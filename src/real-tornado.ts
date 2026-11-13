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
 *  - Pure helpers (note parsing, CREATE2 address derivation), unit-tested offline.
 *  - Proving, delegated to the opt-in `prover/` package: the classic verifier only accepts circom1 +
 *    websnark proofs from Tornado's trusted setup, so we run that toolchain rather than re-implement
 *    it. It is exercised only by the fork rehearsal (`scripts/real-tornado-rehearsal.ts`).
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  concat,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type PublicClient,
} from 'viem';

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
/*                 Proving: the isolated prover/ package (opt-in)              */
/* -------------------------------------------------------------------------- */

const PROVER = join(dirname(fileURLToPath(import.meta.url)), '../prover/prove.cjs');

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
 * Run `prover/prove.cjs` (installed by `yarn prover:install`). The payload carries the spendable
 * note, so it goes over stdin, and a failure is rethrown with only the child's stderr.
 */
function runProver(sub: 'create-note' | 'prove', payload: unknown): unknown {
  let out: string;
  try {
    out = execFileSync(process.execPath, [PROVER, sub], {
      input: JSON.stringify(payload),
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60_000,
    });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    throw new Error(`tornado prover ${sub} failed: ${stderr || 'no output (run `yarn prover:install`)'}`);
  }
  return JSON.parse(out.trim().split('\n').pop() as string);
}

/** A fresh Tornado note and its pedersen commitment, ready to `deposit` into a pool. */
export function createTornadoNote(
  opts: { currency?: string; amount?: string; netId?: number } = {},
): { note: string; commitment: `0x${string}`; nullifierHash: `0x${string}` } {
  return runProver('create-note', {
    currency: opts.currency ?? 'eth',
    amount: opts.amount ?? '1',
    netId: opts.netId ?? 1,
  }) as { note: string; commitment: `0x${string}`; nullifierHash: `0x${string}` };
}

/**
 * A Tornado Classic withdrawal proof bound to `recipient` (the forwarder address). `leaves` is the
 * pool's ordered commitment list including ours; with `expectedRoot` the prover refuses to prove
 * against any other rebuilt root. Relayer, fee and refund are zero.
 */
export function proveTornadoWithdrawal(opts: {
  note: string;
  recipient: `0x${string}`;
  leaves: Array<`0x${string}` | string>;
  expectedRoot?: `0x${string}`;
}): TornadoProof {
  return runProver('prove', {
    note: opts.note,
    recipient: opts.recipient,
    leaves: opts.leaves.map(String),
    expectedRoot: opts.expectedRoot,
    relayer: ZERO_ADDRESS,
    fee: '0',
    refund: '0',
  }) as TornadoProof;
}

const verifierAbi = parseAbi(['function verifyProof(bytes proof, uint256[6] input) view returns (bool)']);

/** Ask a Tornado `Verifier` directly whether it accepts `proof` for the given public args. */
export async function verifyTornadoProof(
  client: Pick<PublicClient, 'readContract'>,
  verifier: `0x${string}`,
  proof: `0x${string}`,
  args: TornadoProof['args'],
): Promise<boolean> {
  try {
    return await client.readContract({
      address: verifier,
      abi: verifierAbi,
      functionName: 'verifyProof',
      args: [proof, args.map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]],
    });
  } catch {
    return false;
  }
}
