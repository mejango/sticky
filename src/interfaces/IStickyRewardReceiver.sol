// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IStickyDistributor} from "./IStickyDistributor.sol";

/// @notice Holds ERC-20 reward arrivals for one Sticky share token and group until anyone settles the full balance.
/// @dev The factory initializes each clone atomically. The receiver has no withdrawal or destination-change method.
/// Settlement time selects the reward round; project-token credits and native currency cannot be settled.
interface IStickyRewardReceiver {
    /// @notice The immutable distributor rewards are settled into, shared by every clone of this implementation.
    /// @return distributor The rewards distributor.
    function DISTRIBUTOR() external view returns (IStickyDistributor distributor);

    /// @notice The reward group each settlement funds.
    /// @return group The configured group, with zero selecting the default balance-snapshot group.
    function groupId() external view returns (uint256 group);

    /// @notice The Sticky share token whose holders this receiver rewards.
    /// @return token The configured share token; zero only on a clone awaiting initialization.
    function stickyToken() external view returns (address token);

    /// @notice Fixes a clone's sticky token and reward group.
    /// @dev Callable once. The factory initializes each clone in the call that deploys it, so no one else can.
    /// @param initialStickyToken The sticky token whose holders this receiver rewards.
    /// @param initialGroupId The reward group settlements fund; the factory only creates receivers for groups the
    /// distributor accepts.
    function initialize(address initialStickyToken, uint256 initialGroupId) external;

    /// @notice Settles this receiver's full balance of a token into the distributor as rewards for the sticky
    /// token's holders in the receiver's group.
    /// @dev Anyone can settle. The settlement time selects the distributor round, whose snapshot determines reward
    /// eligibility; the receiver does not reserve rewards for holders present when tokens arrive.
    /// @param token The reward token to settle.
    /// @return amount The amount settled.
    function settle(IERC20 token) external returns (uint256 amount);
}
