# Sticky client reconciliation

## Plan refinement
- **Objective:** Bring Sticky's Next client to the current shared SDK and sibling-client patterns, and complete its launch and bridge flows for the root task's main-client transition. Preserve its domain-specific account, recovery and verification rules.
- **System fit:** Sticky prepares reviewed actions through SDK review/Safe primitives, verifies effects before progressing, and invalidates its existing project/account reads; shared owner improvements must reach the sibling clients, while Sticky keeps its route identity, Signa refusal and sequential-action integration.
- **Reuse and simplicity:** Consume published shared SDK 2.25.0 for request pacing, Safe execution/lifecycle, transaction messages and the final reviewed-write gate; preserve existing SDK/query owners and avoid introducing a second transaction journal or copying unused product features.
- **Evidence and unknowns:** Baseline is Sticky origin/main 8bff957; JBM origin/main 6a0598d and Revnet origin/main 1fcbf1f1 supply current behavior. The user confirmed no existing Sticky users; legacy migration/interlock work is cancelled. Root owns deployment/cutover, launch and bridge agents own new flow recovery, and this plan owns reconciliation plus integrated verification.
- **Verification:** Run regressions for exact Safe proof, pending proposal handling, dependent steps, mutable-handle navigation and review cancellation, request pacing/abort/retry, activity identity, and existing wallet/domain flows; then full lint/type/coverage/inventory/build/browser gates, recording unavailable external gates explicitly. Final wallet review captures connector instance identity as well as account/chain/Safe mode, and shared app identity checks run after all asynchronous preparation at the SDK send boundary.
- **Resource budget:** Parallelize disjoint route/navigation, transaction lifecycle, and read/display work; install physical locked dependencies once, run focused regressions during implementation, and reserve one coordinated build/browser slot for final gates. Replan if SDK boundaries or legacy deployment evidence changes scope.

## Work
- [x] Install official SDK 2.24.5 and inspect installed Next guidance.
- [x] Reconcile route identity and local navigation without full reloads for same-identity changes; proved identity replacement reloads the boundary.
- [x] Consume shared request pacing and current transaction/Safe boundaries.
- [x] Reconcile applicable activity presentation and freshness/invalidation.
- [x] Integrate shared final `beforeSend` gate and official release declaration after preview verification.
- [x] Integrate separately owned launch and bridge flows into the final client snapshot.
- [x] Run focused and full applicable gates; record architecture owners and review.

## Review
- Official SDK 2.25.0 is declared exactly and installed physically from the registry with npm 12.0.1 and Node 26.7.0; clean `npm ci` passed. Lock integrity matches the published release (`sha512-DeJMW245XZq1QUs+0zzgE8E8ETah+s+D7QxJoh0KG5uTzyrQh3Jn3EWDRh69f/hi6mTOBCMR1txt8TWUf0RoMA==`); no local tarball or linked package remains. Production dependency audit reports zero vulnerabilities after the sharp 0.35.5 update.
- Ordinary confirmed writes retain exact domain refreshes; the detached Safe fallback excludes project scans. The shared reviewed-write boundary runs a synchronous final `beforeSend` callback after awaited preparation, and the SDK owns persisted-intent cleanup.
- Final identity audit demonstrated same-account/same-chain connector replacement during simulation and durable preparation could otherwise reach the wallet. The main hook captures the connector UID before awaiting work and uses `wallet-core.assertReviewedWallet`, shared with launch transaction/signature boundaries. Safe and wallet focused tests: 75/75 pass. Distinct Safe proposals whose execution reverted remain awaiting through dismissal/remount and service outage; exact SDK consumed-nonce execution evidence is required to release them.
- Integrated coverage on the qualified shared SDK preview passes 159 files/3598 tests (statements 94.74%, branches 91.09%, functions 95.37%, lines 96.66%). Root's cancellation-before-invalidation fix retains exact scopes; three integration assertions now await cancellation or compare exact key multisets rather than incidental completion order. Full lint, nonincremental types, deployment records, offline 10-document schema registry and 9-send/4-direct-write transaction inventory pass.
- Final launch review corrections are verified: payment snapshot/expiry is checked again after durable preparation, and both wallet-client writers bind the reviewed supported chain explicitly. Five new regressions fail before and pass after the corrections; the final adapter suite passes 46/46 with scoped lint and full nonincremental TypeScript. Independent acceptance review found no remaining wallet, quote or chain blocker. Production/browser gates use official SDK 2.25.0 after the clean installation.
- Final official-SDK qualification passes 35 affected files / 455 tests, full lint, route generation, nonincremental TypeScript, deployment/schema/transaction inventories, and all three production builds (default, deterministic browser and Signa browser). The complete 53-case browser suite passes under CI's failure-on-flaky policy with two workers, including create and bridge entry checks at four widths, accessibility, overflow, retained-read hydration, Signa callback scrubbing and the fixture request census. Two new create-test selectors were corrected to target the persistent entry and native combobox; application source and builds were unchanged. No live wallet transaction was sent.

## Plan refinement — cold create entry
- **Objective:** Ensure the first create click on a cold page opens the dialog reliably, including before JavaScript hydration finishes.
- **System fit:** The entry must expose action readiness before forwarding the request to the existing lazy launch host; launch preparation, wallet authority, journals and execution proof remain owned by their verified modules.
- **Reuse and simplicity:** Reuse `useHydrated` from `useKeptQuery.ts` to keep both existing create buttons disabled in server markup and enable them with attached React handlers. Retain the launch request buffer for the separate lazy-host loading interval.
- **Evidence and unknowns:** Hosted commit `e4e0218` passed full tests, build and container checks, but its first cold phone create click did not open the dialog; the retry and other 52 browser cases passed. The enabled server button can accept a click before handlers exist. A held-JavaScript browser assertion will reproduce that readiness gap without timing sleeps.
- **Verification:** Assert disabled create entries in server-rendered output; hold app JavaScript in the production browser test, verify disabled entry, release scripts and click once. Run relevant home/launch regressions, lint/types, rebuild and run the complete browser fixture census, then hosted checks for the correction commit. Preserve existing timeout and failure-on-flaky policies.
- **Resource budget:** Limit production changes to the existing hydration owner and two entry props; coordinate the next build slot with the reference-client owner. Reuse the current official SDK lock and prior unaffected coverage rather than repeating all local units.

- [x] Bind create readiness to hydration and prove server-disabled behavior.
- [x] Verify the cold-bootstrap browser flow, publish the correction and confirm hosted gates.

The server-rendered readiness regression failed before the fix and passes afterwards. Exporting the existing hydration helper first preserved all four helper tests; the completed change passes 111 home, launch-host, hydration and architecture regressions plus scoped lint, full nonincremental TypeScript and diff checks. The production browser case now delays app JavaScript explicitly before checking readiness, without increasing timeouts or weakening the fixture census.


Hosted verification passed at `f6ed26bc8a41d748ef1caa1831dee1efc7eebd05`: all seven checks, the complete 3604-unit-test suite, and all 53 browser cases, including the held-JavaScript cold-create case, passed without relaxing the failure-on-flaky policy. [PR 53](https://github.com/mejango/sticky/pull/53) merged the correction as `9530a5ae2534fac784284fa63439da5948029eae`. Root then confirmed the exact revision live, including the fully loaded mobile create defaults, input and connect entry; see the [cutover evidence](../../tasks/sticky-next-cutover.md). No wallet connection, signature or transaction was submitted during acceptance.

## SDK 2.27.0 adoption

## Plan refinement

- **Objective:** Pin the client to authenticated `@bananapus/nana-sdk-core@2.27.0`, prove it through a clean locked install and all existing release checks, then push the qualified review branch without merging PR #58 or deploying it.
- **System fit:** The published SDK owns shared recovery and route-readiness behavior, the web manifest and lock own Sticky's consumer identity, the existing web scripts/workflow own release evidence, and the draft pull request remains the review boundary under the separate contract release authority.
- **Reuse and simplicity:** Use Node 26.7.0, npm 12.0.1, the exact existing core pin and repository-native check/OCI commands. Keep Connect 0.5.6, add no React SDK, wrapper, alias or preview override, and change only current release-state records after the official artifact is verified.
- **Evidence and unknowns:** Sticky is prepared at `5421fe77c6dc97b424fbe1a0f2dbcd2443a088a5` with core 2.26.0; the qualified candidate is SDK commit `930f89f2f2cd06afaced3d5fddfd466b29edd24e` and preview `2.27.0-preview.adversarial.4006a0bca708`. Registry integrity and payload equivalence are prerequisites owned by the SDK release task.
- **Verification:** Require an exact package/lock diff, official installed-package identity, clean `npm ci`, full `npm run check`, standalone non-root/read-only OCI health smoke, and every PR check on the exact pushed SHA. Replan on package-content or unrelated lock movement and retain the first failing evidence.
- **Resource budget:** Run one official clean installation and one complete release path, reusing the qualified preview only to bound expected behavior. Avoid unchanged Solidity, RPC and deployment work, and stop before merge, deployment or automatic merge.

- [x] Inventory dependency owners, current-version records and release gates.
- [x] Verify the official core 2.27.0 artifact supplied by the SDK release owner.
- [x] Update the exact manifest/lock entries and current release-state records only.
- [x] Run clean package identity and the full client checks with the pinned toolchain.
- [ ] Commit the final snapshot, run its hardened OCI smoke, push the qualified branch and confirm all hosted checks on its exact SHA; do not merge PR #58.

## Review

- Core 2.27.0 is installed from the authenticated registry tarball at integrity `sha512-fVGeoj2OE1iVIIZmvFY6aQUtZKlydnJkxulreKM3wIYLm7I+rXnSdsIwqRXf5VnRUyLOCWc7NuIyKGxk8jp+wA==`; registry provenance binds it to SDK release commit `b313472ad2f8b996e61c8b8b494d7413e59f8e8a`, and all 769 compiled/public files match the reviewed preview. Connect remains 0.5.6 and the React SDK is absent.
- The pinned Node 26.7.0/npm 12.0.1 release path passes a clean locked install, zero-vulnerability production audit, lint, nonincremental types, deployment/schema/transaction inventories, 163 files and 3,777 coverage tests (94.63% statements, 90.91% branches, 94.90% functions, 96.59% lines), the standard plus deterministic/Signa production builds, and all 54 browser cases. The initial restricted Playwright start failed only because the sandbox refused its loopback listener; the same built artifacts passed outside that restriction.
- The remaining release boundary is the exact committed revision's hardened OCI smoke and six hosted PR checks. Contract deployment, PR merge and application deployment remain outside this adoption task.
