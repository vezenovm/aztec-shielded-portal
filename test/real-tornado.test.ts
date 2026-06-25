import assert from 'node:assert/strict';
import { test } from 'node:test';

import { concat, keccak256 } from 'viem';

import {
  computeForwarderAddress,
  computeForwarderInitCodeHash,
  parseTornadoNote,
} from '../src/real-tornado.js';

test('parseTornadoNote extracts currency/amount/netId and the LE nullifier+secret', () => {
  // 62-byte preimage: byte0 = 0x01 (nullifier = 1), byte31 = 0x02 (secret = 2), rest zero.
  const preimage = '01' + '00'.repeat(30) + '02' + '00'.repeat(30);
  const note = parseTornadoNote(`tornado-eth-1-1-0x${preimage}`);

  assert.equal(note.currency, 'eth');
  assert.equal(note.amount, '1');
  assert.equal(note.netId, 1);
  assert.equal(note.preimage.length, 62);
  assert.equal(note.nullifier, 1n, 'little-endian nullifier');
  assert.equal(note.secret, 2n, 'little-endian secret');
});

test('parseTornadoNote rejects malformed notes', () => {
  assert.throws(() => parseTornadoNote('not-a-note'));
  assert.throws(() => parseTornadoNote('tornado-eth-1-1-0xdeadbeef'), /Invalid Tornado note/);
});

test('computeForwarderInitCodeHash is a deterministic 32-byte hash of (portal, denomination)', () => {
  const portal = `0x${'ab'.repeat(20)}` as const;
  const h1 = computeForwarderInitCodeHash(portal, 10n ** 18n);
  const h2 = computeForwarderInitCodeHash(portal, 10n ** 18n);
  assert.equal(h1, h2);
  assert.match(h1, /^0x[0-9a-f]{64}$/);
  assert.notEqual(h1, computeForwarderInitCodeHash(portal, 2n * 10n ** 18n), 'denomination changes the hash');
});

test('computeForwarderAddress matches the raw CREATE2 formula (0xff ++ factory ++ salt ++ initCodeHash)', () => {
  const factory = `0x${'11'.repeat(20)}` as const;
  const portal = `0x${'22'.repeat(20)}` as const;
  const commitment = `0x${'ab'.repeat(32)}` as const;

  const initCodeHash = computeForwarderInitCodeHash(portal, 10n ** 18n);
  const viaHelper = computeForwarderAddress(factory, commitment, initCodeHash);

  const manual = `0x${keccak256(concat(['0xff', factory, commitment, initCodeHash])).slice(-40)}`;
  assert.equal(viaHelper.toLowerCase(), manual.toLowerCase());
});
