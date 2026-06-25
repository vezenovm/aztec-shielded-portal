/**
 * TS mirrors of the cross-chain hashes computed on L1 (TornadoEthBridgeL1.sol, via
 * `Hash.sha256ToField(abi.encodeWithSignature(...))`) and on L2
 * (`content_hashes.nr`). Used by tests/scripts to predict deposit ids, message
 * contents and outbox leaves.
 */
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { sha256ToField } from '@aztec/foundation/crypto/sha256';
import type { EthAddress } from '@aztec/foundation/eth-address';
import { computeL2ToL1MessageHash } from '@aztec/stdlib/hash';
import { encodeAbiParameters, parseAbiParameters, toFunctionSelector } from 'viem';

const CLAIM_SIGNATURE = 'claim_from_tornado_bridge(bytes32,uint256)';
const WITHDRAW_SIGNATURE = 'withdraw_from_aztec(address,uint256,bytes32)';

function selectorBuffer(signature: string): Buffer {
  return Buffer.from(toFunctionSelector(signature).substring(2), 'hex');
}

/** Mirrors TornadoEthBridgeL1._registerDeposit's depositId derivation. */
export function computeDepositId(args: {
  chainId: bigint;
  pool: `0x${string}`;
  nullifierHash: `0x${string}`;
  amount: bigint;
  bridge: `0x${string}`;
}): Fr {
  const encoded = encodeAbiParameters(parseAbiParameters('uint256, address, bytes32, uint256, address'), [
    args.chainId,
    args.pool,
    args.nullifierHash,
    args.amount,
    args.bridge,
  ]);
  return sha256ToField([Buffer.from(encoded.slice(2), 'hex')]);
}

/** Content of the L1->L2 mint message (mirrors `get_claim_content_hash`). */
export function getClaimContentHash(depositId: Fr, amount: bigint): Fr {
  return sha256ToField([selectorBuffer(CLAIM_SIGNATURE), depositId.toBuffer(), new Fr(amount).toBuffer()]);
}

/** Content of the L2->L1 burn message (mirrors `get_withdraw_content_hash`). */
export function getWithdrawContentHash(recipientL1: EthAddress, amount: bigint, nonce: Fr): Fr {
  return sha256ToField([
    selectorBuffer(WITHDRAW_SIGNATURE),
    recipientL1.toBuffer32(),
    new Fr(amount).toBuffer(),
    nonce.toBuffer(),
  ]);
}

/**
 * The burn message's outbox leaf — what `withdrawFromAztec` reconstructs and the Outbox
 * proves membership against. Mirrors `Hash.sha256ToField(DataStructures.L2ToL1Msg)`.
 */
export function getBurnMessageLeaf(args: {
  l2Token: AztecAddress;
  portal: EthAddress;
  recipientL1: EthAddress;
  amount: bigint;
  nonce: Fr;
  rollupVersion: bigint;
  chainId: bigint;
}): Fr {
  const content = getWithdrawContentHash(args.recipientL1, args.amount, args.nonce);
  return computeL2ToL1MessageHash({
    l2Sender: args.l2Token,
    l1Recipient: args.portal,
    content,
    rollupVersion: new Fr(args.rollupVersion),
    chainId: new Fr(args.chainId),
  });
}
