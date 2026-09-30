// The environments of the Playwright suite's two builds. Both read every chain
// and indexer answer from the local fixture service
// (test/browser/fail-fast-service.mjs), so the suite opens no connection off
// this machine.

export const APP_PORT = Number(process.env.PLAYWRIGHT_APP_PORT ?? 8791)
export const SIGNA_PORT = Number(process.env.PLAYWRIGHT_SIGNA_PORT ?? 8792)
export const FIXTURE_PORT = Number(process.env.PLAYWRIGHT_FIXTURE_PORT ?? 8793)

export const fixtureOrigin =
  process.env.PLAYWRIGHT_FIXTURE_ORIGIN ?? `http://127.0.0.1:${FIXTURE_PORT}`

/** Each network's indexer is its own fixture path, so the fixture can tell a
 * mainnet question from the same question about testnets. */
const indexers = {
  NEXT_PUBLIC_BENDYSTRAW_URL: `${fixtureOrigin}/mainnet/graphql`,
  NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL: `${fixtureOrigin}/testnet/graphql`,
}

/** The pages under test: every Center read goes to the fixture's `/rpc/<network>`,
 * and wallets are off. */
export const deterministicEnv = {
  NEXT_DIST_DIR: '.next-browser',
  NEXT_PUBLIC_SITE_URL: fixtureOrigin,
  ...indexers,
  NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN: fixtureOrigin,
  NEXT_PUBLIC_DETERMINISTIC_BROWSER: 'true',
  NEXT_PUBLIC_VERSION: 'browser-test',
}

/** Signa's sign-in, as a deployment with Signa on runs it: wallets are on, and
 * Center is the fixture, which answers Center's `/v1/rpc/<chainId>`. The pins
 * have the shape a deployment's must have; the test models Signa at its real
 * origin, https://signa.center. */
export const signaEnv = {
  NEXT_DIST_DIR: '.next-signa',
  NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${SIGNA_PORT}`,
  ...indexers,
  NEXT_PUBLIC_JBCENTER_URL: fixtureOrigin,
  NEXT_PUBLIC_CENTER_WALLET_ENABLED: 'true',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID: 'browser-fixture',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION: `0x${'1'.repeat(64)}`,
  NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI: '1000000000000000',
  NEXT_PUBLIC_VERSION: 'browser-test',
}
