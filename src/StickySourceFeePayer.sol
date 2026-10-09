// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {IJBSucker} from "@bananapus/suckers-v6/src/interfaces/IJBSucker.sol";
import {IJBSuckerExtended} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerExtended.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IStickySourceFeePayer} from "./interfaces/IStickySourceFeePayer.sol";

/// @notice Pays a collector's bridge fees separately from its reserved reward principal and returns each caller's
/// fee tokens and source-chain native refunds.
/// @dev Only the creating collector can operate this child, and it authenticates the sucker and backing-token route
/// before submission. Fee-project tokens received during submission belong to that submission's caller; the balance
/// delta includes any tokens donated during the same call and does not authenticate their mint provenance. Preexisting
/// token donations and forced native currency remain here. This child has no allowance over parent tokens, native
/// receive handler, owner, general rescue operation or arbitrary-call entrypoint and must never receive reserved
/// splits. Its creating collector can contribute the full native balance to the protocol fee project when a
/// destination refund or forced transfer cannot be attributed to a delivery caller.
contract StickySourceFeePayer is IStickySourceFeePayer {
    // A library that safely returns the fee tokens received during this submission.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when submission reduces the fee-token balance, so a caller cannot consume a preexisting donation.
    /// @param feeToken The fee-project ERC-20 whose balance decreased.
    /// @param beforeBalance The fee-token balance before submission, in fee-token decimals.
    /// @param afterBalance The fee-token balance after submission, in fee-token decimals.
    error StickySourceFeePayer_DecreasedBalance(address feeToken, uint256 beforeBalance, uint256 afterBalance);

    /// @notice Thrown when the supplied native value does not cover the registry fee, so submission cannot draw on
    /// forced native currency or another caller's payment.
    /// @param received The value supplied by the parent, in wei.
    /// @param minimum The registry's current fee, in wei, before any required transport payment.
    error StickySourceFeePayer_InsufficientFee(uint256 received, uint256 minimum);

    /// @notice Thrown when a positive registry fee would pay a project without a deployed ERC-20, so fee receipts
    /// cannot become untracked project credits held by this child.
    /// @param sucker The route whose fee-project token was checked.
    /// @param feeProjectId The sucker's fee project.
    /// @param feeToken The address returned by the sucker's token registry.
    error StickySourceFeePayer_InvalidFeeToken(address sucker, uint256 feeProjectId, address feeToken);

    /// @notice Thrown when source-chain registry-fee credit exists before submission or remains after refunding, so one
    /// caller cannot receive another payment and each failed fee is fully returned.
    /// @param sucker The route holding the unexpected credit for this child.
    /// @param amount The unexpected retained registry fee, in wei.
    error StickySourceFeePayer_RetainedFee(address sucker, uint256 amount);

    /// @notice Thrown when source-chain transport-refund credit exists before submission or remains after refunding, so
    /// one caller cannot receive another transport payment and each retained source-chain refund is fully returned.
    /// @param sucker The route holding the unexpected credit for this child.
    /// @param amount The unexpected retained transport refund, in wei.
    error StickySourceFeePayer_RetainedTransportPayment(address sucker, uint256 amount);

    /// @notice Thrown when an address other than the fixed collector attempts a child operation, so route selection,
    /// refund attribution and stranded-balance policy remain in the parent.
    /// @param caller The unauthorized caller.
    error StickySourceFeePayer_Unauthorized(address caller);

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The only account allowed to operate this child.
    /// @dev Fixed to the deploying collector, which authenticates each route and caller refund beneficiary and resolves
    /// the fixed contribution policy's current terminal.
    address public immutable override COLLECTOR;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Gives the creating collector exclusive access to submission and fixed project-1 contributions.
    /// @dev The collector creates this child atomically and controls both typed operation entrypoints permanently.
    constructor() {
        // Keep route selection and refund attribution inside the creating collector's guarded operation.
        COLLECTOR = msg.sender;
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Contributes this child's full raw-address native balance through the fee project's current primary
    /// native terminal.
    /// @dev Only the creating collector can call and resolves the terminal from its canonical directory. This child
    /// fixes the project, native token and held-fee behavior. Terminal failure reverts the transfer and leaves the
    /// complete balance available for another attempt. A zero balance is a no-op. An Arbitrum safe-Inbox alias is
    /// outside this balance.
    /// @param terminal The protocol fee project's current primary native terminal.
    /// @return amount The native balance contributed, in wei.
    function addFeeRefundToBalance(IJBTerminal terminal) external override returns (uint256 amount) {
        // Terminal choice must come from the parent, which resolves it through the canonical directory.
        if (msg.sender != COLLECTOR) revert StickySourceFeePayer_Unauthorized({caller: msg.sender});

        // Include every unattributed native credit and forced transfer without adding a second accounting ledger.
        amount = address(this).balance;
        // An exact zero is the only balance that cannot fund a contribution.
        // forge-lint: disable-next-item(incorrect-strict-equality)
        // slither-disable-next-line incorrect-equality
        if (amount == 0) return 0;

        // This is a contribution, not a payment: no project tokens are minted and no held fees are returned.
        terminal.addToBalanceOf{value: amount}({
            projectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID,
            token: JBConstants.NATIVE_TOKEN,
            amount: amount,
            shouldReturnHeldFees: false,
            memo: "",
            metadata: ""
        });
    }

    /// @notice Submits the parent's prepared outbox and returns its fee tokens and source-chain native refunds.
    /// @dev Only the creating collector can call and must authenticate the route first. Native value covers the
    /// registry fee, with any excess supplied to the transport. A positive registry fee requires its project's ERC-20;
    /// a zero fee skips payment and can use a project without an ERC-20. LINK payment is not provided. This child
    /// rejects direct native refunds, causing supported suckers to retain them as source-chain credit; it claims that
    /// fresh credit directly to the beneficiary. This call does not attribute or return an asynchronous destination
    /// refund. A matching destination-family collector can separately contribute a raw native balance to the protocol
    /// fee project; aliased gateway balances remain outside this child. A rejected token transfer, source-chain refund
    /// or credit postcondition reverts the parent's complete preparation and submission. The parent's send guard spans
    /// every callback.
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
        override
        returns (uint256 feeTokenCount, uint256 refundedFee, uint256 refundedTransportPayment)
    {
        // Route selection and its beneficiary must come from the parent's guarded send.
        if (msg.sender != COLLECTOR) revert StickySourceFeePayer_Unauthorized({caller: msg.sender});

        // The installed interfaces omit the registry getter; forced native balances cannot subsidize caller fees.
        uint256 fee = JBSucker(payable(address(sucker))).REGISTRY().toRemoteFee();
        if (msg.value < fee) revert StickySourceFeePayer_InsufficientFee({received: msg.value, minimum: fee});

        // Resolve the receipt asset through the authenticated route instead of sharing principal custody.
        uint256 feeProjectId = JBSucker(payable(address(sucker))).FEE_PROJECT_ID();
        IERC20 feeToken = IERC20(address(sucker.TOKENS().tokenOf(feeProjectId)));
        bool hasFeeToken = address(feeToken).code.length != 0;
        if (fee != 0 && !hasFeeToken) {
            revert StickySourceFeePayer_InvalidFeeToken({
                sucker: address(sucker), feeProjectId: feeProjectId, feeToken: address(feeToken)
            });
        }

        // Neither source-chain refund ledger may carry a prior caller's payment into this submission.
        _requireNoRetainedCredit(sucker);

        // Exclude preexisting donations when receipts are possible; a zero fee needs no ERC-20 to submit transport.
        uint256 beforeBalance = hasFeeToken ? feeToken.balanceOf(address(this)) : 0;

        // Forward only this call's value; the sucker owns fee processing and the selected asset's transport.
        sucker.toRemote{value: msg.value}(backingToken);

        // Only a deployed fee token can have a measured receipt or donation balance.
        if (hasFeeToken) {
            // Preserve donated inventory even when a route or fee token reports an unexpected debit.
            uint256 afterBalance = feeToken.balanceOf(address(this));
            if (afterBalance < beforeBalance) {
                revert StickySourceFeePayer_DecreasedBalance({
                    feeToken: address(feeToken), beforeBalance: beforeBalance, afterBalance: afterBalance
                });
            }

            // Parent reserve allocations remain outside this address, even when they use the fee project's token.
            feeTokenCount = afterBalance - beforeBalance;
            if (feeTokenCount != 0) feeToken.safeTransfer({to: beneficiary, value: feeTokenCount});
        }

        // Return a failed registry payment directly from the sucker without opening native custody here.
        refundedFee = IJBSuckerExtended(address(sucker)).retainedToRemoteFeeOf(address(this));
        if (refundedFee != 0) IJBSuckerExtended(address(sucker)).claimRetainedToRemoteFee(beneficiary);

        // A rejected source-chain transport refund is separate credit, payable only to this submission's caller.
        refundedTransportPayment = IJBSuckerExtended(address(sucker)).retainedTransportPaymentRefundOf(address(this));
        if (refundedTransportPayment != 0) {
            IJBSuckerExtended(address(sucker)).claimRetainedTransportPaymentRefund(beneficiary);
        }

        // Both claims must finish completely so another submission cannot inherit any of this caller's credit.
        _requireNoRetainedCredit(sucker);
    }

    //*********************************************************************//
    // -------------------------- internal views ------------------------- //
    //*********************************************************************//

    /// @notice Requires both source-chain caller-scoped native refund ledgers to be empty for this child.
    /// @dev Checking before submission isolates callers; checking after both claims rejects partial refunds or
    /// credit introduced during a refund callback.
    /// @param sucker The authenticated route whose refund balances are checked.
    function _requireNoRetainedCredit(IJBSucker sucker) internal view {
        // A registry-fee credit must belong entirely to one atomic submission and refund.
        uint256 retained = IJBSuckerExtended(address(sucker)).retainedToRemoteFeeOf(address(this));
        if (retained != 0) revert StickySourceFeePayer_RetainedFee({sucker: address(sucker), amount: retained});

        // Transport overpayments have a separate ledger and the same per-submission ownership boundary.
        retained = IJBSuckerExtended(address(sucker)).retainedTransportPaymentRefundOf(address(this));
        if (retained != 0) {
            revert StickySourceFeePayer_RetainedTransportPayment({sucker: address(sucker), amount: retained});
        }
    }
}
