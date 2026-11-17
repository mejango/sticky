// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {IJBTerminal} from "@bananapus/core-v6/src/interfaces/IJBTerminal.sol";
import {IJBSucker} from "@bananapus/suckers-v6/src/interfaces/IJBSucker.sol";

/// @notice Separates a collector's reserved principal from delivery callers' fee receipts and source-chain native
/// refunds.
/// @dev Only the configured collector can operate this child. It authenticates the source route and fixes the original
/// delivery caller as beneficiary. Existing donations and forced native currency are excluded from each submission.
/// The configured collector can contribute the child's full raw-address native balance to the protocol fee project
/// through a terminal it resolves from the canonical directory. An Arbitrum safe-Inbox alias is a separate account.
interface IStickySourceFeePayer {
    /// @notice Emitted when the deployment authority permanently binds reserved-token custody to this fee payer.
    /// @param collector The collector authorized to operate this fee payer.
    /// @param caller The deployment authority that completed the binding.
    event BindCollector(address indexed collector, address caller);

    /// @notice The only collector authorized to operate this fee payer.
    /// @return collector The permanently bound collector, zero until the one-time setup is completed.
    function COLLECTOR() external view returns (address collector);

    /// @notice The only account allowed to bind the collector once, with no operation authority after binding.
    /// @return deploymentAuthority The explicit deployment-time binding authority.
    function DEPLOYMENT_AUTHORITY() external view returns (address deploymentAuthority);

    /// @notice Contributes this child's full raw-address native balance through the fee project's current primary
    /// native terminal.
    /// @dev Only the configured collector can call. The project, token and held-fee behavior are fixed; the collector
    /// resolves the current terminal through its canonical directory. A zero balance is a no-op. An Arbitrum
    /// safe-Inbox alias is outside this balance.
    /// @param terminal The protocol fee project's current primary native terminal.
    /// @return amount The native balance contributed, in wei.
    function addFeeRefundToBalance(IJBTerminal terminal) external returns (uint256 amount);

    /// @notice Submits the parent's prepared outbox and returns the source-chain transport refund.
    /// @dev Only the bound collector can call. The sucker pays the registry fee's tokens to `beneficiary` directly.
    /// @param sucker The registered sucker authenticated by the parent for this submission.
    /// @param backingToken The mapped backing asset whose prepared outbox the parent is submitting.
    /// @param beneficiary The original caller of the parent's atomic send, who receives the fee project's tokens.
    /// @param messagingGasLimit The destination gas limit the sucker requests from the bridge.
    /// @return refundedTransportPayment The excess transport payment retained on the source sucker and returned during
    /// this call, in wei.
    function send(
        IJBSucker sucker,
        address backingToken,
        address payable beneficiary,
        uint256 messagingGasLimit
    )
        external
        payable
        returns (uint256 refundedTransportPayment);

    /// @notice Permanently binds the deployed collector authorized to operate this fee payer.
    /// @dev Only the explicit deployment authority can call once. The collector must have deployed code and
    /// reciprocally reference this fee payer. Forwarded callers cannot complete this binding.
    /// @param collector The deployed collector to bind permanently.
    function setCollector(address collector) external;
}
