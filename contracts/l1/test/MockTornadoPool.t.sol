// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {Test} from "forge-std/Test.sol";

import {MockTornadoPool} from "../src/MockTornadoPool.sol";
import {ITornadoWithdrawalReceiver} from "../src/ITornadoWithdrawalReceiver.sol";

/// @notice Records what the pool callback delivers.
contract RecordingReceiver is ITornadoWithdrawalReceiver {
  address public pool;
  bytes32 public nullifierHash;
  bytes32 public commitment;
  uint256 public receivedValue;

  function onTornadoWithdrawal(address _pool, bytes32 _nullifierHash, bytes32 _aztecMintCommitment)
    external
    payable
    override
  {
    pool = _pool;
    nullifierHash = _nullifierHash;
    commitment = _aztecMintCommitment;
    receivedValue = msg.value;
  }
}

contract MockTornadoPoolTest is Test {
  uint256 internal constant DENOMINATION = 1 ether;
  bytes32 internal constant NULLIFIER = bytes32(uint256(0xdead01));
  bytes32 internal constant COMMITMENT = bytes32(uint256(0xc0ffee));

  MockTornadoPool internal pool;
  RecordingReceiver internal receiver;

  event MockTornadoWithdrawal(
    address indexed recipient, bytes32 indexed nullifierHash, uint256 amount, bytes32 aztecMintCommitment
  );

  function setUp() public {
    pool = new MockTornadoPool(DENOMINATION);
    receiver = new RecordingReceiver();
    vm.deal(address(pool), 10 ether);
  }

  function test_WithdrawalPaysExactDenominationViaCallback() public {
    pool.withdrawToBridge(payable(address(receiver)), NULLIFIER, COMMITMENT);

    assertEq(receiver.receivedValue(), DENOMINATION);
    assertEq(address(receiver).balance, DENOMINATION);
    assertEq(receiver.pool(), address(pool));
    assertEq(receiver.nullifierHash(), NULLIFIER);
    assertEq(receiver.commitment(), COMMITMENT);
    assertTrue(pool.nullifierHashes(NULLIFIER));
  }

  function test_EmitsMockTornadoWithdrawal() public {
    vm.expectEmit(true, true, true, true, address(pool));
    emit MockTornadoWithdrawal(address(receiver), NULLIFIER, DENOMINATION, COMMITMENT);
    pool.withdrawToBridge(payable(address(receiver)), NULLIFIER, COMMITMENT);
  }

  function test_RevertWhen_NullifierReused() public {
    pool.withdrawToBridge(payable(address(receiver)), NULLIFIER, COMMITMENT);

    vm.expectRevert(abi.encodeWithSelector(MockTornadoPool.NullifierAlreadySpent.selector, NULLIFIER));
    pool.withdrawToBridge(payable(address(receiver)), NULLIFIER, COMMITMENT);
  }

  function test_RevertWhen_PoolUnderfunded() public {
    MockTornadoPool poor = new MockTornadoPool(DENOMINATION);

    vm.expectRevert(
      abi.encodeWithSelector(MockTornadoPool.InsufficientPoolBalance.selector, 0, DENOMINATION)
    );
    poor.withdrawToBridge(payable(address(receiver)), NULLIFIER, COMMITMENT);
  }
}
