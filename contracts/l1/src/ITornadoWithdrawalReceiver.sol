// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

/**
 * @title ITornadoWithdrawalReceiver
 * @notice Callback interface a Tornado-style pool uses to hand withdrawn ETH to a bridge
 * together with the withdrawal's nullifier hash and the user's Aztec mint commitment.
 * @dev The PoC prefers this callback path over a bare `receive()` because plain ETH receipt
 * cannot be attributed to a specific pool withdrawal (see spec "Important interface note").
 */
interface ITornadoWithdrawalReceiver {
  /**
   * @param _pool - The pool performing the withdrawal (must equal msg.sender)
   * @param _nullifierHash - The Tornado nullifier hash spent by this withdrawal
   * @param _aztecMintCommitment - User-chosen commitment binding the (hidden) Aztec
   * recipient, mint secret and amount; forwarded into the L1->L2 message
   */
  function onTornadoWithdrawal(address _pool, bytes32 _nullifierHash, bytes32 _aztecMintCommitment)
    external
    payable;
}
