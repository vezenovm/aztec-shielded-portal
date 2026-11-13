#!/usr/bin/env node
/* eslint-disable */
/**
 * tornado-prove.cjs -- Tornado Classic withdrawal proof generator (circom1 / websnark).
 *
 * A faithful PORT of tornado-cli's proving path (`createDeposit` / `parseNote` / `generateProof`).
 * It is invoked by `proveViaTornadoCli` / `createTornadoNoteViaCli` in `src/real-tornado.ts` as a
 * child process with `cwd = $TORNADO_CLI_DIR`, so that:
 *   - `snarkjs` / `circomlib` / `fixed-merkle-tree` / `websnark/...` resolve against the tornado-cli
 *     clone's node_modules (the canonical circom1 + websnark forks) via a `createRequire` rooted at
 *     cwd -- a bare `require` would resolve relative to THIS file, not the checkout -- and
 *   - the circuit artifacts load from `<cwd>/build/circuits/{tornado.json,tornadoProvingKey.bin}`.
 *
 * Why delegate instead of using snarkjs/circom2: the classic mainnet verifier only accepts proofs
 * from Tornado's exact circom1 + websnark trusted setup; a snarkjs/circom2 proof would be REJECTED.
 *
 * NOTHING Tornado is bundled into this repo. The operator supplies a tornado-cli checkout
 * (`git clone https://github.com/tornadocash/tornado-cli && npm install`, then point
 * TORNADO_CLI_DIR at it). Running this is the operator's consented step -- see SECURITY.md and the
 * README "Real Tornado" section. The proof packing is validated end-to-end only by the env-gated
 * fork rehearsal (`scripts/real-tornado-rehearsal.ts`), never by the offline suite.
 *
 * Usage (argv[2] = subcommand, JSON payload on STDIN -- never argv, since the payload carries the
 * spendable note and argv is visible to other processes and echoed in spawn errors):
 *   echo '{"currency":"eth","amount":"1","netId":1}' | node tornado-prove.cjs create-note
 *     -> {"note":"tornado-eth-1-1-0x..","commitment":"0x..","nullifierHash":"0x.."}
 *   echo '{"note":"tornado-eth-1-1-0x..","recipient":"0x..","leaves":["123.."]}' | node tornado-prove.cjs prove
 *     -> {"proof":"0x..","root":"0x..","nullifierHash":"0x..","args":["0x.."]}
 *
 * `leaves` is the ordered list of pool commitments (decimal or hex) INCLUDING ours; for a freshly
 * self-deployed pool whose only deposit is ours, pass just our commitment.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

// Resolve tornado-cli's dependencies from its checkout (cwd), not from this repo.
const cliRequire = createRequire(path.join(process.cwd(), 'package.json'));
const snarkjs = cliRequire('snarkjs');
const circomlib = cliRequire('circomlib');
const merkleTree = cliRequire('fixed-merkle-tree');
const buildGroth16 = cliRequire('websnark/src/groth16');
const websnarkUtils = cliRequire('websnark/src/utils');

const bigInt = snarkjs.bigInt;
const MERKLE_TREE_HEIGHT = Number(process.env.MERKLE_TREE_HEIGHT || 20);

const rbigint = nbytes => bigInt.leBuff2int(crypto.randomBytes(nbytes));
const pedersenHash = data => circomlib.babyJub.unpackPoint(circomlib.pedersenHash.hash(data))[0];

function toHex(number, length = 32) {
  const str = number instanceof Buffer ? number.toString('hex') : bigInt(number).toString(16);
  return '0x' + str.padStart(length * 2, '0');
}

// Mirrors tornado-cli createDeposit: commitment = pedersen(nullifier ++ secret), nullifierHash = pedersen(nullifier).
function createDeposit({ nullifier, secret }) {
  const preimage = Buffer.concat([nullifier.leInt2Buff(31), secret.leInt2Buff(31)]);
  const commitment = pedersenHash(preimage);
  const nullifierHash = pedersenHash(nullifier.leInt2Buff(31));
  return {
    nullifier,
    secret,
    preimage,
    commitment,
    commitmentHex: toHex(commitment),
    nullifierHash,
    nullifierHex: toHex(nullifierHash),
  };
}

function parseNote(noteString) {
  const m = /tornado-(?<currency>\w+)-(?<amount>[\d.]+)-(?<netId>\d+)-0x(?<note>[0-9a-fA-F]{124})/g.exec(noteString);
  if (!m) throw new Error('The note has invalid format');
  const buf = Buffer.from(m.groups.note, 'hex');
  const nullifier = bigInt.leBuff2int(buf.slice(0, 31));
  const secret = bigInt.leBuff2int(buf.slice(31, 62));
  return { currency: m.groups.currency, amount: m.groups.amount, netId: Number(m.groups.netId), deposit: createDeposit({ nullifier, secret }) };
}

function createNote({ currency = 'eth', amount = '1', netId = 1 }) {
  const deposit = createDeposit({ nullifier: rbigint(31), secret: rbigint(31) });
  const note = toHex(deposit.preimage, 62);
  return { note: `tornado-${currency}-${amount}-${netId}-${note}`, commitment: deposit.commitmentHex, nullifierHash: deposit.nullifierHex };
}

async function prove({ note, recipient, leaves, relayer = 0, fee = 0, refund = 0 }) {
  const { deposit } = parseNote(note);

  // Build the merkle tree from the supplied (ordered) commitment leaves and locate ours.
  const decimalLeaves = leaves.map(l => bigInt(l).toString(10));
  const target = deposit.commitment.toString(10);
  const leafIndex = decimalLeaves.findIndex(l => l === target);
  if (leafIndex < 0) throw new Error('deposit commitment not found in supplied leaves');
  const tree = new merkleTree(MERKLE_TREE_HEIGHT, decimalLeaves);
  const root = tree.root();
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
  const circuit = require(path.join(process.cwd(), 'build/circuits/tornado.json'));
  const proving_key = fs.readFileSync(path.join(process.cwd(), 'build/circuits/tornadoProvingKey.bin')).buffer;
  const proofData = await websnarkUtils.genWitnessAndProve(groth16, input, circuit, proving_key);
  const { proof } = websnarkUtils.toSolidityInput(proofData);

  const args = [
    toHex(input.root),
    toHex(input.nullifierHash),
    toHex(input.recipient, 20),
    toHex(input.relayer, 20),
    toHex(input.fee),
    toHex(input.refund),
  ];
  return { proof, root: toHex(root), nullifierHash: deposit.nullifierHex, args };
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
    // websnark's groth16 leaves dangling promises that never resolve; exit explicitly like tornado-cli.
    process.exit(0);
  } catch (err) {
    process.stderr.write(String((err && err.stack) || err) + '\n');
    process.exit(1);
  }
})();
