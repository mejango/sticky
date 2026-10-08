// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {JBSuckerState} from "@bananapus/suckers-v6/src/enums/JBSuckerState.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";
import {JBOutboxTree} from "@bananapus/suckers-v6/src/structs/JBOutboxTree.sol";
import {JBRemoteToken} from "@bananapus/suckers-v6/src/structs/JBRemoteToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {StickySourceToken} from "./StickySourceToken.sol";
import {StickySourceTokens} from "./StickySourceTokens.sol";

/// @notice A source route fixture with real project-token burns, per-backing outboxes and separate native refund
/// ledgers.
/// @dev Transport finality and backing escrow are outside this fixture; token custody and callback rollback are real.
contract StickySourceSucker {
    // Keep principal movement subject to the token's actual allowance and balance rules.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when configured preparation, transport or refund behavior rejects the current attempt.
    error StickySourceSucker_Rejected();

    //*********************************************************************//
    // ------------------------- public constants ------------------------ //
    //*********************************************************************//

    /// @notice The project whose token is issued as a bridge-fee receipt.
    uint256 public constant FEE_PROJECT_ID = 1;

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The canonical directory reported for route authentication.
    IJBDirectory public immutable DIRECTORY;

    /// @notice The registry that supplies the submission fee and authenticates this route.
    IJBSuckerRegistry public immutable REGISTRY;

    /// @notice The registry that resolves source and fee-project tokens.
    StickySourceTokens public immutable TOKENS;

    //*********************************************************************//
    // -------------- internal immutable stored properties -------------- //
    //*********************************************************************//

    /// @notice The source project whose tokens this route prepares for reminting.
    uint256 internal immutable _PROJECT_ID;

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The parent's source-token allowance observed before preparation spends it.
    uint256 public allowanceAtPrepare;

    /// @notice The parent's source-token allowance observed when transport is submitted.
    uint256 public allowanceAtSend;

    /// @notice The remote beneficiary encoded in the most recently prepared leaf.
    bytes32 public beneficiaryPrepared;

    /// @notice The number of configured callbacks attempted in committed state.
    uint256 public callbackCount;

    /// @notice The return or revert data from the most recently attempted callback.
    bytes public callbackReason;

    /// @notice Whether the most recently attempted callback succeeded.
    bool public callbackSucceeded;

    /// @notice The account whose retained registry fee was most recently claimed.
    address public claimedAccount;

    /// @notice The beneficiary of the most recent retained registry-fee claim.
    address public claimedBeneficiary;

    /// @notice The account whose retained transport refund was most recently claimed.
    address public claimedTransportAccount;

    /// @notice The beneficiary of the most recent retained transport-refund claim.
    address public claimedTransportBeneficiary;

    /// @notice The caller that most recently prepared principal for transport.
    address public collector;

    /// @notice The attribution metadata encoded in the most recently prepared leaf.
    bytes32 public metadataPrepared;

    /// @notice The backing-token cashout floor passed to the most recent preparation.
    uint256 public minimumPrepared;

    /// @notice The remote route identity reported for authentication.
    bytes32 public peer = bytes32(uint256(1));

    /// @notice The destination chain identity reported for authentication.
    uint256 public peerChainId = 1;

    /// @notice The number of preparations completed in committed state.
    uint256 public prepareCalls;

    /// @notice The project-token atoms pulled and burned by the most recent preparation.
    uint256 public principalPrepared;

    /// @notice The failed registry-fee payments owed to each caller.
    /// @custom:param account The caller whose failed registry payment was retained.
    mapping(address account => uint256 amount) public retainedToRemoteFeeOf;

    /// @notice The rejected direct transport refunds owed to each caller.
    /// @custom:param account The caller whose transport refund was retained.
    mapping(address account => uint256 amount) public retainedTransportPaymentRefundOf;

    /// @notice The account that most recently submitted transport.
    address public sender;

    /// @notice The native value attached to the most recent transport submission, in wei.
    uint256 public sendValue;

    /// @notice The route lifecycle state reported for authentication.
    JBSuckerState public state = JBSuckerState.ENABLED;

    /// @notice The backing asset selected for the most recent preparation.
    address public tokenPrepared;

    /// @notice The backing asset selected for the most recent transport submission.
    address public tokenSent;

    //*********************************************************************//
    // -------------------- internal stored properties ------------------- //
    //*********************************************************************//

    /// @notice The calldata used by the configured callback.
    bytes internal _callbackData;

    /// @notice Whether the configured callback runs during preparation instead of fee submission.
    bool internal _callbackDuringPrepare;

    /// @notice The contract called by the configured callback, or zero to disable it.
    address internal _callbackTarget;

    /// @notice The fee-token atoms burned from the submitting child during transport.
    uint256 internal _consumedDonation;

    /// @notice Whether the registry fee is retained instead of issuing fee-project tokens.
    bool internal _failFee;

    /// @notice Whether claiming a retained registry fee reverts.
    bool internal _failFeeRefund;

    /// @notice Whether preparation reverts after changing principal and the outbox.
    bool internal _failPrepare;

    /// @notice Whether transport reverts after fee and callback effects.
    bool internal _failTransport;

    /// @notice Whether claiming a retained transport refund reverts.
    bool internal _failTransportRefund;

    /// @notice The number of leaves appended by each preparation.
    uint256 internal _leavesAdded = 1;

    /// @notice Whether transport reports a sent frontier that excludes the most recent leaf.
    bool internal _leaveUnsent;

    /// @notice The independent outbox state for each backing asset.
    /// @custom:param backing The backing asset whose prepared leaves and submission frontier are stored.
    mapping(address backing => JBOutboxTree outbox) internal _outboxOf;

    /// @notice The fee-project token atoms minted for a successful nonzero registry payment.
    uint256 internal _receipt;

    /// @notice The configured remote mapping for each backing asset.
    /// @custom:param backing The source backing asset whose remote representation is stored.
    mapping(address backing => JBRemoteToken remoteToken) internal _remoteTokenFor;

    /// @notice Whether either claim incorrectly leaves one wei of retained credit.
    bool internal _residualRefund;

    /// @notice The transport budget returned directly or retained for the caller, in wei.
    uint256 internal _transportRefund;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Binds the route identities and stateful source-token registry.
    /// @param registry The registry used for route authentication and current fees.
    /// @param directory The canonical project directory reported by this route.
    /// @param tokens The registry whose project-token balances are actually moved.
    /// @param sourceProjectId The source project whose tokens are prepared.
    constructor(
        IJBSuckerRegistry registry,
        IJBDirectory directory,
        StickySourceTokens tokens,
        uint256 sourceProjectId
    ) {
        REGISTRY = registry;
        DIRECTORY = directory;
        TOKENS = tokens;
        _PROJECT_ID = sourceProjectId;
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Claims the caller's retained registry payment directly to its selected beneficiary.
    /// @dev Credit is cleared before the external native transfer so a callback cannot reuse it.
    /// @param beneficiary The account receiving the retained payment.
    function claimRetainedToRemoteFee(address payable beneficiary) external {
        if (_failFeeRefund) revert StickySourceSucker_Rejected();
        uint256 amount = retainedToRemoteFeeOf[msg.sender];
        claimedAccount = msg.sender;
        claimedBeneficiary = beneficiary;
        retainedToRemoteFeeOf[msg.sender] = _residualRefund ? 1 : 0;
        _refund({beneficiary: beneficiary, amount: amount});
    }

    /// @notice Claims the caller's retained transport refund directly to its selected beneficiary.
    /// @dev This ledger is separate from registry-fee credit and is cleared before the external native transfer.
    /// @param beneficiary The account receiving the retained transport refund.
    function claimRetainedTransportPaymentRefund(address payable beneficiary) external {
        if (_failTransportRefund) revert StickySourceSucker_Rejected();
        uint256 amount = retainedTransportPaymentRefundOf[msg.sender];
        claimedTransportAccount = msg.sender;
        claimedTransportBeneficiary = beneficiary;
        retainedTransportPaymentRefundOf[msg.sender] = _residualRefund ? 1 : 0;
        _refund({beneficiary: beneficiary, amount: amount});
    }

    /// @notice Pulls and burns real project tokens before appending the configured backing-asset leaves.
    /// @dev Outbox counters and a frontier slot mutate together so rollback assertions cover both forms of state.
    /// @param projectTokenCount The project-token atoms pulled and burned.
    /// @param beneficiary The destination beneficiary committed to the leaf.
    /// @param minTokensReclaimed The backing-token atoms credited to the modeled outbox.
    /// @param token The backing asset selected for the leaf.
    /// @param metadata The attribution metadata committed to the leaf.
    function prepare(
        uint256 projectTokenCount,
        bytes32 beneficiary,
        uint256 minTokensReclaimed,
        address token,
        bytes32 metadata
    )
        external
    {
        StickySourceToken sourceToken = StickySourceToken(address(TOKENS.tokenOf(_PROJECT_ID)));
        collector = msg.sender;
        allowanceAtPrepare = sourceToken.allowance({owner: msg.sender, spender: address(this)});
        IERC20(address(sourceToken)).safeTransferFrom({from: msg.sender, to: address(this), value: projectTokenCount});
        sourceToken.burn({account: address(this), amount: projectTokenCount});
        beneficiaryPrepared = beneficiary;
        metadataPrepared = metadata;
        minimumPrepared = minTokensReclaimed;
        principalPrepared = projectTokenCount;
        tokenPrepared = token;
        prepareCalls++;

        // Make nested execution observable after principal has actually left the collector.
        if (_callbackDuringPrepare) _callback();
        JBOutboxTree storage outbox = _outboxOf[token];
        outbox.tree.branch[0] = keccak256(abi.encode(projectTokenCount, beneficiary, minTokensReclaimed, metadata));
        outbox.tree.count += _leavesAdded;
        outbox.balance += minTokensReclaimed;
        if (_failPrepare) revert StickySourceSucker_Rejected();
    }

    /// @notice Selects fee, transport and refund behavior for subsequent submissions.
    /// @param failFee Whether the registry payment becomes retained caller credit.
    /// @param failTransport Whether transport reverts after its callback and fee effects.
    /// @param leaveUnsent Whether the sent frontier excludes the newest prepared leaf.
    /// @param receipt The fee-project token atoms issued for a successful nonzero fee.
    /// @param transportRefund The native transport budget returned to the submitting caller, in wei.
    function setBehavior(
        bool failFee,
        bool failTransport,
        bool leaveUnsent,
        uint256 receipt,
        uint256 transportRefund
    )
        external
    {
        _failFee = failFee;
        _failTransport = failTransport;
        _leaveUnsent = leaveUnsent;
        _receipt = receipt;
        _transportRefund = transportRefund;
    }

    /// @notice Selects the external callback attempted during preparation or fee submission.
    /// @param target The contract to call, or zero to disable callbacks.
    /// @param data The calldata passed to the callback target.
    /// @param duringPrepare Whether to run during preparation instead of fee submission.
    function setCallback(address target, bytes calldata data, bool duringPrepare) external {
        _callbackTarget = target;
        _callbackData = data;
        _callbackDuringPrepare = duringPrepare;
        callbackSucceeded = false;
        delete callbackReason;
    }

    /// @notice Selects how many preexisting fee-token atoms transport consumes from the submitting child.
    /// @param amount The token atoms burned from the child during submission.
    function setConsumedDonation(uint256 amount) external {
        _consumedDonation = amount;
    }

    /// @notice Sets the route's reported backing-token mapping.
    /// @param backing The source backing asset.
    /// @param remoteToken The mapped remote representation and lifecycle flags.
    function setMapping(address backing, JBRemoteToken calldata remoteToken) external {
        _remoteTokenFor[backing] = remoteToken;
    }

    /// @notice Seeds an existing backing-asset outbox and its transported frontier.
    /// @param backing The backing asset whose outbox is initialized.
    /// @param count The prepared leaf count.
    /// @param sent The transported leaf count.
    /// @param balance The backing-token atoms awaiting transport.
    /// @param nonce The prior transport nonce.
    function setOutbox(address backing, uint256 count, uint192 sent, uint256 balance, uint64 nonce) external {
        JBOutboxTree storage outbox = _outboxOf[backing];
        outbox.tree.count = count;
        outbox.numberOfClaimsSent = sent;
        outbox.balance = balance;
        outbox.nonce = nonce;
        // Keep a nonempty frontier so reverted attempts cannot silently erase earlier prepared claims.
        outbox.tree.branch[0] = keccak256(abi.encode(count, sent, balance, nonce));
    }

    /// @notice Selects preparation's leaf-count and failure behavior.
    /// @param leavesAdded The number of leaves appended by each prepare call.
    /// @param failPrepare Whether preparation reverts after modifying custody and outbox state.
    function setPrepareBehavior(uint256 leavesAdded, bool failPrepare) external {
        _leavesAdded = leavesAdded;
        _failPrepare = failPrepare;
    }

    /// @notice Selects claim failures or an incomplete retained-credit cleanup.
    /// @param failFeeRefund Whether registry-fee claims revert.
    /// @param failTransportRefund Whether transport-refund claims revert.
    /// @param residual Whether either claim leaves one wei of retained credit.
    function setRefundBehavior(bool failFeeRefund, bool failTransportRefund, bool residual) external {
        _failFeeRefund = failFeeRefund;
        _failTransportRefund = failTransportRefund;
        _residualRefund = residual;
    }

    /// @notice Seeds registry-fee credit for an account without changing native custody.
    /// @param account The credit owner.
    /// @param amount The retained registry payment, in wei.
    function setRetainedFee(address account, uint256 amount) external {
        retainedToRemoteFeeOf[account] = amount;
    }

    /// @notice Seeds transport-refund credit for an account without changing native custody.
    /// @param account The credit owner.
    /// @param amount The retained transport refund, in wei.
    function setRetainedTransport(address account, uint256 amount) external {
        retainedTransportPaymentRefundOf[account] = amount;
    }

    /// @notice Changes the route identity and lifecycle reported to the collector.
    /// @param routeState The lifecycle state reported for sending admission.
    /// @param chainId The reported destination chain ID.
    /// @param remotePeer The reported destination route address.
    function setRoute(JBSuckerState routeState, uint256 chainId, bytes32 remotePeer) external {
        state = routeState;
        peerChainId = chainId;
        peer = remotePeer;
    }

    /// @notice Processes fee effects and submits the selected backing-asset outbox in one transaction.
    /// @dev Direct native refund rejection creates caller-scoped credit, matching the child payer's no-receive path.
    /// @param token The backing asset whose outbox is submitted.
    function toRemote(address token) external payable {
        uint256 fee = REGISTRY.toRemoteFee();
        if (msg.value < fee || _transportRefund > msg.value - fee) revert StickySourceSucker_Rejected();
        sender = msg.sender;
        sendValue = msg.value;
        tokenSent = token;
        allowanceAtSend =
            IERC20(address(TOKENS.tokenOf(_PROJECT_ID))).allowance({owner: collector, spender: address(this)});

        // Fee receipts belong to the submitting child; reserved allocations reached by the callback belong elsewhere.
        StickySourceToken feeToken = StickySourceToken(address(TOKENS.tokenOf(FEE_PROJECT_ID)));
        if (fee != 0) {
            if (_failFee) retainedToRemoteFeeOf[msg.sender] += fee;
            else if (_receipt != 0) feeToken.mint({account: msg.sender, amount: _receipt});
        }
        // Debit after receipt issuance so tests can lower the final balance below prior donations without failing
        // inside the token before the fee payer checks its own custody floor.
        if (_consumedDonation != 0) feeToken.burn({account: msg.sender, amount: _consumedDonation});
        if (!_callbackDuringPrepare) _callback();

        if (_transportRefund != 0) {
            // A child without a receive handler keeps refund attribution in the route's separate ledger.
            // forge-lint: disable-next-line(low-level-calls,arbitrary-send-eth)
            (bool success,) = payable(msg.sender).call{value: _transportRefund}("");
            if (!success) retainedTransportPaymentRefundOf[msg.sender] += _transportRefund;
        }
        if (_failTransport) revert StickySourceSucker_Rejected();

        // A successful older root must remain distinguishable from a submission that includes the new leaf.
        JBOutboxTree storage outbox = _outboxOf[token];
        outbox.numberOfClaimsSent = SafeCast.toUint192(outbox.tree.count - (_leaveUnsent ? 1 : 0));
        outbox.nonce++;
        outbox.balance = 0;
    }

    //*********************************************************************//
    // ------------------------- external views -------------------------- //
    //*********************************************************************//

    /// @notice Returns the selected backing asset's stateful outbox.
    /// @param backing The backing asset whose outbox is queried.
    /// @return outbox The current leaf frontier, queued backing and transported count.
    function outboxOf(address backing) external view returns (JBOutboxTree memory outbox) {
        return _outboxOf[backing];
    }

    /// @notice Returns the source project whose token is burned during preparation.
    /// @return id The source project ID.
    function projectId() external view returns (uint256 id) {
        return _PROJECT_ID;
    }

    /// @notice Returns the configured mapping for a backing asset.
    /// @param backing The source backing asset whose mapping is queried.
    /// @return remoteToken The mapped remote representation and lifecycle flags.
    function remoteTokenFor(address backing) external view returns (JBRemoteToken memory remoteToken) {
        return _remoteTokenFor[backing];
    }

    //*********************************************************************//
    // ---------------------- internal transactions ---------------------- //
    //*********************************************************************//

    /// @notice Captures a configured callback's result without converting callback rejection into transport failure.
    /// @dev The target is temporarily disarmed so a missing caller guard cannot cause unbounded fixture recursion.
    function _callback() internal {
        address target = _callbackTarget;
        if (target == address(0)) return;
        _callbackTarget = address(0);
        callbackCount++;
        // Arbitrary callback calldata lets tests exercise actual controller distribution and reentrancy paths.
        // forge-lint: disable-next-line(low-level-calls)
        (bool success, bytes memory reason) = target.call(_callbackData);
        callbackSucceeded = success;
        callbackReason = reason;
        _callbackTarget = target;
    }

    /// @notice Sends the selected refund and surfaces a beneficiary rejection.
    /// @param beneficiary The account receiving the native refund.
    /// @param amount The refund amount, in wei.
    function _refund(address payable beneficiary, uint256 amount) internal {
        // Failure reverts the caller's full prepare-and-send attempt, including all custody and outbox changes.
        // forge-lint: disable-next-line(low-level-calls,arbitrary-send-eth)
        (bool success,) = beneficiary.call{value: amount}("");
        if (!success) revert StickySourceSucker_Rejected();
    }
}
