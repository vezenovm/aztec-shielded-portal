/**
 * ABI/bytecode exports for the L1 contracts, sourced from the Foundry build output
 * (`yarn build:l1` must have run). Mirrors how @aztec/l1-artifacts exposes its contracts.
 */
import type { Abi } from 'viem';

import ForwarderJson from '../contracts/l1/out/Forwarder.sol/Forwarder.json' with { type: 'json' };
import ForwarderFactoryJson from '../contracts/l1/out/ForwarderFactory.sol/ForwarderFactory.json' with { type: 'json' };
import MockRealTornadoPoolJson from '../contracts/l1/out/MockRealTornadoPool.sol/MockRealTornadoPool.json' with { type: 'json' };
import MockTornadoPoolJson from '../contracts/l1/out/MockTornadoPool.sol/MockTornadoPool.json' with { type: 'json' };
import TornadoEthBridgeL1Json from '../contracts/l1/out/TornadoEthBridgeL1.sol/TornadoEthBridgeL1.json' with { type: 'json' };

export const MockTornadoPoolAbi = MockTornadoPoolJson.abi as Abi;
export const MockTornadoPoolBytecode = MockTornadoPoolJson.bytecode.object as `0x${string}`;

export const TornadoEthBridgeL1Abi = TornadoEthBridgeL1Json.abi as Abi;
export const TornadoEthBridgeL1Bytecode = TornadoEthBridgeL1Json.bytecode.object as `0x${string}`;

export const ForwarderFactoryAbi = ForwarderFactoryJson.abi as Abi;
export const ForwarderFactoryBytecode = ForwarderFactoryJson.bytecode.object as `0x${string}`;

/** Forwarder creation code, used to derive the CREATE2 init-code hash off-chain. */
export const ForwarderBytecode = ForwarderJson.bytecode.object as `0x${string}`;

/** Behavioral stand-in for a real Tornado pool (plain-ETH push); for local real-path testing. */
export const MockRealTornadoPoolAbi = MockRealTornadoPoolJson.abi as Abi;
export const MockRealTornadoPoolBytecode = MockRealTornadoPoolJson.bytecode.object as `0x${string}`;
