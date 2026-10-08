// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A mintable project token with a one-shot transfer callback and a bounded transfer burn.
/// @dev Balances, allowances and supply use the ERC-20 implementation so failed callbacks roll back real custody.
contract StickySourceToken is ERC20 {
    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when the configured callback fails and this token is configured to reject that failure.
    /// @param target The contract whose callback failed.
    /// @param reason The callback's revert data.
    error StickySourceToken_CallbackFailed(address target, bytes reason);

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The number of transfer callbacks attempted in committed state.
    uint256 public callbackCount;

    /// @notice Whether the next transfer should execute the configured callback.
    bool public callbackEnabled;

    /// @notice The return or revert data produced by the most recent callback.
    bytes public callbackReason;

    /// @notice Whether the most recent callback completed successfully.
    bool public callbackSucceeded;

    /// @notice The token atoms burned per transfer, capped to that transfer's amount.
    uint256 public transferFee;

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice The calldata executed before the next transfer moves tokens.
    bytes internal _callbackData;

    /// @notice The contract called before the next transfer moves tokens.
    address internal _callbackTarget;

    /// @notice Whether a failed callback reverts the enclosing token transfer.
    bool internal _rejectOnFailure;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Initializes an 18-decimal project token with no transfer fee or armed callback.
    constructor() ERC20("Source token", "SOURCE") {}

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Removes real tokens from a participant's balance and the total supply.
    /// @param account The account whose tokens are burned.
    /// @param amount The number of token atoms to burn.
    function burn(address account, uint256 amount) external {
        _burn({account: account, value: amount});
    }

    /// @notice Creates real tokens for a participant.
    /// @param account The account receiving the tokens.
    /// @param amount The number of token atoms to mint.
    function mint(address account, uint256 amount) external {
        _mint({account: account, value: amount});
    }

    /// @notice Arms one callback before the next transfer moves tokens.
    /// @dev Minting and burning do not trigger it. Callback failure can be observed without aborting the transfer.
    /// @param target The contract to call; a zero address disarms the callback.
    /// @param data The calldata passed to the target.
    /// @param rejectOnFailure Whether a callback failure should revert the token transfer.
    function setTransferCallback(address target, bytes calldata data, bool rejectOnFailure) external {
        _callbackTarget = target;
        _callbackData = data;
        _rejectOnFailure = rejectOnFailure;
        callbackEnabled = target != address(0);
        callbackSucceeded = false;
        delete callbackReason;
    }

    /// @notice Sets the fixed number of token atoms burned during each transfer.
    /// @param amount The burn amount, capped to each transfer's amount when applied.
    function setTransferFee(uint256 amount) external {
        transferFee = amount;
    }

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Executes the transfer callback and burn without affecting mint or explicit burn operations.
    /// @dev The ERC-20 spends transferFrom allowance before reaching this hook. Nested distributions can therefore
    /// establish and consume their own allowance without interfering with the enclosing transfer's approval.
    /// @param from The holder debited, or zero when minting.
    /// @param to The recipient credited, or zero when burning.
    /// @param value The full amount debited from the holder.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && callbackEnabled) {
            // Consume the callback before calling out so a nested transfer cannot replay it.
            callbackEnabled = false;
            callbackCount++;
            // The fixture deliberately permits arbitrary callback behavior to exercise custody guards.
            // forge-lint: disable-next-line(low-level-calls)
            (bool success, bytes memory reason) = _callbackTarget.call(_callbackData);
            callbackSucceeded = success;
            callbackReason = reason;
            if (!success && _rejectOnFailure) {
                revert StickySourceToken_CallbackFailed({target: _callbackTarget, reason: reason});
            }
        }

        if (from != address(0) && to != address(0) && transferFee != 0) {
            // Charge no more than the transfer amount so the receiver can legitimately receive zero.
            uint256 fee = transferFee > value ? value : transferFee;
            super._update({from: from, to: address(0), value: fee});
            super._update({from: from, to: to, value: value - fee});
        } else {
            super._update({from: from, to: to, value: value});
        }
    }
}
