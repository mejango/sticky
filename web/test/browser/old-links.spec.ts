import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'
import { fixtureOrigin } from '../../scripts/browser-env.mjs'
import { HOLDER, PROJECT } from './suite'
import { blockExternalTraffic, settling } from './traffic'

// The old client's links all opened `/`, so an old link first shows the home
// of the production chains, which starts reading them before the router sends
// the visitor on. The recording holds the testnet world only, so those reads
// are refused here, before they reach the fixture.

async function refuseProductionHome(context: BrowserContext) {
  const refuse = (route: Route) => route.fulfill({ status: 503, json: { error: 'The production home is not recorded' } })
  await context.route('**/api/bendystraw/mainnet/query', refuse)
  for (const network of ['mainnet', 'optimism-mainnet', 'base-mainnet', 'arbitrum-mainnet']) {
    await context.route(`${fixtureOrigin}/rpc/${network}`, refuse)
  }
}

/** Opens `path`, counting the tab's history entries before any script of the page runs. */
async function openOldLink(page: Page, path: string) {
  await page.addInitScript(() => {
    ;(window as typeof window & { historyAtLoad?: number }).historyAtLoad = history.length
  })
  await page.goto(path)
}

const historyAdded = (page: Page) =>
  page.evaluate(() => history.length - (window as typeof window & { historyAtLoad?: number }).historyAtLoad!)

test.describe('old links', () => {
  let errors: string[]
  let traffic: Awaited<ReturnType<typeof blockExternalTraffic>>
  let settled: () => Promise<void>

  test.beforeEach(async ({ context, page }) => {
    errors = []
    page.on('pageerror', error => errors.push(error.message))
    traffic = await blockExternalTraffic(context)
    await refuseProductionHome(context)
    settled = settling(page)
  })

  test.afterEach(() => {
    expect(errors).toEqual([])
    expect(traffic).toEqual({ http: [], webSockets: [] })
  })

  test('a project link lands on its tab, in place of the old address', async ({ baseURL, page }) => {
    await openOldLink(page, '/?chain=84532#/project/42/tokens')

    await expect(page).toHaveURL(`${baseURL}${PROJECT}#tokens`)
    await expect(
      page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: 'Tokens', exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    expect(await historyAdded(page), 'the redirect replaces the old address').toBe(0)
    await settled()
  })

  test('an account link keeps the testnet', async ({ baseURL, page }) => {
    await openOldLink(page, `/?chain=84532#/account/${HOLDER}`)

    await expect(page).toHaveURL(`${baseURL}/account/${HOLDER}?network=testnet`)
    expect(await historyAdded(page), 'the redirect replaces the old address').toBe(0)
    await settled()
  })

  test("a testnet project's logo links home to the testnet", async ({ page }) => {
    await page.goto(PROJECT)

    const logos = page.locator('a.overscroll-slime, a.brand-slime')
    await expect(logos).toHaveCount(2)
    for (const logo of await logos.all()) await expect(logo).toHaveAttribute('href', '/?network=testnet')
    await settled()
  })
})
