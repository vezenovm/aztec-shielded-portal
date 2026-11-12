// SPDX-License-Identifier: MIT
pragma solidity >=0.8.27;

import {IInbox} from "@aztec/core/interfaces/messagebridge/IInbox.sol";
import {IOutbox} from "@aztec/core/interfaces/messagebridge/IOutbox.sol";

/**
 * @notice ABI-compatible slices of Aztec's IRegistry/IRollup with only the lookups the
 * bridge needs. Importing the real interfaces drags the full rollup library graph
 * (FeeLib/BlobLib/...) into the compilation unit, which a portal has no business compiling.
 * Function selectors and return ABIs match `IRegistry.getCanonicalRollup` and
 * `IRollup.{getInbox,getOutbox,getVersion}` at v6.0.0.
 */
interface IRollupLookup {
  function getInbox() external view returns (IInbox);
  function getOutbox() external view returns (IOutbox);
  function getVersion() external view returns (uint256);
}

interface IRegistryLookup {
  function getCanonicalRollup() external view returns (IRollupLookup);
}
