// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBToken} from "@bananapus/core-v6/src/interfaces/IJBToken.sol";

import {StickySourceToken} from "./StickySourceToken.sol";

/// @notice A project-token registry that preserves real credit debits and ERC-20 minting during claims.
/// @dev Explicit fixture setters establish project bindings; claims require the bound controller.
contract StickySourceTokens {
    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when a claim exceeds the holder's recorded credits.
    /// @param holder The account whose credits were requested.
    /// @param projectId The project whose credits were requested.
    /// @param count The requested number of credits.
    /// @param available The holder's recorded credits.
    error StickySourceTokens_InsufficientCredits(address holder, uint256 projectId, uint256 count, uint256 available);

    /// @notice Thrown when credits cannot be materialized because the project has no ERC-20 token.
    /// @param projectId The project whose token is missing.
    error StickySourceTokens_TokenNotFound(uint256 projectId);

    /// @notice Thrown when an account other than the project's bound controller attempts to claim credits.
    /// @param projectId The project whose credits were requested.
    /// @param caller The account attempting the claim.
    /// @param controller The project's authorized controller.
    error StickySourceTokens_Unauthorized(uint256 projectId, address caller, address controller);

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The controller authorized to materialize each project's credits.
    /// @custom:param projectId The project whose controller is stored.
    mapping(uint256 projectId => address controller) public controllerOf;

    /// @notice Each holder's unclaimed project-token credits.
    /// @custom:param holder The credit holder.
    /// @custom:param projectId The project that issued the credits.
    mapping(address holder => mapping(uint256 projectId => uint256 balance)) public creditBalanceOf;

    /// @notice The ERC-20 token attached to each project, or zero before token deployment.
    /// @custom:param projectId The project whose token is stored.
    mapping(uint256 projectId => IJBToken token) public tokenOf;

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Debits the holder's credits and mints the same number of ERC-20 token atoms to the beneficiary.
    /// @dev Authorization mirrors the token registry boundary; holder consent is enforced by the controller.
    /// @param holder The owner of the credits being converted.
    /// @param projectId The project whose credits are converted.
    /// @param count The number of credits to materialize.
    /// @param beneficiary The account receiving the minted token atoms.
    function claimTokensFor(address holder, uint256 projectId, uint256 count, address beneficiary) external {
        address controller = controllerOf[projectId];
        if (msg.sender != controller) {
            revert StickySourceTokens_Unauthorized({projectId: projectId, caller: msg.sender, controller: controller});
        }

        IJBToken token = tokenOf[projectId];
        if (address(token) == address(0)) revert StickySourceTokens_TokenNotFound(projectId);
        uint256 available = creditBalanceOf[holder][projectId];
        if (count > available) {
            revert StickySourceTokens_InsufficientCredits({
                holder: holder, projectId: projectId, count: count, available: available
            });
        }

        // Debit before minting so an external token call cannot reuse the same credits.
        creditBalanceOf[holder][projectId] = available - count;
        StickySourceToken(address(token)).mint({account: beneficiary, amount: count});
    }

    /// @notice Adds project-token credits to a holder as an explicit test issuance.
    /// @param holder The holder receiving the credits.
    /// @param projectId The project issuing the credits.
    /// @param amount The number of credits to add.
    function seedCredit(address holder, uint256 projectId, uint256 amount) external {
        creditBalanceOf[holder][projectId] += amount;
    }

    /// @notice Binds a project's controller for token-claim authorization.
    /// @param projectId The project whose controller is set.
    /// @param controller The authorized controller, or zero to remove its authorization.
    function setController(uint256 projectId, address controller) external {
        controllerOf[projectId] = controller;
    }

    /// @notice Attaches or removes a project's ERC-20 token for the test scenario.
    /// @param projectId The project whose token is set.
    /// @param token The attached ERC-20 address, or zero for a credits-only project.
    function setToken(uint256 projectId, address token) external {
        tokenOf[projectId] = IJBToken(token);
    }

    //*********************************************************************//
    // ------------------------- external views -------------------------- //
    //*********************************************************************//

    /// @notice Returns the holder's combined credits and actual attached-token balance.
    /// @param holder The account whose total custody is queried.
    /// @param projectId The project whose custody is queried.
    /// @return balance The holder's credits plus ERC-20 token atoms.
    function totalBalanceOf(address holder, uint256 projectId) external view returns (uint256 balance) {
        balance = creditBalanceOf[holder][projectId];
        IJBToken token = tokenOf[projectId];
        if (address(token) != address(0)) balance += token.balanceOf(holder);
    }
}
