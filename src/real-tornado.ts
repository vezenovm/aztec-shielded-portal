/**
 * Real Tornado Cash (Classic) integration -- Option B: CREATE2 forwarder binding.
 *
 * The classic Tornado ETH pool pays the recipient via a plain `recipient.call{value}("")` with NO
 * calldata, so it cannot carry an Aztec mint commitment. We bind the commitment into the proof-bound
 * `recipient` instead: the recipient is a per-commitment CREATE2 `Forwarder` whose address IS the
 * commitment (salt). The portal re-derives that address and matches it against msg.sender, so the
 * commitment cannot be swapped without invalidating the Tornado proof.
 *
 * Two layers:
 *  - PURE helpers (note parsing, CREATE2 address derivation) -- deterministic, unit-tested offline
 *    (`test/real-tornado.test.ts`).
 *  - PROVING (`createTornadoNoteViaCli`, `proveViaTornadoCli`) -- DELEGATED to a caller-supplied
 *    tornado-cli checkout (`$TORNADO_CLI_DIR`) via `scripts/tornado-prove.cjs`. The classic mainnet
 *    verifier only accepts circom1 + websnark proofs from Tornado's exact trusted setup, so we reuse
 *    tornado-cli's bundled toolchain rather than re-implement it (a snarkjs/circom2 proof would be
 *    REJECTED). Nothing Tornado is vendored here; installing/running tornado-cli is the operator's
 *    consented step (see SECURITY.md). The proof packing is validated end-to-end only by the
 *    env-gated fork rehearsal (`scripts/real-tornado-rehearsal.ts`), never by the offline suite.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { concat, encodeAbiParameters, getContractAddress, keccak256, parseAbiParameters } from 'viem';

import { ForwarderBytecode } from './l1-artifacts.js';

/** Canonical Tornado.Cash 1 ETH pool on Ethereum mainnet (Classic). */
export const TORNADO_1ETH_MAINNET = '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936' as const;
/** Tornado merkle tree depth for the canonical instances. */
export const MERKLE_LEVELS = 20;

/* -------------------------------------------------------------------------- */
/*                          Pure helpers (unit-tested)                        */
/* -------------------------------------------------------------------------- */

export interface TornadoNote {
  currency: string;
  amount: string;
  netId: number;
  /** 31-byte little-endian nullifier. */
  nullifier: bigint;
  /** 31-byte little-endian secret. */
  secret: bigint;
  /** The 62-byte (nullifier ++ secret) preimage. */
  preimage: Buffer;
}

const NOTE_RE = /^tornado-(?<currency>\w+)-(?<amount>[\d.]+)-(?<netId>\d+)-0x(?<note>[0-9a-fA-F]{124})$/;

/** Parse a Tornado note string `tornado-<currency>-<amount>-<netId>-0x<124 hex>`. */
export function parseTornadoNote(note: string): TornadoNote {
  const match = NOTE_RE.exec(note.trim());
  if (!match?.groups) {
    throw new Error(`Invalid Tornado note format: ${note}`);
  }
  const preimage = Buffer.from(match.groups.note, 'hex'); // 62 bytes
  return {
    currency: match.groups.currency,
    amount: match.groups.amount,
    netId: Number(match.groups.netId),
    nullifier: leBuff2Bigint(preimage.subarray(0, 31)),
    secret: leBuff2Bigint(preimage.subarray(31, 62)),
    preimage,
  };
}

function leBuff2Bigint(buf: Buffer): bigint {
  let result = 0n;
  for (let i = buf.length - 1; i >= 0; i--) {
    result = (result << 8n) + BigInt(buf[i]);
  }
  return result;
}

/** keccak256(Forwarder.creationCode ++ abi.encode(portal, denomination)) -- the CREATE2 init-code hash. */
export function computeForwarderInitCodeHash(portal: `0x${string}`, denomination: bigint): `0x${string}` {
  const args = encodeAbiParameters(parseAbiParameters('address, uint256'), [portal, denomination]);
  return keccak256(concat([ForwarderBytecode, args]));
}

/**
 * The deterministic forwarder address for a commitment -- the address a real Tornado withdrawal must
 * name as its proof-bound `recipient`. Mirrors `ForwarderFactory.computeForwarderAddress` /
 * `TornadoEthBridgeL1._computeForwarderAddress`. (In flows that already have the factory deployed,
 * prefer reading `factory.computeForwarderAddress(commitment)` on-chain as the source of truth.)
 */
export function computeForwarderAddress(
  factory: `0x${string}`,
  commitment: `0x${string}`,
  initCodeHash: `0x${string}`,
): `0x${string}` {
  return getContractAddress({ opcode: 'CREATE2', from: factory, salt: commitment, bytecodeHash: initCodeHash });
}

/* -------------------------------------------------------------------------- */
/*           Proving: delegated to a BYO tornado-cli ($TORNADO_CLI_DIR)        */
/* -------------------------------------------------------------------------- */

/** scripts/tornado-prove.cjs -- the CJS port run inside the tornado-cli checkout. */
const PROVE_HELPER = join(dirname(fileURLToPath(import.meta.url)), '../scripts/tornado-prove.cjs');

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export interface TornadoProof {
  /** ABI-encoded Groth16 proof bytes the Tornado `withdraw` verifier expects. */
  proof: `0x${string}`;
  root: `0x${string}`;
  nullifierHash: `0x${string}`;
  /** Withdraw public args, hex: [root, nullifierHash, recipient, relayer, fee, refund]. */
  args: [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`];
}

/**
 * Run `scripts/tornado-prove.cjs` inside `cliDir` ($TORNADO_CLI_DIR) so its requires resolve against
 * tornado-cli's (circom1 + websnark) node_modules and its `build/circuits` artifacts. Throws with the
 * helper's stderr if tornado-cli is missing/uninstalled -- that toolchain is the operator's to set up.
 */
function runHelper(cliDir: string, sub: 'create-note' | 'prove', payload: unknown): unknown {
  const out = execFileSync(process.execPath, [PROVE_HELPER, sub, JSON.stringify(payload)], {
    cwd: cliDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out.trim().split('\n').pop() as string);
}

/**
 * Generate a fresh Tornado note + commitment via tornado-cli's pedersen derivation. Used by the
 * rehearsal to deposit a leaf we own into the (forked) pool before proving against it.
 */
export function createTornadoNoteViaCli(
  cliDir: string,
  opts: { currency?: string; amount?: string; netId?: number } = {},
): { note: string; commitment: `0x${string}`; nullifierHash: `0x${string}` } {
  return runHelper(cliDir, 'create-note', {
    currency: opts.currency ?? 'eth',
    amount: opts.amount ?? '1',
    netId: opts.netId ?? 1,
  }) as { note: string; commitment: `0x${string}`; nullifierHash: `0x${string}` };
}

/**
 * Generate a real Tornado Classic withdrawal proof bound to `recipient` (the forwarder address) by
 * delegating to `scripts/tornado-prove.cjs` inside `cliDir`. `leaves` is the ordered pool commitment
 * set INCLUDING ours; for a freshly self-deployed pool whose only deposit is ours, pass `[commitment]`.
 * `relayer`/`fee`/`refund` are hard-zeroed (relayers out of scope this milestone).
 */
export function proveViaTornadoCli(opts: {
  cliDir: string;
  note: string;
  recipient: `0x${string}`;
  leaves: Array<`0x${string}` | string>;
  relayer?: `0x${string}`;
  fee?: bigint;
  refund?: bigint;
}): TornadoProof {
  return runHelper(opts.cliDir, 'prove', {
    note: opts.note,
    recipient: opts.recipient,
    leaves: opts.leaves.map(String),
    relayer: opts.relayer ?? ZERO_ADDRESS,
    fee: (opts.fee ?? 0n).toString(),
    refund: (opts.refund ?? 0n).toString(),
  }) as TornadoProof;
}
