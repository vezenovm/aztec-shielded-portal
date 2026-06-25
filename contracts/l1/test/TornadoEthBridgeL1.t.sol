// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";

import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

import {TornadoEthBridgeL1} from "../src/TornadoEthBridgeL1.sol";
import {MockTornadoPool} from "../src/MockTornadoPool.sol";
import {MockInbox, MockOutbox, MockRollup, MockRegistry} from "./mocks/MessagingMocks.sol";

/// @notice Approved "pool" that replays the same nullifier against the bridge twice,
/// to exercise the bridge's own depositId guard independently of the pool's guard.
contract ReplayingPool {
  function attack(TornadoEthBridgeL1 _bridge, bytes32 _nullifierHash, bytes32 _commitment) external payable {
    uint256 half = msg.value / 2;
    _bridge.onTornadoWithdrawal{value: half}(address(this), _nullifierHash, _commitment);
    _bridge.onTornadoWithdrawal{value: half}(address(this), _nullifierHash, _commitment);
  }
}

/// @notice Recipient that attempts to re-enter withdrawFromAztec from its receive hook.
contract ReentrantRecipient {
  TornadoEthBridgeL1 public bridge;
  bool public attacked;
  bool public reentered;
  bytes public innerError;

  constructor(TornadoEthBridgeL1 _bridge) {
    bridge = _bridge;
  }

  receive() external payable {
    if (!attacked) {
      attacked = true;
      // Different nonce so the mock outbox would happily consume it if reentrancy were allowed.
      try bridge.withdrawFromAztec(
        payable(address(this)), 0.1 ether, bytes32(uint256(0xbeef)), Epoch.wrap(0), 1, 1, new bytes32[](0)
      ) {
        reentered = true;
      } catch (bytes memory err) {
        innerError = err;
      }
    }
  }
}

/// @notice Recipient with no receive hook, to exercise the failed-transfer path.
contract RejectingRecipient {}

contract TornadoEthBridgeL1Test is Test {
  uint256 internal constant DENOMINATION = 1 ether;
  uint256 internal constant ROLLUP_VERSION = 42;
  bytes32 internal constant L2_TOKEN = bytes32(uint256(0x1234abcd));
  bytes32 internal constant COMMITMENT = bytes32(uint256(0xc0ffee));
  bytes32 internal constant NULLIFIER = bytes32(uint256(0xdead01));

  MockInbox internal inbox;
  MockOutbox internal outbox;
  MockRollup internal rollup;
  MockRegistry internal registry;
  TornadoEthBridgeL1 internal bridge;
  MockTornadoPool internal pool;

  address internal user = makeAddr("user");

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

  function setUp() public {
    inbox = new MockInbox();
    outbox = new MockOutbox();
    rollup = new MockRollup(address(inbox), address(outbox), ROLLUP_VERSION);
    registry = new MockRegistry(address(rollup));

    bridge = new TornadoEthBridgeL1();
    bridge.initialize(address(registry), L2_TOKEN);

    pool = new MockTornadoPool(DENOMINATION);
    vm.deal(address(pool), 100 ether);
    bridge.approvePool(address(pool), DENOMINATION);
  }

  /* ------------------------------ Helpers ------------------------------ */

  function _depositId(address _pool, bytes32 _nullifierHash, uint256 _amount) internal view returns (bytes32) {
    return Hash.sha256ToField(abi.encode(block.chainid, _pool, _nullifierHash, _amount, address(bridge)));
  }

  function _claimContentHash(bytes32 _depositIdValue, uint256 _amount) internal pure returns (bytes32) {
    return Hash.sha256ToField(
      abi.encodeWithSignature("claim_from_tornado_bridge(bytes32,uint256)", _depositIdValue, _amount)
    );
  }

  function _burnMessage(address _recipient, uint256 _amount, bytes32 _nonce)
    internal
    view
    returns (DataStructures.L2ToL1Msg memory)
  {
    return DataStructures.L2ToL1Msg({
      sender: DataStructures.L2Actor(L2_TOKEN, ROLLUP_VERSION),
      recipient: DataStructures.L1Actor(address(bridge), block.chainid),
      content: Hash.sha256ToField(
        abi.encodeWithSignature("withdraw_from_aztec(address,uint256,bytes32)", _recipient, _amount, _nonce)
      )
    });
  }

  function _deposit(bytes32 _nullifierHash) internal {
    pool.withdrawToBridge(payable(address(bridge)), _nullifierHash, COMMITMENT);
  }

  /* ----------------------- Spec test 1: approved pool ----------------------- */

  function test_ApprovedPoolCanDeposit() public {
    _deposit(NULLIFIER);

    assertEq(address(bridge).balance, DENOMINATION, "bridge holds the ETH");
    assertTrue(bridge.consumedDepositIds(_depositId(address(pool), NULLIFIER, DENOMINATION)));
  }

  /* ---------------------- Spec test 2: unapproved pool ---------------------- */

  function test_RevertWhen_PoolNotApproved() public {
    MockTornadoPool rogue = new MockTornadoPool(DENOMINATION);
    vm.deal(address(rogue), 10 ether);

    vm.expectRevert(abi.encodeWithSelector(TornadoEthBridgeL1.PoolNotApproved.selector, address(rogue)));
    rogue.withdrawToBridge(payable(address(bridge)), NULLIFIER, COMMITMENT);
  }

  function test_RevertWhen_SenderIsNotClaimedPool() public {
    // A caller cannot attribute a deposit to a pool it is not.
    vm.deal(user, 1 ether);
    vm.prank(user);
    vm.expectRevert(
      abi.encodeWithSelector(TornadoEthBridgeL1.SenderNotPool.selector, user, address(pool))
    );
    bridge.onTornadoWithdrawal{value: 1 ether}(address(pool), NULLIFIER, COMMITMENT);
  }

  /* --------------------- Spec test 3: wrong denomination --------------------- */

  function test_RevertWhen_WrongDenomination() public {
    // Pool registered for 2 ether but pays out its 1 ether denomination.
    MockTornadoPool misconfigured = new MockTornadoPool(1 ether);
    vm.deal(address(misconfigured), 10 ether);
    bridge.approvePool(address(misconfigured), 2 ether);

    vm.expectRevert(abi.encodeWithSelector(TornadoEthBridgeL1.WrongDenomination.selector, 1 ether, 2 ether));
    misconfigured.withdrawToBridge(payable(address(bridge)), NULLIFIER, COMMITMENT);
  }

  /* ------------------ Spec test 4: duplicate nullifier/depositId ------------------ */

  function test_RevertWhen_NullifierReusedAtPool() public {
    _deposit(NULLIFIER);

    vm.expectRevert(abi.encodeWithSelector(MockTornadoPool.NullifierAlreadySpent.selector, NULLIFIER));
    pool.withdrawToBridge(payable(address(bridge)), NULLIFIER, COMMITMENT);
  }

  function test_RevertWhen_DepositIdReplayedAtBridge() public {
    // Bridge-level guard, independent of the pool's nullifier set.
    ReplayingPool replayer = new ReplayingPool();
    bridge.approvePool(address(replayer), 1 ether);
    vm.deal(address(this), 2 ether);

    bytes32 expectedId = _depositId(address(replayer), NULLIFIER, 1 ether);
    vm.expectRevert(
      abi.encodeWithSelector(TornadoEthBridgeL1.DepositAlreadyRegistered.selector, expectedId)
    );
    replayer.attack{value: 2 ether}(bridge, NULLIFIER, COMMITMENT);
  }

  /* ------------------- Spec test 5: reserve accounting ------------------- */

  function test_DepositIncreasesTotalLockedEth() public {
    assertEq(bridge.totalLockedEth(), 0);

    _deposit(NULLIFIER);
    assertEq(bridge.totalLockedEth(), DENOMINATION);

    _deposit(bytes32(uint256(0xdead02)));
    assertEq(bridge.totalLockedEth(), 2 * DENOMINATION);
  }

  /* ----------------------- Spec test 6: deposit event ----------------------- */

  function test_DepositEmitsTornadoBridgeDeposit() public {
    bytes32 expectedId = _depositId(address(pool), NULLIFIER, DENOMINATION);
    bytes32 expectedContent = _claimContentHash(expectedId, DENOMINATION);
    // MockInbox key derivation for its first message.
    bytes32 expectedKey = keccak256(abi.encode(expectedContent, COMMITMENT, uint256(1)));

    vm.expectEmit(true, true, true, true, address(bridge));
    emit TornadoBridgeDeposit(
      address(pool), NULLIFIER, expectedId, DENOMINATION, COMMITMENT, expectedKey, 1
    );
    _deposit(NULLIFIER);
  }

  /* --------------------- Spec test 7: L1->L2 message sent --------------------- */

  function test_DepositSendsL1ToL2Message() public {
    _deposit(NULLIFIER);

    (bytes32 actor, uint256 version, bytes32 content, bytes32 secretHash) = inbox.lastMessage();
    assertEq(actor, L2_TOKEN, "message recipient is the L2 tornadoETH contract");
    assertEq(version, ROLLUP_VERSION, "rollup version");
    assertEq(content, _claimContentHash(_depositId(address(pool), NULLIFIER, DENOMINATION), DENOMINATION));
    assertEq(secretHash, COMMITMENT, "mint commitment rides in the secretHash slot");
    assertEq(inbox.messagesSent(), 1);
  }

  function test_RevertWhen_EmptyMintCommitment() public {
    vm.expectRevert(TornadoEthBridgeL1.EmptyMintCommitment.selector);
    pool.withdrawToBridge(payable(address(bridge)), NULLIFIER, bytes32(0));
  }

  /* -------------------- Spec test 8: valid burn releases ETH -------------------- */

  function test_ValidBurnMessageReleasesEth() public {
    _deposit(NULLIFIER);

    bytes32 nonce = bytes32(uint256(7));
    uint256 amount = 0.4 ether;
    DataStructures.L2ToL1Msg memory message = _burnMessage(user, amount, nonce);

    vm.expectEmit(true, true, true, true, address(bridge));
    emit AztecRedemption(user, amount, Hash.sha256ToField(message));
    bridge.withdrawFromAztec(payable(user), amount, nonce, Epoch.wrap(0), 1, 0, new bytes32[](0));

    assertEq(user.balance, amount, "recipient received the ETH");
    assertEq(bridge.totalLockedEth(), DENOMINATION - amount, "reserve decreased");
    assertTrue(outbox.consumed(Hash.sha256ToField(message)), "outbox leaf consumed");
  }

  /* ------------------- Spec test 9: invalid burn is rejected ------------------- */

  function test_RevertWhen_InvalidBurnMessage() public {
    _deposit(NULLIFIER);

    outbox.setShouldRevert(true);
    vm.expectRevert("MockOutbox: invalid message");
    bridge.withdrawFromAztec(payable(user), 0.4 ether, bytes32(uint256(7)), Epoch.wrap(0), 1, 0, new bytes32[](0));

    assertEq(user.balance, 0);
    assertEq(bridge.totalLockedEth(), DENOMINATION);
  }

  function test_RevertWhen_BurnMessageReplayed() public {
    _deposit(NULLIFIER);

    bytes32 nonce = bytes32(uint256(7));
    bridge.withdrawFromAztec(payable(user), 0.4 ether, nonce, Epoch.wrap(0), 1, 0, new bytes32[](0));

    vm.expectRevert("MockOutbox: already consumed");
    bridge.withdrawFromAztec(payable(user), 0.4 ether, nonce, Epoch.wrap(0), 1, 0, new bytes32[](0));
  }

  /* ------------------ Spec test 10: cannot exceed locked reserve ------------------ */

  function test_RevertWhen_WithdrawExceedsLockedReserve() public {
    _deposit(NULLIFIER);

    vm.expectRevert(
      abi.encodeWithSelector(TornadoEthBridgeL1.InsufficientLockedEth.selector, 2 ether, 1 ether)
    );
    bridge.withdrawFromAztec(
      payable(user), 2 ether, bytes32(uint256(7)), Epoch.wrap(0), 1, 0, new bytes32[](0)
    );
  }

  /* ------------------------------ Hardening ------------------------------ */

  function test_ReentrantWithdrawalIsBlocked() public {
    _deposit(NULLIFIER);
    _deposit(bytes32(uint256(0xdead02)));

    ReentrantRecipient attacker = new ReentrantRecipient(bridge);
    // Outer withdrawal succeeds; the nested attempt inside receive() must be blocked.
    bridge.withdrawFromAztec(
      payable(address(attacker)), 0.5 ether, bytes32(uint256(1)), Epoch.wrap(0), 1, 0, new bytes32[](0)
    );

    assertTrue(attacker.attacked(), "receive hook ran");
    assertFalse(attacker.reentered(), "nested withdrawal must not succeed");
    assertEq(bytes4(attacker.innerError()), TornadoEthBridgeL1.ReentrantCall.selector);
    assertEq(address(attacker).balance, 0.5 ether, "only the outer withdrawal paid out");
  }

  function test_RevertWhen_EthTransferFails() public {
    _deposit(NULLIFIER);
    RejectingRecipient rejecting = new RejectingRecipient();

    vm.expectRevert(
      abi.encodeWithSelector(
        TornadoEthBridgeL1.EthTransferFailed.selector, address(rejecting), 0.4 ether
      )
    );
    bridge.withdrawFromAztec(
      payable(address(rejecting)), 0.4 ether, bytes32(uint256(7)), Epoch.wrap(0), 1, 0, new bytes32[](0)
    );
  }

  function test_BridgeHasNoPlainEthIngress() public {
    // Provenance guarantee: plain transfers (no pool callback) must revert.
    vm.deal(user, 1 ether);
    vm.prank(user);
    (bool success,) = address(bridge).call{value: 1 ether}("");
    assertFalse(success, "bare ETH transfer must be rejected");
  }

  function test_RevertWhen_DepositBeforeInitialize() public {
    TornadoEthBridgeL1 fresh = new TornadoEthBridgeL1();
    fresh.approvePool(address(pool), DENOMINATION);

    vm.deal(address(pool), 1 ether);
    vm.prank(address(pool));
    vm.expectRevert(TornadoEthBridgeL1.NotInitialized.selector);
    fresh.onTornadoWithdrawal{value: 1 ether}(address(pool), NULLIFIER, COMMITMENT);
  }

  function test_RevertWhen_NonOwnerAdministrates() public {
    vm.prank(user);
    vm.expectRevert(TornadoEthBridgeL1.NotOwner.selector);
    bridge.approvePool(address(0x1), 1 ether);

    TornadoEthBridgeL1 fresh = new TornadoEthBridgeL1();
    vm.prank(user);
    vm.expectRevert(TornadoEthBridgeL1.NotOwner.selector);
    fresh.initialize(address(registry), L2_TOKEN);
  }

  function test_RevertWhen_InitializedTwice() public {
    vm.expectRevert(TornadoEthBridgeL1.AlreadyInitialized.selector);
    bridge.initialize(address(registry), L2_TOKEN);
  }
}
