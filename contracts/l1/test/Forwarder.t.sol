// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";

import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

import {TornadoEthBridgeL1} from "../src/TornadoEthBridgeL1.sol";
import {ForwarderFactory} from "../src/ForwarderFactory.sol";
import {Forwarder} from "../src/Forwarder.sol";
import {ITornadoInstance} from "../src/ITornadoInstance.sol";
import {MockRealTornadoPool} from "../src/MockRealTornadoPool.sol";
import {MockInbox, MockOutbox, MockRollup, MockRegistry} from "./mocks/MessagingMocks.sol";

/// @notice Tries to spoof the forwarder ingress: calls the bridge claiming to be a forwarder for a
/// commitment, but from an address that is not the factory's CREATE2 forwarder for that commitment.
contract SpoofPool {
  function attack(TornadoEthBridgeL1 _bridge, bytes32 _nullifierHash, bytes32 _commitment) external payable {
    _bridge.onTornadoWithdrawal{value: msg.value}(address(this), _nullifierHash, _commitment);
  }
}

contract ForwarderTest is Test {
  uint256 internal constant DENOMINATION = 1 ether;
  uint256 internal constant ROLLUP_VERSION = 42;
  bytes32 internal constant L2_TOKEN = bytes32(uint256(0x1234abcd));
  bytes32 internal constant COMMITMENT = bytes32(uint256(0xc0ffee));
  bytes32 internal constant NULLIFIER = bytes32(uint256(0xdead01));
  bytes32 internal constant ROOT = bytes32(uint256(0x1111));

  MockInbox internal inbox;
  MockOutbox internal outbox;
  MockRollup internal rollup;
  MockRegistry internal registry;
  TornadoEthBridgeL1 internal bridge;
  MockRealTornadoPool internal pool;
  ForwarderFactory internal factory;

  address internal user = makeAddr("user");

  event ForwarderWithdrawal(
    address indexed forwarder,
    bytes32 indexed nullifierHash,
    bytes32 indexed aztecMintCommitment,
    uint256 amount
  );

  function setUp() public {
    inbox = new MockInbox();
    outbox = new MockOutbox();
    rollup = new MockRollup(address(inbox), address(outbox), ROLLUP_VERSION);
    registry = new MockRegistry(address(rollup));

    bridge = new TornadoEthBridgeL1();
    bridge.initialize(address(registry), L2_TOKEN);

    pool = new MockRealTornadoPool(DENOMINATION);
    vm.deal(address(pool), 100 ether);
    pool.setKnownRoot(ROOT, true);

    factory = new ForwarderFactory(address(bridge), ITornadoInstance(address(pool)));
    bridge.setForwarderFactory(address(factory));
  }

  /* ------------------------------ Helpers ------------------------------ */

  function _depositId(address _forwarder, bytes32 _nullifierHash, uint256 _amount)
    internal
    view
    returns (bytes32)
  {
    return Hash.sha256ToField(abi.encode(block.chainid, _forwarder, _nullifierHash, _amount, address(bridge)));
  }

  function _claimContentHash(bytes32 _depositIdValue, uint256 _amount) internal pure returns (bytes32) {
    return Hash.sha256ToField(
      abi.encodeWithSignature("claim_from_tornado_bridge(bytes32,uint256)", _depositIdValue, _amount)
    );
  }

  /* -------------------------- Configuration wiring -------------------------- */

  function test_SetForwarderFactoryConfiguresPortal() public view {
    assertEq(bridge.approvedForwarderFactory(), address(factory));
    assertEq(bridge.forwarderDenomination(), DENOMINATION);
    assertEq(bridge.forwarderInitCodeHash(), factory.FORWARDER_INIT_CODE_HASH());
  }

  function test_RevertWhen_SetForwarderFactoryByNonOwner() public {
    vm.prank(user);
    vm.expectRevert(TornadoEthBridgeL1.NotOwner.selector);
    bridge.setForwarderFactory(address(factory));
  }

  function test_RevertWhen_SetForwarderFactoryZero() public {
    vm.expectRevert(TornadoEthBridgeL1.InvalidFactory.selector);
    bridge.setForwarderFactory(address(0));
  }

  /* ------------------------ Happy path: real-Tornado ingress ------------------------ */

  function test_ForwarderWithdrawalLocksEthAndMessages() public {
    address forwarder = factory.computeForwarderAddress(COMMITMENT);
    bytes32 depositId = _depositId(forwarder, NULLIFIER, DENOMINATION);

    vm.expectEmit(true, true, true, true, address(factory));
    emit ForwarderWithdrawal(forwarder, NULLIFIER, COMMITMENT, DENOMINATION);
    factory.withdrawAndBridge("", ROOT, NULLIFIER, COMMITMENT);

    assertEq(address(bridge).balance, DENOMINATION, "bridge locked the denomination");
    assertEq(bridge.totalLockedEth(), DENOMINATION, "reserve accounting");
    assertTrue(bridge.consumedDepositIds(depositId), "depositId keyed on the forwarder");
    assertTrue(pool.nullifierHashes(NULLIFIER), "nullifier spent on the pool");
    assertGt(forwarder.code.length, 0, "forwarder deployed at the predicted address");

    (bytes32 actor, uint256 version, bytes32 content, bytes32 secretHash) = inbox.lastMessage();
    assertEq(actor, L2_TOKEN);
    assertEq(version, ROLLUP_VERSION);
    assertEq(content, _claimContentHash(depositId, DENOMINATION));
    assertEq(secretHash, COMMITMENT, "mint commitment rides in the secretHash slot");
  }

  function test_PortalAndFactoryDeriveSameForwarderAddress() public {
    // If the portal and factory disagreed on the CREATE2 address, _authorizeIngress would revert
    // PoolNotApproved and this withdrawal would fail. Success proves they agree.
    factory.withdrawAndBridge("", ROOT, NULLIFIER, COMMITMENT);
    assertTrue(bridge.consumedDepositIds(_depositId(factory.computeForwarderAddress(COMMITMENT), NULLIFIER, DENOMINATION)));
  }

  /* ------------------------------ Griefing defense ------------------------------ */

  function test_GrieferDustDoesNotBreakWithdrawal() public {
    bytes32 commitment = bytes32(uint256(0xd00d));
    address forwarder = factory.computeForwarderAddress(commitment);

    // Griefer pre-funds the deterministic (still undeployed) forwarder address.
    vm.deal(forwarder, 0.3 ether);

    factory.withdrawAndBridge("", ROOT, NULLIFIER, commitment);

    assertEq(address(bridge).balance, DENOMINATION, "portal received exactly the denomination");
    assertEq(bridge.totalLockedEth(), DENOMINATION);
    assertEq(forwarder.balance, 0.3 ether, "griefer dust stranded, withdrawal unaffected");
  }

  /* ------------------------------ Rejections ------------------------------ */

  function test_RevertWhen_CommitmentEmpty() public {
    vm.expectRevert(ForwarderFactory.EmptyCommitment.selector);
    factory.withdrawAndBridge("", ROOT, NULLIFIER, bytes32(0));
  }

  function test_RevertWhen_NullifierReusedAtPool() public {
    factory.withdrawAndBridge("", ROOT, NULLIFIER, COMMITMENT);

    // Same nullifier, different commitment: the real pool's nullifier set rejects the replay.
    vm.expectRevert(MockRealTornadoPool.NoteAlreadySpent.selector);
    factory.withdrawAndBridge("", ROOT, NULLIFIER, bytes32(uint256(0xc0ffef)));
  }

  function test_RevertWhen_RootUnknown() public {
    vm.expectRevert(MockRealTornadoPool.UnknownRoot.selector);
    factory.withdrawAndBridge("", bytes32(uint256(0x9999)), NULLIFIER, COMMITMENT);
  }

  function test_RevertWhen_ProofInvalid() public {
    pool.setProofValid(false);
    vm.expectRevert(MockRealTornadoPool.InvalidWithdrawProof.selector);
    factory.withdrawAndBridge("", ROOT, NULLIFIER, COMMITMENT);
  }

  function test_RevertWhen_FlushCalledByNonFactory() public {
    factory.withdrawAndBridge("", ROOT, NULLIFIER, COMMITMENT);
    address forwarder = factory.computeForwarderAddress(COMMITMENT);

    vm.prank(user);
    vm.expectRevert(abi.encodeWithSelector(Forwarder.NotFactory.selector, user));
    Forwarder(payable(forwarder)).flushToPortal(NULLIFIER, COMMITMENT);
  }

  function test_RevertWhen_SpoofedForwarderIngress() public {
    // A contract that is not the factory's forwarder for COMMITMENT cannot attribute a deposit.
    SpoofPool spoof = new SpoofPool();
    vm.deal(address(spoof), 1 ether);

    vm.expectRevert(abi.encodeWithSelector(TornadoEthBridgeL1.PoolNotApproved.selector, address(spoof)));
    spoof.attack{value: 1 ether}(bridge, NULLIFIER, COMMITMENT);
  }

  /* ------------------------------ Coexistence ------------------------------ */

  function test_FactoryDenominationMatchesPool() public view {
    assertEq(factory.DENOMINATION(), DENOMINATION);
    assertEq(address(factory.TORNADO()), address(pool));
    assertEq(factory.PORTAL(), address(bridge));
  }
}
