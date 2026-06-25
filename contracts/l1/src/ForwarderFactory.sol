// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {ITornadoInstance} from "./ITornadoInstance.sol";
import {Forwarder} from "./Forwarder.sol";

/**
 * @title ForwarderFactory
 * @notice Permissionless, ownerless entrypoint that turns a real Tornado withdrawal into a
 * tornadoETH mint. It deploys a per-commitment {Forwarder} at a deterministic CREATE2 address,
 * drives the Tornado withdrawal to that address, then has the forwarder hand the ETH to the portal.
 * @dev Binding model (Option B): the Aztec mint commitment is the CREATE2 salt, so the forwarder
 * address -- which the user names as the proof-bound Tornado `recipient` -- IS the commitment. The
 * portal re-derives the address from the commitment and checks msg.sender, so the commitment cannot
 * be swapped without invalidating the Tornado proof. `withdrawAndBridge` is therefore permissionless:
 * a proof copied from the mempool can only ever mint to the original commitment. `fee`/`refund` are
 * hard-zeroed -- relayers are out of scope for the PoC, and a non-zero fee would make the pool pay
 * out less than DENOMINATION and break the portal's strict value check.
 *
 * PoC: not production-ready. See README for the threat-model simplifications.
 */
contract ForwarderFactory {
  address public immutable PORTAL;
  ITornadoInstance public immutable TORNADO;
  uint256 public immutable DENOMINATION;
  bytes32 public immutable FORWARDER_INIT_CODE_HASH;

  event ForwarderWithdrawal(
    address indexed forwarder,
    bytes32 indexed nullifierHash,
    bytes32 indexed aztecMintCommitment,
    uint256 amount
  );

  error EmptyCommitment();
  error ForwarderAddressMismatch(address deployed, address expected);

  constructor(address _portal, ITornadoInstance _tornado) {
    PORTAL = _portal;
    TORNADO = _tornado;
    uint256 denomination = _tornado.denomination();
    DENOMINATION = denomination;
    FORWARDER_INIT_CODE_HASH =
      keccak256(abi.encodePacked(type(Forwarder).creationCode, abi.encode(_portal, denomination)));
  }

  /**
   * @notice Withdraw DENOMINATION from the real Tornado pool and lock it in the portal, minting
   * tornadoETH to the hidden Aztec recipient committed to by `_aztecMintCommitment`.
   * @param _proof Groth16 withdrawal proof. Its public `recipient` signal MUST equal
   * `computeForwarderAddress(_aztecMintCommitment)`, and `relayer`/`fee`/`refund` MUST be 0.
   * @param _root A known Tornado merkle root.
   * @param _nullifierHash The withdrawal's nullifier hash (proof-bound; spent on the real pool).
   * @param _aztecMintCommitment The Aztec mint commitment (the CREATE2 salt of the forwarder).
   */
  function withdrawAndBridge(
    bytes calldata _proof,
    bytes32 _root,
    bytes32 _nullifierHash,
    bytes32 _aztecMintCommitment
  ) external {
    require(_aztecMintCommitment != 0, EmptyCommitment());

    Forwarder forwarder = _deployForwarder(_aztecMintCommitment);

    // Pull ETH from the real pool to the forwarder (plain .call push, empty calldata).
    TORNADO.withdraw(
      _proof, _root, _nullifierHash, payable(address(forwarder)), payable(address(0)), 0, 0
    );

    // Hand exactly DENOMINATION to the portal as an attributable Tornado-origin deposit.
    forwarder.flushToPortal(_nullifierHash, _aztecMintCommitment);

    emit ForwarderWithdrawal(address(forwarder), _nullifierHash, _aztecMintCommitment, DENOMINATION);
  }

  /// @notice Deterministic forwarder address for a commitment (mirror of the portal's check).
  function computeForwarderAddress(bytes32 _aztecMintCommitment) public view returns (address) {
    return address(
      uint160(
        uint256(
          keccak256(
            abi.encodePacked(
              bytes1(0xff), address(this), _aztecMintCommitment, FORWARDER_INIT_CODE_HASH
            )
          )
        )
      )
    );
  }

  function _deployForwarder(bytes32 _commitment) internal returns (Forwarder) {
    address predicted = computeForwarderAddress(_commitment);
    if (predicted.code.length != 0) {
      // A forwarder for this commitment already exists (commitment reuse). Reuse it rather than
      // reverting on the duplicate CREATE2; the portal's depositId guard still enforces one-claim
      // semantics per (forwarder, nullifier).
      return Forwarder(payable(predicted));
    }
    Forwarder forwarder = new Forwarder{salt: _commitment}(PORTAL, DENOMINATION);
    require(address(forwarder) == predicted, ForwarderAddressMismatch(address(forwarder), predicted));
    return forwarder;
  }
}
