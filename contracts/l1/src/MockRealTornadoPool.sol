// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

/**
 * @title MockRealTornadoPool
 * @notice Behavioral stand-in for the REAL Tornado Cash ETH pool, used to exercise the
 * {ForwarderFactory}/{Forwarder} integration offline (Tier 1) with the same control flow the
 * mainnet contract has -- crucially the plain `_recipient.call{value}("")` push with EMPTY calldata.
 * @dev Differs from {MockTornadoPool} (which models a cooperating callback pool): this one models a
 * pool that knows nothing about the bridge. Proof verification is an external call to a
 * {MockTornadoVerifier} (accept-all by default, or an allowlist of exact public inputs), exactly where
 * the real pool calls its Groth16 verifier. Every other guard the real `withdraw`/`_processWithdraw`
 * enforces is reproduced: fee <= denomination, msg.value == 0, refund == 0, unspent nullifier, known
 * root, and the plain-ETH push.
 */
contract MockTornadoVerifier {
  bool public acceptAll = true;
  mapping(bytes32 inputHash => bool valid) public validInputs;

  function setAcceptAll(bool _acceptAll) external {
    acceptAll = _acceptAll;
  }

  /// @notice Mark a public-input tuple as having a valid proof (models "the owner proved this").
  function setValidInputs(uint256[6] calldata _input, bool _valid) external {
    validInputs[keccak256(abi.encode(_input))] = _valid;
  }

  function verifyProof(bytes memory, uint256[6] memory _input) external view returns (bool) {
    return acceptAll || validInputs[keccak256(abi.encode(_input))];
  }
}

contract MockRealTornadoPool {
  uint256 public immutable denomination;
  MockTornadoVerifier public immutable mockVerifier;

  mapping(bytes32 nullifierHash => bool spent) public nullifierHashes;
  mapping(bytes32 root => bool known) public knownRoots;

  event Withdrawal(address to, bytes32 nullifierHash, address indexed relayer, uint256 fee);

  error FeeExceedsDenomination();
  error NoteAlreadySpent();
  error UnknownRoot();
  error InvalidWithdrawProof();
  error NonZeroMsgValue();
  error NonZeroRefund();
  error PaymentToRecipientFailed();
  error PaymentToRelayerFailed();

  constructor(uint256 _denomination) {
    denomination = _denomination;
    mockVerifier = new MockTornadoVerifier();
  }

  /// @notice Same getter as the real pool's `verifier()`.
  function verifier() external view returns (address) {
    return address(mockVerifier);
  }

  /// @notice Fund the pool (stands in for accumulated Tornado deposits).
  receive() external payable {}

  function isKnownRoot(bytes32 _root) public view returns (bool) {
    return knownRoots[_root];
  }

  function setKnownRoot(bytes32 _root, bool _known) external {
    knownRoots[_root] = _known;
  }

  /// @notice Accept (true) or reject (false) every proof. Finer control: `mockVerifier.setValidInputs`.
  function setProofValid(bool _valid) external {
    mockVerifier.setAcceptAll(_valid);
  }

  /**
   * @notice Mirrors `Tornado.withdraw` + `ETHTornado._processWithdraw`, including the external
   * verifier call with the same public-input layout.
   */
  function withdraw(
    bytes calldata _proof,
    bytes32 _root,
    bytes32 _nullifierHash,
    address payable _recipient,
    address payable _relayer,
    uint256 _fee,
    uint256 _refund
  ) external payable {
    require(_fee <= denomination, FeeExceedsDenomination());
    require(msg.value == 0, NonZeroMsgValue());
    require(_refund == 0, NonZeroRefund());
    require(!nullifierHashes[_nullifierHash], NoteAlreadySpent());
    require(isKnownRoot(_root), UnknownRoot());
    require(
      mockVerifier.verifyProof(
        _proof, [uint256(_root), uint256(_nullifierHash), uint256(uint160(address(_recipient))), uint256(uint160(address(_relayer))), _fee, _refund]
      ),
      InvalidWithdrawProof()
    );

    nullifierHashes[_nullifierHash] = true;

    (bool okRecipient,) = _recipient.call{value: denomination - _fee}("");
    require(okRecipient, PaymentToRecipientFailed());
    if (_fee > 0) {
      (bool okRelayer,) = _relayer.call{value: _fee}("");
      require(okRelayer, PaymentToRelayerFailed());
    }

    emit Withdrawal(_recipient, _nullifierHash, _relayer, _fee);
  }
}
