mod content_hashes;
mod test;

use aztec::macros::aztec;

/// tornadoETH: a private, fungible Aztec asset 1:1 backed by Tornado-origin ETH locked in
/// TornadoEthBridgeL1 on Ethereum. This contract merges token + bridge roles (per the PoC
/// spec): it consumes L1->L2 deposit messages to mint, transfers privately, and burns by
/// emitting L2->L1 withdrawal messages back to the portal.
///
/// Privacy model: note ownership, transfers and balances are private. Mint/burn amounts,
/// total L1 reserves and Tornado provenance are public by design.
///
/// The contract is origin-agnostic apart from naming: a future privacyPoolsETH would be a
/// second instance of the same shape, paired with its own L1 portal.
#[aztec]
pub contract TornadoEthToken {
    use crate::content_hashes::{get_claim_content_hash, get_withdraw_content_hash};

    use aztec::{
        macros::{
            functions::{external, initializer, view},
            storage::storage,
        },
        messages::delivery::MessageDelivery,
        protocol::{
            address::{AztecAddress, EthAddress},
            hash::poseidon2_hash,
            traits::ToField,
        },
        state_vars::{Owned, PublicImmutable},
    };

    use balance_set::BalanceSet;

    #[storage]
    struct Storage<Context> {
        /// The L1 TornadoEthBridgeL1 portal this asset is paired with (write-once).
        portal: PublicImmutable<EthAddress, Context>,
        /// Private tornadoETH balances: per-owner sets of UintNotes.
        balances: Owned<BalanceSet<Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(portal: EthAddress) {
        self.storage.portal.initialize(portal);
    }

    #[external("public")]
    #[view]
    fn get_portal() -> EthAddress {
        self.storage.portal.read()
    }

    /// Claim a Tornado bridge deposit as private tornadoETH notes.
    ///
    /// The L1->L2 message was sent by the portal with
    ///   content    = sha256_to_field(selector ++ deposit_id ++ amount)
    ///   secretHash = aztecMintCommitment
    ///              = compute_secret_hash([poseidon2([recipient, mint_secret, amount])])
    /// We recompute the commitment preimage from the *caller's* address, so consumption
    /// only succeeds for the recipient committed to at deposit time - the L1 side never
    /// learns that address. The message nullifier makes the claim single-use.
    #[external("private")]
    fn claim_from_tornado_bridge(
        deposit_id: Field,
        amount: u128,
        mint_secret: Field,
        message_leaf_index: Field,
    ) {
        let recipient = self.msg_sender();

        let inner_secret = poseidon2_hash([recipient.to_field(), mint_secret, amount as Field]);

        let content_hash = get_claim_content_hash(deposit_id, amount);
        self.context.consume_l1_to_l2_message(
            content_hash,
            [inner_secret],
            self.storage.portal.read(),
            message_leaf_index,
        );

        // Mint. The recipient is the caller, so a plain private note insertion suffices -
        // no partial-note dance and no public phase (L2 supply is implied by L1 reserves).
        self.storage.balances.at(recipient).add(amount).deliver(
            MessageDelivery::onchain_constrained(),
        );
    }

    /// Privately transfer tornadoETH. Input notes are nullified; `sub` re-issues any
    /// change to the sender (asserts "Balance too low" on insufficient funds).
    #[external("private")]
    fn transfer_private(recipient: AztecAddress, amount: u128) {
        let from = self.msg_sender();

        self.storage.balances.at(from).sub(amount).deliver(MessageDelivery::onchain_constrained());
        self.storage.balances.at(recipient).add(amount).deliver(
            MessageDelivery::onchain_constrained(),
        );
    }

    /// Burn tornadoETH and emit an L2->L1 message entitling `recipient_l1` to `amount`
    /// wei of the portal's reserve. The message commits to (portal, recipient, amount,
    /// nonce); the burner's identity stays private. One burn = one L1 redemption - the
    /// portal consumes the outbox leaf exactly once.
    #[external("private")]
    fn burn_for_l1_withdrawal(recipient_l1: EthAddress, amount: u128, nonce: Field) {
        let from = self.msg_sender();

        // Burn: nullify input notes, re-issue only the change. The burnt amount is
        // recreated nowhere on L2.
        self.storage.balances.at(from).sub(amount).deliver(MessageDelivery::onchain_constrained());

        let content = get_withdraw_content_hash(recipient_l1, amount, nonce);
        self.context.message_portal(self.storage.portal.read(), content);
    }

    #[external("utility")]
    unconstrained fn balance_of_private(owner: AztecAddress) -> u128 {
        self.storage.balances.at(owner).balance_of()
    }
}
