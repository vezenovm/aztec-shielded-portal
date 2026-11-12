// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {ITornadoInstance, ITornadoVerifier} from "./ITornadoInstance.sol";
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
 * Front-running: Tornado authenticates the proof's public signals, not the caller, so anyone can
 * replay a pending `withdrawAndBridge` proof directly against the pool. That pays DENOMINATION to the
 * (still undeployed) forwarder and spends the nullifier, making `withdrawAndBridge` revert.
 * `bridgeSpentWithdrawal` completes such a withdrawal: it re-verifies the same proof against the
 * pool's verifier with the forwarder as recipient, so it can only ever finish the original mint.
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
  error WithdrawalNotSpent(bytes32 nullifierHash);
  error InvalidWithdrawProof();

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

  /**
   * @notice Bridge a Tornado withdrawal that was already executed directly against the pool with
   * this commitment's forwarder as recipient (e.g. a front-runner replayed the proof), leaving
   * DENOMINATION at the forwarder address. Permissionless: the proof can only mint to its commitment.
   * @dev Requires (a) the nullifier is spent on the pool and (b) the pool's verifier accepts the proof
   * for `[root, nullifierHash, forwarder, 0, 0, 0]`. A spent nullifier alone is NOT sufficient:
   * nullifier hashes are public, but a valid proof requires the note's nullifier preimage, i.e. the
   * note owner's authorization of this commitment. The root is not re-checked against the pool's
   * root history, which may have rotated since the withdrawal; the proof already binds the owner.
   * The portal's depositId guard keyed on (forwarder, nullifier) keeps this single-use.
   */
  function bridgeSpentWithdrawal(
    bytes calldata _proof,
    bytes32 _root,
    bytes32 _nullifierHash,
    bytes32 _aztecMintCommitment
  ) external {
    require(_aztecMintCommitment != 0, EmptyCommitment());
    require(TORNADO.nullifierHashes(_nullifierHash), WithdrawalNotSpent(_nullifierHash));

    address forwarderAddress = computeForwarderAddress(_aztecMintCommitment);
    uint256[6] memory input =
      [uint256(_root), uint256(_nullifierHash), uint256(uint160(forwarderAddress)), 0, 0, 0];
    require(ITornadoVerifier(TORNADO.verifier()).verifyProof(_proof, input), InvalidWithdrawProof());

    Forwarder forwarder = _deployForwarder(_aztecMintCommitment);
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
