import { expect, test, type Page, type Route } from '@playwright/test'
import { fixtureOrigin } from '../../scripts/browser-env.mjs'
import { PROJECT } from './suite'
import { blockExternalTraffic, settling } from './traffic'

// A reload hydrates the page over what the browser kept of the last visit. A view that rendered the kept copy while
// it hydrated would no longer match the server's HTML (React #418), so any page error fails the test. And the kept
// copy still paints before the network answers.

const RELOADS = 4
const STORE_KEY = 'sticky:query-cache:v1'

const views = [
  {
    name: 'a project page',
    path: PROJECT,
    kept: '"sticky-project"',
    shown: (page: Page) => page.getByRole('heading', { level: 1, name: 'E2ES E2E Sticky' }),
  },
  {
    name: 'the home',
    path: '/?network=testnet',
    kept: '"sticky-home"',
    // A project named in Latest, which a phone shows first as well.
    shown: (page: Page) => page.locator('#home-panel-latest a[href^="/"]').first(),
  },
] as const

for (const width of [390, 1280]) {
  test.describe(`${width} px`, () => {
    test.use({ viewport: { width, height: 900 } })

    for (const view of views) {
      test(`${view.name} reloads over its kept reads as the server rendered it, and paints them first`, async ({
        context,
        page,
      }) => {
        const errors: string[] = []
        page.on('pageerror', error => errors.push(error.message))
        const traffic = await blockExternalTraffic(context)
        const settled = settling(page)

        await page.goto(view.path)
        await settled()
        // The store is written a moment after the reads settle.
        await expect
          .poll(() => page.evaluate(([key, part]) => localStorage.getItem(key)?.includes(part) ?? false, [STORE_KEY, view.kept]))
          .toBe(true)

        for (let reload = 0; reload < RELOADS; reload += 1) {
          await page.reload()
          await settled()
        }

        // With every read held, what shows is what the browser kept.
        let release!: () => void
        const held = new Promise<void>(resolve => {
          release = resolve
        })
        const hold = async (route: Route) => {
          await held
          await route.fallback()
        }
        await context.route('**/api/bendystraw/**', hold)
        await context.route(`${fixtureOrigin}/rpc/**`, hold)
        await page.reload({ waitUntil: 'domcontentloaded' })
        await expect(view.shown(page)).toBeVisible()
        release()
        await settled()

        expect(errors).toEqual([])
        expect(traffic).toEqual({ http: [], webSockets: [] })
      })
    }
  })
}
