// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";

import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

import {TornadoEthBridgeL1} from "../../src/TornadoEthBridgeL1.sol";
import {ForwarderFactory} from "../../src/ForwarderFactory.sol";
import {ITornadoInstance} from "../../src/ITornadoInstance.sol";
import {MockInbox, MockOutbox, MockRollup, MockRegistry} from "../mocks/MessagingMocks.sol";

interface IVerifier {
  function verifyProof(bytes memory, uint256[6] memory) external returns (bool);
}

/**
 * @title RealTornadoForkTest (Tier 2)
 * @notice Drives our {ForwarderFactory}/portal against the REAL deployed 1 ETH Tornado pool bytecode
 * on a mainnet fork, with the pool's verifier (and root membership) mocked to bypass proof
 * generation. This proves the ENTIRE integration surface -- the real `withdraw` control flow, the
 * plain-ETH push into our forwarder, denomination, nullifier accounting on the real contract, the
 * forwarder->portal handoff, depositId derivation and the L1->L2 message -- EXCEPT proof validity
 * (covered at Tier 3 with a real Groth16 proof).
 * @dev Self-skips when MAINNET_RPC_URL is unset, so the default offline suite is unaffected. Run via
 * `yarn test:l1:fork`.
 */
contract RealTornadoForkTest is Test {
  // Canonical Tornado.Cash 1 ETH pool.
  address internal constant TORNADO_1ETH = 0x47CE0C6eD5B0Ce3d3A51fdb1C52DC66a7c3c2936;

  uint256 internal constant ROLLUP_VERSION = 42;
  bytes32 internal constant L2_TOKEN = bytes32(uint256(0x1234abcd));
  bytes32 internal constant COMMITMENT = bytes32(uint256(0xc0ffee));

  bool internal forkEnabled;
  MockInbox internal inbox;
  MockOutbox internal outbox;
  TornadoEthBridgeL1 internal bridge;
  ForwarderFactory internal factory;
  ITornadoInstance internal pool;

  function setUp() public {
    string memory rpc = vm.envOr("MAINNET_RPC_URL", string(""));
    if (bytes(rpc).length == 0) {
      forkEnabled = false;
      return;
    }
    forkEnabled = true;
    // Default pins an archive block (needs an archive RPC, e.g. Alchemy/Infura). With only a pruned
    // or public node, override TORNADO_FORK_BLOCK to a very recent block whose state is still served.
    vm.createSelectFork(rpc, vm.envOr("TORNADO_FORK_BLOCK", uint256(18_500_000)));

    pool = ITornadoInstance(TORNADO_1ETH);

    inbox = new MockInbox();
    outbox = new MockOutbox();
    MockRollup rollup = new MockRollup(address(inbox), address(outbox), ROLLUP_VERSION);
    MockRegistry registry = new MockRegistry(address(rollup));

    bridge = new TornadoEthBridgeL1();
    bridge.initialize(address(registry), L2_TOKEN);

    factory = new ForwarderFactory(address(bridge), pool);
    bridge.setForwarderFactory(address(factory));

    // Tier 2: bypass only zk proof VERIFICATION (an external call to the verifier contract). Root
    // membership is an INTERNAL call inside Tornado.withdraw and cannot be mocked, so the tests use a
    // genuinely known root from the live tree (getLastRoot) rather than a synthetic one.
    vm.mockCall(pool.verifier(), abi.encodeWithSelector(IVerifier.verifyProof.selector), abi.encode(true));
  }

  modifier onlyFork() {
    if (!forkEnabled) {
      vm.skip(true);
      return;
    }
    _;
  }

  function _freshNullifier(uint256 _salt) internal pure returns (bytes32) {
    return keccak256(abi.encode("aztec-portal-fork-test", _salt));
  }

  function _depositId(address _forwarder, bytes32 _nullifierHash, uint256 _amount)
    internal
    view
    returns (bytes32)
  {
    return Hash.sha256ToField(abi.encode(block.chainid, _forwarder, _nullifierHash, _amount, address(bridge)));
  }

  function test_AdapterPullsDenominationFromRealPool() public onlyFork {
    uint256 denomination = pool.denomination();
    assertEq(denomination, 1 ether, "canonical 1 ETH instance");

    bytes32 nullifier = _freshNullifier(1);
    assertFalse(pool.nullifierHashes(nullifier), "fresh nullifier at the fork block");

    bytes32 root = pool.getLastRoot();
    address forwarder = factory.computeForwarderAddress(COMMITMENT);
    factory.withdrawAndBridge("", root, nullifier, COMMITMENT);

    assertEq(address(bridge).balance, denomination, "bridge locked real Tornado ETH");
    assertEq(bridge.totalLockedEth(), denomination);
    assertTrue(bridge.consumedDepositIds(_depositId(forwarder, nullifier, denomination)), "depositId keyed on forwarder");
    assertTrue(pool.nullifierHashes(nullifier), "nullifier marked spent on the real pool");

    (,,, bytes32 secretHash) = inbox.lastMessage();
    assertEq(secretHash, COMMITMENT, "mint commitment reached the L1->L2 message");
  }

  function test_RevertWhen_NullifierReplayedOnRealPool() public onlyFork {
    bytes32 root = pool.getLastRoot();
    bytes32 nullifier = _freshNullifier(2);
    factory.withdrawAndBridge("", root, nullifier, COMMITMENT);

    // The factory refuses a second bridge for the nullifier...
    vm.expectRevert(abi.encodeWithSelector(ForwarderFactory.NullifierAlreadyBridged.selector, nullifier));
    factory.withdrawAndBridge("", root, nullifier, bytes32(uint256(0xc0ffef)));

    // ...and the real pool's nullifier set rejects a direct replay (revert string from Tornado.sol).
    address other = factory.computeForwarderAddress(bytes32(uint256(0xc0ffef)));
    vm.expectRevert(bytes("The note has been already spent"));
    pool.withdraw("", root, nullifier, payable(other), payable(address(0)), 0, 0);
  }

  function test_RecoversFrontRunOnRealPool() public onlyFork {
    bytes32 root = pool.getLastRoot();
    bytes32 nullifier = _freshNullifier(4);
    address forwarder = factory.computeForwarderAddress(COMMITMENT);

    // Front-runner submits the proof straight to the real pool: it pays the undeployed forwarder.
    pool.withdraw("", root, nullifier, payable(forwarder), payable(address(0)), 0, 0);
    assertEq(forwarder.balance, pool.denomination(), "real pool paid the forwarder address");

    factory.bridgeSpentWithdrawal("", root, nullifier, COMMITMENT);
    assertEq(bridge.totalLockedEth(), pool.denomination(), "stranded ETH bridged");
    assertTrue(bridge.consumedDepositIds(_depositId(forwarder, nullifier, pool.denomination())));
  }

  function test_RevertWhen_RootUnknownOnRealPool() public onlyFork {
    // isKnownRoot is the real (un-mockable) internal check, so a bogus root is genuinely rejected.
    vm.expectRevert(bytes("Cannot find your merkle root"));
    factory.withdrawAndBridge("", bytes32(uint256(0xdeadbeef)), _freshNullifier(3), COMMITMENT);
  }
}
