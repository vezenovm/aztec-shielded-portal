/**
 * Real-Tornado rehearsal: a REAL Groth16 (circom1/websnark) proof, accepted by the REAL Tornado
 * verifier, driving the full forwarder -> portal handoff -- on a mainnet fork, no real funds.
 *
 * This is the rung that proves our off-chain proof plumbing (pedersen/MiMC derivations, public-signal
 * ordering, the Groth16->Solidity proof packing) is byte-accepted by the actual mainnet verifier --
 * the one thing the Tier 2 forge fork test mocks out. It is L1-only (the Aztec claim is exercised by
 * the sandbox e2e + the Phase 4 Sepolia rehearsal).
 *
 * Design (resolves "self-deployed pool" + "local anvil WITH fork"): we deploy our OWN `ETHTornado`
 * on the fork, pointed at the REAL on-chain Verifier (+ the canonical MiMC hasher hardcoded at its
 * mainnet address, present on the fork), deposit a single leaf we own, and prove against our fresh
 * root. So we validate packing against the real verifier with NO mainnet leaf history.
 *
 * PREREQUISITES (none are bundled here; running this is the operator's consented step -- see
 * SECURITY.md):
 *   1. A mainnet fork: `aztec-anvil --fork-url $MAINNET_RPC_URL` -- then set L1_RPC_URL to it.
 *   2. A tornado-cli checkout with deps installed, and TORNADO_CLI_DIR pointing at it:
 *        git clone https://github.com/tornadocash/tornado-cli && cd tornado-cli && npm install
 *      (tornado-cli ships the circom1/websnark toolchain + the ETHTornado artifact we deploy from.)
 *
 * VALIDATE: if the real verifier rejects the proof, the most likely culprit is tornado-cli's proof
 * packing assumptions vs our pinned tornado-cli commit -- re-pin tornado-cli, or compare against its
 * own `withdraw` command output.
 */
import { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { deployL1Contract } from '@aztec-labs/ethereum/deploy-l1-contract';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { type Abi, parseAbi } from 'viem';

import MockInboxJson from '../contracts/l1/out/MessagingMocks.sol/MockInbox.json' with { type: 'json' };
import MockOutboxJson from '../contracts/l1/out/MessagingMocks.sol/MockOutbox.json' with { type: 'json' };
import MockRegistryJson from '../contracts/l1/out/MessagingMocks.sol/MockRegistry.json' with { type: 'json' };
import MockRollupJson from '../contracts/l1/out/MessagingMocks.sol/MockRollup.json' with { type: 'json' };
import {
  deployForwarderFactory,
  deployOwnTornadoPool,
  deployTornadoBridge,
  getTotalLockedEth,
  initializeBridge,
  makeL1Client,
  ONE_ETH,
  readTornadoVerifier,
  setForwarderFactory,
  TEST_MNEMONIC,
  withdrawFromRealTornadoToBridge,
  type L1Client,
} from '../src/index.js';
import { createTornadoNoteViaCli, TORNADO_1ETH_MAINNET } from '../src/real-tornado.js';

const tornadoDepositAbi = parseAbi(['function deposit(bytes32 _commitment) external payable']);

function requireEnv(name: string, hint: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required (${hint})`);
  }
  return value;
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
  ownTornado: `0x${string}`;
  lockedEth: bigint;
  depositId: `0x${string}`;
}

export async function runRealTornadoRehearsal(
  opts: { rpcUrl?: string; chainId?: number; cliDir?: string; realPool?: `0x${string}` } = {},
): Promise<RehearsalResult> {
  const cliDir = opts.cliDir ?? requireEnv('TORNADO_CLI_DIR', 'a tornado-cli checkout with deps installed');
  const client = makeL1Client({
    rpcUrl: opts.rpcUrl ?? requireEnv('L1_RPC_URL', 'a mainnet fork endpoint, e.g. aztec-anvil --fork-url'),
    chainId: opts.chainId ?? Number(process.env.L1_CHAIN_ID ?? 1),
    mnemonic: process.env.L1_MNEMONIC ?? TEST_MNEMONIC,
  });

  // 1. Our own ETHTornado on the fork, pointed at the REAL verifier read from the canonical pool.
  const realPool = opts.realPool ?? TORNADO_1ETH_MAINNET;
  const verifier = await readTornadoVerifier(client, realPool);
  console.log(`Deploying our own ETHTornado (verifier=${verifier}) on the fork...`);
  const ownTornado = await deployOwnTornadoPool(client, cliDir, { verifier });

  // 2. A fresh note (via tornado-cli's pedersen), deposited so we own the only leaf.
  console.log('Generating + depositing a fresh Tornado note...');
  const { note, commitment } = createTornadoNoteViaCli(cliDir);
  const depositHash = await client.writeContract({
    address: ownTornado,
    abi: tornadoDepositAbi,
    functionName: 'deposit',
    args: [commitment],
    value: ONE_ETH,
    account: client.account!,
    chain: client.chain,
  });
  await client.waitForTransactionReceipt({ hash: depositHash });

  // 3. L1-only Aztec messaging stubs + the bridge + a forwarder factory pointed at our pool.
  console.log('Deploying messaging mocks + bridge + forwarder factory...');
  const inbox = await deployMock(client, MockInboxJson, []);
  const outbox = await deployMock(client, MockOutboxJson, []);
  const rollup = await deployMock(client, MockRollupJson, [inbox, outbox, 1n]);
  const registry = await deployMock(client, MockRegistryJson, [rollup]);
  const bridge = await deployTornadoBridge(client);
  await initializeBridge(client, bridge, EthAddress.fromString(registry), await AztecAddress.random());
  const factory = await deployForwarderFactory(client, bridge, ownTornado);
  await setForwarderFactory(client, bridge, factory);

  // 4. Real proof bound to the forwarder -> factory -> portal. Our pool's only leaf is ours.
  console.log('Generating the real proof and bridging...');
  const recipient = await AztecAddress.random();
  const deposit = await withdrawFromRealTornadoToBridge(
    { l1Client: client, bridge, denomination: ONE_ETH, factory },
    recipient,
    note,
    { cliDir, leaves: [commitment] },
  );

  const lockedEth = await getTotalLockedEth(client, bridge);
  if (lockedEth !== ONE_ETH) {
    throw new Error(`Expected bridge to lock ${ONE_ETH} wei, got ${lockedEth}`);
  }
  console.log(`OK: real proof accepted, bridge locked ${lockedEth} wei (depositId ${deposit.depositId}).`);

  return { bridge, factory, ownTornado, lockedEth, depositId: deposit.depositId };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runRealTornadoRehearsal()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
