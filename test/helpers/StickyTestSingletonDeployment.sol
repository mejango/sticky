// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {ERC2771Context} from "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import {Vm} from "forge-std/Vm.sol";

import {StickyDeployer} from "../../src/StickyDeployer.sol";
import {StickyHook} from "../../src/StickyHook.sol";
import {StickySourceCollector} from "../../src/StickySourceCollector.sol";
import {StickySourceFeePayer} from "../../src/StickySourceFeePayer.sol";
import {IStickyHook} from "../../src/interfaces/IStickyHook.sol";
import {IStickyRewardReceiverFactory} from "../../src/interfaces/IStickyRewardReceiverFactory.sol";
import {IStickySourceFeePayer} from "../../src/interfaces/IStickySourceFeePayer.sol";

/// @notice Deploys fixture singletons explicitly while preserving permanently fixed reciprocal authorization.
library StickyTestSingletonDeployment {
    /// @notice The standard Foundry cheatcode endpoint used to establish reciprocal mock fixtures.
    Vm internal constant _VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Establishes the complete reciprocal parent boundary for isolated hook accounting fixtures.
    /// @param hook The unbound hook controlled by this fixture.
    /// @param parent The mock parent authorized to register fixture tokens.
    function bindMockHookParent(StickyHook hook, address parent) internal {
        if (parent.code.length == 0) _VM.etch(parent, hex"00");
        _VM.mockCall(parent, abi.encodeWithSignature("HOOK()"), abi.encode(address(hook)));
        _VM.mockCall(parent, abi.encodeWithSignature("CONTROLLER()"), abi.encode(address(hook)));
        _VM.mockCall(parent, abi.encodeWithSignature("trustedForwarder()"), abi.encode(hook.trustedForwarder()));
        hook.setDeployer(parent);
    }

    /// @notice Deploys the hook followed immediately by its bound deployer.
    /// @param controller The fixture controller.
    /// @param terminal The fixture terminal.
    /// @return deployer The newly deployed Sticky factory.
    function deployDeployer(IJBController controller, IJBTerminal terminal) internal returns (StickyDeployer deployer) {
        IStickyHook hook = prepareHook(controller);
        deployer = new StickyDeployer({controller: controller, terminal: terminal, hook: hook});
        hook.setDeployer(address(deployer));
    }

    /// @notice Deploys an unbound hook whose one-time authority is this fixture.
    /// @param controller The fixture controller defining the directory and trusted forwarder.
    /// @return hook The prepared hook; bind it after deploying its parent.
    function prepareHook(IJBController controller) internal returns (IStickyHook hook) {
        return new StickyHook({
            directory: controller.DIRECTORY(),
            deploymentAuthority: address(this),
            trustedForwarder: ERC2771Context(address(controller)).trustedForwarder()
        });
    }

    /// @notice Deploys the fee payer followed immediately by its bound collector.
    /// @param registry The fixture sucker registry.
    /// @param tokens The fixture project token registry.
    /// @param receiverFactory The fixture destination receiver factory.
    /// @param destinationChainId The collector's immutable destination chain.
    /// @return collector The newly deployed collector.
    function deployCollector(
        IJBSuckerRegistry registry,
        IJBTokens tokens,
        IStickyRewardReceiverFactory receiverFactory,
        uint256 destinationChainId
    )
        internal
        returns (StickySourceCollector collector)
    {
        IStickySourceFeePayer feePayer = prepareFeePayer();
        collector = new StickySourceCollector({
            registry: registry,
            tokens: tokens,
            receiverFactory: receiverFactory,
            destinationChainId: destinationChainId,
            feePayer: feePayer
        });
        feePayer.setCollector(address(collector));
    }

    /// @notice Deploys an unbound fee payer whose one-time authority is this fixture.
    /// @return feePayer The prepared payer; bind it after deploying its parent.
    function prepareFeePayer() internal returns (IStickySourceFeePayer feePayer) {
        return new StickySourceFeePayer({deploymentAuthority: address(this)});
    }
}
