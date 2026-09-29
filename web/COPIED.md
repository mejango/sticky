# Copied files

Files in `web/` that come from Homerun (HR, `extensions/homerun`) or Juicebox Money (JBM, `webclients/juicebox-money`). Each row names the source path, the source repo's commit when it was copied, and the edits Sticky made. A fix to a copied wallet or transaction primitive lands in jbm, revnet-money and Homerun in the same change.

| File | Source | Source commit | Sticky edits |
|---|---|---|---|
| `package.json` dependencies, devDependencies, overrides, allowScripts | HR `package.json` lines 49-109 | HR d30cfbe | Dropped `dompurify`, `marked` and `@sphinx-labs/plugins`. The `sharp` override is JBM's `0.35.4`: HR's `0.35.3` fails `npm audit` with two high advisories in libheif. |
| `package.json` scripts, `engines`, `packageManager` | JBM `package.json` (script names and `engines`), the port plan (script list) | JBM 68e1e88 | Sticky's script set. `dev` binds `127.0.0.1:8788`. The two schema scripts take a minimum document count of `0` until Task 1.3 raises it. |
| `.nvmrc` | JBM `.nvmrc` | JBM 68e1e88 | None. |
| `.npmrc` | JBM `.npmrc` | JBM 68e1e88 | None. |
| `tsconfig.json` | HR `tsconfig.json` | HR d30cfbe | `include` is `next-env.d.ts`, `src/**/*`, `test/**/*` and the `.next` and `.next-dev` type folders. HR's `next.config.ts` and its two extra test build folders are gone. |
| `eslint.config.mjs` | HR `eslint.config.mjs` (identical to JBM's) | HR d30cfbe | Added `react/no-danger` for all TypeScript. Added a `no-restricted-imports` ban on `viem/chains`, scoped to `src/`, as JBM's `source:check` scopes it: JBM's own tests import `viem/chains`. |
| `postcss.config.js` | JBM `postcss.config.js` (HR's `postcss.config.mjs` as CommonJS) | JBM 68e1e88 | None. |
| `tailwind.config.mjs` | JBM `tailwind.config.mjs` | JBM 68e1e88 | Only the `content` glob and an empty `theme.extend`. JBM's color scales and font families are not copied; Task 0.3 adds Sticky's theme. |
| `vitest.config.mts` | HR `vitest.config.ts` | HR d30cfbe | Named `.mts`: with no `"type": "module"` in `package.json`, Vite 8.3 warns on every run about ESM syntax in a `.ts` config. `setupFiles` is `./test/setup.ts` and, from Task 0.2, `./test/dialog-shim.ts`, as JBM's config lists both (HR imports the shim in each test instead). The default environment stays jsdom, HR's: the two JBM Center RPC tests declare `// @vitest-environment node`. |
| `knip.json` | JBM `knip.json` (HR has none) | JBM 68e1e88 | Kept the `start-production.mjs`, `page.browsertest.tsx` and `fail-fast-service.mjs` entries, the connector SDK ignores, `tsx` and `../server.js`. Dropped the Para, HeartbeatWorker and jbm-only script entries. |
| `.gitignore` | HR `.gitignore` and JBM `.gitignore` | HR d30cfbe, JBM 68e1e88 | Dropped HR's Solidity, deployment and `public/assets/` entries: Sticky commits its artwork under `public/assets/`. Added JBM's `coverage/`, `playwright-report/` and `.playwright/`. |
| `.env.example` | HR `.env.example` and JBM `.env.example` | HR d30cfbe, JBM 68e1e88 | Names only, no values. Para and Foundry variables dropped. |
| `AGENTS.md`, `CLAUDE.md` | HR `AGENTS.md`, `CLAUDE.md` | HR d30cfbe | None. This is the block Next 16.3.3 writes on `next dev`. |
| `next.config.js` | JBM `next.config.js` | JBM 68e1e88 | Removed the `webpack` hook (the Para aliases and the HeartbeatWorker replacement). `frame-ancestors` names only `https://app.safe.global https://app.5afe.dev`. The site-wide headers skip `/center/callback`, which has its own set: `Cache-Control: no-store`, `Referrer-Policy: strict-origin` (HR's `next.config.ts`), `frame-ancestors 'self'` and `nosniff`. The redirect is `www.sticky.center` to `https://sticky.center`. |
| `test/setup.ts` | HR `test/runtime/setup.ts` (HR has no `test/setup.ts`) | HR d30cfbe | None. JBM's `test/setup.ts` is the same file without the `vi.clearAllMocks()` line. |
| `test/smoke.test.ts` | New. Loads `next.config.js` with `createRequire`, as JBM's `test/safe-app-config.test.ts` and `test/www-redirect.test.ts` do | JBM 68e1e88 | Runs header and redirect requests through Next's `unstable_getResponseFromNextConfig`, so the matching is Next's. |

`src/app/page.tsx` is written for Sticky and copies nothing. `src/app/layout.tsx` is too; from Task 0.2 it wraps `children` in `<Providers>`.

## Task 0.2: chains, Center RPC, providers, wallet, Signa callback

The files below were copied with HR at `33a5d54` and JBM at `68e1e88`. HR moved from `d30cfbe` (the commit Task 0.1 recorded) to `33a5d54` in between; none of the three later HR commits touch a file listed here. Every row is byte-close to its source except for the edits named.

### Source files

| File | Source | Source commit | Sticky edits |
|---|---|---|---|
| `src/lib/chains.ts` | HR `src/lib/chains.ts` (identical to JBM's) | HR 33a5d54 | None. |
| `src/lib/chainDisplay.ts` | HR `src/lib/chainDisplay.ts` (identical to JBM's) | HR 33a5d54 | None. |
| `src/lib/urn.ts` | HR `src/lib/urn.ts` | HR 33a5d54 | Deleted `legacyHref`, `legacyProjectHref` and `LEGACY_SITE`: Sticky has no legacy site. `projectPath`'s comment no longer names Homerun, INCOME or FUND. `parseUrn` returns `null` for text with a malformed percent escape: `decodeURIComponent('%')` threw, in HR and in JBM, where `SearchBox` calls `parseUrn` on the typed text on every render. |
| `src/lib/jbcenter-config.ts` | HR `src/lib/jbcenter-config.ts` | HR 33a5d54 | The constants. `PRODUCTION_SITE_URL` is `https://sticky.center`, `LOCAL_SITE_URL` is `http://127.0.0.1:8788`, `DEV_CENTER_URL` is unchanged, and `DEV_ORIGINS` is `http://127.0.0.1:8788`, `https://sticky-dev.up.railway.app` (ruling R16) and `https://dev.sticky.center`. |
| `src/lib/jbcenter-rpc.ts` | HR `src/lib/jbcenter-rpc.ts` (JBM's has no `jbCenterPublicClient`) | HR 33a5d54 | None. |
| `src/lib/query-persist.ts` | HR `src/lib/query-persist.ts` | HR 33a5d54 | Storage key `sticky:query-cache:v1`. |
| `src/lib/viewAs.ts` | HR `src/lib/viewAs.ts` (identical to JBM's) | HR 33a5d54 | None. |
| `src/lib/wallet-list.ts` | HR `src/lib/wallet-list.ts` | HR 33a5d54 | None. HR's copy is the one that hides the Signa connector and counts an injected wallet with a `type` as announced; JBM's hides only Para. |
| `src/lib/wallet-core.ts` | JBM `src/lib/wallet-core.ts` | JBM 68e1e88 | None. This is JBM's copy, not HR's: HR's predates JBM 7868369, which names the chain a Safe app must open on when the wallet cannot switch chains. HR needs the same change. |
| `src/lib/walletLinks.ts` | JBM `src/lib/walletLinks.ts` (imported by `ExternalWalletDialog.tsx` and `useMobileWallet.ts`) | JBM 68e1e88 | None. This is JBM's copy, not HR's: HR's still rewrites IPFS gateway links to `ipfs.io`, which no longer serves sites, and JBM 05955b9 moved them to `eth.sucks`. HR needs the same change. |
| `src/hooks/useWallet.ts` | HR `src/hooks/useWallet.ts` | HR 33a5d54 | None. |
| `src/hooks/useMobileWallet.ts` | HR `src/hooks/useMobileWallet.ts` (identical to JBM's; imported by `ExternalWalletDialog.tsx`) | HR 33a5d54 | None. |
| `src/components/BrandMarks.tsx` | HR `src/components/BrandMarks.tsx` (imported by `ExternalWalletDialog.tsx`; the file holds only `WalletFallbackMark`) | HR 33a5d54 | None. |
| `src/providers/Providers.tsx` | HR `src/providers/Providers.tsx` | HR 33a5d54 | Ruling R3: removed the `TransactionReviewProvider` import and its wrapper, so `{children}` renders where the wrapper was. Task 3.1 puts both back. |
| `src/providers/WalletAuthContext.tsx` | HR `src/providers/WalletAuthContext.tsx` | HR 33a5d54 | None. |
| `src/providers/center-callback.ts` | HR `src/providers/center-callback.ts` | HR 33a5d54 | `centerReturnPath` accepts Sticky's routes: `/base:23`, `/@handle` and `/account/0x…`. Segments may hold `: @ .` and percent escapes other than an encoded slash. HR's pattern `^\/(?:[a-zA-Z0-9_-]+\/?)*$` refused all three, so signing in from a project page threw before the launch (the return path is saved before every launch, framed or not), and it backtracked exponentially: `/` plus 30 letters and a `!` took 4 seconds, and the 1024-character bound allowed far worse. Sticky's pattern splits segments on a mandatory `/`. The error names Sticky. Removed `CENTER_FRAME_CALLBACK` and `CENTER_FRAME_RECEIVED`: only HR's `CenterProjectPayment.tsx` (Homerun's Center payment) reads them. Added `clearCenterCallbackUrl`: Next's router writes back the URL it booted with as it mounts, callback data included (seen in a production build, Chrome), so the page clears the address bar again before it hands the callback on. HR has the same write-back. |
| `src/providers/center-runtime.ts` | HR `src/providers/center-runtime.ts` | HR 33a5d54 | Storage key `sticky:center:return:v2`. It holds a path; the old Sticky client saved a hash route under `sticky:center:return:v1`, and a saved value must never be mistaken for the other kind. |
| `src/providers/lazy-center-connector.ts` | HR `src/providers/lazy-center-connector.ts` | HR 33a5d54 | `base` comes from `@bananapus/nana-sdk-core/chains`, not `wagmi/chains`, which re-exports the all-chain viem barrel that the lint rule keeps out of `src/`. |
| `src/providers/lazy-connector.ts` | HR `src/providers/lazy-connector.ts` (identical to JBM's) | HR 33a5d54 | None. |
| `src/providers/preload-center.ts` | HR `src/providers/preload-center.ts` | HR 33a5d54 | None. Task 0.3's `WalletButton` calls it. |
| `src/providers/wallet-config.ts` | HR `src/providers/wallet-config.ts` | HR 33a5d54 | The type `HomerunCenterConfig` is `CenterWalletConfig`. |
| `src/providers/wallet-connectors.ts` | HR `src/providers/wallet-connectors.ts` | HR 33a5d54 | App metadata for WalletConnect and Coinbase Wallet: name `Sticky`, the site's own description, default URL `https://sticky.center`, icon `/assets/drip-corner.png` (Task 0.3 adds the file). |
| `src/providers/ExternalWalletDialog.tsx` | HR `src/providers/ExternalWalletDialog.tsx` | HR 33a5d54 | The dialog's class is `sticky-connect` (was `homerun-connect`) and its copy names Sticky. The hint and pairing box use Sticky's `muted`, `line` and `card` tokens instead of HR's `smoke` scale. `safeIcon`: a wallet tile shows an icon only when it is an inline `data:image/...` URL. HR passes `connector.icon` straight to the tile, so an announced wallet with a remote icon URL would tell that host about every visit (the old Sticky chooser refused them). HR and JBM's `ParaAuthSheet` render the icon the same way. |
| `src/app/center/callback/page.tsx` | HR `src/app/center/callback/page.tsx` | HR 33a5d54 | The comment names Sticky. The heading uses `font-agrandir-wide`, Sticky's heading family (Task 0.3 defines it). Calls `clearCenterCallbackUrl` before it hands the callback to the SDK or to the page that framed it. |

Classes the dialog and the callback page use that Task 0.3's theme must define: `text-muted`, `border-line`, `bg-card`, `font-agrandir-wide`, `btn-primary`, `btn-secondary`. The dialog also needs CSS for `.jb-connect.sticky-connect`: the SDK's `--jb-connect-*` tokens, the way HR's `transaction-runtime.css` sets them for `.homerun-connect`.

### Tests

| File | Source | Source commit | Sticky edits |
|---|---|---|---|
| `test/dialog-shim.ts` | HR `test/dialog-shim.ts` (identical to JBM's) | HR 33a5d54 | None. Loaded by `setupFiles`. |
| `test/providers/center-callback.test.ts` | HR `test/center-callback.test.ts` | HR 33a5d54 | Changed cases: the origins `homerun.money` are `sticky.center`; the ordinary navigation `/projects` is `/base:23`; in the return-path case the accepted `/project/8453/7` is now Sticky's routes and the rejected `/project/7?code=x` is `/base:23?code=x`. Every other HR rejection is kept: `//evil.example`, `/\evil.example`, `https://evil.example`, `/center/callback`, `/%2f%2fevil` and `/a#secret`. New cases: more rejections (the old client's `javascript:` and `#/x"><script>`, an empty string, an encoded slash, a malformed escape, double slashes, the 1024-character bound), linear time, the module clearing the address bar as it loads, `clearCenterCallbackUrl`, and the first-import order of the provider tree. |
| `test/providers/center-runtime.test.ts` | HR `test/center-runtime.test.ts` | HR 33a5d54 | Changed cases: the origin `homerun.money` is `sticky-dev.up.railway.app` (a different origin from the config's own, so the callback URI is shown to follow the page) and the page `/project/8453/7` is `/base:23`. The site's Signa configuration is a getter, so a case can turn it off. New cases: no Signa configuration, Sticky's other routes, and a tampered saved page. |
| `test/providers/wallet-config.test.ts` | HR `test/wallet-config.test.ts` | HR 33a5d54 | None. |
| `test/providers/wallet-connectors.test.ts` | JBM `test/providers/wallet-connectors.test.ts` (`lazyConnector` and `wasRecentConnector`, identical in HR) | JBM 68e1e88 | None. |
| `test/lib/wallet-list.test.ts` | JBM `test/lib/wallet-list.test.ts` | JBM 68e1e88 | Added two cases for HR's copy of the module: Signa is never offered as a wallet tile, and an injected wallet without an icon counts as announced. |
| `test/wallet-links.test.ts` | JBM `test/wallet-links.test.ts` | JBM 68e1e88 | None. |
| `test/data/chains.test.ts` | JBM `test/data/chains.test.ts` | JBM 68e1e88 | None. |
| `test/data/jbcenter-rpc.test.ts` | JBM `test/data/jbcenter-rpc.test.ts` | JBM 68e1e88 | Runs in the node environment (the server fetch path). Changed cases: other localhost ports are `localhost:8788` (HR's `jbCenterAppOrigin` echoes the site's own origin where JBM's answers `https://juicebox.money`); the server's `Origin` header is `https://sticky.center`; the dev sites are `https://dev.sticky.center`, `https://sticky-dev.up.railway.app` and `http://127.0.0.1:8788`. |
| `test/data/rpc-block-lag.test.ts` | JBM `test/data/rpc-block-lag.test.ts` | JBM 68e1e88 | Runs in the node environment. |
| `test/query-persist.test.ts` | JBM `test/query-persist.test.ts` | JBM 68e1e88 | The storage key `jbm:query-cache:v1` is `sticky:query-cache:v1`, three places. |
| `test/explorer-and-safe-registries.test.ts` | JBM `test/explorer-and-safe-registries.test.ts` (it tests `chainDisplay`) | JBM 68e1e88 | None. |

New in Sticky, written for the modules above (HR and JBM have no test for them): `test/jbcenter-config.test.ts`, `test/lib/urn.test.ts` (JBM's route-identity cases from `test/data/project-identity.test.ts`, plus every slug, `projectPath` and malformed escapes), `test/lib/view-as.test.ts`, `test/hooks/use-wallet.test.tsx`, `test/data/jbcenter-public-client.test.ts` (one client per chain, `chain` set, and reads made together become one Multicall3 request), `test/providers/providers.test.tsx`, `test/providers/external-wallet-connectors.test.ts`, `test/providers/lazy-center-connector.test.ts`, `test/providers/external-wallet-dialog.test.tsx` and `test/providers/center-callback-page.test.tsx`. The last two render the real dialog and page with the SDK's own controller and modal; only wagmi's hook, the Signa runtime and the site's Signa configuration are replaced.

### Not copied from HR

Nothing Homerun-specific: no FUND or INCOME code, no demo data, no `center-payment.ts` or `CenterProjectPayment.tsx`, no `TransactionReviewProvider` (Task 3.1), no `WalletButton` (Task 0.3), no `HomerunProjectLayout`. HR's `wallet-button.test.tsx` belongs to Task 0.3. The old vendored-bundle hash check is not ported: the SDK now comes from npm.

### The old chooser and callback cases

Every case in `webclient/test/wallet-chooser.test.cjs` and `webclient/test/center-callback.test.cjs`, and the test that covers it now. HR has no test for the dialog or the callback page, so the cases were added under `test/providers/`.

| Old case | Covered by |
|---|---|
| Chooser: the Signa button is labelled by device (Face ID, Touch ID, Windows Hello, Device) | `external-wallet-dialog.test.tsx`, "labels the Signa button with the device's own passkey name", four user agents |
| Chooser: Signa first, then the wallet tiles, named for assistive tech | `external-wallet-dialog.test.tsx`, "puts Signa first as the primary action"; and "offers only browser wallets when Signa is not configured" |
| Chooser: only `data:` icons are shown | `external-wallet-dialog.test.tsx`, "shows only inline images as wallet icons". The old client refused remote icons and HR did not; `safeIcon` is the edit. A wallet without an accepted icon gets `WalletFallbackMark`, where the old chooser showed its first letter |
| Chooser: with no Signa and no wallets the chooser says so | Not ported. The dialog has no empty state: wagmi always lists the generic injected connector and Coinbase Wallet, and `test/lib/wallet-list.test.ts` ("keeps injected as the only way in when nothing is announced") keeps the injected one. A wallet that cannot connect shows its own error as an alert |
| Chooser: pending copy and errors as alerts | `external-wallet-dialog.test.tsx`: "says a Signa sign-in is connecting while it waits" (`Connecting, just a sec...`), "says which wallet is opening while it waits" (`Opening Rabby…`: the SDK's ellipsis character, where the old copy had three dots), "shows the wallet's own error as an alert, and nothing when the person declined" |
| Chooser: the frame's `allow` names the issuer, and the frame survives re-renders | `external-wallet-dialog.test.tsx`, "delegates passkeys to Signa by origin, is named Signa, and survives a re-render" |
| Chooser: size messages resize the frame and get theme tokens back, only from Signa; a page message retitles the dialog | `external-wallet-dialog.test.tsx`: "resizes to the height Signa reports, within bounds", "answers Signa's size message with the heading font, addressed to Signa only" and "retitles the dialog for the page Signa shows". One difference: the SDK's own reply to a size message carries design tokens and goes to target origin `*` for any message from the frame's window, where the old chooser answered only Signa's origin. The heading font Sticky adds goes to Signa's origin only |
| Chooser: closing cancels the attempt, closes the dialog and stops listening | `external-wallet-dialog.test.tsx`, "closing the chooser": the Cancel button, Escape and unmount |
| Chooser: the connect controller drives the chooser end to end | Every dialog test runs the SDK's real controller and modal; "connects the wallet that was picked, then closes" is the plain path |
| Callback: only a safe return route is followed | `center-callback.test.ts`, "restores only a bounded local page path" (the old rejections included); `center-runtime.test.ts`, "returns to any of Sticky's own pages, and only to a page it saved itself"; `center-callback-page.test.tsx`, "follows only a safe route back". The old client read the saved route once and removed it; HR keeps it until the next launch overwrites it, so a Retry can read it again |
| Callback: a framed or popup sign-in hands the callback to the Sticky page that started it | `center-callback-page.test.tsx`: "hands the callback to the Sticky page that opened this window" and "inside the sign-in frame"; `external-wallet-dialog.test.tsx`, "finishes the sign-in here when the frame delivers the callback" and "ignores a callback that does not come from the frame" |
| Callback: a full-page sign-in finishes here with the pinned callback URI and returns to the saved route | `center-callback-page.test.tsx`, "finishes a full-page sign-in with the pinned callback"; `center-runtime.test.ts`, "builds one wallet client for this origin with the exact callback" |
| Callback: a reload of the scrubbed callback retries the saved exchange without offering it upward | `center-callback-page.test.tsx`, "after a reload, when the code is already gone from the address bar" |
| Callback: a site without Signa refuses the callback | `center-callback-page.test.tsx`, "refuses on a site with no Signa configuration, and finishes when Retry is pressed once it has"; `center-runtime.test.ts`, "refuses to build a wallet client on a site that has no Signa configuration" |
| Callback: the code is cleared from the address bar before anything loads | `center-callback.test.ts`, "the module clears the address bar as it loads" (it clears on import, and the provider tree imports it first); `center-callback-page.test.tsx`, "has cleared the code from the address bar again, after the router wrote it back, before the SDK is asked anything" |
| Callback: the vendored bundle matches its hash | Not ported: the SDK comes from npm |
