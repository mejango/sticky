// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StickyDeployment} from "./helpers/StickyDeployment.sol";
import {StickyCoreDeployment} from "./structs/StickyCoreDeployment.sol";
import {StickyDeploymentAddresses} from "./structs/StickyDeploymentAddresses.sol";

/// @notice Runs the production deployment helper twice in a fork simulation, without broadcasting.
contract Rehearse is StickyDeployment {
    /// @notice Exercises fresh/partial deployment or verified reuse for every home, then repeats each one.
    function run() public {
        StickyCoreDeployment memory core = _loadCore();
        _deployAll(core);
        StickyDeploymentAddresses[4] memory deployed = _deployAll(core);
        for (uint256 i; i < deployed.length; i++) {
            _writeManifest({core: core, deployed: deployed[i], kind: "simulation"});
        }
    }
}
