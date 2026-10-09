// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";

import {IStickySourceCollector} from "../../src/interfaces/IStickySourceCollector.sol";

/// @notice Accepts a fee contribution while attempting to reenter its collector once.
contract StickySourceFeeTerminal {
    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The collector whose contribution operation is reentered.
    IStickySourceCollector public immutable COLLECTOR;

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The nested operation's revert data.
    bytes public reentryReason;

    /// @notice Whether the nested contribution unexpectedly succeeded.
    bool public reentrySucceeded;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Binds the collector that will be reentered during a contribution.
    /// @param collector The collector under test.
    constructor(IStickySourceCollector collector) {
        COLLECTOR = collector;
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Accepts a terminal contribution and records the collector's nested response.
    /// @param projectId The project receiving the contribution.
    /// @param token The terminal token contributed.
    /// @param amount The amount recorded for the project.
    /// @param shouldReturnHeldFees Whether the contribution requests held fees.
    /// @param memo The contribution's memo.
    /// @param metadata The contribution's metadata.
    function addToBalanceOf(
        uint256 projectId,
        address token,
        uint256 amount,
        bool shouldReturnHeldFees,
        string calldata memo,
        bytes calldata metadata
    )
        external
        payable
    {
        // Reenter only after proving the outer call has no caller-controlled contribution field.
        assert(
            projectId == JBConstants.FEE_BENEFICIARY_PROJECT_ID && token == JBConstants.NATIVE_TOKEN
                && amount == msg.value && !shouldReturnHeldFees && bytes(memo).length == 0 && metadata.length == 0
        );

        // Catch the nested failure so the outer fixed contribution can still complete.
        // forge-lint: disable-next-line(low-level-calls)
        (reentrySucceeded, reentryReason) =
            address(COLLECTOR).call(abi.encodeCall(IStickySourceCollector.addFeeRefundToBalance, ()));
    }
}
