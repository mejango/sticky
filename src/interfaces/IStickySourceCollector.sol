// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJBDirectory} from "@bananapus/core-v6/src/interfaces/IJBDirectory.sol";
import {IJBSplitHook} from "@bananapus/core-v6/src/interfaces/IJBSplitHook.sol";
import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBTokens} from "@bananapus/core-v6/src/interfaces/IJBTokens.sol";
import {IJBSucker} from "@bananapus/suckers-v6/src/interfaces/IJBSucker.sol";
import {IJBSuckerRegistry} from "@bananapus/suckers-v6/src/interfaces/IJBSuckerRegistry.sol";

import {IStickyRewardReceiverFactory} from "./IStickyRewardReceiverFactory.sol";
import {IStickySourceFeePayer} from "./IStickySourceFeePayer.sol";

/// @notice Accepts V6 reserved project tokens and delivers attributed allocations to Sticky rewards on one home chain.
/// @dev Reserved splits use this hook, their beneficiary as the home-chain Sticky share token, and their projectId as
/// the reward group. Authenticated acceptance queues ERC-20 tokens or credits independently of delivery availability.
/// Permissionless callers can deliver part of a bucket but cannot change its home chain, share token or group.
interface IStickySourceCollector is IJBSplitHook {
    /// @notice Emitted after the fee child's raw-address native balance is contributed to the protocol fee project.
    /// @param terminal The protocol fee project's primary native terminal that received the balance.
    /// @param amount The native balance contributed, in wei.
    /// @param caller The account that permissionlessly executed the contribution.
    event AddFeeRefundToBalance(IJBTerminal indexed terminal, uint256 amount, address caller);

    /// @notice Emitted when an authenticated reserved allocation enters its destination's pending custody.
    /// @param sourceProjectId The source project whose ERC-20 tokens or credits arrived.
    /// @param stickyToken The home-chain Sticky share token whose holders receive the allocation.
    /// @param groupId The destination reward group.
    /// @param receiver The predicted home-chain receiver bound to that Sticky token and group.
    /// @param amount The newly accepted project-token atoms, excluding nested accepted allocations.
    /// @param caller The source controller that authenticated the split.
    event Queue(
        uint256 indexed sourceProjectId,
        address indexed stickyToken,
        uint256 indexed groupId,
        address receiver,
        uint256 amount,
        address caller
    );

    /// @notice Emitted after a queued allocation's leaf is included in a submitted source outbox root.
    /// @param sourceProjectId The source project whose rewards were prepared.
    /// @param stickyToken The home-chain Sticky share token whose holders receive the rewards.
    /// @param groupId The destination reward group.
    /// @param sucker The registered source route used for this submission.
    /// @param backingToken The terminal token cashed out and transported through the sucker.
    /// @param index The prepared leaf index used with the sucker's leaf event to construct a destination claim.
    /// @param projectTokenCount The project-token atoms debited from the selected bucket.
    /// @param minimumReclaimed The fresh fee-adjusted reclaim minimum, in backing-token atoms; it can be zero.
    /// @param feeTokenCount The fee-project token atoms returned to the caller for this payment.
    /// @param refundedFee The failed registry fee retained on the source sucker and returned during this call, in wei.
    /// @param refundedTransportPayment The excess transport value retained on the source sucker and returned during
    /// this call, in wei.
    /// @param caller The account that funded the source submission.
    event Send(
        uint256 indexed sourceProjectId,
        address indexed stickyToken,
        uint256 indexed groupId,
        IJBSucker sucker,
        address backingToken,
        uint256 index,
        uint256 projectTokenCount,
        uint256 minimumReclaimed,
        uint256 feeTokenCount,
        uint256 refundedFee,
        uint256 refundedTransportPayment,
        address caller
    );

    /// @notice Emitted after a local allocation and the receiver's existing inventory settle into Sticky rewards.
    /// @param sourceProjectId The local project whose queued reward tokens were delivered.
    /// @param stickyToken The home-chain Sticky share token whose holders receive the rewards.
    /// @param groupId The destination reward group.
    /// @param amount The project-token atoms debited from the selected bucket.
    /// @param settled The total reward-token atoms settled, including existing receiver inventory.
    /// @param caller The account that executed settlement.
    event Settle(
        uint256 indexed sourceProjectId,
        address indexed stickyToken,
        uint256 indexed groupId,
        uint256 amount,
        uint256 settled,
        address caller
    );

    /// @notice The immutable home chain where every configured destination receives and settles rewards.
    /// @return chainId The nonzero destination chain ID.
    function DESTINATION_CHAIN_ID() external view returns (uint256 chainId);

    /// @notice The canonical directory that authenticates source controllers and cashout terminals.
    /// @return directory The directory derived from the collector's sucker registry.
    function DIRECTORY() external view returns (IJBDirectory directory);

    /// @notice The isolated fee payer that returns caller refunds and holds native currency credited to its raw
    /// address for the fixed destination contribution.
    /// @return feePayer The child permanently authorized to serve this collector.
    function FEE_PAYER() external view returns (IStickySourceFeePayer feePayer);

    /// @notice The receiver factory whose address and implementation match the configured home-chain factory.
    /// @return receiverFactory The factory that validates groups and predicts each destination receiver.
    function RECEIVER_FACTORY() external view returns (IStickyRewardReceiverFactory receiverFactory);

    /// @notice The canonical registry used to authenticate caller-selected source routes.
    /// @return registry The independently bound sucker registry.
    function REGISTRY() external view returns (IJBSuckerRegistry registry);

    /// @notice The canonical registry used for source ERC-20 identity, credits and combined custody.
    /// @return tokens The project-token registry.
    function TOKENS() external view returns (IJBTokens tokens);

    /// @notice The accepted project-token atoms awaiting delivery for one fixed destination bucket.
    /// @param sourceProjectId The source project whose reserved tokens or credits were accepted.
    /// @param stickyToken The home-chain Sticky share token whose holders receive the allocation.
    /// @param groupId The destination reward group.
    /// @return amount The attributed ERC-20 and credit amount, in 18-decimal project-token atoms.
    function pendingOf(
        uint256 sourceProjectId,
        address stickyToken,
        uint256 groupId
    )
        external
        view
        returns (uint256 amount);

    /// @notice The project-token atoms owed across every destination bucket for one source project.
    /// @param sourceProjectId The source project whose attributed liabilities are totaled.
    /// @return amount The aggregate pending amount, covered by combined held ERC-20 tokens and credits.
    function totalPendingOf(uint256 sourceProjectId) external view returns (uint256 amount);

    /// @notice Contributes the destination fee child's complete raw-address native balance to project 1.
    /// @dev Anyone can call on this collector's configured destination chain. The project, native token and terminal
    /// source are fixed, so the caller cannot redirect the balance. The original caller is not reimbursed, an aliased
    /// gateway balance is excluded, and a zero balance is a no-op.
    /// @return amount The native balance contributed, in wei.
    function addFeeRefundToBalance() external returns (uint256 amount);

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
        returns (uint256 leafIndex);

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
        returns (uint256 settled);
}
