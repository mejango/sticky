// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StickyDeployment} from "./helpers/StickyDeployment.sol";
import {StickyCoreDeployment} from "./structs/StickyCoreDeployment.sol";
import {StickyDeploymentAddresses} from "./structs/StickyDeploymentAddresses.sol";

/// @notice Verifies a deployed Sticky suite without sending transactions, and writes its live manifest.
contract Verify is StickyDeployment {
    /// @notice Checks every family's artifacts, predictions, bytecode and bindings against the connected RPC.
    function run() public {
        StickyCoreDeployment memory core = _loadCore();
        StickyDeploymentAddresses[4] memory deployed = _predictAll(core);
        // Validate the complete family set before publishing any live record.
        for (uint256 i; i < deployed.length; i++) {
            _verify({core: core, deployed: deployed[i]});
        }
        for (uint256 i; i < deployed.length; i++) {
            _writeManifest({core: core, deployed: deployed[i], kind: "verified"});
        }
    }
}
