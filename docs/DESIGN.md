# Design notes

## Flow

```text
Tornado withdrawal -> TornadoEthBridgeL1 (lock ETH)  -> Inbox.sendL2Message      L1, public
                   -> claim_from_tornado_bridge      (private mint)              Aztec
                   -> transfer_private                                           Aztec
                   -> burn_for_l1_withdrawal         (private burn, L2->L1 msg)  Aztec
                   -> withdrawFromAztec              (consume outbox, release)   L1
```

**Deposit → mint.** The user picks a random `mint_secret` and passes one `bytes32` through the
Tornado withdrawal:

```text
aztecMintCommitment = compute_secret_hash([poseidon2([aztec_recipient, mint_secret, amount])])
```

It rides in the L1→L2 message's `secretHash` slot; the content commits to `(depositId, amount)`.
`claim_from_tornado_bridge` recomputes the preimage from `msg_sender`, so only the committed
recipient can claim, and the message nullifier makes it single-use. L1 never sees the recipient.

**Burn → redeem.** `burn_for_l1_withdrawal(recipient_l1, amount, nonce)` nullifies the burner's
notes and emits an L2→L1 message over `(bridge, recipient_l1, amount, nonce)`, without the burner's
identity. Once the epoch settles, anyone can call `withdrawFromAztec` with the outbox witness; funds
only go to the committed recipient, and consuming the leaf prevents replay. The bridge has no
`receive()`: pool withdrawals are the only ETH ingress.

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
