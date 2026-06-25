/**
 * Deploy the L1 side: MockTornadoPool (1 ETH denomination) + TornadoEthBridgeL1,
 * fund the pool with mock liquidity and approve it on the bridge.
 *
 * The bridge is NOT initialized here — that happens in deploy-aztec.ts once the L2
 * tornadoETH address is known (canonical portal ordering).
 *
 * Run: yarn deploy:l1   (requires `aztec start --local-network`)
 */
import {
  ONE_ETH,
  approvePool,
  deployMockTornadoPool,
  deployTornadoBridge,
  fundPool,
  makeL1Client,
} from '../src/index.js';
import { writeConfig } from './config.js';

const POOL_LIQUIDITY = 10n * ONE_ETH;

const client = makeL1Client();

const pool = await deployMockTornadoPool(client, ONE_ETH);
console.log(`MockTornadoPool (1 ETH):  ${pool}`);

await fundPool(client, pool, POOL_LIQUIDITY);
console.log(`  funded with ${POOL_LIQUIDITY / ONE_ETH} ETH of mock liquidity`);

const bridge = await deployTornadoBridge(client);
console.log(`TornadoEthBridgeL1:       ${bridge}`);

await approvePool(client, bridge, pool, ONE_ETH);
console.log('  pool approved at 1 ETH denomination');

writeConfig({ pool, bridge, denomination: ONE_ETH.toString() });
console.log('\nNext: yarn deploy:aztec');
