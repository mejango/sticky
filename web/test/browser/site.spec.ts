import { expect, test } from '@playwright/test'
import { expectAxeClean, expectNoDocumentOverflow } from './page-checks'
import { HOLDER, PROJECT, viewports } from './suite'
import { blockExternalTraffic, settling } from './traffic'

const routes = [
  { path: '/?network=testnet', surface: 'home' },
  { path: PROJECT, surface: 'project' },
  { path: `${PROJECT}#tokens`, surface: 'project tokens' },
  { path: `/account/${HOLDER}?network=testnet`, surface: 'account' },
  { path: `${PROJECT}#airdrops`, surface: 'project airdrops' },
] as const

function securityHeaders(headers: Record<string, string>) {
  expect(headers['content-security-policy']).toContain(
    'frame-ancestors https://app.safe.global https://app.5afe.dev',
  )
  expect(headers['x-frame-options']).toBeUndefined()
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  expect(headers['permissions-policy']).toContain('camera=()')
  expect(headers['permissions-policy']).toContain('microphone=()')
  expect(headers['permissions-policy']).toContain('geolocation=()')
}

for (const viewport of viewports) {
  test.describe(viewport.label, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    for (const route of routes) {
      test(`${route.path} keeps its production shape and safety invariants`, async ({
        context,
        page,
      }) => {
        const pageErrors: string[] = []
        page.on('pageerror', error => pageErrors.push(error.message))
        const externalTraffic = await blockExternalTraffic(context)
        const settled = settling(page)
        await page.emulateMedia({ reducedMotion: 'reduce' })

        const response = await page.goto(route.path, { waitUntil: 'domcontentloaded' })
        expect(response?.status()).toBe(200)
        securityHeaders(response?.headers() ?? {})

        await page.evaluate(() => document.fonts.ready)
        await expect(page.locator('main:visible')).toHaveCount(1)
        await settled()

        const surface = `${viewport.label} ${route.surface}`
        await expectNoDocumentOverflow(page, surface)
        await expectAxeClean(page, surface)

        await page.waitForTimeout(500)
        expect(pageErrors).toEqual([])
        expect(externalTraffic).toEqual({ http: [], webSockets: [] })
      })
    }
  })
}
