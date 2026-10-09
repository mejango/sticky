# Administration

## At a glance

| Item | Details |
| --- | --- |
| Scope | Sticky contracts, their reward distributor and source collectors, and every project launched by `StickyDeployer` |
| Control posture | Permissionless deployment; immutable after construction; sticky projects are deployer-owned with no mutable surface |
| Highest-risk actions | `deployStickyFor` (irreversible per-project parameters: underlying token, cash out tax, transfer mode, granters); shared-hook dependency verification and source split destination/group configuration |
| Recovery posture | Replacement deployment for incorrect permanent settings; queued rewards can retry delivery through a valid replacement route, but have no arbitrary rescue or destination reassignment. A destination fee child's raw native balance has one fixed permissionless contribution path to protocol fee project 1. Redemption remains subject to tax, fees, and token behavior; maximum tax returns zero |

## Purpose

Sticky exposes no project administration after launch. The deployer owns every project it launches and its only external transaction is `deployStickyFor`. It cannot queue rulesets, send payouts, set metadata, replace a token or price feed, delegate permissions, or transfer the project NFT. This limits the factory's owner powers; it does not remove core's protocol controls or the underlying token's administration.

## Control model

- Permissionless: anyone can launch with an ERC-20 that exposes supported accounting precision (0–36 decimals) and a nonzero currency ID derived from its address, by paying the `JBProjects` creation fee. This validates configuration, not the safety of the underlying token.
- Immutable project settings: Sticky contracts have no administrator or upgrade path. Holders can update their trusted senders on the hook and their auto-stick configuration on the adapter; ERC-20 allowances remain separate wallet controls.
- Deployer-controlled in name only: the deployer holds each project NFT forever; `JBPermissions` delegation never comes into play because the owner account is a contract with no permission-granting surface.
- Core dependency: `JBController.OMNICHAIN_RULESET_OPERATOR` can queue rulesets without the factory's permission. The canonical omnichain deployer checks the project owner's permissions itself. Verify its implementation and the controller binding on each network; Sticky's zero-duration ruleset and absent approval hook do not provide a second guard against an incorrect operator.
- Protocol controls: the core project creation fee, feeless-address configuration, and default price-feed routing retain their core authority model. The underlying ERC-20 may separately have minting, freezing, or upgrade powers. See [RISKS.md](./RISKS.md).
- Reserved rewards: source project authorities configure the shared collector as a reserved-token split hook, with the home-chain Sticky token/group as destination. Acceptance queues attributed custody on every source chain. Anyone may distribute reserves, settle a partial home-chain allocation, pay fees to send a partial remote allocation through a valid registered route, or add the destination fee child's complete raw native balance to protocol fee project 1. Recurring delivery needs no Safe custody or signature. The child fee payer is callable only by its parent; neither exposes an administrator operation.

## Source reward roles

| Role | Assignment and scope | Authority boundary |
| --- | --- | --- |
| Source split operator | The source project's current owner or operator authorized for `SET_SPLIT_GROUPS` (permission 19 in the pinned V6 release) | Configures current/future stage allocations subject to locks; cannot withdraw or reassign existing pending buckets |
| Collector deployer | Deployment through the canonical CREATE2 factory with reviewed registry, token-registry, receiver-factory and nonzero home-chain bindings | Chooses permanent dependencies and destination family; receives no ongoing privilege |
| Delivery caller | Any address; remote submission additionally needs registry/transport payment and gas | Chooses a positive partial bucket amount and a valid registered remote route/backing; cannot change its home-chain token/group; receives only the fee child's same-call receipts/refunds |
| Fee-balance contributor | Any address on the collector family's configured destination chain | Can move only the destination fee child's complete raw native balance to the canonical project-1 native terminal; receives nothing and cannot choose a destination |
| Native finalizer / destination settler | Any caller satisfying transport proof and sucker claim requirements, or calling receiver settlement | Executes fixed-beneficiary delivery and settlement; cannot choose a different reward pool |

The source authority and current split tables must be read from core at setup time; the collector does not grant split-edit permission. Source controller selection, registry-approved builders/routes/fees, token behavior, source terminal and bridge administration remain external dependencies. See [source-collector setup](DEPLOYMENT.md#source-collectors) for the owning verification recipe.

## One-way decisions

- **Choosing a pool's home chain.** A Sticky launch targets one chain. Its share token, backing, snapshots, rewards and redemption stay there; same-name or same-address deployments elsewhere remain distinct pools. Reward sources must have qualified direct routes to the selected home. No administrator can move an existing collector family's destination or merge independent pool accounting.
- **Launching a sticky project.** The underlying token and its accounting context, the eternal ruleset (backing-priced issuance through the hook and feed, launch-time cash out tax, no payouts, no migration), the share token's name, symbol and transfer mode, and the granter list are permanent. There is no fix for a wrong parameter besides deploying a fresh project.
- **Attaching the share token and feed.** `setTokenFor` and `addPriceFeedFor` are called once at launch; the ruleset flags that permit them stay on, but only the owner can call them and the owner exposes no such call.
- **Choosing granters.** The launch-time granter list is permanent; a forgotten grant program address can still reach holders who individually trust it, but cannot airdrop to everyone. Unauthorized third-party stakes revert.
- **Orphaned backing.** Backing present while the share supply is zero, including donations to an empty project and anything left after the last holder burns without redeeming, is excluded from every later share and cannot be recovered by anyone.
- **Collector dependencies and allocations.** `StickySourceCollector` fixes the registry, tokens, directory, receiver factory and nonzero `DESTINATION_CHAIN_ID`; its constructor fixes the child fee payer's parent. A collector family serves one home chain, with a separate address and custody from other destination families. Accepted allocations permanently identify a source project, home-chain Sticky token and group. Any caller may choose a qualified direct delivery route, including a replacement, but cannot change that destination. Configure the collector as the split's hook, not a plain beneficiary, and never send splits to the child. Unattributed project tokens and parent balances have no rescue. On the configured destination chain, the child exposes only the fixed full-balance project-1 contribution through its parent. If no compatible route exists, a remote bucket remains queued.

## Operational notes

- The project creation fee (`JBProjects.creationFee()`) must be sent exactly as `msg.value` to `deployStickyFor`.
- Fee-on-transfer or rebasing tokens must not be used as underlying tokens: pricing assumes the terminal's recorded balance equals what was paid, and the adapter reverts on any transfer delta mismatch.
- A cash out tax at the maximum makes every redemption, including a full exit, return zero underlying tokens. Non-zero tax subjects the whole reclaim to the terminal fee unless its beneficiary is feeless. Zero-tax cash outs can still owe a fee against the project's fee-free surplus balance; use the net amount in transaction minimums.
- Bootstrap payments must issue at least `1e12` share atoms. Burns and cash outs impose no minimum remaining supply. Very small supplies and donated backing can make later small deposits unissuable within the rounding guard.
- The production reward path is one shared `StickyDistributor` per chain, configured in `script/helpers/StickyDeployment.sol`: bound to the deployed hook, 7-day rounds, 4 vesting rounds, a 2-year claim window, loans disabled. These are constructor arguments and cannot be changed without deploying a new distributor, receiver factory and adapter. Group 0 round snapshots are shared by every sticky token on the chain and are age-blind; tenure groups (`minWeeks * 1000 + maxWeeks`) weigh whole weeks of tranche age measured from each round's start week. Funders choose the group per funding or per split (`split.projectId`); nothing on the distributor is administered. See the README's rewards section before promising tenure-based rewards.
- Reward programs read `tranchesOf` (paginated), `stakedBalanceOf`, `currentStreakOf`, `longestStreakOf`, and the `Staked`, `Unstaked`, `StreakStarted`, `StreakEnded` events; nothing on-chain needs administering to change reward rules.
- Disabling auto-stick requires a valid nonzero minimum and a cooldown between one and thirty days. It preserves the last-compounded timestamp. Revoke the adapter's ERC-20 allowance separately if it is no longer wanted; revoking personal trust cannot override a permanent project granter.
- Collector acceptance and delivery are separate. A failed hook callback is caught by the V6 controller; unconsumed reserved ERC-20s are burned, while credits transferred before the callback can remain unattributed. Verify split configuration before issuing reserves. A later failed delivery restores the accepted bucket for retry. Source credits can wait for their ERC-20 deployment, but remote home-chain claims must wait for the destination reward ERC-20 because receivers cannot claim credits.
- A collector `send(...)` success proves source submission only. Keepers must follow finalization, the fixed-beneficiary destination claim, receiver settlement and holder collection separately. A successful native withdrawal cannot be recalled. Anyone can choose partial amounts, valid routes and send/settlement timing, so reward-round timing is not an administrator promise.
- There is no Sticky pause, principal rescue, forced migration, or orphaned-fund recovery operation. The fixed destination fee-balance contribution cannot return value to a caller or select another project. Follow [DEPLOYMENT.md](./DEPLOYMENT.md) for new releases and [USER_JOURNEYS.md](./USER_JOURNEYS.md) for holder actions.
- Contract changes remain in a PR through complete implementation/review, required checks, deployment and verification. The user's explicit approval of the final PR is required before merge; green checks, deployment access or prior requests to update main do not authorize it. Live deployment and split changes retain their own concrete execution authority.

## Incident and recovery actions

First retain the chain, contract/runtime identity, transaction or proposal reference, canonical receipt, affected pending bucket and relevant source/destination balances. A timeout is an unknown outcome; reconcile the original action before submitting another value-moving transaction. No Sticky administrator can pause these immutable contracts or reverse accepted allocations.

| Observed state | Available response and limit |
| --- | --- |
| Incorrect split configuration before acceptance | The authorized source operator can correct unlocked current/future tables. Inspect reserves already distributed separately: a rejected ERC-20 callback may have burned them, and unattributed project-token credits or donations have no collector rescue. |
| Accepted bucket, failed delivery | Inspect the canonical revert and unchanged pending/custody balances, then retry a positive partial amount after fixing ERC-20 readiness, fees or route state. A qualified replacement must preserve the same home-chain destination. |
| Source submission succeeded, arrival missing | Retain the exact leaf/root and follow the canonical transport's proving/finalization and destination claim. Check whether claim or settlement already occurred before retrying; do not treat a source receipt as destination funding. |
| Unsafe or permanently unavailable lane | Stop configuring additional allocations to that lane and arrange authorized changes to future unlocked splits. Existing buckets remain bound to their destination, and permissionless contracts expose no delivery pause. Every Ethereum-to-Arbitrum submission creates an unsafe root retryable whose refund targets raw `feeChild`; a positive mapped-ERC-20 transfer additionally creates a safe-Inbox gateway retryable that credits `alias(feeChild)`. A WETH cancellation or expiry can also credit bridged call value to `alias(source sucker)`. A verified destination family can contribute only the raw balance, so positive mapped-ERC-20 backing remains unqualified; see [RISKS.md](RISKS.md#operational-limits). |
| Client or artifact mismatch | Restore the last verified client configuration and retain pending transaction records. Re-run live contract verification before publishing corrected artifacts; a website rollback cannot change deployed code, permanent pool settings or a submitted transaction. |

Assign an operator to each unfinished source submission, native finalization, claim, applicable raw-fee contribution and settlement before enabling material funding. Permissionless access supplies execution authority to callers, not monitoring coverage or a recovery service.
