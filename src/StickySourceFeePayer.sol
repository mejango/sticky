// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Pays one collector's bridge fee without receiving its reserved reward principal.
/// @dev Only the fixed parent can submit. Fee-project tokens received during submission and failed-payment refunds
/// belong to the parent's current caller; preexisting child token donations are excluded. This child must never be
/// configured as a reserved-split beneficiary. It has no allowance over parent tokens, arbitrary-call entry or
/// rescue operation. Its collector creates it with the validated source sucker and corresponding fee-project token.
contract StickySourceFeePayer {
    // A library that safely returns only this submission's fee-payment receipt tokens.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when submission reduces the fee-token balance, so a caller cannot consume a preexisting donation.
    /// @param beforeBalance The fee-token balance before submission, in fee-token decimals.
    /// @param afterBalance The fee-token balance after submission, in fee-token decimals.
    error StickySourceFeePayer_DecreasedBalance(uint256 beforeBalance, uint256 afterBalance);

    /// @notice Thrown when the supplied native value differs from the current registry fee, so submission neither
    /// borrows native currency nor leaves an excess balance here.
    /// @param received The value supplied by the parent, in wei.
    /// @param expected The registry's current fee, in wei.
    error StickySourceFeePayer_IncorrectFee(uint256 received, uint256 expected);

    /// @notice Thrown when retained fee credit exists before submission or remains after claiming, so each caller can
    /// receive only the failed fee payment from their own send and it is fully returned.
    /// @param amount The unexpected retained credit, in wei.
    error StickySourceFeePayer_RetainedFee(uint256 amount);

    /// @notice Thrown when an address other than the fixed collector attempts to submit, so fee receipts remain part
    /// of the parent's guarded prepare-and-submit operation.
    /// @param caller The unauthorized caller.
    error StickySourceFeePayer_Unauthorized(address caller);

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The only account allowed to submit through this child.
    /// @dev Fixed to the deploying parent, which supplies the same send caller as the refund beneficiary.
    address public immutable COLLECTOR;

    /// @notice The fee project's ERC-20 derived by the collector from its fixed sucker.
    IERC20 public immutable FEE_TOKEN;

    /// @notice The only sucker this child can call or pay.
    JBSucker public immutable SUCKER;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Binds fee submission to the creating collector and its fixed source route.
    /// @dev The parent validates the route and token before creating this child; this constructor stores that pair.
    /// @param sucker The parent's registered native source sucker.
    /// @param feeToken The sucker's fee-project ERC-20.
    constructor(JBSucker sucker, IERC20 feeToken) {
        // Give only the creating collector access and fix the contracts used for every fee payment.
        COLLECTOR = msg.sender;
        FEE_TOKEN = feeToken;
        SUCKER = sucker;
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Submits the parent's prepared native outbox and returns this caller's fee receipt or refund.
    /// @dev Only the creating collector can call. Native refunds go directly from the sucker to the beneficiary.
    /// Rejection reverts the parent's complete send, leaving another caller free to retry. Preexisting token donations
    /// and any forced native balance remain here; only this call's token increase and retained fee credit are returned.
    /// @param beneficiary The original caller of the parent's atomic send.
    /// @return feeTokenCount The fee-project tokens received during submission and returned, in fee-token decimals.
    /// @return refundedFee The failed fee payment retained during submission and returned, in wei.
    function send(address payable beneficiary) external payable returns (uint256 feeTokenCount, uint256 refundedFee) {
        // Submission and its beneficiary must come from the parent's guarded send.
        if (msg.sender != COLLECTOR) revert StickySourceFeePayer_Unauthorized({caller: msg.sender});

        // Forward exactly the current fee without drawing on, or adding to, any forced native balance.
        uint256 fee = SUCKER.REGISTRY().toRemoteFee();
        if (msg.value != fee) revert StickySourceFeePayer_IncorrectFee({received: msg.value, expected: fee});

        // Reject stale retained credit so this caller cannot claim another payment.
        uint256 retained = SUCKER.retainedToRemoteFeeOf(address(this));
        if (retained != 0) revert StickySourceFeePayer_RetainedFee({amount: retained});

        // Snapshot donations before paying; only the balance increase during submission belongs to this caller.
        uint256 beforeBalance = FEE_TOKEN.balanceOf(address(this));

        // Submit the native outbox prepared by the parent; the sucker handles fee payment and native transport.
        SUCKER.toRemote{value: msg.value}(JBConstants.NATIVE_TOKEN);

        // Verify that submission preserves every preexisting fee token before returning its receipt delta.
        uint256 afterBalance = FEE_TOKEN.balanceOf(address(this));
        if (afterBalance < beforeBalance) {
            revert StickySourceFeePayer_DecreasedBalance({beforeBalance: beforeBalance, afterBalance: afterBalance});
        }

        // Return fee receipts directly, keeping any parent rewards distributed by payment callbacks out of custody.
        feeTokenCount = afterBalance - beforeBalance;
        if (feeTokenCount != 0) FEE_TOKEN.safeTransfer({to: beneficiary, value: feeTokenCount});

        // A failed fee payment can leave native credit in the sucker; return it in the same atomic send.
        refundedFee = SUCKER.retainedToRemoteFeeOf(address(this));
        if (refundedFee != 0) {
            SUCKER.claimRetainedToRemoteFee(beneficiary);

            // A partial claim cannot leave credit for another caller to receive.
            retained = SUCKER.retainedToRemoteFeeOf(address(this));
            if (retained != 0) revert StickySourceFeePayer_RetainedFee({amount: retained});
        }
    }
}
