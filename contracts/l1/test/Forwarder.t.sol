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

    // Same nullifier, different commitment: the factory's per-nullifier guard rejects it first...
    vm.expectRevert(abi.encodeWithSelector(ForwarderFactory.NullifierAlreadyBridged.selector, NULLIFIER));
    factory.withdrawAndBridge("", ROOT, NULLIFIER, bytes32(uint256(0xc0ffef)));

    // ...and the pool's own nullifier set rejects a direct replay.
    address other = factory.computeForwarderAddress(bytes32(uint256(0xc0ffef)));
    vm.expectRevert(MockRealTornadoPool.NoteAlreadySpent.selector);
    pool.withdraw("", ROOT, NULLIFIER, payable(other), payable(address(0)), 0, 0);
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

  /* ------------------------ Front-run recovery ------------------------ */

  /// @dev A front-runner replays the pending proof directly against the pool: the pool pays the
  /// undeployed forwarder and spends the nullifier, so withdrawAndBridge can no longer succeed.
  function _frontRunDirectlyToPool(bytes32 _commitment) internal returns (address forwarder) {
    forwarder = factory.computeForwarderAddress(_commitment);
    vm.prank(makeAddr("frontRunner"));
    pool.withdraw("", ROOT, NULLIFIER, payable(forwarder), payable(address(0)), 0, 0);
  }

  function _validInputs(address _recipient) internal pure returns (uint256[6] memory) {
    return [uint256(ROOT), uint256(NULLIFIER), uint256(uint160(_recipient)), 0, 0, 0];
  }

  function test_FrontRunDirectPoolWithdrawalIsRecoverable() public {
    address forwarder = _frontRunDirectlyToPool(COMMITMENT);
    assertEq(forwarder.balance, DENOMINATION, "pool paid the undeployed forwarder");
    assertEq(forwarder.code.length, 0);

    vm.expectRevert(MockRealTornadoPool.NoteAlreadySpent.selector);
    factory.withdrawAndBridge("", ROOT, NULLIFIER, COMMITMENT);

    // Anyone (here the front-runner) can finish the bridge, but only to the original commitment.
    vm.expectEmit(true, true, true, true, address(factory));
    emit ForwarderWithdrawal(forwarder, NULLIFIER, COMMITMENT, DENOMINATION);
    vm.prank(makeAddr("frontRunner"));
    factory.bridgeSpentWithdrawal("", ROOT, NULLIFIER, COMMITMENT);

    assertEq(address(bridge).balance, DENOMINATION, "bridge locked the stranded denomination");
    assertEq(bridge.totalLockedEth(), DENOMINATION);
    assertEq(forwarder.balance, 0);
    assertTrue(bridge.consumedDepositIds(_depositId(forwarder, NULLIFIER, DENOMINATION)));
    (,,, bytes32 secretHash) = inbox.lastMessage();
    assertEq(secretHash, COMMITMENT, "mint goes to the original commitment");
  }

  function test_RevertWhen_RecoveryForUnspentNullifier() public {
    vm.expectRevert(abi.encodeWithSelector(ForwarderFactory.WithdrawalNotSpent.selector, NULLIFIER));
    factory.bridgeSpentWithdrawal("", ROOT, NULLIFIER, COMMITMENT);
  }

  function test_RevertWhen_RecoveryProofBoundToAnotherRecipient() public {
    // Only the proof for recipient = forwarder(COMMITMENT) is valid.
    pool.setProofValid(false);
    pool.mockVerifier().setValidInputs(_validInputs(factory.computeForwarderAddress(COMMITMENT)), true);
    _frontRunDirectlyToPool(COMMITMENT);

    // Re-pointing the spent withdrawal at another commitment fails proof verification, even if that
    // commitment's forwarder address holds ETH.
    bytes32 otherCommitment = bytes32(uint256(0xbad));
    vm.deal(factory.computeForwarderAddress(otherCommitment), DENOMINATION);
    vm.expectRevert(ForwarderFactory.InvalidWithdrawProof.selector);
    factory.bridgeSpentWithdrawal("", ROOT, NULLIFIER, otherCommitment);

    factory.bridgeSpentWithdrawal("", ROOT, NULLIFIER, COMMITMENT);
    assertEq(bridge.totalLockedEth(), DENOMINATION);
  }

  function test_RevertWhen_RecoveryReplayed() public {
    address forwarder = _frontRunDirectlyToPool(COMMITMENT);
    factory.bridgeSpentWithdrawal("", ROOT, NULLIFIER, COMMITMENT);

    // Topping the forwarder up with plain ETH cannot mint a second deposit for the same nullifier.
    vm.deal(forwarder, DENOMINATION);
    vm.expectRevert(abi.encodeWithSelector(ForwarderFactory.NullifierAlreadyBridged.selector, NULLIFIER));
    factory.bridgeSpentWithdrawal("", ROOT, NULLIFIER, COMMITMENT);
  }

  function test_RevertWhen_RecoveryAfterNormalBridge() public {
    factory.withdrawAndBridge("", ROOT, NULLIFIER, COMMITMENT);

    vm.deal(factory.computeForwarderAddress(COMMITMENT), DENOMINATION);
    vm.expectRevert(abi.encodeWithSelector(ForwarderFactory.NullifierAlreadyBridged.selector, NULLIFIER));
    factory.bridgeSpentWithdrawal("", ROOT, NULLIFIER, COMMITMENT);
  }

  /// @dev One spent note must not authorize many plain-ETH-backed deposits through fresh forwarders.
  function test_RevertWhen_SpentNullifierReusedForAnotherForwarder() public {
    _frontRunDirectlyToPool(COMMITMENT);
    factory.bridgeSpentWithdrawal("", ROOT, NULLIFIER, COMMITMENT);

    bytes32 freshCommitment = bytes32(uint256(0xf00d));
    vm.deal(factory.computeForwarderAddress(freshCommitment), DENOMINATION);
    vm.expectRevert(abi.encodeWithSelector(ForwarderFactory.NullifierAlreadyBridged.selector, NULLIFIER));
    factory.bridgeSpentWithdrawal("", ROOT, NULLIFIER, freshCommitment);
    assertEq(bridge.totalLockedEth(), DENOMINATION, "still exactly one deposit for the note");
  }

  /* ------------------------------ Coexistence ------------------------------ */

  function test_FactoryDenominationMatchesPool() public view {
    assertEq(factory.DENOMINATION(), DENOMINATION);
    assertEq(address(factory.TORNADO()), address(pool));
    assertEq(factory.PORTAL(), address(bridge));
  }
}
