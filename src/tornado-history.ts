/**
 * Rebuild a Tornado pool's ordered commitment list (the Merkle leaves a withdrawal proof is built
 * over) from the pinned tornado-cli deposit cache plus `Deposit` logs for the blocks after it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAbi, parseAbiItem, type PublicClient } from 'viem';

const MAX_LEAVES = 2 ** 20;

/** tornado-cli's cached 1 ETH pool deposits (fetched by `yarn prover:install`). */
export const ETH_1_DEPOSIT_CACHE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../prover/assets/cache/ethereum/deposits_eth_1.json',
);

const depositEvent = parseAbiItem('event Deposit(bytes32 indexed commitment, uint32 leafIndex, uint256 timestamp)');
const poolAbi = parseAbi([
  'function nextIndex() view returns (uint32)',
  'function getLastRoot() view returns (bytes32)',
]);

export interface DepositEvent {
  blockNumber: number;
  commitment: `0x${string}`;
  leafIndex: number;
}

export interface PoolHistory {
  /** Commitments in leaf order. */
  leaves: `0x${string}`[];
  /** Block the snapshot (count + root) was taken at. */
  blockNumber: bigint;
  /** `getLastRoot()` at `blockNumber`; the root the proof must be built against. */
  root: `0x${string}`;
}

type LogsClient = Pick<PublicClient, 'getLogs'>;

export function loadDepositCache(path = ETH_1_DEPOSIT_CACHE): DepositEvent[] {
  if (!existsSync(path)) {
    throw new Error(`Deposit cache missing at ${path}. Run \`yarn prover:install\`.`);
  }
  return (JSON.parse(readFileSync(path, 'utf8')) as DepositEvent[]).map(e => ({
    blockNumber: Number(e.blockNumber),
    commitment: e.commitment.toLowerCase() as `0x${string}`,
    leafIndex: Number(e.leafIndex),
  }));
}

/**
 * Deposit logs in [fromBlock, toBlock]. A failed request is retried (free RPC tiers rate-limit),
 * then the range is halved (they also cap the block span); it grows back after each success.
 */
export async function fetchDeposits(
  client: LogsClient,
  pool: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  opts: { maxRange?: bigint; retries?: number; onProgress?: (block: bigint) => void } = {},
): Promise<DepositEvent[]> {
  const out: DepositEvent[] = [];
  const retries = opts.retries ?? 3;
  const maxRange = opts.maxRange ?? 5_000n;
  let range = maxRange;
  let from = fromBlock;
  let failures = 0;
  while (from <= toBlock) {
    const to = from + range - 1n < toBlock ? from + range - 1n : toBlock;
    let logs;
    try {
      logs = await client.getLogs({ address: pool, event: depositEvent, fromBlock: from, toBlock: to });
      failures = 0;
    } catch (err) {
      if (++failures <= retries) {
        await new Promise(r => setTimeout(r, 500 * 2 ** failures));
        continue;
      }
      if (range === 1n) {
        throw err;
      }
      range = range / 2n;
      failures = 0;
      continue;
    }
    for (const log of logs) {
      out.push({
        blockNumber: Number(log.blockNumber),
        commitment: log.args.commitment!.toLowerCase() as `0x${string}`,
        leafIndex: Number(log.args.leafIndex),
      });
    }
    opts.onProgress?.(to);
    from = to + 1n;
    range = range * 2n < maxRange ? range * 2n : maxRange;
  }
  return out;
}

/**
 * Merge deposit events into leaf order. Identical duplicates (cache/log overlap) collapse; a leaf
 * index seen with two different commitments, or any gap from index 0, is an error.
 */
export function mergeDeposits(...sources: DepositEvent[][]): `0x${string}`[] {
  const byIndex = new Map<number, `0x${string}`>();
  for (const e of sources.flat()) {
    if (!/^0x[0-9a-f]{64}$/.test(e.commitment)) {
      throw new Error(`malformed commitment at leaf ${e.leafIndex}: ${e.commitment}`);
    }
    const seen = byIndex.get(e.leafIndex);
    if (seen !== undefined && seen !== e.commitment) {
      throw new Error(`conflicting commitments for leaf ${e.leafIndex}`);
    }
    byIndex.set(e.leafIndex, e.commitment);
  }
  if (byIndex.size > MAX_LEAVES) {
    throw new Error(`${byIndex.size} leaves exceed a depth-20 tree`);
  }
  const leaves: `0x${string}`[] = [];
  for (let i = 0; i < byIndex.size; i++) {
    const leaf = byIndex.get(i);
    if (leaf === undefined) {
      throw new Error(`missing leaf ${i} (have ${byIndex.size} leaves)`);
    }
    leaves.push(leaf);
  }
  return leaves;
}

/**
 * Snapshot a pool's leaves and root at `blockNumber`. `cache` seeds the history (tornado-cli's
 * events for the canonical pool); logs are fetched from the cache's last block (inclusive, so a
 * partially cached block is re-read) or `fromBlock` for a pool with no cache.
 *
 * On a fork, pass `upstream` + `forkBlock`: blocks up to the fork point are read from the upstream
 * RPC directly (Anvil's forwarding of historical `getLogs` does not respect the provider's range
 * caps), and only later blocks from `client`.
 */
export async function rebuildPoolHistory(opts: {
  client: LogsClient & Pick<PublicClient, 'readContract'>;
  pool: `0x${string}`;
  blockNumber: bigint;
  cache?: DepositEvent[];
  fromBlock?: bigint;
  upstream?: LogsClient;
  forkBlock?: bigint;
  maxRange?: bigint;
  onProgress?: (block: bigint) => void;
}): Promise<PoolHistory> {
  const cache = (opts.cache ?? []).filter(e => BigInt(e.blockNumber) <= opts.blockNumber);
  const start = cache.length ? BigInt(cache[cache.length - 1].blockNumber) : (opts.fromBlock ?? 0n);
  const fetchOpts = { maxRange: opts.maxRange, onProgress: opts.onProgress };
  let tail: DepositEvent[];
  if (opts.upstream && opts.forkBlock !== undefined && start <= opts.forkBlock) {
    const split = opts.forkBlock < opts.blockNumber ? opts.forkBlock : opts.blockNumber;
    tail = await fetchDeposits(opts.upstream, opts.pool, start, split, fetchOpts);
    if (split < opts.blockNumber) {
      tail.push(...(await fetchDeposits(opts.client, opts.pool, split + 1n, opts.blockNumber, fetchOpts)));
    }
  } else {
    tail = await fetchDeposits(opts.client, opts.pool, start, opts.blockNumber, fetchOpts);
  }
  const leaves = mergeDeposits(cache, tail);

  const at = { address: opts.pool, abi: poolAbi, blockNumber: opts.blockNumber } as const;
  const [nextIndex, root] = await Promise.all([
    opts.client.readContract({ ...at, functionName: 'nextIndex' }),
    opts.client.readContract({ ...at, functionName: 'getLastRoot' }),
  ]);
  if (leaves.length !== Number(nextIndex)) {
    throw new Error(`rebuilt ${leaves.length} leaves but pool nextIndex is ${nextIndex} at block ${opts.blockNumber}`);
  }
  return { leaves, blockNumber: opts.blockNumber, root };
}
