/**
 * Real-Tornado rehearsal on a mainnet fork: a Groth16 proof from Tornado's own toolchain and proving
 * key, checked by the real on-chain verifier, driving the whole bridge round trip:
 *
 *   deposit into a Tornado pool -> rebuild its tree -> prove to our forwarder
 *   -> ForwarderFactory.withdrawAndBridge -> portal -> L1->L2 message -> private mint on Aztec
 *   -> burn -> L2->L1 message -> redeem on L1
 *
 * The Aztec local network deploys its L1 contracts onto the same fork, so both halves share one L1.
 *
 * The pool defaults to our own ETHTornado: the canonical 1 ETH pool's exact code, Hasher and real
 * Verifier, with our deposit as its only leaf, so no history is needed.
 *
 * Flags:
 *   --real-pool  use the canonical 1 ETH pool instead; rebuilding its ~12M-block log tail needs an RPC
 *                that serves wide eth_getLogs ranges (free public tiers cap them at ~100 blocks)
 *   --l1-only    stop after the portal locks the ETH; Aztec messaging is mocked, no local network
 *
 * Env: MAINNET_RPC_URL (starts the fork + local network), or L1_RPC_URL [+ AZTEC_NODE_URL] to attach
 * to a fork already running with chain id 31337. Needs `yarn prover:install`.
 */
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Abi, createPublicClient, http, parseAbi } from 'viem';

import MockInboxJson from '../contracts/l1/out/MessagingMocks.sol/MockInbox.json' with { type: 'json' };
import MockOutboxJson from '../contracts/l1/out/MessagingMocks.sol/MockOutbox.json' with { type: 'json' };
import MockRegistryJson from '../contracts/l1/out/MessagingMocks.sol/MockRegistry.json' with { type: 'json' };
import MockRollupJson from '../contracts/l1/out/MessagingMocks.sol/MockRollup.json' with { type: 'json' };
import {
  balanceOfPrivate,
  burnForL1Withdrawal,
  claimTornadoEth,
  createTornadoNote,
  deployForwarderFactory,
  deployL1ContractChecked,
  deployOwnTornadoPool,
  deployTornadoBridge,
  getBurnWitness,
  getTotalLockedEth,
  initializeBridge,
  loadDepositCache,
  makeL1Client,
  makeMessageConsumable,
  ONE_ETH,
  prepareRealTornadoWithdrawal,
  readTornadoVerifier,
  rebuildPoolHistory,
  setForwarderFactory,
  setupBridgeStack,
  TORNADO_1ETH_MAINNET,
  verifyTornadoProof,
  waitForL1Success,
  withdrawFromAztecOnL1,
  withdrawViaForwarder,
  type L1Client,
} from '../src/index.js';
import { startForkNetwork, type ForkNetwork } from './fork-network.js';

const poolAbi = parseAbi([
  'function deposit(bytes32 _commitment) payable',
  'function nullifierHashes(bytes32) view returns (bool)',
]);
/** Fresh EOA that only ever receives the redemption. */
const L1_RECIPIENT = '0x2000000000000000000000000000000000000002' as const;
/** Anvil test-mnemonic index for our L1 txs; index 0 is the Aztec sequencer's publisher. */
const L1_ACCOUNT_INDEX = 3;

export interface RehearsalResult {
  mode: 'full' | 'l1-only';
  pool: `0x${string}`;
  verifier: `0x${string}`;
  forkBlock: bigint;
  leaves: number;
  depositId: `0x${string}`;
  /** ETH the L1 recipient received from the redemption (full mode). */
  redeemed?: bigint;
}

/** Print getLogs progress roughly every 500k blocks. */
function logProgress(): (block: bigint) => void {
  let next = 0n;
  return block => {
    if (block >= next) {
      console.log(`  logs through block ${block}`);
      next = block + 500_000n;
    }
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    throw new Error(`rehearsal check failed: ${msg}`);
  }
}

async function assertAnvilFork(client: L1Client): Promise<void> {
  const rpc = client as unknown as { request(args: { method: string }): Promise<unknown> };
  const info = (await rpc.request({ method: 'anvil_nodeInfo' }).catch(() => undefined)) as
    | { forkConfig?: { forkUrl?: string | null } }
    | undefined;
  assert(info?.forkConfig?.forkUrl, 'L1 must be an Anvil mainnet fork (refusing to spend real funds)');
  assert((await client.getChainId()) === 31337, 'the fork must run with --chain-id 31337');
}

async function deployMock(client: L1Client, json: { abi: unknown; bytecode: { object: string } }, args: unknown[]) {
  return deployL1ContractChecked(client, json.abi as Abi, json.bytecode.object as `0x${string}`, args);
}

/** L1-only stack: the portal wired to mock Aztec messaging, forwarder factory pointed at `pool`. */
async function setupL1OnlyStack(client: L1Client, pool: `0x${string}`) {
  const inbox = await deployMock(client, MockInboxJson, []);
  const outbox = await deployMock(client, MockOutboxJson, []);
  const rollup = await deployMock(client, MockRollupJson, [inbox, outbox, 1n]);
  const registry = await deployMock(client, MockRegistryJson, [rollup]);
  const bridge = await deployTornadoBridge(client);
  await initializeBridge(client, bridge, EthAddress.fromString(registry), await AztecAddress.random());
  const factory = await deployForwarderFactory(client, bridge, pool);
  await setForwarderFactory(client, bridge, factory);
  return { l1Client: client, pool, bridge, factory, denomination: ONE_ETH };
}

export async function runRealTornadoRehearsal(
  opts: { realPool?: boolean; l1Only?: boolean } = {},
): Promise<RehearsalResult> {
  let network: ForkNetwork | undefined;
  if (process.env.MAINNET_RPC_URL) {
    console.log('Starting the mainnet fork' + (opts.l1Only ? '' : ' and the Aztec local network') + '...');
    network = await startForkNetwork({ forkUrl: process.env.MAINNET_RPC_URL, withAztec: !opts.l1Only });
  }
  try {
    const l1RpcUrl = network?.l1RpcUrl ?? process.env.L1_RPC_URL;
    assert(l1RpcUrl, 'set MAINNET_RPC_URL, or L1_RPC_URL for an already-running fork');
    const aztecNodeUrl = network?.aztecNodeUrl ?? process.env.AZTEC_NODE_URL;
    const l1 = { rpcUrl: l1RpcUrl, chainId: 31337, addressIndex: L1_ACCOUNT_INDEX };
    const client = makeL1Client(l1);
    await assertAnvilFork(client);
    const forkBlock = network?.forkBlock ?? (await client.getBlockNumber());

    // 1. The pool: our own copy of the 1 ETH instance pointed at its verifier, or the canonical one.
    let pool: `0x${string}` = TORNADO_1ETH_MAINNET;
    let poolDeployBlock: bigint | undefined;
    if (!opts.realPool) {
      pool = await deployOwnTornadoPool(client, { verifier: await readTornadoVerifier(client, TORNADO_1ETH_MAINNET) });
      poolDeployBlock = await client.getBlockNumber();
    }

    // 2. Portal stack against that pool.
    console.log(`Deploying the portal stack against pool ${pool}...`);
    const full = opts.l1Only ? undefined : await setupBridgeStack({ existingPool: pool, l1, aztecNodeUrl });
    const stack = full ? { ...full, factory: full.factory! } : await setupL1OnlyStack(client, pool);
    const alice = full ? full.accounts[0] : await AztecAddress.random();

    // 3. Deposit a fresh note, then rebuild the pool's tree as of that block.
    const { note, commitment } = createTornadoNote();
    const depositReceipt = await waitForL1Success(
      client,
      await client.writeContract({
        address: pool,
        abi: poolAbi,
        functionName: 'deposit',
        args: [commitment],
        value: ONE_ETH,
        account: client.account!,
        chain: client.chain,
      }),
    );
    console.log('Rebuilding the pool tree from the deposit cache + logs...');
    const history = await rebuildPoolHistory({
      client,
      pool,
      blockNumber: depositReceipt.blockNumber,
      cache: opts.realPool ? loadDepositCache() : undefined,
      fromBlock: poolDeployBlock,
      upstream: process.env.MAINNET_RPC_URL
        ? createPublicClient({ transport: http(process.env.MAINNET_RPC_URL) })
        : undefined,
      forkBlock,
      onProgress: logProgress(),
    });
    assert(history.leaves.at(-1) === commitment.toLowerCase(), 'our deposit is the last leaf');
    console.log(`${history.leaves.length} leaves, root ${history.root}`);

    // 4. Prove to the forwarder; the real verifier must accept it, and reject it for any other recipient.
    console.log('Proving (circom1/websnark) and checking against the real verifier...');
    const withdrawal = await prepareRealTornadoWithdrawal(stack, alice, note, history);
    const tampered = [...withdrawal.proof.args] as typeof withdrawal.proof.args;
    tampered[2] = `0x${'00'.repeat(19)}01`;
    assert(
      !(await verifyTornadoProof(client, withdrawal.verifier, withdrawal.proof.proof, tampered)),
      'the verifier must reject the proof for a different recipient',
    );

    // 5. Real pool withdrawal -> forwarder -> portal.
    const deposit = await withdrawViaForwarder(stack, withdrawal.payload);
    assert((await getTotalLockedEth(client, stack.bridge)) === ONE_ETH, 'portal locked the denomination');
    assert(
      await client.readContract({
        address: pool,
        abi: poolAbi,
        functionName: 'nullifierHashes',
        args: [withdrawal.payload.nullifierHash],
      }),
      'the Tornado nullifier is spent',
    );
    console.log(`Portal locked 1 ETH (depositId ${deposit.depositId}).`);

    const result: RehearsalResult = {
      mode: opts.l1Only ? 'l1-only' : 'full',
      pool,
      verifier: withdrawal.verifier,
      forkBlock,
      leaves: history.leaves.length,
      depositId: deposit.depositId,
    };
    if (!full) {
      return result;
    }

    // 6. Aztec half: claim the private mint, burn all of it, redeem on L1.
    console.log('Claiming on Aztec...');
    await makeMessageConsumable(full, deposit, alice);
    await claimTornadoEth(full.token, alice, deposit);
    assert((await balanceOfPrivate(full.token, alice)) === ONE_ETH, 'alice holds 1 private tornadoETH');

    console.log('Burning and redeeming on L1...');
    const burn = await burnForL1Withdrawal(full, alice, L1_RECIPIENT, ONE_ETH);
    assert((await balanceOfPrivate(full.token, alice)) === 0n, 'burn consumed the notes');
    const witness = await getBurnWitness(full, burn, alice);
    const before = await client.getBalance({ address: L1_RECIPIENT });
    await withdrawFromAztecOnL1(full, burn, witness);
    const redeemed = (await client.getBalance({ address: L1_RECIPIENT })) - before;
    assert(redeemed === ONE_ETH, 'recipient received 1 ETH');
    assert((await getTotalLockedEth(client, full.bridge)) === 0n, 'portal reserve is empty');
    const replay = await withdrawFromAztecOnL1(full, burn, witness).then(
      () => true,
      () => false,
    );
    assert(!replay, 'redeeming the same burn twice must fail');

    console.log('OK: real proof accepted by the real verifier; full round trip settled on the fork.');
    return { ...result, redeemed };
  } finally {
    network?.stop();
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runRealTornadoRehearsal({ realPool: process.argv.includes('--real-pool'), l1Only: process.argv.includes('--l1-only') })
    .then(result => {
      console.log(JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
