/**
 * Start a mainnet-fork Anvil (chain id 31337, which the local network's L1 deploy hardcodes) and,
 * optionally, `aztec start --local-network` with its L1 pointed at that fork. The aztec wrapper
 * always spawns its own plain anvil; it is parked on a spare port and unused.
 *
 * Child output goes to `.rehearsal/*.log`. `stop()` kills both process groups.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

import { createAztecNodeClient } from '@aztec-labs/aztec.js/node';
import { createPublicClient, http } from 'viem';

export interface ForkNetwork {
  l1RpcUrl: string;
  aztecNodeUrl?: string;
  forkBlock: bigint;
  stop(): void;
}

const LOG_DIR = join(process.cwd(), '.rehearsal');

async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const srv = createServer()
      .once('error', () => reject(new Error(`port ${port} is in use`)))
      .once('listening', () => srv.close(() => resolve()))
      .listen(port, '127.0.0.1');
  });
}

function start(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  mkdirSync(LOG_DIR, { recursive: true });
  const log = createWriteStream(join(LOG_DIR, `${name}.log`));
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  return child;
}

function killGroup(child: ChildProcess): void {
  if (child.pid !== undefined && child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
}

async function waitFor(what: string, child: ChildProcess, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${what} exited with code ${child.exitCode}; see ${LOG_DIR}`);
    }
    if (await check().catch(() => false)) {
      return;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for ${what}; see ${LOG_DIR}`);
}

export async function startForkNetwork(opts: {
  forkUrl: string;
  forkBlock?: bigint;
  withAztec: boolean;
  l1Port?: number;
  spareAnvilPort?: number;
  aztecPort?: number;
}): Promise<ForkNetwork> {
  const l1Port = opts.l1Port ?? 8545;
  const aztecPort = opts.aztecPort ?? 8080;
  const sparePort = opts.spareAnvilPort ?? 8546;
  await assertPortFree(l1Port);
  if (opts.withAztec) {
    await assertPortFree(aztecPort);
    await assertPortFree(sparePort);
  }

  // A few blocks behind the tip, so the fork never starts on a block the upstream may still reorg.
  const latest = await createPublicClient({ transport: http(opts.forkUrl) }).getBlockNumber();
  const forkBlock = opts.forkBlock ?? (latest > 5n ? latest - 5n : latest);
  const children: ChildProcess[] = [];
  const stop = () => children.forEach(killGroup);
  process.once('exit', stop);

  try {
    const anvil = start('anvil-fork', 'aztec-anvil', [
      '--fork-url',
      opts.forkUrl,
      '--fork-block-number',
      forkBlock.toString(),
      '--chain-id',
      '31337',
      '--port',
      String(l1Port),
    ]);
    children.push(anvil);
    const l1RpcUrl = `http://127.0.0.1:${l1Port}`;
    const l1 = createPublicClient({ transport: http(l1RpcUrl) });
    await waitFor('anvil fork', anvil, async () => (await l1.getChainId()) === 31337, 60_000);

    if (!opts.withAztec) {
      return { l1RpcUrl, forkBlock, stop };
    }

    const aztec = start('aztec-local-network', 'aztec', ['start', '--local-network', '--port', String(aztecPort)], {
      ANVIL_PORT: String(sparePort),
      ETHEREUM_HOSTS: l1RpcUrl,
      L1_CHAIN_ID: '31337',
    });
    children.push(aztec);
    const aztecNodeUrl = `http://127.0.0.1:${aztecPort}`;
    const node = createAztecNodeClient(aztecNodeUrl);
    await waitFor('aztec local network', aztec, () => node.isReady(), 600_000);
    return { l1RpcUrl, aztecNodeUrl, forkBlock, stop };
  } catch (err) {
    stop();
    throw err;
  }
}
