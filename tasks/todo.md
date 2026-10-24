# Sticky client convergence, 2026-10-24

## Plan refinement
- **Objective:** Verify and enforce the five selected client correctness rules on Sticky's reachable paths, without contracts, deployment, merges or unrelated original-tree edits. The user clarified that shop voting must always be price based; Sticky has no shop compiler to change.
- **System fit:** Sticky's SDK4 reviewed-send adapter owns wallet invocation for direct, approval and Relayr calls; project/chain read owners retain identity and read completeness. No shop tier compiler exists in this one-stage ERC20 product.
- **Reuse and simplicity:** Reuse the existing adapter and tests, add focused source-bound regressions only where they protect actual behavior; do not invent absent shop features or cross-chain aggregates.
- **Evidence and unknowns:** Isolated origin/main 2621788e34eb9eb3206efa53c0cd66877dc0827d matches the parent's refreshed revision; a successful refreshed fetch confirms the same remote revision. Initial preparation-only tests checked SDK4 account/chain/Safe binding; Astra later reproduced the acquisition race addressed below.
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
| Current wallet at invocation | Corrected the acquisition race: use the explicitly current connector and invoke immediately after final account/chain/Safe checks. Initial beforeWallet-only tests missed this race; actual wagmi acquisition regressions and SDK cleanup/signature tests now cover it | web/src/lib/wallet-core.ts:39, web/src/hooks/useReviewedAction.ts, installed SDK4 review/wallet.js connection and sendTransaction |
| Chain-qualified custom tokens | Already compliant; no cross-chain asset-value aggregation. Per-chain funding and rewards are scoped by chain/project, and global token metadata keys include chain | web/src/lib/sticky-rewards.ts:373,492; existing test/lib/sticky-rewards.test.ts:993 |
| Reject initialSupply1 with reserve | Not applicable, no NFT shop tier initial supply or reserve compiler | web/src/lib/sticky-launch-plan.ts LaunchInput, no initialSupply/reserveFrequency/useVotingUnits occurrences in web/src |
| Unknown balances remain unknown | Already compliant; add rendered menu Loading/Unavailable regressions. Existing account page suppresses empty claims until all chains answered and no failures/skipped projects | web/src/components/SignedInWallet.tsx:22,43; web/src/components/account/AccountPositions.tsx:64; web/test/components/account.test.tsx:665 |

Seven new tests across three existing test files. No application code, dependency, contract, or original Sticky checkout changes. Final focused proof passed 175 tests in five files, including existing same-address/different-chain token cache and partial/all-chain balance failure regressions.

Full coverage passed 3811 tests in 172 files on Node 26.12.1 with one worker. Coverage: statements 94.62%, branches 90.74%, functions 94.44%, lines 96.73%. Lint, final typecheck, production audit (existing fail-closed zod3 exception), deployment synchronization, offline schema registry, transaction inventory and wallet inventory all passed. The wallet inventory verified three production signing/submission sites and zero residuals.

Production build and all five existing client budgets passed with Node 26.12.1 and npm 12.0.1 using physical locked dependencies. Budgets: home 326.7/328 KiB, project 343.1/345 KiB, account 317.6/319 KiB, callback 211.8/216 KiB, missing route 210.6/214 KiB. The budget checker required approved localhost access after the sandbox denied listen. Initial broad test runs were interrupted under severe shared-machine load after unrelated timed-review failures; the complete serial rerun passed, and the first affected unstick case separately passed unchanged.

No browser, Docker, deployment, merge or wallet-execution claim. These are the initial pre-Astra verification results. The wallet conclusion and tests-only scope are superseded by the acquisition correction below; the other four rule dispositions remain unchanged.

# Close the current-wallet acquisition race

## Plan refinement
- **Objective:** Correct Astra's reproduced SDK4/wagmi acquisition race so every Sticky wallet invocation uses the current same-account connector, while rejecting changed reviewed account, chain or Safe route; no SDK, dependency, contract or transport change.
- **System fit:** web/src/lib/wallet-core.ts owns every adapter send, signature and batch. The callback helper acquires the explicitly current connector, retries connector replacement, and invokes the actual method synchronously after final identity checks plus live ViewAs and per-action synchronous guards bound by the existing engine bridge; proven pre-invocation write aborts carry a private branded 4001 shim for SDK hold cleanup, then the existing review-engine loader exposes a plain readable error; signatures keep their normal ReviewLineError and actual ambiguous method failures retain recovery.
- **Reuse and simplicity:** Reuse the existing app adapter and Homerun's bounded callback pattern, SDK ReviewLineError/WalletAdapter types and existing journal tests. Replace the generic adapter rather than wrapping its extra await or adding a transport framework.
- **Evidence and unknowns:** /private/tmp/astra-wallet-race.mjs executes installed wagmi/SDK and proves current selected but old invoked. Prior preparation-only switch tests missed connector acquisition awaits; the earlier already-compliant wallet conclusion is superseded.
- **Verification:** Add actual wagmi plus app-adapter tests holding getChainId/getProvider for direct payments, approvals, messages, typed signatures and batches, negative account/chain/route tests, bounded retry and pre-invocation hold cleanup. Run required owning gates and build/budgets, then obtain independent Astra review of frozen source before publication.
- **Resource budget:** Sticky only, physical locked dependencies, pinned Node26 and max2 test workers. No unrelated refactor or feature expansion; parent owns publication after review. Measure any budget footprint before considering a minimal justified ceiling change.

- [x] Replace adapter acquisition with synchronous final callback invocation.
- [x] Prove connector acquisition races and definitely-unsent cleanup with actual-source regressions.
- [x] Run focused local checks and artifacts, obtain Astra re-review and commit the owned candidate; exact-head full GitHub CI remains required before parent merges.


## Acquisition-fix candidate verification

The final app adapter retries only same-authority connector replacement and invokes the current client in the same continuation as its final checks. Each reviewed send/resume binds its own synchronous guard and assertWriteState; the adapter also rechecks live ViewAs. The private pre-invocation send refusal releases SDK holds and journals, then the existing lazy engine preserves the readable line. Signature refusals retain their line directly. Actual wallet method failures remain outside this classification and retain pending recovery.

Final focused checks passed 103 tests in four files, including actual installed wagmi acquisition races for payments, approvals, messages, typed signatures and batches; SDK signReviewed refusal lines; bounded retries; actual hook review-expiry/ViewAs/account refusal cleanup and UI lines; actual SDK direct/payment rollback with same-quote retry; and actual payment-method timeout retention. A preceding nine-file affected-flow run passed 136 tests before final guard propagation; the four-file final run binds the current source.

Final lint, types, transaction inventory (10 actions, four direct reviewed forwards), wallet inventory (seven signing/submission sites, zero residuals), deployment synchronization and offline schema registry checks passed. Production build and all original budgets passed with physical locked dependencies, Node26.12.1/npm12.0.1: home326.9/328KiB, project343.3/345KiB, account317.8/319KiB, callback212.0/216KiB, missing-route210.7/214KiB. No ceilings changed.

Independent Astra approved the frozen source and independently passed 33 acquisition/hook tests. Approved SHA256: wallet-core.ts ea304fc0cdf954af65d4da1814008f2d76cae1aa2a35fa251c94cc8ed94a8ff8, review-engine.ts 98e7661a54e28de9ba9765998c4429529762678ec29c598f38fec8f0508a74a8. No application changes followed approval.

At the parent's explicit landing-efficiency instruction, the incomplete local full coverage rerun was stopped at35/173files; it is not a final full-suite result. The already-running production browser check remains pending at candidate commit. Exact-head full coverage and browser GitHub CI must pass before merge. The earlier3811/172 proof belongs to the pre-acquisition-fix head and is not claimed for this candidate. Parent owns publication and merge; this checkout performs neither.
