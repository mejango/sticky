import { expect, type BrowserContext, type Page } from '@playwright/test'
import { fixtureOrigin } from '../../scripts/browser-env.mjs'

function isLocalHostname(hostname: string) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

/** Answers the browser's requests to `prefix` from the fixture's recording, at `path` on the fixture. */
async function stubFromFixture(context: BrowserContext, prefix: string, path: string) {
  await context.route(`${prefix}**`, async route => {
    const response = await route.fetch({ url: `${fixtureOrigin}${path}${route.request().url().slice(prefix.length)}` })
    await route.fulfill({ response })
  })
}

/** Center's IPFS gateway and DexScreener answer from the fixture's recording.
 * Every other request off this machine is refused on the spot and counted. A
 * spec that models another origin routes it after this, which takes precedence. */
export async function blockExternalTraffic(context: BrowserContext) {
  const attempts = { http: [] as string[], webSockets: [] as string[] }
  await context.route(/^https?:\/\//, async route => {
    const url = route.request().url()
    if (isLocalHostname(new URL(url).hostname)) {
      await route.continue()
      return
    }
    attempts.http.push(url)
    // Fulfil locally instead of opening a socket. A fast HTTP failure lets
    // client libraries exercise their normal error handling without turning
    // an intentionally blocked fetch into an unhandled browser exception.
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'External browser traffic is disabled' }),
    })
  })
  await stubFromFixture(context, 'https://juicebox.center/ipfs/', '/ipfs/')
  await stubFromFixture(context, 'https://api.dexscreener.com/', '/dexscreener/')

  await context.routeWebSocket(
    url => !isLocalHostname(url.hostname),
    socket => {
      attempts.webSockets.push(socket.url())
      socket.close()
    },
  )
  return attempts
}

/** How long a page must go without a request in flight to count as done reading. */
const QUIET_MS = 750

/**
 * Watches the page's requests from here on, and returns a check that waits until every read it started has
 * answered and it shows no placeholder and nothing being confirmed. A recording run keeps only what a page asked
 * for before its test ended, so a test that checks a page before its reads are done would replay short.
 */
export function settling(page: Page) {
  let inFlight = 0
  let changed = Date.now()
  const asked = new Map<string, number>()
  page.on('request', request => {
    inFlight += 1
    changed = Date.now()
    const { pathname } = new URL(request.url())
    asked.set(pathname, (asked.get(pathname) ?? 0) + 1)
  })
  const finished = () => {
    inFlight -= 1
    changed = Date.now()
  }
  page.on('requestfinished', finished)
  page.on('requestfailed', finished)
  return async () => {
    try {
      await expect.poll(() => inFlight === 0 && Date.now() - changed >= QUIET_MS).toBe(true)
    } catch (error) {
      const busiest = [...asked].sort((a, b) => b[1] - a[1]).slice(0, 5)
      throw new Error(`The page never stopped reading. Most asked: ${JSON.stringify(busiest)}`, { cause: error })
    }
    await expect(page.locator('.skeleton-shimmer:visible')).toHaveCount(0)
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
  }
}
