// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Executes delivery as a contract caller and observes refund rejection or reentrancy.
contract StickySourceCaller {
    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when the scenario refuses its native refund.
    error StickySourceCaller_RejectRefund();

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The nested operation's return or revert data.
    bytes public reentryReason;

    /// @notice Whether the refund callback's nested operation succeeded.
    bool public reentrySucceeded;

    /// @notice Native refunds accepted in committed state.
    uint256 public refunded;

    /// @notice Whether native refunds should revert.
    bool public rejectRefund;

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice The optional nested call's calldata.
    bytes internal _data;

    /// @notice The optional contract called during the next refund.
    address internal _target;

    //*********************************************************************//
    // ------------------------- receive / fallback ---------------------- //
    //*********************************************************************//

    /// @notice Accepts, rejects or attempts a nested operation during refund delivery.
    receive() external payable {
        if (rejectRefund) revert StickySourceCaller_RejectRefund();
        refunded += msg.value;
        if (_target != address(0)) {
            address target = _target;
            _target = address(0);
            // Disarm before calling so an absent guard cannot recurse without bound.
            // forge-lint: disable-next-line(low-level-calls)
            (reentrySucceeded, reentryReason) = target.call(_data);
        }
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Configures the next refund's behavior.
    /// @param reject Whether to reject native currency.
    /// @param target The nested operation's target, or zero for no callback.
    /// @param data The nested calldata.
    function configure(bool reject, address target, bytes calldata data) external {
        rejectRefund = reject;
        _target = target;
        _data = data;
    }

    /// @notice Calls a delivery operation as this contract and preserves its exact revert data.
    /// @param target The contract to call.
    /// @param data The delivery calldata.
    /// @return result The operation's return data.
    function execute(address target, bytes calldata data) external payable returns (bytes memory result) {
        // The fixture deliberately exposes its caller identity to the tested refund path.
        // forge-lint: disable-next-line(low-level-calls,arbitrary-send-eth)
        (bool success, bytes memory returned) = target.call{value: msg.value}(data);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(returned, 32), mload(returned))
            }
        }
        return returned;
    }
}
