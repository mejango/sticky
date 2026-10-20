# Stick failure reason and re-quote (2026-10-20)

Ruling (jango): if a payment fails, we should know the reason and let the user adjust. A stick pays Sticky's terminal with no buyback, so its minimum stays the exact quote; a shortfall offers a fresh quote instead of a looser minimum.

- [x] 1. Bump @bananapus/nana-sdk-core 3.1.0 -> 3.3.0 (Node 26, npm 12).
- [x] 2. useSafeTx gains `onFailure(error)` for a send that fails before the wallet (same option jbm adds).
- [x] 3. `stickFailure(error, stSymbol)` in lib: decodePayFailure covers the terminal's UnderMin; Sticky's own StickyAutoStick_InsufficientStickyTokens(received, minimum) decodes locally. A shortfall gives one plain line with both amounts; other known pay reverts give the SDK's line.
- [x] 4. StickSend: on a shortfall the dialog shows that line and "Quote again", which re-plans the same stick.
- [ ] 5. Tests, full `npm run check`, screenshot of the failure state, PR, two Codex passes, no merge.

## Plan refinement
- **Objective:** A stick that fails says why in one line; when the price moved past the reviewed minimum, the dialog offers a fresh quote. Happy path and the exact-quote minimum are unchanged.
- **System fit:** Outcome (understood failure, easy retry) -> capability (SDK decodePayFailure plus Sticky's own error table) -> evidence (the simulation error the engine already catches) -> prepared action (StickSend's existing re-plan via onReviewAgain) -> authority (existing review and held send) -> verified result (receipt). Unstick, transfer, AutoStick and launch flows are unaffected.
- **Reuse and simplicity:** SDK decodes JB reverts; only Sticky's contract error is decoded here, from its generated ABI. Re-quote reuses onReviewAgain. One small option on useSafeTx, mirroring jbm's.
- **Evidence and unknowns:** StickyAutoStick.sol 593-608 and JBMultiTerminal UnderMin carry received and minimum; SDK source wt-sdk-paymin executionErrors.ts; published 3.3.0 re-read after install. A mined revert keeps the engine's settled line (the review simulates right before signing).
- **Verification:** Unit tests for the decoder (terminal UnderMin, Sticky InsufficientStickyTokens, other) and StickSend's shortfall line + Quote again; full `npm run check`; Playwright screenshot of the failure dialog.
- **Resource budget:** One worktree, one bump, three small edits; replan if 3.3.0 differs from source.

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

# SDK 2.39 migration: held writes and saved attempts from the SDK

## Plan refinement
- **Objective:** Move Sticky onto `@bananapus/nana-sdk-core` 2.39.0 and `@bananapus/nana-sdk-react` 53.0.0 so every hold watcher, Safe follower and saved-attempt recovery is the SDK's (useHeldWrite, useSavedAttempt, createSavedAttemptRecovery, HeldWritesNotice), with the frozen recovery rule (ALIGN/recovery-rule.md) unchanged and no added click, wait or notice on the normal path. Push a PR, do not merge.
- **System fit:** Wallet send (useSafeTx, launch adapter) -> SDK hold reservation -> SDK view/follower -> settlement -> app domain checks (bridge verifyWrite, launch verifyDeployment/verifyPayment) -> journal records domain data only. Owners: SDK owns hold, follow, exit, recovery outcomes and copy; Sticky owns journals (launch session, bridge pending record), domain authentication and `confirmRetirable` re-reads. Unaffected: builders, intents (sticky-hold-intent), review dialogs, Relayr/Center domain calls.
- **Reuse and simplicity:** Delete the in-memory Safe registry and hold watchers in useSafeTx (one useHeldWrite per flow), PendingWriteExit, check-required.ts, the launch hold/exitHold/forceExit/sponsorUnknown views, bridge-journal settlement adoption glue; one shared SavedWriteRecovery component binds useSavedAttempt + useHeldWrite for Bridge and Collector; the launch host binds the same hooks. Keep legacy-intents.ts passed as `legacy`. Only new app code: attempt builders (domain inputs) and a source gate test.
- **Evidence and unknowns:** SDK sources at juice-sdk-v4 origin/main af41636 (2.39.0, integrity checked). Found: nana-sdk-react 53.0.0 imports wagmi 2's `useToken`, missing in wagmi 3.7.6, so webpack and Node fail to link it. Coordinator ruling: no nana-sdk-react; bind core's createHeldWriteView and createSavedAttemptRecovery in one thin file (`src/lib/held-write-react.ts`, a copy of the SDK hooks) until SDK 2.40 ships `@bananapus/nana-sdk-core/review/react`. Approval counts stay domain info; nothing main settles from the chain regresses. Browser suite has no wallet; the happy-path click/notice comparison is a jsdom test against main's counts.
- **Verification:** Red-first: cross-tab launch-send race (two controllers, one storage: the second sees held, never check/send); ported scenarios on the SDK path (double-send refused, settled-while-away, unreadable storage warned exit, stale check refused, wallet rejection retires); grep gate over src for app-local hold/recovery patterns and copied SDK copy; happy-path click/notice parity for stick, unstick and launch. Then full `npm run check` (audit, lint, types, inventories, coverage, build, browser).
- **Resource budget:** One worktree, Node 26.7.0 with `npx npm@12.0.1`; no subagents. Port tests by scenario instead of internals; replan if the SDK hooks cannot express a Sticky flow without app-local hold logic.

### Work
- [x] Bump core 2.39.0, lockfile via npm 12 (nana-sdk-react dropped by ruling; thin binding file instead).
- [x] useSafeTx on useHeldWrite; delete registry, watchers, stored-hold APIs; closed Safe proposals still followed.
- [x] Bridge/Collector: SavedWriteRecovery (useSavedAttempt + useHeldWrite); delete PendingWriteExit and journal settlement glue.
- [x] Launch: launchAttempt + useSavedAttempt (LaunchRecovery; direct, payment, sponsor with the 30-minute window); delete launch hold views; reserve before journaling.
- [x] SDK 2.40.0: hooks from `@bananapus/nana-sdk-core/review/react`, local copy deleted; app-wide HeldWritesNotice (held phase only) per chain for the connected account; gate forbids local hook copies.
- [x] Copy from SDK constants; delete check-required.ts and app duplicates.
- [x] Tests: race (red with the old order), ported scenarios, grep gate, happy-path parity.
- [x] Full gate, push, PR (no merge).

### Review
- Full `npm run check` passes: prod audit 0 vulnerabilities, lint, types, inventories (10 useSafeTx sends), 164 files / 3839 unit tests (coverage 94.29/90.99/94.25/96.75), three production builds, 54 browser cases.
- Codex round 1: [P1] a launch that confirmed during its run could not Finish (canDiscard retired a pending hold); [P2] a launch exit's retirement could be dropped behind the host's busy flag. Both fixed (recover before retiring; retire outside the host action), P1 with a red-first test. Round 2: both closed, no new findings.
- Rulings: no nana-sdk-react (wagmi 2 peer); thin copy of its hooks in `src/lib/held-write-react.ts` until SDK 2.40. HeldWritesNotice skipped for now. Approval counts unchanged.

# SDK 2.41 follow-up

## Plan refinement
- **Objective:** Take core 2.41.0 and send through its `useHeldSend`, so all four sites send a call known only at send time the same way; confirm the salt and new-builder rulings apply or not.
- **System fit:** Only `useSafeTx`'s binding changes (the SDK opens, reuses and starts the held view per send); flows, journals and recovery are unchanged.
- **Reuse and simplicity:** Deletes the local target state, the flushSync binding and its render wait. Salt: Sticky deploys with `deployStickyFor` and has no contract salt, so nothing to change. Sticky has no redeem, burn, Safe batch or sync write, so no 2.41 builder applies and no legacy key is needed.
- **Evidence and unknowns:** 2.41.0 integrity matches the coordinator's; `useHeldSend` read from the installed package.
- **Verification:** Existing engine, flow, happy-path and gate suites, then the full `npm run check`.
- **Resource budget:** One small PR from origin/main in .worktrees/sticky-241; no merge.

- [x] Bump core 2.41.0; useSafeTx on useHeldSend; gate keeps the createHeldWriteView ban.
- [x] Salt and builder rulings: nothing applies (no salt; no redeem, burn, Safe batch or sync write).
- [x] Full gate, push, PR.
- [x] SDK 2.41.1: removed the engine's post-receipt `check()` (the SDK's own checked read after a send replaces it); kept the brief busy retry (a different race, still reproduced) and the wallet-rejection handling (it picks the error line, not a workaround). The SDK now reads a mined-but-unreadable hash right after the send; the flow keeps its own waiting line and shows the SDK's line only for a long pending wait, as on main. New test: a second send of the same action right after the first confirmed is taken (it also passes on 2.41.0 here).

# SDK 2.41.2

## Plan refinement
- **Objective:** Take core 2.41.2 and remove the two engine workarounds it makes unnecessary (the busy-retry loop and the app's own waiting line), with no other change.
- **System fit:** Only `useSafeTx`'s send call and its long-pending line change; the SDK now owns both the send-time lock and the confirming line.
- **Reuse and simplicity:** Applies the coordinator's validated diff verbatim; deletes code, adds none.
- **Evidence and unknowns:** 2.41.2 integrity matches; the coordinator validated it against Sticky with both workarounds removed.
- **Verification:** Full `npm run check`.
- **Resource budget:** One small PR from origin/main in .worktrees/sticky-2412; no merge.

- [x] Bump core 2.41.2; remove the busy retry and the app waiting line; full gate passes (3842 unit, 54 browser).

### SDK 3.4.1 (2026-10-20)
- [x] Bump @bananapus/nana-sdk-core 3.3.0 -> 3.4.1. Its write hold releases a direct write's canonical revert at once (settled `failed`, the SDK's held-failed line), so the engine now says `reverted` from that settlement instead of StickSend matching a line.
- [x] The SDK decodes only canonically encoded reverts with their amounts, so the "minimum without amounts" branch is gone; a stick that would return nothing reads "This stick would return no stX. Review again for a fresh quote."
- [x] Codex final pass: `reverted` now also reads the hold's own settled view, so Review again shows while the settlement callback still fetches its receipt; the callback applies only to the write the flow is waiting on (pending, and the same hash for a direct write), so a settlement landing after a reset or under a newer send changes nothing. Both covered by tests that fail without the fix.
- [x] Codex pass 2: settlement callbacks now belong to the open attempt, decided at once rather than on render: a reset closes the attempt, and a new send leaves every settlement already known (and the write it replaces) behind. A review that went stale because another window's write settled applies that settlement directly instead of waiting on a callback that may already have run. Tests cover a reset in the same batch as the callback and an older failure landing under a newer sent or reply-lost write.
- [x] Codex pass 3: a settlement is the open attempt's unless a reset or newer send left its hash behind, so a Safe execution or a verified speed-up finishes the flow; resuming a held write after a reset takes its settlement back; a success already applied during review is never turned back into pending by "went through while away". Test: a held write resumed after a reset finishes.
- [x] Codex pass 4: a success always reaches the flow (the hold counts it as told once delivered, so dropping it would allow a second send without "went through while away"); only failures a reset or newer send left behind are dropped. A success taken during review is restored if the send moved the phase on since. Test: a success landing after a reset is taken.
- [x] Settlement handling is back to main's, as in jbm: the hold's onSettled carries no record identity and a Safe settlement carries the execution hash, so a client-side guard cannot tell a stale settlement from the current one (jbm's Codex passes showed it dropping a current Safe execution). The engine diff is only `onFailure` and the `reverted` flag. Gap, for one batched SDK fix later: a late failure from an earlier attempt can still overwrite a reset or newer send; needs identity in the SDK's useHeldSend.
- [x] Codex passes 8-11: Sticky's own shortfall is read by SDK 3.4.1's evidence rules (any revert data outranks a decoded copy, decoded-only evidence needs the ABI item, 0 <= received < minimum <= max uint256, payloads decoded lowercased, a known SDK pay revert outranks Sticky's check), and only the final stick step's failure reads as a stick failure (an approval revert keeps the engine line and Retry). Pass 12: SHIP.
- [x] follow-redirects 1.16.0 -> 1.16.1 (two new high advisories failed `audit:prod`). `npm run check` on f588be1: 3879 unit, `next build`, budgets, 54 browser.
