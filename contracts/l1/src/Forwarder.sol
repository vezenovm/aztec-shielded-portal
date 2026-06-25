// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {ITornadoWithdrawalReceiver} from "./ITornadoWithdrawalReceiver.sol";

/**
 * @title Forwarder
 * @notice Single-use CREATE2 husk whose address is a binding commitment to a user's Aztec mint
 * commitment (the commitment IS the CREATE2 salt). A real Tornado withdrawal names this address as
 * its proof-bound `recipient`, so the denomination lands here; the factory then has the forwarder
 * hand exactly DENOMINATION to the portal together with the (proof-authenticated) nullifier hash and
 * commitment.
 * @dev Deployed by {ForwarderFactory} as `new Forwarder{salt: commitment}(portal, denomination)`.
 * The portal re-derives this address from the commitment and asserts it equals msg.sender; that is
 * what binds the commitment, since a front-runner cannot change it without changing the proof-bound
 * recipient and thus invalidating the Tornado proof.
 */
contract Forwarder {
  address public immutable PORTAL;
  address public immutable FACTORY;
  uint256 public immutable DENOMINATION;

  error NotFactory(address sender);

  constructor(address _portal, uint256 _denomination) {
    PORTAL = _portal;
    FACTORY = msg.sender;
    DENOMINATION = _denomination;
  }

  /// @notice Accept the plain-ETH push from the Tornado pool (empty calldata).
  receive() external payable {}

  /**
   * @notice Forward exactly DENOMINATION to the portal as an attributable Tornado-origin deposit.
   * @dev Forwards a FIXED amount, not the full balance: this deterministic address is known before
   * deployment, so a griefer could pre-send dust to it. Forwarding exactly DENOMINATION keeps the
   * portal's strict `msg.value == denomination` check satisfied and strands any such dust here at the
   * griefer's expense, never breaking the user's withdrawal.
   */
  function flushToPortal(bytes32 _nullifierHash, bytes32 _aztecMintCommitment) external {
    require(msg.sender == FACTORY, NotFactory(msg.sender));
    ITornadoWithdrawalReceiver(PORTAL).onTornadoWithdrawal{value: DENOMINATION}(
      address(this), _nullifierHash, _aztecMintCommitment
    );
  }
}
