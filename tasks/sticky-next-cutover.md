# Sticky Next cutover documentation

Required resources read: `/Users/jango/Documents/jb/v6/evm/AGENTS.md`, `workflow/ponytail/SKILL.md`, `workflow/ponytail/README.md`, `docs/PLAN_REFINEMENT.md`, root `tasks/lessons.md`, and Sticky `web/AGENTS.md`.

## Plan refinement

- **Objective:** Make current development, audit and contract-artifact instructions lead to the completed Next client in `web/`, and give the deployment owner an exact retirement checklist without changing hosting or deleting the currently deployed runtime.
- **System fit:** Root contract scripts still verify deployed contracts and generate artifacts; `web/scripts/sync-deployments.mjs` owns their client projection. The Next workflow, Dockerfile and health route own release validation. Root owns production cutover and source retirement; this task prepares documentation and scripts, with no claim that preparation changes the live service.
- **Reuse and simplicity:** Reuse the existing Next scripts, `.env.example`, Dockerfile, Railway configuration and CI workflow. Replace active legacy instructions, add one short client README, remove Python from post-deployment sync commands, and retain historical audit/port records with their original revision context. The user confirmed no existing users, so no migration or recovery adapter is needed.
- **Evidence and unknowns:** Current checkout base is `8bff9575f57807df244c1c41b9045f614ab7a76c`. The retained legacy Railway file specifies Nixpacks, `python3 build-config.py`, `python3 serve.py` and `/healthz`; Next specifies a Dockerfile under `web/` and `/api/healthz`. Root reports production still uses the legacy configuration. Current local SDK tarball dependencies must be replaced by the release owner before a portable release; docs do not establish deployment readiness.
- **Verification:** Parse the root package scripts and both Railway configs, check updated relative documentation links, inspect all executable references to legacy files before retirement, run the plan checker and `git diff --check`. Existing Next CI remains the build/browser/container acceptance owner; no contract deployment command, wallet action or hosting mutation is part of this task.
- **Resource budget:** One writer changes root docs/package scripts and `web/README.md`; one read-only worker inventories legacy runtime/test dependencies. Bound verification to changed instructions and configurations, and hand remaining production evidence to root rather than repeat full builds or mutate shared application files.

## Work

- [x] Read active docs, package scripts, workflow, environment validation and hosting configurations.
- [x] Point active instructions and post-deployment artifact sync at Next.
- [x] Record exact retirement dependencies and release checklist.
- [x] Validate links, configuration assertions and diff; hand off without live changes.

## Cutover checklist

Pending source/deployment owner confirmation. No item below is implied by the documentation changes.

- [ ] Finish integrated Next gates, including browser and standalone-container checks in `.github/workflows/web.yml`; restore a portable published SDK dependency in the application manifest and lockfile.
- [ ] Record the intended production Git revision and current Railway settings for rollback.
- [ ] Set the Railway service root to `/web`, load `/web/railway.json`, and use its Dockerfile builder. Remove legacy build/start overrides and replace `/healthz` with `/api/healthz`.
- [ ] Supply the Next build-time configuration from `web/.env.example`; retain verified public Signa/Center settings and keep confidential credentials out of `NEXT_PUBLIC_*` values. Set the built revision from `RAILWAY_GIT_COMMIT_SHA` or `NEXT_PUBLIC_VERSION`.
- [ ] Confirm the deployed `/api/healthz` returns HTTP 200 with the intended revision, then verify home, project/account routes, Center callback, read proxies, launch and bridge recovery through the deployment owner's acceptance checks.
- [ ] After confirmation, retire `webclient/` and `.github/workflows/webclient.yml` together with the executable fixture dependencies inventoried below. Keep dated audit and port records as historical evidence.

## Retirement dependencies

Runtime/workflow files remain present until root confirms cutover.

| Owner | Retirement action |
| --- | --- |
| `webclient/` | Remove the whole obsolete runtime, its vendor bundles, Python server/configuration, assets and tests after confirmed cutover. No Next runtime, test fixture, snapshot, import or filesystem read depends on this directory; assets already exist independently in `web/public/`. |
| `.github/workflows/webclient.yml` | Remove with the runtime; every Python, JS, vendor, server and configuration check in this workflow targets `webclient/`. Keep `.github/workflows/web.yml`. |
| `package.json` `deploy:post:testnets` and `deploy:post:mainnets` | Prepared: remove only the Python sync segment, retaining contract verification/artifacts and `node web/scripts/sync-deployments.mjs`. Neither deployment command was executed by this task. |
| `.gitignore` | After retirement, remove `webclient/config.js`, `webclient/.venv/` and `webclient/.env` entries. Leave generic ignore rules alone. |
| `README.md`, `USER_JOURNEYS.md`, `DEPLOYMENT.md`, `AUDIT_INSTRUCTIONS.md`, `INVARIANTS.md` | Prepared: point current configuration, artifacts, auditing and test coverage guidance at Next. After retirement, remove the temporary retained-runtime language from README, audit instructions and `web/README.md`. |
| `docs/plans/2026-09-29-sticky-next-port*.md`, `AUDIT_REPORT.md`, `AUDIT_REMEDIATION.md`, `web/COPIED.md`, source/test provenance comments | Preserve historical claims and scope. For any legacy source link that needs to remain clickable, point to its recorded Git revision; the complete legacy source is available at `8bff9575f57807df244c1c41b9045f614ab7a76c` before this transition. |

`web/scripts/sync-deployments.mjs` reads root `deployments/` directly, so no legacy registry migration is required. There are no tracked symlinks from Next to the old runtime. The user confirmed there are no legacy users; no cross-version pending journal adapter or migration page is required.

## Review

Validation passed: both post-deployment command assertions, both Railway configuration assertions, all 42 relative documentation links, and `git diff --check`. The read-only `node web/scripts/sync-deployments.mjs --check` passed under Node 26.7.0. Independent source-reference inventory found no Next executable dependency on legacy files. The required refinement checker passed before edits and at handoff. Existing runtime and workflow files are still present; historical reports were not rewritten. Full Next build/browser/container verification and live revision evidence remain with the source/deployment owners. No hosting change, contract deployment, wallet action, commit or push was performed.
