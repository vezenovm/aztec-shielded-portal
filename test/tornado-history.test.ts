import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchDeposits, mergeDeposits, type DepositEvent } from '../src/tornado-history.js';

const leaf = (i: number) => `0x${i.toString(16).padStart(64, '0')}` as const;
const ev = (i: number, commitment: `0x${string}` = leaf(i + 1)): DepositEvent => ({ blockNumber: i, commitment, leafIndex: i });

test('mergeDeposits orders by leaf index and collapses cache/log overlap', () => {
  assert.deepEqual(mergeDeposits([ev(1), ev(0)], [ev(1), ev(2)]), [leaf(1), leaf(2), leaf(3)]);
});

test('mergeDeposits rejects gaps and conflicting duplicates', () => {
  assert.throws(() => mergeDeposits([ev(0), ev(2)]), /missing leaf 1/);
  assert.throws(() => mergeDeposits([ev(0)], [ev(0, leaf(99))]), /conflicting commitments for leaf 0/);
});

test('fetchDeposits halves the block range until the provider accepts it', async () => {
  const ranges: Array<[bigint, bigint]> = [];
  const client = {
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      if (toBlock - fromBlock + 1n > 25n) throw new Error('range too large');
      ranges.push([fromBlock, toBlock]);
      return [];
    },
  };
  await fetchDeposits(client as never, `0x${'00'.repeat(20)}`, 0n, 99n, { maxRange: 100n, retries: 0 });
  assert.deepEqual(ranges, [
    [0n, 24n],
    [25n, 49n],
    [50n, 74n],
    [75n, 99n],
  ]);
});
