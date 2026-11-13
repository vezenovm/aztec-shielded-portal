/**
 * Real-Tornado forwarder path when the proof is front-run: someone replays the pending proof directly
 * against the pool, which pays the still-undeployed forwarder and spends the nullifier. The SDK must
 * recover the deposit (keeping the caller's mint secret) and the recipient must still be able to claim.
 *
 * Run against a local network (`aztec start --local-network`): yarn test:aztec
 */
import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { parseAbi } from 'viem';

import {
  type BridgeStack,
  ForwarderFactoryAbi,
  balanceOfPrivate,
  claimTornadoEth,
  computeAztecMintCommitment,
  generateMintSecret,
  getTotalLockedEth,
  makeMessageConsumable,
  setupBridgeStack,
  waitForL1Success,
  withdrawFromMockRealPool,
} from '../src/index.js';

const poolAbi = parseAbi([
  'function withdraw(bytes _proof, bytes32 _root, bytes32 _nullifierHash, address _recipient, address _relayer, uint256 _fee, uint256 _refund) payable',
]);

describe('forwarder front-run recovery', () => {
  let stack: BridgeStack;
  let alice: AztecAddress;

  before(
    async () => {
      stack = await setupBridgeStack({ useRealTornado: true });
      [alice] = stack.accounts;
    },
    { timeout: 600_000 },
  );

  /** Replay a withdrawal straight into the pool, paying `commitment`'s undeployed forwarder. */
  async function frontRun(commitment: Fr, nullifierHash: `0x${string}`): Promise<void> {
    const forwarder = (await stack.l1Client.readContract({
      address: stack.factory!,
      abi: ForwarderFactoryAbi,
      functionName: 'computeForwarderAddress',
      args: [commitment.toString()],
    })) as `0x${string}`;
    const hash = await stack.l1Client.writeContract({
      address: stack.pool,
      abi: poolAbi,
      functionName: 'withdraw',
      args: ['0x', stack.mockKnownRoot!, nullifierHash, forwarder, '0x0000000000000000000000000000000000000000', 0n, 0n],
      account: stack.l1Client.account!,
      chain: stack.l1Client.chain,
    });
    await waitForL1Success(stack.l1Client, hash);
  }

  it('recovers a front-run withdrawal and the recipient can still claim', { timeout: 300_000 }, async () => {
    const mintSecret = generateMintSecret();
    const commitment = await computeAztecMintCommitment(alice, mintSecret, stack.denomination);
    const nullifierHash = Fr.random().toString() as `0x${string}`;
    const lockedBefore = await getTotalLockedEth(stack.l1Client, stack.bridge);

    await frontRun(commitment, nullifierHash);

    // withdrawAndBridge now reverts (nullifier spent); the SDK falls back to bridgeSpentWithdrawal.
    const deposit = await withdrawFromMockRealPool(stack, alice, { nullifierHash, mintSecret });
    assert.equal(deposit.mintSecret.toString(), mintSecret.toString(), 'mint secret preserved');
    assert.equal(deposit.nullifierHash.toLowerCase(), nullifierHash.toLowerCase());
    assert.equal(await getTotalLockedEth(stack.l1Client, stack.bridge), lockedBefore + stack.denomination);

    const balanceBefore = await balanceOfPrivate(stack.token, alice);
    await makeMessageConsumable(stack, deposit, alice);
    await claimTornadoEth(stack.token, alice, deposit);
    assert.equal(await balanceOfPrivate(stack.token, alice), balanceBefore + stack.denomination);
  });

  it('finds the deposit when someone else already completed the recovery', { timeout: 300_000 }, async () => {
    const mintSecret = generateMintSecret();
    const commitment = await computeAztecMintCommitment(alice, mintSecret, stack.denomination);
    const nullifierHash = Fr.random().toString() as `0x${string}`;

    await frontRun(commitment, nullifierHash);
    const hash = await stack.l1Client.writeContract({
      address: stack.factory!,
      abi: ForwarderFactoryAbi,
      functionName: 'bridgeSpentWithdrawal',
      args: ['0x', stack.mockKnownRoot!, nullifierHash, commitment.toString()],
      account: stack.l1Client.account!,
      chain: stack.l1Client.chain,
    });
    await waitForL1Success(stack.l1Client, hash);
    const locked = await getTotalLockedEth(stack.l1Client, stack.bridge);

    // Both factory paths now revert (nullifier already bridged); the SDK locates the existing deposit.
    const deposit = await withdrawFromMockRealPool(stack, alice, { nullifierHash, mintSecret });
    assert.equal(await getTotalLockedEth(stack.l1Client, stack.bridge), locked, 'no second deposit');

    const balanceBefore = await balanceOfPrivate(stack.token, alice);
    await makeMessageConsumable(stack, deposit, alice);
    await claimTornadoEth(stack.token, alice, deposit);
    assert.equal(await balanceOfPrivate(stack.token, alice), balanceBefore + stack.denomination);
  });
});
