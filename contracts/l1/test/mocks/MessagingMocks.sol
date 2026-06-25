// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {DataStructures} from "@aztec/core/libraries/DataStructures.sol";
import {Epoch} from "@aztec/core/libraries/TimeLib.sol";
import {Hash} from "@aztec/core/libraries/crypto/Hash.sol";

/**
 * @notice Records sendL2Message calls and returns deterministic (key, index) pairs.
 * Selector-compatible with IInbox for the single function the bridge uses.
 */
contract MockInbox {
  struct SentMessage {
    bytes32 actor;
    uint256 version;
    bytes32 content;
    bytes32 secretHash;
  }

  SentMessage public lastMessage;
  uint256 public messagesSent;

  function sendL2Message(DataStructures.L2Actor memory _recipient, bytes32 _content, bytes32 _secretHash)
    external
    returns (bytes32, uint256)
  {
    lastMessage = SentMessage(_recipient.actor, _recipient.version, _content, _secretHash);
    messagesSent += 1;
    return (keccak256(abi.encode(_content, _secretHash, messagesSent)), messagesSent);
  }
}

/**
 * @notice Consumes L2->L1 messages: configurable validity, replay-protected by message hash.
 * Selector-compatible with IOutbox for the single function the bridge uses.
 */
contract MockOutbox {
  bool public shouldRevert;
  mapping(bytes32 messageHash => bool consumed) public consumed;

  function setShouldRevert(bool _shouldRevert) external {
    shouldRevert = _shouldRevert;
  }

  function consume(
    DataStructures.L2ToL1Msg calldata _message,
    Epoch,
    uint256,
    uint256,
    bytes32[] calldata
  ) external {
    require(!shouldRevert, "MockOutbox: invalid message");
    bytes32 messageHash = Hash.sha256ToField(_message);
    require(!consumed[messageHash], "MockOutbox: already consumed");
    consumed[messageHash] = true;
  }
}

/**
 * @notice Minimal rollup exposing the three getters the bridge's initialize uses.
 */
contract MockRollup {
  address public immutable INBOX;
  address public immutable OUTBOX;
  uint256 public immutable VERSION;

  constructor(address _inbox, address _outbox, uint256 _version) {
    INBOX = _inbox;
    OUTBOX = _outbox;
    VERSION = _version;
  }

  function getInbox() external view returns (address) {
    return INBOX;
  }

  function getOutbox() external view returns (address) {
    return OUTBOX;
  }

  function getVersion() external view returns (uint256) {
    return VERSION;
  }
}

/**
 * @notice Minimal registry pointing at a single canonical rollup.
 */
contract MockRegistry {
  address public immutable ROLLUP;

  constructor(address _rollup) {
    ROLLUP = _rollup;
  }

  function getCanonicalRollup() external view returns (address) {
    return ROLLUP;
  }
}
