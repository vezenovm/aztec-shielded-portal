// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

/**
 * @title MockRealTornadoPool
 * @notice Behavioral stand-in for the REAL Tornado Cash ETH pool, used to exercise the
 * {ForwarderFactory}/{Forwarder} integration offline (Tier 1) with the same control flow the
 * mainnet contract has -- crucially the plain `_recipient.call{value}("")` push with EMPTY calldata.
 * @dev Differs from {MockTornadoPool} (which models a cooperating callback pool): this one models a
 * pool that knows nothing about the bridge. It skips real zk verification (toggle via `setProofValid`)
 * but reproduces every other guard the real `withdraw`/`_processWithdraw` enforces: fee <= denomination,
 * msg.value == 0, refund == 0, unspent nullifier, known root, and the plain-ETH push.
 */
contract MockRealTornadoPool {
  uint256 public immutable denomination;
  address public verifier;

  mapping(bytes32 nullifierHash => bool spent) public nullifierHashes;
  mapping(bytes32 root => bool known) public knownRoots;
  bool public proofValid = true;

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
    verifier = address(uint160(uint256(keccak256("MockRealTornadoPool.verifier"))));
  }

  /// @notice Fund the pool (stands in for accumulated Tornado deposits).
  receive() external payable {}

  function isKnownRoot(bytes32 _root) public view returns (bool) {
    return knownRoots[_root];
  }

  function setKnownRoot(bytes32 _root, bool _known) external {
    knownRoots[_root] = _known;
  }

  function setProofValid(bool _valid) external {
    proofValid = _valid;
  }

  /**
   * @notice Mirrors `Tornado.withdraw` + `ETHTornado._processWithdraw`. The `_proof` bytes are
   * ignored (validity is faked via `proofValid`); everything else matches mainnet behavior.
   */
  function withdraw(
    bytes calldata, /* _proof */
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
    require(proofValid, InvalidWithdrawProof()); // stands in for verifier.verifyProof(...)

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
