/**
 * Real-Tornado fork rehearsal (opt-in): `RUN_REAL_TORNADO=1` plus MAINNET_RPC_URL (or L1_RPC_URL +
 * AZTEC_NODE_URL for a running fork). Once enabled, missing prerequisites fail rather than skip.
 * See scripts/real-tornado-rehearsal.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runRealTornadoRehearsal } from '../../scripts/real-tornado-rehearsal.js';

test(
  'a real Tornado proof is accepted by the real verifier and the bridge round trip settles on a mainnet fork',
  { skip: process.env.RUN_REAL_TORNADO === '1' ? false : 'set RUN_REAL_TORNADO=1 (see the rehearsal script)', timeout: 3_600_000 },
  async () => {
    const result = await runRealTornadoRehearsal();
    assert.equal(result.mode, 'full');
  },
);
