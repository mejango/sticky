// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJBSucker} from "@bananapus/suckers-v6/src/interfaces/IJBSucker.sol";

/// @notice Separates a collector's reserved principal from delivery callers' fee receipts and source-chain native
/// refunds.
/// @dev Only the creating collector can submit. It authenticates the source route and fixes the original delivery
/// caller as beneficiary. Existing donations and forced native currency are excluded from each submission.
/// Asynchronous destination-chain refunds are neither attributed nor recovered by this child.
interface IStickySourceFeePayer {
    /// @notice The only collector authorized to select a route and refund beneficiary for this fee payer.
    /// @return collector The creating collector, fixed permanently at construction.
    function COLLECTOR() external view returns (address collector);

    /// @notice Submits the parent's prepared outbox and returns its fee tokens and source-chain native refunds.
    /// @dev Only the creating collector can call and must authenticate the route first. Native value covers the
    /// registry fee, with any excess supplied to the transport. A positive registry fee requires its project's ERC-20;
    /// a zero fee skips payment and can use a project without an ERC-20. LINK payment is not provided. This child
    /// rejects direct native refunds, causing supported suckers to retain them as source-chain credit; it claims that
    /// fresh credit directly to the beneficiary. Asynchronous destination refunds are neither attributed nor recovered
    /// by this child. A rejected token transfer, source-chain refund or credit postcondition reverts the parent's
    /// complete preparation and submission. The parent's send guard spans every callback.
    /// @param sucker The registered sucker authenticated by the parent for this submission.
    /// @param backingToken The mapped backing asset whose prepared outbox the parent is submitting.
    /// @param beneficiary The original caller of the parent's atomic send.
    /// @return feeTokenCount The fee-project tokens received during submission and returned, in fee-token decimals.
    /// @return refundedFee The failed registry fee retained on the source sucker and returned during this call, in wei.
    /// @return refundedTransportPayment The excess transport payment retained on the source sucker and returned during
    /// this call, in wei.
    function send(
        IJBSucker sucker,
        address backingToken,
        address payable beneficiary
    )
        external
        payable
        returns (uint256 feeTokenCount, uint256 refundedFee, uint256 refundedTransportPayment);
}
