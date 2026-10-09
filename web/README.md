# Sticky web

Sticky's Next app uses the shared Juice SDK review, Safe execution, request pacing and transaction presentation rules used by Juicebox Money, Revnet Money and Homerun. Sticky-specific launch, staking, rewards and bridge models live in `src/lib/`; React flows consume those models through the common transaction boundary. [COPIED.md](COPIED.md) records the original port provenance and shared owners.

## Development

Use the Node version in [.nvmrc](.nvmrc) and the npm version declared by [package.json](package.json), independently of the repository's contract toolchain. From this directory:

```sh
nvm use
npm install --global "$(node -p 'require("./package.json").packageManager')"
npm ci
cp .env.example .env.local
npm run dev
```

Fill `.env.local` from [.env.example](.env.example), using `http://127.0.0.1:8788` as the local site origin. Development serves that address. `NEXT_PUBLIC_*` values are public browser configuration; never put confidential RPC or API credentials in them. WalletConnect and Signa are optional; enabling Signa requires the complete valid manifest configuration described by the environment example and checked by `scripts/check-deployment-env.mjs`.

## Verification

```sh
npx playwright install chromium
NODE_OPTIONS=--no-experimental-webstorage npm run check
```

`check` runs the production dependency audit, lint, types, deployment/schema/transaction inventories, coverage, the production build and browser tests. [The web workflow](../.github/workflows/web.yml) also builds and starts the production Docker image as a non-root user and checks its revision. Browser tests use recorded fixtures; they do not establish live wallet or deployment outcomes.

`npm run deployments:check` compares `src/lib/sticky-deployments.json` and `src/lib/sticky-source-collectors.json` with verified contract records in `../deployments/`. Flat suite records require `kind: verified` and a successful creation receipt with nonzero block and transaction hashes; collector records additionally bind source/home identity, constructor arguments and the parent/child creation transaction. These are local consistency checks, so retain the live verification evidence described in [DEPLOYMENT.md](../DEPLOYMENT.md). After contract deployment, the root `deploy:post:*` scripts verify the suite, write artifacts and run this client's sync script. Commit both generated registries with the corresponding deployment records. Collector configuration is currently empty; predictions and rehearsals must not be added as live collectors.

## Deployment

Use this directory as the Railway service root (`/web`) and [railway.json](railway.json) as its configuration. The checked-in [Dockerfile](Dockerfile) installs locked dependencies, validates production configuration, builds the standalone app, and starts `scripts/start-production.mjs`. Do not retain the Python client's build or start command overrides.

Provide the public variables in [.env.example](.env.example) at build time. Production requires HTTPS site and both Bendystraw URLs, plus a revision from `NEXT_PUBLIC_VERSION` or Railway's `RAILWAY_GIT_COMMIT_SHA`; the Dockerfile carries them into its runtime. Public configuration changes require rebuilding. Before building outside Railway, run `node scripts/check-deployment-env.mjs build` with those variables exported; the Docker build runs the same check.

Readiness is `GET /api/healthz`, returning `{ "ok": true, "revision": "<built commit>" }` with no caching. Verify the exact expected revision after deployment. The Railway configuration uses a 60-second readiness timeout; the container runs as `node` on `$PORT` (3000 by default). A read-only container needs writable storage at `/app/.next/cache`, as exercised by CI.

The [cutover record](../tasks/sticky-next-cutover.md) documents the transition to this app. Legacy source and tests remain available at the [pre-cutover revision](https://github.com/mejango/sticky/tree/8bff9575f57807df244c1c41b9045f614ab7a76c/webclient). Dated audit and port records remain evidence about their recorded revisions.
