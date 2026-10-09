// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBMultiTerminal} from "@bananapus/core-v6/src/interfaces/IJBMultiTerminal.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";

/// @notice The core contracts a Sticky singleton deployment depends on.
/// @custom:member controller The controller used to launch projects.
/// @custom:member directory The directory shared by the controller and terminal.
/// @custom:member registry The canonical registry authenticating source reward routes.
/// @custom:member terminal The terminal receiving stakes.
// forge-lint: disable-next-line(pascal-case-struct)
struct StickyCoreDeployment {
    IJBController controller;
    IJBDirectory directory;
    IJBSuckerRegistry registry;
    IJBMultiTerminal terminal;
}
