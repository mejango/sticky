# Sticky Next cutover and legacy retirement

Required resources read: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `workflow/ponytail/SKILL.md`, `workflow/ponytail/README.md`, `docs/PLAN_REFINEMENT.md`, root `tasks/lessons.md`, and Sticky `web/AGENTS.md`.

## Plan refinement

- **Objective:** Retire the unused legacy runtime after the verified Next production cutover, preserve audit/provenance links, record the hosted cold-create qualification, and submit the bounded cleanup for root's merge.
- **System fit:** Root contract scripts verify deployments and generate artifacts; `web/scripts/sync-deployments.mjs` owns their client projection. The Next workflow, Dockerfile and health route own client validation. Root completed the production cutover and confirmed live acceptance before authorizing source removal; root also owns the retirement merge and subsequent deployment evidence.
- **Reuse and simplicity:** Apply the reviewed 83-path removal manifest and five-file documentation/ignore patch, retaining the existing Next client, workflow, assets and tests. Preserve dated reports and port provenance, replacing only five broken audit-link destinations with permanent baseline URLs. The user confirmed no existing users, so no migration or recovery adapter is needed.
- **Evidence and unknowns:** PR 53 merged at `9530a5ae2534fac784284fa63439da5948029eae`; all seven hosted checks passed at its qualified head `f6ed26bc8a41d748ef1caa1831dee1efc7eebd05`, including 3604 unit tests and 53 browser cases. Railway deployment `2bc8b56f-7eef-4d1b-a269-310b4a387236` succeeded at the merged revision, and root confirmed the live acceptance pass recorded below. Stored builder RAILPACK differs from the verified effective DOCKERFILE deployment. A subsequent retirement-revision deployment is not yet verified by this record.
- **Verification:** Check source/input hashes before removal, pass the plan gate, remove only the inventoried tracked files, run deployment sync and staged/unstaged whitespace checks, and confirm no maintained executable/test fixture depends on legacy paths. Preserve the five exact audit claims while pinning their source links; use the retirement PR's applicable CI before root merges. Live anonymous entry checks do not establish wallet signing, sending or transaction recovery.
- **Resource budget:** One writer owns the obsolete runtime/workflow deletion and seven documentation/evidence files. Reuse the reviewed inventory, source dependency scan, qualified application gates and root's live evidence rather than rerun unchanged application suites locally. Replan if source hashes, deployment revision or acceptance results differ.

## Work

- [x] Point active instructions and post-deployment artifact sync at Next.
- [x] Inventory all legacy runtime, workflow, fixture and documentation dependencies.
- [x] Qualify the integrated Next app and cold-create correction, merge PR 53, and verify its production cutover.
- [x] Apply the reviewed legacy removal and documentation patch after root's explicit live-acceptance pass.
- [x] Run retirement checks and prepare the cleanup for root's PR review.

## Verified production cutover — 2026-10-08

[PR 53](https://github.com/mejango/sticky/pull/53) integrated the maintained Next client with published SDK 2.25.0 and its portable lockfile. Hosted checks passed at [f6ed26b](https://github.com/mejango/sticky/commit/f6ed26bc8a41d748ef1caa1831dee1efc7eebd05); the merged and deployed revision is [9530a5a](https://github.com/mejango/sticky/commit/9530a5ae2534fac784284fa63439da5948029eae). Qualification includes the complete 3604-test unit suite, 53 production-browser cases, builds, configuration/source inventories and standalone-container checks. The held-JavaScript cold-create browser case passed with the normal failure-on-flaky policy.

| Production setting or evidence | Verified value |
| --- | --- |
| Site | `https://sticky.center` |
| Railway deployment | `2bc8b56f-7eef-4d1b-a269-310b4a387236`, SUCCESS, commit `9530a5ae2534fac784284fa63439da5948029eae` |
| Service root and configuration | `/web`, `/web/railway.json` |
| Build | Stored service enum `RAILPACK`; effective deployment metadata `DOCKERFILE`, `Dockerfile`; no legacy build/start overrides |
| Readiness and port | `/api/healthz`, 60-second health timeout, `PORT=8080` |
| Watch paths | `/web/**`, `/deployments/**` |
| Public configuration | Site origin and verified public Signa/Center configuration supplied; no confidential credentials added to `NEXT_PUBLIC_*` values |
| Rollback retained | Previous successful deployment/image `a2e03298-4bbd-4adc-ac3c-b29fb4185ea2`; the previous service configuration remains in root's release evidence |
| Source-removal authority | Root explicitly confirmed live acceptance PASS before authorizing this cleanup; main branch protection was false and branch-rule lookup was empty, so no obsolete required workflow setting needed changing |

The live health response was HTTP 200 with `Cache-Control: no-store` and exactly:

```json
{"ok":true,"revision":"9530a5ae2534fac784284fa63439da5948029eae"}
```

Root executed the read-only acceptance script against that revision and inspected the desktop/mobile captures. It passed:

- Mainnet and testnet same-origin Bendystraw proxies executed registered `StickyEvents` operation `81e7b7ba0ff2c1d1665c89a108cb041e67043c15d6087af17525de3c1c451fe3`; SDK response validation accepted the real upstream data (zero mainnet rows, one testnet row for the bounded read).
- Mainnet/testnet home pages loaded. `/basesep:42` rendered `E2ES E2E Sticky`, `140 ART` backing and holder data; its Tokens tab was usable, and the account page rendered one position.
- The verified project opened its airdrop form and anonymous bridge entry from Sepolia to Base Sepolia. Origin-token and status controls were present; Review transfer stayed disabled. No route discovery, authorization, transfer or recovery was attempted.
- A fresh-context `/center/callback` handled the missing session with `There is no pending wallet exchange in this tab.` and a Retry control. No callback credentials or authorization were supplied.
- Create and sign-in entries opened; the old project link redirected to `/basesep:42#tokens`. Root additionally verified the fully loaded mobile create defaults, input and connect entry. Document overflow was false and browser page errors were empty.

These observations establish deployed read and entry behavior. Signing, submissions and pending recovery remain covered by the recorded deterministic/unit/browser regressions; no live wallet transaction was sent for this acceptance. Root's machine-readable acceptance and deployment records were `/private/tmp/sticky-live-acceptance.json` and `/private/tmp/sticky-next-cutover-applied.json`; the durable facts are summarized here rather than depending on those temporary paths.

## Retirement scope

Source removal follows the live proof above. The prior legacy tree is preserved at [8bff9575f57807df244c1c41b9045f614ab7a76c](https://github.com/mejango/sticky/tree/8bff9575f57807df244c1c41b9045f614ab7a76c/webclient).

| Owner | Reviewed action |
| --- | --- |
| `webclient/` | Remove all 82 tracked legacy runtime, vendor, Python, asset and test files. No Next executable, fixture, snapshot, import, filesystem read or tracked symlink depends on them; Next assets are independent in `web/public/`. |
| `.github/workflows/webclient.yml` | Remove its legacy-only checks with the runtime; retain `.github/workflows/web.yml`. |
| `.gitignore` | Remove only `webclient/config.js`, `webclient/.venv/` and `webclient/.env`; retain generic ignore rules. |
| Root post-deployment scripts | Already migrated: retain contract verification/artifacts and `node web/scripts/sync-deployments.mjs`; no Python stage. No deployment command was executed for retirement. |
| Active README and audit instructions | Remove temporary retained-runtime wording, retain current Next guidance and link the preserved legacy tree. |
| `AUDIT_REPORT.md` | Change only five legacy-test link destinations to the baseline commit; keep labels, findings and historical claims intact. |
| Dated port plans, `AUDIT_REMEDIATION.md`, `web/COPIED.md`, source/test provenance comments | Preserve their recorded scope and source history. |

The checked-in legacy Railway file described Nixpacks, Python build/start and `/healthz`; the pre-cutover service snapshot instead recorded its stored RAILPACK enum and no explicit config/build/start/health overrides. These are different layers of evidence. Root retained the actual prior service snapshot and successful image for rollback.

`web/scripts/sync-deployments.mjs` reads root `deployments/` directly. No old deployment-registry migration, pending-journal adapter or recovery-only page is required for the unused legacy client.

## Preparation and remaining release evidence

The initial documentation preparation at the pre-cutover baseline checked both post-deployment scripts, both Railway configurations, 42 relative documentation links, deployment sync and whitespace. A later exact inventory proved all 83 retirement inputs matched the preserved baseline, found no untracked/ignored legacy remnants, and validated the patch without applying it before production proof. Six already-stale contract-test links in the historical audit report are outside this cleanup and remain unchanged.

Retirement validation passed: the staged deletion set exactly matches the approved 83 paths and their baseline blobs; the Next runtime, tests, scripts and dependency files are unchanged; deployment sync, the 10-document offline operation registry, and the 9-send/4-reviewed-direct-write transaction inventory pass. All 48 retained relative links resolve apart from the six previously stale historical contract-test links; the audit report differs only in five URL destinations. Staged/unstaged whitespace and the workspace plan gate pass. Independent read-only review found no remaining executable/fixture dependency or scope issue. The cleanup is ready for PR review and exact-head hosted CI. This record establishes the initial Next production cutover, not a subsequent deployment of the retirement commit; root records that final rollout in the PR or release record after it actually succeeds.
