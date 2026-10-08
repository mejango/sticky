// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBCashOutTerminal} from "@bananapus/core-v6/src/interfaces/IJBCashOutTerminal.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBFees} from "@bananapus/core-v6/src/libraries/JBFees.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {JBSuckerState} from "@bananapus/suckers-v6/src/enums/JBSuckerState.sol";
import {JBRemoteToken} from "@bananapus/suckers-v6/src/structs/JBRemoteToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {StickySourceFeePayer} from "./StickySourceFeePayer.sol";

/// @notice Holds one V6 project's reserved ERC-20 rewards until anyone sends them through a fixed native sucker to
/// one Ethereum Sticky reward receiver.
/// @dev Configure reserved splits with this contract as their plain beneficiary, never its fee payer. Every send
/// atomically prepares and submits the entire source-token balance; failed transport leaves no prepared leaf or
/// spent principal. Canonical withdrawal finalization, destination claim and receiver settlement remain separate.
/// The source project must be V6 project 1 or 3 on OP, Base or Arbitrum. Deployment must bind the canonical registered
/// native sucker and the receiver of the intended Ethereum Sticky token/group; the constructor checks route shape
/// and the supplied sucker's own registry, not canonical deployment identity or destination bytecode.
/// @dev The route has no owner, upgrade, withdrawal or rescue operation. If its sucker permanently stops accepting
/// preparation or submission, held source rewards remain here. Assets other than the source token cannot be sent.
contract StickySourceCollector is ReentrancyGuard {
    // A library that safely grants and clears the sucker's exact source-token allowance.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when there are no source tokens to bridge, so a send cannot create an empty outbox leaf.
    /// @param token The source token whose collector balance is empty.
    error StickySourceCollector_EmptyBalance(IERC20 token);

    /// @notice Thrown when the supplied native value differs from the registry fee, so a caller funds exactly one
    /// submission without leaving excess native currency here.
    /// @param received The value supplied by the caller, in wei.
    /// @param expected The registry's current fee, in wei.
    error StickySourceCollector_IncorrectFee(uint256 received, uint256 expected);

    /// @notice Thrown when the peer or native mapping cannot deliver native backing to Ethereum, so a send cannot
    /// prepare rewards for an unsupported or emergency route.
    /// @param sucker The source sucker whose native route failed validation.
    /// @param peerChainId The sucker's current destination chain ID.
    /// @param peer The sucker's current destination peer.
    /// @param remoteToken The current native-token mapping, including its enabled and emergency state.
    error StickySourceCollector_InvalidNativeRoute(
        JBSucker sucker, uint256 peerChainId, bytes32 peer, JBRemoteToken remoteToken
    );

    /// @notice Thrown when the source project or fee project is unsupported, or the sucker is not registered for
    /// its source project, so custody cannot be bound to that project/route pair.
    /// @param sucker The source sucker whose project or registry binding failed validation.
    /// @param projectId The source project ID reported by the sucker.
    error StickySourceCollector_InvalidProject(JBSucker sucker, uint256 projectId);

    /// @notice Thrown when the source chain is unsupported, the sucker has no code or the receiver is zero, so the
    /// collector cannot bind its permanent route.
    /// @param chainId The chain on which the collector is being deployed.
    /// @param sucker The supplied source sucker.
    /// @param receiver The supplied Ethereum receiver.
    error StickySourceCollector_InvalidRoute(uint256 chainId, JBSucker sucker, address receiver);

    /// @notice Thrown when the source token or fee token has no code, since reward custody and fee receipts require
    /// ERC-20 balances on the source chain.
    /// @param sourceToken The source project token reported by the sucker's token registry.
    /// @param feeToken The fee project token reported by the sucker's token registry.
    error StickySourceCollector_InvalidTokens(IERC20 sourceToken, IERC20 feeToken);

    /// @notice Thrown when the source project has no primary native cashout terminal, so a positive reclaim bound
    /// cannot be quoted before spending source tokens.
    /// @param projectId The source project without a primary native cashout terminal.
    error StickySourceCollector_NoTerminal(uint256 projectId);

    /// @notice Thrown when the sucker's sending phase has ended, so a collector cannot bind or prepare rewards for
    /// a route that can no longer submit them.
    /// @param sucker The source sucker whose sending phase has ended.
    /// @param state The sucker's current deprecation state.
    error StickySourceCollector_SuckerNotSending(JBSucker sucker, JBSuckerState state);

    /// @notice Thrown when preparation did not append exactly one leaf after the captured frontier, so the sent-root
    /// postcondition cannot bind this call's reward leaf.
    /// @param expected The expected next tree count.
    /// @param actual The actual tree count after preparation.
    error StickySourceCollector_UnexpectedLeafCount(uint256 expected, uint256 actual);

    /// @notice Thrown when submission did not include this call's prepared leaf, so preparation and its token spend
    /// revert instead of leaving that leaf awaiting another sender.
    /// @param index The prepared leaf index.
    /// @param sentCount The number of leaves included in submitted roots.
    error StickySourceCollector_UnsentLeaf(uint256 index, uint256 sentCount);

    /// @notice Thrown when a fresh cashout preview cannot protect a positive amount of backing, so rewards cannot be
    /// burned with a zero reclaim bound.
    /// @param projectTokenCount The source project tokens quoted for preparation, in source-token decimals.
    /// @param grossReclaimed The terminal's gross native reclaim quote, in wei.
    error StickySourceCollector_ZeroReclaim(uint256 projectTokenCount, uint256 grossReclaimed);

    //*********************************************************************//
    // ------------------------------- events ---------------------------- //
    //*********************************************************************//

    /// @notice Emitted after this call's source rewards are included in a submitted native outbox root.
    /// @param index The prepared leaf index, used with the sucker's emitted leaf data to build a claim.
    /// @param projectTokenCount The source project tokens prepared by this call, in source-token decimals.
    /// @param minimumReclaimed The positive protocol-fee-adjusted lower bound from the fresh cashout preview, in wei.
    /// @param feeTokenCount The fee-payment receipt tokens returned to this caller, in fee-token decimals.
    /// @param refundedFee The failed fee payment returned to this caller, in wei; zero if no payment was retained.
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
    /// @dev Created by this collector and callable only by it; never configure the child as a split beneficiary.
    StickySourceFeePayer public immutable FEE_PAYER;

    /// @notice The V6 source project whose reserved ERC-20 rewards this collector bridges.
    uint256 public immutable PROJECT_ID;

    /// @notice The fixed Ethereum reward receiver that benefits from every prepared source leaf.
    /// @dev Its destination Sticky token and reward group must be checked before deployment; they are not read here.
    address public immutable RECEIVER;

    /// @notice The source project's ERC-20, derived from the sucker's token registry.
    IERC20 public immutable SOURCE_TOKEN;

    /// @notice The registered native source sucker whose peer is on Ethereum.
    JBSucker public immutable SUCKER;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Binds source custody and fee handling to one source route and Ethereum reward receiver.
    /// @dev The route must already have an enabled native-to-native Ethereum mapping and source and fee ERC-20s.
    /// Deployment must separately establish canonical sucker identity and the intended receiver's token/group.
    /// @param sucker The canonical native sucker registered for source project 1 or 3.
    /// @param receiver The intended Ethereum Sticky reward receiver, which may be counterfactual.
    constructor(JBSucker sucker, address receiver) {
        // Limit the route to supported source chains, deployed sucker code and a nonzero destination.
        if (
            (block.chainid != 10 && block.chainid != 8453 && block.chainid != 42_161)
                || address(sucker).code.length == 0 || receiver == address(0)
        ) revert StickySourceCollector_InvalidRoute({chainId: block.chainid, sucker: sucker, receiver: receiver});

        // Bind only the supported source projects and fee project through this sucker's own registry.
        uint256 projectId = sucker.projectId();
        if (
            (projectId != 1 && projectId != 3) || sucker.FEE_PROJECT_ID() != 1
                || !sucker.REGISTRY().isSuckerOf({projectId: projectId, addr: address(sucker)})
        ) revert StickySourceCollector_InvalidProject({sucker: sucker, projectId: projectId});

        // Require an enabled native mapping before fixing the route for every future submission.
        _requireNativeRoute(sucker);

        // ERC-20 custody must exist for both the reserved rewards and the fee-payment receipts.
        IERC20 sourceToken = IERC20(address(sucker.TOKENS().tokenOf(projectId)));
        IERC20 feeToken = IERC20(address(sucker.TOKENS().tokenOf(sucker.FEE_PROJECT_ID())));
        if (address(sourceToken).code.length == 0 || address(feeToken).code.length == 0) {
            revert StickySourceCollector_InvalidTokens({sourceToken: sourceToken, feeToken: feeToken});
        }

        // Fix the reward identity and destination so permissionless callers cannot redirect principal.
        PROJECT_ID = projectId;
        RECEIVER = receiver;
        SOURCE_TOKEN = sourceToken;
        SUCKER = sucker;

        // Separate fee receipts from reserves that the fee terminal's callbacks can distribute to this collector.
        FEE_PAYER = new StickySourceFeePayer({sucker: sucker, feeToken: feeToken});
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Prepares and submits all held source rewards, with this caller funding the exact registry fee.
    /// @dev The cashout minimum is a fresh gross preview less the maximum standard protocol fee, whose calculation
    /// rounds down to whole wei. It is not an AMM slippage quote or a destination token-amount guarantee.
    /// Callback-delivered reserves remain in this collector for a later send. A reverting transport, refund, receipt
    /// transfer or sent-leaf postcondition reverts the complete preparation and submission. Native finalization,
    /// destination claim and receiver settlement require separate calls after a successful source submission.
    /// @return leafIndex The newly prepared leaf's index in the source sucker's native outbox.
    function send() external payable nonReentrant returns (uint256 leafIndex) {
        // Reject a disabled, emergency or redirected mapping before granting token approval.
        _requireNativeRoute(SUCKER);

        // Fund only the current registry fee; unused excess value has no recovery path.
        uint256 fee = SUCKER.REGISTRY().toRemoteFee();
        if (msg.value != fee) revert StickySourceCollector_IncorrectFee({received: msg.value, expected: fee});

        // Snapshot the full available principal; tokens received during submission belong to a later send.
        uint256 projectTokenCount = SOURCE_TOKEN.balanceOf(address(this));

        // An empty balance must not create a zero-value bridge leaf.
        // slither-disable-next-line incorrect-equality
        if (projectTokenCount == 0) revert StickySourceCollector_EmptyBalance(SOURCE_TOKEN);

        // Quote the same native terminal the sucker will use to cash out the source rewards.
        IJBTerminal terminal =
            SUCKER.DIRECTORY().primaryTerminalOf({projectId: PROJECT_ID, token: JBConstants.NATIVE_TOKEN});
        if (address(terminal) == address(0)) revert StickySourceCollector_NoTerminal(PROJECT_ID);

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

        // The maximum standard fee gives a conservative bound even when the sucker receives a fee discount.
        uint256 minimumReclaimed = grossReclaimed - JBFees.standardFeeAmountFrom(grossReclaimed);

        // Reject zero backing so preparation cannot burn rewards without a positive reclaim bound.
        // slither-disable-next-line incorrect-equality
        if (minimumReclaimed == 0) {
            revert StickySourceCollector_ZeroReclaim({
                projectTokenCount: projectTokenCount, grossReclaimed: grossReclaimed
            });
        }

        // Capture the append frontier so submission can prove inclusion of this call's leaf.
        leafIndex = SUCKER.outboxOf(JBConstants.NATIVE_TOKEN).tree.count;

        // Limit the sucker to the snapshotted principal, including tokens that require an allowance reset.
        SOURCE_TOKEN.forceApprove({spender: address(SUCKER), value: projectTokenCount});

        // Burn the source project tokens into one leaf for the fixed destination with the fresh backing bound.
        SUCKER.prepare({
            projectTokenCount: projectTokenCount,
            beneficiary: bytes32(uint256(uint160(RECEIVER))),
            minTokensReclaimed: minimumReclaimed,
            token: JBConstants.NATIVE_TOKEN,
            metadata: bytes32(0)
        });

        // Leave no allowance that could spend callback-delivered reserves outside a subsequent guarded send.
        SOURCE_TOKEN.forceApprove({spender: address(SUCKER), value: 0});

        // Exactly one appended leaf binds the captured index to this preparation.
        uint256 nextCount = SUCKER.outboxOf(JBConstants.NATIVE_TOKEN).tree.count;
        if (nextCount != leafIndex + 1) {
            revert StickySourceCollector_UnexpectedLeafCount({expected: leafIndex + 1, actual: nextCount});
        }

        // The fee payer cannot pull parent rewards, including reserves distributed during its payment callbacks.
        (uint256 feeTokenCount, uint256 refundedFee) = FEE_PAYER.send{value: msg.value}(payable(msg.sender));

        // A successful transport call is insufficient unless its submitted root includes the prepared leaf.
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

    /// @notice Requires a sucker that can still send through an enabled native-to-native Ethereum mapping with a
    /// nonzero peer and no emergency hatch.
    /// @dev Checked during construction and before each send because the sucker's sending phase and mapping can
    /// change independently of this collector. Pending deprecation still permits sending; disabled sending and full
    /// deprecation do not. The peer address itself must be authenticated before deployment.
    /// @param sucker The fixed source sucker whose route is checked.
    function _requireNativeRoute(JBSucker sucker) internal view {
        // Reject a route whose sending phase has ended before binding it or approving reward preparation.
        JBSuckerState state = sucker.state();
        if (state == JBSuckerState.SENDING_DISABLED || state == JBSuckerState.DEPRECATED) {
            revert StickySourceCollector_SuckerNotSending({sucker: sucker, state: state});
        }

        // Capture the complete route binding so a rejected route identifies its peer and native mapping.
        JBRemoteToken memory remoteToken = sucker.remoteTokenFor(JBConstants.NATIVE_TOKEN);
        uint256 peerChainId = sucker.peerChainId();
        bytes32 peer = sucker.peer();

        // Preserve the backing asset and destination chain independently of the source project's mutable mapping.
        if (
            peerChainId != 1 || peer == bytes32(0) || !remoteToken.enabled || remoteToken.emergencyHatch
                || remoteToken.addr != bytes32(uint256(uint160(JBConstants.NATIVE_TOKEN)))
        ) {
            revert StickySourceCollector_InvalidNativeRoute({
                sucker: sucker, peerChainId: peerChainId, peer: peer, remoteToken: remoteToken
            });
        }
    }
}
