# Invariants

These guarantees apply to projects launched by `StickyDeployer`, using the configured V6 core and supported underlying tokens. [RISKS.md](./RISKS.md) describes assumptions and behaviors they do not guarantee.

## Pool identity and launch

1. A pool is identified by its home chain and share token, alongside its chain/project identity. Shares, backing, snapshots, rewards and redemption are local to that pool. Matching names, addresses, assets or metadata on another chain do not combine pool supplies.
2. Sticky launch preparation and executable saved plans have exactly one supported target chain. Chain-qualified inputs cannot silently change chains. A stale multi-target plan retains transaction evidence for inspection but cannot resume sending by dropping targets.
3. Reward source chains are distinct from the pool's home chain. Only qualified direct routes to that home are usable; unsupported pairs cannot silently route through another destination or an unimplemented relay.

## Issuance and backing

1. A successful payment into an existing supply issues `floor(amount × supply / backing)` share atoms, using pre-payment supply and backing after excluding orphaned funds. No intermediate exchange-rate rounding changes this ratio.
2. Empty-supply issuance starts at one Sticky share per whole underlying token, normalized to 18 decimals. A bootstrap must issue at least `1e12` share atoms. The minimum is an initial issuance requirement, not a minimum remaining supply after a burn.
3. Positive payments cannot issue zero shares or exceed the conservative one-basis-point share-rounding bound. Rejection reverts the complete payment.
4. The after-pay callback checks the expected issuance and aggregate supply/backing against the terminal's pre-payment snapshot. Unexpected intervening mint, burn, payment, or donation cannot silently change the accepted price.
5. Backing that exists without shares is excluded from subsequent generations. The next positive payment records that baseline in `orphanedBalanceOf`; while supply is zero, all backing is unowned even if the stored baseline has not caught up.
6. Cash out pricing excludes orphaned backing. Sticky exposes no operation that withdraws it or allocates it to later holders.
7. The immutable project feed uses the terminal's cached accounting precision. Later ERC-20 metadata changes cannot change that precision. An incorrect fallback price cannot pass the after-pay check if it changes issuance.

## Positions and exits

1. At completed transaction boundaries, a holder's `stakedBalanceOf` equals their share-token balance and the sum of active tranche amounts. Between core minting and after-pay recording, outgoing positive share movements from an unreconciled holder revert.
2. Only the registered share token reports burns or transfers. Every positive burn, including a voluntary controller burn, consumes accounting exactly once.
3. A burn can leave any remaining supply. Another holder's dust does not create a minimum balance the exiter must keep.
4. Tranches are consumed newest-first. A partially consumed tranche retains its timestamp. Partial exits find the retained tail by binary search; every fully consumed tranche debits its original epoch bucket, so an exit loops once per distinct week it consumes, never once per deposit.
5. Positive minting and incoming transfers join the holder's newest tranche when it was created in the current week, moving its timestamp to the transaction timestamp, and otherwise create a new tranche. Every active tranche is in a distinct week. Transferred shares do not inherit the sender's age. Existing recipient streaks continue.
6. A holder's streak starts when their recorded balance becomes positive and ends when it reaches zero. Adding shares cannot backdate a tranche or restart an active streak. The longest completed streak never decreases.
7. Zero movements and self-transfers do not change Sticky position accounting. Soulbound tokens reject transfers between nonzero addresses, including zero and self-transfers.
8. The bounded tranche getter returns at most 256 active entries. Logically discarded storage is never exposed as an active tranche.
9. For every project, the sum of `netStakedIn` over all epochs equals the sum of holders' staked balances and the token supply at completed transaction boundaries. `stakedBalanceThroughEpochOf(projectId, holder, epoch)` equals the sum of the holder's active tranches created through that epoch.

## Authorization and permanent settings

1. Only the deployer registers project tokens and granters. Its public launch path registers each once and exposes no later project mutation operation.
2. A third-party payment requires the beneficiary's personal trust or permanent granter status. Self-stakes are permitted. Transferable share transfers do not use this payment gate.
3. Only a project's terminal may call the state-changing after-pay or after-cash-out hooks. Both reject forwarded native value. Public before-recording views do not change state.
4. Only core `JBTokens` may mint or burn the share token. Its project binding, metadata, transfer mode, and self-delegation are immutable.
5. The factory grants no owner permissions and exposes no path to withdraw, reconfigure, or transfer a launched project. This guarantee does not override core's omnichain operator or trusted-forwarder assumptions.

## Rewards and compounding

1. At any queryable past block, holder votes equal their share balance at that block, and active votes equal total supply. No delegation change can move reward weight independently of ownership.
2. Group-0 allocations use the pinned historical balance, not tranche age, holder streak, current balance, or continued ownership throughout vesting.
3. A tenure group's window for a round is fixed by the round's start week and the group's `minWeeks`/`maxWeeks`. Its denominator equals the sum of the project's live in-window stake when the round is first funded, is never read while a payment's minted shares still lack a tranche, and no stake added afterwards can enter that window. A holder's allocation equals the pot times their live in-window stake at claim time over that denominator, capped by what the pot still holds, so the sum of claims never exceeds the pot.
4. A receiver is bound to one Sticky token, one reward group, and one distributor. Positive settlement funds the current distributor round of that group with the receiver's reward balance; a zero balance is a no-op. The returned gross amount is not proof of net distributor credit for a transfer-tax token.
5. Keeper compounding requires the selected holder's enabled configuration, cooldown, positive minimum, allowance, hook permission, and at least one reward group, listed once each in ascending order. The minimum applies to the combined collectable amount across the requested groups. Only that holder can change the configuration.
6. Both compounding entrypoints collect every requested group to the holder, pull only the total balance increase delivered by those collections, and stake into the same holder's project. Existing unrelated wallet funds cannot substitute for rewards collected before the call.
7. A holder-to-adapter transfer delta mismatch or a payment below the adapter's execution-time share quote reverts the complete collection and stake. The adapter clears its terminal allowance after success.
8. Failure cannot leave a partially completed auto-stick transaction. Permissionless prior collection can leave rewards safely in the holder's wallet and make a later compound ineligible.
9. Rewards allocated to the distributor's own address are never transferred out or erased. Collecting them to the distributor recycles the unlocked amount into the current round of the same hook, group and token; any other token ID collected to the distributor reverts. Custody and the accounted balance are unchanged by a recycle.

## Source reward collection

These invariants assume verified canonical constructor bindings and current source controllers, registered bridge implementations and source-project token behavior. Each collector has a nonzero immutable `DESTINATION_CHAIN_ID`. The source split uses that home chain's collector as `hook`, the home-chain Sticky share token as `beneficiary`, and the reward group as `split.projectId`. A route's source registry membership does not independently verify its remote peer or destination readiness.

1. Only the source project's current controller may call acceptance. The callback identifies the reserved-token split group, this hook, 18 project-token decimals, zero native value and either the registered source ERC-20 or already-transferred project credits. The receiver factory owns nonzero destination-token and reward-group validation. A zero-token context remains valid for credits when the controller cached it before another split deployed the ERC-20.
2. `pendingOf(sourceProjectId, stickyToken, groupId)` records accepted custody for exactly that source and home-chain reward destination. The collector address separates destination families; neither callbacks nor delivery callers can reassign custody to another family. `totalPendingOf(sourceProjectId)` equals the sum of its pending buckets and cannot exceed combined held ERC-20/credit custody at completed operations. Preexisting unattributed donations create no delivery entitlement.
3. An ERC-20 receipt credits combined project-custody growth less nested same-project pending growth during its transfer. A credit receipt books its authenticated amount only when custody covers the resulting liabilities. Nested valid receipts remain admissible and are counted once; their accounting cannot be swept into the outer allocation.
4. Acceptance only queues custody on every chain, including the home chain. It does not call a terminal, prepare a leaf, validate delivery routes, pay fees, fund a reward round or require the source ERC-20 to exist when credits are received.
5. Positive acceptance depth blocks all outbound delivery until every nested receipt finishes. Outbound reentrancy is separately prohibited. Valid incoming allocations during a delivery, including fee callbacks, remain queued and are not consumed by that delivery's earlier debit.
6. Delivery selects a positive amount no larger than one bucket, debits that bucket and the source total before state-changing external calls, and materializes held credits into the source ERC-20 when it exists. It cannot assign donations, spend a sibling bucket or redirect the bucket's home-chain token/group destination. A failed delivery restores liabilities and all same-transaction custody changes.
7. `settle` only executes when the current chain equals `DESTINATION_CHAIN_ID`. It transfers the chosen allocation to its predicted receiver and invokes the existing factory settlement atomically. The receiver's existing reward-token inventory also settles under its own whole-balance rule; it is not debited from unrelated collector buckets.
8. Remote `send` only executes off the immutable destination chain. It requires a registered source-project sucker sharing canonical registry/directory/tokens, a peer on that home chain, sending-enabled state and an enabled non-emergency backing mapping. A qualified replacement direct route may be selected for later deliveries. This changes transport, not the bucket destination, and establishes no implicit relay.
9. The cashout bound is the current primary backing terminal's gross quote for the sucker holder/beneficiary less the standard protocol fee, in backing-token atoms. A zero quote is allowed. Exactly the selected project-token allowance is granted to the validated sucker and cleared after preparation; project-token reminting belongs to the sucker/core path.
10. Preparation appends exactly one fixed-receiver leaf after the captured frontier; submission must cover that leaf's index. Other callbacks may append later leaves. Any preparation, transport, receipt/refund or postcondition failure restores the prior outbox and selected custody atomically.
11. Only the immutable parent may use the fee child, and the child has no allowance over parent principal. The caller supplies at least the current registry fee; excess is transport budget. A positive fee requires a deployed fee ERC-20; a zero fee does not. Only the child's same-call fee-token increase, when that ERC-20 exists, and fresh registry-fee/transport-refund credits return to the caller. Preexisting token/native donations are excluded; tokens deliberately donated during submission enter the measured increase. Both retained-credit ledgers must be empty before and after the submission/refunds.
12. Neither contract has an owner, arbitrary call, rescue or pending-destination reassignment. Source submission does not imply native finality, destination claim, receiver settlement or holder collection, and a successful withdrawal cannot be recalled by the collector.

## Verification map

| Surface | Tests |
| --- | --- |
| Tranche accounting, exits, epoch buckets, and streaks | `test/StickyAccounting.t.sol`, `test/StickyHook_Unit.t.sol`, `test/StickyBurn_Integration.t.sol` |
| Reward groups, windows, splits, and pot solvency | `test/StickyDistributor_Unit.t.sol`, `test/StickyDistributor_Invariant.t.sol` |
| Issuance, rounding, and orphaned backing | `test/StickyPricing_Regression.t.sol`, `test/StickyPriceFeed_Regression.t.sol` |
| Callback ordering | `test/StickyPricingCallbacks.t.sol` |
| Core and reward integration | `test/Sticky_Integration.t.sol`, `test/StickyRewards_Regression.t.sol`, `test/StickyAutoStick_Unit.t.sol` |
| Deployment identity and restart | `test/deployment/` |
| Source reward acceptance, attributed custody, fee isolation and partial delivery | `test/StickySourceCollector.t.sol`; deployed split/route integration in `test/fork/StickyJbxOmnichain.t.sol` and credits in `test/fork/StickySourceCredits.t.sol` |
| Quotes, configuration, and transaction recovery | `web/test/lib/sticky-quotes.test.ts`, `web/test/deployment-env.test.ts`, `web/test/transactions/`, `web/test/lib/sticky-launch-session.test.ts`, `web/test/lib/sticky-bridge-journal.test.ts` |
