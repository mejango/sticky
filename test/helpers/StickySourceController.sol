// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {JBSplitHookContext} from "@bananapus/core-v6/src/structs/JBSplitHookContext.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {StickySourceToken} from "./StickySourceToken.sol";
import {StickySourceTokens} from "./StickySourceTokens.sol";

/// @notice A controller fixture that issues reserved tokens and preserves split-hook failure and burn semantics.
/// @dev ERC-20 reserves are approved before the callback; credits arrive before it. Only unconsumed ERC-20s burn.
contract StickySourceController {
    // Use token-safe approvals while keeping real balances and allowances observable.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when a caller attempts to materialize another holder's credits.
    /// @param caller The account requesting the claim.
    /// @param holder The owner whose consent is required.
    error StickySourceController_Unauthorized(address caller, address holder);

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The registry that records credits and materializes project tokens.
    StickySourceTokens public immutable TOKENS;

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The number of distribution callbacks that returned successfully.
    uint256 public acceptedCallbacks;

    /// @notice The total unconsumed ERC-20 token atoms burned after distribution callbacks.
    uint256 public burned;

    /// @notice The number of distribution callbacks whose failures were caught.
    uint256 public rejectedCallbacks;

    /// @notice The revert data of the most recent distribution callback, cleared before each attempt.
    bytes public rejectionReason;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Binds the stateful token registry used for credit issuance and claims.
    /// @param tokens The registry used by the collector under test.
    constructor(StickySourceTokens tokens) {
        TOKENS = tokens;
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Converts the calling holder's credits into real project tokens.
    /// @dev This fixture models holder consent; delegated operator permissions are outside its custody scope.
    /// @param holder The owner of the credits being claimed.
    /// @param projectId The project whose credits are claimed.
    /// @param tokenCount The number of credits converted into token atoms.
    /// @param beneficiary The account receiving the resulting project tokens.
    function claimTokensFor(address holder, uint256 projectId, uint256 tokenCount, address beneficiary) external {
        if (msg.sender != holder) {
            revert StickySourceController_Unauthorized({caller: msg.sender, holder: holder});
        }
        TOKENS.claimTokensFor({holder: holder, projectId: projectId, count: tokenCount, beneficiary: beneficiary});
    }

    /// @notice Calls a split hook with the controller's identity without issuing new custody.
    /// @dev Reverts are surfaced so authentication and unsupported-native-value checks can be asserted directly.
    /// @param context The exact callback context passed to the hook.
    function dispatch(JBSplitHookContext calldata context) external payable {
        context.split.hook.processSplitWith{value: msg.value}(context);
    }

    /// @notice Issues one reserve allocation and invokes its hook, catching rejection before burning unused tokens.
    /// @dev A rejected credits callback leaves the already-transferred credits in the hook's custody.
    /// @param context The token, amount and split destination for this reserve allocation.
    function distribute(JBSplitHookContext calldata context) external {
        if (context.token == address(0)) {
            // Credits have no allowance: the core transfers the full allocation before calling the hook.
            TOKENS.seedCredit({
                holder: address(context.split.hook), projectId: context.projectId, amount: context.amount
            });
        } else {
            // Issue real tokens to the controller so hook rejection leaves an observable supply burn.
            StickySourceToken(context.token).mint({account: address(this), amount: context.amount});
            IERC20(context.token).forceApprove({spender: address(context.split.hook), value: context.amount});
        }

        // The controller preserves the outer distribution even when a hook rejects its allocation.
        delete rejectionReason;
        try context.split.hook.processSplitWith(context) {
            acceptedCallbacks++;
        } catch (bytes memory reason) {
            rejectedCallbacks++;
            rejectionReason = reason;
        }

        if (context.token != address(0)) {
            uint256 remaining =
                IERC20(context.token).allowance({owner: address(this), spender: address(context.split.hook)});
            if (remaining != 0) {
                // Zero the spend permission before destroying reserves the hook did not consume.
                IERC20(context.token).forceApprove({spender: address(context.split.hook), value: 0});
                StickySourceToken(context.token).burn({account: address(this), amount: remaining});
                burned += remaining;
            }
        }
    }
}
