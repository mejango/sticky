# Transaction coverage: Sticky

This inventory tracks semantic coverage of wallet-affecting operations. The
contracts and canonical SDK ABIs are authoritative; Bendystraw is display and
discovery data only. `npm run transaction:check` reads this table and
`test/transaction-sites.json`. Every write site names the actions it sends, and
every action here names the tests that cover it.

Legend:

- **E**: exact request or calldata encode/decode assertions
- **S**: canonical selector/ABI-shape assertion only
- **P**: pure planning/state-machine assertions
- **-**: no dedicated regression test yet

Every test file an action lists must carry the action's marker in the title of
an `it` or `test` that runs and proves the action: `wallet-action:` plus the
action's name in lowercase with hyphens (`wallet-action:stick-for-someone-else`
for "Stick for someone else"). A marker counts only on a test written directly
in a `describe` body or at the top of the file (not inside an `if`, a loop or a
function, and not after a `return`), with an inline callback, options that carry
no `skip`, `todo` or `fails` and no spread, computed key or variable before the
callback (a constant after it is a timeout), a context that the test and the
hooks of its suite only read as `ctx.name` and never as `skip` (the `arguments`
of a `function` callback are the context too), no `beforeEach`, `afterEach` or
`aroundEach` in its suite or the suites around it that is not written inline or
as `vi.<name>`, no call statement there but a test, suite, hook, `vi`, `vitest`
or `expect` call (a helper may register a hook that skips), and, for `.each` and
`.for`, a table written as an array literal with a row; a `describe` or `suite`
title does not count, and nothing under `.skip`, `.todo`, `.skipIf`, `.runIf`,
`.fails`, `.extend` or a bracketed modifier (`describe['skip']`) counts, so a
broad test file cannot make a new operation look covered.

A hook hung off the test API (`test.beforeEach`) is refused like any hook the
check cannot read. The check does not read a helper call inside a declaration or
expression (`const gate = installGate()`, `ok && installGate()`) or an alias of
an extended test (`const test = base.extend({...})`), since refusing every
suite-level call, `new` included, would drop 75 of the 76 marked titles today.
`npm run transaction:check` fails on a missing marker.

| User action | Contract function or authorization | Coverage | Test |
| --- | --- | :---: | --- |
| Create a Sticky token | `StickyDeployer.deployStickyFor`, with fresh deployment/token/fee/adapter reads and exact reviewed calldata, durable intent and hash before waiting; only canonical matching DeploySticky and Create events complete it | **E** | `lib/sticky-launch-adapter.test.ts`, `lib/sticky-launch-session.test.ts` |
| Pay for a multichain Sticky launch | Exact bound Relayr quote option, unpaid and runtime checks, reviewed funding call, durable payment intent/hash and SDK canonical payment proof; raw launch publication is never replaced after an unknown reply | **E** | `lib/sticky-launch-adapter.test.ts`, `lib/sticky-launch-session.test.ts` |
| Authorize Sticky listing | SDK validates the Center envelope, content hash and exact signing message before the connected publisher signs; retries retain the original launch and never duplicate a sponsor request | **E** | `lib/sticky-listing.test.ts`, `lib/sticky-launch-session.test.ts` |
| Submit a reviewed direct write | reviewed-account check → review → chain/account check → simulate → exact simulated write | **P** | `transactions/contract-write.test.ts`, `transactions/use-safe-tx.test.ts`, `transactions/sticky-use-safe-tx.test.tsx`, `transactions/signa-gate.test.tsx` |
| Approve the staked token for a stick | `ERC20.approve` to the project's terminal: a reset to zero first when the allowance is not zero, the exact amount, and nothing when the allowance already covers it | **E** | `lib/sticky-builders.test.ts`, `components/stick-flow.test.tsx`, `components/stick-flow-engine.test.tsx` |
| Stick | `JBMultiTerminal.pay` for the holder, with the freshly read `previewPayFor` as its minimum | **E** | `lib/sticky-builders.test.ts`, `lib/sticky-quotes.test.ts`, `components/stick-flow.test.tsx`, `components/stick-flow-engine.test.tsx` |
| Stick for someone else | `JBMultiTerminal.pay` with another beneficiary, sent only after `isGranterOf` or `isTrustedSenderOf` says the sender may | **E** | `lib/sticky-builders.test.ts`, `lib/sticky-quotes.test.ts`, `components/stick-flow.test.tsx`, `components/stick-flow-engine.test.tsx` |
| Turn off auto-stick | `StickyAutoStick.setConfigFor(projectId, false, minimum, cooldown)` | **E** | `components/unstick-flow.test.tsx`, `lib/sticky-builders.test.ts`, `components/autostick-flow.test.tsx` |
| Take back the auto-stick adapter's trust | `StickyHook.setTrustedSenderFor(projectId, adapter, false)`, in a teardown, and alone when auto-stick is off and the holder still trusts the adapter, stopped then when auto-stick was turned back on since the review | **E** | `components/unstick-flow.test.tsx`, `lib/sticky-builders.test.ts`, `components/autostick-flow.test.tsx` |
| Take back the auto-stick adapter's allowance | staked token `approve(adapter, 0)`, in a teardown, and alone when auto-stick is off and an allowance is left, stopped then when auto-stick was turned back on since the review | **E** | `components/unstick-flow.test.tsx`, `lib/sticky-builders.test.ts`, `components/autostick-flow.test.tsx` |
| Approve the auto-stick adapter's allowance | staked token `approve` to the auto-stick adapter for exactly the cap (unlimited, or the custom cap), reset to zero first when it is neither zero nor the cap, and nothing when it is the cap already; stopped when auto-stick or the holder's trust changed since the review | **E** | `lib/sticky-builders.test.ts`, `components/autostick-flow.test.tsx` |
| Turn on auto-stick | `StickyAutoStick.setConfigFor(projectId, true, minimum, cooldown)`, last, after an auto-stick that is on is turned off with its old settings and the allowance and trust are in place; a minimum of nothing or past a uint128 and a cooldown outside 1 to 30 days are refused before review, and each step is stopped when auto-stick or the holder's trust changed since the review (one turned on elsewhere, say); the allowance is held only for a turn-on that approves nothing, to at least the cap, and never after the plan's own approval (a token may store less, as UNI and COMP store 2^96 - 1) | **E** | `lib/sticky-builders.test.ts`, `components/autostick-flow.test.tsx` |
| Change auto-stick settings | `StickyAutoStick.setConfigFor(projectId, true, minimum, cooldown)` alone, for an auto-stick that is on, within the same bounds, and stopped when it was turned off or the trust changed since the review, never for an allowance a keeper spent from | **E** | `lib/sticky-builders.test.ts`, `components/autostick-flow.test.tsx` |
| Stick ready rewards now | `StickyAutoStick.compoundFor(projectId, holder, groupIds)` for the groups holding ready staked-token rewards, refused before review unless the adapter says it is ready and the mint is more than nothing, and stopped when auto-stick or the trust changed since the review, or the allowance fell below what was ready | **E** | `lib/sticky-builders.test.ts`, `components/autostick-flow.test.tsx` |
| Start unlocking rewards | `StickyAutoStick.beginVestingFor(projectId, holder, groupIds)` for the groups whose finished rounds hold rewards not yet vesting, refused before review with auto-stick off or no such group, and stopped when auto-stick or the trust changed since the review, never for the allowance | **E** | `lib/sticky-builders.test.ts`, `components/autostick-flow.test.tsx` |
| Collect rewards or start vesting | `StickyDistributor.collectVestedRewards(stToken, groupId, [holder], [token], holder)`, which also starts vesting what finished rounds earned, refused before review when nothing is collectable or vestable, and tried against the chain as the holder first | **E** | `lib/sticky-builders.test.ts`, `components/claim-flow.test.tsx` |
| Approve the staked token for a claim and stick | staked token `approve` to the auto-stick adapter for the claim: a reset to zero first when the allowance is not zero, the exact claim, and nothing when the allowance already covers it | **E** | `lib/sticky-builders.test.ts`, `components/claim-flow.test.tsx` |
| Trust the auto-stick adapter | `StickyHook.setTrustedSenderFor(projectId, adapter, true)`, planned only when neither the holder trusts the adapter nor the project made it a granter | **E** | `lib/sticky-builders.test.ts`, `components/claim-flow.test.tsx`, `components/autostick-flow.test.tsx` |
| Claim and stick rewards | `StickyAutoStick.stickRewardsFor(projectId, groupIds)` for the groups holding collectable staked-token rewards, refused before review for a claim of nothing or a mint of nothing, and stopped when the claim has changed | **E** | `lib/sticky-builders.test.ts`, `components/claim-flow.test.tsx` |
| Create a reward address | `StickyRewardReceiverFactory.deployReceiverFor(stToken, groupId)` for the group the weeks name, refused before review when the address exists or the factory settles into another distributor than the deployment's, and tried against the chain as the sender first | **E** | `lib/sticky-builders.test.ts`, `components/receiver-flow.test.tsx` |
| Settle arrivals into airdrops | `StickyRewardReceiverFactory.settleFor(stToken, groupId, token)` for an ERC-20 only, refused before review for ETH, for an address that is no token, for an address that holds none of the token and for a factory that settles into another distributor, and tried against the chain as the sender first | **E** | `lib/sticky-builders.test.ts`, `components/receiver-flow.test.tsx` |
| Approve a reward token for an airdrop | `ERC20.approve` to the distributor: a reset to zero first when the allowance is not zero, the exact amount, nothing when the allowance already covers it, and never for ETH | **E** | `lib/sticky-builders.test.ts`, `components/fund-flow.test.tsx` |
| Send an airdrop | `StickyDistributor.fund(stToken, token, amount, groupId)` for the group the weeks name, sent only after the distributor's `isValidGroupId` accepts it and the balance covers it, with `value` equal to the amount for ETH (JB's native token); an address that answers no `decimals()` is refused before review as no token | **E** | `lib/sticky-builders.test.ts`, `components/fund-flow.test.tsx` |
| Approve a bridge transfer | Exact source-token `approve` to the verified sucker, reset when necessary; each saved step is rebuilt and compared before submission | **E** | `lib/sticky-bridge.test.ts`, `components/bridge-flow.test.tsx` |
| Queue cross-chain rewards | `JBSucker.prepare` with reviewed minimum backing, receiver, amount and random metadata; durable intent precedes the wallet and canonical source/event proof releases it | **E** | `lib/sticky-bridge.test.ts`, `lib/sticky-bridge-journal.test.ts`, `components/bridge-flow.test.tsx` |
| Send queued rewards across chains | Verified transport's `toRemote` with the simulated fee budget and fresh queued-tree evidence | **E** | `lib/sticky-bridge.test.ts`, `components/bridge-flow.test.tsx` |
| Deliver queued rewards | SDK-built `StickySourceCollector.send` for a partial accepted allocation, with fresh route and queue checks, an exact simulated transport budget, durable request and route watch before the wallet; unknown hashless attempts cannot retry, and canonical source proof remains separate from arrival and settlement | **E** | `lib/sticky-collector-delivery.test.ts`, `components/collector-flow.test.tsx` |
| Settle queued rewards | SDK-built `StickySourceCollector.settle` for a partial accepted allocation on its home chain, with fresh custody and receiver checks; only canonical matching execution proof marks settlement complete | **E** | `lib/sticky-collector-delivery.test.ts`, `components/collector-flow.test.tsx` |
| Claim arriving rewards | Destination `claim` with dense source-tree proof matched to the live inbox root, for the group's verified receiver; settlement reuses the receiver flow | **E** | `lib/sticky-bridge.test.ts`, `components/bridge-flow.test.tsx` |
| Unstick Sticky tokens | `JBMultiTerminal.cashOutTokensOf` with the quote's net as its minimum | **E** | `components/unstick-flow.test.tsx`, `lib/sticky-builders.test.ts`, `lib/sticky-quotes.test.ts` |
| Transfer Sticky tokens | Sticky token `transfer` of an 18-decimal amount, refused for a locked token, for the zero address, for the sender's own address and for the Sticky token, hook and terminal, and stopped when the balance has fallen | **E** | `lib/sticky-builders.test.ts`, `components/transfer-flow.test.tsx`, `transactions/sticky-transfer-trust.test.tsx` |
| Trust or untrust a sender | `StickyHook.setTrustedSenderFor`, refused for the zero address, and stopped when the hook already says so | **E** | `lib/sticky-builders.test.ts`, `components/trust-flow.test.tsx`, `transactions/sticky-transfer-trust.test.tsx` |
