use aztec::protocol::traits::ToField;

use crate::test::utils;
use crate::TornadoEthToken;

// NOTE: the TXE cannot inject L1->L2 messages at this version, so everything involving a
// real claim (valid/invalid secret, double-claim) and note happy paths is covered by the
// sandbox integration tests in test/aztec.test.ts. Here we cover what runs without
// cross-chain state: initialization and the failure paths of note arithmetic.

#[test]
unconstrained fn test_constructor_sets_portal() {
    let (env, token, _user) = utils::setup();

    let portal = env.view_public(TornadoEthToken::at(token).get_portal());
    assert_eq(portal.to_field(), utils::portal().to_field());
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn test_fail_transfer_without_balance() {
    let (mut env, token, user) = utils::setup();
    let recipient = env.create_light_account();

    env.call_private(
        user,
        TornadoEthToken::at(token).transfer_private(recipient, 100 as u128),
    );
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn test_fail_burn_without_balance() {
    let (mut env, token, user) = utils::setup();

    env.call_private(
        user,
        TornadoEthToken::at(token).burn_for_l1_withdrawal(utils::recipient_l1(), 100 as u128, 7),
    );
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn test_fail_claim_then_overdraw_is_impossible_without_notes() {
    // Even a zero-balance account asking for 1 wei-equivalent must fail.
    let (mut env, token, user) = utils::setup();
    let recipient = env.create_light_account();

    env.call_private(
        user,
        TornadoEthToken::at(token).transfer_private(recipient, 1 as u128),
    );
}
