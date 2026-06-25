/**
 * Deploy the Aztec side: the TornadoEthToken (tornadoETH) contract paired with the
 * already-deployed L1 bridge, then initialize the bridge with the L2 address.
 *
 * Run: yarn deploy:aztec   (after yarn deploy:l1)
 */
import { connectToAztec, deployTornadoEthToken, initializeBridge, makeL1Client } from '../src/index.js';
import { readConfig, writeConfig } from './config.js';

const { bridge } = readConfig();
if (!bridge) {
  throw new Error('No bridge in config.local.json — run `yarn deploy:l1` first.');
}

const client = makeL1Client();
const conn = await connectToAztec();
const deployer = conn.accounts[0];

const token = await deployTornadoEthToken(conn, deployer, bridge);
console.log(`TornadoEthToken (tornadoETH): ${token.address.toString()}`);

const { registryAddress } = await conn.node.getL1ContractAddresses();
await initializeBridge(client, bridge, registryAddress, token.address);
console.log(`  bridge ${bridge} initialized against registry ${registryAddress.toString()}`);

writeConfig({ l2Token: token.address.toString() });
console.log('\nNext: yarn demo');
