# Audit Instructions

## Audit objective

Find a concrete sequence that loses backing, corrupts share or tranche accounting, blocks another holder's exit, redirects rewards, or causes the client to authorize a different outcome from the one it presents. Verify findings against the pinned core and distributor implementations. Distinguish a source defect from a documented economic choice, a dependency failure, or an unverified deployment.

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
6. `StickySourceCollector` and `StickySourceFeePayer`: source principal versus caller fee receipts, route authentication, execution-time cashout bounds, outbox frontier and sent-leaf checks, callbacks and atomic refunds.
7. Core `JBMultiTerminal`, `JBTerminalStore`, `JBController`, `JBTokens`, and `JBPrices`, paired with distributor `JBDistributor`; for collection, also `JBSucker.prepare`, `toRemote`, retained-fee claims, the registry and native transport implementations actually deployed on the selected routes.
8. Deployment helpers and the client transaction path for the same operation. Source collectors are outside the singleton deployment helper; review their separate [verification recipe](DEPLOYMENT.md#source-collectors).

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
- Attempt collector construction with unsupported chains/projects, fake self-reported registries, the wrong transport family, missing tokens, non-Ethereum peers, disabled/emergency/non-native mappings and incorrect receivers. Separate contract rejections from identities that deployment must authenticate; a nonzero receiver and reported registry membership alone do not establish a canonical route.
- Send zero/dust and large source balances at changing terminal quotes and fees. Check the actual sucker holder/beneficiary preview, standard-fee rounding, positive native minimum, exact approval and allowance reset. Seed a nonempty outbox; require one appended leaf and prove that the submitted root includes its exact index/beneficiary, not merely earlier leaves. Fail each step and verify principal, token supply, allowance and outbox rollback.
- During bridge fee payment, distribute additional reserved tokens to the parent while issuing the fee receipt to the child; use the same token for source principal and fee receipts. Only the child's same-call increase may reach the caller. Add prior token donations and forced ETH, configure an incorrect child split as a negative setup case, and test receipt/refund failures, preexisting retained credit and zero registry fees.
- Reenter the parent through source preparation, fee payment, receipt transfer and native refund callbacks. Attempt direct child submission and unauthorized route/beneficiary selection. A caller rejecting its own refund must not prevent a different caller from retrying. Test every sucker lifecycle state at construction and send, including the earlier send-disable cutoff within a deprecation schedule, and distinguish future split redirection from recovery of already-held inventory. Deliberately donate fee tokens to the child during submission to confirm that its measured delta does not authenticate provenance.
- Trace every collector lane from real reserved issuance through source leaf/supply/escrow accounting, modeled native finality, destination claim, receiver settlement and holder collection. Check REV's total-issuance versus reserved-allocation denominator, preserved split remainder and integer dust. Do not infer canonical finality or a running keeper from a passing fork handoff.
- Change the connected account or chain during a multi-step client action; reject a signature, lose the RPC response after submission, and resume after reload. Verify destination, minimums, canonical receipts, and whether a retry would duplicate value movement.
- Rehearse clean, partial, repeated, and mismatched deployments on both network groups. Treat foreign code, immutable mismatches, stale manifests, and unverified privileged core bindings as distinct failures.

## Evidence and reporting

For a defect, provide the affected contract or client entrypoint, required starting state, executable sequence, observed result, expected invariant, and value or availability impact. Use a focused regression when changing behavior. Keep historical findings in review reports; source comments describe the current mechanism and its reason.

Validate source and documentation against [STYLE_GUIDE.md](./STYLE_GUIDE.md). Check complete NatSpec, correct units, current function names, and user-facing claims as part of the same review. A fixed test count or static-analysis result is evidence about that run, not certification of a release.

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

Use [DEPLOYMENT.md](./DEPLOYMENT.md) for fork rehearsals, Sphinx proposals, and post-execution verification. Run target-chain wallet checks after execution; a local test or read-only rehearsal cannot establish those outcomes.
