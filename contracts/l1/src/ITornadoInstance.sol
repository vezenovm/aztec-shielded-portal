// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

/**
 * @title ITornadoInstance
 * @notice Minimal ABI slice of a real Tornado Cash fixed-denomination pool (e.g. the canonical
 * 1 ETH instance at 0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936).
 * @dev Only the surface the ForwarderFactory and fork tests touch. The real pool pays the
 * recipient via a plain `_recipient.call{value: denomination - fee}("")` with EMPTY calldata, so a
 * contract recipient learns nothing about the withdrawal. That is exactly why the factory binds the
 * Aztec commitment into the proof-bound `_recipient` (via a per-commitment CREATE2 forwarder)
 * instead of relying on a callback the real pool does not make.
 */
/// @notice Tornado Classic's Groth16 verifier (`IVerifier` in tornado-core).
interface ITornadoVerifier {
  /// @param _input `[root, nullifierHash, recipient, relayer, fee, refund]`, as `Tornado.withdraw` passes it.
  function verifyProof(bytes memory _proof, uint256[6] memory _input) external returns (bool);
}

interface ITornadoInstance {
  function denomination() external view returns (uint256);

  function verifier() external view returns (address);

  function nullifierHashes(bytes32 _nullifierHash) external view returns (bool);

  function isKnownRoot(bytes32 _root) external view returns (bool);

  function getLastRoot() external view returns (bytes32);

  function withdraw(
    bytes calldata _proof,
    bytes32 _root,
    bytes32 _nullifierHash,
    address payable _recipient,
    address payable _relayer,
    uint256 _fee,
    uint256 _refund
  ) external payable;
}
