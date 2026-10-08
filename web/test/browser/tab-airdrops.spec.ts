import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import deployments from '../../src/lib/sticky-deployments.json'
import { expectAxeClean, expectNoDocumentOverflow } from './page-checks'
import { HOLDER, PROJECT, viewports } from './suite'
import { blockExternalTraffic, settling } from './traffic'

// The Airdrops tab of the recorded project, whose Sticky token the distributor was funded for, as a visitor reads it and
// as two accounts do when the site is viewed as them (View as stands in for a connected wallet, which the suite has
// none of). Each state fits every screen and is accessible, as the other tabs are, and so is each form the tab opens.
// Nothing is sent: a form opens and closes, and sending is the wallet's.
//
// A recording runs the specs in the order of their file names, and each chain's head is fixed by its first read. The audit
// in test/browser-fixture.test.ts allows Bendystraw's answers about a minute from there on Arbitrum, and this spec replays
// the tab 16 times and reads nothing of Bendystraw's that site.spec.ts has not, so its name puts it after that spec.

const AIRDROPS = `${PROJECT}#airdrops`

/** The account View as keeps in the browser (`src/lib/viewAs.ts`). */
const VIEW_AS_KEY = 'jb-view-as-v1'

/** An account that trusts the largest holder to stick for it, and has not turned auto-stick on. */
const TRUSTING = '0x6dae5ac33cca5a3dd3633b8db01c04e46772a25f'

/** The recorded project's Sticky token, and the distributor of the deployment on its chain, Base Sepolia. */
const STICKY_TOKEN = '0xb4591bfc2cf3507228af5e34763c2f379179529c'
const DISTRIBUTOR = deployments['84532'].distributor

// What the recording holds of the project's airdrops: its Sticky token was funded twice, with 100 and 10 of one token for
// everyone, in a round that has ended. So the pot of that token shows what was sent and nothing to collect or vest, and
// the staked token's own pot, which the tab always lists, shows none sent.
const FUNDED_TOKEN = '0x1d9fbfedcf7b644edbaf6dcfa72a365ecad3a42e'
const NOTHING = { 'Claimable now': '0 ART', Vesting: 'None' }
const ROUND = /^Round \d+ ends [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s[AP]M\. Your share then vests over 4 rounds, a quarter each week, starting when you collect\.$/

/**
 * Opens `path` as `viewer` sees it, and waits until its reads are done. `settled` waits again for the reads a click
 * starts, and `done` checks what every page of the suite must leave: no page error, and no request off this machine.
 */
async function open(context: BrowserContext, page: Page, viewer: string | null, path = AIRDROPS) {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  const externalTraffic = await blockExternalTraffic(context)
  const settled = settling(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  if (viewer) await context.addInitScript(([key, account]) => localStorage.setItem(key, account), [VIEW_AS_KEY, viewer])

  await page.goto(path, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => document.fonts.ready)
  await settled()
  return {
    settled,
    done: () => {
      expect(pageErrors).toEqual([])
      expect(externalTraffic).toEqual({ http: [], webSockets: [] })
    },
  }
}

const card = (page: Page, name: string | RegExp) => page.getByRole('region', { name })

/** A pot's lines, by their labels. */
const linesOf = (pot: Locator) =>
  pot.locator('dt').evaluateAll(terms => Object.fromEntries(terms.map(term => [term.textContent, term.nextElementSibling?.textContent])))

/** The reward pots the tab lists: the funded token's, then the staked token's, each for everyone. */
async function expectPots(page: Page) {
  const rewards = card(page, 'Your rewards')
  const pots = rewards.getByRole('listitem')
  await expect(pots).toHaveCount(2)
  await expect(pots.nth(0)).toHaveAttribute('data-reward', `0:${FUNDED_TOKEN}`)
  await expect(pots.nth(1)).toHaveAttribute('data-reward', /^0:0x[0-9a-f]{40}$/)
  await expect(pots.nth(1)).not.toHaveAttribute('data-reward', `0:${FUNDED_TOKEN}`)
  await expect.poll(() => linesOf(pots.nth(0))).toEqual({ ...NOTHING, Funded: 'None this round. 110 ART in total.' })
  await expect.poll(() => linesOf(pots.nth(1))).toEqual({ ...NOTHING, Funded: 'None this round. 0 ART in total.' })
  await expect(rewards.getByText(/^Round \d+ ends /)).toHaveText(ROUND)
}

/** The page as it is now: inside the screen, and accessible. */
async function expectFits(page: Page, surface: string) {
  await expectNoDocumentOverflow(page, surface)
  await expectAxeClean(page, surface)
}

/** A form that `open` opens: it is named `name`, shows what `shows` asks for, fits the screen and closes with Escape. */
async function expectForm(
  page: Page,
  surface: string,
  name: string,
  open: () => Promise<void>,
  shows: (dialog: Locator) => Promise<unknown>,
) {
  await open()
  const dialog = page.getByRole('dialog', { name, exact: true })
  await expect(dialog).toBeVisible()
  await shows(dialog)
  await expectFits(page, `${surface}, its ${name} form`)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
}

for (const viewport of viewports) {
  test.describe(viewport.label, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } })

    test('a visitor opens the tab, reads what was funded, and has no card that needs an account', async ({ baseURL, context, page }) => {
      const surface = `${viewport.label} visitor's Airdrops tab`
      const visit = await open(context, page, null, PROJECT)

      const tab = page.getByRole('tablist', { name: 'Project sections' }).getByRole('tab', { name: 'Airdrops', exact: true })
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
      await expect(page).toHaveURL(`${baseURL}${AIRDROPS}`)
      await visit.settled()
      await expect(card(page, 'Stick for someone else')).toBeVisible()
      await expect(card(page, 'Send airdrop rewards')).toBeVisible()
      await expect(card(page, 'Who can stick for you')).toBeVisible()
      await expectPots(page)

      // What belongs to an account is left out: no auto-stick, and no list of who can stick for it, not even an empty one.
      await expect(card(page, /^Auto-stick/)).toHaveCount(0)
      await expect(page.getByText('None yet', { exact: true })).toHaveCount(0)
      await expect(card(page, 'Who can stick for you').getByRole('button', { name: 'Trust', exact: true })).toBeVisible()
      await expect(card(page, 'Stick for someone else').getByRole('button', { name: 'Sign in to stick' })).toBeVisible()
      await expectFits(page, surface)

      await expectForm(
        page,
        surface,
        'Airdrop',
        () => card(page, 'Send airdrop rewards').getByRole('button', { name: 'Send', exact: true }).click(),
        dialog =>
          Promise.all([
            expect(dialog.getByLabel('From chain')).toBeVisible(),
            expect(dialog.getByLabel('Airdropped token')).toBeVisible(),
            expect(dialog.getByLabel('Minimum stake age (weeks)')).toBeVisible(),
            expect(dialog.getByLabel('Maximum stake age (weeks)')).toBeVisible(),
            expect(dialog.getByLabel('Amount')).toBeVisible(),
            expect(dialog.getByRole('button', { name: 'Sign in to send' })).toBeVisible(),
          ]),
      )
      await expectForm(
        page,
        surface,
        'Airdrop across chains',
        async () => {
          await card(page, 'Send airdrop rewards').getByRole('button', { name: 'Send', exact: true }).click()
          await page.getByRole('dialog', { name: 'Airdrop', exact: true }).getByLabel('From chain').selectOption('11155420')
        },
        dialog => Promise.all([
          expect(dialog.getByLabel('Origin project token')).toBeVisible(),
          expect(dialog.getByLabel('Minimum stake age (weeks)')).toBeVisible(),
          expect(dialog.getByLabel('Maximum stake age (weeks)')).toBeVisible(),
          expect(dialog.getByLabel('Amount', { exact: true })).toBeVisible(),
          expect(dialog.getByRole('button', { name: 'Review transfer' })).toBeDisabled(),
          expect(dialog.getByRole('button', { name: 'Find bridge' })).toBeVisible(),
        ]),
      )
      await expectForm(
        page,
        surface,
        'Trust a sender',
        () => card(page, 'Who can stick for you').getByRole('button', { name: 'Trust', exact: true }).click(),
        dialog =>
          Promise.all([
            expect(dialog.getByLabel('Sender address')).toBeVisible(),
            expect(dialog.getByRole('button', { name: 'Sign in to trust' })).toBeVisible(),
          ]),
      )

      visit.done()
    })

    test('the largest holder has auto-stick on, and no other sender listed', async ({ context, page }) => {
      const surface = `${viewport.label} holder's Airdrops tab`
      const visit = await open(context, page, HOLDER)

      await expect(page.getByText('Viewing as 0x042F…203A')).toBeVisible()
      await expectPots(page)
      const autoStick = card(page, 'Auto-stick ART rewards')
      const state = autoStick.locator('[data-autostick-state]')
      await expect(state.locator('strong')).toHaveText('On')
      await expect(state).toContainText('Unlocked ART rewards auto-stick when at least 1 ART is ready, at most once every 1d 0h.')
      await expect(state).toContainText('0 ART ready | minimum 1')
      await expect(autoStick.getByRole('button', { name: 'Turn off auto-stick' })).toBeVisible()
      await expect(autoStick.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
      // The auto-stick adapter is trusted too, and is not listed: the auto-stick card presents its trust.
      const senders = card(page, 'Who can stick for you')
      await expect(senders.getByText('None yet', { exact: true })).toBeVisible()
      await expect(senders.getByText("Only you and the project's trusted senders can stick for you.")).toBeVisible()
      await expect(senders.getByRole('listitem')).toHaveCount(0)
      await expectFits(page, surface)

      await expectForm(
        page,
        surface,
        'Auto-stick settings',
        () => autoStick.getByRole('button', { name: 'Settings', exact: true }).click(),
        dialog =>
          Promise.all([
            expect(dialog.getByLabel('Minimum ART per auto-stick')).toHaveValue('1'),
            expect(dialog.getByRole('button', { name: 'Save settings' })).toBeVisible(),
          ]),
      )

      visit.done()
    })

    test('an account that trusts a sender lists them, and its auto-stick is off', async ({ context, page }) => {
      const surface = `${viewport.label} trusting account's Airdrops tab`
      const visit = await open(context, page, TRUSTING)

      await expect(page.getByText('Viewing as 0x6DAE…A25F')).toBeVisible()
      await expectPots(page)
      const autoStick = card(page, 'Auto-stick ART rewards')
      const state = autoStick.locator('[data-autostick-state]')
      await expect(state.locator('strong')).toHaveText('Off')
      await expect(state).toContainText('Unlocked ART rewards stay claimable until you collect them.')
      await expect(autoStick.getByRole('button', { name: 'Turn on auto-stick' })).toBeVisible()
      await expect(autoStick.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0)

      const senders = card(page, 'Who can stick for you')
      await expect(senders.getByRole('listitem')).toHaveCount(1)
      await expect(senders.getByRole('listitem')).toContainText('0x042f…203a')
      await expect(senders.getByText('None yet', { exact: true })).toHaveCount(0)
      await expectFits(page, surface)

      await expectForm(
        page,
        surface,
        'Untrust sender',
        () => senders.getByRole('button', { name: 'Untrust' }).click(),
        dialog =>
          Promise.all([
            expect(dialog.getByText(HOLDER, { exact: true })).toBeVisible(),
            expect(dialog.getByRole('button', { name: 'Sign in to untrust' })).toBeVisible(),
          ]),
      )
      await expectForm(
        page,
        surface,
        'Turn on auto-stick',
        () => autoStick.getByRole('button', { name: 'Turn on auto-stick' }).click(),
        dialog =>
          Promise.all([
            expect(dialog.getByLabel('Minimum ART per auto-stick')).toHaveValue('1'),
            expect(dialog.getByRole('button', { name: 'Turn on auto-stick' })).toBeVisible(),
          ]),
      )

      visit.done()
    })

    test('the split recipe and the reward address open without leaving the screen', async ({ context, page }) => {
      const visit = await open(context, page, null)

      const send = card(page, 'Send airdrop rewards')
      await send.getByText("Recurring rewards from a Juicebox project's splits").click()
      await send.getByText('Reward address for fee payouts and transfers').click()
      await visit.settled()

      const split = send.locator('[data-split-recipe]')
      await expect(split).toContainText(DISTRIBUTOR)
      await expect(split).toContainText(new RegExp(`Beneficiary${STICKY_TOKEN}`, 'i'))
      await expect(split).toContainText('Project ID0 (reward group: everyone)')
      const receiver = send.locator('[data-receiver]')
      await expect(receiver).toContainText(/Reward address0x[0-9a-fA-F]{40}/)
      await expect(receiver).toContainText('StatusNot created yet')
      await expect(send.locator('[data-arrivals]')).toHaveText('0 ART waiting to settle')
      await expectFits(page, `${viewport.label} Airdrops tab, its split recipe and reward address open`)

      visit.done()
    })
  })
}
