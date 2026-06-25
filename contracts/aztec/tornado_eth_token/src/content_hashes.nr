use aztec::protocol::{address::EthAddress, hash::sha256_to_field, traits::ToField};

// Cross-chain message content hashes. Each must match the L1 side of
// TornadoEthBridgeL1.sol byte-for-byte:
//   Hash.sha256ToField(abi.encodeWithSignature(<selector string>, <args...>))
// The selector strings are identifiers of an action, not real function calls
// (same convention as the canonical TokenPortal / token_portal_content_hash_lib).

/// Content hash of an L1->L2 mint message: selector ++ deposit_id ++ amount.
/// L1 reference: TornadoEthBridgeL1._sendMintMessage.
pub fn get_claim_content_hash(deposit_id: Field, amount: u128) -> Field {
    let mut hash_bytes = [0; 68];
    let deposit_id_bytes: [u8; 32] = deposit_id.to_be_bytes();
    let amount_bytes: [u8; 32] = (amount as Field).to_be_bytes();

    let selector = comptime {
        keccak256::keccak256("claim_from_tornado_bridge(bytes32,uint256)".as_bytes(), 42)
    };

    for i in 0..4 {
        hash_bytes[i] = selector[i];
    }

    for i in 0..32 {
        hash_bytes[i + 4] = deposit_id_bytes[i];
        hash_bytes[i + 36] = amount_bytes[i];
    }

    sha256_to_field(hash_bytes)
}

/// Content hash of an L2->L1 burn/withdraw message: selector ++ recipient ++ amount ++ nonce.
/// L1 reference: TornadoEthBridgeL1.withdrawFromAztec.
pub fn get_withdraw_content_hash(recipient: EthAddress, amount: u128, nonce: Field) -> Field {
    let mut hash_bytes: [u8; 100] = [0; 100];
    let recipient_bytes: [u8; 32] = recipient.to_field().to_be_bytes();
    let amount_bytes: [u8; 32] = (amount as Field).to_be_bytes();
    let nonce_bytes: [u8; 32] = nonce.to_be_bytes();

    let selector = comptime {
        keccak256::keccak256("withdraw_from_aztec(address,uint256,bytes32)".as_bytes(), 44)
    };

    for i in 0..4 {
        hash_bytes[i] = selector[i];
    }

    for i in 0..32 {
        hash_bytes[i + 4] = recipient_bytes[i];
        hash_bytes[i + 36] = amount_bytes[i];
        hash_bytes[i + 68] = nonce_bytes[i];
    }

    sha256_to_field(hash_bytes)
}
