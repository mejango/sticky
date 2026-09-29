# Juicebox Money architecture map (port reference, 2026-09-29)

How jbm (webclients/juicebox-money @ 68e1e88), revnet-money and Homerun are built, for the Sticky Next port to copy.

## Summary

**Layout** (JBM = `/Users/jango/Documents/jb/v6/evm/webclients/juicebox-money`)
- **Stack:** Next 16.3.3 App Router built with webpack, React 19.2.8, wagmi 3.7.6, viem 2.55.19, react-query 5.101.4, Tailwind 4.3.3.
- **JB SDK:** only `@bananapus/nana-sdk-core` ^2.12.2. No juice-sdk-react.
- **Wallets:** Para 3.15, browser wallets (EIP-6963 discovery), WalletConnect, Coinbase and Safe.
- **Tooling:** vitest 4 and Playwright 1.62 on Node 26.7.0 with npm 12.0.1.
- **Code:** `src/app` holds routes and `api/`. The rest is `src/components` (`project/`, `account/`, `create/`, `ui/`), `src/hooks`, `src/lib`, `src/providers` and `src/proxy.ts`.
- **Shipping:** it runs as a standalone Docker image on Railway.

**10 modules a Sticky Next app should copy or import** (jbm paths unless marked HR = `/Users/jango/Documents/jb/v6/evm/extensions/homerun`):
1. **Build and deploy shell:** package.json pins, .nvmrc, .npmrc, next.config.js, Dockerfile, railway.json, scripts/start-production.mjs, scripts/check-deployment-env.mjs and `api/healthz`.
2. **Wallet:** providers/Providers.tsx (`wagmiConfig`), lazy-connector.ts, wallet-connectors.ts and hooks/useWallet.ts. Signa is in neither jbm nor revnet. Take it from HR providers/lazy-center-connector.ts, center-runtime.ts and app/center/callback.
3. **RPC:** lib/jbcenter-rpc.ts, lib/jbcenter-config.ts, lib/chains.ts, plus HR's `jbCenterPublicClient`.
4. **Bendystraw proxy:** `api/bendystraw/[net]/query/route.ts`, the `lib/bendystraw*.ts` files, the registry JSON and scripts/check-bendystraw-schema.mjs.
5. **Query cache:** lib/query-persist.ts, ui/Revalidating.tsx and lib/api-cache.ts.
6. **Write engine:** hooks/useSafeTx.ts, lib/contract-write.ts, lib/transaction-review.ts, lib/transaction-simulation.ts, and TransactionReviewProvider.tsx with TransactionReviewDialog.tsx.
7. **Confirm UI:** ui/TxConfirmDialog.tsx, TxSteps.tsx, TxError.tsx and ModalShell.tsx.
8. **Multichain:** lib/relayr.ts, launch-relayr.ts, launch-session.ts, safe-connector.ts and safe-batch-connector.ts.
9. **Activity feed:** ActivityList.tsx, FreshActivity.tsx and ActivityMeta.tsx.
10. **Pages and design:** app/layout.tsx (fonts), project/Tabs.tsx, the account page, DESIGN.md, tailwind.config.mjs and globals.css.

**Import rather than copy:**
- nana-sdk-core already carries the Sticky ABIs, addresses and Sticky helpers.
- `@bananapus/nana-sdk-connect` provides Signa sign-in.

**Head start:** Homerun already has working Sticky stake, unstake and reward reads and writes in lib/sticky-contracts.ts, lib/sticky-state.ts and components/StickyHolder.tsx.

**How jbm and revnet-money share code:** they don't share a package or a monorepo.
- They are separate repos. The only shared code is the npm SDK.
- Everything else is copied and adapted by hand and kept in step by convention. Code comments like "Kept identical to revnet-money's copy" mark this, and the memory rule says wallet primitives land in both in the same change.
- Of 77 files at the same path under `src/`, only `lib/protocol-rollout.json` is byte-identical. It is generated from the same deploy records in both repos.
- Of 16 files I sampled, 5 differ only in formatting and 11 have drifted apart.

---

# Juicebox Money (jbm) architecture map for the Sticky Next.js port

Roots (read-only inspection, 2026-09-29):
- **JBM** = /Users/jango/Documents/jb/v6/evm/webclients/juicebox-money (github.com/mejango/juicebox-money, main @ 68e1e88)
- **REV** = /Users/jango/Documents/jb/v6/evm/webclients/revnet-money (github.com/mejango/revnet-money, upstream rev-net/revnet-app, main @ 19c33af3)
- **HR** = /Users/jango/Documents/jb/v6/evm/extensions/homerun (a Next app that copies jbm and adds Signa and Sticky)
- **STK** = /Users/jango/Documents/jb/v6/evm/extensions/sticky (the current vanilla client lives in STK/webclient)

Paths that start with `src/`, `scripts/` or `test/` are under JBM.

## 1. Stack, versions, toolchain and scripts

**Runtime dependencies** (JBM/package.json):

| Package | Version | Notes |
|---|---|---|
| next | 16.3.3 | Always run with `--webpack` |
| react, react-dom | 19.2.8 | |
| wagmi | 3.7.6 | |
| @wagmi/core | 3.6.4 | |
| viem | 2.55.19 | |
| @tanstack/react-query | 5.101.4 | |
| @bananapus/nana-sdk-core | ^2.12.2 | The only JB SDK. No juice-sdk-react or nana-sdk-react. |
| @getpara/react-sdk-lite, web-sdk, wagmi-v2-connector, react-component-library | 3.15.0 | Para embedded wallet |
| @safe-global/safe-apps-sdk | 9.1.0 | |
| @safe-global/safe-apps-provider | 0.18.6 | |
| @walletconnect/ethereum-provider | 2.23.10 | |
| @coinbase/wallet-sdk | 4.3.7 | |
| dompurify, marked | 3.4.14, 18.0.10 | Rich text |
| qrcode | 1.5.4 | WalletConnect QR code |
| sharp | 0.35.4 | Social preview images |

**Dev dependencies:**
- **Styling:** tailwindcss 4.3.3 with @tailwindcss/postcss 4.3.3.
- **Unit tests:** vitest ^4.1.9 with @vitest/coverage-v8, jsdom 29.1.1 and react-test-renderer 19.2.8. jbm has no Testing Library.
- **Browser tests:** @playwright/test ^1.62.1 with @axe-core/playwright.
- **Lint:** eslint 10.7.0 with eslint-config-next 16.3.3 and @eslint/compat.
- **Other:** knip 6.29.0, graphql 17.0.2 and tsx.
- **TypeScript:** `typescript` is 5.9.3. Next and eslint use it as the compiler API. The `tsc` command comes from `@typescript/native` (TypeScript 7.0.2): `node_modules/.bin/tsc` points there. graphql also ends up in the app bundle, because the Bendystraw operation compiler runs in the browser too.

**Install policy:**
- `overrides` pin ws, axios, nanoid, bn.js, sharp and postcss.
- An `allowScripts` allowlist works together with `.npmrc strict-allow-scripts=true`.

**Node and npm:**
- JBM pins Node 26.7.0 (`.nvmrc`), `engines` node 26.7.x and npm 12.0.x, and `packageManager` npm@12.0.1.
- `.npmrc` sets `node-options=--no-experimental-webstorage`. Node 20 refuses this flag, so use Node 26.
- The Dockerfile base is `node:26.7.0-bookworm-slim@sha256:cd56…` plus a global install of npm 12.0.1.
- REV pins Node 26.5.0, uses prettier, and points `typescript` at the TypeScript 6 compatibility package.

**Scripts:**
- **Run:**
  - `dev` runs `next dev --webpack --port 3001`.
  - `build` runs `next build --webpack`.
  - `start` runs `node scripts/start-standalone.mjs`, which copies static files and `public/` into the standalone folder, then starts `server.js`.
- **Quality checks:**
  - `lint` runs `eslint . --max-warnings=0 --no-cache`.
  - `ts:check` runs `next typegen && tsc --noEmit`.
  - `test` runs `vitest run`; `test:ci` and `test:coverage` add coverage.
  - `dead-code:check` runs knip.
  - `source:check` bans the `viem/chains` import and `any`, and requires the ESM Tailwind config.
- **Browser and bundle:**
  - `build:browser` makes a production build against local fixtures.
  - `test:browser` runs `node scripts/with-browser-env.mjs playwright test`.
  - `budget` checks gzip bundle sizes.
- **Dependencies and environment:**
  - `deps:check` runs `npm ls --all --omit=dev`.
  - `audit:prod`, `env:check:build`, `env:check:all` and `container:check`.
- **Protocol and data:**
  - `protocol:check` and `protocol:generate`.
  - `schema:check` validates against live Bendystraw, and `schema:check:offline` only checks the registry is current.
  - `bendystraw:registry` rewrites the registry.
  - `transaction:check` checks the list of wallet-write sites.
- **Full sequences:**
  - `check` runs everything in order: deps, knip, audit, container, lint, ts, source, protocol, schema, transaction, test:ci, build:browser, budget, test:browser.
  - `check:deploy` adds `env:check:all`.

**Stale docs:**
- TESTING.md says `typescript` is the TS6 compatibility package. That is true only for REV.
- docs/adr/0001 says Next 16.2 with React 18. The repo is on 16.3.3 with React 19.2.8.

## 2. Directory layout (JBM/src)

**`app/` (App Router routes)**
- `layout.tsx`: root layout.
- `page.tsx`: home. It revalidates every 120 s and streams sections behind Suspense.
- Framework files: `globals.css`, `error.tsx`, `global-error.tsx`, `not-found.tsx`, `robots.ts`, `sitemap.ts` and `llms.txt/route.ts`.
- `[urn]/page.tsx`: the project page, at `/eth:1` or `/@handle`.
  - `[urn]/loading.tsx` is its loading state.
  - `[urn]/[...rest]/page.tsx` redirects older-version paths to old.juicebox.money.
- `account/[address]/page.tsx` (+ loading state).
- `create/`, `build/`, `build/first-payment/`, `learn/` and `audit/`.
- `ipfs-proof/` and `modal-proof/` are `page.browsertest.tsx` files. They are compiled only when `NEXT_PUBLIC_DETERMINISTIC_BROWSER=true`.
- `api/` route handlers:
  - `bendystraw/[net]/query` (POST proxy, see §4)
  - `activity`, `participants`, `price-history`, `top-projects`, `auto-issuances`, `loans`, `movements`, `search`, `shop-customers`
  - `project-name`, `project-ready`
  - `project-og/[chainId]/[projectId]` (social preview image, uses sharp)
  - `healthz`

**`proxy.ts`**
- Next 16 calls middleware "proxy".
- Any path whose first segment isn't one of the app's own routes gets a 307 redirect to old.juicebox.money.

**`components/`**
- **Top level:** ActivityList, FreshActivity, ActivityMeta, ActorLink, ChainIcon, ChainSelect, SearchBox, SiteNavigation, SiteFooter, WalletButton, ViewAsForm, TransactionReviewProvider and TransactionReviewDialog, ProjectLogo*, ProjectLink, RichContent, LoadingSkeletons, SafeBadge, TreasuryCard, TopProjectRows, HomepageDiscoveryLayout.
- **`project/`** (about 70 files): tabs, cards, write flows, Safe batch UI and charts.
- **`account/`**: 8 files.
- **`create/`**: CreateForm, its editors and draft handling.
- **`ui/`**: ModalShell, TxConfirmDialog, TxSteps, TxError, Revalidating, Skeleton, AddressLabel and AddressLink, ChainPicker, ChainPillButton, DateTimeField, QuantityStepper, PerChainAddress*Field.

**`hooks/`**
- useWallet, useSafeTx, useViewedAccount, useReviewedPermit2Signature.
- useTokenBalance(s), useProjectTokenSymbol, useProjectTokenUnit.
- useEnsName, useInfiniteScroll, useOutsideClose, useMobileWallet, useCashOutFloor, useShop721.

**`lib/`** (about 110 modules, mostly framework-free)
- **Data:** bendystraw*, api-cache, api-params, query-persist, project-fallback, project-metadata*, top-projects, trending, new-projects, homepage-reserves, suckers-queries, loans-queries, lp-positions-queries, shop-read, ens.
- **Chains:**
  - chains, chainDisplay, urn.
  - contracts (`addrOf`), protocol-rollout.ts and protocol-rollout.json.
  - jbcenter-config, jbcenter-rpc, jbcenter-ipfs.
- **Transactions:**
  - Core path: contract-write, transaction-review, transaction-simulation, transaction-builders, gas, receipt, errors, viewAs.
  - Wallet plumbing: wallet-core, wallet-list.
  - Multichain and Safe: relayr*, launch*, payer-relayr, authority, cross-chain-authority, project-batch, forwarder-authorization, safe*.
  - Swaps: permit2-swap, direct-pay-swap.
- **Domain logic:** cashOut, loanFees, market-liquidity, uniswap-v4, price-series, sticky, sticky-check, splits.
- **Content:** learn-guide, build-guide, audit-prompt.

**`providers/`**
- Providers.tsx builds the provider tree and exports `wagmiConfig`.
- Wallet connector factories, the Para host, sign-in sheet, session and on-ramp files, SignInShell and SignInPlaceholder, and ProjectRouteContext.

**Other folders in `src/`**
- `assets/`: brand and chain SVGs and illustration PNGs, imported statically.
- `vendor/HeartbeatWorker.js`.

**Outside `src/`**
- `public/`: fonts (woff2), assets, `manifest.json` (the Safe app manifest) and examples.
- `scripts/`: gates and start scripts.
- `test/`.
- `docs/`: bendystraw-data-policy, relayr-journeys, protocol-rollout, deployment-validation and adr/.
- `tasks/`.

## 3. Providers and wallet stack

**src/providers/Providers.tsx**
- `wagmiConfig = createConfig({...})` with these settings:
  - `chains`: `SUPPORTED_CHAINS`.
  - `transports`: one `jbCenterRpcTransport(id)` per chain, 8 in total.
  - `connectors`: `injected({shimDisconnect: true})`, `lazyParaConnector()`, then `...externalWalletConnectors()`.
  - `multiInjectedProviderDiscovery: true` for EIP-6963, and `ssr: true`.
  - In deterministic browser mode there are no connectors and no reconnect.
- Provider tree, outermost first: `QueryClientProvider`, `WagmiProvider` (reconnect on mount), `ParaAuthContext`, `ProjectRouteProvider`, `TransactionReviewProvider`.
- The Para modal host is a lazily loaded sibling, not a wrapper. A `ParaProvider` wrapper kills server rendering.

**src/lib/chains.ts**
- `SUPPORTED_CHAINS` is mainnet, optimism, base and arbitrum, plus sepolia and the three L2 sepolias.
- They come from `@bananapus/nana-sdk-core/chains`. `source:check` bans importing `viem/chains`.

**Connectors**
- **src/providers/lazy-connector.ts:** `lazyConnector({id, name, type, load, shouldRestore})` is a stable wagmi connector whose vendor SDK is imported on first use.
  - `shouldRestore` gates wagmi's startup reconnect probe. `wasRecentConnector` reads `wagmi.recentConnectorId` to decide.
  - This keeps vendor SDKs off anonymous page loads, and the bundle-size gate enforces it.
- **src/providers/wallet-connectors.ts:**
  - WalletConnect loads only when `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` is set. It uses `showQrModal: false`; the app draws its own QR from `display_uri`.
  - Coinbase Wallet SDK.
  - Safe restores only when the page is framed, with `allowedDomains` app.safe.global and app.5afe.dev.

**Para (embedded email, phone and social wallet)**
- **lazy-para-connector.ts**
- **para-config.ts:** the `getParaClient()` singleton, the on-ramp provider and the portal theme.
- **ParaAuthContext.tsx:** the session marker `juicebox.para-session`.
- **para-session.ts**
- **ParaModalHost.tsx:** hosts Para inside a native modal dialog, so Para works on top of app modals.
- **ParaAuthSheet.tsx:** the one sign-in chooser. It offers email or phone, OAuth, browser wallets, the WalletConnect QR, mobile deep links and View-as.
- **SignInShell.tsx and SignInPlaceholder.tsx:** shown while Para is still loading.
- **preload-para.ts:** loads Para when the browser is idle, but not on save-data or 2G connections.
- **OnRampHandoff.tsx and on-ramp-window.ts:** Para's headless on-ramp. The popup opens inside the click handler so browsers don't block it.

**Wallet hooks and helpers**
- **src/hooks/useWallet.ts**
  - Returns `{isConnected, address, connectors, connectWith(id), openSignIn(), disconnect()}`.
  - Also connects a settled Para session to wagmi's `para` connector.
- **src/lib/wallet-list.ts:** `offerableWallets` removes duplicate wallets from the list.
- **src/lib/wallet-core.ts**
  - `publicClient(chainId)`.
  - `connectedWallet(chainId, {expected, requireUnchanged})`, which switches chain and errors if the account changed.
- **src/components/WalletButton.tsx:** the account menu, with balances, View-as and a link to `/account/<address>`.

**Safe app support**
- Setup:
  - Uses the Safe connector above.
  - The page CSP allows framing by app.safe.global and app.5afe.dev.
  - `/manifest.json` is served with `Access-Control-Allow-Origin: *`.
  - Icon: public/assets/juicebox-safe-icon.svg.
- **src/lib/safe-connector.ts**
  - `isSafeConnection`.
  - `SAFE_PREFIX` lists chains with Safe app links. `SAFE_SERVICE_PREFIX` lists chains with a hosted Safe transaction service. The split is deliberate.
  - `waitForSafeExecutionHash` and `swapDeadline`.
- **src/lib/safe-batch-connector.ts:** `proposeSafeBatch` is the single raw `wallet_sendCalls` call site. The Safe app turns it into one MultiSend proposal.
- **src/lib/safe.ts**
  - Reads from the Safe transaction service, confirms and executes, and uses `approveHash` on chains without a service.
  - `runSafeCalls`.
- **Other files:** safe-reads.ts and the safe-batch*.ts files. UI: components/project/SafeBatchProvider, SafeBatchTray, SafeBatchDialog, SafeBatchPresetDialog and SafeQueueCard.tsx.
- **Behavior:** the Safe queue polls once a minute and pauses during actions. Opened as a Safe App, execution is handed off to Safe{Wallet}.

**Relayr** (one native-token payment funds calls on several chains through the ERC-2771 forwarder)
- **src/lib/relayr.ts**
  - API at `https://api.relayr.ba5ed.com`. The payment contract's address, selector and code hash are pinned.
  - Main functions: `buildForwardedTx`, `relayrPostBundle`, `relayrPay` and `relayrPoll`.
  - Pending sessions live in localStorage under `jb-relayr-pending-v1:<scope>`, guarded by `withRelayrScopeLock`.
  - Relayr's transaction IDs are matched by request, never by position (commit 40213cb).
- **relayr-chains.ts:** a bundle stays within one family, mainnets or testnets.
- **forwarder-authorization.ts**
- **launch-relayr.ts and launch-session.ts:** multichain project creation. The saved session key is `jbm-launch-pending-v1`, with per-chain recovery.
- **payer-relayr.ts**
- **authority.ts `runAuthorityCalls` and project-batch.ts:** an ordinary wallet sends one Relayr bundle, and a Safe gets one proposal per chain.
- **UI:**
  - The funding-chain picker comes from `requireFundingChainSelection`.
  - The account page shows pending bundles in components/account/AccountPendingRelayr.tsx.
- Journeys across the clients: docs/relayr-journeys.md.

**Signa / JB Center sign-in: not present in jbm or REV** (both use Para). Homerun is the Next template to follow:
- **HR/src/providers/lazy-center-connector.ts:**
  - `lazyConnector({id: 'juicebox-center'})` wraps `centerAccountConnector` from `@bananapus/nana-sdk-connect/wagmi`.
  - It reads through `jbCenterRpcTransport(8453)`.
- **HR/src/providers/center-runtime.ts:**
  - `createCenterWalletClient` from `/core`, with the callback at `/center/callback`.
  - The page to return to is kept in sessionStorage.
- **Other HR provider files:** wallet-config.ts, center-callback.ts, preload-center.ts, ExternalWalletDialog.tsx and WalletAuthContext.tsx.
- **HR/src/app/center/callback/page.tsx:** uses `deliverCenterCallback` when framed or in a popup. Otherwise it calls `completeConnection` or `completePayment`.
- **HR/next.config.ts:** `/center/callback` gets `Cache-Control: no-store` and `Referrer-Policy: strict-origin`.
- STK's vanilla client vendors the same flow as STK/webclient/center-connect.js, built from `@bananapus/nana-sdk-connect/core`.

**JB Center (not sign-in)**
- The browser uses `@bananapus/nana-sdk-core/jbcenter` without credentials:
  - For RPC reads (§4).
  - For IPFS pinning in src/lib/jbcenter-ipfs.ts (`pinJson`, `pinImage`, `pinMedia`, gateway `https://juicebox.center/ipfs/`).
- jbm does not use Center intents. Homerun does, in HR/src/lib/fund-intent.ts and HR/src/components/DeployChains.tsx:
  - `JBCenterClient` methods: `prepareIntent`, `publishIntent`, `recordDeployment` and `requestDeploy`.
  - Helpers: `publishSignedIntent` and `ensureDeployed`.

## 4. Data layer

### Bendystraw (indexer): same-origin persisted-operation proxy

**Core function: `bendystraw<T>(query, variables, {chainId?, network?, policy?})` in src/lib/bendystraw.ts**
- **Compile:** it compiles each GraphQL document once in src/lib/bendystraw-operation.ts (`compileBendystrawOperation`, using graphql's `parse`). That produces the operation name, a bounded check on variables, and a recursive check on the response shape.
- **Network:** it picks mainnet or testnet with the SDK's `resolveBendystrawNetwork`, from `chainId`, the variables or an explicit network.
- **On the server** (server components and route handlers): it calls the SDK's `requestBendystraw` on `selectBendystrawEndpoint({mainnet: NEXT_PUBLIC_BENDYSTRAW_URL/graphql, testnet: NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL/graphql})`.
  - Next's fetch `revalidate` comes from `bendystrawCacheTtl(policy)`: live 15 s, standard 30 s, stable 60 s.
- **In the browser:** it imports src/lib/bendystraw-browser.ts and POSTs `{operation: sha256(document), variables}` to `/api/bendystraw/<mainnet|testnet>/query`.
  - The hash comes from src/lib/bendystraw-operation-id.ts (WebCrypto).
  - It uses `cache: 'no-store'` and runs the same response checks.
  - The code has no dev bypass: the browser goes through the proxy in dev too. The 2026-08-18 memory note saying dev hits Bendystraw directly is outdated.

**Route: src/app/api/bendystraw/[net]/query/route.ts**
- **Request checks:** only `mainnet` or `testnet`, only `application/json`, and bodies capped at 32 KiB (both the declared size and the streamed size).
- **Lookup:** `resolvePersistedBendystrawRequest` in src/lib/bendystraw-proxy.ts allows exactly the keys `{operation, variables}` and a 64-character hex ID, then looks the ID up in the registry. Unknown IDs get a 400.
- **Response:** it runs `bendystraw(doc, vars, {network, policy: 'live'})` on the server.
  - Success is `{data}` with no-store and nosniff headers.
  - Failure is a 502 `{error}`.

**Registry: src/lib/bendystraw-operation-registry.json**
- A map of `{sha256hex: document}`, currently 38 entries.
- **Generate:** run `npm run bendystraw:registry`, which runs `scripts/check-bendystraw-schema.mjs 27 --write-registry`.
  - The script parses every `src` file with the TypeScript compiler API.
  - It works out the value of every string or template literal that starts with `query` or `mutation`. It can resolve `${CONST}` interpolation and `.map`/`.join` over module constants.
  - It fails if a template can't be resolved or if it finds fewer than 27 documents.
- **Check in CI:** `schema:check:offline` fails when the committed registry is stale.
- **Full check:** `schema:check` also validates every document against both live schemas, and rejects `projectId_in` combined with `chainId_in`, and identity fields inside `OR` without an explicit `AND`.
- **What this means for new code:** write every query as a static document built only from module constants. After changing one, regenerate the registry and commit it.

**Policy and fallbacks**
- **Policy** is in docs/bendystraw-data-policy.md. A timeout, schema error or malformed response must never become zero, an empty list or another project's data. Fallbacks keep the same project identity and are marked degraded.
- **Degraded project page:** src/lib/project-fallback.ts `getProjectPageData` returns either `{project, degraded: false}` or an on-chain shell with `degraded: true` and a reason of `'not-indexed'` or `'indexer-error'`.

**Other same-origin read APIs**
- `activity`, `participants`, `price-history`, `top-projects`, `auto-issuances`, `loans`, `movements`, `search`, `shop-customers`, `project-ready` and `project-name`.
- Each wraps lib/bendystraw.ts on the server.
- CDN cache headers come from src/lib/api-cache.ts: `public, s-maxage=60, stale-while-revalidate=86400`, or 15/60 for live data.
- These headers go only on successful responses that aren't tied to an account.

**Sibling apps**
- REV has the same route but named, typed operations in REV/src/lib/bendystraw/operations.ts, plus registry.server.ts, query.server.ts, client.ts and useBendystrawQuery.ts.
- HR uses jbm's file set: HR/src/lib/bendystraw-*.ts, with `check:indexer` running the schema script with `7 --offline`.

### RPC

**`jbCenterRpcTransport(chainId, timeoutMs = 15_000)` in src/lib/jbcenter-rpc.ts**
- A viem `custom()` transport over the SDK's `createJBCenterRpcProvider(chainId, {baseUrl, fetch, timeoutMs})`, with `retryCount: 1`.
- **Lag retries:** `retryWhileBehindHead` retries JSON-RPC error -32001 after 250, 500, 1000, 2000 and 2000 ms. That error means a load-balanced node hasn't reached the requested block yet.
- **Origin:** on the server, fetch sets the `Origin` header to `jbCenterAppOrigin()`.
- **Test mode:** deterministic mode uses `http(<fixture>/rpc/<network>)`.

**Center base URL (src/lib/jbcenter-config.ts)**
- dev.juicebox.money and localhost:3001 go to `https://dev.juicebox.center`. Everything else goes to `https://juicebox.center`.
- No API key is used, and none may be.

**What Center's RPC allows**
- Center accepts read methods only, including `eth_call`, `eth_getLogs`, `eth_estimateGas` and `eth_simulateV1`.
- It rejects wallet, signing, send and **JSON-RPC batch** requests.
- So batching through Center means Multicall3. STK's JSON-RPC batching in `batchedRpc` won't work through Center.

**Clients**
- jbm reads through wagmi: `useReadContract` (21 sites), `usePublicClient({chainId})`, `getPublicClient(wagmiConfig, {chainId})` and `publicClient()` in lib/wallet-core.ts.
- wagmi's `createConfig` clients carry `chain` and default to `batch: {multicall: true}` (@wagmi/core 3.6.4 createConfig.js:132), so reads are batched into Multicall3.
- **jbm has no `jbCenterPublicClient`.** It is Homerun's (HR/src/lib/jbcenter-rpc.ts): one cached `createPublicClient({chain, transport: jbCenterRpcTransport(id, 60_000), batch: {multicall: true}})` per chain.
- REV's equivalent is `getViemPublicClient` in REV/src/lib/wagmiTransports.ts.
- **Rules:**
  - A standalone viem client without `chain` silently skips multicall.
  - Center applies one rate limit across all chains. Run per-chain bursts one after another (jbm commit 087456e) and poll slowly.

### react-query conventions

**Defaults and keys**
- The QueryClient is created in Providers.tsx with `staleTime 30_000`, `gcTime 10 min`, `retry 1` and `refetchOnWindowFocus false`.
- Query keys are plain arrays, for example `['projectTreasuryUsd', chains]` and `['participants', suckerGroupId ?? refs]`. There are about 111 `useQuery` sites.
- wagmi's read hooks share the same QueryClient.

**Persistence (src/lib/query-persist.ts)**
- It is opt-in per query:
  - `meta: PERSIST` or `cachedQuery()` shows the last session's value first, then refetches.
  - `immutableQuery()` sets `staleTime` and `gcTime` to Infinity.
- **Storage:** it uses react-query's `dehydrate`/`hydrate` into localStorage under `jbm:query-cache:v1`.
  - Capped at 2.5 MB, with writes debounced by 1 s.
  - Bigints are stored as tagged `$bigint` objects.
- It is installed after `window.load` so it can't cause hydration mismatches.
- **Display:** pair it with `<Revalidating pending={isFetching && !!data}>` (src/components/ui/Revalidating.tsx) and the `.revalidating` CSS class.
- **Rule:** never persist queries keyed by wallet or account. test/persist-scope.test.ts scans for this.

**Server-side caching**
- Server components wrap POST-backed reads in `react.cache()`, because Next's fetch cache doesn't dedupe POSTs.
- Handle lookups use `unstable_cache` with a 900 s revalidate.

## 5. Activity feed

### Data (src/lib/bendystraw.ts)

**`BsActivityEvent` type**
- One row with a nullable sub-object per event kind:
  - Money in and out: pay, add-to-balance, cash out, token mint, payouts, reserved-token distributions, auto-issue.
  - Loans: borrow, repay and liquidate.
  - Shop and token: NFT mint, ERC-20 deploy, NFT tier added and removed.
  - Project admin: project create, URI update, ownership transfer, ruleset queued, operator permissions.
  - Buyback and bridging: buyback swap, buyback pool, bridge claim.
- `ACTIVITY_EVENT_FIELDS` is the shared field selection.

**Fetchers**
- `getProjectActivity(suckerGroupId, limit, chainId?, offset)` and `getProjectActivityByProject(chainId, projectId, limit, offset)` return `{items, totalCount}` through `getPagedItems` with the `live` policy.
- `getRecentActivity(limit, offset)` covers every V6 project, for the home page. It nests `project{name logoUri metadataUri tokenSymbol decimals}` and fills gaps with `fillIndexedMetadata`.
- `getAccountActivity(address)` feeds the account page.

**First page renders on the server**
- The project page (`[urn]/page.tsx`) fetches 250 events, scoped to the sucker group when there is one. On failure it passes `error: true`, never an empty list.
- The home page calls `getRecentActivity(9)` and passes the result to `<FreshActivity>`.

### src/components/ActivityList.tsx (project feed, client component)

**Updating**
- Holds `liveEvents` in state.
- Refreshes every 15 s (`ACTIVITY_POLL_MS`) and when the tab becomes visible. It skips refreshes while the tab is hidden.
- `mergeActivityEvents` removes duplicates by id and sorts newest first, breaking ties by id.
- The "more" link loads 250 more by offset, up to `totalCount`.

**Filtering**
- `projectFeedEvents` drops permission grants. It keeps a reserved-split receipt only next to its distribution.
- Category filtering uses `activityCategory` and `ActivityTypeFilter`.

**Rendering:** `mergeCrossChainGroups(groupSameTxEvents(visible)).map(({group, chains}) => <Row .../>)`
- **`groupSameTxEvents`**
  - Groups by `${chainId}:${projectId}:${version}:${txHash}`.
  - A group sits where its newest event sat.
- **`mergeCrossChainGroups`**
  - Builds a signature from the sender (`from`) plus each event's sorted `eventDisplaySignature`.
  - Groups with the same signature on different chains within 6 hours fold into one item with a `chains[]` list.
  - Each chain icon links to its own transaction.
- **`combinedActivityParts(group, tokenUnit)`**
  - Orders events by `GROUP_ORDER`: projectCreate, pay, addToBalance, nftMint, cashOut, buybackSwap, tokenMint, autoIssue, bridgeClaim. Reserved-split receipts go last, largest first.
  - Drops the duplicate mint that an issuing pay produces, and hides the buyback hook's re-mint inside a cash out.
  - Returns the lead event's parts plus `actions[]` for bullets, and a joined `action` sentence.
- **`activityParts(event, tokenUnit)`**
  - Returns `{actor, action, direction ('in' | 'out' | null), kind, headline, memo, amountUsd, amountRaw}`.
  - Sticky splits already render through `isStickyHook` and `<StickyRecipient>`.

**Row layout**
- Top line: the amount (`ActivityAmountLine`) on the left, and "time ago on <chain icons>" on the right.
- Then "to", "from" or "by" the actor, then the memo, then the actions as bullets.

**Empty and error states**
- Empty shows an illustration.
- Error says "temporarily unavailable" and never shows an empty history.

### src/components/FreshActivity.tsx (home page feed)

- **Polling:** fetches `/api/activity?limit=8&offset=0` every 15 s. That route is cached at the CDN.
- **Loading more:** infinite scroll through `useInfiniteScroll`.
- **Grouping:** `groupSameTxEvents` only, with no cross-chain merge.
- **Row:** logo, project link, `<ActivityMeta>`, the actor and the joined action.
- **Token name:** `useProjectTokenUnit` reads the project's ERC-20 symbol on-chain.

### src/components/ActivityMeta.tsx

- **`ActivityMeta`:** the amount, an in/out tag, and a chain icon linking to the transaction.
- **`ActivityAmountLine`**
- **`ActivityOnChain`:** stacked chain icons.
- **`activityAmountLabel`:** formats the amount. It uses the indexed 18-decimal USD value through `formatUsd18`, or the raw amount in the accounting token when every chain uses the same token.
- **`actorPrefix`**

### Other surfaces and Sticky

- components/account/AccountActivity.tsx reuses the same helpers.
- REV's equivalent is REV/src/app/[slug]/components/ActivityFeed/: ActivityFeed, ActivityItem, mapActivityEvents and PendingRoutingPayments.
- **For Sticky:** Bendystraw indexes Sticky projects' pays and cash outs but not StickyHook positions, tranches or streaks (per STK/webclient/README.md).
  - Stake and unstake rows have to come from scanning the hook's logs.
  - Map them into a union shaped like `BsActivityEvent` so the grouping, merge and parts helpers can be reused.

## 6. Transaction flow

### Rules (from memory: `jb-webclients-tx-confirm-dialog-everywhere`, `jb-webclients-dialogs-replace-not-stack`, `jb-webclients-multitx-step-viewer`)

- **Every write uses a confirm dialog.** Every wallet write, one step or several, is reviewed in a Pay-style dialog: a title, label/value rows, the TxSteps list and one action button.
- **No inline reviews.** Never append a review under the form, and never use a "Review" button. The form's main button, named for the action, opens the dialog in its `preparing` state while fresh reads load.
- **No stacked dialogs.**
  - A confirm opened inside a ModalShell replaces that card's contents, via `useEnclosingModalCard`.
  - A newer dialog covers older ones through the `data-covered` attribute instead of adding a second backdrop.
- **Plan steps up front.** Work out the full step list, including approvals and Permit2, while reviewing, not while executing.

### UI components

- **src/components/ui/TxConfirmDialog.tsx**
  - Props:
    - Content: `open`, `onClose`, `eyebrow`, `title`, `rows[{label, value, mono, strong}]`, `children`.
    - Steps: `steps`, `activeIndex`, `stepsIntro`.
    - Actions: `action`, `actionDisabled`, `cancelLabel`, `onConfirm`.
    - State: `busy`, `complete`, `preparing`, `status`, `error`.
  - It can't be closed while `busy`, and shows a single "Done" button once `complete`.
- **src/components/ui/TxSteps.tsx:** takes `steps[{key, title, detail}]`, an `activeIndex` that runs from -1 (not started) to the number of steps (done), and an optional `intro`.
- **src/components/ui/TxError.tsx:** the red error block.
- **src/components/ui/ModalShell.tsx:**
  - `ModalDialog`: a native `<dialog>` opened with `showModal()`, with backdrop-click close, a reference-counted body scroll lock, and covering of the dialogs below it.
  - Also `ModalShell` (a titled card), `ModalCloseButton` and `useEnclosingModalCard`.

### Single-chain direct write

**`useSafeTx(chainId)` in src/hooks/useSafeTx.ts**
- Returns:
  - Status: `phase` (idle, review, simulating, signing, pending, success or error), `busy`, `isSafe`, `error`, `confirmationUncertain`.
  - Results: `hash`, `safeProposalHash`, `safeNonceGuidance`, `receipt`.
  - Actions: `send` and `reset`.
- `txPhaseLabel` gives the button text for each phase.
- `send(TxRequest{chainId, address, abi, functionName, args, value?, label?}, {reverify?, reviewedInParent?, simulationBlockNumber?, reviewNotice?})`.

**`submitReviewedContractWrite` in src/lib/contract-write.ts runs in this order:**
1. `assertNoViewAs`.
2. `review(request)`, which opens the global review dialog.
3. `switchChain`.
4. Account check.
5. `reverify`, where the caller re-reads live state.
6. Account check.
7. `simulate`: `simulateContract` plus `estimateContractGas`, with the gas estimate doubled by `gasWithHeadroom` (lib/gas.ts).
8. Account check.
9. `write(simulated)`. Only the simulated request reaches `writeContractAsync`.

**Receipts**
- wagmi's `useWaitForTransactionReceipt` (120 s timeout) races a `getTransactionReceipt` poll every 4 s.
- A reverted receipt becomes an error.
- If the RPC can't confirm, the user is told the transaction was submitted but confirmation is unavailable, and not to resubmit.
- lib/receipt.ts `waitForTrackedReceipt` is the non-hook version.
- With the Safe connector, the proposal hash is resolved to the execution hash.

### Global review dialog

- **src/lib/transaction-review.ts:** a registry of review handlers.
  - Entry points: `requestContractTransactionReview`, `requireTransactionReview`, `requireContractTransactionReview` and `requireFundingChainSelection`.
  - Also builds JSON and "review this for me" prompts.
- **src/components/TransactionReviewProvider.tsx:** a promise-based queue.
  - It snapshots the calls including `from`.
  - It loads the dialog code only when needed.
  - Unmounting or cancelling counts as declining.
- **src/components/TransactionReviewDialog.tsx:** decodes calldata against the SDK's ABIs.
  - It names known addresses: the JB address book, Permit2, the Universal Router and USDC.
  - It spells out Uniswap V4 and Universal Router plans, JB hook metadata, sucker claims, Safe inner calls and setup, permissions and split groups. Sticky splits go through `describeStickySplit`.
  - It offers copy-as-JSON and copy-review-prompt.

### Other write paths

- **src/lib/transaction-simulation.ts:** `simulateStateChangingTransaction` is a raw `eth_call` with a 10M gas cap, a 4 KiB return cap and no CCIP-read. The Relayr and Safe paths use it.
- **hooks/useReviewedPermit2Signature.ts:** Permit2 signatures.
- **Relayr and Safe:** see §3.
- **View-as:** lib/viewAs.ts blocks writes while View-as is on.

### Composing a write

The smallest real example is src/components/project/BurnTokensFlow.tsx with src/lib/burnTokens.ts:
1. A pure builder returns `{chainId, address, abi, functionName, args}`. src/lib/transaction-builders.ts has about 30 of these, using the SDK's ABIs and `jbContractAddress['6']`.
2. The form's main button sets `preparing`, re-reads live state with `refetch`, then saves the frozen `plan`.
3. It renders `<TxConfirmDialog preparing={!plan} rows steps activeIndex busy complete action onConfirm error={error ?? tx.error}/>`.
4. `onConfirm` calls `tx.send({...plan, label}, {reverify})`.

Multi-step examples: PayPanel, CashOutFlow, AddLiquidityFlow, GetLoanFlow and MoveFlow.

### Gates

- **`npm run transaction:check`** (scripts/check-transaction-inventory.mjs) parses all production TypeScript.
  - Every `useSafeTx.send`, authority, reviewed direct write and raw wallet API call must be listed in test/transaction-sites.json.
  - Each needs a stable action ID and a test reference.
- **test/TRANSACTION_COVERAGE.md** records what each write's tests cover.
- **TESTING.md**, under "Contract-facing test rules", lists nine things to assert for every write.

### REV equivalents

- **Wallet hooks:**
  - hooks/useReviewedWriteContract.ts wraps wagmi's `useWriteContract` and also exports `proposeSafeBatch`.
  - Also useReviewedRelayr.ts, useReviewedSafeSignature.ts and useMultichainBatch.ts.
- **UI:** components/ui/TxConfirmDialog.tsx and TxSteps.tsx have the same API. components/ExactCallCard.tsx is REV-only.
- **Gate:** scripts/check-wallet-write-sites.mjs with test/fixtures/wallet-write-sites.json.

## 7. Project page, account view, layout and theming

### Project page: src/app/[urn]/page.tsx (server component)

**Routing**
- `resolveProjectRouteCached` accepts two URL forms:
  - `/eth:1`: lib/urn.ts `parseUrn` and `toUrn`, with slugs from lib/chainDisplay.ts.
  - `/@handle`: ENS-verified through lib/project-handles.ts and lib/ens.ts.
- `ProjectRouteSync` and `ProjectRouteProvider` reload handle URLs when the browser restores them from history.
- Unknown paths redirect to old.juicebox.money.

**Data** (all wrapped in `cache()`)
- `getProjectPageData`, which falls back to a `DegradedProjectShell`.
- In parallel:
  - IPFS metadata, fetched with a 300 s revalidate.
  - 250 activity events.
  - The sucker-group siblings from `getSuckerGroupProjects`. A failure is shown to the user, not hidden.
  - The revnet operator.
- `resolveProjectDeployments` gives the chain list up front. A chain is only read when the payer picks it.
- Per-chain owners or operators, JSON-LD, and `generateMetadata` with the preview image `/api/project-og/<chainId>/<projectId>`.

**Page structure**
- An optional cover image.
- A header with:
  - The logo (112 px), an h1 in `font-agrandir`, and the tagline.
  - `ProjectStats`: USD raised, payments, holders, and treasury USD from a persisted query.
  - A line with flavor, owner, created date and chains.
- Then `<ProjectTabs sidebar={<TreasuryCard>(PayPanel)} activity={<PendingPayments/><ActivityList/>} tabs=[...]>`, wrapped in `<ShopCartProvider><SafeBatchProvider>`.

**ProjectTabs (src/components/project/Tabs.tsx)**
- **Layout:**
  - From 801 px wide, two columns: a left column (320 or 384 px) with the pay card and activity, and the tab row and panels on the right.
  - Below that, one column with an extra "Activity" tab that is selected by default.
- **Tabs, in order:**
  - Overview (OverviewTab: RevnetPriceCard, FundingChart, description and links).
  - Terms for revnets, or Rulesets for custom projects.
  - Funds (custom projects only).
  - Owners for revnets, or Tokens for custom projects. Sub-tabs: Accounts, Market, Settlement, Splits or Reserved, Auto issuance, Loans.
  - Shop, with Inventory and Customers.
  - Extras, then Operator or Owner (BackOfficeTab). These last two sit behind a "⋯" overflow button.
- **Deep links:** URLs use `#tab/subtab`. The hash is updated with the browser's native `History.prototype.replaceState`.
- **Loading:**
  - A panel mounts the first time it's opened and stays mounted.
  - The secondary tabs are code-split through LazyProjectTabs.tsx (`next/dynamic` with `loading: () => null`) into DeferredProjectTabs.ts, one shared chunk.
- `TabShell` and `SubTabs` are reused by the account page.

### Account page: src/app/account/[address]/page.tsx

- **Input:** an address or an ENS name.
- **Data:** reads are wrapped in `cache()`, and each section has its own error state.
- **Layout:** AccountHeader, then AccountTabs:
  - Activity: pending Relayr bundles, then AccountActivity.
  - Holdings: tokens and store items.
  - Projects: owned directly and through a Safe (AccountSafeProjects).
  - Roles: operator grants.
- **View-as:**
  - lib/viewAs.ts stores it in localStorage under `jb-view-as-v1`, read via `useSyncExternalStore`.
  - hooks/useViewedAccount.ts serves reads for display.
  - Writes always use the connected wallet.

### Layout: src/app/layout.tsx

- **Fonts** load with `next/font/local` from public/fonts, all with `display: swap` and system fallbacks:
  - PP Agrandir Medium as `--font-agrandir`.
  - PP Agrandir Wide Medium and Bold as `--font-agrandir-wide`.
  - Beatrice Regular and Medium as `--font-beatrice`.
- **Body**, in order:
  - A skip link.
  - `<Providers>`, which wraps everything below.
  - ScrollToTop.
  - A sticky header (`sticky top-0 z-40 border-b border-smoke-200 bg-bone/90 backdrop-blur`) holding SiteNavigation.
  - `<main id="main-content">`.
  - SiteFooter, styled in Slate.
- **SiteNavigation** holds the logo, Learn, Build and Audit links, SearchBox and WalletButton. It collapses to a 44 px mobile menu.
- **Metadata:** OpenGraph and Twitter tags, and `themeColor` #FFF7E8.
- Content under the sticky header needs `scroll-mt-28` so scroll-into-view clears it.

### Theming

- **JBM/DESIGN.md** is the Juicebox Brand 2023 system. It uses the light Bone theme only, with no dark mode.
  - Color scales:
    - Split is the brand yellow, not used for buttons.
    - Bluebs is the action, focus and selected color.
    - Melon, Peel, Grape and Crush are the fruit accents.
    - Smoke, Grey and Error are neutrals and states; Slate is for the footer.
  - Rules: 44 px touch targets, text contrast of at least 4.5:1, no icon libraries, and reduced motion respected.
- **JBM/tailwind.config.mjs** holds the color scales and the `sans`, `agrandir` and `agrandir-wide` font families.
- **src/app/globals.css** loads Tailwind 4 with `@import "tailwindcss"` plus `@config` pointing at the JS config.
  - Base styles: Bone background, Ink text, a Bluebs `:focus-visible` outline and pointer cursors.
  - Component classes, by group:
    - Surfaces: `.card`.
    - Dialogs: `.modal-dialog` with `::backdrop`, `dialog[data-covered]`, and `dialog.ui-modal-host` for Para.
    - Loading: `.skeleton-shimmer`, `.revalidating`.
    - Buttons and navigation: `.btn-primary`, `.btn-secondary`, `.btn-tertiary`, `.btn-ghost`, `.btn-link`, `.icon-button`, `.nav-link`.
    - Forms: `.chip`, `.select-caret`, `.field-label`, `.field-hint`, `.field-error`, `.input-well`.
    - Notices and menus: `.callout-*`, `.menu-item`, plus the guide styles.
- **JBM/UI_STYLE_AUDIT.md** records the style audit.
- STK/webclient already ships Beatrice and PP Agrandir Wide woff2 files, so this font setup carries over directly.

## 8. What jbm and revnet-money share, and how

There is no shared internal package, workspace or monorepo. Each app is a separate git repo that builds on its own. They share code three ways.

### 1. The published SDK: `@bananapus/nana-sdk-core` ^2.12.2

- **Source:** Bananapus/juice-sdk-v4, `packages/core`. Local checkouts are at /Users/jango/Documents/jb/v6/evm/juice-sdk-v4 and /Users/jango/Documents/jb/v6/evm/juice-sdk-connect.
  - The second also contains `packages/connect`, which is `@bananapus/nana-sdk-connect` 0.5.6 with `./core`, `./wagmi` and `./react` entry points.
- **Contents:**
  - **ABIs and addresses:** ABIs and `jbContractAddress['6']` for core, 721, buyback, router, suckers, omnichain, revnet and Sticky.
    - Sticky contracts: StickyDeployer, StickyHook, StickyDistributor, StickyRewardReceiverFactory, StickyAutoStick.
    - Sticky ABIs: `stickyHookAbi`, `stickyDeployerAbi`, `stickyDistributorAbi`, `stickyRewardReceiverFactoryAbi`, `stickyAutoStickAbi`.
  - **Chains and indexer:** `./chains`, plus Bendystraw helpers for requests, validation, network choice, filters and cache policy.
  - **Services:** `./jbcenter` (RPC provider, IPFS and intents) and `./safe`.
  - **Actions:** `./v6` actions: pay, cash out, loans, Permit2, Uniswap V4 and splits.
  - **Sticky helpers:** `STICKY_*` constants, `stickyDistributorAddress`, `isStickySplit`, `stickyGroupId`, `validateStickyGroupId`, `decodeStickyGroupId` and `describeStickySplit`.
- Neither app uses juice-sdk-react or nana-sdk-react.

### 2. App code that is copied, adapted and kept in step by hand

- Code comments mark shared files:
  - "Kept identical to revnet-money's copy" appears in lib/transfer-schedule.ts, protocol-concepts, price-concepts and pay-choices.
  - lib/safe-batch-presets.ts says "Must match revnet-money's preset: Safe co-signers on either client only meet on identical calldata."
- Memory rules back this up:
  - A wallet primitive lands in both apps in the same change.
  - Any client change gets a parity check against the other clients, including juicescan.
  - Revnet's Sticky split UI borrows jbm's.

### 3. Identical generated data

- `src/lib/protocol-rollout.json` is byte-identical in both.
- Each repo generates it from deploy-all-v6 with its own scripts/generate-protocol-rollout.mjs.

### Evidence

- 77 files exist at the same path under `src/` in both repos, and only protocol-rollout.json is byte-identical.
- Of 16 I sampled, 5 differ only in formatting. jbm uses single quotes and no semicolons; REV runs prettier. Those 5 are:
  - lib/wallet-list.ts
  - providers/lazy-para-connector.ts
  - providers/para-session.ts
  - vendor/HeartbeatWorker.js
  - lib/router-gateway-abi.ts
- The other 11 have real differences. Examples:
  - jbcenter-rpc: REV uses a `NEXT_PUBLIC_RPC_FIXTURE_URL` fixture and has no timeout parameter.
  - lazy-connector and query-persist.
  - TransactionReviewProvider: 1733 lines in REV because it includes the dialog.

### How REV is built differently

- **Project tabs are route segments**, `/[slug]/owners`, `terms`, `shop`, `extras` and `operator`. `[slug]/layout.tsx` holds the Header, PayCard and ActivityFeed.
- **App setup:**
  - Root providers are in app/providers.tsx, which renders AppSpecificProviders.tsx.
  - wagmiConfig lives in lib/wagmiConfig.ts and lib/wagmiTransports.ts.
  - Bendystraw operations are typed.
- **UI:**
  - Components are shadcn-style (ui/dialog.tsx, toast, tooltip, tailwind-merge), plus lib/topLayer.ts.
  - The palette is zinc and teal, with the Simplon Mono font.
- **Tooling:** it uses Testing Library and a prettier formatting ratchet.

### Equivalent pieces, jbm to REV

| jbm | REV |
|---|---|
| useSafeTx + contract-write | useReviewedWriteContract |
| safe-batch-connector `proposeSafeBatch` | `proposeSafeBatch` inside useReviewedWriteContract |
| relayr.ts and authority.ts | useReviewedRelayr and useMultichainBatch |
| TransactionReviewProvider + TransactionReviewDialog | TransactionReviewProvider (dialog included) |
| ModalShell | ui/dialog |
| viewAs.ts | view-as.ts |
| ActivityList | ActivityFeed/* |
| transaction-sites.json | wallet-write-sites.json |

### Homerun: the closest template for Sticky

Homerun is a third sibling. It copies jbm's file layout most literally and already handles Sticky.
- **Copied from jbm:**
  - HR/src/lib: bendystraw-*.ts, contract-write.ts, chains.ts, chainDisplay.ts, gas.ts and jbcenter-*.ts.
  - HR/src/hooks: useSafeTx.ts and useWallet.ts.
  - Components: TransactionReviewProvider and TransactionReviewDialog, plus ui/ModalShell, ui/Revalidating and ui/Skeleton.
  - Providers: lazy-connector.ts and wallet-connectors.ts.
- **Added:**
  - Signa sign-in (§3) and `jbCenterPublicClient`.
  - Solidity contracts and the Next app share one `src/` folder. foundry.toml sets `src = "src"`, and tsconfig includes only `src/**/*.ts(x)`.
- **Sticky modules you can reuse:**
  - **HR/src/lib/sticky-contracts.ts:** `buildStickyStake`, `buildStickyUnstake`, `buildStickyApproval`, `buildStickyCreditClaim`, `stickyMinimum` and `assertStickyIdentity`.
  - **HR/src/lib/sticky-state.ts:** `readStickyProjectState`, `readStickyRewards`, `quoteStickyStake` and `quoteStickyUnstake`.
  - **HR/src/lib/sticky-create.ts:** Homerun's own create variant for its FUND projects, fixed to soulbound tokens and a 0 tax.
  - **HR/src/lib/sticky-session.ts and fund-snapshot-sticky.ts.**
  - **HR/src/components/StickyHolder.tsx:** stake, unstake and `StickyRewards`, built on `TxRequest` and `TxSendOptions` from useSafeTx.
  - **HR/src/components/StickyCreate.tsx.**

## 9. Testing, and what "next build is the gate" means

### Agent docs in the repo

- JBM/AGENTS.md holds only the block Next generates: "This is NOT the Next.js you know… read node_modules/next/dist/docs/ before writing code."
- JBM/CLAUDE.md is just `@AGENTS.md`. REV has the same pair.
- TESTING.md does not use the phrase "the gate".

### "next build is the gate"

This comes from the memory note `jb-webclients-next-build-is-the-only-real-gate`, not from the repo.
- **Why:** tsc, vitest and eslint all pass code that `next build` rejects. The example in the note: a `"use server"` module that exports a synchronous helper fails the build with "Server Actions must be async functions".
- **What to do:**
  - Run `./node_modules/.bin/next build --webpack` (about 1 minute) before pushing.
  - Keep pure helpers in `src/lib`.
- **In CI**, the build gate is `npm run build:browser`, followed by `budget` and `test:browser`.
- **Related traps:**
  - Use Node 26. Node 20 dies on `--no-experimental-webstorage`.
  - If `npm run` or `npx` fails on that flag, call `./node_modules/.bin/<tool>` directly.
  - Dev builds now go to `.next-dev`, so a production build no longer overwrites the running dev server. `NEXT_DIST_DIR` overrides the output folder.

### Unit tests (vitest.config.ts)

- **Setup:**
  - Runs in the Node environment and picks up `test/**/*.test.{ts,tsx}`.
  - test/setup.ts makes every `fetch`, XHR, WebSocket and EventSource throw.
  - test/dialog-shim.ts adds `showModal` to jsdom.
  - `@` maps to `./src`.
- **Coverage:** v8 coverage over all of `src/**/*.{ts,tsx}`.
  - Global minimums: 10.4% statements, 8% branches, 9.1% functions, 10.9% lines.
  - Higher per-file minimums on trust boundaries, for example: contract-write 95, transaction-builders 95, transaction-review 90, useSafeTx 78 statements / 82 lines, relayr 80.
- **Folders:**
  - **test/contracts (15):** ABI, selector and calldata round-trips.
  - **test/data (21):** Bendystraw responses treated as hostile input, plus tests for the proxy, jbcenter-rpc, block lag and network boundaries.
  - **test/transactions (24):** contract-write, use-safe-tx, review, relayr*, safe*, launch*, receipts and simulation.
  - **test/components (49):** write-flow orchestration using react-test-renderer.
  - **Smaller folders:** test/lib (8), test/providers (3), and test/fixtures (protocol-deployments.v6.json, safe-1.4.1.json).
  - About 48 more files sit at the `test/` root, including persist-scope.test.ts and activity-same-tx-grouping.test.tsx.

### Browser tests (playwright.config.ts, test/browser)

- **Setup:**
  - Chromium only.
  - `webServer` starts the fixture server (test/browser/fail-fast-service.mjs on port 4399), then runs `npm run start` on port 3100 with the deterministic environment.
- **Specs:** site, launch, create-multisig, guides, ipfs, modal and pending-payments.
- **Checks**, at 320, 390, 768 and 1280 px:
  - Accessibility: axe WCAG A/AA with zero contrast findings, and visible keyboard focus.
  - Page health: the security headers are present, there's no horizontal overflow, and there are no page errors.
  - Network: every non-local request is blocked.
- **Teardown** requires that the expected GraphQL and contract reads actually happened.
- **CI setting:** `failOnFlakyTests` is on, so a pass on retry fails the run.

### Other gates

- **`budget`** enforces these gzip limits, and Para must not load on any initial route:

  | Surface | Limit |
  |---|---|
  | Home route | 340 KiB |
  | Project route | 570 KiB |
  | Create route | 465 KiB |
  | All client JavaScript | 1500 KiB |
  | Largest single chunk | 450 KiB |
  | All CSS | 32 KiB |

- **Other scripts:** `transaction:check`, `schema:check:offline`, `protocol:check`, `source:check` and knip.

### CI

- **Main workflow:** .github/workflows/ci.yml.
  - Runs on Ubuntu 24.04, with actions pinned to commit SHAs.
  - Checks out pinned deploy-all-v6 deployment artifacts.
  - Steps in order: `npm ci`, deps:check, container:check, audit:prod, lint, ts:check, protocol:check, transaction:check, schema:check:offline, test:ci, build:browser, budget, then Playwright.
- **Container smoke job:** runs the image with a read-only filesystem, as a non-root user, with all Linux capabilities dropped.
- **Release:** .github/workflows/release-image.yml publishes the image to GHCR.

## 10. Deployment

### Docker image (JBM/Dockerfile)

- **Stages:**
  - **Base:** `node:26.7.0-bookworm-slim`, pinned by digest, with npm 12.0.1.
  - **Dependencies:** `npm ci`.
  - **Builder:** `NEXT_PUBLIC_*` values come in as build args. It runs `node scripts/check-deployment-env.mjs build && npm run build`.
  - **Runner:** copies `.next/standalone`, `.next/static`, `public`, `scripts/check-deployment-env.mjs` and `scripts/start-production.mjs`.
- **Runtime:**
  - Runs as `USER node` on port 3000.
  - A HEALTHCHECK hits `/api/healthz`.
  - CMD is `node scripts/start-production.mjs`, which checks the environment and then imports `server.js`.
- **next.config.js settings:**
  - `output: 'standalone'` and `outputFileTracingRoot: __dirname`.
  - `deploymentId: NEXT_PUBLIC_VERSION`, so a tab on an old build does a full reload.
  - distDir is `.next-dev` in dev and `.next` otherwise.
  - `optimizePackageImports: ['@bananapus/nana-sdk-core']`.

### Railway

- **JBM/railway.json:**
  - Builds with the DOCKERFILE builder (`Dockerfile`).
  - Health check on `/api/healthz` with a 60 s timeout.
  - Restarts ON_FAILURE up to 10 times; 1 replica; the app never sleeps.
- **Branches and environments (DEPLOYMENT.md):**
  - Branch `dev` deploys to the dev environment at https://dev.juicebox.money.
  - Branch `main` deploys to production at https://juicebox.money.
  - Deploys run automatically after CI passes, with overlapping deploys disabled.
  - `NEXT_PUBLIC_VERSION` is filled from `RAILWAY_GIT_COMMIT_SHA`.
- **Services:** `juicebox-money` and `juicebox-money-dev`. The `railway` CLI needs `--environment dev` for the dev service.
- **To verify:** a memory note says Railway builds these apps with Railpack, but railway.json says DOCKERFILE.
- **Images:** GHCR releases are tagged `ghcr.io/bananapus/juicebox-money:sha-<commit>`. Deploy and roll back by digest.

### Environment variables

`NEXT_PUBLIC_*` values are public and baked in at build time. .env.example lists them.

| Variable | Status | Rule |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | Required | https URL |
| `NEXT_PUBLIC_BENDYSTRAW_URL` | Required | https URL; `/graphql` is appended |
| `NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL` | Required | https URL |
| `NEXT_PUBLIC_PARA_API_KEY` | Required | At least 8 characters |
| `NEXT_PUBLIC_PARA_ENV` | Required | DEV, SANDBOX, BETA or PROD |
| `NEXT_PUBLIC_VERSION` | Required | At least 7 characters, and not "unknown" |
| `NEXT_PUBLIC_PARA_ONRAMP_PROVIDER` | Optional | STRIPE, MOONPAY, RAMP, CDP or MERCURYO |
| `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` | Optional | Leave empty to hide WalletConnect |
| `NEXT_PUBLIC_DETERMINISTIC_BROWSER=true` | Forbidden in deploys | Test builds only |
| `NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN` | Forbidden in deploys | Test builds only |

- **Required values** are checked by scripts/check-deployment-env.mjs.
- **Test and dev only:** `BROWSER_BUILD_FIXTURE_ORIGIN`, `NEXT_DIST_DIR` and the `PLAYWRIGHT_*` variables.
- **Read at runtime:** `RAILWAY_PUBLIC_DOMAIN` (fallback origin for social previews), `PORT` and `HOSTNAME`.
- **No secrets:** the JB Center URL is derived from the site URL, and the client holds no Center key.

### Headers and CSP (next.config.js)

- **Every path** gets:
  - `Content-Security-Policy: frame-ancestors https://app.safe.global https://app.5afe.dev https://plugin.money https://www.plugin.money https://crop.top https://croptop.eth.sucks`. This only controls who may frame the site; there is no `script-src` or `connect-src` policy.
  - `X-Content-Type-Options: nosniff`.
  - `Referrer-Policy: strict-origin-when-cross-origin`.
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- **`/manifest.json`** gets `Access-Control-Allow-Origin: *`.
- **`/assets/*`** gets `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`.
- **Redirects:** `poweredByHeader` is off, and `www.juicebox.money/*` permanently redirects (308) to the bare domain.
- **Images:** `remotePatterns` allows juicebox.center `/ipfs/**`, with a one-year `minimumCacheTTL`.
- **Webpack:**
  - Aliases stub out Para's optional add-ons: farcaster, the cosmos and solana connectors, x402, `aa-*`, async-storage and pino-pretty.
  - `wagmi/connectors$` points at `@wagmi/core`.
  - A `NormalModuleReplacementPlugin` swaps in src/vendor/HeartbeatWorker.js.
- **REV** has the same headers minus crop.top in `frame-ancestors`, plus `X-Permitted-Cross-Domain-Policies: none`.
- **For Sticky with Signa:** add Homerun's `/center/callback` headers (no-store and `Referrer-Policy: strict-origin`). Make sure the site-wide `frame-ancestors` doesn't block Signa's framed sign-in; check which origin frames `/center/callback`.

## Appendix A: Sticky vanilla client files and what replaces them

Roles are inferred from file names and STK/webclient/README.md.

| STK/webclient | Replace with |
|---|---|
| runtime.js (`batchedRpc`, log bisection, localStorage caches) | wagmi clients (multicall), HR `jbCenterPublicClient`, lib/query-persist.ts (never wallet data). Hook log scans stay custom. |
| serve.py relay + bendystraw-operations.json + bendystraw-registry.py | route.ts + bendystraw-proxy.ts + registry JSON + check-bendystraw-schema.mjs |
| tx-engine.js + calldata.js (decode before confirm) | useSafeTx + contract-write + TransactionReviewProvider/Dialog + transaction-sites.json |
| tx-safe.js | safe-connector.ts, safe.ts, safe-batch-connector.ts |
| relayr.js, launch-session.js, launch-plan.js | lib/relayr.ts, launch-relayr.ts, launch-session.ts (+ launch.ts plan shape) |
| wallet-chooser.js, center-connect.js, center-callback.{js,html} | A chooser like ParaAuthSheet.tsx (or HR ExternalWalletDialog.tsx), plus Signa from HR lazy-center-connector.ts, center-runtime.ts and app/center/callback |
| center-intents.js | `@bananapus/nana-sdk-core/jbcenter` (`JBCenterClient`, `publishSignedIntent`, `ensureDeployed`); see HR lib/fund-intent.ts |
| config.js, deployments.json, build-config.py | SDK `jbContractAddress['6'].Sticky*`. While the SDK lags a redeploy, overlay addresses like `lib/contracts.ts addrOf` + `protocol-rollout.json` (generator + `protocol:check`). Site config goes in `NEXT_PUBLIC_*`. |
| route-boot.js, app.js, index.html | App Router pages: `/`, `/[urn]`, `/account/[address]`, `/create` |
| serve.py `/healthz`, webclient/railway.json | Next standalone image + `/api/healthz` + jbm-style Dockerfile and railway.json |
| Sticky domain logic | Reuse HR lib/sticky-{contracts,state,session}.ts and components/StickyHolder.tsx; jbm lib/sticky.ts, sticky-check.ts, components/project/StickyRecipient.tsx, components/create/StickyTokenStatus.tsx; REV components/sticky/* |

## Appendix B: Gotchas

- **Registry:** any new or edited Bendystraw document needs `npm run bendystraw:registry`, or the proxy answers 400. Build documents only from module constants so the extractor can resolve them.
- **RPC batching:**
  - A standalone viem client needs `chain`, or multicall silently does nothing.
  - Center rejects JSON-RPC batch requests, and applies one rate limit across all chains.
- **Persistence:** never persist queries keyed by wallet or account.
- **Dialogs:** use the confirm dialog for every write. Dialogs replace each other instead of stacking, and the step list is built at review time.
- **Parity:** wallet primitives land in jbm and revnet in the same change. Keep the Sticky app's shapes aligned with jbm's so primitives can move between the apps.
- **Toolchain:**
  - Use Node 26.7 and npm 12 (`npx -y npm@12.0 install …`); other versions churn the lockfile and builds exit with code 9.
  - Run `./node_modules/.bin/next build --webpack` before pushing.
