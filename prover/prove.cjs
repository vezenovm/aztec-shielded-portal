#!/usr/bin/env node
/* eslint-disable */
/**
 * Tornado Classic note creation + withdrawal proving: a port of tornado-cli's `createDeposit` /
 * `parseNote` / `generateProof`, run against this package's pinned circom1/websnark toolchain and the
 * sha256-checked circuit + proving key in ./assets (see assets.json). The classic verifier only
 * accepts proofs from that exact toolchain and trusted setup.
 *
 * Invoked by `src/real-tornado.ts` as a child process. The payload goes over STDIN (never argv: it
 * carries the spendable note); one JSON result line goes to stdout.
 *   create-note  {"currency":"eth","amount":"1","netId":1}
 *     -> {"note","commitment","nullifierHash"}
 *   prove        {"note","recipient","leaves":[...],"expectedRoot"?,"relayer"?,"fee"?,"refund"?}
 *     -> {"proof","root","nullifierHash","args":[root,nullifierHash,recipient,relayer,fee,refund]}
 *
 * `leaves` is the pool's ordered commitment list including ours. When `expectedRoot` is given, the
 * rebuilt root must equal it before the (slow) witness/proof generation starts.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const snarkjs = require('snarkjs');
const circomlib = require('circomlib');
const MerkleTree = require('fixed-merkle-tree');
const buildGroth16 = require('websnark/src/groth16');
const websnarkUtils = require('websnark/src/utils');

const bigInt = snarkjs.bigInt;
const MERKLE_TREE_HEIGHT = 20;
const CIRCUITS = path.join(__dirname, 'assets/build/circuits');

const rbigint = nbytes => bigInt.leBuff2int(crypto.randomBytes(nbytes));
const pedersenHash = data => circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0];

function toHex(number, length = 32) {
  const str = number instanceof Buffer ? number.toString('hex') : bigInt(number).toString(16);
  return '0x' + str.padStart(length * 2, '0');
}

function createDeposit({ nullifier, secret }) {
  const preimage = Buffer.concat([nullifier.leInt2Buff(31), secret.leInt2Buff(31)]);
  return {
    nullifier,
    secret,
    preimage,
    commitment: pedersenHash(preimage),
    nullifierHash: pedersenHash(nullifier.leInt2Buff(31)),
  };
}

function parseNote(noteString) {
  const m = /^tornado-(\w+)-([\d.]+)-(\d+)-0x([0-9a-fA-F]{124})$/.exec(noteString.trim());
  if (!m) throw new Error('The note has invalid format');
  const buf = Buffer.from(m[4], 'hex');
  return createDeposit({ nullifier: bigInt.leBuff2int(buf.slice(0, 31)), secret: bigInt.leBuff2int(buf.slice(31, 62)) });
}

function createNote({ currency = 'eth', amount = '1', netId = 1 }) {
  const deposit = createDeposit({ nullifier: rbigint(31), secret: rbigint(31) });
  return {
    note: `tornado-${currency}-${amount}-${netId}-${toHex(deposit.preimage, 62)}`,
    commitment: toHex(deposit.commitment),
    nullifierHash: toHex(deposit.nullifierHash),
  };
}

async function prove({ note, recipient, leaves, expectedRoot, relayer = 0, fee = 0, refund = 0 }) {
  const deposit = parseNote(note);

  const decimalLeaves = leaves.map(l => bigInt(l).toString(10));
  const leafIndex = decimalLeaves.indexOf(deposit.commitment.toString(10));
  if (leafIndex < 0) throw new Error('deposit commitment not found in supplied leaves');
  const tree = new MerkleTree(MERKLE_TREE_HEIGHT, decimalLeaves);
  const root = tree.root();
  if (expectedRoot !== undefined && !bigInt(expectedRoot).equals(bigInt(root))) {
    throw new Error(`rebuilt root ${toHex(root)} != expected ${expectedRoot}`);
  }
  const { pathElements, pathIndices } = tree.path(leafIndex);

  const input = {
    root,
    nullifierHash: deposit.nullifierHash,
    recipient: bigInt(recipient),
    relayer: bigInt(relayer),
    fee: bigInt(fee),
    refund: bigInt(refund),
    nullifier: deposit.nullifier,
    secret: deposit.secret,
    pathElements,
    pathIndices,
  };

  const groth16 = await buildGroth16();
  const circuit = JSON.parse(fs.readFileSync(path.join(CIRCUITS, 'tornado.json'), 'utf8'));
  const keyBuf = fs.readFileSync(path.join(CIRCUITS, 'tornadoProvingKey.bin'));
  const provingKey = keyBuf.buffer.slice(keyBuf.byteOffset, keyBuf.byteOffset + keyBuf.byteLength);
  const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, provingKey);
  const { proof } = websnarkUtils.toSolidityInput(proofData);

  return {
    proof,
    root: toHex(root),
    nullifierHash: toHex(deposit.nullifierHash),
    args: [
      toHex(input.root),
      toHex(input.nullifierHash),
      toHex(input.recipient, 20),
      toHex(input.relayer, 20),
      toHex(input.fee),
      toHex(input.refund),
    ],
  };
}

(async () => {
  try {
    const cmd = process.argv[2];
    const raw = fs.readFileSync(0, 'utf8');
    const payload = raw.trim() ? JSON.parse(raw) : {};
    let out;
    if (cmd === 'create-note') out = createNote(payload);
    else if (cmd === 'prove') out = await prove(payload);
    else throw new Error(`unknown subcommand: ${cmd} (expected "create-note" | "prove")`);
    process.stdout.write(JSON.stringify(out) + '\n');
    // websnark's workers keep the event loop alive; exit explicitly like tornado-cli.
    process.exit(0);
  } catch (err) {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exit(1);
  }
})();
