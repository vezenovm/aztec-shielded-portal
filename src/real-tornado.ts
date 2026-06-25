/**
 * Real Tornado Cash integration (Option B: CREATE2 forwarder binding).
 *
 * The classic Tornado ETH pool pays the recipient via a plain `recipient.call{value}("")` with NO
 * calldata, so it cannot carry an Aztec mint commitment. We bind the commitment into the proof-bound
 * `recipient` instead: the recipient is a per-commitment CREATE2 `Forwarder` whose address IS the
 * commitment (salt). The portal re-derives that address and matches it against msg.sender, so the
 * commitment cannot be swapped without invalidating the Tornado proof.
 *
 * This module has two layers:
 *  - PURE helpers (note parsing, CREATE2 address derivation) -- deterministic, unit-tested offline.
 *  - PROOF/TREE helpers (pedersen, merkle reconstruction, Groth16) -- they dynamic-import the
 *    optional toolchain (`circomlibjs`, `fixed-merkle-tree`, `snarkjs`) and require the CANONICAL
 *    tornado-core circuit artifacts (withdraw.wasm + withdraw_final.zkey). They follow the
 *    tornado-cli reference; the exact Groth16 -> Solidity proof packing MUST be validated against
 *    the real verifier via the Tier 3 fork test (`test/fork/real-tornado.fork.test.ts`). It is NOT
 *    exercised by the offline suite.
 */
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { concat, encodeAbiParameters, getContractAddress, keccak256, parseAbiItem, parseAbiParameters } from 'viem';

import { computeAztecMintCommitment } from './commitment.js';
import type { L1Client } from './deploy.js';
import { ForwarderBytecode } from './l1-artifacts.js';

/** Canonical Tornado.Cash 1 ETH pool on Ethereum mainnet. */
export const TORNADO_1ETH_MAINNET = '0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936' as const;
/** Tornado merkle tree depth for the canonical instances. */
export const MERKLE_LEVELS = 20;
/** Tornado's empty-leaf value (keccak256("tornado") % FIELD_SIZE), used as the tree's zeroElement. */
export const TORNADO_ZERO_VALUE =
  '21663839004416932945382355908790599225266501822907911457504978515578255421292';

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

function leInt2Buff(value: bigint, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let v = value;
  for (let i = 0; i < length; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return buf;
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
/*          Proof/tree helpers (require the optional Tornado toolchain)        */
/* -------------------------------------------------------------------------- */

/**
 * Tornado commitment + nullifierHash from a note, via babyjubjub pedersen hashing (circomlibjs).
 * commitment = pedersen(nullifier ++ secret); nullifierHash = pedersen(nullifier). Matches
 * tornado-cli's `pedersenHash` util.
 */
export async function computeTornadoCommitments(
  note: TornadoNote,
): Promise<{ commitment: bigint; nullifierHash: bigint }> {
  const circomlibjs = await import('circomlibjs');
  const pedersen = await circomlibjs.buildPedersenHash();
  const babyJub = await circomlibjs.buildBabyjub();
  const hash = (data: Buffer): bigint => babyJub.F.toObject(babyJub.unpackPoint(pedersen.hash(data))[0]);
  return {
    commitment: hash(note.preimage),
    nullifierHash: hash(leInt2Buff(note.nullifier, 31)),
  };
}

/**
 * Generate a fresh Tornado note (random 31-byte nullifier + secret) and its commitment, for
 * depositing into a pool during a rehearsal. The commitment is what you pass to `pool.deposit`.
 */
export async function generateTornadoNote(
  opts: { currency?: string; amount?: string; netId?: number } = {},
): Promise<{ note: string; commitment: bigint; nullifierHash: bigint }> {
  const preimage = Buffer.concat([leInt2Buff(randomFieldBytes(31), 31), leInt2Buff(randomFieldBytes(31), 31)]);
  const note = `tornado-${opts.currency ?? 'eth'}-${opts.amount ?? '1'}-${opts.netId ?? 1}-0x${preimage.toString('hex')}`;
  const { commitment, nullifierHash } = await computeTornadoCommitments(parseTornadoNote(note));
  return { note, commitment, nullifierHash };
}

function randomFieldBytes(length: number): bigint {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return leBuff2Bigint(Buffer.from(bytes));
}

/** Fetch all Deposit-event commitments from a Tornado pool, ordered by leaf index. */
export async function fetchDepositLeaves(
  client: L1Client,
  tornado: `0x${string}`,
  opts: { fromBlock?: bigint; toBlock?: bigint; pageSize?: bigint } = {},
): Promise<bigint[]> {
  const event = parseAbiItem('event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)');
  const pageSize = opts.pageSize ?? 50_000n;
  const fromBlock = opts.fromBlock ?? 0n;
  const toBlock = opts.toBlock ?? (await client.getBlockNumber());

  const found: Array<{ leafIndex: number; commitment: bigint }> = [];
  for (let start = fromBlock; start <= toBlock; start += pageSize) {
    const end = start + pageSize - 1n > toBlock ? toBlock : start + pageSize - 1n;
    const logs = await client.getLogs({ address: tornado, event, fromBlock: start, toBlock: end });
    for (const log of logs) {
      const args = (log as unknown as { args: { commitment: `0x${string}`; leafIndex: number } }).args;
      found.push({ leafIndex: Number(args.leafIndex), commitment: BigInt(args.commitment) });
    }
  }
  found.sort((a, b) => a.leafIndex - b.leafIndex);
  return found.map(d => d.commitment);
}

/** Reconstruct the Tornado merkle tree (MiMCSponge) from ordered leaves. */
export async function buildMerkleTree(leaves: bigint[]): Promise<{ tree: any; root: string }> {
  const { MerkleTree } = await import('fixed-merkle-tree');
  const circomlibjs = await import('circomlibjs');
  const mimc = await circomlibjs.buildMimcSponge();
  const hashFn = (left: string, right: string): string => mimc.F.toString(mimc.multiHash([BigInt(left), BigInt(right)]));
  const tree = new MerkleTree(MERKLE_LEVELS, leaves.map(String), {
    hashFunction: hashFn,
    zeroElement: TORNADO_ZERO_VALUE,
  });
  return { tree, root: tree.root as string };
}

function toBytes32(value: bigint | string): `0x${string}` {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

/**
 * Generate a real Tornado withdrawal Groth16 proof bound to `recipient` (the forwarder address).
 *
 * Requires the CANONICAL tornado-core circuit artifacts -- the mainnet pool's verifier only accepts
 * proofs from that exact trusted setup. Provide their paths via `wasmPath`/`zkeyPath` (or the
 * `TORNADO_WASM_PATH`/`TORNADO_ZKEY_PATH` env vars).
 *
 * VALIDATE: the Groth16 -> Solidity `bytes _proof` packing below (the pi_b element order in
 * particular) must be confirmed against the real verifier via the Tier 3 fork test. It is the single
 * most likely point of incompatibility and is intentionally NOT exercised by the offline suite.
 */
export async function generateWithdrawProof(opts: {
  note: TornadoNote;
  tree: any;
  recipient: `0x${string}`;
  relayer?: `0x${string}`;
  fee?: bigint;
  refund?: bigint;
  wasmPath?: string;
  zkeyPath?: string;
}): Promise<{ proof: `0x${string}`; root: `0x${string}`; nullifierHash: `0x${string}` }> {
  const snarkjs = await import('snarkjs');
  const wasmPath = opts.wasmPath ?? requireEnv('TORNADO_WASM_PATH');
  const zkeyPath = opts.zkeyPath ?? requireEnv('TORNADO_ZKEY_PATH');

  const { commitment, nullifierHash } = await computeTornadoCommitments(opts.note);
  const leafIndex: number = opts.tree.indexOf(commitment.toString());
  if (leafIndex < 0) {
    throw new Error('Tornado commitment not found in the reconstructed tree (stale or wrong leaf set?)');
  }
  const { pathElements, pathIndices } = opts.tree.path(leafIndex);

  const input = {
    root: opts.tree.root,
    nullifierHash: nullifierHash.toString(),
    recipient: BigInt(opts.recipient).toString(),
    relayer: BigInt(opts.relayer ?? '0x0000000000000000000000000000000000000000').toString(),
    fee: (opts.fee ?? 0n).toString(),
    refund: (opts.refund ?? 0n).toString(),
    nullifier: opts.note.nullifier.toString(),
    secret: opts.note.secret.toString(),
    pathElements,
    pathIndices,
  };

  const { proof } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
  return { proof: packGroth16Proof(proof), root: toBytes32(opts.tree.root), nullifierHash: toBytes32(nullifierHash) };
}

/**
 * Pack a snarkjs Groth16 proof into the `bytes _proof` the Tornado verifier expects: eight 32-byte
 * words [a0,a1, b00,b01,b10,b11, c0,c1] with the pi_b coordinate pairs swapped (the standard
 * snarkjs->Solidity convention). VALIDATE against the real verifier (Tier 3) before trusting.
 */
function packGroth16Proof(proof: {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}): `0x${string}` {
  const words = [
    proof.pi_a[0],
    proof.pi_a[1],
    proof.pi_b[0][1],
    proof.pi_b[0][0],
    proof.pi_b[1][1],
    proof.pi_b[1][0],
    proof.pi_c[0],
    proof.pi_c[1],
  ];
  return `0x${words.map(w => BigInt(w).toString(16).padStart(64, '0')).join('')}`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for real Tornado proof generation (path to the canonical circuit artifact)`);
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/*                        High-level note -> proof bundle                      */
/* -------------------------------------------------------------------------- */

export interface RealWithdrawalPayload {
  proof: `0x${string}`;
  root: `0x${string}`;
  nullifierHash: `0x${string}`;
  /** The Aztec mint commitment (forwarder CREATE2 salt). */
  commitment: Fr;
  mintSecret: Fr;
  /** The forwarder address named as the Tornado proof recipient. */
  forwarder: `0x${string}`;
}

/**
 * End-to-end real-withdrawal payload builder: parse the note, derive the Aztec commitment + forwarder
 * recipient, reconstruct the tree, and produce the Groth16 proof. The returned bundle is what
 * `ForwarderFactory.withdrawAndBridge` consumes. See {@link generateWithdrawProof} for the artifact
 * requirements and the proof-packing validation caveat.
 */
export async function buildRealWithdrawalPayload(opts: {
  client: L1Client;
  tornado: `0x${string}`;
  factory: `0x${string}`;
  recipient: AztecAddress;
  amount: bigint;
  note: string;
  mintSecret?: Fr;
  forwarderInitCodeHash: `0x${string}`;
  leaves?: bigint[];
  wasmPath?: string;
  zkeyPath?: string;
}): Promise<RealWithdrawalPayload> {
  const note = parseTornadoNote(opts.note);
  const mintSecret = opts.mintSecret ?? Fr.random();
  const commitment = await computeAztecMintCommitment(opts.recipient, mintSecret, opts.amount);
  const forwarder = computeForwarderAddress(opts.factory, commitment.toString(), opts.forwarderInitCodeHash);

  const leaves = opts.leaves ?? (await fetchDepositLeaves(opts.client, opts.tornado));
  const { tree } = await buildMerkleTree(leaves);

  const { proof, root, nullifierHash } = await generateWithdrawProof({
    note,
    tree,
    recipient: forwarder,
    wasmPath: opts.wasmPath,
    zkeyPath: opts.zkeyPath,
  });

  return { proof, root, nullifierHash, commitment, mintSecret, forwarder };
}
