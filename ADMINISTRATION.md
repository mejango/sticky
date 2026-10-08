# Administration

## At a glance

| Item | Details |
| --- | --- |
| Scope | Sticky contracts, their reward distributor and source collectors, and every project launched by `StickyDeployer` |
| Control posture | Permissionless deployment; immutable after construction; sticky projects are deployer-owned with no mutable surface |
| Highest-risk actions | `deployStickyFor` (irreversible per-project parameters: underlying token, cash out tax, transfer mode, granters); collector route/receiver selection and source split configuration |
| Recovery posture | Replacement deployment for incorrect permanent settings; collector balances have no rescue. Redemption remains subject to tax, fees, and token behavior; maximum tax returns zero |

## Purpose

Sticky exposes no project administration after launch. The deployer owns every project it launches and its only external transaction is `deployStickyFor`. It cannot queue rulesets, send payouts, set metadata, replace a token or price feed, delegate permissions, or transfer the project NFT. This limits the factory's owner powers; it does not remove core's protocol controls or the underlying token's administration.

## Control model

- Permissionless: anyone can launch with an ERC-20 that exposes supported accounting precision (0–36 decimals) and a nonzero currency ID derived from its address, by paying the `JBProjects` creation fee. This validates configuration, not the safety of the underlying token.
- Immutable project settings: Sticky contracts have no administrator or upgrade path. Holders can update their trusted senders on the hook and their auto-stick configuration on the adapter; ERC-20 allowances remain separate wallet controls.
- Deployer-controlled in name only: the deployer holds each project NFT forever; `JBPermissions` delegation never comes into play because the owner account is a contract with no permission-granting surface.
- Core dependency: `JBController.OMNICHAIN_RULESET_OPERATOR` can queue rulesets without the factory's permission. The canonical omnichain deployer checks the project owner's permissions itself. Verify its implementation and the controller binding on each network; Sticky's zero-duration ruleset and absent approval hook do not provide a second guard against an incorrect operator.
- Protocol controls: the core project creation fee, feeless-address configuration, and default price-feed routing retain their core authority model. The underlying ERC-20 may separately have minting, freezing, or upgrade powers. See [RISKS.md](./RISKS.md).
- Remote rewards: source project authorities approve initial reserved-split redirection to a collector. Once configured, anyone may distribute pending reserves, pay the current registry fee to submit, and execute the later bridge/settlement steps. Recurring delivery needs no Safe custody or signature. The collector's fixed fee payer is callable only by its parent; neither exposes an administrator operation.

## Source reward roles

| Role | Assignment and scope | Authority boundary |
| --- | --- | --- |
| Source split operator | The source project's current owner or operator authorized for `SET_SPLIT_GROUPS` (permission 19 in the pinned V6 release) | Configures current/future stage recipients subject to existing locks; cannot withdraw collector inventory or change its route |
| Collector deployer | Anyone supplying the constructor's sucker and Ethereum receiver | Chooses permanent bindings; receives no ongoing privilege |
| Delivery caller | Any address paying the exact current `toRemoteFee()` and transaction gas | Triggers all held source rewards along the fixed route; receives only the fee child's same-call receipt/refund |
| Native finalizer / destination settler | Any caller satisfying the native bridge proof and sucker claim requirements | Executes fixed-beneficiary delivery and receiver settlement; cannot choose a different reward pool |

The source authority and current split tables must be read from core at setup time; the collector does not grant split-edit permission. Registry fee, source terminal and bridge administration remain external dependencies. See [source-collector setup](DEPLOYMENT.md#source-collectors) for the owning verification recipe.

## One-way decisions

- **Launching a sticky project.** The underlying token and its accounting context, the eternal ruleset (backing-priced issuance through the hook and feed, launch-time cash out tax, no payouts, no migration), the share token's name, symbol and transfer mode, and the granter list are permanent. There is no fix for a wrong parameter besides deploying a fresh project.
- **Attaching the share token and feed.** `setTokenFor` and `addPriceFeedFor` are called once at launch; the ruleset flags that permit them stay on, but only the owner can call them and the owner exposes no such call.
- **Choosing granters.** The launch-time granter list is permanent; a forgotten grant program address can still reach holders who individually trust it, but cannot airdrop to everyone. Unauthorized third-party stakes revert.
- **Orphaned backing.** Backing present while the share supply is zero, including donations to an empty project and anything left after the last holder burns without redeeming, is excluded from every later share and cannot be recovered by anyone.
- **Collector route and custody.** `StickySourceCollector` fixes its source project/token, sucker and Ethereum receiver. Its constructor creates `StickySourceFeePayer`, fixing that child's parent, sucker and fee token. The parent, never the child, must receive every configured reserved split. Neither contract can pause, migrate, rescue an unsupported donation or redirect an existing balance. A wrong receiver or permanently unavailable route cannot be repaired in place.

## Operational notes

- The project creation fee (`JBProjects.creationFee()`) must be sent exactly as `msg.value` to `deployStickyFor`.
- Fee-on-transfer or rebasing tokens must not be used as underlying tokens: pricing assumes the terminal's recorded balance equals what was paid, and the adapter reverts on any transfer delta mismatch.
- A cash out tax at the maximum makes every redemption, including a full exit, return zero underlying tokens. Non-zero tax subjects the whole reclaim to the terminal fee unless its beneficiary is feeless. Zero-tax cash outs can still owe a fee against the project's fee-free surplus balance; use the net amount in transaction minimums.
- Bootstrap payments must issue at least `1e12` share atoms. Burns and cash outs impose no minimum remaining supply. Very small supplies and donated backing can make later small deposits unissuable within the rounding guard.
- The production reward path is one shared `StickyDistributor` per chain, configured in `script/helpers/StickyDeployment.sol`: bound to the deployed hook, 7-day rounds, 4 vesting rounds, a 2-year claim window, loans disabled. These are constructor arguments and cannot be changed without deploying a new distributor, receiver factory and adapter. Group 0 round snapshots are shared by every sticky token on the chain and are age-blind; tenure groups (`minWeeks * 1000 + maxWeeks`) weigh whole weeks of tranche age measured from each round's start week. Funders choose the group per funding or per split (`split.projectId`); nothing on the distributor is administered. See the README's rewards section before promising tenure-based rewards.
- Reward programs read `tranchesOf` (paginated), `stakedBalanceOf`, `currentStreakOf`, `longestStreakOf`, and the `Staked`, `Unstaked`, `StreakStarted`, `StreakEnded` events; nothing on-chain needs administering to change reward rules.
- Disabling auto-stick requires a valid nonzero minimum and a cooldown between one and thirty days. It preserves the last-compounded timestamp. Revoke the adapter's ERC-20 allowance separately if it is no longer wanted; revoking personal trust cannot override a permanent project granter.
- A collector `send()` success proves source submission only. Keepers must follow native finalization, the fixed-beneficiary destination claim, receiver settlement and holder collection separately. A failed source prepare, transport, receipt transfer or refund reverts the entire send and may be retried after its cause is resolved; a successful native submission cannot be recalled. Anyone can choose send/settlement timing, so reward-round timing is not an administrator promise.
- There is no Sticky pause, asset rescue, forced migration, or orphaned-fund recovery operation. Follow [DEPLOYMENT.md](./DEPLOYMENT.md) for new releases and [USER_JOURNEYS.md](./USER_JOURNEYS.md) for holder actions.
