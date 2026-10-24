# Sticky client convergence, 2026-10-24

## Plan refinement
- **Objective:** Verify and enforce the five selected client correctness rules on Sticky's reachable paths, without contracts, deployment, merges or unrelated original-tree edits. The user clarified that shop voting must always be price based; Sticky has no shop compiler to change.
- **System fit:** Sticky's SDK4 reviewed-send adapter owns wallet invocation for direct, approval and Relayr calls; project/chain read owners retain identity and read completeness. No shop tier compiler exists in this one-stage ERC20 product.
- **Reuse and simplicity:** Reuse the existing adapter and tests, add focused source-bound regressions only where they protect actual behavior; do not invent absent shop features or cross-chain aggregates.
- **Evidence and unknowns:** Isolated origin/main 2621788e34eb9eb3206efa53c0cd66877dc0827d matches the parent's refreshed revision; a successful refreshed fetch confirms the same remote revision. Installed locked SDK4 source confirms current-client resolution and account/chain/Safe binding.
- **Verification:** Exercise current-wallet resolution after awaited preparation and account/chain/Safe rejection using actual installed SDK; inspect balances and identity consumers, run applicable web checks and record exact results and limits.
- **Resource budget:** Bounded Sticky-only source census and focused regressions, locked physical dependencies, full unit/lint/type/inventory gates for any edits. Replan only for a demonstrated shared SDK defect; preserve dirty original sphinx.lock and web/AGENTS.md.

- [x] Inspect all five rule owners and sibling paths.
- [x] Add applicable focused regressions or fixes after plan check.
- [x] Run required checks and report the five-rule scope matrix.

Resources: /Users/jango/Documents/jb/v6/evm/AGENTS.md, workflow/ponytail/SKILL.md, docs/PLAN_REFINEMENT.md, tasks/lessons.md, extensions/sticky/web/AGENTS.md. Isolated web/AGENTS.md also applies.

## Scope matrix and review

| Rule | Sticky result | Owning evidence |
| --- | --- | --- |
| Always price-based shop voting | Not applicable, Sticky has no shop tier compiler or tier editing form | web/src/lib/sticky-launch-plan.ts LaunchInput, deployStickyFor preparation |
| Current wallet at invocation | Already compliant; add regression through actual useReviewedAction and installed SDK4 for direct/approval switch during deferred beforeWallet, and adapter account/chain/Safe changes during resolver await | web/src/lib/wallet-core.ts:39, web/src/hooks/useReviewedAction.ts, installed SDK4 review/wallet.js connection and sendTransaction |
| Chain-qualified custom tokens | Already compliant; no cross-chain asset-value aggregation. Per-chain funding and rewards are scoped by chain/project, and global token metadata keys include chain | web/src/lib/sticky-rewards.ts:373,492; existing test/lib/sticky-rewards.test.ts:993 |
| Reject initialSupply1 with reserve | Not applicable, no NFT shop tier initial supply or reserve compiler | web/src/lib/sticky-launch-plan.ts LaunchInput, no initialSupply/reserveFrequency/useVotingUnits occurrences in web/src |
| Unknown balances remain unknown | Already compliant; add rendered menu Loading/Unavailable regressions. Existing account page suppresses empty claims until all chains answered and no failures/skipped projects | web/src/components/SignedInWallet.tsx:22,43; web/src/components/account/AccountPositions.tsx:64; web/test/components/account.test.tsx:665 |

Seven new tests across three existing test files. No application code, dependency, contract, or original Sticky checkout changes. Final focused proof passed 175 tests in five files, including existing same-address/different-chain token cache and partial/all-chain balance failure regressions.

Full coverage passed 3811 tests in 172 files on Node 26.12.1 with one worker. Coverage: statements 94.62%, branches 90.74%, functions 94.44%, lines 96.73%. Lint, final typecheck, production audit (existing fail-closed zod3 exception), deployment synchronization, offline schema registry, transaction inventory and wallet inventory all passed. The wallet inventory verified three production signing/submission sites and zero residuals.

Production build and all five existing client budgets passed with Node 26.12.1 and npm 12.0.1 using physical locked dependencies. Budgets: home 326.7/328 KiB, project 343.1/345 KiB, account 317.6/319 KiB, callback 211.8/216 KiB, missing route 210.6/214 KiB. The budget checker required approved localhost access after the sandbox denied listen. Initial broad test runs were interrupted under severe shared-machine load after unrelated timed-review failures; the complete serial rerun passed, and the first affected unstick case separately passed unchanged.

No browser, Docker, deployment, merge or wallet-execution claim. The change is tests and this scoped verification record only; existing application behavior already satisfies every applicable selected rule.
