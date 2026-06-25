/**
 * Deployment + flow helpers shared by the sandbox tests and the demo scripts.
 *
 * Targets a running local network (`aztec start --local-network`):
 *   - Anvil L1 on :8545 (well-known test mnemonic, prefunded)
 *   - Aztec node on :8080 (prefunded Schnorr test accounts)
 *
 * The local network does no real proving; its EpochTestSettler pushes each completed
 * epoch's out-hash into the L1 Outbox (epoch duration = 2 checkpoints), which is what
 * makes L2->L1 redemption work without a prover.
 */
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { createExtendedL1Client } from '@aztec/ethereum/client';
import { OutboxContract } from '@aztec/ethereum/contracts';
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import { EthAddress } from '@aztec/foundation/eth-address';
import { retryUntil } from '@aztec/foundation/retry';
import { computeL2ToL1MembershipWitness } from '@aztec/stdlib/messaging';
import type { TxReceipt } from '@aztec/stdlib/tx';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { registerInitialLocalNetworkAccountsInWallet } from '@aztec/wallets/testing';
import { defineChain, parseEventLogs, type Chain } from 'viem';
import { foundry } from 'viem/chains';

import { computeAztecMintCommitment, generateMintSecret } from './commitment.js';
import { getBurnMessageLeaf } from './content-hashes.js';
import { TornadoEthTokenContract } from './generated/TornadoEthToken.js';
import {
  ForwarderFactoryAbi,
  ForwarderFactoryBytecode,
  MockRealTornadoPoolAbi,
  MockRealTornadoPoolBytecode,
  MockTornadoPoolAbi,
  MockTornadoPoolBytecode,
  TornadoEthBridgeL1Abi,
  TornadoEthBridgeL1Bytecode,
} from './l1-artifacts.js';
import { buildRealWithdrawalPayload } from './real-tornado.js';

export const DEFAULT_L1_RPC_URL = 'http://localhost:8545';
export const DEFAULT_L1_CHAIN_ID = foundry.id;
export const L1_RPC_URL = process.env.L1_RPC_URL ?? DEFAULT_L1_RPC_URL;
export const L1_CHAIN_ID = Number(process.env.L1_CHAIN_ID ?? DEFAULT_L1_CHAIN_ID);
export const AZTEC_NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080';
/** Anvil's well-known dev mnemonic; HD account 0 deploys and owns the L1 contracts. */
export const TEST_MNEMONIC = 'test test test test test test test test test test test junk';

export const ONE_ETH = 10n ** 18n;

export type L1Client = ReturnType<typeof createExtendedL1Client>;
export type AztecNode = ReturnType<typeof createAztecNodeClient>;

export interface L1ClientConfig {
  rpcUrl?: string;
  rpcUrls?: string[];
  chainId?: number | string;
  chainName?: string;
  privateKey?: `0x${string}`;
  mnemonic?: string;
  addressIndex?: number;
  pollingIntervalMS?: number;
  httpTimeoutMS?: number;
}

export interface ResolvedL1ClientConfig {
  rpcUrls: string[];
  chainId: number;
  chain: Chain;
  signer: string;
  addressIndex?: number;
  pollingIntervalMS?: number;
  httpTimeoutMS?: number;
}

function parseRpcUrls(value?: string): string[] {
  return (value ?? DEFAULT_L1_RPC_URL)
    .split(',')
    .map(url => url.trim())
    .filter(Boolean);
}

function getRpcUrls(opts: L1ClientConfig): string[] {
  const rpcUrls = opts.rpcUrls ?? (opts.rpcUrl ? [opts.rpcUrl] : parseRpcUrls(process.env.L1_RPC_URL));
  if (rpcUrls.length === 0) {
    throw new Error('At least one L1 RPC URL is required');
  }
  return rpcUrls;
}

function parseChainId(value: number | string | undefined): number {
  const chainId = Number(value ?? DEFAULT_L1_CHAIN_ID);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid L1 chain id: ${value}`);
  }
  return chainId;
}

function normalizePrivateKey(privateKey?: string): `0x${string}` | undefined {
  if (privateKey === undefined || privateKey === '') {
    return undefined;
  }
  if (!privateKey.startsWith('0x')) {
    throw new Error('L1 private key must be 0x-prefixed');
  }
  return privateKey as `0x${string}`;
}

function isLocalRpcUrl(rpcUrl: string): boolean {
  try {
    const { hostname } = new URL(rpcUrl);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
  } catch {
    return false;
  }
}

function canUseDefaultTestMnemonic(rpcUrls: string[], chainId: number): boolean {
  return chainId === DEFAULT_L1_CHAIN_ID && rpcUrls.every(isLocalRpcUrl);
}

export function makeL1Chain(opts: { rpcUrls: string[]; chainId: number; chainName?: string }): Chain {
  return defineChain({
    id: opts.chainId,
    name: opts.chainName ?? (opts.chainId === foundry.id ? foundry.name : `L1 ${opts.chainId}`),
    nativeCurrency: foundry.nativeCurrency,
    rpcUrls: {
      default: {
        http: opts.rpcUrls,
      },
    },
    testnet: true,
  });
}

export function resolveL1ClientConfig(opts: L1ClientConfig = {}): ResolvedL1ClientConfig {
  const rpcUrls = getRpcUrls(opts);
  const chainId = parseChainId(opts.chainId ?? process.env.L1_CHAIN_ID);
  const privateKey = normalizePrivateKey(opts.privateKey ?? process.env.L1_PRIVATE_KEY);
  const mnemonic = opts.mnemonic ?? process.env.L1_MNEMONIC;

  if (!privateKey && !mnemonic && !canUseDefaultTestMnemonic(rpcUrls, chainId)) {
    throw new Error('Set L1_PRIVATE_KEY or L1_MNEMONIC for non-local L1 RPC/chain configuration');
  }

  return {
    rpcUrls,
    chainId,
    chain: makeL1Chain({ rpcUrls, chainId, chainName: opts.chainName ?? process.env.L1_CHAIN_NAME }),
    signer: privateKey ?? mnemonic ?? TEST_MNEMONIC,
    addressIndex: opts.addressIndex,
    pollingIntervalMS: opts.pollingIntervalMS,
    httpTimeoutMS: opts.httpTimeoutMS,
  };
}

/** viem wallet+public client for the configured L1, signing with env/opts or local Anvil defaults. */
export function makeL1Client(opts: L1ClientConfig = {}): L1Client {
  const config = resolveL1ClientConfig(opts);
  return createExtendedL1Client(
    config.rpcUrls,
    config.signer,
    config.chain,
    config.pollingIntervalMS,
    config.addressIndex,
    { httpTimeoutMS: config.httpTimeoutMS },
  );
}

export interface AztecConnection {
  node: AztecNode;
  wallet: Awaited<ReturnType<typeof EmbeddedWallet.create>>;
  /** Prefunded local-network Schnorr accounts, usable as `from`. */
  accounts: AztecAddress[];
}

/** Connect to the local network node and register its prefunded test accounts. */
export async function connectToAztec(nodeUrl = AZTEC_NODE_URL): Promise<AztecConnection> {
  const node = createAztecNodeClient(nodeUrl);
  const wallet = await EmbeddedWallet.create(nodeUrl, {
    ephemeral: true,
    pxeConfig: { proverEnabled: false },
  });
  const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);
  if (accounts.length < 2) {
    throw new Error('Expected prefunded local-network accounts — is `aztec start --local-network` running?');
  }
  return { node, wallet, accounts };
}

/* -------------------------------------------------------------------------- */
/*                                 Deployment                                 */
/* -------------------------------------------------------------------------- */

export async function deployMockTornadoPool(client: L1Client, denomination: bigint): Promise<`0x${string}`> {
  const { address } = await deployL1Contract(client, MockTornadoPoolAbi, MockTornadoPoolBytecode, [denomination]);
  return address.toString() as `0x${string}`;
}

export async function deployTornadoBridge(client: L1Client): Promise<`0x${string}`> {
  const { address } = await deployL1Contract(client, TornadoEthBridgeL1Abi, TornadoEthBridgeL1Bytecode, []);
  return address.toString() as `0x${string}`;
}

/** Fund the mock pool with ETH (stands in for Tornado deposits). */
export async function fundPool(client: L1Client, pool: `0x${string}`, amount: bigint): Promise<void> {
  const hash = await client.sendTransaction({ to: pool, value: amount, account: client.account!, chain: client.chain });
  await client.waitForTransactionReceipt({ hash });
}

export async function approvePool(
  client: L1Client,
  bridge: `0x${string}`,
  pool: `0x${string}`,
  denomination: bigint,
): Promise<void> {
  const hash = await client.writeContract({
    address: bridge,
    abi: TornadoEthBridgeL1Abi,
    functionName: 'approvePool',
    args: [pool, denomination],
    account: client.account!,
    chain: client.chain,
  });
  await client.waitForTransactionReceipt({ hash });
}

export async function deployTornadoEthToken(
  conn: AztecConnection,
  deployer: AztecAddress,
  portal: `0x${string}`,
): Promise<TornadoEthTokenContract> {
  const { contract } = await TornadoEthTokenContract.deploy(conn.wallet, EthAddress.fromString(portal)).send({
    from: deployer,
  });
  return contract;
}

/** Wire the bridge to the rollup (via the registry) and to the L2 token. Owner-only, once. */
export async function initializeBridge(
  client: L1Client,
  bridge: `0x${string}`,
  registry: EthAddress,
  l2Token: AztecAddress,
): Promise<void> {
  const hash = await client.writeContract({
    address: bridge,
    abi: TornadoEthBridgeL1Abi,
    functionName: 'initialize',
    args: [registry.toString(), l2Token.toString()],
    account: client.account!,
    chain: client.chain,
  });
  await client.waitForTransactionReceipt({ hash });
}

export interface BridgeStack {
  l1Client: L1Client;
  node: AztecNode;
  wallet: AztecConnection['wallet'];
  accounts: AztecAddress[];
  /** MockTornadoPool address (denomination = ONE_ETH unless overridden). */
  pool: `0x${string}`;
  /** TornadoEthBridgeL1 address. */
  bridge: `0x${string}`;
  /** The L2 tornadoETH contract. */
  token: TornadoEthTokenContract;
  denomination: bigint;
  /** ForwarderFactory address (present when the stack was built with `useRealTornado`). */
  factory?: `0x${string}`;
  /** Known root configured on the mock-real pool (real-Tornado local mode only). */
  mockKnownRoot?: `0x${string}`;
}

/**
 * Deploy + wire the full stack: pool -> bridge -> L2 token -> initialize.
 *
 * With `useRealTornado`, the ingress is the real-Tornado-shaped forwarder path (ForwarderFactory +
 * per-commitment Forwarder), backed by a behavioral {MockRealTornadoPool} so the full flow runs
 * locally without snarkjs/circuit artifacts. That path is byte-identical to mainnet from the
 * forwarder onward; only the pool's proof verification is faked.
 */
export async function setupBridgeStack(
  opts: { denomination?: bigint; poolLiquidity?: bigint; l1?: L1ClientConfig; useRealTornado?: boolean } = {},
): Promise<BridgeStack> {
  const denomination = opts.denomination ?? ONE_ETH;
  const l1Client = makeL1Client(opts.l1);
  const conn = await connectToAztec();
  const deployer = conn.accounts[0];

  const bridge = await deployTornadoBridge(l1Client);

  let pool: `0x${string}`;
  let factory: `0x${string}` | undefined;
  let mockKnownRoot: `0x${string}` | undefined;

  if (opts.useRealTornado) {
    pool = await deployMockRealTornadoPool(l1Client, denomination);
    await fundPool(l1Client, pool, opts.poolLiquidity ?? 10n * denomination);
    mockKnownRoot = MOCK_REAL_KNOWN_ROOT;
    await setMockRealPoolKnownRoot(l1Client, pool, mockKnownRoot);
    factory = await deployForwarderFactory(l1Client, bridge, pool);
    await setForwarderFactory(l1Client, bridge, factory);
  } else {
    pool = await deployMockTornadoPool(l1Client, denomination);
    await fundPool(l1Client, pool, opts.poolLiquidity ?? 10n * denomination);
    await approvePool(l1Client, bridge, pool, denomination);
  }

  // Portal ordering (as in the canonical TokenPortal): the L2 contract is deployed
  // pointing at the (already-known) bridge address, then the bridge learns the L2
  // address through initialize.
  const token = await deployTornadoEthToken(conn, deployer, bridge);
  const { registryAddress } = await conn.node.getL1ContractAddresses();
  await initializeBridge(l1Client, bridge, registryAddress, token.address);

  return {
    l1Client,
    node: conn.node,
    wallet: conn.wallet,
    accounts: conn.accounts,
    pool,
    bridge,
    token,
    denomination,
    factory,
    mockKnownRoot,
  };
}

/* -------------------------------------------------------------------------- */
/*                          Deposit -> claim (L1 -> L2)                        */
/* -------------------------------------------------------------------------- */

export interface TornadoDeposit {
  mintSecret: Fr;
  commitment: Fr;
  nullifierHash: `0x${string}`;
  depositId: `0x${string}`;
  messageHash: Fr;
  messageLeafIndex: bigint;
  amount: bigint;
}

/**
 * Step 1-4 of the flow: generate a mint secret + commitment, withdraw from the mock
 * Tornado pool into the bridge, and pull the deposit/message identifiers from the
 * `TornadoBridgeDeposit` event.
 */
export async function withdrawFromTornadoToBridge(
  stack: Pick<BridgeStack, 'l1Client' | 'pool' | 'bridge' | 'denomination'>,
  recipient: AztecAddress,
  opts: { nullifierHash?: `0x${string}`; mintSecret?: Fr } = {},
): Promise<TornadoDeposit> {
  const amount = stack.denomination;
  const mintSecret = opts.mintSecret ?? generateMintSecret();
  const commitment = await computeAztecMintCommitment(recipient, mintSecret, amount);
  const nullifierHash = opts.nullifierHash ?? (Fr.random().toString() as `0x${string}`);

  const hash = await stack.l1Client.writeContract({
    address: stack.pool,
    abi: MockTornadoPoolAbi,
    functionName: 'withdrawToBridge',
    args: [stack.bridge, nullifierHash, commitment.toString()],
    account: stack.l1Client.account!,
    chain: stack.l1Client.chain,
  });
  const receipt = await stack.l1Client.waitForTransactionReceipt({ hash });

  const [log] = parseEventLogs({
    abi: TornadoEthBridgeL1Abi,
    logs: receipt.logs,
    eventName: 'TornadoBridgeDeposit',
  }) as unknown as Array<{
    args: {
      depositId: `0x${string}`;
      amount: bigint;
      aztecMintCommitment: `0x${string}`;
      messageKey: `0x${string}`;
      messageLeafIndex: bigint;
    };
  }>;
  if (!log) {
    throw new Error('TornadoBridgeDeposit event not found in receipt');
  }

  return {
    mintSecret,
    commitment,
    nullifierHash,
    depositId: log.args.depositId,
    messageHash: Fr.fromHexString(log.args.messageKey),
    messageLeafIndex: log.args.messageLeafIndex,
    amount,
  };
}

/** Wait until the archiver has indexed the L1->L2 message. */
export async function waitForMessageSeen(node: AztecNode, messageHash: Fr, timeoutSec = 90): Promise<void> {
  await retryUntil(
    async () => (await node.getL1ToL2MessageCheckpoint(messageHash)) !== undefined,
    `L1->L2 message ${messageHash.toString()} indexed`,
    timeoutSec,
    1,
  );
}

/**
 * Progress the rollup by `blocks` L2 blocks using no-op self-transfers. An L1->L2
 * message becomes consumable two blocks after insertion (one for subtree inclusion,
 * one for tree availability) — mirrors the canonical harness's makeMessageConsumable.
 */
export async function advanceL2Blocks(
  token: TornadoEthTokenContract,
  account: AztecAddress,
  blocks: number,
): Promise<void> {
  for (let i = 0; i < blocks; i++) {
    await token.methods.transfer_private(account, 0n).send({ from: account });
  }
}

/** Make a deposit's L1->L2 message consumable: wait for indexing + 2 L2 blocks. */
export async function makeMessageConsumable(
  stack: Pick<BridgeStack, 'node' | 'token'>,
  deposit: TornadoDeposit,
  account: AztecAddress,
): Promise<void> {
  await waitForMessageSeen(stack.node, deposit.messageHash);
  await advanceL2Blocks(stack.token, account, 2);
}

/** Claim the deposit as private tornadoETH notes for `recipient` (the tx sender). */
export async function claimTornadoEth(
  token: TornadoEthTokenContract,
  recipient: AztecAddress,
  deposit: TornadoDeposit,
  overrides: { amount?: bigint; mintSecret?: Fr } = {},
): Promise<TxReceipt> {
  const { receipt } = await token.methods
    .claim_from_tornado_bridge(
      Fr.fromHexString(deposit.depositId),
      overrides.amount ?? deposit.amount,
      overrides.mintSecret ?? deposit.mintSecret,
      deposit.messageLeafIndex,
    )
    .send({ from: recipient });
  return receipt;
}

/** Private tornadoETH balance via the contract's utility function. */
export async function balanceOfPrivate(token: TornadoEthTokenContract, owner: AztecAddress): Promise<bigint> {
  const { result } = await token.methods.balance_of_private(owner).simulate({ from: owner });
  return BigInt(result as bigint);
}

/* -------------------------------------------------------------------------- */
/*                          Burn -> redeem (L2 -> L1)                          */
/* -------------------------------------------------------------------------- */

export interface BurnForWithdrawal {
  receipt: TxReceipt;
  nonce: Fr;
  recipientL1: EthAddress;
  amount: bigint;
  /** The outbox leaf the L1 bridge will consume. */
  messageLeaf: Fr;
}

/** Burn tornadoETH, emitting the L2->L1 withdrawal message. */
export async function burnForL1Withdrawal(
  stack: Pick<BridgeStack, 'l1Client' | 'bridge' | 'token'>,
  owner: AztecAddress,
  recipientL1: `0x${string}`,
  amount: bigint,
  nonce: Fr = Fr.random(),
): Promise<BurnForWithdrawal> {
  const recipient = EthAddress.fromString(recipientL1);
  const { receipt } = await stack.token.methods
    .burn_for_l1_withdrawal(recipient, amount, nonce)
    .send({ from: owner });

  const rollupVersion = (await stack.l1Client.readContract({
    address: stack.bridge,
    abi: TornadoEthBridgeL1Abi,
    functionName: 'rollupVersion',
  })) as bigint;

  const messageLeaf = getBurnMessageLeaf({
    l2Token: stack.token.address,
    portal: EthAddress.fromString(stack.bridge),
    recipientL1: recipient,
    amount,
    nonce,
    rollupVersion,
    chainId: BigInt(stack.l1Client.chain.id),
  });

  return { receipt, nonce, recipientL1: recipient, amount, messageLeaf };
}

export interface BurnWitness {
  epochNumber: number;
  numCheckpointsInEpoch: number;
  leafIndex: bigint;
  siblingPath: { toBufferArray(): Buffer[] };
}

/**
 * Wait for the burn's epoch to settle into the Outbox, then compute the membership
 * witness. The local network's EpochTestSettler inserts the out-hash once the epoch
 * (2 checkpoints) completes; we keep producing trivial L2 blocks to push the epoch
 * over the boundary while polling.
 */
export async function getBurnWitness(
  stack: Pick<BridgeStack, 'node' | 'l1Client' | 'token'>,
  burn: BurnForWithdrawal,
  blockProducer: AztecAddress,
  timeoutSec = 180,
): Promise<BurnWitness> {
  const { outboxAddress } = await stack.node.getL1ContractAddresses();
  const outbox = new OutboxContract(stack.l1Client, outboxAddress);

  let witness: Awaited<ReturnType<typeof computeL2ToL1MembershipWitness>>;
  await retryUntil(
    async () => {
      witness = await computeL2ToL1MembershipWitness(stack.node, outbox, burn.messageLeaf, burn.receipt);
      if (witness !== undefined) {
        return true;
      }
      // Nudge the epoch forward so the EpochTestSettler can settle it.
      await advanceL2Blocks(stack.token, blockProducer, 1);
      return false;
    },
    'L2->L1 burn message witness',
    timeoutSec,
    1,
  );
  return witness! as unknown as BurnWitness;
}

/** Consume the burn message on L1, releasing reserve ETH to the committed recipient. */
export async function withdrawFromAztecOnL1(
  stack: Pick<BridgeStack, 'l1Client' | 'bridge'>,
  burn: BurnForWithdrawal,
  witness: BurnWitness,
): Promise<void> {
  const hash = await stack.l1Client.writeContract({
    address: stack.bridge,
    abi: TornadoEthBridgeL1Abi,
    functionName: 'withdrawFromAztec',
    args: [
      burn.recipientL1.toString(),
      burn.amount,
      burn.nonce.toString(),
      BigInt(witness.epochNumber),
      BigInt(witness.numCheckpointsInEpoch),
      witness.leafIndex,
      witness.siblingPath.toBufferArray().map((buf: Buffer) => `0x${buf.toString('hex')}`),
    ],
    account: stack.l1Client.account!,
    chain: stack.l1Client.chain,
  });
  await stack.l1Client.waitForTransactionReceipt({ hash });
}

/** Bridge reserve accounting, as tracked on L1. */
export async function getTotalLockedEth(client: L1Client, bridge: `0x${string}`): Promise<bigint> {
  return (await client.readContract({
    address: bridge,
    abi: TornadoEthBridgeL1Abi,
    functionName: 'totalLockedEth',
  })) as bigint;
}

/* -------------------------------------------------------------------------- */
/*                  Real-Tornado ingress (CREATE2 forwarder)                  */
/* -------------------------------------------------------------------------- */

/** Arbitrary 32-byte root marked known on the mock-real pool for local real-path runs. */
export const MOCK_REAL_KNOWN_ROOT = `0x${'11'.repeat(32)}` as const;

export async function deployForwarderFactory(
  client: L1Client,
  bridge: `0x${string}`,
  tornado: `0x${string}`,
): Promise<`0x${string}`> {
  const { address } = await deployL1Contract(client, ForwarderFactoryAbi, ForwarderFactoryBytecode, [bridge, tornado]);
  return address.toString() as `0x${string}`;
}

export async function deployMockRealTornadoPool(client: L1Client, denomination: bigint): Promise<`0x${string}`> {
  const { address } = await deployL1Contract(client, MockRealTornadoPoolAbi, MockRealTornadoPoolBytecode, [
    denomination,
  ]);
  return address.toString() as `0x${string}`;
}

/** Approve a ForwarderFactory as the real-Tornado ingress (owner-only). */
export async function setForwarderFactory(
  client: L1Client,
  bridge: `0x${string}`,
  factory: `0x${string}`,
): Promise<void> {
  const hash = await client.writeContract({
    address: bridge,
    abi: TornadoEthBridgeL1Abi,
    functionName: 'setForwarderFactory',
    args: [factory],
    account: client.account!,
    chain: client.chain,
  });
  await client.waitForTransactionReceipt({ hash });
}

async function setMockRealPoolKnownRoot(
  client: L1Client,
  pool: `0x${string}`,
  root: `0x${string}`,
): Promise<void> {
  const hash = await client.writeContract({
    address: pool,
    abi: MockRealTornadoPoolAbi,
    functionName: 'setKnownRoot',
    args: [root, true],
    account: client.account!,
    chain: client.chain,
  });
  await client.waitForTransactionReceipt({ hash });
}

/**
 * Drive `ForwarderFactory.withdrawAndBridge` and parse the portal's `TornadoBridgeDeposit` event into
 * a {TornadoDeposit}. The returned struct is identical to the mock path's, so the downstream
 * claim/burn/redeem helpers work unchanged.
 */
export async function withdrawViaForwarder(
  stack: Pick<BridgeStack, 'l1Client' | 'bridge' | 'denomination'> & { factory: `0x${string}` },
  payload: { proof: `0x${string}`; root: `0x${string}`; nullifierHash: `0x${string}`; commitment: Fr; mintSecret: Fr },
): Promise<TornadoDeposit> {
  const hash = await stack.l1Client.writeContract({
    address: stack.factory,
    abi: ForwarderFactoryAbi,
    functionName: 'withdrawAndBridge',
    args: [payload.proof, payload.root, payload.nullifierHash, payload.commitment.toString()],
    account: stack.l1Client.account!,
    chain: stack.l1Client.chain,
  });
  const receipt = await stack.l1Client.waitForTransactionReceipt({ hash });

  const [log] = parseEventLogs({
    abi: TornadoEthBridgeL1Abi,
    logs: receipt.logs,
    eventName: 'TornadoBridgeDeposit',
  }) as unknown as Array<{
    args: { depositId: `0x${string}`; messageKey: `0x${string}`; messageLeafIndex: bigint };
  }>;
  if (!log) {
    throw new Error('TornadoBridgeDeposit event not found in receipt');
  }

  return {
    mintSecret: payload.mintSecret,
    commitment: payload.commitment,
    nullifierHash: payload.nullifierHash,
    depositId: log.args.depositId,
    messageHash: Fr.fromHexString(log.args.messageKey),
    messageLeafIndex: log.args.messageLeafIndex,
    amount: stack.denomination,
  };
}

/**
 * Local real-path withdrawal against the mock-real pool: generates the Aztec commitment and drives
 * the forwarder with an empty proof + the pool's known root (the mock ignores the proof). Exercises
 * the full forwarder->portal->L2 path without snarkjs.
 */
export async function withdrawFromMockRealPool(
  stack: Pick<BridgeStack, 'l1Client' | 'bridge' | 'denomination' | 'factory' | 'mockKnownRoot'>,
  recipient: AztecAddress,
  opts: { nullifierHash?: `0x${string}`; mintSecret?: Fr } = {},
): Promise<TornadoDeposit> {
  if (!stack.factory || !stack.mockKnownRoot) {
    throw new Error('stack is not in real-Tornado mode (use setupBridgeStack({ useRealTornado: true }))');
  }
  const mintSecret = opts.mintSecret ?? generateMintSecret();
  const commitment = await computeAztecMintCommitment(recipient, mintSecret, stack.denomination);
  const nullifierHash = opts.nullifierHash ?? (Fr.random().toString() as `0x${string}`);

  return withdrawViaForwarder(
    { l1Client: stack.l1Client, bridge: stack.bridge, denomination: stack.denomination, factory: stack.factory },
    { proof: '0x', root: stack.mockKnownRoot, nullifierHash, commitment, mintSecret },
  );
}

/**
 * Production real-path withdrawal: parse a real Tornado note, build its merkle proof against the live
 * pool, generate the Groth16 proof bound to the forwarder, and drive the factory. Requires the
 * canonical circuit artifacts (see {@link buildRealWithdrawalPayload}). The proof-packing must be
 * validated against the real verifier via the Tier 3 fork test before mainnet use.
 */
export async function withdrawFromRealTornadoToBridge(
  stack: Pick<BridgeStack, 'l1Client' | 'bridge' | 'denomination'> & { factory: `0x${string}` },
  recipient: AztecAddress,
  note: string,
  opts: { tornado?: `0x${string}`; mintSecret?: Fr; leaves?: bigint[]; wasmPath?: string; zkeyPath?: string } = {},
): Promise<TornadoDeposit> {
  const forwarderInitCodeHash = (await stack.l1Client.readContract({
    address: stack.factory,
    abi: ForwarderFactoryAbi,
    functionName: 'FORWARDER_INIT_CODE_HASH',
  })) as `0x${string}`;
  const tornado =
    opts.tornado ??
    ((await stack.l1Client.readContract({
      address: stack.factory,
      abi: ForwarderFactoryAbi,
      functionName: 'TORNADO',
    })) as `0x${string}`);

  const payload = await buildRealWithdrawalPayload({
    client: stack.l1Client,
    tornado,
    factory: stack.factory,
    recipient,
    amount: stack.denomination,
    note,
    mintSecret: opts.mintSecret,
    forwarderInitCodeHash,
    leaves: opts.leaves,
    wasmPath: opts.wasmPath,
    zkeyPath: opts.zkeyPath,
  });

  return withdrawViaForwarder(stack, payload);
}
