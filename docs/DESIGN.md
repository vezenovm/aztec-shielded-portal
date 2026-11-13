# Design notes

Background for `README.md`: where the implementation departs from the original PoC spec, and how to
add a second origin bridge.

## Deviations from the spec

Protocol reality required a few interface adjustments; the substance is unchanged:

1. `claim_from_tornado_bridge` gains a `message_leaf_index: Field` parameter — consuming
   an L1→L2 message requires its inbox leaf index (returned by `sendL2Message`, surfaced
   in the `TornadoBridgeDeposit` event).
2. `withdrawFromAztec` takes the real outbox witness `(nonce, epoch,
   numCheckpointsInEpoch, leafIndex, path)` instead of a bare `burnMessageHash`; the
   message (and its hash, emitted in `AztecRedemption`) is reconstructed in-contract.
3. `depositId` uses `Hash.sha256ToField` rather than raw `keccak256` so the id fits in a
   Noir field and can be recomputed identically inside the claim circuit.
4. `aztecMintCommitment = compute_secret_hash([poseidon2([recipient, mint_secret,
   amount])])` rides in the message's `secretHash` slot (the protocol's native private-
   consumption mechanism); the content carries `(depositId, amount)`. The message leaf
   commits to all of it.
5. The spec's L1 unit tests live in Foundry (`contracts/l1/test`), not `l1.test.ts`.
   Aztec claim-path cases live in `test/aztec.test.ts` against the local network — the
   TXE cannot inject L1→L2 messages at the pinned version.
6. `TornadoBridgeDeposit` additionally emits `(messageKey, messageLeafIndex)` so clients
   don't need to recompute them.

## Adding another bridge

Examples: `privacyPoolsETH`, `railgunETH`.

Per-origin assets stay isolated so provenance is obvious. The recipe:

1. **L1**: new portal contract with its own ingress (e.g. verify a Privacy Pools
   withdrawal instead of `onTornadoWithdrawal`). The generic seams to lift from
   `TornadoEthBridgeL1` are `_registerDeposit`, `_sendMintMessage`, and
   `withdrawFromAztec` — they contain nothing Tornado-specific.
2. **L2**: deploy a second instance of the same token contract shape paired with the new
   portal (`TornadoEthToken` is origin-agnostic apart from naming) — that instance *is*
   `privacyPoolsETH`.
3. Extract a shared abstract base / generic token only when the second bridge actually
   exists; the PoC deliberately ships concrete contracts.

Do **not** merge origins into one asset; a future unified `shieldedETH` would be a
separate design with hidden origin metadata.
