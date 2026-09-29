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
| `vitest.config.mts` | HR `vitest.config.ts` | HR d30cfbe | Named `.mts`: with no `"type": "module"` in `package.json`, Vite 8.3 warns on every run about ESM syntax in a `.ts` config. `setupFiles` is `./test/setup.ts`. |
| `knip.json` | JBM `knip.json` (HR has none) | JBM 68e1e88 | Kept the `start-production.mjs`, `page.browsertest.tsx` and `fail-fast-service.mjs` entries, the connector SDK ignores, `tsx` and `../server.js`. Dropped the Para, HeartbeatWorker and jbm-only script entries. |
| `.gitignore` | HR `.gitignore` and JBM `.gitignore` | HR d30cfbe, JBM 68e1e88 | Dropped HR's Solidity, deployment and `public/assets/` entries: Sticky commits its artwork under `public/assets/`. Added JBM's `coverage/`, `playwright-report/` and `.playwright/`. |
| `.env.example` | HR `.env.example` and JBM `.env.example` | HR d30cfbe, JBM 68e1e88 | Names only, no values. Para and Foundry variables dropped. |
| `AGENTS.md`, `CLAUDE.md` | HR `AGENTS.md`, `CLAUDE.md` | HR d30cfbe | None. This is the block Next 16.3.3 writes on `next dev`. |
| `next.config.js` | JBM `next.config.js` | JBM 68e1e88 | Removed the `webpack` hook (the Para aliases and the HeartbeatWorker replacement). `frame-ancestors` names only `https://app.safe.global https://app.5afe.dev`. The site-wide headers skip `/center/callback`, which has its own set: `Cache-Control: no-store`, `Referrer-Policy: strict-origin` (HR's `next.config.ts`), `frame-ancestors 'self'` and `nosniff`. The redirect is `www.sticky.center` to `https://sticky.center`. |
| `test/setup.ts` | HR `test/runtime/setup.ts` (HR has no `test/setup.ts`) | HR d30cfbe | None. JBM's `test/setup.ts` is the same file without the `vi.clearAllMocks()` line. |
| `test/smoke.test.ts` | New. Loads `next.config.js` with `createRequire`, as JBM's `test/safe-app-config.test.ts` and `test/www-redirect.test.ts` do | JBM 68e1e88 | Runs header and redirect requests through Next's `unstable_getResponseFromNextConfig`, so the matching is Next's. |

`src/app/layout.tsx` and `src/app/page.tsx` are written for Sticky and copy nothing.
