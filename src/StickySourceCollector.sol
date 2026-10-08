// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBCashOutTerminal} from "@bananapus/core-v6/src/interfaces/IJBCashOutTerminal.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBFees} from "@bananapus/core-v6/src/libraries/JBFees.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {JBRemoteToken} from "@bananapus/suckers-v6/src/structs/JBRemoteToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Holds one V6 project's reserved ERC-20 rewards until anyone sends them through a fixed native sucker to
/// one Ethereum Sticky reward receiver.
/// @dev Configure reserved splits with this contract as their plain beneficiary, never its fee payer. Every send
/// atomically prepares and submits the entire source-token balance; failed transport leaves no prepared leaf or
/// spent principal. Canonical withdrawal finalization, destination claim and receiver settlement remain separate.
/// The source project must be V6 project 1 or 3 on OP, Base or Arbitrum. Deployment must bind the canonical registered
/// native sucker and the receiver of the intended Ethereum Sticky token/group. Other donated assets have no rescue.
// The fee payer is a constructor-created custody boundary used only by this collector.
// forge-lint: disable-next-line(multi-contract-file)
contract StickySourceCollector is ReentrancyGuard {
    // A library that safely grants and clears the sucker's exact source-token allowance.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when there are no source tokens to bridge.
    error StickySourceCollector_EmptyBalance();

    /// @notice Thrown when the supplied native value differs from the registry fee.
    /// @param received The value supplied by the caller.
    /// @param expected The registry's current fee.
    error StickySourceCollector_IncorrectFee(uint256 received, uint256 expected);

    /// @notice Thrown when a constructor or route check cannot bind the supported fixed native path.
    error StickySourceCollector_InvalidRoute();

    /// @notice Thrown when the source project has no primary native cashout terminal.
    error StickySourceCollector_NoTerminal();

    /// @notice Thrown when preparation did not append exactly one leaf after the captured frontier.
    /// @param expected The expected next tree count.
    /// @param actual The actual tree count after preparation.
    error StickySourceCollector_UnexpectedLeafCount(uint256 expected, uint256 actual);

    /// @notice Thrown when submission did not include this call's prepared leaf.
    /// @param index The prepared leaf index.
    /// @param sentCount The number of leaves included in submitted roots.
    error StickySourceCollector_UnsentLeaf(uint256 index, uint256 sentCount);

    /// @notice Thrown when a fresh cashout preview cannot protect a positive amount of backing.
    error StickySourceCollector_ZeroReclaim();

    //*********************************************************************//
    // ------------------------------- events ---------------------------- //
    //*********************************************************************//

    /// @notice Emitted after this call's source rewards are included in a submitted native outbox root.
    /// @param index The prepared leaf index, used with the sucker's emitted leaf data to build a claim.
    /// @param projectTokenCount The source project tokens prepared by this call.
    /// @param minimumReclaimed The positive protocol-fee-adjusted lower bound from the fresh cashout preview.
    /// @param feeTokenCount The fee-payment receipt tokens returned to this caller.
    /// @param refundedFee The failed fee payment returned to this caller, if any.
    /// @param caller The account that paid for this source submission.
    event Send(
        uint256 indexed index,
        uint256 projectTokenCount,
        uint256 minimumReclaimed,
        uint256 feeTokenCount,
        uint256 refundedFee,
        address indexed caller
    );

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The child that separates the caller's bridge-fee receipt from reserved reward principal.
    StickySourceFeePayer public immutable FEE_PAYER;

    /// @notice The V6 source project whose reserved ERC-20 rewards this collector bridges.
    uint256 public immutable PROJECT_ID;

    /// @notice The fixed Ethereum reward receiver that benefits from every prepared source leaf.
    address public immutable RECEIVER;

    /// @notice The source project's ERC-20, derived from the sucker's token registry.
    IERC20 public immutable SOURCE_TOKEN;

    /// @notice The registered native source sucker whose peer is on Ethereum.
    JBSucker public immutable SUCKER;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Binds source custody and fee handling to one canonical route and Ethereum reward receiver.
    /// @param sucker The canonical native sucker registered for source project 1 or 3.
    /// @param receiver The intended Ethereum Sticky reward receiver, which may be counterfactual.
    constructor(JBSucker sucker, address receiver) {
        if (
            (block.chainid != 10 && block.chainid != 8453 && block.chainid != 42_161)
                || address(sucker).code.length == 0 || receiver == address(0)
        ) revert StickySourceCollector_InvalidRoute();

        uint256 projectId = sucker.projectId();
        if (
            (projectId != 1 && projectId != 3) || sucker.FEE_PROJECT_ID() != 1
                || !sucker.REGISTRY().isSuckerOf({projectId: projectId, addr: address(sucker)})
        ) revert StickySourceCollector_InvalidRoute();
        _requireNativeRoute(sucker);

        IERC20 sourceToken = IERC20(address(sucker.TOKENS().tokenOf(projectId)));
        IERC20 feeToken = IERC20(address(sucker.TOKENS().tokenOf(sucker.FEE_PROJECT_ID())));
        if (address(sourceToken).code.length == 0 || address(feeToken).code.length == 0) {
            revert StickySourceCollector_InvalidRoute();
        }

        PROJECT_ID = projectId;
        RECEIVER = receiver;
        SOURCE_TOKEN = sourceToken;
        SUCKER = sucker;
        FEE_PAYER = new StickySourceFeePayer({sucker: sucker, feeToken: feeToken});
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Prepares and submits all held source rewards, with this caller funding the exact registry fee.
    /// @dev The cashout minimum is a fresh gross preview less the maximum standard protocol fee, not an AMM slippage
    /// quote. Callback-delivered reserves remain in this collector for a later send. A reverting transport, refund,
    /// receipt transfer or sent-leaf postcondition reverts the complete preparation and submission.
    /// @return leafIndex The newly prepared leaf's index in the source sucker's native outbox.
    function send() external payable nonReentrant returns (uint256 leafIndex) {
        _requireNativeRoute(SUCKER);

        uint256 fee = SUCKER.REGISTRY().toRemoteFee();
        if (msg.value != fee) revert StickySourceCollector_IncorrectFee({received: msg.value, expected: fee});

        uint256 projectTokenCount = SOURCE_TOKEN.balanceOf(address(this));
        // An empty balance must not create a zero-value bridge leaf.
        // slither-disable-next-line incorrect-equality
        if (projectTokenCount == 0) revert StickySourceCollector_EmptyBalance();

        IJBTerminal terminal =
            SUCKER.DIRECTORY().primaryTerminalOf({projectId: PROJECT_ID, token: JBConstants.NATIVE_TOKEN});
        if (address(terminal) == address(0)) revert StickySourceCollector_NoTerminal();

        // The terminal owns ruleset and hook interpretation; only its gross reclaim quote defines this bound.
        // forge-lint: disable-next-item(unused-return)
        // slither-disable-next-line unused-return
        (, uint256 grossReclaimed,,) = IJBCashOutTerminal(address(terminal))
            .previewCashOutFrom({
                holder: address(SUCKER),
                projectId: PROJECT_ID,
                cashOutCount: projectTokenCount,
                tokenToReclaim: JBConstants.NATIVE_TOKEN,
                beneficiary: payable(address(SUCKER)),
                metadata: ""
            });
        uint256 minimumReclaimed = grossReclaimed - JBFees.standardFeeAmountFrom(grossReclaimed);
        // Reject zero backing so preparation cannot burn rewards without a positive reclaim bound.
        // slither-disable-next-line incorrect-equality
        if (minimumReclaimed == 0) revert StickySourceCollector_ZeroReclaim();

        leafIndex = SUCKER.outboxOf(JBConstants.NATIVE_TOKEN).tree.count;
        SOURCE_TOKEN.forceApprove({spender: address(SUCKER), value: projectTokenCount});
        SUCKER.prepare({
            projectTokenCount: projectTokenCount,
            beneficiary: bytes32(uint256(uint160(RECEIVER))),
            minTokensReclaimed: minimumReclaimed,
            token: JBConstants.NATIVE_TOKEN,
            metadata: bytes32(0)
        });
        SOURCE_TOKEN.forceApprove({spender: address(SUCKER), value: 0});

        uint256 nextCount = SUCKER.outboxOf(JBConstants.NATIVE_TOKEN).tree.count;
        if (nextCount != leafIndex + 1) {
            revert StickySourceCollector_UnexpectedLeafCount({expected: leafIndex + 1, actual: nextCount});
        }

        // The fee payer cannot pull parent rewards, including reserves distributed during its payment callbacks.
        (uint256 feeTokenCount, uint256 refundedFee) = FEE_PAYER.send{value: msg.value}(payable(msg.sender));
        uint256 sentCount = SUCKER.outboxOf(JBConstants.NATIVE_TOKEN).numberOfClaimsSent;
        if (sentCount <= leafIndex) {
            revert StickySourceCollector_UnsentLeaf({index: leafIndex, sentCount: sentCount});
        }

        // The reentrancy guard spans all callbacks; emit only after the newly prepared leaf is proven sent.
        // forge-lint: disable-next-item(reentrancy-events)
        emit Send({
            index: leafIndex,
            projectTokenCount: projectTokenCount,
            minimumReclaimed: minimumReclaimed,
            feeTokenCount: feeTokenCount,
            refundedFee: refundedFee,
            caller: msg.sender
        });
    }

    //*********************************************************************//
    // -------------------------- internal views ------------------------- //
    //*********************************************************************//

    /// @notice Requires the supported native-to-native Ethereum route, including after an unused mapping changes.
    /// @param sucker The fixed source sucker whose route is checked.
    function _requireNativeRoute(JBSucker sucker) internal view {
        JBRemoteToken memory remoteToken = sucker.remoteTokenFor(JBConstants.NATIVE_TOKEN);
        if (
            sucker.peerChainId() != 1 || sucker.peer() == bytes32(0) || !remoteToken.enabled
                || remoteToken.emergencyHatch || remoteToken.addr != bytes32(uint256(uint160(JBConstants.NATIVE_TOKEN)))
        ) revert StickySourceCollector_InvalidRoute();
    }
}

/// @notice Pays one collector's bridge fee without receiving its reserved reward principal.
/// @dev Only the fixed parent can submit. Fee-project receipt tokens and failed-payment refunds belong to the
/// parent's current caller; preexisting child token donations are excluded. This child must never be configured as
/// a reserved-split beneficiary. It has no allowance over parent tokens, arbitrary-call entry or rescue operation.
// The parent creates this child atomically to give fee-payment receipts a separate custody address.
// forge-lint: disable-next-line(multi-contract-file)
contract StickySourceFeePayer {
    // A library that safely returns only this submission's fee-payment receipt tokens.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown if submission consumed a preexisting fee-token donation.
    /// @param beforeBalance The fee-token balance before submission.
    /// @param afterBalance The fee-token balance after submission.
    error StickySourceFeePayer_DecreasedBalance(uint256 beforeBalance, uint256 afterBalance);

    /// @notice Thrown when the supplied native value differs from the current registry fee.
    /// @param received The value supplied by the parent.
    /// @param expected The registry's current fee.
    error StickySourceFeePayer_IncorrectFee(uint256 received, uint256 expected);

    /// @notice Thrown when retained fee credit exists outside this call's atomic refund.
    /// @param amount The unexpected retained credit.
    error StickySourceFeePayer_RetainedFee(uint256 amount);

    /// @notice Thrown when an address other than the fixed collector attempts to submit.
    /// @param caller The unauthorized caller.
    error StickySourceFeePayer_Unauthorized(address caller);

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The only account allowed to submit through this child.
    address public immutable COLLECTOR;

    /// @notice The fee project's ERC-20 derived by the collector from its fixed sucker.
    IERC20 public immutable FEE_TOKEN;

    /// @notice The only sucker this child can call or pay.
    JBSucker public immutable SUCKER;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Binds fee submission to the creating collector and its fixed source route.
    /// @param sucker The parent's registered native source sucker.
    /// @param feeToken The sucker's fee-project ERC-20.
    constructor(JBSucker sucker, IERC20 feeToken) {
        COLLECTOR = msg.sender;
        FEE_TOKEN = feeToken;
        SUCKER = sucker;
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Submits the parent's prepared native outbox and returns this caller's fee receipt or refund.
    /// @dev Native refunds go directly from the sucker to the beneficiary. Rejection reverts the parent's complete
    /// send, leaving another caller free to retry. No ETH balance, refund ledger or recipient callback is needed here.
    /// @param beneficiary The original caller of the parent's atomic send.
    /// @return feeTokenCount The newly received fee-project tokens returned to the beneficiary.
    /// @return refundedFee The newly retained failed fee payment returned to the beneficiary.
    function send(address payable beneficiary) external payable returns (uint256 feeTokenCount, uint256 refundedFee) {
        if (msg.sender != COLLECTOR) revert StickySourceFeePayer_Unauthorized({caller: msg.sender});

        uint256 fee = SUCKER.REGISTRY().toRemoteFee();
        if (msg.value != fee) revert StickySourceFeePayer_IncorrectFee({received: msg.value, expected: fee});

        uint256 retained = SUCKER.retainedToRemoteFeeOf(address(this));
        if (retained != 0) revert StickySourceFeePayer_RetainedFee({amount: retained});

        uint256 beforeBalance = FEE_TOKEN.balanceOf(address(this));
        SUCKER.toRemote{value: msg.value}(JBConstants.NATIVE_TOKEN);
        uint256 afterBalance = FEE_TOKEN.balanceOf(address(this));
        if (afterBalance < beforeBalance) {
            revert StickySourceFeePayer_DecreasedBalance({beforeBalance: beforeBalance, afterBalance: afterBalance});
        }
        feeTokenCount = afterBalance - beforeBalance;
        if (feeTokenCount != 0) FEE_TOKEN.safeTransfer({to: beneficiary, value: feeTokenCount});

        refundedFee = SUCKER.retainedToRemoteFeeOf(address(this));
        if (refundedFee != 0) {
            SUCKER.claimRetainedToRemoteFee(beneficiary);
            retained = SUCKER.retainedToRemoteFeeOf(address(this));
            if (retained != 0) revert StickySourceFeePayer_RetainedFee({amount: retained});
        }
    }
}
