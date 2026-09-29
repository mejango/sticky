# Sticky on Next.js (jbm architecture) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the vanilla-JS client in `webclient/` with a Next.js app in `web/` that is built the way Juicebox Money (jbm) is built. Sticky activity is read from Bendystraw, with a StickyHook log-scan fallback. Every user-facing behavior is kept except the drops listed under Decisions.

**Architecture:** `web/` is a standalone Next 16 App Router app laid out like jbm (`src/app`, `src/components`, `src/hooks`, `src/lib`, `src/providers`). Framework files are copied from Homerun, which copies jbm and adds Signa sign-in and `jbCenterPublicClient`. Sticky's domain logic moves out of `webclient/*.js` into typed `src/lib/sticky-*.ts` modules. Their vitest tests are ported from `webclient/test/*.test.cjs`.
- **Writes** use jbm's engine: `useSafeTx`, then `contract-write`, then the global review dialog, then `TxConfirmDialog`/`TxSteps`.
- **Reads** go through JB Center RPC via wagmi/viem, batched with Multicall3.

**Tech stack:**
- Next 16.3.3 (always `--webpack`), React 19.2.8
- wagmi 3.7.6, @wagmi/core 3.6.4, viem 2.55.19, @tanstack/react-query 5.101.4
- Tailwind 4.3.3
- @bananapus/nana-sdk-core 2.12.2, @bananapus/nana-sdk-connect ^0.5.6
- vitest 4, Playwright 1.62
- Node 26.7.0 with npm 12.0.1
- Bendystraw side: see Phase A.

**Spec:** the Decisions and Defaults sections below, plus two reference maps next to this file:
- `2026-09-29-sticky-next-port-inventory.md`: everything the current client does, with `webclient/` line numbers.
- `2026-09-29-sticky-next-port-jbm-map.md`: how jbm, revnet-money and Homerun are built.

**Path shorthands**, all relative to the workspace root `/Users/jango/Documents/jb/v6/evm`:

| Shorthand | Path |
|---|---|
| `W/` | `extensions/sticky/web` |
| `OLD/` | `extensions/sticky/webclient` |
| `JBM/` | `webclients/juicebox-money` |
| `HR/` | `extensions/homerun` |
| `BS/` | the Bendystraw repo named in Phase A |

**How port tasks are written:** a task that moves existing logic names the source lines to port and the typed signature to port them into. It does not re-paste hundreds of lines of working code. New logic, and every test, is written out.

## At a glance (for review)

**Where it happens**
- The new app goes in `web/`. The live site keeps serving `webclient/` until the cutover PR.
- There are 8 PRs on mejango/sticky (phases 0–7). Phase A, which runs alongside phases 0–2, is not a new PR: it extends the open Bendystraw PR #36, which already indexes stick, unstick and streak events plus per-holder positions, with the three settings events the site also reads.

**What changes for users**
- URLs follow jbm: `/base:23`, `/@handle`, `/account/0x…`, with tabs as `#tokens`. Old links redirect.
- **Removed on purpose:**
  - demo mode
  - the saved-transaction record and its recovery box
  - the cross-tab write lock
  - the blocking decode gate
  - the `script-src 'self'` CSP
  - RPC keys in the client
  - `serve.py` and `build-config.py`
- **Added:**
  - jbm's review dialog (decoded calldata, copy as JSON, audit prompt)
  - Sticky activity from Bendystraw first
  - the account page across all chains
  - `/@handle` resolved from ENS records

**Your steps:** a Railway dev environment and dev.sticky.center (phase 0), the Bendystraw merge and deploy (phase A), and switching the Railway service to `web/` (phase 7).

## Decisions (jango, 2026-09-29)

1. **Port Sticky to Next.js using jbm's structure.**
2. **Transaction engine: jbm's, as-is.** This drops:
   - the saved transaction record (`sticky.transactions.v1`) and its tombstones
   - the cross-tab `sticky-wallet-write` lock
   - finality-gated retry
   - the paste-an-execution-hash recovery box
   - Confirm being blocked when a call fails to decode (jbm shows the raw view instead)

   What replaces them:
   - **Multi-step flows** re-read chain state (allowance, trust) at review time, so a retried flow skips steps that already landed.
   - **Launches** keep a saved record: jbm's `launch-session` posts a Relayr bundle only once.
3. **Data: Bendystraw first, hook log scan fallback.** A Bendystraw PR indexes StickyHook events (Phase A). The site prefers Bendystraw and falls back to scanning the hook's logs, including a tail scan past Bendystraw's indexed block.
4. **RPC: JB Center**, through wagmi/viem clients with Multicall3, like jbm. No RPC keys in the client.
5. **Demo mode dropped.** Browser tests use jbm-style deterministic fixtures instead.

## Defaults chosen in this plan (flag any that are wrong)

- **App location: `web/`.** The root `package.json` is the published `@bananapus/sticky-v6` contracts package, and it must not pick up app dependencies. Homerun mixes the two, and that works only because Homerun is private.
- **URLs:** `/base:23` for a project, `/@handle`, and `/account/0x…`.
  - Tabs are `#overview`, `#tokens`, `#airdrops` and `#latest`, through jbm's `ProjectTabs`.
  - The testnet home is `/?network=testnet`.
  - Old links redirect client-side from `/`. Examples: `?chain=8453#/project/23/tokens` goes to `/base:23#tokens`; `#/@name` goes to `/@name`; `#/account/0x…` goes to `/account/0x…`.
- **Handles resolve forward, like jbm.** The ENS `juicebox` text record gives `chainId:projectId`, which `JBProjectHandles.handleOf` then verifies. This replaces checking every project on the page chain.
- **Create stays a dialog on home**, not jbm's `/create` page, because the form is short.
- **Wallets: Homerun's stack.** That is wagmi's `injected` with EIP-6963 discovery, Signa through `lazyCenterConnector`, and lazy WalletConnect, Coinbase and Safe connectors. Para is not added.
- **Account page:** positions and activity on every chain. It reads one chain at a time to stay under Center's single rate limit. Today it reads only the page chain.
- **Headers: jbm's set**, plus Homerun's `/center/callback` headers.
  - jbm's set is `nosniff`, a referrer policy, a permissions policy, and `frame-ancestors` for Safe apps.
  - `script-src 'self'` goes away, as in jbm. React escaping replaces `esc()`.
  - **Flag:** this is the one security-relevant downgrade. Sticky renders no HTML strings. Task 2.1 adds a lint rule that bans `dangerouslySetInnerHTML`.
- **Addresses:** `W/src/lib/sticky-deployments.json` is generated from `deployments/*/verified.json`. It is preferred over the SDK's `jbContractAddress['6'].Sticky*`, because the SDK still pins the receiver factory from before the 2026-09-28 redeploy.
  - Each chain's hook, terminal and controller are checked against `StickyDeployer.HOOK()/TERMINAL()/CONTROLLER()` once per session. A mismatch stops the page, the same rule as today's boot cache.
- **Environments:** the `dev` branch deploys to dev.sticky.center (a Railway dev environment) and `main` to sticky.center, like jbm. Local dev runs on `127.0.0.1:8788`, which Center's dev allowlist already contains.
- **Look:** Sticky's tokens, fonts and drip art are kept. They are expressed as a Tailwind theme plus `globals.css` component classes, the way jbm does it. This is visual parity, not a redesign.
- **Phone tab label:** jbm's `ProjectTabs` gets an optional `activityLabel` prop, defaulting to jbm's "Activity", so Sticky keeps "Latest". The same one-line prop goes into jbm in phase 2 so the two files stay alike.

## Global Constraints

**Toolchain**
- Node 26.7.0 and npm 12.0.1, set in `.nvmrc`, `engines` and `packageManager`.
- Install with `npx -y npm@12.0.1 install …`. Other npm versions churn the lockfile, and builds exit with code 9.
- `.npmrc` carries jbm's two lines: `node-options=--no-experimental-webstorage` and `strict-allow-scripts=true`.
- `./node_modules/.bin/next build --webpack` must pass before every PR. tsc, vitest and eslint all pass code that `next build` rejects.
- `.env.example` holds names only, never keys.

**Copied code**
- Files copied from HR or JBM stay as close to the source as their Sticky edits allow. Record each copied file and its source commit in `W/COPIED.md`.
- A bug fix to a copied wallet or transaction primitive lands in jbm, revnet-money and Homerun in the same change.

**Writes and dialogs**
- Every wallet write goes through `TxConfirmDialog`.
- Dialogs replace each other instead of stacking.
- Steps, including approvals, are planned at review time.
- Every write site is listed in `W/test/transaction-sites.json` and checked by `npm run transaction:check`.
- View-as and Signa accounts cannot send. Signa gets "This action needs an external wallet." plus a Connect action.

**Queries and data**
- Never persist a react-query query keyed by wallet or account. `W/test/persist-scope.test.ts` checks this, as in jbm.
- Bendystraw:
  - Documents are static and built only from module constants.
  - Run `npm run bendystraw:registry` after any change.
  - Money figures (backing, supply, quotes, minimums) never come from Bendystraw.
  - A timeout or error never becomes zero or an empty list.
- JB Center RPC:
  - No per-chain `Promise.all` bursts; chains are read one after another.
  - Every `eth_call` goes through a client that has `chain` set, so Multicall3 batching actually happens.
  - A log scan runs at most 2 requests in flight, and a page runs its scans one after another.

**Accounting**
- "Stuck" always means underlying backing, never Sticky supply.
- Sticky shares always have 18 decimals.
- Amounts follow juicebox.money's `formatTokenAmount` rules.

**Copy** (from `STYLE_GUIDE.md` and `OLD/llms.txt`)
- Vocabulary: Stick/Unstick, stickiness bonus, Airdrops, "N transactions left".
- Launch review rows use no em dash.
- Reward copy never says "soon" and never uses "—".
- No dot separators, and no emoji.

## Review Focus

These input classes are ones no ported test covers. Each line names the task that adds its test.

1. **Bendystraw has no Sticky tables yet, or is behind.** The feeds and holder lists fall back to hook scans, marked degraded, and never render empty or zero. Test in Task 1.4.
2. **Center RPC answers 429 during a first-visit scan** of a large project (project 23 spans about 69k blocks). The scanner backs off and retries within its request budget, and the page shows loading, not an error. Test in Task 1.2.
3. **An old shared link** (hash route with or without `?chain=`, a handle, an account, a tab) lands on the same view. Test in Task 2.7.
4. **A page reload between the approval and the pay** of a stick. The next review re-reads the allowance, skips the approval and doesn't approve twice. Test in Task 3.3.
5. **A Signa (read-only) account presses any write button.** It gets "This action needs an external wallet." and a Connect action, and no wallet call is made. Test in Task 3.1.

## File map (target)

```
web/
  package.json .nvmrc .npmrc tsconfig.json next.config.js eslint.config.mjs postcss.config.js
  tailwind.config.mjs vitest.config.ts playwright.config.ts knip.json Dockerfile railway.json
  .env.example AGENTS.md CLAUDE.md COPIED.md
  scripts/
    start-standalone.mjs start-production.mjs check-deployment-env.mjs   # JBM copies
    check-bendystraw-schema.mjs                                          # JBM copy (min-doc count = Sticky's)
    check-transaction-inventory.mjs                                      # JBM copy
    sync-deployments.mjs                                                 # NEW: replaces build-config.py --sync/--check-deployments
  public/fonts/{Beatrice-Regular,Beatrice-Medium,PPAgrandir-WideBold}.woff2
  public/assets/{drip-corner,drip-round,hero-donut,hero,jar,cone,juicebox}.png
  src/
    app/
      layout.tsx globals.css page.tsx not-found.tsx error.tsx robots.ts llms.txt/route.ts
      [urn]/page.tsx [urn]/loading.tsx            # /base:23 and /@handle
      account/[address]/page.tsx
      center/callback/page.tsx                     # HR copy
      api/bendystraw/[net]/query/route.ts          # HR copy
      api/healthz/route.ts
    providers/  Providers.tsx lazy-connector.ts lazy-center-connector.ts center-runtime.ts
                center-callback.ts wallet-config.ts wallet-connectors.ts WalletAuthContext.tsx
                ExternalWalletDialog.tsx           # HR copies
    hooks/      useWallet.ts useSafeTx.ts useViewedAccount.ts useEnsName.ts   # HR/JBM copies
    components/
      SiteHeader.tsx SiteFooter.tsx WalletButton.tsx ChainIcon.tsx LegacyHashRedirect.tsx
      TransactionReviewProvider.tsx TransactionReviewDialog.tsx              # HR copies + Sticky labels
      StickyFeed.tsx                                                          # feed rows (jbm ActivityList row layout)
      ui/ ModalShell.tsx TxConfirmDialog.tsx TxSteps.tsx TxError.tsx Revalidating.tsx Skeleton.tsx AddressLabel.tsx
      home/ HomeLists.tsx StickiestCard.tsx SecuredChart.tsx HomeHero.tsx
      project/ ProjectHeader.tsx Tabs.tsx (JBM copy + activityLabel) StickCard.tsx OverviewTab.tsx
               DetailsCard.tsx ChainsCard.tsx BackingChart.tsx TokensTab.tsx TrancheTable.tsx Leaderboard.tsx
               BonusSplit.tsx AirdropsTab.tsx RewardsCard.tsx AutoStickCard.tsx TrustedSenders.tsx
               flows/ StickFlow.tsx UnstickFlow.tsx TransferFlow.tsx TrustFlow.tsx FundFlow.tsx
                      ClaimFlow.tsx AutoStickFlow.tsx ReceiverFlow.tsx BridgeFlow.tsx
      create/ CreateDialog.tsx LaunchDialog.tsx LaunchBanner.tsx
      account/ AccountPositions.tsx AccountActivity.tsx
    lib/
      # copies (HR unless noted)
      chains.ts chainDisplay.ts urn.ts jbcenter-config.ts jbcenter-rpc.ts query-persist.ts viewAs.ts
      wallet-core.ts wallet-list.ts bendystraw.ts bendystraw-browser.ts bendystraw-operation.ts
      bendystraw-operation-id.ts bendystraw-proxy.ts bendystraw-operation-registry.json
      contract-write.ts transaction-review.ts transaction-simulation.ts gas.ts receipt.ts readable-error.ts
      relayr.ts relayr-chains.ts forwarder-authorization.ts safe-connector.ts
      launch-relayr.ts launch-session.ts (JBM) project-handles.ts ens.ts (JBM) activity-groups.ts (from JBM ActivityList)
      # Sticky
      sticky-deployments.json sticky-addresses.ts sticky-abis.ts sticky-project.ts hook-logs.ts
      sticky-indexed.ts sticky-events.ts sticky-feed.ts sticky-holders.ts sticky-backing.ts sticky-siblings.ts
      sticky-metadata.ts sticky-prices.ts sticky-format.ts sticky-rewards.ts sticky-autostick.ts
      sticky-builders.ts sticky-quotes.ts sticky-launch-plan.ts sticky-launch.ts sticky-listing.ts
      sticky-bridge.ts legacy-routes.ts
  test/ (vitest; test/browser = Playwright)
```

---

## Phase A: Bendystraw indexes StickyHook events (extend upstream PR #36)

**The PR this phase builds on.** peripheralist/bendystraw PR #36, "Mark Sticky and Homerun projects, index Sticky positions".
- Its head is `mejango:our-sites-and-flags` at 6b27a0e. It is open, with no reviews.
- It already indexes the StickyHook at `0xa8dcd735031cf96c4213d9a3f66a1dffdcdba693` on all 8 chains, with start blocks equal to the hook's deploy receipts:
  - `Staked`, `Unstaked`, `StreakStarted` and `StreakEnded`, into `stickyEvent`: append-only history with no block number column.
  - Per-holder `stakedBalance`, `streakStartedAt` and `longestCompletedStreak`, into `stickyPosition`.

**What this phase adds.** The site reads three events that PR #36 skips:
- `SetGranter`, for the granter list (`OLD/app.js:2460`)
- `SetTrustedSender`, for trusted-sender candidates (3024)
- `ExcludeOrphanedBalance`, for orphaned backing in the chart (1123, 1773)

This phase adds them to the same PR. `SetToken` stays unindexed, because nothing reads it.

**Repo:** `BS/` = `bendystraw-v6`. `origin` and `upstream` are peripheralist/bendystraw; `fork` is mejango/bendystraw.
- Work in a worktree on `fork/our-sites-and-flags`. Don't use the checkout's current branch (`fix/metadata-gateway-sunset`) or its stale local `main`.
- Commands: `yarn codegen`, `yarn tsc`, `yarn lint`, `yarn test`. `yarn test` runs the `tsx` check scripts; the repo has no CI.
- A merge to `main` deploys automatically on Railway and replays every handler into a fresh schema. The old container keeps serving until the new one is healthy.

### Task A.1: Index the hook's settings events

**Files:**
- Modify:
  - `BS/abis/StickyHookAbi.ts`: add the three events, copied from the `.abi` in `extensions/sticky/deployments/base/StickyHook.json`.
  - `BS/ponder.schema.ts`: add an enum and a table after `stickyEvent`.
  - `BS/src/StickyHook.ts`: add three handlers.
  - `BS/package.json`: add the new check to `test`.
  - `BS/README.md`: the Sticky section.
- Create: `BS/scripts/check-sticky-settings.ts`, built on the harness in `scripts/check-sticky-positions.ts`.

**Interfaces (schema):**

```ts
export const stickySettingType = onchainEnum("sticky_setting_type", [
  "granterSet",
  "trustedSenderSet",
  "orphanedBalanceExcluded",
]);

// Append-only StickyHook settings history (V6 only). SetTrustedSender has no caller, so the
// event columns are composed one by one, as projectTransferEvent does.
export const stickySettingEvent = onchainTable(
  "sticky_setting_event",
  (t) => ({
    ...uniqueId(t),
    ...chainId(t),
    ...version(t),
    ...txHash(t),
    ...timestamp(t),
    ...from(t),
    ...logIndex(t),
    ...projectId(t),
    ...suckerGroupId(t),
    type: stickySettingType().notNull(),
    // granterSet: the granter. trustedSenderSet: the sender.
    account: t.hex(),
    // trustedSenderSet: the holder who trusts or untrusts the sender.
    holder: t.hex(),
    // trustedSenderSet only.
    trusted: t.boolean(),
    // orphanedBalanceExcluded only.
    amount: t.bigint(),
    // Null on trustedSenderSet, whose event has no caller.
    caller: t.hex(),
  }),
  (t) => ({
    projectHistoryIdx: index().on(t.chainId, t.projectId, t.version, t.timestamp),
    holderIdx: index().on(t.chainId, t.projectId, t.version, t.holder),
  })
);

export const stickySettingEventRelations = relations(stickySettingEvent, ({ one }) => ({
  project: one(project, {
    fields: [stickySettingEvent.chainId, stickySettingEvent.projectId, stickySettingEvent.version],
    references: [project.chainId, project.projectId, project.version],
  }),
}));
```

- [ ] **Step 1: Create the worktree and install.**
  - Run `git -C bendystraw-v6 fetch fork our-sites-and-flags && git -C bendystraw-v6 worktree add ../.worktrees/bendystraw-sticky-settings fork/our-sites-and-flags -b sticky-settings`.
  - Then `cd .worktrees/bendystraw-sticky-settings && yarn install --frozen-lockfile`.
- [ ] **Step 2: Write the failing check script.** `scripts/check-sticky-settings.ts` runs the real handlers in the same `node:vm` harness as `check-sticky-positions.ts`, for project 23 on chain 84532, and asserts the rows below. A fifth event for a project the database doesn't have writes no row, and the handler logs instead of throwing.

| Event replayed | Expected `stickySettingEvent` row |
|---|---|
| `SetGranter(23, 0xg…, 0xc…)` | `type` `granterSet`, `account` `0xg…`, `caller` `0xc…` |
| `SetTrustedSender(23, 0xh…, 0xs…, true)` | `type` `trustedSenderSet`, `account` `0xs…`, `holder` `0xh…`, `trusted` true, `caller` null |
| `SetTrustedSender(23, 0xh…, 0xs…, false)` | the same, with `trusted` false |
| `ExcludeOrphanedBalance(23, 5e18, 0xc…)` | `type` `orphanedBalanceExcluded`, `amount` 5e18 |

  Every row's `suckerGroupId` equals the project row's.
- [ ] **Step 3: Run it.** `yarn tsx scripts/check-sticky-settings.ts`. Expected: FAIL, because the table and handlers don't exist yet.
- [ ] **Step 4: Implement.** Add the ABI entries and the schema above, and three handlers in `src/StickyHook.ts` that follow PR #36's `Staked` handler:
  - Wrap each handler in `try`/`catch` with `console.error("StickyHook:<Event>", e)`.
  - Read `suckerGroupId` with `context.db.find(project, {chainId, projectId, version})`. A missing project throws "Missing project" inside the `try`.
  - Insert `{...getEventParams({event, context}), version, projectId, suckerGroupId, type, …}`.
- [ ] **Step 5: Gate.** `yarn codegen && yarn tsc && yarn lint && yarn test`. Expected: all pass, including `check-sticky-positions.ts`.
- [ ] **Step 6: Commit** with the message `Index Sticky granters, trusted senders and orphaned-balance exclusions`.
- [ ] **Step 7: Push (ask jango first: this updates an open upstream PR).** Run `git push fork sticky-settings:our-sites-and-flags`. Then edit PR #36's description: add `stickySettingEvent` to the list of tables, and note that `SetToken` is left out on purpose.

### Task A.2: Check the index after the deploy

- [ ] **Step 1: Confirm the old hook had no activity.** The first hook, `0x965444ab0bea878cdd3fc12b86a0762350de70e6`, was replaced on 2026-09-26. On each chain, confirm it has no Staked logs: `cast logs --address 0x965444ab0bea878cdd3fc12b86a0762350de70e6 --from-block <its deploy block> <Staked topic> --rpc-url <chain>`.
  - Expected: no logs. If there are logs, add the old hook as a second address on the StickyHook source in `ponder.config.ts` and repeat Task A.1's gate.
- [ ] **Step 2: Compare holders once the replay finishes.** Take one Base Sepolia project that has holders on sticky.center and compare `stickyPositions` with the Tokens tab there:

```sh
curl -s https://testnet.bendystraw.xyz/graphql -H 'content-type: application/json' \
  --data '{"query":"{ stickyPositions(where:{chainId:84532, projectId:<id>}, limit:1000){ items { holder stakedBalance streakStartedAt longestCompletedStreak } } }"}'
```

  Expected: the same holders, balances and streak starts as the Tokens tab.

- [ ] **Step 3: Compare the event count.** `stickyEvents(where:{chainId:84532, projectId:<id>})` should return as many rows as there are Staked, Unstaked, StreakStarted and StreakEnded logs up to `_meta`'s block.

---

## Phase 0: Shell (PR "web: Next.js shell")

Deliverable: `web/` builds and deploys to dev.sticky.center, showing the header and working sign-in (Signa or a browser wallet). `/api/healthz` is green.

### Task 0.1: Package, toolchain, configs

**Files:**
- Create: `W/package.json`, `W/.nvmrc`, `W/.npmrc`, `W/tsconfig.json`, `W/next.config.js`, `W/eslint.config.mjs`, `W/postcss.config.js`, `W/tailwind.config.mjs`, `W/vitest.config.ts`, `W/knip.json`, `W/.gitignore`, `W/.env.example`, `W/AGENTS.md`, `W/CLAUDE.md`, `W/COPIED.md`, `W/src/app/layout.tsx` (minimal), `W/src/app/page.tsx` (minimal)
- Test: `W/test/setup.ts`, `W/test/smoke.test.ts`

**Interfaces:**
- Produces: `npm run dev|build|start|lint|ts:check|test|test:ci|check`, and the path alias `@/` → `W/src/`.

- [ ] **Step 1: Create `W/package.json`.** Take the dependency pins from `HR/package.json` (lines 49-109) with these changes:
  - Drop `dompurify` and `marked`, since Sticky renders no rich text.
  - Drop `@sphinx-labs/plugins`.
  - Set `"engines": {"node": "26.7.x", "npm": "12.0.x"}` and `"packageManager": "npm@12.0.1"`.

  The `scripts` block:

```json
{
  "dev": "next dev --webpack --hostname 127.0.0.1 --port 8788",
  "build": "next build --webpack",
  "start": "node scripts/start-standalone.mjs",
  "lint": "eslint . --max-warnings=0 --no-cache",
  "ts:check": "next typegen && tsc --noEmit",
  "test": "vitest run",
  "test:ci": "vitest run --coverage",
  "test:browser": "playwright test",
  "bendystraw:registry": "node scripts/check-bendystraw-schema.mjs 1 --write-registry",
  "schema:check:offline": "node scripts/check-bendystraw-schema.mjs 1 --offline",
  "transaction:check": "node scripts/check-transaction-inventory.mjs",
  "deployments:sync": "node scripts/sync-deployments.mjs",
  "deployments:check": "node scripts/sync-deployments.mjs --check",
  "check": "npm run lint && npm run ts:check && npm run deployments:check && npm run schema:check:offline && npm run transaction:check && npm run test:ci && npm run build"
}
```

  The `1` in the two schema scripts is the minimum document count. Raise it as Phase 1 adds documents.
- [ ] **Step 2: Copy configs from HR.** Copy `tsconfig.json`, `eslint.config.mjs`, `postcss.config.mjs` (as `.js`), `vitest.config.ts`, `knip.json`, and `.gitignore`. `.nvmrc` holds `26.7.0` and `.npmrc` holds the two lines from Global Constraints.
  - Remove Solidity paths from `tsconfig` `include`/`exclude`; only `src/**/*` and `test/**/*` remain.
  - Add to `eslint.config.mjs`: `'react/no-danger': 'error'`, and a `no-restricted-imports` entry banning `viem/chains`. That ban is jbm's `source:check`; chains come from `@bananapus/nana-sdk-core/chains`.
- [ ] **Step 3: Copy `JBM/next.config.js`.** Keep `output: 'standalone'`, `deploymentId: process.env.NEXT_PUBLIC_VERSION`, `optimizePackageImports`, the dev `distDir`, `poweredByHeader: false`, and the headers. Remove the Para aliases and the `HeartbeatWorker` replacement. Set:
  - `images.remotePatterns` to `https://juicebox.center/ipfs/**`.
  - `frame-ancestors` to jbm's Safe origins only: `https://app.safe.global https://app.5afe.dev`.
  - The redirect `www.sticky.center/*` → `https://sticky.center/*` (308).
  - For `/center/callback`, HR's headers (`Cache-Control: no-store`, `Referrer-Policy: strict-origin`) plus `Content-Security-Policy: frame-ancestors 'self'`.
- [ ] **Step 4: Write the minimal pages and the setup file.**
  - `layout.tsx` is `<html lang="en"><body>{children}</body></html>`. `page.tsx` returns `<main id="main-content">Sticky</main>`.
  - Copy `HR/test/setup.ts`, if present, else `JBM/test/setup.ts`: every network call throws.
- [ ] **Step 5: Write the smoke test.**

```ts
// W/test/smoke.test.ts
import { describe, expect, it } from 'vitest'
import nextConfig from '../next.config.js'

describe('next config', () => {
  it('builds a standalone server and sends the callback page its own headers', async () => {
    expect(nextConfig.output).toBe('standalone')
    const headers = await nextConfig.headers()
    const callback = headers.find((entry: { source: string }) => entry.source === '/center/callback')
    expect(callback.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store' })
    expect(callback.headers).toContainEqual({ key: 'Content-Security-Policy', value: "frame-ancestors 'self'" })
  })
})
```

- [ ] **Step 6: Install and gate.**
  - Run `cd web && npx -y npm@12.0.1 install && npm run lint && npm run ts:check && npm test && ./node_modules/.bin/next build --webpack`.
  - Expected: all pass. The smoke test passes once Step 3 is done; if it fails, fix `next.config.js`.
- [ ] **Step 7: Commit** with the message `Add the Next.js app shell in web/`.

### Task 0.2: Chains, Center RPC, providers, wallet, Signa callback

**Files:**
- Copy from HR:
  - `src/lib/{chains,chainDisplay,urn,jbcenter-config,jbcenter-rpc,query-persist,viewAs,wallet-core,wallet-list}.ts`
  - `src/providers/*` (listed in the file map)
  - `src/hooks/useWallet.ts`
  - `src/app/center/callback/page.tsx`
- Modify: `W/src/lib/jbcenter-config.ts`, `W/src/lib/urn.ts`, `W/src/lib/query-persist.ts`, `W/src/app/layout.tsx`
- Test: copy HR's tests for these files into `W/test/` (`test/providers/*`, and the jbcenter-rpc, query-persist and urn tests). Add `W/test/jbcenter-config.test.ts`.

**Interfaces:**
- Produces:
  - `wagmiConfig` and `<Providers>` from `@/providers/Providers`
  - `jbCenterPublicClient(chainId: number): PublicClient`
  - `jbCenterRpcTransport(chainId, timeoutMs?)`
  - `SUPPORTED_CHAINS`, `PRODUCTION_CHAINS`, `TESTNET_CHAINS`, `chainsForEnvironment(env)`
  - `parseUrn(urn) → {chainId, projectId} | null`, `toUrn(chainId, projectId)`, `projectPath(chainId, projectId)`
  - `useWallet()`
  - `PERSIST`, `cachedQuery`, `immutableQuery`

- [ ] **Step 1: Write the failing Center-environment test.**

```ts
// W/test/jbcenter-config.test.ts
import { describe, expect, it } from 'vitest'
import { jbCenterAppOrigin, jbCenterBaseUrl } from '@/lib/jbcenter-config'

describe('JB Center environment', () => {
  it('reads dev Center from the local server and dev.sticky.center', () => {
    expect(jbCenterBaseUrl('http://127.0.0.1:8788')).toBe('https://dev.juicebox.center')
    expect(jbCenterBaseUrl('https://dev.sticky.center')).toBe('https://dev.juicebox.center')
  })
  it('reads production Center from sticky.center', () => {
    expect(jbCenterBaseUrl('https://sticky.center')).toBe('https://juicebox.center')
    expect(jbCenterAppOrigin('https://sticky.center/base:23')).toBe('https://sticky.center')
  })
})
```

- [ ] **Step 2: Run it.** `npx vitest run test/jbcenter-config.test.ts`. Expected: FAIL, because HR's constants name homerun.money.
- [ ] **Step 3: Edit `jbcenter-config.ts` constants.**

```ts
const PRODUCTION_SITE_URL = 'https://sticky.center'
const LOCAL_SITE_URL = 'http://127.0.0.1:8788'
const DEV_CENTER_URL = 'https://dev.juicebox.center'
const DEV_ORIGINS = new Set(['http://127.0.0.1:8788', 'https://dev.sticky.center'])
```

- [ ] **Step 4: Make the Sticky edits to the other copied files.**
  - `urn.ts`: delete `legacyHref` and `legacyProjectHref`, since Sticky has no legacy site.
  - `query-persist.ts`: change the storage key to `sticky:query-cache:v1`.
  - `layout.tsx`: wrap `children` in `<Providers>`.
- [ ] **Step 5: Run all copied tests plus the new one.** Expected: PASS. A copied test that asserts Homerun-only behavior (FUND or INCOME names) gets its expectation changed to Sticky's. Never delete a case silently; list each changed case in `COPIED.md`.
- [ ] **Step 6: Check the old chooser and callback cases against HR's tests.** Go through every case in `OLD/test/wallet-chooser.test.cjs` and `OLD/test/center-callback.test.cjs`. For each, either name the HR test that covers it, or add the case to `W/test/providers/`.
  - Wallet chooser cases:
    - the Signa button is labelled by device (Face ID, Touch ID, Windows Hello, Device)
    - Signa comes first, then the wallet tiles
    - only `data:` icons are shown
    - the pending and error copy
    - the frame's `allow` names the issuer
    - theme messages go only to the issuer's origin
    - closing cancels
  - Callback cases:
    - only a safe return route is followed
    - the opener or frame handoff
    - full-page completion
    - the code is scrubbed before load
  - The old vendored-bundle hash check is not ported: the SDK now comes from npm.
  - Record the mapping in `COPIED.md`.
- [ ] **Step 7: Gate and commit.**
  - Run `npm run lint && npm run ts:check && npm test && ./node_modules/.bin/next build --webpack`.
  - Commit with the message `Read through JB Center and sign in with Signa or a browser wallet`.
### Task 0.3: Layout, theme, header, wallet button

**Files:**
- Create:
  - `W/public/fonts/*.woff2`, copied from `OLD/`
  - `W/public/assets/*.png`, copied from `OLD/`: `drip-corner`, `drip-round`, `hero-donut`, `hero`, `jar`, `cone`, `juicebox`
  - `W/src/app/globals.css`, `W/tailwind.config.mjs`
  - `W/src/components/{SiteHeader,SiteFooter,WalletButton}.tsx`
- Modify: `W/src/app/layout.tsx`
- Test: `W/test/components/wallet-button.test.tsx`

**Interfaces:**
- Consumes: `useWallet()`, `viewAs` from Task 0.2.
- Produces: `<SiteHeader/>` and `<WalletButton/>`. `WalletButton` shows the balances menu when a project is in view: it reads `ProjectRouteContext`, the same way HR's WalletButton does.

- [ ] **Step 1: Write the failing test.** Using react-test-renderer and a mocked `useWallet`, assert the button label in each state:
  - Disconnected: exactly "Sign in".
  - Connected with ENS `jango.eth`: "Signed in", with `jango.eth` in the button text.
  - View-as `0x1234…abcd`: "Viewing as 0x1234…abcd".

  The menu items are exactly "Account", "Copy address", "Disconnect" and "View as" (or "Exit View as" while viewing). These strings come from `OLD/app.js:5777-5809`.
- [ ] **Step 2: Run it.** Expected: FAIL (no component).
- [ ] **Step 3: Implement.**
  - **Theme:** `tailwind.config.mjs` defines colors `bg #f0f7f9`, `card #f8fcfd`, `line #d8e7eb`, `ink #1c2d33`, `muted #57727c`, `accent #0e7c91`, `amber #2fb3c7`, `teal #7fd4e0`, `err #b34a35`. These come from `OLD/index.html:34-38`.
  - **Fonts:** `beatrice` and `agrandir-wide` families, loaded with `next/font/local` in `layout.tsx` (weights 400/500 and 700).
  - **`globals.css`:** `@import "tailwindcss"` plus `@config`, and jbm's component classes (`.card`, `.btn-primary`, `.btn-secondary`, `.btn-link`, `.modal-dialog`, `dialog[data-covered]`, `.skeleton-shimmer`, `.revalidating`) restyled with Sticky's tokens, taking values from `OLD/index.html:21-751`.
  - **`SiteHeader`:** the `drip-corner` logo linking to `/`, plus `WalletButton`. Keep the 50 px top fold and the drip overscroll art from `OLD/app.js:204-224`.
  - **`WalletButton`:** start from `HR/src/components/WalletButton.tsx` if it exists, else JBM's, and change the labels to Sticky's.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Gate and commit.** Run the full gate, then commit with the message `Add Sticky's header, theme and wallet button`.

### Task 0.4: Bendystraw proxy

**Files:**
- Copy from HR: `src/lib/bendystraw{,-browser,-operation,-operation-id,-proxy}.ts`, `src/lib/bendystraw-operation-registry.json` (reset to `{}`), `src/app/api/bendystraw/[net]/query/route.ts`, `scripts/check-bendystraw-schema.mjs`
- Test: copy JBM's `test/data` proxy tests: unknown operation → 400, body over 32 KiB → 400, `net` other than `mainnet|testnet` → 404, upstream failure → 502 `{error}`.

**Interfaces:**
- Produces: `bendystraw<T>(query: string, variables: object, opts: {chainId?: number; network?: 'mainnet'|'testnet'; policy?: 'live'|'standard'|'stable'}): Promise<T>`.

- [ ] **Step 1: Copy the tests.** Run them. Expected: FAIL (no route).
- [ ] **Step 2: Copy the sources.** Run the tests. Expected: PASS.
- [ ] **Step 3: Check the registry.** Run `npm run schema:check:offline`. Expected: PASS once the registry is regenerated from the documents in `src/`. At this point there are 0 documents; the count is temporarily `0` until Task 1.3.
- [ ] **Step 4: Commit** with the message `Relay registered Bendystraw queries from the site origin`.

### Task 0.5: Health, deployment env check, Docker, Railway, CI

**Files:**
- Create:
  - `W/src/app/api/healthz/route.ts`
  - `W/scripts/{start-standalone,start-production,check-deployment-env}.mjs` (JBM copies)
  - `W/Dockerfile` and `W/railway.json` (JBM copies)
  - `.github/workflows/web.yml` (repo root)
- Test: `W/test/healthz.test.ts`, `W/test/deployment-env.test.ts`

**Interfaces:**
- Produces: `GET /api/healthz` → `{ok: true, revision}`, with HTTP 200.

- [ ] **Step 1: Write the failing tests.**

```ts
// W/test/healthz.test.ts
import { describe, expect, it, vi } from 'vitest'

describe('GET /api/healthz', () => {
  it('reports ready with the build revision', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERSION', 'abc1234')
    const { GET } = await import('@/app/api/healthz/route')
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, revision: 'abc1234' })
  })
})
```

  `deployment-env.test.ts` checks that `check-deployment-env.mjs build` enforces these rules:
  - It rejects a missing `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_BENDYSTRAW_URL`, `NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL` or `NEXT_PUBLIC_VERSION`.
  - It rejects `NEXT_PUBLIC_DETERMINISTIC_BROWSER=true`.
  - It accepts a complete set.
  - The Signa values (`NEXT_PUBLIC_CENTER_WALLET_*`) and `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` are optional.
- [ ] **Step 2: Implement.**
  - **Health route:** `route.ts` returns `Response.json({ ok: true, revision: process.env.NEXT_PUBLIC_VERSION ?? 'unknown' })` with `Cache-Control: no-store`.
  - **Env check:** in `check-deployment-env.mjs`, remove the Para variables from jbm's list and add the optional Signa set.
  - **Docker and Railway:** use jbm's `Dockerfile` unchanged apart from the build args list. `railway.json` is jbm's: DOCKERFILE builder, health check `/api/healthz`.
  - **`web.yml`:** runs on `ubuntu-24.04`, `working-directory: web`, with actions pinned to SHAs as in `JBM/.github/workflows/ci.yml`. Steps: `npm ci`, lint, `ts:check`, `deployments:check`, `schema:check:offline`, `transaction:check`, `test:ci`, build.
- [ ] **Step 3: Run the tests.** Expected: PASS.
- [ ] **Step 4: Build the image.** Run `docker build -t sticky-web web` with the required build args. Expected: success, and `docker run` answers `/api/healthz` with 200.
- [ ] **Step 5: Commit** with the message `Serve a health check and build the Docker image Railway runs`.

### Task 0.6: Deployment addresses from the repo's records

**Files:**
- Create: `W/scripts/sync-deployments.mjs`, `W/src/lib/sticky-deployments.json` (generated), `W/src/lib/sticky-addresses.ts`
- Modify: `extensions/sticky/package.json`. Both `deploy:post:*` scripts get `&& node web/scripts/sync-deployments.mjs`. Keep the python call until phase 7.
- Test: `W/test/sticky-addresses.test.ts`

**Interfaces:**
- Produces:
  - `type StickyDeployment = {chainId: number; deployer: Address; hook: Address; terminal: Address; controller: Address; distributor: Address; rewardReceiverFactory: Address; autoStick: Address; fromBlock: bigint}`
  - `stickyDeployment(chainId: number): StickyDeployment | null`
  - `stickyChainIds(env: 'production'|'testnet'): number[]`

- [ ] **Step 1: Write the failing test.**

```ts
// W/test/sticky-addresses.test.ts
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { stickyChainIds, stickyDeployment } from '@/lib/sticky-addresses'

describe('Sticky deployments', () => {
  it('lists every chain with verified records, in both families', () => {
    expect(stickyChainIds('production')).toEqual([1, 10, 8453, 42161])
    expect(stickyChainIds('testnet')).toEqual([84532, 421614, 11155111, 11155420])
  })
  it('returns checksummed addresses and the deployer block', () => {
    const base = stickyDeployment(8453)!
    expect(base.deployer).toBe('0xdA38Ec48B5b1d186B02BA99F297e95153BEE33a9')
    expect(base.rewardReceiverFactory).toBe('0x41AEC7AacEa4759F2c8AaBD68D4a4C1574A6A737')
    expect(base.fromBlock).toBe(51791252n)
  })
  it('knows nothing about other chains', () => {
    expect(stickyDeployment(137)).toBeNull()
  })
  it('matches the deployment records', () => {
    expect(() => execFileSync('node', ['scripts/sync-deployments.mjs', '--check'])).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Generator:** `sync-deployments.mjs` ports `OLD/build-config.py:114-127`.
    - Read each `../deployments/*/verified.json` and skip the `_test` folder.
    - Require `StickyDeployer.json` `address` to equal `verified.deployer`.
    - Take `deployer`, `hook`, `terminal`, `controller`, `distributor`, `rewardReceiverFactory` and `autoStick`, each checksummed with viem `getAddress` and never zero.
    - Set `fromBlock = parseInt(StickyDeployer.json receipt.blockNumber, 16)`.
    - Write the result sorted by chain id, as `{ "<chainId>": {...} }` with `fromBlock` as a decimal string.
    - `--check` compares the output with the committed file and exits 1 on any difference.
  - **Accessor:** `sticky-addresses.ts` imports the JSON and returns typed entries. It uses the `environmentForChainIds` rule from `chains.ts`.
- [ ] **Step 4: Generate and test.** Run `npm run deployments:sync && npx vitest run test/sticky-addresses.test.ts`. Expected: PASS. The fromBlocks match `OLD/deployments.json`: 1=26057164, 10=157386536, 8453=51791252, 42161=508887149, 11155111=11781859, 11155420=49284433, 84532=47301559, 421614=312706619. These are the current deployer's blocks; the ones noted in `tasks/todo.md` on 2026-09-25 belong to the replaced deployer.
- [ ] **Step 5: Commit** with the message `Read Sticky's addresses from the repo's deployment records`.

### Task 0.7: Dev environment (ops, jango, with one Center PR)

- [ ] **Step 1: Center PR.** On `mejango/jbcenter`, add `https://dev.sticky.center` to `DEV_APPLICATIONS` in `src/firstParty.ts`, plus its case in the `originsForEnvironment` test. Open the PR, and merge after review.
- [ ] **Step 2: Railway (jango).**
  - Create a dev environment for the sticky service with its root at `/web`, the Dockerfile builder and branch `dev`.
  - Add the domain dev.sticky.center.
  - Set the variables:
    - `NEXT_PUBLIC_SITE_URL=https://dev.sticky.center`
    - both Bendystraw URLs
    - `NEXT_PUBLIC_VERSION=${{RAILWAY_GIT_COMMIT_SHA}}`
    - optionally the `NEXT_PUBLIC_CENTER_WALLET_*` set, copied from the prod `STICKY_CENTER_WALLET_*` values
  - Signa on dev also needs Signa's framing variable `WALLET_FRAMEABLE_APP_ORIGINS` to include `https://dev.sticky.center`.
- [ ] **Step 3: Verify.** Open https://dev.sticky.center/api/healthz. Expected: `{"ok":true,"revision":"<sha>"}`.

---

## Phase 1: Read model (PR "web: Sticky read model")

Deliverable: typed, tested modules that produce every figure the pages show. No UI yet.

### Task 1.1: ABIs and project reads

**Files:**
- Create: `W/src/lib/sticky-abis.ts`, `W/src/lib/sticky-project.ts`
- Test: `W/test/lib/sticky-abis.test.ts`, `W/test/lib/sticky-project.test.ts`

**Interfaces:**
- Consumes: `jbCenterPublicClient` and `stickyDeployment`.
- Produces:
  - `sticky-abis.ts` re-exports `stickyHookAbi`, `stickyDeployerAbi`, `stickyDistributorAbi`, `stickyRewardReceiverFactoryAbi` and `stickyAutoStickAbi` from `@bananapus/nana-sdk-core`. It adds `parseAbi` lists for:
    - the Sticky ERC-20: `SOULBOUND`, `getPastVotes` and the standard ERC-20 functions
    - JBMultiTerminal: `previewPayFor`, `previewCashOutFrom`, `feeFreeSurplusOf`, `FEELESS_ADDRESSES`
    - `isFeelessFor`
    - JBTerminalStore: `balanceOf`
    - JBProjects: `count`, `ownerOf`, `creationFee`
    - JBTokens: `tokenOf`, `projectIdOf`
    - the controller: `uriOf`
  - `type StickyProjectInfo = {chainId; projectId: bigint; stToken: Address; stSymbol: string; stName: string; stakedToken: Address; symbol: string; name: string; decimals: number; cashOutTaxRate: bigint; soulbound: boolean; totalSupply: bigint; backing: bigint; orphaned: bigint; launchId: Hex | null; blockNumber: bigint}`
  - `readStickyProject(chainId: number, projectId: bigint): Promise<StickyProjectInfo>`, which reads at one pinned block through a single multicall.
  - `verifyStickyDeployment(chainId): Promise<void>`, which throws `StickyDeploymentMismatch` when `HOOK()`, `TERMINAL()` or `CONTROLLER()` differ from the generated JSON.

- [ ] **Step 1: Write the failing selector test.** For every function `OLD/app.js:8-80` calls (the `SEL` table), assert `toFunctionSelector(abiItem)` equals the old selector. Examples: `stakedBalanceOf` → `0x7bd208b2`, `previewPayFor` → `0x0aff0c31`, `tranchesOf(uint256,address,uint256,uint256)` → `0xc964d0f3`. Port the full list, one `it.each` row per entry.
- [ ] **Step 2: Write the failing project-read tests.** Port the pool-backing and orphan cases from `OLD/test/actions.test.cjs`, keeping their names. Use a fake `PublicClient` whose `multicall` returns fixed results. Add these cases:
  - `SOULBOUND()` reverting reads as locked (`OLD/app.js:1064`).
  - `verifyStickyDeployment` throws on a hook mismatch.
- [ ] **Step 3: Run both.** Expected: FAIL.
- [ ] **Step 4: Implement** by porting `projectInfo`, `poolBacking` and `launchIdOf`, found via `grep -n "function projectInfo\|function poolBacking\|function launchIdOf" OLD/app.js`. Reads go through `client.multicall({blockNumber})`, with the block number pinned from `client.getBlockNumber()`.
- [ ] **Step 5: Run the tests.** Expected: PASS. Then commit with the message `Read Sticky projects through Center with one pinned multicall`.

### Task 1.2: Hook log scanner and history cache

**Files:**
- Create: `W/src/lib/hook-logs.ts`
- Test: `W/test/lib/hook-logs.test.ts`

**Interfaces:**
- Produces:
  - `scanLogs(client: PublicClient, q: {address: Address; topics: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint}, opts?: {maxInFlight?: number; maxRequests?: number}): Promise<Log[]>`. The defaults are 2 in flight and 1024 requests. It never returns a partial history: it resolves with all logs or rejects.
  - `projectHookLogs(chainId: number, projectId: bigint, fromBlock: bigint): Promise<Log[]>`. It serves history below head-64 from localStorage `sticky.history.v1:<chain>:<hook>:<id>` (≤400k chars), and scans only newer blocks.

- [ ] **Step 1: Port the log tests.** Port every `logs()` case from `OLD/test/runtime.test.cjs` and the history-cache-with-reorg-depth case from `OLD/test/project-page.test.cjs`. The cases are:
  - stated-range splitting
  - HTTP 413
  - no partial history
  - bounded parallel bisection
  - de-duplication and order
- [ ] **Step 2: Add the Review Focus #2 test.**

```ts
it('backs off on 429 and finishes the scan without surfacing an error', async () => {
  let calls = 0
  const client = fakeClient(async ({ fromBlock, toBlock }) => {
    calls += 1
    if (calls <= 2) throw Object.assign(new Error('Too Many Requests'), { status: 429 })
    return [log(fromBlock), log(toBlock)]
  })
  const logs = await scanLogs(client, { address: HOOK, topics: [], fromBlock: 0n, toBlock: 10n }, { maxInFlight: 1 })
  expect(logs.map(entry => entry.blockNumber)).toEqual([0n, 10n])
  expect(calls).toBe(3)
})
```

- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.**
  - **Scanner:** port `OLD/runtime.js:140-208` onto `client.getLogs`, keeping the stated-range parser.
  - **429 handling:** retry after 1 s, then 2 s, then 4 s, capped at 3 retries per range. Retries count toward `maxRequests`.
  - **History cache:** port `OLD/app.js:1094-1133`.
- [ ] **Step 5: Run the tests.** Expected: PASS. Then commit with the message `Scan hook logs through Center within its rate limit, keeping buried history in the browser`.

### Task 1.3: Bendystraw Sticky documents

**Files:**
- Create: `W/src/lib/sticky-indexed.ts`
- Modify: `W/src/lib/bendystraw-operation-registry.json` (regenerated), and the `package.json` schema scripts (min count `7`)
- Test: `W/test/lib/sticky-indexed.test.ts`

**Interfaces:**
- Produces:
  - `indexedStickyProjects(network): Promise<{block: bigint; projects: {chainId: number; projectId: bigint}[]}>`
  - `indexedStickyMoves(chainId, projectIds): Promise<IndexedMove[]>` (pays and cash-outs)
  - `indexedStickyCreateTx(chainId, projectId): Promise<Hex | null>`
  - `indexedBlocks(network): Promise<Map<number, bigint>>`: each chain's last indexed block, from `_meta { status }`.
  - `indexedStickyEvents(q: {chainIds?: number[]; chainId?: number; projectId?: bigint; holder?: Address; newest?: number}): Promise<IndexedStickyEvent[]>`, from PR #36's `stickyEvents`.
  - `indexedStickyPositions(q: {chainId?: number; projectId?: bigint; holder?: Address}): Promise<IndexedPosition[]>`, from PR #36's `stickyPositions`.
  - `indexedStickySettings(chainId: number, projectId: bigint): Promise<IndexedSetting[]>`, from Phase A's `stickySettingEvents`.
- The three new documents follow Ponder's generated names: `stickyEvents(where: stickyEventFilter, orderBy: "timestamp", orderDirection, limit: 1000, after)`, `stickyPositions(where: stickyPositionFilter, …)` and `stickySettingEvents(where: stickySettingEventFilter, …)`, each selecting `items { … } pageInfo { hasNextPage endCursor }`.
- Home's newest-40 query filters on `chainId_in` only, never `chainId_in` together with `projectId_in`. jbm's schema check rejects that combination.
- Minimum document count for the two schema scripts: `7`.

- [ ] **Step 1: Port the tests.** Port every case in `OLD/test/bendystraw.test.cjs`:
  - index parsing
  - errors fall back
  - events per chain and version
  - home without history scans
  - tail-scan discovery
  - zero state only when truly empty
  - creation block from Bendystraw verified by receipt, else a binary search
  - paging stops at 20 pages with an error, never silently truncating
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Copy the four documents (StickyIndex, StickyPays, StickyCashOuts, StickyCreate) verbatim from `OLD/runtime.js:263-355` as module constants, and add the three new ones: StickyEvents, StickyPositions and StickySettings. Wrap them all with `bendystraw()` using the `live` policy.
  - The new documents are written now, before Phase A deploys. Until then Bendystraw answers them with "Cannot query field", and Task 1.4 turns that into a scan.
  - Add a test that feeds a "Cannot query field" error to each of the new functions. Each must reject rather than return an empty list.
- [ ] **Step 4: Regenerate and test.** Run `npm run bendystraw:registry && npm run schema:check:offline && npx vitest run test/lib/sticky-indexed.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** with the message `Query Sticky projects, pays and cash outs from Bendystraw`.

### Task 1.4: Sticky events, from Bendystraw first with a scan fallback

**Files:**
- Create: `W/src/lib/sticky-events.ts`
- Test: `W/test/lib/sticky-events.test.ts`

**Interfaces:**
- Consumes: `indexedStickyEvents` (Task 1.3) and `projectHookLogs`/`scanLogs` (Task 1.2).
- Produces the event types:

```ts
export type StickyEventKind = 'stick' | 'unstick' | 'streakStart' | 'streakEnd' | 'trust' | 'granter' | 'excludeOrphan'
export type StickyEvent = {
  kind: StickyEventKind
  chainId: number
  projectId: bigint
  holder: Address
  txHash: Hex
  logIndex: number
  blockNumber: bigint | null   // null on indexed events: stickyEvent has no block column
  timestamp: number
  payer?: Address          // stick
  count?: bigint           // stick / unstick share count
  balance?: bigint         // stick / unstick resulting balance
  length?: bigint          // streakEnd
  sender?: Address         // trust
  trusted?: boolean        // trust / granter
}
export type StickyEventsResult = { events: StickyEvent[]; source: 'indexed' | 'scanned'; degraded: null | 'not-indexed' | 'indexer-error' }
export function stickyEvents(chainId: number, projectId: bigint): Promise<StickyEventsResult>
export function stickyHolderEvents(chainId: number, holder: Address): Promise<StickyEventsResult>
export function decodeHookLog(log: Log): StickyEvent | null   // pure; field layout from OLD/app.js:82-98 + inventory §2.3
```

- [ ] **Step 1: Write the failing tests** (Review Focus #1).

```ts
// ev(txHash, logIndex, timestamp) is an indexed event (no block number);
// log(txHash, logIndex, blockNumber) is a raw hook log from the scanner.
it('uses Bendystraw and scans only past its indexed block', async () => {
  const deps = fakeDeps({ indexed: { block: 100n, events: [ev('0xa', 1, 90)] }, tail: [log('0xb', 1, 101n)] })
  const result = await stickyEvents(8453, 23n, deps)
  expect(result.source).toBe('indexed')
  expect(result.events.map(e => e.txHash)).toEqual(['0xa', '0xb'])
  expect(deps.scans).toEqual([{ fromBlock: 101n }])
})
it('never double counts an event both sources returned', async () => {
  const deps = fakeDeps({ indexed: { block: 99n, events: [ev('0xa', 1, 100)] }, tail: [log('0xa', 1, 100n)] })
  expect((await stickyEvents(8453, 23n, deps)).events).toHaveLength(1)
})
it('falls back to a full scan, marked degraded, when Bendystraw fails', async () => {
  const deps = fakeDeps({ indexed: new Error('Cannot query field "stickyEvents"'), full: [log('0xa', 1, 5n)] })
  const result = await stickyEvents(8453, 23n, deps)
  expect(result).toMatchObject({ source: 'scanned', degraded: 'indexer-error' })
  expect(result.events).toHaveLength(1)
})
it('rejects when both sources fail, instead of returning an empty history', async () => {
  const deps = fakeDeps({ indexed: new Error('down'), full: new Error('429 budget spent') })
  await expect(stickyEvents(8453, 23n, deps)).rejects.toThrow()
})
```

  - **Dependencies:** `stickyEvents` takes an optional third `deps` argument (indexed reader, scanner, head block) so tests don't need network.
  - **Sort order:**
    - Indexed events are ordered by `(timestamp, logIndex)`.
    - Scanned events keep the scanner's block order.
    - Tail-scan events always come after indexed ones, because they are past the indexed block.
  - **De-duplication key:** `${chainId}:${txHash.toLowerCase()}:${logIndex}`.
  - **Balances never come from event order.** On Arbitrum two blocks can share a timestamp, so the indexed order is right for the feed but not for balances. Balances come from positions (Task 1.6).
  - **Source kinds:** `stickyEvents` covers the stick, unstick and streak kinds from `stickyEvents`. The `trust`, `granter` and `excludeOrphan` kinds come from `stickySettingEvents`. Both use the same indexed-block tail scan and the same fallback.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** A Bendystraw schema error ("Cannot query field") is recorded as `degraded: 'indexer-error'`. Before Phase A deploys, every call takes this path, and it is expected.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then commit with the message `Read Sticky events from Bendystraw first and scan the hook when it can't answer`.

### Task 1.5: Feed rows with jbm's same-transaction grouping

**Files:**
- Create: `W/src/lib/activity-groups.ts`, `W/src/lib/sticky-feed.ts`
- Test: `W/test/lib/sticky-feed.test.ts` (ported from `OLD/test/feed-amounts.test.cjs`)

**Interfaces:**
- `activity-groups.ts`:

```ts
/** jbm's groupSameTxEvents (JBM/src/components/ActivityList.tsx:303), keyed by the caller.
 * A group sits where its newest member sat. */
export function groupSameTx<T>(events: T[], key: (event: T) => string): T[][] {
  const groups = new Map<string, T[]>()
  const order: T[][] = []
  for (const event of events) {
    const id = key(event)
    const group = groups.get(id)
    if (group) group.push(event)
    else {
      const fresh = [event]
      groups.set(id, fresh)
      order.push(fresh)
    }
  }
  return order
}
```

- `sticky-feed.ts`:
  - `type FeedRow = {chainId; projectId; timestamp: number; txHash: Hex; direction: 'in' | 'out' | null; amount: {value: bigint; decimals: number; symbol: string} | null; line: FeedLine}`
  - `FeedLine` is a discriminated union: `stuck | autoStuck | gift | unstuck | removed | gotSticky | cameUnstuck`, each with `holder`, and `payer`/`length` where relevant. A `streak` field (`'started' | {endedAfter: bigint}`) carries a folded same-transaction streak.
  - `terminalMoves(events, reader): Promise<Map<string, bigint>>`
  - `feedRows(events, moves, {adapter}): FeedRow[]`, newest first, with the same-transaction key `${chainId}:${txHash}:${projectId}:${holder}` (see today's `sameTxKey` in `OLD/app.js`).
  - `airdropRows(...)`

- [ ] **Step 1: Port every test in `OLD/test/feed-amounts.test.cjs`.** That includes the 2026-09-29 case "a streak that starts or ends in a stick or unstick transaction reads on that row", which asserts three rows:
  - `{line: {kind: 'removed', streak: {endedAfter: 86400n}}}`
  - a separate `gotSticky` for the other holder
  - `{line: {kind: 'stuck', streak: 'started'}}`

  Assertions move from HTML regexes to row objects.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Port `moveKey`, `terminalMoves`, `logMove`, `activityItems`, `airdropItems`, `indexedActivityItems` and `indexedAirdropItems` from `OLD/app.js:1180-1380`, returning `FeedRow`s instead of HTML. Use `groupSameTx` for the streak fold.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then commit with the message `Build feed rows with jbm's same-transaction grouping`.

### Task 1.6: Holders, backing series, siblings

**Files:**
- Create: `W/src/lib/sticky-holders.ts`, `W/src/lib/sticky-backing.ts`, `W/src/lib/sticky-siblings.ts`
- Test: `W/test/lib/{sticky-holders,sticky-backing,sticky-siblings}.test.ts`

**Interfaces:**
- `stickyHolders(chainId, projectId): Promise<{rows: HolderRow[]; source: 'indexed' | 'scanned'; degraded: null | 'not-indexed' | 'indexer-error'}>`. It maps `indexedStickyPositions` when Bendystraw answers, and uses `holderRows(events)` on scanned events when it doesn't.
  - The current streak is `now - streakStartedAt`.
  - The longest streak is `max(current, longestCompletedStreak)`, matching `StickyHook.longestStreakOf`.
  - Positions rows past the indexed block are corrected by applying the tail-scan events.
- `holderRows(events: StickyEvent[]): HolderRow[]`, where `HolderRow = {holder; staked: bigint; start: number; longest: number; sticks: number}`.
- `verifyHolderPage(chainId, projectId, rows, block): Promise<HolderRow[]>`, which re-reads `stakedBalanceOf` for the visible page.
- `backingSeries(flows, supplyFallback): SeriesPoint[]` and `backingFlows(chainId, projectId, fromBlock): Promise<Flow[]>`.
- `siblingProjects(info, candidates): Sibling[]`, which groups by `launchId`, tax and soulbound, and `siblingTotals(siblings)`.

- [ ] **Step 1: Port the tests.**
  - New indexed-holder cases:
    - Indexed positions map to rows with the streak rules above.
    - A tail-scan `Staked` past the indexed block raises that holder's balance.
    - A holder whose indexed balance is 0 drops out of active rows.
  - From `OLD/test/project-page.test.cjs`: holder rows from events, pinned-block ages, page re-read, sibling discovery and totals.
  - From `OLD/test/chart-backing.test.cjs`: flows, fees, orphans, zero clamp, underlying labels and supply fallback.
- [ ] **Step 2: Run them.** Expected: FAIL. Implement by porting `holderRows` (`OLD/app.js:1137-1170`), `verifyHolderPage` (1172), `backingFlows` (1229) and `backingSeries` (1775), plus `renderSiblings`' data part (787-815).
- [ ] **Step 3: Run them again.** Expected: PASS. Commit with the message `Derive holders, backing history and sibling chains`.

### Task 1.7: Metadata, prices, handles, ENS, formatting

**Files:**
- Create: `W/src/lib/sticky-metadata.ts`, `sticky-prices.ts`, `sticky-format.ts`
- Copy from JBM: `project-handles.ts` and `ens.ts`
- Test: `W/test/lib/{sticky-metadata,sticky-prices,sticky-format,handles}.test.ts`

**Interfaces:**
- `projectMetadata(chainId, stakedToken): Promise<{name?: string; logoUri?: string; sticky?: StickyUri}>`. It uses `JBTokens.projectIdOf`, then `uriOf`. A `data:` URI is parsed inline; otherwise the document comes through `https://juicebox.center/ipfs/`. It is used as an `immutableQuery` keyed by URI, so it is persisted.
- `usdPrices(chainId, tokens): Promise<Map<Address, number>>`. It reads DexScreener and returns an empty map on testnets.
- `formatAmount(value, decimals)` follows juicebox.money's rules. Also `formatDuration(seconds)` and `ago(ts)`.
- Handles: jbm's `resolveProjectHandle(handle) → {chainId, projectId} | null`, verified.

- [ ] **Step 1: Port the tests.**
  - `OLD/test/format.test.cjs`
  - `OLD/test/ens.test.cjs`: ENS and handles on production chains only.
  - The DexScreener pair choice: most liquidity, token as base or quote.
  - `assetUrl`'s https-only rule (`OLD/runtime.js:16-25`).
  - `metadata-rendering`: a symbol like `<img onerror=…>` renders as text. This one runs as a component test in Task 2.3.
- [ ] **Step 2: Run them.** Expected: FAIL. Implement by porting `resolveProjectMetadata` (`OLD/app.js:456-483`), the prices code (1490-1580) and the formatters (411-419).
- [ ] **Step 3: Run them again.** Expected: PASS. Commit with the message `Resolve project metadata, prices, handles and amounts`.

---

## Phase 2: Read-only pages (PR "web: read-only pages")

Deliverable: home, project and account pages on dev.sticky.center that match the live site's reads. Old links land on the right view. Playwright smoke tests pass at 320, 390, 768 and 1280 px.

**Shared rule for every component in this phase:**
- Data comes from `useQuery` with plain array keys. Public facts get `meta: PERSIST` and render under `<Revalidating>`.
- Each view draws its own skeletons, and there is no global loading pill.
- Component tests use react-test-renderer with the query functions mocked, the way `JBM/test/components` does.
- Position and reward queries refresh every 15 s (`refetchInterval: 15_000`) and stop while the tab is hidden (`refetchIntervalInBackground: false`). Each owning task tests this with fake timers and `document.hidden`.

### Task 2.1: Home

**Files:**
- Create: `W/src/app/page.tsx`, `W/src/components/home/{HomeLists,StickiestCard,SecuredChart,HomeHero}.tsx`, `W/src/components/StickyFeed.tsx`
- Test: `W/test/components/home.test.tsx`, ported from `OLD/test/home-states.test.cjs`

**Interfaces:**
- Consumes: `indexedStickyProjects`, `readStickyProject`, `feedRows`/`airdropRows`, `usdPrices` and `stickyChainIds`.
- Produces: `useStickyHome(network)` returning `{cards, activity, airdrops, secured, failedChains}`. It persists, which replaces the `sticky.home.v1` HTML snapshot. It also exports `refreshStickyHome()`, which invalidates now, at +4 s and at +12 s, for use after a launch.

- [ ] **Step 1: Port the home-states tests as component tests.**
  - The loading, empty, error and ready semantics, with the exact notes: "Sticky is not deployed yet.", "Sticky is not on testnets yet.", "No sticky tokens yet.", "No sticky tokens on testnets yet.", "Could not read Sticky tokens.", "Could not read Sticky tokens on X."
  - Chain links, merging and grouping (sibling launches collapse into one card), and retry.
  - Ready stays ready on a revisit.
- [ ] **Step 2: Add the keyboard and chart tests.**
  - The tab layout: phones below 640 px get Latest, Stickiest and Airdrops tabs; tablets get Stickiest and Airdrops; desktops show all three lists.
  - Arrow, Home and End keys move between tabs.
  - `SecuredChart` handles pointer, focus and ←/→ keys, and mounts only when every loaded chain has prices.
- [ ] **Step 3: Run them.** Expected: FAIL. Implement by porting `renderHome` (`OLD/app.js:2203-2276`), `stickiestCardHtml` (2180), `groupHomeCards` (2162), `homeSecuredSeries` and `mountHomeSecuredChart` (1621-1746), and `feedCard` (1390) as `StickyFeed`. The feed rows use jbm's row layout: the amount and in/out tag on the left; the age and chain icon linking to the transaction on the right; then the project link and the line.
- [ ] **Step 4: Run them again.** Expected: PASS. Build, then commit with the message `Show the Sticky home: Latest, Stickiest, Airdrops and the secured chart`.

### Task 2.2: Project route, header and tabs

**Files:**
- Create: `W/src/app/[urn]/page.tsx`, `W/src/app/[urn]/loading.tsx`, `W/src/components/project/{ProjectHeader,Tabs,StickCard}.tsx`
- Modify: `JBM/src/components/project/Tabs.tsx`, adding the `activityLabel` prop with default `'Activity'` (a separate jbm PR, same diff)
- Test: `W/test/components/project-route.test.tsx`

**Interfaces:**
- `[urn]` resolves `parseUrn` or, when the segment starts with `@`, `resolveProjectHandle`. Anything else is `notFound()`.
- `useStickyProject(chainId, projectId)` returns `{info, verified: boolean}`, where `verified` is true only after a fetch in this visit, never from persisted data.

- [ ] **Step 1: Write the failing tests.**
  - `/base:23` renders the header with a meta row of Stuck, Sticks, On, Average active stick and Longest active stick, in that order.
  - The tabs are Overview, Tokens and Airdrops. Below 821 px the Latest tab is selected by default. `#tokens` opens Tokens.
  - With persisted data but no fresh fetch, the Stick button is disabled and reads "Checking…" (`OLD/app.js:2310`).
  - Changing the route key discards the previous project's data. This is the view-races rule, which react-query keys make structural.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Copy jbm's `Tabs.tsx` and add the prop.
  - Pass `<ProjectTabs activityLabel="Latest" sidebar={<StickCard/>} activity={<StickyFeed/>} tabs=[…]>`.
  - Port the header from `OLD/index.html:882-888` and `OLD/app.js:2370-2478`, with Stuck painting early from the backing read.
- [ ] **Step 4: Run them again.** Expected: PASS. Build and commit.

### Task 2.3: Overview tab

**Files:**
- Create: `W/src/components/project/{OverviewTab,BackingChart,DetailsCard,ChainsCard}.tsx`
- Test: `W/test/components/overview.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **Details rows:** Token, Sticks, Supply, Backing, Backing per token, Unowned backing, Stickiness bonus, Transfers.
  - **Under "Rules and contracts":** copyable addresses for the Sticky token, the underlying token, and "Stick accounting" (the hook).
  - **Chains card:** a "Planned at launch. Not deployed yet." row, and a total that shows only when every chain uses the same token.
  - **Chart:** falls back to Sticky supply, with its label saying so.
  - **Escaping:** a symbol of `<img src=x onerror=alert(1)>` renders as text (the metadata-rendering port).
- [ ] **Step 2: Run them.** Expected: FAIL. Implement by porting `detailsHtml` (`OLD/app.js:2482`), `chartSvg` (1795-1930) and `renderSiblings`.
- [ ] **Step 3: Run them again.** Expected: PASS. Commit.

### Task 2.4: Tokens tab

**Files:**
- Create: `W/src/components/project/{TokensTab,TrancheTable,Leaderboard,BonusSplit}.tsx`
- Test: `W/test/components/tokens.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **You:** Stuck (underlying), Active oldest and Record.
  - **Tranche table:** 50 rows per page with Older and Newer, read at one pinned block. Port the 1M-entry paging case from `actions.test.cjs`.
  - **Transfer button:** hidden when the token is soulbound.
  - **Leaderboard:** sorts by Oldest or Biggest, 20 per page, and the visible page is re-read.
  - **Bonus card:** shows only when the tax is above 0.
- [ ] **Step 2: Run them.** Expected: FAIL. Implement by porting `readTranchePage` (`OLD/app.js:2592`), `renderBoard` (6254-6288), `pieSvg` (1953) and `renderBonusSplit` (6138).
- [ ] **Step 3: Run them again.** Expected: PASS. Commit.

### Task 2.5: Airdrops tab (reads)

**Files:**
- Create: `W/src/lib/sticky-rewards.ts`, `W/src/lib/sticky-autostick.ts`, `W/src/components/project/{AirdropsTab,RewardsCard,AutoStickCard,TrustedSenders}.tsx`
- Test: `W/test/lib/sticky-rewards.test.ts`, `W/test/components/airdrops.test.tsx`

**Interfaces:**
- `readRewards(chainId, stToken, holder, groups): Promise<RewardCard[]>`
- `readAutoStick(chainId, projectId, holder): Promise<AutoStickState>`, where `status` is the `AS_STATUS` enum (`OLD/app.js:4169`).
- `trustedSenders(events, reads)`

- [ ] **Step 1: Port the reward tests.** From `actions.test.cjs`:
  - group encoding and labels
  - tenure stake math
  - the earned-rewards cap
  - reward copy dates such as "Oct 16", never "soon" or "—"

  Add these auto-stick cases:
  - `INVALID_PROJECT` hides the card (fails closed).
  - The adapter never appears in the trusted-sender list.
- [ ] **Step 2: Run them.** Expected: FAIL. Implement by porting `renderRewards`' reads (`OLD/app.js:3922-4020`, `earnedRewardsOf` 3721, `rewardPosition` 3784, `rewardStakeOf` 3707), `renderAutoStick`'s reads (4274-4331) and the trusted-sender list (3014-3047).
  - Buttons render, but stay inert until phase 3 and 4 wire them.
- [ ] **Step 3: Run them again.** Expected: PASS. Commit.

### Task 2.6: Account page

**Files:**
- Create: `W/src/app/account/[address]/page.tsx`, `W/src/components/account/{AccountPositions,AccountActivity}.tsx`
- Test: `W/test/components/account.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **Title:** "Your account" when the address is the connected wallet, otherwise "Account".
  - **Positions:** one `indexedStickyPositions({holder})` query per network lists every chain's positions.
    - Each listed position's balance is then re-read on its chain, one chain after another. Assert the fake client sees chain 1's reads finish before chain 10's start.
    - When Bendystraw fails, it falls back to reading every deployed project on each chain, again one chain after another.
  - **Failed reads:** a failed chain is counted, with a Retry button.
  - **Activity:** comes from `stickyHolderEvents` and is grouped with `groupSameTx`.
- [ ] **Step 2: Run them.** Expected: FAIL. Implement from `OLD/app.js:5827-5887`, changed to read every chain in the address's environment.
- [ ] **Step 3: Run them again.** Expected: PASS. Commit.

### Task 2.7: Old links, llms.txt, not-found, browser smoke

**Files:**
- Create:
  - `W/src/lib/legacy-routes.ts`, `W/src/components/LegacyHashRedirect.tsx` (mounted in `page.tsx`)
  - `W/src/app/llms.txt/route.ts`, updated from `OLD/llms.txt` with the new URLs
  - `W/src/app/not-found.tsx`, `W/src/app/robots.ts`
  - `W/playwright.config.ts`, `W/test/browser/*`
- Test: `W/test/lib/legacy-routes.test.ts` (Review Focus #3) and `W/test/browser/site.spec.ts`

**Interfaces:**

```ts
/** Old hash routes to jbm-style paths. `search` is location.search, `hash` is location.hash. */
export function legacyRoute(search: string, hash: string): string | null
```

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, expect, it } from 'vitest'
import { legacyRoute } from '@/lib/legacy-routes'

describe('old links', () => {
  it.each([
    ['?chain=8453', '#/project/23', '/base:23'],
    ['?chain=8453', '#/project/23/tokens', '/base:23#tokens'],
    ['?chain=8453', '#/project/23/airdrops', '/base:23#airdrops'],
    ['?chain=8453', '#/project/23/latest', '/base:23#latest'],
    ['?chain=8453', '#/project/23/overview', '/base:23'],
    ['', '#/project/5', '/eth:5'],
    ['?chain=11155420', '#/project/7', '/opsep:7'],
    ['', '#/@banny', '/@banny'],
    ['', '#/@banny/tokens', '/@banny#tokens'],
    ['', '#/account/0x1234567890abcdef1234567890abcdef12345678', '/account/0x1234567890abcdef1234567890abcdef12345678'],
    ['?chain=84532', '#/', '/?network=testnet'],
    ['?chain=84532', '', '/?network=testnet'],
    ['?network=testnet', '', null],
    ['?chain=8453', '#/', null],
    ['', '', null],
    ['', '#tokens', null],
    ['', '#/project/abc', null],
  ])('%s%s → %s', (search, hash, expected) => {
    expect(legacyRoute(search, hash)).toBe(expected)
  })
})
```

  The default chain for an old link without `?chain=` is 1, matching `STICKY_DEFAULT_CHAIN`'s default.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Parser:** `legacy-routes.ts` uses the patterns from `OLD/app.js:5895-5949`.
  - **Redirect:** `LegacyHashRedirect` calls `router.replace(legacyRoute(location.search, location.hash))` once on mount when the result isn't null.
- [ ] **Step 4: Run it again.** Expected: PASS.
- [ ] **Step 5: Browser smoke.** Copy JBM's Playwright setup (`playwright.config.ts`, `test/browser/fail-fast-service.mjs`, the deterministic env) with Sticky fixtures: one Base Sepolia project with 3 holders, recorded from dev.sticky.center reads. Visit home, `/basesep:<id>`, `/basesep:<id>#tokens` and `/account/<holder>` at 320, 390, 768 and 1280 px, and check:
  - axe WCAG A/AA passes with zero contrast findings
  - there is no horizontal overflow and no page errors
  - every non-local request is blocked
- [ ] **Step 6: Gate and commit.** Run `npm run check && npm run test:browser`. Expected: PASS. Commit, then open the PR. Merge it to `dev` and check dev.sticky.center by hand against sticky.center for projects on Base Sepolia and OP Sepolia.

---

## Phase 3: Write engine and core flows (PR "web: stick, unstick, transfer, trust")

Deliverable: stick, stick for someone else, unstick, transfer, trust and untrust, each through jbm's engine, on dev.sticky.center testnets.

### Task 3.1: jbm's engine

**Files:**
- Copy from HR:
  - `src/hooks/useSafeTx.ts`
  - `src/lib/{contract-write,transaction-review,transaction-simulation,gas,receipt,readable-error}.ts`
  - `src/components/{TransactionReviewProvider,TransactionReviewDialog}.tsx`
  - `src/components/ui/{ModalShell,TxConfirmDialog,TxSteps,TxError}.tsx`
- Copy from JBM: `scripts/check-transaction-inventory.mjs` and `test/transaction-sites.json` (emptied)
- Test: copy JBM's `test/transactions/{contract-write,use-safe-tx,review}*.test.ts`, and add `W/test/transactions/sticky-review.test.ts`

- [ ] **Step 1: Write the failing Sticky review test.** For each write Sticky sends (the 19 functions in `OLD/calldata.js`'s ABI list, minus the unused `beginVesting`), build the call and render the review rows. Assert the decoded view is used, not the raw fallback, and assert a known row value. For example:
  - `setTrustedSenderFor(23, 0xabc…, true)` shows a sender row `0xabc…`.
  - A `fund` to `stickyGroupId({minWeeks: 4})` shows "Staked 4+ weeks", via the SDK's `describeStickySplit` and `decodeStickyGroupId`.
- [ ] **Step 2a: Write the confirmation and review-copy tests.** These port `OLD/test/tx-status.test.cjs` and `OLD/test/review-copy.test.cjs`.
  - After a confirmed send, the completed dialog shows "View transaction ↗", linking to the chain's explorer, and stays open until the user presses Done.
  - The steps intro reads "N transactions left", never "remain".
  - Review values wrap at spaces, and only hex values break mid-word.
- [ ] **Step 2: Write the Review Focus #5 test.** With a Signa connector active, `useSafeTx.send` rejects with the `NEEDS_EXTERNAL_WALLET` code. The flow shows "This action needs an external wallet." and a "Connect a wallet" action, and the wallet's `request` is never called. Take the error code from HR's Signa read-only handling.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Copy the engine.** In `TransactionReviewDialog`, add Sticky contract names to the known-address map, from `sticky-addresses.ts` for every chain.
- [ ] **Step 5: Run everything.** Run the copied suites and the new tests. Expected: PASS. Commit with the message `Review and send transactions through jbm's engine`.

### Task 3.2: Builders and quotes

**Files:**
- Create: `W/src/lib/sticky-builders.ts`, `W/src/lib/sticky-quotes.ts`
- Test: `W/test/lib/sticky-builders.test.ts`, with fixtures copied from `OLD/test/calldata-fixtures.json`

**Interfaces:**
- Every builder returns a `TxRequest` (`{chainId, address, abi, functionName, args, value?}` from `useSafeTx`). The builders are:
  - `approveSteps(token, spender, allowance, amount): TxRequest[]`: reset to 0 when the allowance is nonzero and different, then approve the exact amount.
  - `stickTx(info, beneficiary, amount, minReturned)`: `JBMultiTerminal.pay` through the SDK's `buildPayTx`, with memo `""` and metadata `0x`.
  - `unstickTxs(info, holder, count, minReclaimed, autoStick?)`: the full-exit teardown from `OLD/app.js:4874` first, then `cashOutTokensOf` through `buildCashOutTx`.
  - `transferTx`
  - `trustTx(projectId, sender, trusted)`
- The quotes:
  - `quoteStick(chainId, projectId, token, amount, payer, beneficiary)`: `previewPayFor` with `account = payer`. It rejects zero issuance and requires reserved = 0, an offset of 384 and no hooks (`OLD/app.js:4773-4783`).
  - `quoteUnstick(...)`: the net after the terminal's fee rule (`OLD/app.js:4725-4748`).

- [ ] **Step 1: Port the builder and quote cases** from `OLD/test/actions.test.cjs` and `OLD/test/calldata.test.cjs`:
  - approval reset
  - frozen review
  - stake, grant, unstake and the full-exit teardown
  - "Unstick without reclaiming tokens" when the quote is zero
  - the exact dialog copy "You get 1.95 ART. 0.5 ART stays…"
  - every `cast calldata` fixture round-trips byte for byte
- [ ] **Step 2: Run them.** Expected: FAIL. Implement.
- [ ] **Step 3: Run them again.** Expected: PASS. Commit.

### Task 3.3: Stick and stick for someone else

**Files:**
- Create: `W/src/components/project/flows/StickFlow.tsx`
- Modify: `W/src/components/project/{StickCard,AirdropsTab}.tsx`, `W/test/transaction-sites.json`
- Test: `W/test/components/stick-flow.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **Input:** typing waits 250 ms before quoting ("You get at least N STICKYX"). A failed quote blocks the button.
  - **Review:** the main button opens `TxConfirmDialog` in `preparing`. It re-reads the allowance and the quote, then lists the steps: an approval reset if needed, the approval, then Stick.
  - **Review Focus #4:** the allowance already equals the amount (the approval landed before a reload). The steps are Stick only, and exactly one wallet call is made.
  - **Stick for someone else:** refused unless the sender is a granter or the beneficiary trusts the sender.
  - **Unverified project:** Stick stays disabled.
- [ ] **Step 2: Run them.** Expected: FAIL. Implement following `JBM/src/components/project/BurnTokensFlow.tsx`'s shape. Register both sites in `transaction-sites.json`.
- [ ] **Step 3: Run them again.** Expected: PASS. Build and commit.

### Task 3.4: Unstick

**Files:**
- Create: `W/src/components/project/flows/UnstickFlow.tsx`
- Test: `W/test/components/unstick-flow.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **Full exit with auto-stick on:** four steps in order: `setConfigFor(off)`, untrust the adapter, approve 0, then `cashOutTokensOf`.
  - **Partial exit:** a single `cashOutTokensOf`.
  - **Minimum:** `minReclaimed` equals the net quote.
  - **Preflight:** an `eth_call` runs before review, and a revert shows `TxError` without opening the wallet.
- [ ] **Step 2: Run them.** Expected: FAIL. Implement.
- [ ] **Step 3: Run them again.** Expected: PASS. Commit.

### Task 3.5: Transfer and trust

**Files:**
- Create: `W/src/components/project/flows/{TransferFlow,TrustFlow}.tsx`
- Test: `W/test/components/{transfer,trust}-flow.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **Transfer:** only unlocked tokens can move, the amount has 18 decimals, and sending to yourself is refused.
  - **Trust:** `setTrustedSenderFor(id, sender, true)`, and Untrust sends `false`.
- [ ] **Step 2: Run them.** Expected: FAIL. Implement.
- [ ] **Step 3: Run them again.** Expected: PASS.
- [ ] **Step 4: Gate.** Run `npm run check`, then commit and open the PR.
- [ ] **Step 5: Verify live.** On dev.sticky.center with a funded testnet wallet, run each flow once on Base Sepolia. Record the transaction hashes in the PR.

---

## Phase 4: Rewards, auto-stick, reward addresses (PR "web: airdrops and auto-stick")

Deliverable: every Airdrops-tab button works through jbm's engine on dev.sticky.center testnets.

Component tests in this phase use react-test-renderer with mocked reads and a mocked `useSafeTx`, like Task 3.3. Case names taken from `OLD/test/actions.test.cjs` keep their names.

### Task 4.1: Send airdrop rewards

**Files:**
- Create: `W/src/components/project/flows/FundFlow.tsx`
- Modify: `W/src/lib/sticky-builders.ts` (adds `fundTxs`), `W/test/transaction-sites.json`
- Test: `W/test/components/fund-flow.test.tsx`

**Interfaces:**
- `fundTxs(chainId, {stToken, token, amount, groupId, allowance}): TxRequest[]`: the ERC-20 approval steps to the distributor, then `distributor.fund(stToken, token, amount, groupId)`. For ETH (`token` = the native sentinel), it is `fund` alone with `value: amount`.

- [ ] **Step 1: Write the failing tests.**
  - An ERC-20 fund plans an exact approval to the distributor, then `fund`.
  - An ETH fund plans only `fund`, with `value` equal to the amount.
  - A group that fails `isValidGroupId` is refused before review, and the wallet is never called.
  - The review names the group in words: "Everyone", "Staked 4+ weeks" or "Staked 4–12 weeks".
  - The "from chain" select lists only this chain. Phase 6 adds the others.
- [ ] **Step 2: Run them.** `npx vitest run test/components/fund-flow.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** by porting `fundRewards` (`OLD/app.js:4093`) and the fund dialog (`OLD/index.html:1177-1216`). Register the write site.
- [ ] **Step 4: Run them again.** Expected: PASS. Commit with the message `Send airdrop rewards through jbm's engine`.

### Task 4.2: Collect, start vesting, claim & stick

**Files:**
- Create: `W/src/components/project/flows/ClaimFlow.tsx`
- Modify: `W/src/lib/sticky-builders.ts` (adds `collectTx` and `claimAndStickTxs`), `W/test/transaction-sites.json`
- Test: `W/test/components/claim-flow.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - Collect and start vesting both send `collectVestedRewards(stToken, group, [holder], [token], holder)`.
  - An empty allocation is refused before review.
  - A tenure group's review shows a FORFEIT row.
  - "Claim & stick" plans an exact approval, then trusts the adapter only when `isTrustedSenderOf` is false, then calls `adapter.stickRewardsFor(id, groupIds)`.
  - The mint estimate shows only when the adapter can already pay.
  - "Collect only" appears for the underlying token.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** by porting `claimReward` (`OLD/app.js:4130`) and `claimAndStick` (4549). Register both write sites.
- [ ] **Step 4: Run them again.** Expected: PASS. Commit with the message `Collect rewards, start vesting, or claim and stick them`.

### Task 4.3: Auto-stick

**Files:**
- Create: `W/src/components/project/flows/AutoStickFlow.tsx`
- Modify: `W/src/lib/sticky-builders.ts` (adds `autoStickOnTxs`, `autoStickSettingsTx`, `autoStickOffTxs`, `repairTxs`, `compoundTx` and `beginVestingTx`), `W/test/transaction-sites.json`
- Test: `W/test/components/autostick-flow.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **Turn on while it's already on:** disable, then the approval (unlimited, or the exact custom cap), then `setTrustedSenderFor(adapter, true)` only if not already trusted, then `setConfigFor(on, min, cooldown)` last.
  - **Limits:** a cooldown of 0 or 31 days is refused. A minimum above `2^128 - 1` is refused.
  - **Settings:** a single `setConfigFor`.
  - **Turn off:** the disable calls from `asDisableTxs`.
  - **Repair:** `setTrustedSenderFor(adapter, true)` when trust is missing. When the allowance is short, it reopens renew instead.
  - **Stick now:** `adapter.compoundFor(id, holder, groupIds)`.
  - **Start unlocking:** `adapter.beginVestingFor(id, holder, groupIds)`.
  - **Dialog choices:** DAY, WEEK and MONTH, and UNLIMITED or CUSTOM CAP (`OLD/index.html:1262-1289`).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** by porting `saveAutoStick` (`OLD/app.js:4423`), `toggleAutoStick`, `repairAutoStick`, `autoStickNow` (4489) and `beginAutoStickVesting` (4519). Register every write site.
- [ ] **Step 4: Run them again.** Expected: PASS. Commit with the message `Turn auto-stick on, change it, repair it or run it now`.

### Task 4.4: Reward address

**Files:**
- Create: `W/src/components/project/flows/ReceiverFlow.tsx`
- Modify: `W/src/lib/sticky-builders.ts` (adds `createReceiverTx` and `settleTx`), `W/test/transaction-sites.json`
- Test: `W/test/components/receiver-flow.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **Create:** a preflight `eth_call`, then `factory.deployReceiverFor(stToken, groupId)`.
  - **Settle:** `factory.settleFor(stToken, groupId, token)`, offered for ERC-20s only.
  - **Wrong factory:** a factory whose `DISTRIBUTOR()` differs from `stickyDeployment(chainId).distributor` is refused before review.
  - **Status:** the predicted address shows "Created" when it has code, else "Not created yet".
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** by porting `createRewardAddress` (`OLD/app.js:4064`) and `settleArrivals` (4591). Register both write sites.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Gate and open the PR.** Run `npm run check`, then commit and open the PR. On dev.sticky.center, run each Phase 4 flow once on Base Sepolia and record the hashes in the PR.

---

## Phase 5: Launch (PR "web: launch Sticky tokens")

Deliverable: single-chain, Relayr multichain and Center-sponsored launches from dev.sticky.center, with the launch banner and recovery after a reload.

### Task 5.1: Launch plan rules

**Files:**
- Create: `W/src/lib/sticky-launch-plan.ts`
- Test: `W/test/lib/sticky-launch-plan.test.ts`

- [ ] **Step 1: Port every case in `OLD/test/launch-plan.test.cjs`, keeping their names.**
  - bonus presets 0/5/10/25, default 10, custom 0–99.99
  - default names "Sticky <name>" and `STICKY<SYM>`
  - trusted-sender parsing
  - AutoStick always as the last granter
  - token input as an address, `5` or `base:5`
  - cross-chain project token resolution and the same-token check
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** by porting `OLD/launch-plan.js` (92 lines) to TypeScript, keeping each exported function's name.
- [ ] **Step 4: Run them again.** Expected: PASS. Commit with the message `Port the launch form rules`.

### Task 5.2: Create dialog

**Files:**
- Create: `W/src/components/create/CreateDialog.tsx`
- Modify: `W/src/components/home/HomeHero.tsx` (the "Make your token sticky" button opens it)
- Test: `W/test/components/create-dialog.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **Fields, in order:** token, name, symbol, bonus (presets as native buttons with `aria-pressed`), trusted senders, TRANSFERS (Locked or Unlocked, default Unlocked), and DEPLOY (Production or Testnets, plus a checkbox per chain).
  - **Blocked chains:** a chain without a deployment shows "not deployed", and one without an adapter shows "no auto-stick helper". Neither can be checked.
  - **Invalid input:** Launch stays disabled until the token resolves on every checked chain.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** by porting `OLD/index.html:1108-1175` and `OLD/app.js:6036-6218`.
- [ ] **Step 4: Run them again.** Expected: PASS. Commit with the message `Open the create form from home`.

### Task 5.3: Runtime checks and a single-chain launch

**Files:**
- Create: `W/src/lib/sticky-launch.ts`, `W/src/components/create/LaunchDialog.tsx`
- Modify: `W/test/transaction-sites.json`
- Test: `W/test/lib/sticky-launch.test.ts`, `W/test/components/launch-dialog.test.tsx`

**Interfaces:**
- `checkLaunchChains(plan): Promise<Map<number, LaunchBlocker | null>>`, ported from `loadStickyRuntime` (`OLD/app.js:3118-3162`):
  - the RPC's chain id
  - code at the deployer and its dependencies
  - the creation fee
  - the adapter's deployer, distributor and hook must match
  - the token's name, symbol and decimals must match on every chain
- `deployTx(chainId, plan, creationFee): TxRequest`: `StickyDeployer.deployStickyFor(token, name, symbol, uri, taxBps, granters, soulbound)` with `value = creationFee`. The `uri` is the inline Sticky URI from `OLD/app.js:5020-5026`.

- [ ] **Step 1: Write the failing tests.**
  - Port the chain-blocker cases from `OLD/test/launch-listing.test.cjs`.
  - Port every case in `OLD/test/launch-wallet.test.cjs`: closing a payment review keeps the pending state, a missing record blocks, and the wrong account is refused.
  - A single-chain launch sends exactly one `deployStickyFor` with the fee as `value`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Register the write site.
- [ ] **Step 4: Run them again.** Expected: PASS. Commit with the message `Launch on one chain`.

### Task 5.4: Multichain launch through Relayr

**Files:**
- Copy from JBM: `src/lib/{relayr,relayr-chains,launch-relayr,launch-session,forwarder-authorization}.ts`
- Create: `W/src/components/create/LaunchBanner.tsx`
- Modify: `W/src/lib/launch-session.ts` (the storage key becomes `sticky-launch-pending-v1`), `W/src/components/create/LaunchDialog.tsx`, `W/test/transaction-sites.json`
- Test: copy JBM's `test/transactions/{relayr,launch}*.test.ts`, and add `W/test/lib/sticky-relayr-launch.test.ts`

- [ ] **Step 1: Map the old Relayr and launch-session cases.** For each case in `OLD/test/relayr.test.cjs` and `OLD/test/launch-session.test.cjs`, either name the copied jbm test that covers it or write it new in `sticky-relayr-launch.test.ts`. The cases:
  - the bundle is posted once
  - the quote is bound to the saved calls before any payment choice
  - payment happens once
  - recovery after a reload
  - candidate hashes are kept
  - a reorg downgrades a confirmed chain
  - binding rejects a changed request
  - the deployment receipt must carry DeploySticky plus Create
  - Relayr transaction IDs bind by request, never by index

  Put the mapping table in the test file's header comment.
- [ ] **Step 2: Add the banner test.** It reads "<SYM>: N of M chains confirmed.", polls every 12 s, and pauses while `document.hidden`.
- [ ] **Step 3: Run them.** Expected: FAIL.
- [ ] **Step 4: Implement.** Deploy calls go through the ERC-2771 forwarder, as in `launch-relayr`, with the funding-chain picker from `requireFundingChainSelection`.
- [ ] **Step 5: Run them again.** Expected: PASS. Commit with the message `Launch on several chains with one Relayr payment`.

### Task 5.5: Juicebox Center listing and the sponsored launch

**Files:**
- Create: `W/src/lib/sticky-listing.ts`, following HR's `lib/fund-intent.ts` and `lib/jbcenter-client.ts`
- Modify: `W/src/components/create/LaunchDialog.tsx`
- Test: `W/test/lib/sticky-listing.test.ts`

- [ ] **Step 1: Port the tests.**
  - Every case in `OLD/test/center-intents.test.cjs`:
    - the envelope format, sorted, with no value
    - the content-hash vector
    - signing only an exact echo
    - the error codes
    - recording waits for 2 confirmations
    - the sponsored-plan rules and the forwarder constants
  - The listing-plan cases from `OLD/test/launch-listing.test.cjs`:
    - self-paid today
    - sponsored only when every chain can be sponsored (not chain 1) and `isTrustedForwarder(0x3bA6…E3e2)` is true
    - contract accounts can't list, but 7702 wallets can
    - no Center URL means no listing
  - The plain-words error mapping, from `OLD/app.js:5075-5082` and `OLD/launch-session.js:65-71`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Listing:** sign Center's `sticky.center/deploy.v1` message, publish it, then record the deployments.
  - **Center unavailable:** if Center refuses or can't be reached, the launch continues unlisted and offers "List on Juicebox Center" as a retry.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Gate and open the PR.** Run `npm run check`, then commit and open the PR. On dev.sticky.center, run and record:
  - a self-paid launch on Base Sepolia
  - a Relayr launch on Base Sepolia and OP Sepolia
  - a sponsored launch

  Record the transaction hashes and the intent id.

---

## Phase 6: Bridge rewards across chains (PR "web: bridge airdrop rewards")

Deliverable: airdrop rewards funded from another chain, from queue to claim, on dev.sticky.center testnets.

### Task 6.1: Bridge model

**Files:**
- Create: `W/src/lib/sticky-bridge.ts`
- Test: `W/test/lib/sticky-bridge.test.ts`

- [ ] **Step 1: Port every case in `OLD/test/bridge.test.cjs`, keeping their names.**
  - the empty Merkle root, and proofs
  - the net minimum with 1% slippage
  - route discovery in both directions, and route rejections
  - environments never mixed
  - receiver prediction per group
  - movement rebuild and its rejections
  - claim
  - transport budgets for CCIP, native bridges and Arbitrum
  - terminal migration
  - an incomplete history blocks prepare
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** by porting `OLD/bridge.js` (378 lines) onto viem clients from `jbCenterPublicClient`.
  - History is rebuilt from INSERT logs and checked against the sucker's root on every read.
  - No bridge records are saved, because jbm's engine re-derives state. That drops `sticky:bridge:v2:*` and its locks.
- [ ] **Step 4: Run them again.** Expected: PASS. Commit with the message `Port the reward bridge model`.

### Task 6.2: Bridge flows

**Files:**
- Create: `W/src/components/project/flows/BridgeFlow.tsx`
- Modify: `W/src/components/project/flows/FundFlow.tsx` (the "from chain" select lists other chains and opens `BridgeFlow`), `W/test/transaction-sites.json`
- Test: `W/test/components/bridge-flow.test.tsx`

- [ ] **Step 1: Write the failing tests.**
  - **Queue:** the source-token approval(s) to the sucker, then `sucker.prepare(count, beneficiary, minBacking, token, metadata)`.
  - **Send across chains:** `sucker.toRemote(token)` with `value` equal to the fee plus the simulated transport budget.
  - **Claim:** on the destination chain, `sucker.claim(claimData)`, after the proof is re-checked.
  - **Navigation during a quote** (the port of `OLD/test/daybreak-bridge-project-race.test.cjs`): navigating to another project while a bridge quote loads stops the flow before review.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** by porting `prepareBridgeFunding` (`OLD/app.js:3480`) and `actOnBridgeMovement`. Register every write site.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Gate and open the PR.** Run `npm run check`, then commit and open the PR. On dev.sticky.center, run a Base Sepolia to OP Sepolia bridge from queue to claim and record the hashes.

---

## Phase 7: Cutover (PR "web: replace webclient")

- [ ] **Step 1: Parity walk on dev.sticky.center.** Tick every row of the checklist below. Record each hash or screenshot in the PR.
- [ ] **Step 2: Delete `webclient/`.**
  - Move `OLD/llms.txt` content into `W/src/app/llms.txt/route.ts` (already done in Task 2.7).
  - Point the root `package.json` `deploy:post:*` scripts at `node web/scripts/sync-deployments.mjs` only.
  - Delete `.github/workflows/webclient.yml`.
  - Update `README.md`, `ARCHITECTURE.md` and `USER_JOURNEYS.md` where they name `webclient/`, `serve.py` or hash URLs.
- [ ] **Step 3: Railway production (jango).**
  - Point the service root at `/web` and switch the builder to Dockerfile.
  - Set `NEXT_PUBLIC_SITE_URL=https://sticky.center`, both Bendystraw URLs, `NEXT_PUBLIC_VERSION`, and the `NEXT_PUBLIC_CENTER_WALLET_*` values copied from `STICKY_CENTER_WALLET_*`.
  - Remove the `STICKY_*` RPC and Dwellir variables after the deploy is green.
  - Set the health check to `/api/healthz`.
- [ ] **Step 4: Verify.**
  - `https://sticky.center/api/healthz` shows the merge sha.
  - An old link, `https://sticky.center/?chain=8453#/project/23`, lands on `/base:23`.
  - Signa sign-in works.

### Parity checklist

**Routes and states**
- [ ] Home loading, empty, error and ready states
- [ ] Testnet home
- [ ] Project Overview, Tokens, Airdrops and Latest (on phones)
- [ ] `/@handle`
- [ ] Account page
- [ ] Old links
- [ ] llms.txt

**Writes**
- [ ] Stick
- [ ] Stick for someone else
- [ ] Unstick (partial)
- [ ] Unstick (full exit with auto-stick on)
- [ ] Transfer
- [ ] Trust
- [ ] Untrust
- [ ] Send airdrop (ERC-20)
- [ ] Send airdrop (ETH)
- [ ] Collect or start vesting
- [ ] Claim & stick
- [ ] Auto-stick on/renew, settings, off, repair, stick now and start unlocking
- [ ] Create reward address
- [ ] Settle arrivals
- [ ] Bridge queue, send and claim
- [ ] Direct launch
- [ ] Relayr launch
- [ ] Sponsored launch

**Wallets**
- [ ] Signa sign-in, framed and full-page callback
- [ ] Browser wallet via EIP-6963
- [ ] WalletConnect
- [ ] View as
- [ ] Signa write refused with Connect

**Behavior**
- [ ] A launch's saved record survives a reload and posts once
- [ ] Background refreshes pause in hidden tabs

---

## Ops steps for jango (in order)

1. **Phase 0:** merge the Center PR adding `https://dev.sticky.center`. Create the Railway dev environment and domain, and set its variables (Task 0.7). Optionally add Signa framing for dev.
2. **Phase A:** approve the push to PR #36, which is upstream on peripheralist/bendystraw, so its maintainer merges it. The merge deploys automatically, with a full replay. Then run Task A.2's checks.
3. **Phase 2:** merge jbm's one-prop `Tabs.tsx` PR.
4. **Phase 7:** switch the Railway production service to `/web` and set its variables (Phase 7, Step 3).

## Skipped on purpose

- **Indexing `SetToken`.** Nothing reads it.
- **Server-rendered first pages.** Pages render client-side, like Sticky today. Add server rendering when search engines or link previews need it; jbm's `[urn]` server fetch is the model.
- **Sharing code with jbm through a package.** jbm and revnet share by copying, so Sticky does the same (`COPIED.md` records the sources).
