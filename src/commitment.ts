/**
 * Mint-commitment helpers — the client side of the privacy scheme.
 *
 * The user generates a random `mint_secret` and passes
 *   aztecMintCommitment = compute_secret_hash(poseidon2([recipient, mint_secret, amount]))
 * through the Tornado withdrawal calldata. The L1 bridge forwards it as the L1->L2
 * message's secretHash, so L1 never learns the Aztec recipient. On claim, the contract
 * recomputes the inner hash from the *caller's* address (TornadoEthToken.nr,
 * `claim_from_tornado_bridge`) — the field order/types here must match it exactly.
 */
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { computeSecretHash } from '@aztec/stdlib/hash';

/** Random field element kept by the user until claim time. */
export function generateMintSecret(): Fr {
  return Fr.random();
}

/** Commitment preimage: poseidon2([recipient, mint_secret, amount]). */
export function computeInnerSecret(recipient: AztecAddress, mintSecret: Fr, amount: bigint): Promise<Fr> {
  return poseidon2Hash([recipient.toField(), mintSecret, new Fr(amount)]);
}

/** The bytes32 handed to `MockTornadoPool.withdrawToBridge` / consumed by the claim. */
export async function computeAztecMintCommitment(
  recipient: AztecAddress,
  mintSecret: Fr,
  amount: bigint,
): Promise<Fr> {
  const inner = await computeInnerSecret(recipient, mintSecret, amount);
  return computeSecretHash(inner);
}
