/**
 * Real-Tornado fork rehearsal (env-gated): runs the real-proof rehearsal and asserts the bridge
 * locked the denomination. Skips unless a mainnet fork + a tornado-cli checkout are configured, so
 * the default `yarn test:*` stays offline. See scripts/real-tornado-rehearsal.ts for prerequisites.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runRealTornadoRehearsal } from '../../scripts/real-tornado-rehearsal.js';

const enabled = Boolean(process.env.TORNADO_CLI_DIR) && Boolean(process.env.L1_RPC_URL);

test(
  'a real Tornado proof is accepted by the real verifier and bridges the denomination',
  { skip: enabled ? false : 'set TORNADO_CLI_DIR + L1_RPC_URL (mainnet fork) to run' },
  async () => {
    const { lockedEth } = await runRealTornadoRehearsal();
    assert.equal(lockedEth, 10n ** 18n);
  },
);
