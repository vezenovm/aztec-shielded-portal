// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {ITornadoWithdrawalReceiver} from "./ITornadoWithdrawalReceiver.sol";

/**
 * @title MockTornadoPool
 * @notice Mock of a Tornado Cash-style fixed-denomination pool for local testing.
 * @dev Implements NO zk proofs. It models only the surface the bridge interacts with:
 * a withdrawal that pays out exactly `DENOMINATION` and reports a nullifier hash.
 * Tornado is assumed to already exist; this stands in for it.
 */
contract MockTornadoPool {
  uint256 public immutable DENOMINATION;

  mapping(bytes32 nullifierHash => bool spent) public nullifierHashes;

  event MockTornadoWithdrawal(
    address indexed recipient, bytes32 indexed nullifierHash, uint256 amount, bytes32 aztecMintCommitment
  );

  error NullifierAlreadySpent(bytes32 nullifierHash);
  error InsufficientPoolBalance(uint256 available, uint256 required);

  constructor(uint256 _denomination) {
    DENOMINATION = _denomination;
  }

  /**
   * @notice Fund the mock pool. Stands in for Tornado deposits accumulating liquidity.
   */
  receive() external payable {}

  /**
   * @notice Simplified withdrawal: pays `DENOMINATION` to `_recipient` through its
   * `onTornadoWithdrawal` callback, forwarding the caller-chosen mint commitment.
   * @dev A real pool would verify a zk proof here; the mock only enforces nullifier
   * uniqueness so double-withdrawal tests behave like the real thing.
   */
  function withdrawToBridge(address payable _recipient, bytes32 _nullifierHash, bytes32 _aztecMintCommitment)
    external
  {
    require(!nullifierHashes[_nullifierHash], NullifierAlreadySpent(_nullifierHash));
    require(
      address(this).balance >= DENOMINATION, InsufficientPoolBalance(address(this).balance, DENOMINATION)
    );

    nullifierHashes[_nullifierHash] = true;

    ITornadoWithdrawalReceiver(_recipient).onTornadoWithdrawal{value: DENOMINATION}(
      address(this), _nullifierHash, _aztecMintCommitment
    );

    emit MockTornadoWithdrawal(_recipient, _nullifierHash, DENOMINATION, _aztecMintCommitment);
  }
}
