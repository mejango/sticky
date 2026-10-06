import { expect, test } from '@playwright/test'
import { expectAxeClean, expectNoDocumentOverflow } from './page-checks'
import { PROJECT, viewports } from './suite'
import { blockExternalTraffic, settling } from './traffic'

// The Transfer form, opened by a visitor who has not signed in: what it asks for, that it fits every screen, and that it
// is accessible. Nothing is sent: there is no wallet to ask.

// The recorded Sticky project's Tokens tab, whose token can be transferred.
const TOKENS = `${PROJECT}#tokens`

for (const viewport of viewports) {
  test.describe(viewport.label, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('Transfer opens as a form that fits the screen, is accessible and closes with Escape', async ({ context, page }) => {
      const pageErrors: string[] = []
      page.on('pageerror', error => pageErrors.push(error.message))
      const externalTraffic = await blockExternalTraffic(context)
      const settled = settling(page)
      await page.emulateMedia({ reducedMotion: 'reduce' })

      await page.goto(TOKENS, { waitUntil: 'domcontentloaded' })
      await page.evaluate(() => document.fonts.ready)
      await settled()

      await page.getByRole('button', { name: 'Transfer', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Transfer', exact: true })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Recipient')).toBeVisible()
      await expect(dialog.getByLabel('Amount')).toBeVisible()
      await expect(dialog.getByText('Moved tokens start a new stick for the recipient.')).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Sign in to transfer' })).toBeVisible()

      const surface = `${viewport.label} Transfer form`
      await expectNoDocumentOverflow(page, surface)
      await expectAxeClean(page, surface)

      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()

      expect(pageErrors).toEqual([])
      expect(externalTraffic).toEqual({ http: [], webSockets: [] })
    })
  })
}
