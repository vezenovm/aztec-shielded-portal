/**
 * End-to-end flow (spec "End-to-end test", steps 1-8) against a local network
 * (`aztec start --local-network`):
 *
 *   1-2. user generates mint_secret + aztecMintCommitment
 *   3.   mock Tornado pool withdrawal pays the bridge (1 ETH)
 *   4.   bridge locks ETH and sends the L1->L2 mint message
 *   5.   user A claims private tornadoETH on Aztec
 *   6.   A privately transfers part to user B
 *   7.   B burns some tornadoETH for an L1 withdrawal
 *   8.   the bridge consumes the burn message and releases ETH on L1
 *
 * Run: yarn test:e2e
 */
import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  type BridgeStack,
  type BurnForWithdrawal,
  type BurnWitness,
  type TornadoDeposit,
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

const ETH = 10n ** 18n;
const TRANSFER_AMOUNT = (4n * ETH) / 10n; // 0.4 tornadoETH A -> B
const BURN_AMOUNT = (25n * ETH) / 100n; // 0.25 tornadoETH redeemed by B
/** Fresh L1 EOA with no history — only ever receives the redemption. */
const L1_RECIPIENT = '0x2000000000000000000000000000000000000002' as const;

describe('tornado -> bridge -> tornadoETH -> L1 redemption', () => {
  let stack: BridgeStack;
  let userA: AztecAddress;
  let userB: AztecAddress;
  let deposit: TornadoDeposit;
  let burn: BurnForWithdrawal;
  let witness: BurnWitness;

  before(
    async () => {
      stack = await setupBridgeStack();
      [userA, userB] = stack.accounts;
    },
    { timeout: 600_000 },
  );

  it('steps 1-4: tornado withdrawal locks ETH in the bridge and messages Aztec', { timeout: 300_000 }, async () => {
    const lockedBefore = await getTotalLockedEth(stack.l1Client, stack.bridge);

    // Steps 1-3: mint_secret + commitment are generated client-side inside the helper,
    // and the mock pool pays the bridge through onTornadoWithdrawal.
    deposit = await withdrawFromTornadoToBridge(stack, userA);

    // Step 4: ETH locked, deposit registered, L1->L2 message emitted.
    assert.equal(await getTotalLockedEth(stack.l1Client, stack.bridge), lockedBefore + ETH);
    assert.equal(await stack.l1Client.getBalance({ address: stack.bridge }), ETH);
    assert.notEqual(deposit.depositId, `0x${'00'.repeat(32)}`);
    assert.ok(deposit.messageLeafIndex >= 0n, 'inbox leaf index recorded');
  });

  it('step 5: user A claims private tornadoETH', { timeout: 300_000 }, async () => {
    await makeMessageConsumable(stack, deposit, userA);

    const receipt = await claimTornadoEth(stack.token, userA, deposit);
    assert.equal(receipt.hasExecutionSucceeded(), true);
    assert.equal(await balanceOfPrivate(stack.token, userA), ETH);
  });

  it('step 6: A transfers tornadoETH privately to B', { timeout: 300_000 }, async () => {
    const { receipt } = await stack.token.methods
      .transfer_private(userB, TRANSFER_AMOUNT)
      .send({ from: userA });
    assert.equal(receipt.hasExecutionSucceeded(), true);

    assert.equal(await balanceOfPrivate(stack.token, userA), ETH - TRANSFER_AMOUNT);
    assert.equal(await balanceOfPrivate(stack.token, userB), TRANSFER_AMOUNT);
  });

  it('step 7: B burns tornadoETH for an L1 withdrawal', { timeout: 600_000 }, async () => {
    burn = await burnForL1Withdrawal(stack, userB, L1_RECIPIENT, BURN_AMOUNT);
    assert.equal(burn.receipt.hasExecutionSucceeded(), true);
    assert.equal(await balanceOfPrivate(stack.token, userB), TRANSFER_AMOUNT - BURN_AMOUNT);

    // Wait for the epoch to settle into the Outbox and fetch the membership witness.
    witness = await getBurnWitness(stack, burn, userA);
    assert.ok(witness.siblingPath, 'burn message settled into the outbox');
  });

  it('step 8: the bridge consumes the burn message and releases ETH', { timeout: 300_000 }, async () => {
    const recipientBalanceBefore = await stack.l1Client.getBalance({ address: L1_RECIPIENT });
    const lockedBefore = await getTotalLockedEth(stack.l1Client, stack.bridge);

    await withdrawFromAztecOnL1(stack, burn, witness);

    assert.equal(
      await stack.l1Client.getBalance({ address: L1_RECIPIENT }),
      recipientBalanceBefore + BURN_AMOUNT,
    );
    assert.equal(await getTotalLockedEth(stack.l1Client, stack.bridge), lockedBefore - BURN_AMOUNT);

    // One burn = one redemption: replaying the same witness must revert in the Outbox.
    await assert.rejects(withdrawFromAztecOnL1(stack, burn, witness));
  });
});
