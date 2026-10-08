// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Pulls real receiver balances into separately observed reward destinations for source-delivery tests.
/// @dev The fixture accepts only the two groups used by its tests; production group validation belongs to Sticky.
contract StickySourceDistributor {
    /// @notice Thrown when the scenario rejects destination settlement.
    error StickySourceDistributor_Rejected();

    /// @notice Rewards actually pulled for each holder pool, group and reward token.
    /// @custom:param stickyToken The rewarded holder pool.
    /// @custom:param groupId The reward group.
    /// @custom:param token The reward ERC-20.
    mapping(address stickyToken => mapping(uint256 groupId => mapping(IERC20 token => uint256 amount))) public fundedOf;

    /// @notice Whether funding should fail atomically.
    bool public rejectFunding;

    /// @notice Pulls rewards approved by the real receiver into this observed reward ledger.
    /// @param hook The rewarded holder pool.
    /// @param token The reward ERC-20.
    /// @param amount The exact amount to pull.
    /// @param groupId The reward group.
    function fund(address hook, IERC20 token, uint256 amount, uint256 groupId) external {
        if (rejectFunding) revert StickySourceDistributor_Rejected();
        SafeERC20.safeTransferFrom({token: token, from: msg.sender, to: address(this), value: amount});
        fundedOf[hook][groupId][token] += amount;
    }

    /// @notice Chooses whether receiver settlement rejects its transfer.
    /// @param reject Whether funding should revert.
    function setRejectFunding(bool reject) external {
        rejectFunding = reject;
    }

    /// @notice Reports the explicit fixture whitelist used by the real receiver factory.
    /// @param groupId The reward group being queried.
    /// @return valid Whether the group belongs to this fixture's whitelist.
    function isValidGroupId(uint256 groupId) external pure returns (bool valid) {
        return groupId == 0 || groupId == 4000;
    }
}
