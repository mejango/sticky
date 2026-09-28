// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IStickyDistributor} from "./interfaces/IStickyDistributor.sol";

/// @notice Holds cross-chain reward arrivals for one sticky token and reward group until anyone settles them into
/// the rewards distributor.
/// @dev Each (Sticky token, group) pair has its own receiver address so plain ERC-20 arrivals identify both the
/// rewarded holder pool and how it is weighed, without bridge-specific metadata or a shared deposit ledger. The
/// factory deploys one implementation and gives each pair a minimal clone of it, initialized with the pair; each
/// receiver settles its full token balance, without ordering individual arrivals. The receiver's deterministic address
/// can receive tokens before deployment. Its address matches across chains only when the factory address, sticky
/// token address and group all match.
/// @dev Settles ERC-20 balances only. Project-token credits minted by a sucker claim, which is what a destination
/// project without an ERC-20 receives, and native ETH cannot be settled and stay in the receiver. Funders must bridge
/// only to chains where the reward project has an ERC-20 and must not send ETH. A tenure group's receiver can only
/// settle once its sticky token is registered with the distributor's Sticky hook.
contract StickyRewardReceiver {
    // A library that safely interacts with ERC-20 tokens.
    using SafeERC20 for IERC20;

    //*********************************************************************//
    // --------------------------- custom errors ------------------------- //
    //*********************************************************************//

    /// @notice Thrown when a receiver is initialized twice, or by anyone other than its factory.
    /// @param caller The address that attempted the initialization.
    error StickyRewardReceiver_Unauthorized(address caller);

    /// @notice Thrown when the distributor is the zero address, since the immutable settlement destination cannot be
    /// corrected after deployment.
    /// @param distributor The distributor provided for the receiver.
    error StickyRewardReceiver_InvalidDistributor(IStickyDistributor distributor);

    /// @notice Thrown when the Sticky token is the zero address, since arrivals would have no rewarded holder pool.
    /// @param stickyToken The Sticky token provided for the receiver.
    error StickyRewardReceiver_InvalidStickyToken(address stickyToken);

    //*********************************************************************//
    // --------------- public immutable stored properties ---------------- //
    //*********************************************************************//

    /// @notice The distributor rewards are settled into, shared by every clone of this implementation.
    IStickyDistributor public immutable DISTRIBUTOR;

    /// @notice The factory that deployed this implementation and is the only address allowed to initialize clones.
    address public immutable FACTORY;

    //*********************************************************************//
    // --------------------- public stored properties -------------------- //
    //*********************************************************************//

    /// @notice The reward group settlements fund (0 = the default group).
    uint256 public groupId;

    /// @notice The sticky token whose holders this receiver rewards. Zero until the factory initializes the clone.
    address public stickyToken;

    //*********************************************************************//
    // -------------------------- constructor ---------------------------- //
    //*********************************************************************//

    /// @notice Initializes the implementation's distributor and factory, which its clones share.
    /// @param distributor The distributor rewards are settled into.
    constructor(IStickyDistributor distributor) {
        // Require a settlement destination because the immutable distributor cannot be corrected after deployment.
        if (address(distributor) == address(0)) revert StickyRewardReceiver_InvalidDistributor(distributor);

        // Fix the destination so permissionless callers cannot redirect the receiver's rewards.
        DISTRIBUTOR = distributor;

        // Only the deploying factory initializes clones, and it never initializes this implementation.
        FACTORY = msg.sender;
    }

    //*********************************************************************//
    // ---------------------- external transactions ---------------------- //
    //*********************************************************************//

    /// @notice Fixes a clone's sticky token and reward group.
    /// @dev Only the factory can initialize, once, in the same call that deploys the clone.
    /// @param initialStickyToken The sticky token whose holders this receiver rewards.
    /// @param initialGroupId The reward group settlements fund; the factory only creates receivers for groups the
    /// distributor accepts.
    function initialize(address initialStickyToken, uint256 initialGroupId) external {
        // Reject re-initialization and any caller that could point a clone at a different holder pool.
        if (msg.sender != FACTORY || stickyToken != address(0)) revert StickyRewardReceiver_Unauthorized(msg.sender);

        // Require a reward-bearing token so arrivals cannot be assigned to an empty holder identity.
        if (initialStickyToken == address(0)) revert StickyRewardReceiver_InvalidStickyToken(initialStickyToken);

        // Fix how the rewarded holders are weighed.
        groupId = initialGroupId;

        // Fix the rewarded holders independently of who sends or settles the arriving tokens. Set once, in the call
        // where the factory emits `DeployReceiver` with the same pair.
        // forge-lint: disable-next-line(missing-events-access-control)
        stickyToken = initialStickyToken;
    }

    /// @notice Settles this receiver's full balance of a token into the distributor as rewards for the sticky
    /// token's holders in the receiver's group.
    /// @dev Anyone can settle. The settlement time selects the distributor round, whose snapshot determines reward
    /// eligibility; the receiver does not reserve rewards for holders present when tokens arrive.
    /// @param token The reward token to settle.
    /// @return amount The amount settled.
    function settle(IERC20 token) external returns (uint256 amount) {
        // Settle all tokens currently available, including arrivals sent before this receiver was deployed.
        amount = token.balanceOf(address(this));

        // Nothing to settle is a no-op; every positive balance can still be settled.
        // slither-disable-next-line incorrect-equality
        if (amount == 0) return 0;

        // Let the distributor pull exactly this settlement's balance, including tokens requiring an allowance reset.
        token.forceApprove({spender: address(DISTRIBUTOR), value: amount});

        // Assign the pulled tokens to the fixed Sticky token and group's current reward round.
        DISTRIBUTOR.fund({hook: stickyToken, token: token, amount: amount, groupId: groupId});
    }
}
