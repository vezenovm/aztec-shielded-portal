/**
 * Tier 3 (env-gated): runs the real-proof rehearsal and asserts the bridge locked the denomination.
 * Skips unless a fork RPC and the canonical circuit artifacts are configured. See
 * scripts/real-tornado-rehearsal.ts for the full prerequisites.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runRealTornadoRehearsal } from '../../scripts/real-tornado-rehearsal.js';

const enabled =
  Boolean(process.env.L1_RPC_URL) &&
  Boolean(process.env.TORNADO_WASM_PATH) &&
  Boolean(process.env.TORNADO_ZKEY_PATH);

test(
  'Tier 3: a real Tornado proof is accepted by the real verifier and bridges the denomination',
  { skip: enabled ? false : 'set L1_RPC_URL (fork) + TORNADO_WASM_PATH + TORNADO_ZKEY_PATH to run' },
  async () => {
    const { lockedEth } = await runRealTornadoRehearsal();
    assert.equal(lockedEth, 10n ** 18n);
  },
);
