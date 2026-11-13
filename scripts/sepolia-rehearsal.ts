/**
 * Phase 4 BLUEPRINT -- full live flow on Sepolia (tornado-core) + Aztec testnet.
 *
 * Runnable + documented, but NOT validated against live testnet here: it reuses the verified,
 * network-agnostic flow helpers, and isolates the testnet-specific bootstrap (real proving, a funded
 * account, fees, real epoch-settlement waiting) into clearly-marked seams. The first live run wires
 * `registerTestnetAccount` and tunes timeouts -- see docs/TESTNET.md.
 *
 * Prerequisites: docs/TESTNET.md#prerequisites.
 */
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded';
import { parseAbi } from 'viem';

import {
  approveForwarderFactory,
  type AztecConnection,
  balanceOfPrivate,
  burnForL1Withdrawal,
  claimTornadoEth,
  createTornadoNote,
  deployForwarderFactory,
  deployTornadoBridge,
  deployTornadoEthToken,
  getBurnWitness,
  getTotalLockedEth,
  initializeBridge,
  makeL1Client,
  makeMessageConsumable,
  ONE_ETH,
  PXE_SYNC_CHAIN_TIP,
  rebuildPoolHistory,
  withdrawFromRealTornadoToBridge,
  withdrawFromAztecOnL1,
  waitForL1Success,
} from '../src/index.js';

const tornadoDepositAbi = parseAbi(['function deposit(bytes32 _commitment) external payable']);

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (${hint})`);
  return value;
}

/**
 * TODO(testnet, first live run): register + fund an Aztec testnet account and return it. The local
 * helper `registerInitialLocalNetworkAccountsInWallet` does NOT apply on testnet (no prefunded
 * accounts). Options: the testnet faucet, bridging fee juice, or a sponsored FPC. See docs/TESTNET.md.
 */
async function registerTestnetAccount(_wallet: AztecConnection['wallet']): Promise<AztecAddress> {
  throw new Error('Aztec testnet account registration + funding not wired -- see docs/TESTNET.md');
}

/** Aztec testnet connection: real proving enabled, one funded account. */
async function connectToAztecTestnet(nodeUrl: string): Promise<AztecConnection> {
  const node = createAztecNodeClient(nodeUrl);
  const wallet = await EmbeddedWallet.create(nodeUrl, { pxeConfig: { proverEnabled: true, syncChainTip: PXE_SYNC_CHAIN_TIP } });
  const account = await registerTestnetAccount(wallet);
  return { node, wallet, accounts: [account] };
}

export async function runSepoliaRehearsal(): Promise<{ lockedEthAfter: bigint }> {
  const pool = requireEnv('SEPOLIA_TORNADO_POOL', 'a tornado-core pool deployed on Sepolia') as `0x${string}`;
  const l1Client = makeL1Client({
    rpcUrl: requireEnv('L1_RPC_URL', 'a Sepolia RPC'),
    chainId: Number(process.env.L1_CHAIN_ID ?? 11155111),
    privateKey: requireEnv('L1_PRIVATE_KEY', 'a funded Sepolia signer') as `0x${string}`,
  });

  // 1. Aztec testnet connection (real proving + a funded account) -- see the TODO above.
  const conn = await connectToAztecTestnet(process.env.AZTEC_NODE_URL ?? requireEnv('AZTEC_NODE_URL', 'the Aztec testnet node'));
  const [alice] = conn.accounts;
  const bob = alice; // single funded account for the rehearsal; split into two if the faucet allows.

  // 2. Deploy + wire our bridge stack against the existing Sepolia pool (network-agnostic helpers).
  const bridge = await deployTornadoBridge(l1Client);
  const factory = await deployForwarderFactory(l1Client, bridge, pool);
  await approveForwarderFactory(l1Client, bridge, factory);
  const token = await deployTornadoEthToken(conn, alice, bridge);
  const { registryAddress } = await conn.node.getL1ContractAddresses();
  await initializeBridge(l1Client, bridge, registryAddress, token.address);

  const stack = {
    l1Client,
    node: conn.node,
    wallet: conn.wallet,
    accounts: conn.accounts,
    pool,
    bridge,
    token,
    denomination: ONE_ETH,
    factory,
  };

  // 3. Fresh note deposited into the Sepolia pool so we own a leaf.
  const { note, commitment } = createTornadoNote({ netId: 11155111 });
  const depositHash = await l1Client.writeContract({
    address: pool,
    abi: tornadoDepositAbi,
    functionName: 'deposit',
    args: [commitment],
    value: ONE_ETH,
    account: l1Client.account!,
    chain: l1Client.chain,
  });
  const depositReceipt = await waitForL1Success(l1Client, depositHash);

  // 4. Real proof -> forwarder -> portal, over the pool's full history up to our deposit.
  const history = await rebuildPoolHistory({
    client: l1Client,
    pool,
    blockNumber: depositReceipt.blockNumber,
    fromBlock: BigInt(requireEnv('SEPOLIA_TORNADO_POOL_DEPLOY_BLOCK', 'the pool deployment block')),
  });
  const deposit = await withdrawFromRealTornadoToBridge(stack, alice, note, history);

  // 5. Claim privately on Aztec testnet. makeMessageConsumable + getBurnWitness poll on real timing;
  // testnet epochs settle on real proving time, so use a generous timeout.
  await makeMessageConsumable(stack, deposit, alice);
  await claimTornadoEth(token, alice, deposit);

  await token.methods.transfer_private(bob, (4n * ONE_ETH) / 10n).send({ from: alice });

  // 6. Burn a slice for an L1 withdrawal back to a fresh Sepolia EOA, then redeem on L1.
  const l1Recipient = '0x3000000000000000000000000000000000000003' as const;
  const burn = await burnForL1Withdrawal(stack, bob, l1Recipient, (25n * ONE_ETH) / 100n);
  const witness = await getBurnWitness(stack, burn, alice, 1800); // real epoch settlement can take minutes
  await withdrawFromAztecOnL1(stack, burn, witness);

  console.log(`alice tornadoETH: ${await balanceOfPrivate(token, alice)}`);
  const lockedEthAfter = await getTotalLockedEth(l1Client, bridge);
  console.log(`bridge locked after redeem: ${lockedEthAfter} wei`);
  return { lockedEthAfter };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runSepoliaRehearsal()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
