/**
 * Tier 3 rehearsal: REAL Groth16 proof against the REAL Tornado verifier, on a mainnet fork.
 *
 * This is the rung that proves our off-chain proof plumbing (public-signal ordering, pedersen/MiMC
 * derivations, proof packing) is byte-accepted by the actual mainnet verifier -- the one thing the
 * Tier 2 forge fork test mocks out. It is L1-only (the Aztec claim is the Phase 4 Sepolia rehearsal):
 * a fresh deposit into the forked pool, tree reconstruction, a real proof bound to the forwarder, and
 * the factory->portal handoff, asserting the bridge locked exactly the denomination.
 *
 * PREREQUISITES (none are bundled here):
 *   1. `anvil --fork-url $MAINNET_RPC_URL` running (or set L1_RPC_URL to a fork endpoint).
 *   2. The OPTIONAL toolchain installed: `yarn add -O snarkjs circomlibjs fixed-merkle-tree`.
 *   3. The CANONICAL tornado-core circuit artifacts, paths via env:
 *        TORNADO_WASM_PATH=/path/to/withdraw.wasm
 *        TORNADO_ZKEY_PATH=/path/to/withdraw_final.zkey
 *      (The mainnet verifier only accepts proofs from that exact trusted setup.)
 *   4. Optional: TORNADO_FROM_BLOCK to bound the Deposit-event scan (defaults near the pool's
 *      deployment); the full 1 ETH leaf set is large, so a tight range speeds reconstruction.
 *
 * VALIDATE: if the real verifier rejects the proof, the most likely culprit is the Groth16->Solidity
 * proof packing in `packGroth16Proof` (src/real-tornado.ts) -- the pi_b element order in particular.
 */
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { deployL1Contract } from '@aztec/ethereum/deploy-l1-contract';
import { EthAddress } from '@aztec/foundation/eth-address';
import { type Abi, parseAbi } from 'viem';

import MockInboxJson from '../contracts/l1/out/MessagingMocks.sol/MockInbox.json' with { type: 'json' };
import MockOutboxJson from '../contracts/l1/out/MessagingMocks.sol/MockOutbox.json' with { type: 'json' };
import MockRegistryJson from '../contracts/l1/out/MessagingMocks.sol/MockRegistry.json' with { type: 'json' };
import MockRollupJson from '../contracts/l1/out/MessagingMocks.sol/MockRollup.json' with { type: 'json' };
import {
  deployForwarderFactory,
  deployTornadoBridge,
  getTotalLockedEth,
  initializeBridge,
  makeL1Client,
  ONE_ETH,
  setForwarderFactory,
  TEST_MNEMONIC,
  withdrawFromRealTornadoToBridge,
  type L1Client,
} from '../src/index.js';
import { fetchDepositLeaves, generateTornadoNote, TORNADO_1ETH_MAINNET } from '../src/real-tornado.js';

const POOL_DEPLOY_BLOCK_DEFAULT = 9_117_000n;

const tornadoAbi = parseAbi([
  'function deposit(bytes32 _commitment) external payable',
  'function getLastRoot() external view returns (bytes32)',
]);

function toBytes32(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

async function deployMock(
  client: L1Client,
  json: { abi: unknown; bytecode: { object: string } },
  args: unknown[],
): Promise<`0x${string}`> {
  const { address } = await deployL1Contract(client, json.abi as Abi, json.bytecode.object as `0x${string}`, args);
  return address.toString() as `0x${string}`;
}

export interface RehearsalResult {
  bridge: `0x${string}`;
  factory: `0x${string}`;
  lockedEth: bigint;
  depositId: `0x${string}`;
}

export async function runRealTornadoRehearsal(
  opts: { rpcUrl?: string; chainId?: number; tornado?: `0x${string}`; fromBlock?: bigint } = {},
): Promise<RehearsalResult> {
  const tornado = opts.tornado ?? TORNADO_1ETH_MAINNET;
  const client = makeL1Client({
    rpcUrl: opts.rpcUrl ?? process.env.L1_RPC_URL ?? 'http://localhost:8545',
    chainId: opts.chainId ?? Number(process.env.L1_CHAIN_ID ?? 1),
    mnemonic: process.env.L1_MNEMONIC ?? TEST_MNEMONIC,
  });

  // 1. L1-only Aztec messaging stubs + the bridge wired to them.
  console.log('Deploying messaging mocks + bridge on the fork...');
  const inbox = await deployMock(client, MockInboxJson, []);
  const outbox = await deployMock(client, MockOutboxJson, []);
  const rollup = await deployMock(client, MockRollupJson, [inbox, outbox, 1n]);
  const registry = await deployMock(client, MockRegistryJson, [rollup]);
  const bridge = await deployTornadoBridge(client);
  await initializeBridge(client, bridge, EthAddress.fromString(registry), AztecAddress.fromField(new Fr(0x1234n)));

  // 2. Forwarder factory pointed at the REAL pool, approved on the bridge.
  const factory = await deployForwarderFactory(client, bridge, tornado);
  await setForwarderFactory(client, bridge, factory);

  // 3. Fresh Tornado note + deposit into the forked pool so we own a leaf.
  console.log('Generating + depositing a fresh Tornado note...');
  const { note, commitment } = await generateTornadoNote();
  const depositHash = await client.writeContract({
    address: tornado,
    abi: tornadoAbi,
    functionName: 'deposit',
    args: [toBytes32(commitment)],
    value: ONE_ETH,
    account: client.account!,
    chain: client.chain,
  });
  await client.waitForTransactionReceipt({ hash: depositHash });

  // 4. Real proof -> forwarder -> portal. Reconstruct the tree from Deposit events (bounded by
  // fromBlock to keep the scan tractable), then generate + submit the real proof.
  console.log('Reconstructing tree, generating the real proof, and bridging...');
  const leaves = await fetchDepositLeaves(client, tornado, { fromBlock: opts.fromBlock ?? POOL_DEPLOY_BLOCK_DEFAULT });
  const recipient = AztecAddress.fromField(new Fr(0xabcdefn));
  const deposit = await withdrawFromRealTornadoToBridge(
    { l1Client: client, bridge, denomination: ONE_ETH, factory },
    recipient,
    note,
    { tornado, leaves },
  );

  const lockedEth = await getTotalLockedEth(client, bridge);
  if (lockedEth !== ONE_ETH) {
    throw new Error(`Expected bridge to lock ${ONE_ETH} wei, got ${lockedEth}`);
  }
  console.log(`OK: real proof accepted, bridge locked ${lockedEth} wei (depositId ${deposit.depositId}).`);

  return { bridge, factory, lockedEth, depositId: deposit.depositId };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const fromBlock = process.env.TORNADO_FROM_BLOCK ? BigInt(process.env.TORNADO_FROM_BLOCK) : POOL_DEPLOY_BLOCK_DEFAULT;
  runRealTornadoRehearsal({ fromBlock })
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
