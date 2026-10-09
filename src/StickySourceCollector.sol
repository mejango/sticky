// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBCashOutTerminal} from "@bananapus/core-v6/src/interfaces/IJBCashOutTerminal.sol";
import {IJBController} from "@bananapus/core-v6/src/interfaces/IJBController.sol";
import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBSplitHook} from "@bananapus/core-v6/src/interfaces/IJBSplitHook.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {JBConstants} from "@bananapus/core-v6/src/libraries/JBConstants.sol";
import {JBFees} from "@bananapus/core-v6/src/libraries/JBFees.sol";
import {JBSplitGroupIds} from "@bananapus/core-v6/src/libraries/JBSplitGroupIds.sol";
import {JBSplitHookContext} from "@bananapus/core-v6/src/structs/JBSplitHookContext.sol";
import {JBSucker} from "@bananapus/suckers-v6/src/JBSucker.sol";
import {JBSuckerState} from "@bananapus/suckers-v6/src/enums/JBSuckerState.sol";
import {IJBSucker} from "@bananapus/suckers-v6/src/interfaces/IJBSucker.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {JBRemoteToken} from "@bananapus/suckers-v6/src/structs/JBRemoteToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {StickySourceFeePayer} from "./StickySourceFeePayer.sol";

import {IStickyRewardReceiverFactory} from "./interfaces/IStickyRewardReceiverFactory.sol";
import {IStickySourceCollector} from "./interfaces/IStickySourceCollector.sol";
import {IStickySourceFeePayer} from "./interfaces/IStickySourceFeePayer.sol";

/// @notice Accepts V6 reserved project tokens for permissionless delivery to Sticky reward receivers on one configured
/// home chain.
/// @dev Set the reserved split's hook to this contract, beneficiary to the home-chain Sticky share token, and projectId
/// to its reward group. Acceptance only records attributed custody; bridge fees, transport and settlement are separate
/// calls so their failures cannot reject a valid reserved allocation. Credits can wait here for the source ERC-20.
/// @dev Each source project, Sticky token and group has its own pending balance. Callers cannot redirect that balance,
/// spend another bucket or claim unattributed donations. Canonical project and transport dependencies still govern
/// issuance and delivery. The home-chain reward ERC-20 and intended Sticky receiver must be usable before remote
/// claims.
/// @dev There is no owner, upgrade, withdrawal or general rescue. The only fee-child recovery contributes its full
/// native balance to the protocol fee project on this family's home chain. A caller may select another registered
/// route to that home chain when one stops sending; if none is usable, rewards remain queued. Native finality and
/// destination claims are separate.
contract StickySourceCollector is IStickySourceCollector, ReentrancyGuard {
    // A library that safely pulls allocated rewards and limits each sucker to one delivery's approved amount.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when a destination-chain operation is called on another chain.
    /// @param chainId The chain on which the destination operation was attempted.
    error StickySourceCollector_DestinationOnly(uint256 chainId);

    /// @notice Thrown when an outbound custody operation would run during an inbound receipt measurement.
    /// @param caller The account attempting the outbound custody operation.
    /// @param depth The number of active, possibly nested, acceptance callbacks.
    error StickySourceCollector_InboundTransfer(address caller, uint256 depth);

    /// @notice Thrown when project custody cannot cover its attributed pending balances.
    /// @param sourceProjectId The project whose custody is insufficient.
    /// @param available The combined project tokens and credits held, in 18-decimal project-token atoms.
    /// @param required The project-token atoms needed to cover the liabilities being checked.
    error StickySourceCollector_InsufficientCustody(uint256 sourceProjectId, uint256 available, uint256 required);

    /// @notice Thrown when a delivery exceeds its own bucket instead of spending another destination's allocation.
    /// @param sourceProjectId The project whose rewards were requested.
    /// @param stickyToken The home-chain Sticky share token whose holders receive this bucket.
    /// @param groupId The bucket's reward group.
    /// @param requested The requested project-token atoms.
    /// @param pending The project-token atoms attributed to this bucket.
    error StickySourceCollector_InsufficientPending(
        uint256 sourceProjectId, address stickyToken, uint256 groupId, uint256 requested, uint256 pending
    );

    /// @notice Thrown when a delivery requests zero tokens, so it cannot create an empty reward operation.
    /// @param amount The requested project-token atoms.
    error StickySourceCollector_InvalidAmount(uint256 amount);

    /// @notice Thrown when a constructor dependency has no code and cannot establish canonical custody bindings.
    /// @param dependency The dependency that has no deployed code.
    error StickySourceCollector_InvalidDependency(address dependency);

    /// @notice Thrown when no destination chain is configured, so queued rewards cannot have an undefined home.
    /// @param destinationChainId The invalid destination chain ID.
    error StickySourceCollector_InvalidDestinationChainId(uint256 destinationChainId);

    /// @notice Thrown when the chosen backing asset cannot be sent through the sucker's current mapping.
    /// @param sucker The selected source sucker.
    /// @param backingToken The source terminal token selected for cashout and transport.
    /// @param remoteToken The current mapping, including its destination, enabled flag and emergency state.
    error StickySourceCollector_InvalidMapping(IJBSucker sucker, address backingToken, JBRemoteToken remoteToken);

    /// @notice Thrown when a supplied sucker does not bind this source project to the configured destination through
    /// the canonical route system.
    /// @param sourceProjectId The project whose registered route was required.
    /// @param sucker The supplied source sucker.
    error StickySourceCollector_InvalidRoute(uint256 sourceProjectId, IJBSucker sucker);

    /// @notice Thrown when a callback does not describe this hook's V6 reserved-token split.
    /// @param sourceProjectId The context's source project.
    /// @param groupId The context's source split group, which must be the reserved-token group.
    /// @param hook The hook named in the split.
    /// @param decimals The context's project-token decimals, which must be 18.
    error StickySourceCollector_InvalidSplit(uint256 sourceProjectId, uint256 groupId, address hook, uint256 decimals);

    /// @notice Thrown when a project has no deployed primary terminal for the selected token.
    /// @param sourceProjectId The project without a usable primary terminal.
    /// @param backingToken The selected terminal token.
    error StickySourceCollector_NoTerminal(uint256 sourceProjectId, address backingToken);

    /// @notice Thrown when delivery needs a source ERC-20 that has not been deployed or attached yet.
    /// @param sourceProjectId The project whose queued credits cannot yet be delivered.
    error StickySourceCollector_NoToken(uint256 sourceProjectId);

    /// @notice Thrown when a remote send is requested on the configured home chain, where local settlement is used
    /// instead.
    /// @param chainId The chain on which remote delivery was attempted.
    error StickySourceCollector_SourceOnly(uint256 chainId);

    /// @notice Thrown when the chosen sucker's sending phase has ended and another usable route is required.
    /// @param sucker The selected source sucker.
    /// @param state The sucker's current deprecation state.
    error StickySourceCollector_SuckerNotSending(IJBSucker sucker, JBSuckerState state);

    /// @notice Thrown when a non-credit callback names a different token from the source project's registered ERC-20.
    /// @param sourceProjectId The context's source project.
    /// @param received The token named in the callback.
    /// @param expected The ERC-20 currently registered for the project.
    error StickySourceCollector_TokenMismatch(uint256 sourceProjectId, address received, address expected);

    /// @notice Thrown when a caller is not the source project's current controller and cannot attest reserved issuance.
    /// @param sourceProjectId The context's source project.
    /// @param caller The direct callback sender.
    /// @param controller The controller currently recorded in the canonical directory.
    error StickySourceCollector_Unauthorized(uint256 sourceProjectId, address caller, address controller);

    /// @notice Thrown when converting held credits still leaves too few ERC-20 tokens for the requested delivery.
    /// @param sourceProjectId The project whose credits were claimed.
    /// @param expected The minimum ERC-20 balance required, in project-token atoms.
    /// @param actual The ERC-20 balance after the claim, in project-token atoms.
    error StickySourceCollector_UnexpectedClaimBalance(uint256 sourceProjectId, uint256 expected, uint256 actual);

    /// @notice Thrown when preparation does not append exactly one leaf after the captured outbox frontier.
    /// @param expected The expected next tree count.
    /// @param actual The tree count after preparation.
    error StickySourceCollector_UnexpectedLeafCount(uint256 expected, uint256 actual);

    /// @notice Thrown when a reserved-token callback supplies native currency instead of project tokens or credits.
    /// @param amount The native value supplied, in wei.
    error StickySourceCollector_UnexpectedNativeValue(uint256 amount);

    /// @notice Thrown when an inbound custody delta cannot cover nested accepted allocations before crediting its
    /// caller.
    /// @param sourceProjectId The source project being measured.
    /// @param custodyBefore The combined project-token and credit balance before the pull.
    /// @param custodyAfter The combined balance after the pull.
    /// @param pendingBefore The aggregate attributed balance before the pull.
    /// @param pendingAfter The aggregate attributed balance after nested callbacks return.
    error StickySourceCollector_UnexpectedReceipt(
        uint256 sourceProjectId,
        uint256 custodyBefore,
        uint256 custodyAfter,
        uint256 pendingBefore,
        uint256 pendingAfter
    );

    /// @notice Thrown when submission did not include this call's prepared leaf, reverting its full preparation.
    /// @param index The prepared leaf index.
    /// @param sentCount The number of leaves included in submitted roots.
    error StickySourceCollector_UnsentLeaf(uint256 index, uint256 sentCount);

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The home chain where every configured Sticky destination receives and settles its rewards.
    /// @dev Fixed for this collector, so a permissionless delivery caller cannot change a bucket's destination chain.
    uint256 public immutable override DESTINATION_CHAIN_ID;

    /// @notice The canonical directory used to authenticate controllers and source cashout terminals.
    /// @dev Derived from the supplied canonical sucker registry, whose deployment identity must be verified.
    IJBDirectory public immutable override DIRECTORY;

    /// @notice The parent-only child that separates caller refunds from queued principal and holds raw destination
    /// refunds until their fixed project-1 contribution.
    IStickySourceFeePayer public immutable override FEE_PAYER;

    /// @notice The receiver factory whose address and implementation match the configured home-chain factory.
    /// @dev Its existing prediction rule owns Sticky-token/group validation and cross-chain receiver identity.
    IStickyRewardReceiverFactory public immutable override RECEIVER_FACTORY;

    /// @notice The independently bound canonical registry that authenticates every caller-selected sucker.
    IJBSuckerRegistry public immutable override REGISTRY;

    /// @notice The canonical project-token registry used for ERC-20 identity, held credits and combined custody.
    IJBTokens public immutable override TOKENS;

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The accepted project-token atoms awaiting delivery to each home-chain Sticky token and reward group.
    /// @custom:param sourceProjectId The source project whose reserved tokens or credits were accepted.
    /// @custom:param stickyToken The home-chain Sticky share token whose holders receive this allocation.
    /// @custom:param groupId The destination reward group.
    mapping(uint256 sourceProjectId => mapping(address stickyToken => mapping(uint256 groupId => uint256 amount)))
        public
        override pendingOf;

    /// @notice The project-token atoms owed across every destination bucket for a source project.
    /// @dev Combined held credits and ERC-20 tokens must cover this amount; donations do not increase it.
    /// @custom:param sourceProjectId The project whose attributed liabilities are totaled.
    mapping(uint256 sourceProjectId => uint256 amount) public override totalPendingOf;

    //*********************************************************************//
    // ------------------- transient stored properties ------------------- //
    //*********************************************************************//

    /// @notice The number of active acceptance callbacks whose custody measurements must remain free of outbound
    /// spends.
    /// @dev Nested valid callbacks are allowed because core catches hook failures and burns unconsumed ERC-20 reserves.
    uint256 internal transient _acceptanceDepth;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Binds shared reserved-token custody to canonical V6 contracts and receiver prediction on one home chain.
    /// @dev Identical arguments, initcode and CREATE2 salt give the same hook address across source chains. Dependency
    /// runtime identities and receiver-factory parity must be verified before installing any live split.
    /// @param registry The canonical sucker registry whose directory authenticates source controllers and routes.
    /// @param tokens The canonical project-token registry used by those controllers and suckers.
    /// @param receiverFactory The existing receiver factory with the home-chain factory's address and implementation.
    /// @param destinationChainId The nonzero home-chain ID shared by every destination bucket in this collector.
    constructor(
        IJBSuckerRegistry registry,
        IJBTokens tokens,
        IStickyRewardReceiverFactory receiverFactory,
        uint256 destinationChainId
    ) {
        // Every accepted allocation needs one immutable destination before custody can be attributed.
        if (destinationChainId == 0) revert StickySourceCollector_InvalidDestinationChainId(destinationChainId);

        // Refuse missing dependencies before fixing custody and receiver identity for all future allocations.
        if (address(registry).code.length == 0) revert StickySourceCollector_InvalidDependency(address(registry));
        if (address(tokens).code.length == 0) revert StickySourceCollector_InvalidDependency(address(tokens));
        if (address(receiverFactory).code.length == 0) {
            revert StickySourceCollector_InvalidDependency(address(receiverFactory));
        }
        IJBDirectory directory = registry.DIRECTORY();
        if (address(directory).code.length == 0) revert StickySourceCollector_InvalidDependency(address(directory));

        // The bindings authenticate live project configuration without installing an owner or route-change permission.
        DESTINATION_CHAIN_ID = destinationChainId;
        DIRECTORY = directory;
        RECEIVER_FACTORY = receiverFactory;
        REGISTRY = registry;
        TOKENS = tokens;

        // Give fee payments their own address so newly distributed reserves remain attributed parent custody.
        FEE_PAYER = new StickySourceFeePayer();
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Contributes the destination copy's full raw-address native balance to project 1.
    /// @dev Anyone can call on this collector's configured destination chain. The current primary terminal is resolved
    /// from the canonical directory, while the child fixes the project, native token and held-fee behavior. A zero
    /// balance is a no-op. The original delivery caller is not reimbursed, and an aliased gateway balance is outside
    /// this operation. Terminal failure leaves the complete balance available for another attempt.
    /// @return amount The native balance contributed, in wei.
    function addFeeRefundToBalance() external override nonReentrant returns (uint256 amount) {
        // Never move fee custody during a nested reserved-token receipt measurement.
        _requireNotAccepting();
        if (block.chainid != DESTINATION_CHAIN_ID) revert StickySourceCollector_DestinationOnly(block.chainid);

        // Skip the external directory lookup when there is nothing to contribute.
        // An exact zero is the only balance that cannot fund a contribution.
        // forge-lint: disable-next-item(incorrect-strict-equality)
        // slither-disable-next-line incorrect-equality
        if (address(FEE_PAYER).balance == 0) return 0;

        // Resolve the protocol fee project's live native terminal without giving the caller a routing choice.
        IJBTerminal terminal = DIRECTORY.primaryTerminalOf({
            projectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID, token: JBConstants.NATIVE_TOKEN
        });
        if (address(terminal).code.length == 0) {
            revert StickySourceCollector_NoTerminal({
                sourceProjectId: JBConstants.FEE_BENEFICIARY_PROJECT_ID, backingToken: JBConstants.NATIVE_TOKEN
            });
        }

        // The child fixes the terminal call's project and token, and returns the exact amount transferred.
        amount = FEE_PAYER.addFeeRefundToBalance(terminal);
        // The terminal call finishes before this receipt is emitted, and the outer guard rejects reentry.
        // forge-lint: disable-next-line(reentrancy-events)
        emit AddFeeRefundToBalance({terminal: terminal, amount: amount, caller: msg.sender});
    }

    /// @notice Accepts and attributes one authenticated reserved split without attempting delivery or charging a fee.
    /// @dev The split beneficiary is the home-chain Sticky share token; its projectId is the reward group. ERC-20 pulls
    /// measure combined project custody and exclude nested allocations already recorded by this hook. Credit contexts
    /// are valid even if an earlier split deployed the ERC-20 after the controller cached its credit-only token value.
    /// Valid nested acceptance remains available during token callbacks and outbound fee payments.
    /// @param context The source controller's reserved-token allocation and destination configuration.
    function processSplitWith(JBSplitHookContext calldata context) external payable override {
        // Preserve every valid nested allocation while preventing outbound delivery from disturbing its measurement.
        ++_acceptanceDepth;

        // Only the canonical directory's current controller can attest that this project's reserves were issued.
        address controller = address(DIRECTORY.controllerOf(context.projectId));
        if (msg.sender != controller) {
            revert StickySourceCollector_Unauthorized({
                sourceProjectId: context.projectId, caller: msg.sender, controller: controller
            });
        }
        if (
            context.groupId != JBSplitGroupIds.RESERVED_TOKENS || address(context.split.hook) != address(this)
                || context.decimals != 18
        ) {
            revert StickySourceCollector_InvalidSplit({
                sourceProjectId: context.projectId,
                groupId: context.groupId,
                hook: address(context.split.hook),
                decimals: context.decimals
            });
        }

        // Reserved issuance transfers project tokens or credits, never a native bridge-fee budget.
        if (msg.value != 0) revert StickySourceCollector_UnexpectedNativeValue(msg.value);
        address sourceToken = address(TOKENS.tokenOf(context.projectId));
        if (context.token != address(0) && context.token != sourceToken) {
            revert StickySourceCollector_TokenMismatch({
                sourceProjectId: context.projectId, received: context.token, expected: sourceToken
            });
        }

        // Reuse the destination factory's validation and prediction instead of maintaining another group or salt rule.
        address stickyToken = address(context.split.beneficiary);
        uint256 groupId = context.split.projectId;
        address receiver = RECEIVER_FACTORY.predictReceiverOf({stickyToken: stickyToken, groupId: groupId});
        uint256 amount = _acceptFrom(context);

        // Book only this callback's receipt; nested callbacks have already credited their own destination buckets.
        pendingOf[context.projectId][stickyToken][groupId] += amount;
        uint256 pending = totalPendingOf[context.projectId] + amount;
        _requireCustody({sourceProjectId: context.projectId, required: pending});
        totalPendingOf[context.projectId] = pending;
        --_acceptanceDepth;

        // Acceptance has no external delivery call, so a later bridge or settlement failure leaves this allocation
        // queued.
        emit Queue({
            sourceProjectId: context.projectId,
            stickyToken: stickyToken,
            groupId: groupId,
            receiver: receiver,
            amount: amount,
            caller: msg.sender
        });
    }

    /// @notice Atomically sends part of one destination bucket through a registered, usable sucker route to the
    /// configured home chain.
    /// @dev The caller funds the registry fee and any native transport budget. The minimum uses the selected backing
    /// terminal's current gross preview less the maximum standard protocol fee, in backing-token atoms. Zero backing
    /// remains valid because the destination remints the leaf's project-token count. A caller-sensitive custom cashout
    /// hook may make preview and execution differ; a failed minimum restores custody and liabilities for another
    /// attempt. Native finality, destination claim and receiver settlement remain separate after source submission
    /// succeeds. The fee child returns source-chain retained registry and transport refunds to this caller. A matching
    /// destination-family collector can separately contribute an unattributed raw native refund to the protocol fee
    /// project; this call does not reimburse the caller or recover an aliased gateway refund.
    /// @param sourceProjectId The project whose attributed reserved-token custody is being delivered.
    /// @param stickyToken The home-chain Sticky share token whose holders receive the selected bucket.
    /// @param groupId The bucket's destination reward group.
    /// @param amount The positive project-token atoms to send, at most the selected bucket's pending amount.
    /// @param sucker The project's registered source sucker with a peer on the configured home chain and usable
    /// backing mapping.
    /// @param backingToken The source terminal token to cash out and bridge, including a supported mapped ERC-20.
    /// @return leafIndex The newly prepared leaf's index in the selected backing asset's source outbox.
    function send(
        uint256 sourceProjectId,
        address stickyToken,
        uint256 groupId,
        uint256 amount,
        IJBSucker sucker,
        address backingToken
    )
        external
        payable
        override
        nonReentrant
        returns (uint256 leafIndex)
    {
        // Outbound work cannot change a nested inbound receipt's balance or liability snapshots.
        _requireNotAccepting();
        if (block.chainid == DESTINATION_CHAIN_ID) revert StickySourceCollector_SourceOnly(block.chainid);
        _requireRoute({sourceProjectId: sourceProjectId, sucker: sucker, backingToken: backingToken});
        address receiver = RECEIVER_FACTORY.predictReceiverOf({stickyToken: stickyToken, groupId: groupId});

        // Debit only this destination before state-changing external calls; any later revert restores the whole bucket.
        _debit({sourceProjectId: sourceProjectId, stickyToken: stickyToken, groupId: groupId, amount: amount});
        IERC20 sourceToken = _materializeToken({sourceProjectId: sourceProjectId, amount: amount});
        uint256 minimumReclaimed;
        (leafIndex, minimumReclaimed) = _prepare({
            sourceProjectId: sourceProjectId,
            sourceToken: sourceToken,
            amount: amount,
            sucker: sucker,
            backingToken: backingToken,
            receiver: receiver
        });

        // The child has no source allowance; fee-triggered reserve callbacks can only add attributed parent custody.
        (uint256 feeTokenCount, uint256 refundedFee, uint256 refundedTransportPayment) = FEE_PAYER.send{
            value: msg.value
        }({
            sucker: sucker, backingToken: backingToken, beneficiary: payable(msg.sender)
        });
        uint256 sentCount = sucker.outboxOf(backingToken).numberOfClaimsSent;
        if (sentCount <= leafIndex) {
            revert StickySourceCollector_UnsentLeaf({index: leafIndex, sentCount: sentCount});
        }
        _requireCustody({sourceProjectId: sourceProjectId, required: totalPendingOf[sourceProjectId]});

        // Report success only after this leaf is included and all remaining destinations are still covered.
        // forge-lint: disable-next-item(reentrancy-events)
        emit Send({
            sourceProjectId: sourceProjectId,
            stickyToken: stickyToken,
            groupId: groupId,
            sucker: sucker,
            backingToken: backingToken,
            index: leafIndex,
            projectTokenCount: amount,
            minimumReclaimed: minimumReclaimed,
            feeTokenCount: feeTokenCount,
            refundedFee: refundedFee,
            refundedTransportPayment: refundedTransportPayment,
            caller: msg.sender
        });
    }

    /// @notice Delivers part of a home-chain bucket into its fixed receiver and settles that receiver's full inventory.
    /// @dev No bridge fee is required. The existing receiver can also hold earlier arrivals, so the returned settled
    /// amount can exceed the amount debited here. Any failed credit claim, transfer or settlement restores the bucket.
    /// @param sourceProjectId The home-chain project whose reserved rewards were accepted.
    /// @param stickyToken The home-chain Sticky share token whose holders receive the selected bucket.
    /// @param groupId The bucket's destination reward group.
    /// @param amount The positive project-token atoms to deliver from this bucket.
    /// @return settled The reward-token atoms settled, including existing receiver inventory.
    function settle(
        uint256 sourceProjectId,
        address stickyToken,
        uint256 groupId,
        uint256 amount
    )
        external
        override
        nonReentrant
        returns (uint256 settled)
    {
        // Local settlement shares the outbound guard and cannot run inside any inbound receipt measurement.
        _requireNotAccepting();
        if (block.chainid != DESTINATION_CHAIN_ID) revert StickySourceCollector_DestinationOnly(block.chainid);
        address receiver = RECEIVER_FACTORY.predictReceiverOf({stickyToken: stickyToken, groupId: groupId});
        _debit({sourceProjectId: sourceProjectId, stickyToken: stickyToken, groupId: groupId, amount: amount});
        IERC20 sourceToken = _materializeToken({sourceProjectId: sourceProjectId, amount: amount});

        // The factory's existing receiver fixes the reward pool and group; the caller supplies no arbitrary recipient.
        sourceToken.safeTransfer({to: receiver, value: amount});
        settled = RECEIVER_FACTORY.settleFor({stickyToken: stickyToken, groupId: groupId, token: sourceToken});
        _requireCustody({sourceProjectId: sourceProjectId, required: totalPendingOf[sourceProjectId]});

        // The complete receiver inventory has settled without reducing another pending destination's backing.
        // forge-lint: disable-next-item(reentrancy-events)
        emit Settle({
            sourceProjectId: sourceProjectId,
            stickyToken: stickyToken,
            groupId: groupId,
            amount: amount,
            settled: settled,
            caller: msg.sender
        });
    }

    //*********************************************************************//
    // ----------------------- external views ---------------------------- //
    //*********************************************************************//

    /// @notice Reports the ERC-165 and reserved split-hook interfaces implemented by this contract.
    /// @param interfaceId The interface identifier being queried.
    /// @return supported Whether this contract implements the requested interface.
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool supported) {
        return interfaceId == type(IJBSplitHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Accepts one split's assets while excluding project custody already credited by nested callbacks.
    /// @dev Outbound calls are blocked throughout the surrounding acceptance depth, so nested liabilities only grow.
    /// Combined token and credit balances also cover a nested credit allocation made while an ERC-20 pull is active.
    /// @param context The authenticated controller context, including the source asset and nominal amount.
    /// @return amount The project-token atoms attributable to this callback alone.
    function _acceptFrom(JBSplitHookContext calldata context) internal returns (uint256 amount) {
        // Core already moved credits before invoking the hook; the caller checks total custody before booking them.
        if (context.token == address(0)) return context.amount;

        // Capture custody and liabilities together so a nested reserved allocation is never counted twice.
        uint256 custodyBefore = TOKENS.totalBalanceOf({holder: address(this), projectId: context.projectId});
        uint256 pendingBefore = totalPendingOf[context.projectId];
        IERC20(context.token).safeTransferFrom({from: msg.sender, to: address(this), value: context.amount});
        uint256 custodyAfter = TOKENS.totalBalanceOf({holder: address(this), projectId: context.projectId});
        uint256 pendingAfter = totalPendingOf[context.projectId];

        // Unexpected decreases or uncovered nested receipts cannot be hidden by unsigned subtraction.
        if (
            custodyAfter < custodyBefore || pendingAfter < pendingBefore
                || custodyAfter - custodyBefore < pendingAfter - pendingBefore
        ) {
            revert StickySourceCollector_UnexpectedReceipt({
                sourceProjectId: context.projectId,
                custodyBefore: custodyBefore,
                custodyAfter: custodyAfter,
                pendingBefore: pendingBefore,
                pendingAfter: pendingAfter
            });
        }
        return (custodyAfter - custodyBefore) - (pendingAfter - pendingBefore);
    }

    /// @notice Debits a positive delivery from only its source project's selected destination bucket.
    /// @param sourceProjectId The project whose pending custody is being spent.
    /// @param stickyToken The home-chain Sticky share token identifying the destination.
    /// @param groupId The destination reward group.
    /// @param amount The project-token atoms to debit.
    function _debit(uint256 sourceProjectId, address stickyToken, uint256 groupId, uint256 amount) internal {
        // Positive bounded debits prevent callers from spending donations or another destination's allocation.
        if (amount == 0) revert StickySourceCollector_InvalidAmount(amount);
        uint256 pending = pendingOf[sourceProjectId][stickyToken][groupId];
        if (amount > pending) {
            revert StickySourceCollector_InsufficientPending({
                sourceProjectId: sourceProjectId,
                stickyToken: stickyToken,
                groupId: groupId,
                requested: amount,
                pending: pending
            });
        }
        uint256 totalPending = totalPendingOf[sourceProjectId];
        _requireCustody({sourceProjectId: sourceProjectId, required: totalPending});

        // Reduce liabilities before credit claims, token transfers, bridge calls or fee callbacks can execute.
        pendingOf[sourceProjectId][stickyToken][groupId] = pending - amount;
        totalPendingOf[sourceProjectId] = totalPending - amount;
    }

    /// @notice Materializes only the ERC-20 shortfall needed to deliver an already debited amount.
    /// @dev Credits remain queued until the project has an ERC-20. Claiming to this contract preserves destination
    /// attribution; unused credits and token donations are never assigned to a caller-selected beneficiary.
    /// @param sourceProjectId The project whose held credits may need conversion.
    /// @param amount The project-token atoms required for this delivery.
    /// @return token The project's deployed ERC-20 containing enough tokens for the delivery.
    function _materializeToken(uint256 sourceProjectId, uint256 amount) internal returns (IERC20 token) {
        // A missing ERC-20 is a retryable delivery failure and cannot discard an accepted credit allocation.
        token = IERC20(address(TOKENS.tokenOf(sourceProjectId)));
        if (address(token).code.length == 0) revert StickySourceCollector_NoToken(sourceProjectId);
        uint256 balance = token.balanceOf(address(this));
        if (balance >= amount) return token;

        // Claim only what this delivery needs; core authenticates this contract as the holder of the credits.
        IJBController(address(DIRECTORY.controllerOf(sourceProjectId)))
            .claimTokensFor({
                holder: address(this),
                projectId: sourceProjectId,
                tokenCount: amount - balance,
                beneficiary: address(this)
            });
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance < amount) {
            revert StickySourceCollector_UnexpectedClaimBalance({
                sourceProjectId: sourceProjectId, expected: amount, actual: afterBalance
            });
        }
    }

    /// @notice Quotes backing and prepares exactly one fixed-receiver leaf for the selected project-token amount.
    /// @param sourceProjectId The project whose rewards will be cashed out.
    /// @param sourceToken The source project's registered ERC-20.
    /// @param amount The project-token atoms to approve and prepare.
    /// @param sucker The authenticated, sending-enabled source sucker.
    /// @param backingToken The mapped terminal asset being reclaimed and bridged.
    /// @param receiver The fixed home-chain receiver predicted for the bucket's Sticky token and group.
    /// @return leafIndex The leaf's index in the backing asset's source outbox.
    /// @return minimumReclaimed The conservative preview bound, in backing-token atoms, including zero backing.
    function _prepare(
        uint256 sourceProjectId,
        IERC20 sourceToken,
        uint256 amount,
        IJBSucker sucker,
        address backingToken,
        address receiver
    )
        internal
        returns (uint256 leafIndex, uint256 minimumReclaimed)
    {
        // Use the same primary terminal, holder and beneficiary as the sucker's actual cashout.
        IJBTerminal terminal = DIRECTORY.primaryTerminalOf({projectId: sourceProjectId, token: backingToken});
        if (address(terminal) == address(0)) {
            revert StickySourceCollector_NoTerminal({sourceProjectId: sourceProjectId, backingToken: backingToken});
        }
        // Only the gross return sets the bound; ruleset and hook interpretation stay with the terminal.
        // forge-lint: disable-next-item(unused-return)
        // slither-disable-next-line unused-return
        (, uint256 grossReclaimed,,) = IJBCashOutTerminal(address(terminal))
            .previewCashOutFrom({
                holder: address(sucker),
                projectId: sourceProjectId,
                cashOutCount: amount,
                tokenToReclaim: backingToken,
                beneficiary: payable(address(sucker)),
                metadata: ""
            });
        minimumReclaimed = grossReclaimed - JBFees.standardFeeAmountFrom(grossReclaimed);

        // Bound both custody spend and leaf identity, then leave no allowance for a later external call.
        leafIndex = sucker.outboxOf(backingToken).tree.count;
        sourceToken.forceApprove({spender: address(sucker), value: amount});
        sucker.prepare({
            projectTokenCount: amount,
            beneficiary: bytes32(uint256(uint160(receiver))),
            minTokensReclaimed: minimumReclaimed,
            token: backingToken,
            metadata: bytes32(0)
        });
        sourceToken.forceApprove({spender: address(sucker), value: 0});
        uint256 nextCount = sucker.outboxOf(backingToken).tree.count;
        if (nextCount != leafIndex + 1) {
            revert StickySourceCollector_UnexpectedLeafCount({expected: leafIndex + 1, actual: nextCount});
        }
    }

    //*********************************************************************//
    // -------------------------- internal views ------------------------- //
    //*********************************************************************//

    /// @notice Requires enough combined ERC-20 and credit custody to cover the specified project-token liabilities.
    /// @param sourceProjectId The source project whose custody is checked.
    /// @param required The project-token atoms that must remain covered.
    function _requireCustody(uint256 sourceProjectId, uint256 required) internal view {
        uint256 available = TOKENS.totalBalanceOf({holder: address(this), projectId: sourceProjectId});
        if (available < required) {
            revert StickySourceCollector_InsufficientCustody({
                sourceProjectId: sourceProjectId, available: available, required: required
            });
        }
    }

    /// @notice Prevents outbound mutations while any acceptance callback is measuring incoming project custody.
    function _requireNotAccepting() internal view {
        if (_acceptanceDepth != 0) {
            revert StickySourceCollector_InboundTransfer({caller: msg.sender, depth: _acceptanceDepth});
        }
    }

    /// @notice Authenticates a usable source route and backing mapping against independently bound canonical contracts.
    /// @dev Sending-enabled pending deprecation is permitted exactly as in the sucker. Peer configuration and actual
    /// home-chain reward-token readiness remain source-project setup responsibilities, not caller-selected
    /// destinations.
    /// @param sourceProjectId The project whose queued rewards are being sent.
    /// @param sucker The supplied registered source route.
    /// @param backingToken The mapped source terminal asset selected for transport.
    function _requireRoute(uint256 sourceProjectId, IJBSucker sucker, address backingToken) internal view {
        // Authenticate membership before trusting any of the candidate's self-reported protocol bindings.
        if (
            address(sucker).code.length == 0
                || !REGISTRY.isSuckerOf({projectId: sourceProjectId, addr: address(sucker)})
        ) {
            revert StickySourceCollector_InvalidRoute({sourceProjectId: sourceProjectId, sucker: sucker});
        }
        // The installed sucker interface omits its registry getter; keep that concrete access inside validation.
        if (
            sucker.projectId() != sourceProjectId || JBSucker(payable(address(sucker))).REGISTRY() != REGISTRY
                || sucker.DIRECTORY() != DIRECTORY || sucker.TOKENS() != TOKENS
                || sucker.peerChainId() != DESTINATION_CHAIN_ID || sucker.peer() == bytes32(0)
        ) revert StickySourceCollector_InvalidRoute({sourceProjectId: sourceProjectId, sucker: sucker});

        // Retired registration can retain mint authority, so sending eligibility needs its own live state check.
        JBSuckerState state = sucker.state();
        if (state == JBSuckerState.SENDING_DISABLED || state == JBSuckerState.DEPRECATED) {
            revert StickySourceCollector_SuckerNotSending({sucker: sucker, state: state});
        }
        JBRemoteToken memory remoteToken = sucker.remoteTokenFor(backingToken);
        if (!remoteToken.enabled || remoteToken.emergencyHatch || remoteToken.addr == bytes32(0)) {
            revert StickySourceCollector_InvalidMapping({
                sucker: sucker, backingToken: backingToken, remoteToken: remoteToken
            });
        }
    }
}
