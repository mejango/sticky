# Audit Instructions

## Audit objective

Find a concrete sequence that loses backing, corrupts share or tranche accounting, blocks another holder's exit, redirects rewards, or causes the client to authorize a different outcome from the one it presents. Verify findings against the pinned core and distributor implementations. Distinguish a source defect from a documented economic choice, a dependency failure, or an unverified deployment.

The [2026-10-09 adversarial review](ADVERSARIAL_REVIEW_2026-10-09.md) owns the latest findings and supersedes earlier readiness conclusions. Its open native Ethereum-to-Arbitrum asynchronous-refund defect excludes that native collector lane from live qualification; CCIP is a distinct transport requiring separate qualification. Ethereum-home JBX delivery has separate release gates.

## Scope

- Solidity in `src/`, including interfaces, structs, and `StickyPricing`.
- Deployment and verification under `script/`, environment handling, and Sphinx network groups.
- The core pay/mint/burn/cash-out flows and the inherited `JBDistributor` snapshot, vesting, and recycling logic actually used by `StickyDistributor`.
- `web/` configuration, project identity, quote units, transaction preparation, receipt recovery, rewards, and cross-chain flows, including the shared SDK rules it consumes.

Read [ARCHITECTURE.md](./ARCHITECTURE.md), [INVARIANTS.md](./INVARIANTS.md), [RISKS.md](./RISKS.md), and [USER_JOURNEYS.md](./USER_JOURNEYS.md), then trace source in this order:

1. `StickyDeployer`: permanent project metadata, ownership, accepted token, and core bindings.
2. `StickyPricing`, `StickyPriceFeed`, and `StickyHook`: exact issuance, orphaned backing, callback authentication, and position accounting.
3. `StickyToken`: every mint, transfer, burn, delegation, and checkpoint transition.
4. `StickyDistributor`: group encoding, the window pinned at round start, the denominator read from the hook's buckets at first funding, live-tranche numerators, the pot-remainder cap, split fallback to group 0, and the unregistered-token check.
5. `StickyAutoStick`, `StickyRewardReceiverFactory`, and `StickyRewardReceiver`: collection consent across groups, balance deltas, settlement timing, group validation, and destination identity.
6. `StickySourceCollector` and `StickySourceFeePayer`: immutable nonzero destination-family identity, authenticated reserved acceptance, nested receipt accounting, per-project/bucket liabilities, credit materialization, home-chain-only settlement, qualified direct replacement routes, execution-time backing bounds, outbox frontier and sent-leaf checks, isolated fee receipts and both native refund ledgers.
7. Core `JBMultiTerminal`, `JBTerminalStore`, `JBController`, `JBTokens`, and `JBPrices`, paired with distributor `JBDistributor`; for collection, also the real controller's reserved-token catch-and-burn behavior, `JBSucker.prepare`, `toRemote`, retained registry/transport refunds, the registry's builder trust and native transport implementations actually deployed on the selected routes.
8. Deployment helpers and the client transaction path for the same operation. Verify the shared collector and its constructor-created fee child through the existing singleton helper and [source-hook setup recipe](DEPLOYMENT.md#source-collectors).

## Attack sequences

- Deposit, donate, partially redeem, voluntarily burn, fully exit, donate while empty, and bootstrap again. Track terminal backing, orphaned funds, share supply, and every holder's tranche sum.
- Leave one holder with dust and redeem every share belonging to another. Repeat in soulbound and transferable projects; another account's residual position must not impose a minimum balance on the exiter.
- Reduce supply to a few atoms, increase backing per atom, and try exact and inexact deposits across 0–36 accounting decimals. Rejected payments must not donate value; accepted payments must match exact rounded issuance.
- Reenter during the underlying token's transfer or approval callbacks. Attempt mint-time share transfers, controller burns, nested deposits, and donations before the after-pay reconciliation.
- Build many positive tranches in the same week and across weeks, exit partially and fully, then reuse the position. Check newest-first consumption, timestamp preservation, same-week merging, that every consumed tranche debits its original epoch bucket, that buckets always sum to supply, and bounded reads.
- Stake before and after a round start in the same week, fund a tenure group early and late in the round, exit and transfer between funding and claiming, and claim in every order. The recorded denominator must equal the in-window stake at first funding, no later stake may enter the window, and the sum of claims must never exceed the pot.
- Fund a tenure group through a split whose `projectId` is invalid, whose beneficiary is a token the hook does not track, or whose `lockedUntil` is set; fund directly with the same inputs.
- Compare cash outs at zero, intermediate, and maximum tax for a partial holder exit and the whole supply. Include a feeless beneficiary, fee-free surplus, a failed fee route, and low-decimal rounding. Compare gross preview with net receipt.
- Acquire shares for one block, call `poke()`, exit, and fund both pinned group-0 rounds. Repeat with transferable shares returned to their source, and repeat against a tenure group, which must pay that position nothing.
- Begin vesting, permissionlessly collect to the holder, and attempt a later compound. Fail each approval, transfer, preview, and payment step to check atomicity and that unrelated wallet funds are untouched.
- Fund a predicted receiver before deployment, settle across a round boundary, and compare predictions across different factories, destination tokens, and groups; confirm only the factory can initialize a clone, once, and that the implementation stays uninitialized.
- Construct collectors for zero, Ethereum and non-Ethereum destinations. Reject zero; require local settlement only on the immutable destination and remote sending only elsewhere. Verify the selected peer equals that destination, group encoding remains unchanged, and identical source-project/token/group keys in another collector family do not share custody. Equal arguments must produce equal family addresses across source chains; changing the home chain must produce a separate family.
- Construct the shared collector with missing or malicious canonical dependencies. Distinguish code/binding checks from deployment's obligation to authenticate actual runtime identities and receiver-factory parity. Exercise source projects beyond the initial JBP6/REV fixtures; runtime must not inherit those fixtures' project, source-chain or native-asset restrictions.
- Call reserved acceptance through the actual current controller and through unauthorized callers, with wrong split groups/hooks/decimals, native value, mismatched ERC-20s, invalid reward groups and zero beneficiaries. Exercise both ERC-20 pulls and transferred credits, including a controller that cached credits before an earlier split deployed the ERC-20. Confirm rejection consequences against core's real catch-and-burn behavior, not only a mock revert.
- Queue allocations for several source projects, Sticky tokens and reward groups. Check bucket sums against `totalPendingOf` and combined token/credit custody; plain donations must not create a spendable allocation. Accept credits before the ERC-20 exists, reject delivery without losing that pending balance, then deploy the token and deliver only the requested shortfall. No bridge fee, terminal, route or settlement availability may be necessary for a valid acceptance, including on the home chain.
- Trigger valid nested allocations during token pulls, including same-project ERC-20 and credit receipts, and another project's real reserved distribution. Combined-custody delta must exclude nested pending growth exactly once; rejecting every nested callback can cause core to burn another project's reserves. Attempt outbound calls at every active acceptance depth and reenter outbound delivery during claims, transfers and fees. Valid incoming allocations during delivery must stay queued.
- Settle positive partial home-chain buckets with preexisting receiver inventory, across a reward-round boundary and into tenure groups. The debit belongs only to the chosen bucket; the returned settled amount may include previous receiver inventory. Fail materialization, transfer and receiver settlement separately and require full rollback.
- Supply unregistered, spoofed or wrong-project routes, inconsistent canonical registry/directory/token bindings, wrong peers and disabled/emergency mappings. Check every sending state on delivery and the earlier send-disable cutoff during pending deprecation. Then select a valid replacement route and mapped ERC-20 backing. No caller-selected route may change the bucket's home-chain receiver; no valid replacement means pending rewards remain queued.
- Send zero, dust, partial and large amounts at changing backing quotes and fees. Check the actual sucker holder/beneficiary preview, standard-fee rounding in backing-token atoms, zero-quote support, exact approval and allowance reset, custom-hook preview mismatch and upstream count limits. Seed a nonempty outbox; require exactly one leaf during preparation and prove submission includes that index and beneficiary, even if fee callbacks append later leaves. Fail each step and verify pending balances, custody, token supply, allowance and outbox rollback.
- During bridge fee payment, distribute additional reserved tokens to the parent while issuing the fee receipt to the child; use the same token for principal and receipts. Test the dynamically selected route/fee token, native fee minimum and transport budget, missing fee ERC-20 with positive and zero fees, prior token donations and forced ETH. Reject preexisting retained registry or transport credits, return new credits directly to the caller and require both ledgers empty afterward. A rejecting caller may abort its own attempt but cannot stop another caller from retrying. Deliberately donate fee tokens during submission to confirm that the child's same-call balance delta does not authenticate provenance; principal must remain in the parent's attributed buckets.
- Trace real reserved issuance through home-chain settlement or remote source leaf/supply/escrow accounting, modeled native finality, destination claim, receiver settlement and holder collection. Include source credits followed by ERC-20 deployment, and establish destination ERC-20 readiness before remote claims. Check REV's total-issuance versus reserved-allocation denominator, preserved split remainder and integer dust. Do not infer canonical finality or a running keeper from a passing fork handoff.
- Change the connected account or chain during a multi-step client action; reject a signature, lose the RPC response after submission, and resume after reload. Verify destination, minimums, canonical receipts, and whether a retry would duplicate value movement.
- Attempt a multi-target Sticky launch through preparation, restored plans and the wallet boundary, including stale saved metadata. Preserve recorded receipts for inspection while preventing further multi-target submission. Use chain-qualified asset input and equal addresses/names on different chains; no consumer may merge independent pool supplies or change the reviewed home chain. The shared SDK must retain multichain primitives used by other clients.
- Present a route to an intermediate Ethereum peer for an L2-home collector and reject it. Source/home setup must qualify a direct lane and destination reward ERC-20; an immutable destination alone does not establish native L2-to-L2 support. No fallback or implicit relay may disguise unsupported routing.
- Rehearse clean, partial, repeated, and mismatched deployments for each selected home-chain family. Check same-family collector parity, different-family isolation, the no-argument nonce-1 child, all immutable occurrences including destination chain, and family-specific manifests/artifacts while preserving the six existing runtime identities. Reject differently targeted or incomplete family records; verify source revision freshness separately rather than inferring it from address/kind validation. Treat foreign code, immutable mismatches, unverified dependencies and missing direct-route qualification as distinct failures. Mainnet and testnet destinations must remain explicitly identified.

## Evidence and reporting

For a defect, provide the affected contract or client entrypoint, required starting state, executable sequence, observed result, expected invariant, and value or availability impact. Use a focused regression when changing behavior. Keep historical findings in review reports; source comments describe the current mechanism and its reason.

Validate source and documentation against [STYLE_GUIDE.md](./STYLE_GUIDE.md). Check complete NatSpec, correct units, current function names, and user-facing claims as part of the same review. A fixed test count or static-analysis result is evidence about that run, not certification of a release.

Inventory every public contract against its interface, including immutable and constant getters. Receiver, collector and fee-payer interfaces must own their declarations/events; concrete contracts retain execution/errors. Check typed factory/fee-child getters and the reused `IJBSucker` public boundary, accounting for upstream APIs that still require an implementation cast. Compare deployed singleton bytecode, function/error selectors and event topics after declaration changes; a renamed ABI `internalType` alone is not changed encoding. Preserve current ERC-165 behavior and keep the collector's destination behavior change separately attributable.

The [historical collector report](SOURCE_COLLECTOR_AUDIT.md) covers the superseded fixed-route design. The [omnichain review](OMNICHAIN_SPLIT_HOOK_REVIEW.md) separately labels the later Ethereum-only implementation evidence as historical. Record new home-chain evidence against the exact reviewed source and dependencies; do not inherit either design's pass counts, hashes or addresses. The [accepted home-chain plan](tasks/home-chain-pools.md) and [operative hook plan](tasks/omnichain-split-hook.md) define the current scope.

## Verification

Use the workspace and toolchain described in [README.md](./README.md), then run:

```sh
forge fmt --check
forge test --deny notes --fail-fast --summary --detailed --skip '*/script/**'
npm run test:deployment
STICKY_ENV_FILE=../../deploy-all-v6/.env npm run test:fork
forge build --deny notes --sizes --skip '*/test/**' --skip '*/script/**' --skip SphinxUtils
forge build --skip '*/test/**'
slither . --config-file slither-ci.config.json --fail-medium
```

Use the separate Node/npm toolchain in [web/README.md](web/README.md), then run the client's complete check from `web/`:

```sh
npm run check
```

The client gate includes lint, types, deployment/schema/transaction inventories, coverage, a production build and browser tests. The [web workflow](.github/workflows/web.yml) additionally checks the production container. Historical reports retain their original legacy-client evidence, with source and tests preserved at the [pre-cutover revision](https://github.com/mejango/sticky/tree/8bff9575f57807df244c1c41b9045f614ab7a76c/webclient). The [cutover record](tasks/sticky-next-cutover.md) documents the transition.

Use [DEPLOYMENT.md](./DEPLOYMENT.md) for fork rehearsals, Sphinx proposals, and post-execution verification. Run target-chain wallet checks after execution; a local test or read-only rehearsal cannot establish those outcomes. Contract changes remain in their PR through review, authorized deployment and verification, then require explicit approval of the final PR before merge. Review completion and passing CI do not authorize deployment, source-split changes or merging.
