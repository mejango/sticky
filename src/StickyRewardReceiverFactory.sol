// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IStickyDistributor} from "./interfaces/IStickyDistributor.sol";
import {IStickyRewardReceiver} from "./interfaces/IStickyRewardReceiver.sol";
import {IStickyRewardReceiverFactory} from "./interfaces/IStickyRewardReceiverFactory.sol";

/// @notice Creates and locates a separate reward receiver for each Sticky token and reward group, and forwards
/// settlement requests.
/// @dev Funds arrive at the per-(token, group) receiver, whose address identifies the rewarded holder pool and how
/// it is weighed. When needed, this factory deploys a minimal clone of the receiver implementation at the pair's
/// deterministic address, which it predicts before deployment. A funder can bridge sucker-mapped reward tokens
/// to the receiver without adding suckers to the Sticky project itself.
/// @dev Receivers settle ERC-20 balances only. Project-token credits minted by a sucker claim, which is what a
/// destination project without an ERC-20 receives, and native ETH cannot be settled and stay in the receiver.
/// Funders must bridge only to chains where the reward project has an ERC-20 and must not send ETH.
contract StickyRewardReceiverFactory is IStickyRewardReceiverFactory {
    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when a receiver is requested for a group the distributor cannot fund.
    /// @param groupId The unsupported reward group ID.
    error StickyRewardReceiverFactory_InvalidGroupId(uint256 groupId);

    /// @notice Thrown when a receiver is requested for the zero sticky token, which no receiver can be bound to.
    /// @param stickyToken The invalid Sticky share token address.
    error StickyRewardReceiverFactory_InvalidStickyToken(address stickyToken);

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The distributor receivers settle rewards into.
    IStickyDistributor public immutable override DISTRIBUTOR;

    /// @notice The receiver implementation every receiver is cloned from.
    IStickyRewardReceiver public immutable override RECEIVER;

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The receiver deployed for a sticky token and reward group, or the zero address if it hasn't been
    /// deployed yet.
    /// @custom:param stickyToken The sticky token the receiver collects rewards for.
    /// @custom:param groupId The reward group the receiver funds (0 = the default group).
    mapping(address stickyToken => mapping(uint256 groupId => address)) public override receiverOf;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Initializes the factory's receiver implementation.
    /// @param receiver The receiver implementation every receiver is cloned from.
    constructor(IStickyRewardReceiver receiver) {
        // Clone this implementation; its address, with the pair's salt, determines every receiver's address.
        RECEIVER = receiver;

        // Read the distributor from the implementation so the factory and its clones cannot disagree.
        DISTRIBUTOR = receiver.DISTRIBUTOR();
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Settles a receiver's balance of a token into the rewards distributor, deploying the receiver if needed.
    /// @param stickyToken The sticky token whose holders should be rewarded.
    /// @param groupId The reward group the receiver funds (0 = the default group).
    /// @param token The reward token to settle.
    /// @return amount The receiver's gross balance submitted for funding, in reward-token atoms. Transfer taxes can
    /// make the distributor's credited amount smaller.
    function settleFor(address stickyToken, uint256 groupId, IERC20 token) external override returns (uint256 amount) {
        // Materialize the destination if needed so even arrivals sent before deployment can fund rewards.
        amount = IStickyRewardReceiver(deployReceiverFor({stickyToken: stickyToken, groupId: groupId})).settle(token);

        // This reports the completed call's gross amount; reward accounting belongs to the guarded distributor.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Settle({stickyToken: stickyToken, groupId: groupId, token: token, amount: amount, caller: msg.sender});
    }

    //*********************************************************************//
    // ----------------------- external views ---------------------------- //
    //*********************************************************************//

    /// @notice The deterministic receiver address for a sticky token and reward group, whether or not it has been
    /// deployed.
    /// @dev Matches across chains only when the factory address, sticky token address and group all match.
    /// @param stickyToken The sticky token to predict the receiver of.
    /// @param groupId The reward group the receiver funds (0 = the default group).
    /// @return receiver The predicted receiver address.
    function predictReceiverOf(address stickyToken, uint256 groupId) external view override returns (address receiver) {
        // Never predict an address no receiver can be deployed at. A tenure group's receiver still settles only once
        // its sticky token is registered with the Sticky hook, which may happen after tokens arrive.
        _requireDeployable({stickyToken: stickyToken, groupId: groupId});

        // Reproduce the clone address so funders can route tokens before the receiver exists.
        return Clones.predictDeterministicAddress({
            implementation: address(RECEIVER), salt: _saltOf({stickyToken: stickyToken, groupId: groupId})
        });
    }

    //*********************************************************************//
    // ----------------------- public transactions ----------------------- //
    //*********************************************************************//

    /// @notice Deploys the receiver for a sticky token and reward group at its deterministic address.
    /// @param stickyToken The sticky token the receiver collects rewards for.
    /// @param groupId The reward group the receiver funds (0 = the default group).
    /// @return receiver The deployed receiver.
    function deployReceiverFor(address stickyToken, uint256 groupId) public override returns (address receiver) {
        // Look up the existing destination before attempting a deployment at its unique CREATE2 address.
        receiver = receiverOf[stickyToken][groupId];

        // Reuse a deployed receiver so repeated settlement never attempts to deploy over existing code.
        if (receiver != address(0)) return receiver;

        // Reject pairs the clone could never be initialized with or the distributor could never fund.
        _requireDeployable({stickyToken: stickyToken, groupId: groupId});

        // Match the predicted salt so tokens already sent to that address become usable.
        receiver = Clones.cloneDeterministic({
            implementation: address(RECEIVER), salt: _saltOf({stickyToken: stickyToken, groupId: groupId})
        });

        // Record the deployed receiver so subsequent settlement calls reuse the same destination.
        receiverOf[stickyToken][groupId] = receiver;

        // Fix the clone's holder pool and group in the same call, so no one else can initialize it.
        IStickyRewardReceiver(receiver).initialize({initialStickyToken: stickyToken, initialGroupId: groupId});

        // Publish the destination for funders and indexers. Initialization only validates and stores the pair, so it
        // cannot call back into this factory.
        // forge-lint: disable-next-line(reentrancy-events)
        emit DeployReceiver({stickyToken: stickyToken, groupId: groupId, receiver: receiver, caller: msg.sender});
    }

    //*********************************************************************//
    // ----------------------- internal helpers -------------------------- //
    //*********************************************************************//

    /// @notice The CREATE2 salt for a sticky token and reward group's receiver.
    /// @param stickyToken The sticky token the receiver collects rewards for.
    /// @param groupId The reward group the receiver funds.
    /// @return salt The salt, distinct for every (token, group) pair.
    function _saltOf(address stickyToken, uint256 groupId) internal pure returns (bytes32 salt) {
        // Fixed-width encoding keeps every pair distinct without depending on deployment order or the caller.
        salt = keccak256(abi.encode(stickyToken, groupId));
    }

    //*********************************************************************//
    // ----------------------- internal views ---------------------------- //
    //*********************************************************************//

    /// @notice Reverts unless a receiver can be deployed for the sticky token and reward group.
    /// @param stickyToken The sticky token to validate.
    /// @param groupId The reward group to validate.
    function _requireDeployable(address stickyToken, uint256 groupId) internal view {
        // The receiver rejects the zero sticky token at initialization, so its address could never hold code.
        if (stickyToken == address(0)) revert StickyRewardReceiverFactory_InvalidStickyToken(stickyToken);

        // Defer to the distributor so the factory never encodes a group rule of its own.
        if (!DISTRIBUTOR.isValidGroupId(groupId)) revert StickyRewardReceiverFactory_InvalidGroupId(groupId);
    }
}
