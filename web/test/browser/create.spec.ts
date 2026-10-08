import { expect, test } from '@playwright/test'
import { expectAxeClean, expectNoDocumentOverflow } from './page-checks'
import { viewports } from './suite'
import { blockExternalTraffic } from './traffic'

for (const viewport of viewports) {
  test.describe(viewport.label, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('opens the create flow with the reviewed defaults and closes with Escape', async ({ context, page }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const traffic = await blockExternalTraffic(context)
      let releaseScripts!: () => void
      const scriptsReady = new Promise<void>(resolve => { releaseScripts = resolve })
      await page.route('**/_next/static/**/*.js', async route => {
        await scriptsReady
        await route.continue()
      })
      await page.goto('/?network=testnet', { waitUntil: 'commit' })
      // The dashboard entry remains available while the empty-state hero also
      // offers creation. A cold server-rendered button must not accept a click
      // until its handlers exist; host loading after that remains buffered.
      const create = page.getByRole('button', { name: 'Make your token sticky', exact: true }).first()
      try { await expect(create).toBeDisabled() } finally { releaseScripts() }
      await create.click()

      const dialog = page.getByRole('dialog', { name: 'Make your token sticky' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Token address or Juicebox project ID')).toHaveValue('')
      await expect(dialog.getByLabel('Stickiness bonus')).toHaveValue('10')
      await expect(dialog.getByRole('combobox', { name: 'Networks', exact: true })).toHaveValue('testnet')
      await expect(dialog.getByLabel(/^Lock transfers/)).not.toBeChecked()
      const availableChains = dialog.getByRole('group', { name: 'Launch on' }).locator('input[type="checkbox"]:enabled')
      expect(await availableChains.count()).toBeGreaterThan(0)
      for (const chain of await availableChains.all()) await expect(chain).toBeChecked()
      await expect(dialog.getByRole('button', { name: 'Connect an external wallet' })).toBeVisible()
      await expectNoDocumentOverflow(page, `${viewport.label} create`)
      await expectAxeClean(page, `${viewport.label} create`)

      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      expect(errors).toEqual([])
      expect(traffic).toEqual({ http: [], webSockets: [] })
    })
  })
}
