/**
 * Canonical runnable SDK example for the full tornadoETH flow. Deploys a fresh stack
 * each run (self-contained), then walks the spec's 8 steps with balance printouts.
 *
 * Run: yarn demo   (requires `aztec start --local-network`)
 */
import {
  ONE_ETH,
  balanceOfPrivate,
  burnForL1Withdrawal,
  claimTornadoEth,
  getBurnWitness,
  getTotalLockedEth,
  makeMessageConsumable,
  setupBridgeStack,
  withdrawFromAztecOnL1,
  withdrawFromTornadoToBridge,
} from '../src/index.js';

const fmt = (wei: bigint) => `${Number(wei) / 1e18} ETH`;
const L1_RECIPIENT = '0x3000000000000000000000000000000000000003' as const;
const TRANSFER_AMOUNT = (4n * ONE_ETH) / 10n;
const BURN_AMOUNT = (25n * ONE_ETH) / 100n;

console.log('Deploying fresh stack (pool, bridge, tornadoETH)...');
const stack = await setupBridgeStack();
const [alice, bob] = stack.accounts;
console.log(`  MockTornadoPool:    ${stack.pool}`);
console.log(`  TornadoEthBridgeL1: ${stack.bridge}`);
console.log(`  TornadoEthToken:    ${stack.token.address.toString()}`);
console.log(`  alice (Aztec):      ${alice.toString()}`);
console.log(`  bob   (Aztec):      ${bob.toString()}\n`);

console.log('[1-2] alice generates mint_secret and aztecMintCommitment (client-side)');
console.log('[3]   tornado pool withdrawal pays the bridge 1 ETH, forwarding the commitment');
const deposit = await withdrawFromTornadoToBridge(stack, alice);
console.log(`      depositId:    ${deposit.depositId}`);
console.log(`      commitment:   ${deposit.commitment.toString()}`);

console.log('[4]   bridge locked the ETH and sent the L1->L2 mint message');
console.log(`      totalLockedEth: ${fmt(await getTotalLockedEth(stack.l1Client, stack.bridge))}`);
console.log(`      message hash:   ${deposit.messageHash.toString()} (leaf ${deposit.messageLeafIndex})`);

console.log('[5]   alice claims private tornadoETH (L1 never saw her address)...');
await makeMessageConsumable(stack, deposit, alice);
await claimTornadoEth(stack.token, alice, deposit);
console.log(`      alice balance: ${fmt(await balanceOfPrivate(stack.token, alice))} tornadoETH`);

console.log(`[6]   alice privately transfers ${fmt(TRANSFER_AMOUNT)} to bob...`);
await stack.token.methods.transfer_private(bob, TRANSFER_AMOUNT).send({ from: alice });
console.log(`      alice balance: ${fmt(await balanceOfPrivate(stack.token, alice))} tornadoETH`);
console.log(`      bob balance:   ${fmt(await balanceOfPrivate(stack.token, bob))} tornadoETH`);

console.log(`[7]   bob burns ${fmt(BURN_AMOUNT)} for an L1 withdrawal to ${L1_RECIPIENT}...`);
const burn = await burnForL1Withdrawal(stack, bob, L1_RECIPIENT, BURN_AMOUNT);
console.log(`      burn nonce:    ${burn.nonce.toString()}`);
console.log(`      bob balance:   ${fmt(await balanceOfPrivate(stack.token, bob))} tornadoETH`);
console.log('      waiting for the epoch to settle the burn message into the L1 Outbox...');
const witness = await getBurnWitness(stack, burn, alice);

console.log('[8]   bridge consumes the burn message and releases the ETH...');
await withdrawFromAztecOnL1(stack, burn, witness);
console.log(`      ${L1_RECIPIENT} balance: ${fmt(await stack.l1Client.getBalance({ address: L1_RECIPIENT }))}`);
console.log(`      totalLockedEth: ${fmt(await getTotalLockedEth(stack.l1Client, stack.bridge))}`);

console.log('\nDone: 1 ETH of Tornado-origin reserve, 0.75 tornadoETH still circulating privately.');
