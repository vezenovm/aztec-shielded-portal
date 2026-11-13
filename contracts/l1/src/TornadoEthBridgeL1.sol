// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

import {IRegistryLookup, IRollupLookup} from "./IAztecMinimal.sol";
import {ITornadoWithdrawalReceiver} from "./ITornadoWithdrawalReceiver.sol";

/**
 * @notice The portal reads the forwarder init-code hash and denomination from an approved
 * {ForwarderFactory} so the two contracts stay a single source of truth.
 */
interface IForwarderFactory {
  function PORTAL() external view returns (address);
  function FORWARDER_INIT_CODE_HASH() external view returns (bytes32);
  function DENOMINATION() external view returns (uint256);
}

/// @notice The one getter the portal reads from a caller claiming to be a {Forwarder}.
interface IForwarderLike {
  function FACTORY() external view returns (address);
}

/**
 * @title TornadoEthBridgeL1
 * @notice L1 portal locking Tornado-origin ETH as the reserve backing private `tornadoETH`
 * notes on Aztec.
 *
 * Ingress: accepts ETH exclusively through `onTornadoWithdrawal`, called by an approved
 * Tornado-style pool during a withdrawal. There is deliberately no `receive`/`fallback`,
 * so every wei of reserve is attributable to a specific pool withdrawal (public
 * Tornado-origin provenance).
 *
 * Egress: releases ETH only by consuming an L2->L1 burn message emitted by the
 * `tornadoETH` Aztec contract.
 *
 * The generic seams (`_registerDeposit`, `_sendMintMessage`, `withdrawFromAztec`) are kept
 * distinct from the Tornado-specific ingress so that a future bridge for another shielded
 * pool (e.g. privacyPoolsETH) can lift them into a shared base.
 *
 * PoC: not production-ready. See README for the threat-model simplifications.
 */
contract TornadoEthBridgeL1 is ITornadoWithdrawalReceiver {
  /* -------------------------------------------------------------------------- */
  /*                                    State                                   */
  /* -------------------------------------------------------------------------- */

  address public immutable OWNER;

  IRegistryLookup public registry;
  IRollupLookup public rollup;
  IInbox public inbox;
  IOutbox public outbox;
  uint256 public rollupVersion;
  /// @notice Aztec address of the tornadoETH contract (the only valid L2 counterparty).
  bytes32 public l2TornadoEthToken;

  mapping(address pool => bool approved) public approvedPools;
  mapping(address pool => uint256 denomination) public poolDenomination;
  mapping(bytes32 depositId => bool consumed) public consumedDepositIds;
  uint256 public totalLockedEth;

  /// @notice A {ForwarderFactory} approved as real-Tornado ingress, one per pool (0.1/1/10/100 ETH).
  struct ForwarderFactoryConfig {
    /// @dev CREATE2 init-code hash of the factory's Forwarder, for re-deriving forwarder addresses.
    bytes32 initCodeHash;
    /// @dev The factory's pool denomination; zero means not approved.
    uint256 denomination;
  }

  mapping(address factory => ForwarderFactoryConfig config) public forwarderFactories;

  uint256 private _reentrancyLock = 1;

  /* -------------------------------------------------------------------------- */
  /*                                   Events                                   */
  /* -------------------------------------------------------------------------- */

  event BridgeInitialized(
    address rollup, address inbox, address outbox, uint256 rollupVersion, bytes32 l2TornadoEthToken
  );

  event PoolApproved(address indexed pool, uint256 denomination);

  event ForwarderFactoryApproved(address indexed factory, bytes32 forwarderInitCodeHash, uint256 denomination);

  event TornadoBridgeDeposit(
    address indexed pool,
    bytes32 indexed nullifierHash,
    bytes32 indexed depositId,
    uint256 amount,
    bytes32 aztecMintCommitment,
    bytes32 messageKey,
    uint256 messageLeafIndex
  );

  event AztecRedemption(address indexed recipient, uint256 amount, bytes32 indexed burnMessageHash);

  /* -------------------------------------------------------------------------- */
  /*                                   Errors                                   */
  /* -------------------------------------------------------------------------- */

  error NotOwner();
  error AlreadyInitialized();
  error NotInitialized();
  error InvalidPool();
  error InvalidFactory();
  error InvalidDenomination();
  error InvalidL2Token();
  error SenderNotPool(address sender, address pool);
  error PoolNotApproved(address pool);
  error WrongDenomination(uint256 received, uint256 expected);
  error EmptyMintCommitment();
  error DepositAlreadyRegistered(bytes32 depositId);
  error InsufficientLockedEth(uint256 requested, uint256 locked);
  error EthTransferFailed(address recipient, uint256 amount);
  error ReentrantCall();

  /* -------------------------------------------------------------------------- */
  /*                                  Modifiers                                 */
  /* -------------------------------------------------------------------------- */

  modifier onlyOwner() {
    require(msg.sender == OWNER, NotOwner());
    _;
  }

  modifier onlyInitialized() {
    require(address(inbox) != address(0), NotInitialized());
    _;
  }

  modifier nonReentrant() {
    require(_reentrancyLock == 1, ReentrantCall());
    _reentrancyLock = 2;
    _;
    _reentrancyLock = 1;
  }

  constructor() {
    OWNER = msg.sender;
  }

  /* -------------------------------------------------------------------------- */
  /*                                Administration                              */
  /* -------------------------------------------------------------------------- */

  /**
   * @notice Wire the bridge to the Aztec rollup and the L2 tornadoETH contract.
   * @dev Mirrors the canonical TokenPortal: inbox/outbox/version are derived from the
   * registry's canonical rollup. Callable once, after the L2 contract is deployed.
   */
  function initialize(address _registry, bytes32 _l2TornadoEthToken) external onlyOwner {
    require(address(rollup) == address(0), AlreadyInitialized());
    require(_l2TornadoEthToken != 0, InvalidL2Token());

    registry = IRegistryLookup(_registry);
    rollup = registry.getCanonicalRollup();
    inbox = rollup.getInbox();
    outbox = rollup.getOutbox();
    rollupVersion = rollup.getVersion();
    l2TornadoEthToken = _l2TornadoEthToken;

    emit BridgeInitialized(
      address(rollup), address(inbox), address(outbox), rollupVersion, _l2TornadoEthToken
    );
  }

  /**
   * @notice Approve a Tornado-style pool as an ETH source, pinned to its denomination.
   */
  function approvePool(address _pool, uint256 _denomination) external onlyOwner {
    require(_pool != address(0), InvalidPool());
    require(_denomination != 0, InvalidDenomination());

    approvedPools[_pool] = true;
    poolDenomination[_pool] = _denomination;

    emit PoolApproved(_pool, _denomination);
  }

  /**
   * @notice Approve a {ForwarderFactory} as real-Tornado ingress and pin its forwarder init-code
   * hash + denomination (read from the factory so they cannot drift apart). Additive: approve one
   * factory per pool, so notes from every denomination mint the same tornadoETH and can be merged
   * on Aztec.
   * @dev Owner-gated. A malicious factory cannot mint unbacked tokens: any forwarder it produces
   * must still deliver its pinned denomination to lock. The only owner power here is over
   * provenance scope, never over reserves.
   */
  function approveForwarderFactory(address _factory) external onlyOwner {
    require(_factory != address(0), InvalidFactory());
    require(IForwarderFactory(_factory).PORTAL() == address(this), InvalidFactory());
    uint256 denomination = IForwarderFactory(_factory).DENOMINATION();
    require(denomination != 0, InvalidDenomination());
    bytes32 initCodeHash = IForwarderFactory(_factory).FORWARDER_INIT_CODE_HASH();

    forwarderFactories[_factory] = ForwarderFactoryConfig({initCodeHash: initCodeHash, denomination: denomination});

    emit ForwarderFactoryApproved(_factory, initCodeHash, denomination);
  }

  /* -------------------------------------------------------------------------- */
  /*                          Ingress: Tornado -> Aztec                          */
  /* -------------------------------------------------------------------------- */

  /**
   * @notice Receive a Tornado withdrawal, lock the ETH, and message the Aztec tornadoETH
   * contract so the (hidden) recipient can mint private notes.
   * @dev The mint commitment travels in the L1->L2 message's secretHash slot as
   * `compute_secret_hash(poseidon2([aztec_recipient, mint_secret, amount]))`, so this
   * contract never learns the Aztec recipient.
   */
  function onTornadoWithdrawal(address _pool, bytes32 _nullifierHash, bytes32 _aztecMintCommitment)
    external
    payable
    override
    onlyInitialized
  {
    // Checks
    require(msg.sender == _pool, SenderNotPool(msg.sender, _pool));
    require(_aztecMintCommitment != 0, EmptyMintCommitment());

    uint256 expectedDenomination = _authorizeIngress(_pool, _aztecMintCommitment);
    require(msg.value == expectedDenomination, WrongDenomination(msg.value, expectedDenomination));

    // Effects
    bytes32 depositId = _registerDeposit(_pool, _nullifierHash, msg.value);

    // Interactions (inbox is a trusted protocol contract)
    (bytes32 key, uint256 index) = _sendMintMessage(depositId, msg.value, _aztecMintCommitment);

    emit TornadoBridgeDeposit(
      _pool, _nullifierHash, depositId, msg.value, _aztecMintCommitment, key, index
    );
  }

  /**
   * @notice Authorize the caller as a legitimate ETH source and return its pinned denomination.
   * @dev Two accepted ingress paths:
   *  1. An owner-approved pool that calls back directly (the mock, or any cooperating pool).
   *  2. A per-commitment {Forwarder} deployed by an approved {ForwarderFactory}, whose address is
   *     a CREATE2 binding to the commitment. This is how a REAL Tornado withdrawal attaches the
   *     Aztec recipient: Tornado's plain-ETH push carries no data, so the binding lives in the
   *     proof-bound `recipient` (== this forwarder address). Re-deriving it here and matching it
   *     against msg.sender is what makes the commitment unforgeable.
   *
   *     The caller names its factory via `FACTORY()`. That answer is untrusted but only selects
   *     which approved factory's CREATE2 derivation to check; a caller that lies cannot reproduce
   *     its own address from another factory, so it is rejected like any unapproved pool.
   */
  function _authorizeIngress(address _pool, bytes32 _aztecMintCommitment)
    internal
    view
    returns (uint256)
  {
    if (approvedPools[_pool]) {
      return poolDenomination[_pool];
    }
    // Low-level so a caller without FACTORY() (an EOA, a rogue pool) falls through to the revert.
    (bool ok, bytes memory ret) = _pool.staticcall(abi.encodeCall(IForwarderLike.FACTORY, ()));
    if (ok && ret.length == 32) {
      address factory = abi.decode(ret, (address));
      ForwarderFactoryConfig memory config = forwarderFactories[factory];
      if (
        config.denomination != 0
          && _pool == _computeForwarderAddress(factory, config.initCodeHash, _aztecMintCommitment)
      ) {
        return config.denomination;
      }
    }
    revert PoolNotApproved(_pool);
  }

  /// @notice CREATE2 address of the forwarder bound to a commitment (mirrors ForwarderFactory).
  function _computeForwarderAddress(address _factory, bytes32 _initCodeHash, bytes32 _aztecMintCommitment)
    internal
    pure
    returns (address)
  {
    return address(
      uint160(
        uint256(
          keccak256(abi.encodePacked(bytes1(0xff), _factory, _aztecMintCommitment, _initCodeHash))
        )
      )
    );
  }

  /**
   * @notice Derive the unique deposit id and account for the new reserve.
   * @dev Origin-agnostic seam: nothing in here is Tornado-specific beyond the inputs.
   * Uses sha256ToField (not raw keccak) so the id fits in a Noir Field and can be
   * reproduced byte-for-byte inside the L2 claim circuit.
   */
  function _registerDeposit(address _pool, bytes32 _nullifierHash, uint256 _amount)
    internal
    returns (bytes32)
  {
    bytes32 depositId =
      Hash.sha256ToField(abi.encode(block.chainid, _pool, _nullifierHash, _amount, address(this)));

    require(!consumedDepositIds[depositId], DepositAlreadyRegistered(depositId));
    consumedDepositIds[depositId] = true;
    totalLockedEth += _amount;

    return depositId;
  }

  /**
   * @notice Send the L1->L2 mint message for a registered deposit.
   * @dev The content signature is an identifier of the action, not a real function call
   * (same convention as the canonical TokenPortal). It must match the L2 contract's
   * `get_claim_content_hash` byte-for-byte.
   */
  function _sendMintMessage(bytes32 _depositId, uint256 _amount, bytes32 _aztecMintCommitment)
    internal
    returns (bytes32, uint256)
  {
    DataStructures.L2Actor memory actor = DataStructures.L2Actor(l2TornadoEthToken, rollupVersion);

    bytes32 contentHash = Hash.sha256ToField(
      abi.encodeWithSignature("claim_from_tornado_bridge(bytes32,uint256)", _depositId, _amount)
    );

    return inbox.sendL2Message(actor, contentHash, _aztecMintCommitment);
  }

  /* -------------------------------------------------------------------------- */
  /*                           Egress: Aztec -> L1 ETH                           */
  /* -------------------------------------------------------------------------- */

  /**
   * @notice Release reserve ETH by consuming an L2->L1 burn message emitted by the
   * tornadoETH contract's `burn_for_l1_withdrawal`.
   * @dev Callable by anyone: the executor only pays gas, funds can only ever go to the
   * recipient committed to in the burn message. Consuming the outbox leaf is the replay
   * protection — one burn maps to exactly one redemption.
   * @param _recipient - L1 recipient committed to in the burn message
   * @param _amount - Amount (wei) committed to in the burn message
   * @param _nonce - Nonce committed to in the burn message (disambiguates identical burns)
   * @param _epoch - Epoch the message was included in
   * @param _numCheckpointsInEpoch - Checkpoint count of the epoch's partial proof
   * @param _leafIndex - Index of the message leaf in the epoch message tree
   * @param _path - Sibling path proving inclusion
   */
  function withdrawFromAztec(
    address payable _recipient,
    uint256 _amount,
    bytes32 _nonce,
    Epoch _epoch,
    uint256 _numCheckpointsInEpoch,
    uint256 _leafIndex,
    bytes32[] calldata _path
  ) external onlyInitialized nonReentrant {
    DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
      sender: DataStructures.L2Actor(l2TornadoEthToken, rollupVersion),
      recipient: DataStructures.L1Actor(address(this), block.chainid),
      content: Hash.sha256ToField(
        abi.encodeWithSignature("withdraw_from_aztec(address,uint256,bytes32)", _recipient, _amount, _nonce)
      )
    });
    bytes32 burnMessageHash = Hash.sha256ToField(message);

    // Checks: outbox verifies membership and marks the leaf consumed (reverts on replay)
    outbox.consume(message, _epoch, _numCheckpointsInEpoch, _leafIndex, _path);

    // Effects
    require(_amount <= totalLockedEth, InsufficientLockedEth(_amount, totalLockedEth));
    totalLockedEth -= _amount;

    // Interactions
    (bool success,) = _recipient.call{value: _amount}("");
    require(success, EthTransferFailed(_recipient, _amount));

    emit AztecRedemption(_recipient, _amount, burnMessageHash);
  }
}
