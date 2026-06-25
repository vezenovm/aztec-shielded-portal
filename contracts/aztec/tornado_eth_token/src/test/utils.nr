use aztec::{
    protocol::address::{AztecAddress, EthAddress},
    test::helpers::test_environment::TestEnvironment,
};

use crate::TornadoEthToken;

/// Stand-in L1 portal address used across the TXE suite.
pub unconstrained fn portal() -> EthAddress {
    EthAddress::from_field(0x1111111111111111111111111111111111111111)
}

/// Stand-in L1 withdrawal recipient.
pub unconstrained fn recipient_l1() -> EthAddress {
    EthAddress::from_field(0x2222222222222222222222222222222222222222)
}

/// Deploy a TornadoEthToken paired with the stand-in portal, plus a fresh user account.
pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let user = env.create_light_account();

    let initializer_call = TornadoEthToken::interface().constructor(portal());
    let token = env.deploy("TornadoEthToken").with_public_initializer(user, initializer_call);

    (env, token, user)
}
