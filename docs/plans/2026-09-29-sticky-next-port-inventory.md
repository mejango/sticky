# Sticky web client inventory (port reference, 2026-09-29)

What the vanilla client in `webclient/` does, with file:line references at HEAD b1d2029 plus the same-tx feed fix. The Next port must keep all of it except the drops listed in the plan.

**Routes.** All are hash routes. `?chain=<id>` picks the chain for project, account and handle routes, and the environment for home.
- `#/` home
- `#/project/<id>` with optional `/overview`, `/tokens`, `/airdrops` or `/latest`
- `#/@<handle>` with the same tabs
- `#/account/<0x…40>`
- Server paths: `/`, `/healthz`, `/center/callback`, `POST /api/bendystraw/{mainnet|testnet}/query`, `/llms.txt`

**Write flows: 23.** 22 send wallet transactions and 1 is signature-only (the Center-sponsored launch).
- **Stick flows:** stick, stick for someone else, unstick, transfer, trust sender, untrust sender.
- **Rewards:** send airdrop (ERC-20 or ETH), collect / start vesting, claim & stick.
- **Auto-stick:** turn on / renew, settings, turn off, repair, stick now, start unlocking.
- **Reward receivers:** create reward address, settle arrivals.
- **Bridge:** queue, send across chains, claim.
- **Launch:** direct launch, Relayr-paid multichain launch, Center-sponsored launch.
- Hash recovery and dismiss/discard actions come on top of these.

**10 riskiest things to lose in the port**
1. **Calldata review gate** (`calldata.js`). Every write is decoded against a fixed ABI list, and review rows are checked against the calldata. Any mismatch disables Confirm.
2. **Saved transaction record** (`tx-engine.js`, `tx-safe.js`). Each step is saved to localStorage before the wallet opens, and a cross-tab lock stops two tabs sending at once. An unclear submission is never resent. Receipts are re-checked against the chain before being trusted, a failed step can only be retried once its block is finalized, and Safe proposals are tied to their exact execution. Recovery works by pasting an execution hash.
3. **Saved launch record** (`launch-session.js`). The Relayr bundle is only ever posted once, because the deployer has no protection against duplicate launches. Also: the quote is matched to the saved calls before any payment choice, payments are verified, candidate hashes are kept, and the Center listing states and self-pay fallback all live here.
4. **Quotes used as minimums.** The pay preview (with the real payer) is the minimum tokens returned. The unstick minimum is the net after the terminal's fee rule. Zero issuance is refused.
5. **Bendystraw relay.** It forwards only registered SHA-256 queries, with typed variables and a 15 s shared cache. A registry check runs in CI. Every read falls back to the chain, and money figures never come from Bendystraw.
6. **Bridge safety.** Routes are verified in both directions, bridge history is rebuilt and checked against the source contract's Merkle root, and transport fees are simulated. Saved bridge records are locked.
7. **Headers.** The CSP is `script-src 'self'` with no inline scripts. The Signa callback page can only be framed by this site. The set of served files is fixed, and the vendored SDK hash is checked.
8. **Hash-route compatibility.** The view is named before first paint, a cached project summary shows faded until confirmed, stale results are dropped after navigation, and handles are verified.
9. **Log scanning.** Range-limit splitting, batched RPC requests, each project's creation block, a saved scan history kept 64 blocks behind the chain head, and multichain sibling matching.
10. **Accounting display rules.** "Stuck" is the underlying backing, not the Sticky supply, and Sticky shares use 18 decimals. The chart is rebuilt from terminal events, and reward-group encoding mirrors the distributor.

---

# Sticky webclient: Next.js port inventory

Source: `/Users/jango/Documents/jb/v6/evm/extensions/sticky/webclient` at HEAD `b1d2029`, plus an uncommitted diff. The diff adds `sameTxKey` and merges same-transaction streak events into the stick or unstick row (`app.js:1251-1305`), with its test in `test/feed-amounts.test.cjs:167-183`. Include it.
The jbm app to mirror is at `/Users/jango/Documents/jb/v6/evm/webclients/juicebox-money`.

## 0. File map

| File | Lines | Role |
|---|---|---|
| `app.js` | 6621 | Everything in the UI: router, views, reads, write builders, confirm dialog, wallet, launch and bridge UI, demo RPC |
| `index.html` | 1342 | Markup for all views and dialogs, plus all CSS inline in `<style>` (21-751). Scripts load at 1329-1340 with a shared `?v=133` |
| `route-boot.js` | 114 | Runs in `<head>` before paint; sets `html[data-route]`. Also holds the project-summary, handle and JSON caches |
| `runtime.js` | 358 | RPC (plain and batched), log scanner, asset URL checks, per-chain deployment lookup, fixture stripping, Bendystraw client and the 4 query documents |
| `calldata.js` | 319 | ABI list for every write (19 functions), strict decoder, review-row check, formatters |
| `tx-engine.js` | 493 | Saved transaction record and cross-tab lock; submit, poll, recover |
| `tx-safe.js` | 130 | Decodes a Safe `execTransaction` and its outcome events |
| `relayr.js` | 386 | Relayr prepaid client, a keccak256 implementation, payment and deployment checks |
| `launch-plan.js` | 92 | Pure create-form rules (bonus, names, trusted senders, token input) |
| `launch-session.js` | 360 | Saved-launch store and controller (direct, relayr and center modes, Center listing) |
| `center-intents.js` | 137 | Juicebox Center listing client (`sticky.center/deploy.v1`) |
| `center-callback.{html,js}` | 33/75 | `/center/callback` page for the Signa sign-in |
| `center-connect.js` | 19 (198 KB) | Vendored ESM bundle of `@bananapus/nana-sdk-connect/core` 0.5.6, `@me.jango/center-wallet` 0.3.7 and viem 2.55.19. Rebuilt by `vendor/build.sh` (entry at `vendor/entry.js`) |
| `wallet-chooser.js` | 156 | Sign-in dialog (Signa passkey frame, wallet tiles) |
| `bridge.js` | 378 | V6 sucker reward bridging: route discovery, Merkle rebuild, prepare/flush/claim |
| `serve.py` | 405 | Waitress and WhiteNoise server, headers, `/healthz`, Bendystraw relay |
| `build-config.py` | 243 | Env vars to `config.js`; `--sync-deployments` / `--check-deployments` |
| `bendystraw-registry.py` / `bendystraw-operations.json` | 64/6 | Allowed query registry, `{sha256: document}` |
| `deployments.json` | 58 | Per-chain addresses and scan start blocks |
| `config.js` / `config.example.js` | 84/17 | Generated live config / demo example |
| `llms.txt` | 52 | Agent-facing guide: routes and vocabulary |
| `railway.json`, `requirements.txt`, `.env.example` | – | Deploy setup (waitress 3.0.2, whitenoise 6.12.0) |
| `test/` | 32 `.test.cjs`, 2 `.py`, 1 fixtures json | See §6 |

Hidden state inputs: `#rpc`, `#deployer` and `#account` sit in a `#connection-dialog` that nothing ever opens (`index.html:1093-1106`). They hold the page RPC URL, the deployer and the local-mode account, read through `$("rpc").value` and so on. In the port these become context/state.

## 1. Routes and views

### 1.1 Router
- `route()` is at `app.js:5894-5949` and runs on `window.onhashchange` (5950). Tab map (5895): `overview→overview`, `tokens→owners`, `airdrops→rewards`, `latest→activity`.
- Patterns:
  - account `^#\/account\/(0x[0-9a-fA-F]{40})$` (5910)
  - handle `^#\/@([^/]+)(?:\/(overview|tokens|airdrops|latest))?\/?$` (5918)
  - project `^#\/project\/(\d+)(?:\/(tab))?\/?$` (5936)
  - anything else is home
- The same patterns are in `route-boot.js:8-14` `routeKind()`, which sets `<html data-route>` before first paint. CSS then hides home on project or account routes (`index.html:365-366`). `syncRouteView()` is at `app.js:5891`.
- Each route change closes every dialog (5898-5904), cancels a pending review (5906) and bumps `viewSequence`. `currentView()` (966-971) drops stale async results when the sequence, chain, project or account changes.
- `?chain=<id>`:
  - `pageChainId()` (2280) picks the chain for project, account and handle routes.
  - `homeEnvironment()` (2036) picks production or testnet for home.
  - Links to another chain use `?chain=N#/project/id` (`projectHref`, 2047).
- Boot (6588-6616): demo mode wires the fixture RPC. Otherwise `route()` renders immediately and `loadDeployer()` runs in the background. Home does not wait for the page chain (`applyDeployment`, 1022).
- Deployment boot cache (`sticky.boot.v1:<chain>:<deployer>`, 973-1045): a returning visit starts from the saved addresses and re-checks them. If the chain disagrees, the page stops with a loud error.

### 1.2 Home `#/` (`index.html:769-855`; `renderHome` at `app.js:2203-2276`)
- **Layout:** a 4-column grid on desktop (3 lists plus a hero column). Tablet (640-1279 px) gets Stickiest/Airdrops ranking tabs; phones (<640 px) get Latest/Stickiest/Airdrops tabs (`index.html:223-334`). Arrow, Home and End keys move between tabs (`app.js:1471-1488`).
- **"Secured by Sticky" USD chart** (`#home-secured`, 780-793): the value, a hover date/value readout, 28 bars and a caption. `mountHomeSecuredChart` (1662-1746) supports pointer, focus and ←/→ keys. The series comes from `homeSecuredSeries` (1621-1655): today's claimable backing (σ) × USD price. History is estimated from past share counts at today's backing-per-share and price. The chart only mounts once every loaded chain has prices.
- **Latest (`#activity`), Stickiest (`#projects`) and Airdrops (`#airdrops`).**
  - Cards come from `stickiestCardHtml` (2180): rank, logo, label, `#id` or chain icons, Backing, Sticks, Bonus.
  - Sibling launches collapse into one card when they share launchId, tax and soulbound (`groupHomeCards`, 2162).
  - Feed rows come from `feedCard` (1390): amount with an in/out tag, age, chain icon, project link, and a line such as "stuck by", "to X from Y", "auto-stuck by", "unstuck by", "removed by", "got sticky" or "came unstuck after".
  - Newest 40 across chains.
- **Hero:** `hero-donut.png`, "Sticky", "Mark your presence, earn by sticking around.", a "Make your token sticky" button (`#create-toggle`, opens the create dialog) and a GitHub link. A three-step list (Stick/Earn/Unstick) shows only in the empty state (818-822). Explainer blocks use `jar.png`, `cone.png` and `juicebox.png` (826-854).
- **States** (`setHomeState`, 2056): `loading` (pulsing placeholders), `empty`, `error` (note plus Try again), `ready` (note names any failed chains).
  - Notes: "Sticky is not deployed yet." / "Sticky is not on testnets yet." / "No sticky tokens yet." / "No sticky tokens on testnets yet." / "Could not read Sticky tokens." / "Could not read Sticky tokens on X."
  - A snapshot of the last home (localStorage `sticky.home.v1:<env>`, stored as innerHTML) paints at once with the `.revalidating` class (2213-2221) and is only saved when every chain loaded (2259).
- **Data per chain** (`homeChainData`, 2092): the Bendystraw index, then deployed projects, then Bendystraw pays and cash-outs. `homeCards` reads `projectInfo`, `poolBacking` and `launchIdOf` from the chain. Prices load asynchronously. If Bendystraw fails, `scannedHomeChainData` (2116) scans DeploySticky logs and hook position logs instead.
- After a launch completes, `refreshIndexedHome` (2070) re-renders now, at +4 s and at +12 s.

### 1.3 Project `#/project/<id>[/tab]` and `#/@<handle>[/tab]` (`index.html:881-1091`; `renderProject` at `app.js:2370-2478`)
- **Handle route:** `projectIdForHandle` (304-317) checks each deployed project on the page chain. `verifiedHandleOf` (278-299) reads `JBProjectHandles.handleOf(chainId, projectId, owner)` on Ethereum, where owner is `JBProjects.ownerOf` (the deployer). Production chains only. The alias stays in the URL across tabs (2379). A verified handle is cached as `sticky.handle.v1:<chain>:<handle>`.
- **Entering the view** (`enterProjectView`, 2292-2316):
  - The cached summary `sticky.project.v1:<chain>:<id>` (30-day TTL, public facts only) paints with `data-state="cached"`.
  - Otherwise placeholders show.
  - The Stick button is disabled with the label "Checking…" until this visit has verified the project (2310-2312).
- **Header** (882-888): logo (the underlying token's Juicebox project logo), Sticky symbol, name, then a meta row: Stuck, Sticks, On (chain icons), Average active stick, Longest active stick. Stuck paints early from the backing read (2396-2400).
- **Stick card** (`#stick-card`, 892-906): amount, a wallet-balance "max" link and a debounced quote "You get at least N STICKYX" (`renderStickQuote`, 4787).
- **Latest feed** (`#p-latest`, 907-910): a side column on desktop, its own tab on phones (≤820 px, 470-480). The `/latest` route shows Overview on desktop (486-489).
- **Overview tab** (921-941):
  - **Chart:** Total stuck (in the underlying token) and Active sticks (`chartSvg`, 1795-1930; `backingSeries`, 1775). It falls back to Sticky supply if the terminal logs fail.
  - **Details card** (`detailsHtml`, 2482): Token, Sticks, Supply, Backing, Backing per token, Unowned backing, Stickiness bonus, Transfers. Under "Rules and contracts": rules plus copyable addresses for the Sticky token, the underlying token and "Stick accounting" (the hook).
  - **Chains card** (`renderSiblings`, 787-815): a row per sibling chain with backing and supply, "Planned at launch. Not deployed yet.", and totals. Backing is only totalled when every chain uses the same token.
- **Tokens tab** (`#tab-owners`, 1034-1087):
  - **You:** Stuck (underlying), Active oldest, Record. A tranche table with 50 per page, Older/Newer, read at one pinned block (`readTranchePage`, 2592). Unstick and Transfer buttons; Transfer shows only when the token is not soulbound (4631).
  - **All:** a donut pie (`pieSvg`, 1953) plus a leaderboard sorted Oldest or Biggest, 20 per page. The visible page is re-read from the hook (`renderBoard`, 6254-6288; `verifyHolderPage`, 1172).
  - **Stickiness bonus card** (only if tax > 0): `renderBonusSplit` (6138) bar showing where 100 unstuck tokens go.
- **Airdrops tab** (`#tab-rewards`, 943-1032):
  - **Stick for someone else:** recipient, amount, quote, "Review stick".
  - **Send airdrop rewards:** opens the fund dialog, plus two disclosures:
    - "Recurring rewards from a Juicebox project's splits": min/max week inputs and a copyable split hook (the distributor), beneficiary (the Sticky token) and project ID (the group ID).
    - "Reward address for fee payouts and transfers": min/max weeks, the predicted receiver and its status (Created / Not created yet), "Create onchain", a token to settle, "Settle into airdrops".
  - **Your rewards** (`renderRewards`, 3922-4020): a round sentence, then one card per (group, token) showing Claimable now, Vesting (next/last unlock), Earned but not vesting, Funded. Actions: Collect or Start vesting, or "Claim & stick" plus "Collect only" for the underlying token when the adapter can stick. "Check another reward token". A tenure warning note.
  - **Auto-stick card** (`renderAutoStick`, 4274-4331): On/Off state, status line, and Turn on/off, Stick ready rewards now, Start unlocking, Repair / Renew, Settings. Hidden entirely if there's no adapter or `INVALID_PROJECT` (fails closed).
  - **Who can stick for you:** trusted-sender list with Untrust, plus a Trust button. Candidates come from SetTrustedSender logs and are re-checked with `isTrustedSenderOf`; the auto-stick adapter is excluded (3014-3047).
- Position refresh (`refreshPosition`, 2533-2588) runs every 15 s and pauses while the tab is hidden (6617-6619).

### 1.4 Account `#/account/<addr>` (`index.html:857-878`; `renderAccount` at `app.js:5827-5887`)
- Title is "Your account" when the address is the connected wallet, otherwise "Account".
- **Positions:** for every project on the page chain only, read `stakedBalanceOf`, `streakStartOf` and `longestStreakOf`, 6 at a time. Each card shows Stuck (underlying), Time and Longest. Failures are counted with a Retry.
- **Activity:** holder logs scanned from the oldest project's creation block.
- Reached from the wallet menu's "Account" item.

### 1.5 Dialogs (native `<dialog>`, which replace each other rather than stack)
- **create** (`index.html:1108-1175`)
- **fund / Airdrop** (1177-1216): FROM CHAIN select; this chain shows token (address or "ETH"), amount and Send; another chain shows the bridge UI.
- **unstick** (1218-1233)
- **transfer** (1235-1250)
- **trust** (1252-1260)
- **autostick** (1262-1289): minimum, cooldown DAY/WEEK/MONTH, allowance UNLIMITED or CUSTOM CAP
- **wallet** (1291-1295)
- **confirm** (1297-1316)
- **sticky-launch-dialog:** built dynamically (`app.js:5196-5257`)
- **tx-recovery banner and `#cd-recovery` box:** built dynamically (2907-2948)

### 1.6 Global chrome
- **Header** (756-763): drip logos linking home, and the connect button. The "top fold" scroll behaviour is at `app.js:204-224` and `--top-fold-height: 50px`.
- **Other chrome:** `#status` line, `#demo-notice`, `#tx-status` toast (fixed top-right, 1324), address tooltip (1328), footer (1317-1323), `sticky-launch-banner`.

### 1.7 Server paths
`/` → `index.html`, `/healthz`, `/center/callback` (only when Signa is configured), `POST /api/bendystraw/(mainnet|testnet)/query`, and the allowlisted static files including `/llms.txt`. See §5.

## 2. Data sources

### 2.1 RPC transport (`runtime.js`)
- `jsonRpc` (46-80): 20 s timeout, `credentials:"omit"`, `redirect:"error"`, `cache:"no-store"`. It reads the JSON body even on a non-2xx status (base.org answers 413 this way).
- `batchedRpc` (81-139): an 8 ms window and up to 20 per batch. It batches `eth_call`, `eth_getCode`, `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getTransactionReceipt` and `eth_getBalance`. If a batch fails it retries each call alone. Log scans, gas estimates and sends are never batched.
- `logs()` (140-208):
  - Splits a rejected range at the span the node names in its error (`statedRange`), otherwise halves it.
  - Handles HTTP 413, runs at most 8 requests at once and at most 1024 requests per scan.
  - Returns complete, ordered, de-duplicated results and never a partial history.
- `app.js`: page `rpc()` (228) and per-chain `rpcAt()` (3111). The ENS RPC (`ensRpc`) always targets Ethereum.

### 2.2 Contract reads (selectors from `app.js:8-80` unless noted)

**StickyDeployer**
- `HOOK()` 0xa54eb242, `CONTROLLER()` 0xee0fc121, `TOKENS()` 0x1d831d5c, `TERMINAL()` 0x160668af
- `stakedTokenOf(id)` 0xdbced5db, `cashOutTaxRateOf(id)` 0x7aac1c6f
- `isTrustedForwarder(0x3bA6…E3e2)` 0x572b6c05 (`center-intents.js:12`)

**JBMultiTerminal**
- `STORE()` 0x507f1465
- `previewPayFor(id, token, amount, beneficiary, "0x")` 0x0aff0c31, called with `from` = payer. The result must be 13+ words, with reserved = 0, an offset of 384 and no hooks (4773-4783).
- `previewCashOutFrom(holder, id, count, token, holder, "0x")` 0x4aa71dbc: exactly 13 words, offset 384, no hooks (4725-4748).
- `feeFreeSurplusOf(id, token)` 0xc66d192b, `FEELESS_ADDRESSES()` 0x659a2047, then `isFeelessFor(holder, id, holder)` 0x8717d7c2.

**JBTerminalStore**
- `balanceOf(terminal, id, token)` 0x467f4cb9, as the "raw backing".

**Controller**
- `PROJECTS()` 0x293c4999, `TOKENS()`
- `uriOf(id)` 0xa312889b, which returns an inline `data:application/json` Sticky URI `{protocol:"Sticky", version:1, launchId, environment, chains}` (5020-5026).

**JBProjects**
- `count()` 0x06661abd, read at past blocks for a binary search of the creation block (683-699)
- `creationFee()` 0xdce0b4e4, `ownerOf(id)` 0x6352211e

**JBTokens**
- `tokenOf(id)` 0xea78803f, `projectIdOf(token)` 0x0f85421b

**StickyHook**
- `orphanedBalanceOf` 0x325fcad5, `trancheCountOf` 0x56dbba3b
- bounded `tranchesOf(id, holder, start, count)` 0xc964d0f3 (`SEL.tranchesRangeOf`; pages of 50); the unbounded 0x8cc1b370 is used by the demo only
- `stakedBalanceOf` 0x7bd208b2, `streakStartOf` 0xac609038, `longestStreakOf` 0x62a82139
- `isTrustedSenderOf(id, holder, sender)` 0x5d0bc3bb, `isGranterOf(id, addr)` 0xb9f2a2ba
- `stakedBalanceThroughEpochOf(id, holder, epoch)` 0x0fdcc877

**Sticky ERC-20 and underlying ERC-20s**
- `symbol`, `name`, `decimals`, `totalSupply`, `balanceOf`, `allowance`
- `SOULBOUND()` 0x32a9ba68 (a failed read counts as locked, 1064)
- `getPastVotes(holder, block)` 0x3a46b1a8

**StickyDistributor**
- `currentRound` 0x8a19c8bc, `ROUND_DURATION` 0x6641ea08, `VESTING_ROUNDS` 0xaf29da14, `STARTING_TIMESTAMP` 0x20e9fcd4
- `collectableFor` 0x5710be41, `claimedFor` 0x51e0706c, `latestVestedIndexOf` 0x4d5bf2a8, `vestingDataOf` 0xa50ae7da
- `nextClaimRoundOf` 0x5fef1a8a, `rewardRoundOf` 0xc45c9bf6, `isValidGroupId` 0x0468459c, `snapshotEpochOf` 0x09ff1c3f
- Reward math: `earnedRewardsOf` (3721), `rewardPosition` (3784), `rewardStakeOf` (3707)

**StickyRewardReceiverFactory**
- `DISTRIBUTOR()` 0x9c26149f, `predictReceiverOf(stickyToken, groupId)` 0x330b5eea, plus `eth_getCode` on the receiver

**StickyAutoStick adapter**
- `configOf(id, holder)` 0x7f1a9379 → (minimum, cooldown, lastCompoundedAt, enabled)
- `statusOf(id, holder, groupIds)` 0x7d33ed0f → (status, collectable, allowance, nextCompoundAt)
- `AS_STATUS` enum (4169): READY 0, DISABLED 1, INVALID_PROJECT 2, COOLDOWN 3, BELOW_MINIMUM 4, NOT_TRUSTED 5, INSUFFICIENT_ALLOWANCE 6, ZERO_ISSUANCE 7
- Launch pre-checks (`loadStickyRuntime`, 3118-3162): 0xc1b8411a (adapter's deployer), `DISTRIBUTOR()` and `HOOK()`, all of which must match this deployment

**ENS Universal Resolver** 0xeeeeeeee14d718c2b47d9923deab1335e144eeee
- `reverseWithGateways` 0xb7d6ca64. Cached per address; production only (236).

**JBProjectHandles** 0x726f4a3dfd2fb8297f8ab98d215b42a92d8eefe8 on Ethereum
- `handleOf` 0xd9b0da2d

**Bridge** (`bridge.js:14-33`)
- Default contracts: JBTokens 0x1f80…a7d9, JBDirectory 0x5aff…535b, JBSuckerRegistry 0x7903…f297, JBMultiTerminal 0x130f…7f53. These can be overridden per chain via `chains[id].bridgeContracts`.
- Registry: `isSuckerOf`, `allSuckersOf`, `toRemoteFee`
- Sucker: `peer`, `peerChainId`, `projectId`, `state`, `remoteTokenFor`, `outboxOf`, `inboxOf`, `executedLeafHashOf`, and transport probes `CCIP_ROUTER` / `OPMESSENGER` / `ARBINBOX` / `LAYER` / `GATEWAYROUTER`
- Directory: `primaryTerminalOf`; terminal: `accountingContextsOf`, `accountingContextForTokenOf`
- Log topic INSERT 0xc92fa115…

**Relayr payment contract** 0x1c05f7841379d4393574c0ffa17908ec40ffd97d
- The `eth_getCode` keccak must equal `PAYMENT_CODE_HASH`, and the payment is simulated with `eth_call` using 150k gas (`relayr.js:274-284`).

**Safe**
- Decodes `execTransaction` 0x6a761202 and the ExecutionSuccess/Failure events (`tx-safe.js`).

### 2.3 Event topics (`app.js:82-98`)
- **Sticky:** DeploySticky 0xc00d5094…, Staked 0xd6d3230e… (data: payer, count, balance, caller), Unstaked 0x169f9c26… (count, balance, caller), StreakStarted 0xbf35648f…, StreakEnded 0x633ff8e2… (length), SetGranter 0xb1493c70…, SetTrustedSender 0x19cb6ea1…, ExcludeOrphanedBalance 0xa0b9b2db…
- **Distributor:** Fund 0x171d1972… (topics stToken, group, token; data amount at word 1)
- **JBMultiTerminal:** Pay 0x133161f1…, CashOutTokens 0xfaf1d4bf…, ProcessFee 0xb514e730…, AddToBalance 0x9ecaf7fc…
- **Other:** Transfer (declared but unused); JBProjects Create is computed in `relayr.js:204`.

What each scan uses:
- **Project scan** (`projectLogs`, 1111-1133): hook, position topics plus SetGranter, SetTrustedSender and ExcludeOrphanedBalance, filtered by projectId, from the project's creation block.
- **Terminal amounts:** `terminalMoves` (1186) and `backingFlows` (1229).
- **Account:** holder logs (1082).
- **Deployer:** DeploySticky scan (620).
- **Distributor:** Fund scan (3892).
- **Bridge:** INSERT logs.

### 2.4 Bendystraw
Both the queries and the relay are part of the app.

**Operations** (`bendystraw-operations.json`, documents in `runtime.js:263-355`):

| Name | Operation id | Variables | Use |
|---|---|---|---|
| `StickyIndex` | 6d883ec5… | `$owners:[String!]`, `$after` | `_meta{status}` plus projects with owner in the deployers; limit 1000; one call per environment, cached 60 s (`app.js:580-595`) |
| `StickyPays` | ee745e23… | `$where:payEventFilter`, `$after` | pays, one filter per (chain, version), `projectId_in` |
| `StickyCashOuts` | 80dd4117… | `$where:cashOutTokensEventFilter`, `$after` | cash-outs, same filter shape |
| `StickyCreate` | 991f6343… | `$where:projectCreateEventFilter` | creating tx hash; the block is taken from the receipt, which must contain this deployer's DeploySticky (671-682) |

- **Request shape:** the page posts `{operation: sha256(document), variables}` to the same-origin `/api/bendystraw/<mainnet|testnet>/query` (`bendystrawUrl`, 575). The environment comes from the chain.
- **Paging:** `graphqlItems` follows cursors for up to 20 pages. Anything longer is an error, never a silent truncation.
- **Fallbacks:** any Bendystraw failure falls back to chain scans. Launches newer than the indexed block are found by a DeploySticky tail scan from `indexed.block+1` (606-636). Money figures (backing, supply, quotes) never come from Bendystraw.
- **Registry:** rebuilt by `python3 bendystraw-registry.py` and checked in CI with `--check`. Documents must be plain template literals.

### 2.5 IPFS and metadata
- `resolveProjectMetadata` (456-483) looks up the underlying token's Juicebox project (`JBTokens.projectIdOf`, then `controller.uriOf`). An inline `data:` Sticky URI is parsed as-is; otherwise the document is fetched through the gateway `https://juicebox.center/ipfs/` (`runtime.js:11`).
- Fetch options: 10 s timeout, `credentials:"omit"`, no referrer.
- Cached forever in localStorage `sticky.ipfs.v1:<ipfs uri>` (≤200 k chars).
- `logoUri` becomes the token logo (`hydrateLogos`, 828), replacing a monogram badge (`tokenBadge`, 445).
- `assetUrl` (`runtime.js:16-25`) only allows https URLs without credentials; local image filenames are allowed only for overrides.

### 2.6 Prices (`app.js:1490-1580`)
- DexScreener `https://api.dexscreener.com/tokens/v1/{ethereum|optimism|base|arbitrum}/{addrs}` with a 5 s timeout. Picks the pair with the most liquidity and handles the token being either base or quote.
- Overrides: `usdPriceEndpoint`, `usdPriceOverrides` (keys `chain:addr`, `addr` or symbol).
- No prices on testnets, which show "$—".
- Prices only feed the USD chart; cards never wait for them.

### 2.7 Off-chain APIs
- **Relayr:** `POST /v1/bundle/prepaid` and `GET /v1/bundle/<uuid>` (`relayr.js`). Timeouts are 45 s for POST and 15 s for GET.
- **Juicebox Center:** `POST /v1/intents/message`, `POST /v1/intents`, `GET /v1/intents/<id>`, `POST /v1/intents/<id>/deployments`, `POST /v1/intents/<id>/deploy` (`center-intents.js`).
- **Signa:** via the SDK, with issuer `https://signa.center`.

### 2.8 Browser storage, locks and caches

**localStorage**
- `sticky.boot.v1:<chain>:<deployer>`: deployment addresses
- `sticky.project.v1:<chain>:<id>`: project summary (public facts only, 30-day TTL, validated on read)
- `sticky.handle.v1:<chain>:<handle>`: handle to project id
- `sticky.history.v1:<chain>:<hook>:<id>`: hook logs up to 64 blocks below the head, ≤400 k chars (1094-1110)
- `sticky.home.v1:<env>`: home list HTML snapshot
- `sticky.ipfs.v1:<uri>`: IPFS documents
- `sticky.transactions.v1`: the transaction record, plus tombstones `sticky.transactions.v1.discarded.<id>`
- `sticky-launch-v1`: the saved launch
- `sticky:bridge:v2:<chain>:<stToken>:<group>:<owner>`: bridge recovery records, ≤100 per key
- `jb-wallet-connected`, `jb-wallet-rdns`: eager wallet reconnect

**sessionStorage**
- `sticky:center:return:v1`: route to return to after a full-page Signa sign-in
- `center.wallet.connection.v1:<issuer>:<origin>/center/callback`: Signa session, managed by the SDK

**Web Locks**
- `sticky-wallet-write`: the transaction record; exclusive, fails immediately if held
- `sticky-reward-bridge-storage`: bridge records; exclusive, waits
- `sticky-reward-bridge`: bridge actions; fails immediately if held
- `sticky-launch-write`: the saved launch

**Storage-event listeners:** the transaction-record key re-renders the recovery banner (2943); the launch key re-renders the launch UI (5413).

**In-memory caches:** chain runtimes and readers, the index (60 s TTL), deployed projects (60 s), start blocks, launch ids, siblings, ENS names, handles, logos, metadata, block timestamps, the reward clock.

### 2.9 Timers
- Position refresh every 15 s.
- Launch progress poll every 12 s (`pollStickyLaunchProgress`, 5395).
- Both pause in hidden tabs.
- Quote inputs wait 250 ms after typing (`QUOTE_SETTLE_MS`).
- Transaction receipts are polled 20 × 1.5 s.

## 3. Write flows

### 3.0 Common path
1. `guard()` (5954-5973) blocks double clicks, disables the button and shows errors inline next to it. A `NEEDS_EXTERNAL_WALLET` error gets a "Connect a wallet" action; errors during a review go to the toast.
2. `beginAction()` / `reviewAction()` (3625-3635) freeze the holder, chain and project. The action is refused if any of them changed.
3. `confirmAndRun()` (2869) snapshots `from`, `chainId` and `rpcUrl`, then calls `txEngine.prepare`.
4. `runSavedTransactions()` (2830) runs the plan.
5. `txAccount()` (194-202) throws for view-as mode, Signa accounts ("This action needs an external wallet."), the demo, or no wallet. A loopback local mode may use the `#account` field.
6. **tx-engine submit** (`tx-engine.js:304-354`):
   - Authorize, check the RPC's chain id, and check the wallet account and chain (`ensureWalletChain` switches or adds the chain, `app.js:346`).
   - Simulate with `eth_call`; an approve must return true.
   - Read the nonce floor and code, and estimate gas +30%.
   - Save the step as "submitting" before sending.
   - Send with `eth_sendTransaction`; code 4001 means rejected, any other error is "unknown".
   - Poll, then verify: the tx and receipt must be in the canonical block, the nonce must be at or above the floor, the block must be after the submission, and Safe results must bind to their proposal.
   - A reverted step can only be retried after its block is finalized.
7. Recovery: `recover(hash)`, `clear()`, `acknowledge()`, `discardUnsubmitted()` (writes a tombstone), `discardIfUnsent()`.

### 3.1 Confirm dialog (`app.js:2609-2948`; `index.html:1297-1316`)
- **Content:** eyebrow "Transaction sequence", title, summary rows, and a step list.
  - Step states: Ready for review / Cancelled in wallet / Waiting for wallet / Checking execution / Execution hash needed / Reverted and finalized / Confirmed / "Juicebox Center sends this".
  - Each step shows a chain label, contract name and address, and a label.
  - **Pretty view:** rows decoded from the calldata by `StickyCalldata.review` (FROM first; VALUE when > 0).
  - **Raw view:** CHAIN, FROM, TO, VALUE (wei and ETH), SELECTOR, FUNCTION, ARGUMENTS, CALLDATA, plus a JSON payload.
- **Copy audit prompt:** builds a full AI security-review prompt (2951-3012).
- **Warning line:** "Every row is read back from the exact data your wallet will sign…". If any step fails to decode or match: "Sending is blocked. The transaction data does not match this review." and Confirm is disabled.
- **Confirm label:** "Confirm & send", "Check transaction" (a step is uncertain), "Sign listing" (sponsored), or "Resume saved plan" (after an error).
- **Opening and closing:** the review replaces the dialog that opened it and restores it on cancel (2797-2808). Closing before anything was sent discards the plan (6237-6243).
- **Recovery box:** an "Execution transaction hash" field with "Verify execution", shown when a step is uncertain.
- **Toast:** a success with an explorer "View transaction ↗" link stays until dismissed; other messages fade after 8 s (909-929).
- **Recovery banner:** "<title>: saved transaction needs attention." with "Review saved transaction" and "Dismiss saved plan".

### 3.2 Flows

| # | Flow | Entry point | Contract calls (in order) | Notes |
|---|---|---|---|---|
| 1 | Stick | `stake()` 4671 | approve reset if nonzero, then approve exact (terminal); `JBMultiTerminal.pay(id, token, amt, beneficiary, minReturned = previewPayFor, "", 0x)` | balance check; quote failure blocks |
| 2 | Stick for someone else | `stake(true)` | same as 1 with a beneficiary | sender must be a granter, or trusted by the beneficiary |
| 3 | Unstick | `unstake()` 4874 | if auto-stick is on and this is a full exit: `setConfigFor(off)`, untrust adapter, approve 0; then `cashOutTokensOf(holder, id, count, token, minReclaimed = net quote, holder, 0x)` | preflight `eth_call`; zero return is labelled "Unstick without reclaiming tokens" |
| 4 | Transfer | `transferSticky()` 4635 | `stToken.transfer` | unlocked tokens only, 18 decimals, not to self |
| 5–6 | Trust / untrust sender | `setTrust()` 3049 | `hook.setTrustedSenderFor(id, sender, bool)` | |
| 7 | Send airdrop | `fundRewards()` 4093 | approve(s) to distributor; `distributor.fund(stToken, token, amt, groupId)`, with value for ETH | `isValidGroupId` pre-check |
| 8 | Collect / start vesting | `claimReward()` 4130 | `collectVestedRewards(stToken, group, [holder], [token], holder)` | refuses an empty allocation; FORFEIT row for tenure groups |
| 9 | Claim & stick | `claimAndStick()` 4549 | approve exact; trust adapter if needed; `adapter.stickRewardsFor(id, groupIds)` | mint estimate only when the adapter can already pay |
| 10 | Turn on / renew auto-stick | `saveAutoStick()` 4423 | disable first if already on; approve (unlimited or cap, exact); trust if needed; `setConfigFor(on, min, cooldown)` last | cooldown 1–30 days; min fits uint128 |
| 11 | Auto-stick settings | same, settings mode | `setConfigFor` | |
| 12 | Turn off auto-stick | `toggleAutoStick()` | `asDisableTxs` | |
| 13 | Repair permission / renew allowance | `repairAutoStick()` | `setTrustedSenderFor(adapter, true)`, or reopens the enable dialog | |
| 14 | Stick ready rewards now | `autoStickNow()` 4489 | `adapter.compoundFor(id, holder, groupIds)` | |
| 15 | Start unlocking | `beginAutoStickVesting()` 4519 | `adapter.beginVestingFor(id, holder, groupIds)` | |
| 16 | Create reward address | `createRewardAddress()` 4064 | `factory.deployReceiverFor(stToken, groupId)` | preflight |
| 17 | Settle arrivals / settle into airdrops | `settleArrivals()` 4591 | `factory.settleFor(stToken, groupId, token)` | ERC-20 only; factory's distributor must match |
| 18 | Bridge: queue | `prepareBridgeFunding()` 3480 | source token approve(s) to sucker; `sucker.prepare(count, beneficiary, minBacking, token, metadata)` | sessionTag `sticky-bridge:<metadata>`; 1% slippage |
| 19 | Bridge: send across chains | `actOnBridgeMovement` → `flush` | `sucker.toRemote(token)` with value = fee + simulated budget | |
| 20 | Bridge: claim | `claim` | destination `sucker.claim(claimData)` | proof re-checked |
| 21 | Launch: direct (one chain) | `deployStreaks` → `prepareStickyLaunch()` 4973 | `StickyDeployer.deployStickyFor(token, name, symbol, uri, taxBps, granters+AutoStick, soulbound)`, value = creation fee | |
| 22 | Launch: Relayr (several chains) | same | POST bundle; choose payment chain; `Relayr.prepayment(bytes16 bundle, uint40 deadline)` with value | |
| 23 | Launch: Center-sponsored | same | `personal_sign` of Center's message; Center deploys via the ERC-2771 forwarder | only when every chain is sponsored (not chain 1) and the deployer trusts the forwarder. Today's deployer does not, so this path is dormant |

The Center listing signature (`signListing`, 5092) is also a pre-step in flows 21 and 22. If Center refuses or can't be reached, the launch still goes ahead unlisted, with a retry offered.

### 3.3 Launch details
- **Create dialog** (`index.html:1108-1175`; `app.js:6036-6218`):
  - Token field accepts an address, a project ID (`5`) or a chain-prefixed ID (`base:5`); aliases at 6043-6046.
  - Custom name and symbol (defaults "Sticky <name>" / `STICKY<SYM>`).
  - Bonus presets 0/5/10/25% (default 10 when enabled) or custom 0–99.99.
  - Extras: trusted senders.
  - TRANSFERS Locked / Unlocked (default Unlocked).
  - DEPLOY: Production / Testnets plus chain checkboxes. A chain is blocked with "not deployed" or "no auto-stick helper".
- **Checks** (`loadStickyRuntime`): each chain's RPC chain id, code at the deployer and its dependencies, the creation fee, and that the adapter matches the deployer, hook and distributor. The token must match (name, symbol, decimals) on every chain.
- **Listing plan** (`launchListingPlan`, 5056): contract accounts other than 7702-delegated wallets can't list.
- **Launch dialog:** progress steps, a funding picker, the error line, a "Recover a destination transaction" hash box, and a view of the saved calls. Buttons: Discard draft / Done, Check progress, List on Juicebox Center, Launch it yourself, Continue launch.
- **Banner:** "<SYM>: N of M chains confirmed."

### 3.4 Wallet options
- **Browser wallets:** EIP-6963 discovery with a `window.ethereum` fallback (5418-5543).
  - Connect: `wallet_requestPermissions`, then `eth_requestAccounts`.
  - Disconnect: `wallet_revokePermissions`.
  - Handles accountsChanged, chainChanged and disconnect.
- **Chooser** (`wallet-chooser.js`, `openWalletChooser` at 5742):
  - A Signa passkey button labelled with the device (Face ID, Touch ID, Windows Hello or Device), shown only when `centerWallet` is set.
  - "or connect a wallet" icon tiles (only `data:` icons are shown).
  - "View as an address".
  - The Signa iframe gets `allow="publickey-credentials-get <issuer>; publickey-credentials-create <issuer>"` and exchanges postMessages `juicebox-center:size`, `:theme` (sends `--jb-connect-*` tokens) and `:page`.
- **Signa accounts** are read-only (chain 8453). A full-page sign-in goes through `/center/callback` (`center-callback.js`): the code is scrubbed from the address bar first, the result is handed to the opener or frame, or completed on that page and returned to the saved route.
- **Wallet menu** (5777-5808): balances (ETH, underlying, Sticky) when a project is in view, Account, Copy address, Disconnect, View as / Exit View as.
- **Connect button:** "Sign in" / "Signed in" plus ENS name or short address / "Viewing as 0x…".

## 4. Configuration

### 4.1 `window.STICKY_CONFIG`
**Generated** (`build-config.py:182-194`):
- Top level: `rpcUrl`, `deployer`, `distributor`, `rewardReceiverFactory`, `autoStickAdapter`, `fromBlock` (all copied from the default chain), `defaultChainId`, `demoMode`, `projectId`
- `chains{"<id>":{rpcUrl, deployer?, distributor?, rewardReceiverFactory?, autoStickAdapter?, fromBlock}}`
- `ensRpc`, `relayrUrl`, `bendystrawUrl`, `testnetBendystrawUrl`
- `centerWallet`: null or `{issuer, audience, manifest:{id, revision}, maximumNetworkFee}`
- `centerUrl`

**Hand-written or dev only:**
- `localMode` (with `account`)
- `usdPriceEndpoint`
- `chains[id].bridgeContracts`, `chains[id].bridgeFromBlock`
- Fixtures removed unless demo or loopback local mode (`runtime.js:38-45`): `demoHomeStickiest`, `demoHomeAirdrops`, `demoChartHistory`, `usdPriceOverrides`, `logoOverrides`, `projectNameOverrides`, `projectChainOverrides`

`StickyRuntime.deployment()` (`runtime.js:26-36`) only falls back to the top-level values for the default chain.

### 4.2 Environment variables (`build-config.py`)
- `STICKY_DEFAULT_CHAIN` (default 1), `STICKY_DEMO`
- `NEXT_PUBLIC_DWELLIR_API_KEY` or `STICKY_DWELLIR_API_KEY`; `STICKY_RPC_<id>`; `STICKY_ENS_RPC`
- `STICKY_{DEPLOYER|DISTRIBUTOR|REWARD_RECEIVER_FACTORY|AUTOSTICK_ADAPTER}[_<id>]`
- `STICKY_FROM_BLOCK[_<id>]`, `STICKY_PROJECT_ID`
- `STICKY_RELAYR_URL`, `STICKY_CENTER_URL` (HTTPS origin only)
- `NEXT_PUBLIC_BENDYSTRAW_URL`, `NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL`
- `STICKY_CENTER_WALLET_{ENABLED, ISSUER, AUDIENCE, MANIFEST_ID, MANIFEST_REVISION, MAXIMUM_NETWORK_FEE_WEI}`. Over HTTPS the issuer and audience must be `https://signa.center` and `https://api.signa.center`.
- Server side: `PORT`, `RAILWAY_GIT_COMMIT_SHA`

Validation: a live build requires a deployer on the default chain. Invalid values fail without echoing secrets. The file is written atomically with mode 0644.

### 4.3 `deployments.json`
- Shape: `{"<chainId>": {deployer, distributor, rewardReceiverFactory, autoStickAdapter, fromBlock}}` for 8 chains, with the same addresses on every chain:
  - deployer 0xdA38…33a9
  - distributor 0xc62b…1Bb8
  - receiver factory 0x41AE…A737
  - adapter 0x9B09…18C5
- Generated from `../deployments/*/verified.json`; `fromBlock` is the StickyDeployer receipt block.
- Checked in CI; the `deploy:post:*` npm scripts regenerate it.

### 4.4 Chains (`ORIGINS`, `app.js:3081-3090`)
- Production: 1, 10, 8453, 42161. Testnet: 11155111, 11155420, 84532, 421614. Each entry has a key, label, name, icon, public RPC and explorer.
- The fallback RPCs are tested to match `build-config.py` `PUBLIC_RPC`.
- Relayr payment chains come in the same two families.
- Center sponsors every chain except 1.

## 5. `serve.py`
- **Static files:** an explicit `PUBLIC_ASSETS` allowlist (19-26). No symlinks, no directory listings, and no compressed variants that weren't reviewed (307-315). `/` serves `index.html`. Only GET and HEAD, otherwise 405.
- **Cache headers:** `config.js` and the callback page are `no-store`; html, js and txt are `no-cache`; images `max-age=86400, public`. ETag and Range are supported.
- **Page headers** (32-52): `nosniff`, `X-Frame-Options: DENY`, and CSP `script-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'none'`.
  - With Signa on: `form-action <issuer>` and `Referrer-Policy: strict-origin`, otherwise `no-referrer`.
  - There is deliberately no `connect-src` or `default-src`.
  - The callback page gets `X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'` and `form-action 'none'`.
- **`/center/callback`:** served only when a valid issuer is configured; `/center-callback.html` itself returns 404.
- **`/healthz`:** `{"ok", "mode": "demo"|"live", "revision"}`, returning 503 when not ready. Ready means `config.js` and `index.html` are present and parse, a live config has a deployer, every script is allowlisted, the registry is valid, and Signa's files are present when Signa is on.
- **Startup:** refuses to start when `PORT` is set and the app isn't ready. Binds `0.0.0.0` when `PORT` is set, otherwise `127.0.0.1:8788`. Waitress runs 8 threads, 100 connections, a 30 s channel timeout, 8 KB request bodies and 16 KB headers.
- **Bendystraw relay** (108-298):
  - POST only, `application/json`, body up to 8 KB.
  - The body must be exactly `{operation, variables}` with an operation id from the registry.
  - Variables must fit their declared types: strings ≤1024, lists ≤100, objects ≤32 fields, depth ≤3.
  - Upstream is `<url>/graphql` with an 8 s timeout, responses ≤8 MB, and a system CA fallback.
  - Answers are cached 15 s, keyed on (network, operation, sorted variables), with at most 256 entries.
  - Status codes: 400 unknown or invalid, 404 not configured, 502 upstream failure.

## 6. Tests (the port's acceptance criteria)

Run with `node --test webclient/test/*.test.cjs` and `python -m unittest discover -s webclient/test -p 'test_*.py'`. CI (`.github/workflows/webclient.yml`) also runs:
- `--check-deployments` and `bendystraw-registry.py --check`
- `node --check` on all scripts
- `vendor/build.sh --check`
- a demo build and a live 8-chain build
- a live server smoke test: healthz reports live, the callback sends `SAMEORIGIN`, and the relay answers 400 to an arbitrary query

Many `.cjs` tests cut functions out of `app.js` by name. The module tests carry over more easily.

**Module tests:**
- **runtime:** asset URL XSS guards; the default deployment never enables an unconfigured chain; fixtures stripped on live pages; RPC error shapes and 413; stated-range splitting; no partial history; batching and fallback; bounded parallel bisection; strict ABI decoding.
- **calldata (+ fixtures from `cast calldata`):** selectors equal keccak; every write decodes; every `fn:` in `app.js` and `bridge.js` is registered; non-canonical encodings refused; tampered or hidden or extra arguments blocked; formatters; launch and Relayr builders.
- **tx-engine:** frozen bytes; saved before submit; gas +30%; cancel, rejection, unknown outcome and timeout without resending; account or chain mismatch; storage failure fails closed; cross-tab lock; launch records protected; approve returning false caught; tombstones; discardIfUnsent.
- **tx-engine-safety:** receipt evidence mismatches never complete or resend; wrong-chain RPC; a disappeared receipt goes back to pending; retry only after finalized revert; Safe proposal binding; discard re-checks finality.
- **tx-engine-adversarial:** a Safe proposal with identical calldata can't complete another; outer-replacement binding; finalized EOA revert recovery.
- **tx-safe:** exact Safe `execTransaction` decode; single outcome event; offset and padding attacks; no throwing on bad input.
- **relayr:** keccak vectors; network families and virtual nonces; bundle saved before POST; UUID kept; binding rejects any changed request; payment parse and expiry; pinned runtime and simulation; deployment receipt checks (DeploySticky plus Create); Safe and forwarder paths.
- **launch-session:** post once; bind before choice; pay once; recovery after reload; candidate hashes; reorg downgrade; Center publish, record, wait and unlisted; sponsored deploy and self-pay fallback; stored-state validation.
- **launch-plan:** bonus presets and custom range; default names; sender parsing; AutoStick always the last granter; token input parsing; cross-chain project token resolution; same-token check.
- **center-intents:** envelope format, sorting and no value; content hash vector; sign only an exact echo; error codes; record waits for 2 confirmations; sponsored plan rules and forwarder constants.
- **center-callback:** safe return route; opener/frame handoff; full-page completion; scrub before load; vendored bundle sha256 matches its header.
- **wallet-chooser:** device labels; Signa first then tiles; `data:` icons only; pending and error copy; frame `allow`; theme messages go only to the issuer; close cancels.
- **bridge:** Merkle empty root; proofs; net minimum and 1% slippage; discovery; route rejections; environment never mixed; receiver prediction per group; prepare, approve and reset; movement rebuild and rejections; claim; transport budgets for CCIP, native and Arbitrum; terminal migration; incomplete history blocks prepare.
- **route-boot:** route kinds; boot script first in `<head>` and external; single script cache version; CSS view switch; summary cache round-trip, validation and TTL; handles; cached paint then replace; never home before the chain loads; meta-row labels and order.

**App tests:**
- **actions:** amount parsing; mint and unstick quotes, including the exact dialog copy "You get 1.95 ART. 0.5 ART stays…"; tranche paging (1M entries); pool backing and orphan rules; approval reset; frozen review; stake, grant, unstake and full-exit teardown; ETH funding; group encoding and labels; per-group claims and settlement; tenure stake math; earned-rewards cap; reward copy dates ("Oct 16") with no "soon" or "—"; stick refused before verification; quote debounce.
- **bendystraw:** index parsing; errors fall back; events per chain and version; home without history scans; tail-scan discovery; zero state only when truly empty; creation block from Bendystraw verified by receipt, else binary search.
- **home-states:** loading, empty, error and ready semantics and exact notes; chain links; merge and grouping; retry; no global pill; ready stays ready on revisit.
- **project-page:** holder rows from events; pinned-block ages; page re-read; sibling discovery by launchId, tax and soulbound; totals; dialog replacement; one scan per view; history cache with reorg depth.
- **feed-amounts:** feed shows underlying amounts via terminal Pay and CashOut matching; transfers show Sticky counts; "Stuck" means underlying everywhere; same-transaction streak merge.
- **chart-backing:** backing-series rebuild (flows, fees, orphans, zero clamp); chart labels in the underlying token; supply fallback.
- **view-races:** stale handle, project, home, reward and auto-stick loads can't overwrite the current view.
- **boot-cache:** saved deployment starts at once; a mismatch stops the page and forgets it.
- **bridge-wallet:** saved bridge records under account changes, cancel, unknown outcome, crash and 100-record limit; donor-copy guard; merges under the lock.
- **daybreak-bridge-project-race:** navigation during a bridge quote stops before review.
- **tx-adapter:** view-as, demo and Signa can't send; `NEEDS_EXTERNAL_WALLET` offers Connect; guard behaviour; sender and RPC snapshot; onPrepared ordering.
- **tx-status:** confirmation link sticks until dismissed; other messages fade after 8 s.
- **launch-listing:** self-paid today; sponsored when trusted; contract vs 7702 wallets; no Center URL; chain blockers.
- **launch-wallet:** closing a payment review keeps pending state; a missing record blocks; wrong account is refused.
- **review-copy:** "N transactions left"; hex-only breaking; title-preserving addresses; no em dash in launch copy.
- **ens:** ENS and handles on production chains only.
- **format:** juicebox.money amount rules; "0d"; "now".
- **metadata-rendering:** token symbols are escaped in the bonus illustration.

**Python tests:**
- **test_production.py:** config builder validation; deployments match records; the app's RPC list matches `PUBLIC_RPC`; the server's types, headers, cache rules, traversal and symlink denial, healthz, readiness, 405s, the relay allow/reject matrix and 502s; Signa CSP and callback headers; the registry is not stale.
- **test_accessibility.py:** every control and dialog has an accessible name; preset buttons are native with `aria-pressed`; no inline handlers or scripts.

## 7. Assets and design tokens
- **Fonts:** `Beatrice-Regular.woff2` (400), `Beatrice-Medium.woff2` (500–700), `PPAgrandir-WideBold.woff2` (700, headings and tabs) (`index.html:22-33`).
- **Images:**
  - `drip-corner.png`: brand and favicon
  - `drip-round.png`: overscroll drip
  - `hero-donut.png`: hero image
  - `hero.png`: og/twitter image
  - `jar.png`, `cone.png`, `juicebox.png`: explainer images, also used as demo logos
  - `artizen.jpg`, `banny.png`, `donut.png`: demo logos only
  - `drip-wide.png`, `goo.png`, `goo2.png`: served but never referenced
- **Tokens** (`:root`, 34-38): `--bg #f0f7f9`, `--card #f8fcfd`, `--line #d8e7eb`, `--text #1c2d33`, `--muted #57727c`, `--accent #0e7c91`, `--amber #2fb3c7`, `--ink #1c2d33`, `--teal #7fd4e0`, `--err`/`--out #b34a35`, `--top-fold-height 50px`.
- **Signa theme tokens** (719-720): `--jb-connect-bg`, `-fg`, `-muted`, `-line`, `-accent`, `-accent-fg`, `-radius 8px`, `-pad 32px`.
- **Chart colours:** `#2fb3c7` active sticks, `#1c2d33` stuck, `#e2d7bd` fee. Chain icons are inline SVG (`CHAIN_ICON_SVG`, 3075).
- **Breakpoints:** 480, 520, 560, 639, 640–767, 768–1279, 820/821. `prefers-reduced-motion` turns off the pulse and sweep animations.
- All styles live inline in `index.html` (21-751); `center-callback.html:8-22` has its own.

## 8. Copy and UX rules visible in comments and tests
- **Vocabulary** (`STYLE_GUIDE.md`, `llms.txt`): Stick / Unstick, Sticky shares, backing, tranche, streak, "stickiness bonus" (the cash out tax), Airdrops.
- **"Stuck" means underlying backing, never Sticky supply** (2435, 2559). Sticky counts keep the Sticky symbol.
- **Amounts** follow juicebox.money's `formatTokenAmount` (411-419): grouped, at most 4 decimals, a tiny amount shows its first significant figure. Inputs and review rows use full precision.
- **Layouts copied from juicebox.money:** activity rows ("ActivityList", 113, 1388), project tabs (452), phone home tabs (316), signed-in button (5809).
- **Text breaking:** review values wrap at spaces and only hex breaks (2642). Details values never wrap mid-word (184). Meta-row pipes are clipped at the start of a line (136-141). Tables scroll sideways (521). Fields are sized to what they hold (515).
- **Dialogs never stack** (2797, 5741). A linked confirmation stays until dismissed (925). Each view draws its own placeholders; there's no global loading pill. Restored values show faded with a sweep (391-392).
- **Words to avoid:** no "—" or "·" in the home steps; no "soon" or "—" in reward copy; no em dashes in launch review rows; "N transactions left", never "remain".
- **Plain-words error mapping:** Center refusals (5075-5082) and Center waiting codes (`launch-session.js:65-71`).
- Every review row is read back from the calldata, and the review names the decoded group ("Everyone", "Staked N+ weeks", "Staked N–M weeks"), never the raw number.
- The Stick button stays closed until the project is verified; nothing is stuck from a cached summary (2310).

## 9. Gotchas for the port
- **Dead code:** `SEL.mint` and `SEL.beginVesting` are unused (distributor `beginVesting` is registered in `calldata.js` but never built); `TOPIC.Transfer` is unused; `#connection-dialog` never opens; `window.stickNowFor` is a global hook.
- **Account page is single-chain:** it reads only the page chain.
- **Demo mode** (6381-6616) is a complete fixture RPC. Decide whether to keep it.
- **CSP:** `script-src 'self'` with no inline scripts means Next.js needs nonces or hashes. `route-boot` must still run before paint.
- **Hash-route deep links** (`llms.txt` and shared links) need a compatibility layer if the port moves to path routes.
- **Multi-tab behaviour** depends on Web Locks and the storage event; keep both.
