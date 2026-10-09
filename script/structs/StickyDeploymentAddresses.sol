// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @notice Deterministic shared singleton addresses and one destination-bound collector family.
/// @custom:member destinationChainId The pool home chain permanently bound by the source collector.
/// @custom:member deployer The project factory.
/// @custom:member hook The factory's constructor-created accounting hook.
/// @custom:member distributor The shared reward distributor.
/// @custom:member rewardReceiver The reward receiver implementation the factory clones.
/// @custom:member rewardReceiverFactory The reward receiver factory.
/// @custom:member autoStick The opt-in compounding adapter.
/// @custom:member sourceCollector The shared reserved-token split hook.
/// @custom:member sourceFeePayer The collector's constructor-created fee custodian.
// forge-lint: disable-next-line(pascal-case-struct)
struct StickyDeploymentAddresses {
    uint256 destinationChainId;
    address deployer;
    address hook;
    address distributor;
    address rewardReceiver;
    address rewardReceiverFactory;
    address autoStick;
    address sourceCollector;
    address sourceFeePayer;
}
