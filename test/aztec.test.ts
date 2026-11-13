/**
 * Aztec-side integration tests (spec "Aztec tests" 1-9), run against a local network
 * (`aztec start --local-network`). The claim cases need real L1->L2 messages, which the
 * TXE cannot inject at this version — hence sandbox tests rather than Noir unit tests.
 *
 * Run: yarn test:aztec
 */
import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  type BridgeStack,
  type TornadoDeposit,
  balanceOfPrivate,
  burnForL1Withdrawal,
  claimTornadoEth,
  getBurnWitness,
  makeMessageConsumable,
  setupBridgeStack,
  withdrawFromTornadoToBridge,
} from '../src/index.js';

const ETH = 10n ** 18n;

describe('tornadoETH on Aztec', () => {
  let stack: BridgeStack;
  let userA: AztecAddress;
  let userB: AztecAddress;
  let depositA: TornadoDeposit;
  let depositA2: TornadoDeposit;

  before(
    async () => {
      stack = await setupBridgeStack();
      [userA, userB] = stack.accounts;

      // Two deposits committed to userA: one claimed in the happy-path test, one used
      // first for the negative claim cases (then claimed for the transfer/burn tests).
      depositA = await withdrawFromTornadoToBridge(stack, userA);
      depositA2 = await withdrawFromTornadoToBridge(stack, userA);
      await makeMessageConsumable(stack, depositA, userA);
      await makeMessageConsumable(stack, depositA2, userA);
    },
    { timeout: 600_000 },
  );

  // Spec Aztec test 1: claim from a valid L1 message.
  it('claims tornadoETH from a valid L1 deposit message', { timeout: 300_000 }, async () => {
    const receipt = await claimTornadoEth(stack.token, userA, depositA);
    assert.equal(receipt.hasExecutionSucceeded(), true);
    assert.equal(await balanceOfPrivate(stack.token, userA), ETH);
  });

  // Spec Aztec test 2: wrong mint secret fails.
  it('rejects a claim with the wrong mint secret', { timeout: 300_000 }, async () => {
    await assert.rejects(claimTornadoEth(stack.token, userA, depositA2, { mintSecret: Fr.random() }));
  });

  // Spec Aztec test 3: wrong amount fails.
  it('rejects a claim with the wrong amount', { timeout: 300_000 }, async () => {
    await assert.rejects(claimTornadoEth(stack.token, userA, depositA2, { amount: ETH / 2n }));
  });

  // Spec Aztec test 2b (commitment binding): the wrong recipient cannot claim, even
  // knowing the correct secret — the commitment pins the recipient address.
  it('rejects a claim by a non-committed recipient', { timeout: 300_000 }, async () => {
    await assert.rejects(claimTornadoEth(stack.token, userB, depositA2));
  });

  // Failed attempts must not burn the deposit: the rightful claim still works.
  it('still allows the rightful claim after failed attempts', { timeout: 300_000 }, async () => {
    const receipt = await claimTornadoEth(stack.token, userA, depositA2);
    assert.equal(receipt.hasExecutionSucceeded(), true);
    assert.equal(await balanceOfPrivate(stack.token, userA), 2n * ETH);
  });

  // Spec Aztec test 4: the same L1 message cannot be claimed twice.
  it('rejects claiming the same deposit twice', { timeout: 300_000 }, async () => {
    await assert.rejects(claimTornadoEth(stack.token, userA, depositA));
  });

  // Spec Aztec tests 5 + 6: private transfer with change back to the sender.
  it('transfers tornadoETH privately, leaving change with the sender', { timeout: 300_000 }, async () => {
    const sendAmount = (4n * ETH) / 10n;
    const { receipt } = await stack.token.methods
      .transfer_private(userB, sendAmount)
      .send({ from: userA });
    assert.equal(receipt.hasExecutionSucceeded(), true);

    assert.equal(await balanceOfPrivate(stack.token, userB), sendAmount);
    // 2 ETH in notes - 0.4 sent => 1.6 change back to A.
    assert.equal(await balanceOfPrivate(stack.token, userA), 2n * ETH - sendAmount);
  });

  // Spec Aztec test 5b: cannot transfer more than the balance.
  it('rejects transferring more than the private balance', { timeout: 300_000 }, async () => {
    await assert.rejects(
      stack.token.methods.transfer_private(userA, ETH).send({ from: userB }), // B holds 0.4
    );
  });

  // Spec Aztec tests 7 + 8 + 9: burn reduces the balance, emits the exact L2->L1
  // message (proven by finding its leaf in the outbox tree), and burnt notes are gone.
  it('burns tornadoETH and emits the committed L2->L1 message', { timeout: 600_000 }, async () => {
    const recipientL1 = '0x1000000000000000000000000000000000000001' as const;
    const burnAmount = (25n * ETH) / 100n;

    const burn = await burnForL1Withdrawal(stack, userB, recipientL1, burnAmount);
    assert.equal(burn.receipt.hasExecutionSucceeded(), true);

    // Notes are nullified immediately: 0.4 - 0.25 = 0.15 left.
    const remaining = (15n * ETH) / 100n;
    assert.equal(await balanceOfPrivate(stack.token, userB), remaining);

    // Spec test 8: the message leaf we predict from (recipient, amount, nonce) must be
    // found in the settled outbox tree — i.e. the contract emitted exactly the
    // committed content.
    const witness = await getBurnWitness(stack, burn, userA);
    assert.ok(witness.siblingPath, 'witness for the burn message leaf exists');

    // Spec test 9: burned notes cannot be reused.
    await assert.rejects(
      stack.token.methods.transfer_private(userA, remaining + 1n).send({ from: userB }),
    );
  });
});
