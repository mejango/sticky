import { randomBytes, randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { PROJECT } from './suite'
import { blockExternalTraffic, settling } from './traffic'

// The real Signa build of the site and the pinned connect SDK, with Signa's
// answers modeled here. This is not server authorization, passkey or chain
// evidence. Ported from Homerun's test/center-browser.mjs.

const issuer = 'https://signa.center'
const audience = 'https://api.signa.center'
const wallet = '0x1111111111111111111111111111111111111111'

type HandoffRequest = { callbackUri: string; origin: string; issuer: string; requestKey: string; state: string; expiresAtMs: number }

const scrollOf = (page: Page) => page.evaluate(() => window.scrollY)

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })

test('Signa signs in inside its frame, hands the callback up and scrubs it', async ({ baseURL, context, page }, testInfo) => {
  const base = baseURL!
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const externalTraffic = await blockExternalTraffic(context)
  const settled = settling(page)

  const intentId = randomBytes(32).toString('base64url')
  const code = randomBytes(32).toString('base64url')
  let request: HandoffRequest | undefined
  let originalExchange: unknown
  let grant: Record<string, unknown> | undefined
  let exchanges = 0
  let launches = 0
  let release!: () => void
  let holdExchange!: () => void
  let releaseExchange!: () => void
  const continuing = new Promise<void>(resolve => { release = resolve })
  const exchangeStarted = new Promise<void>(resolve => { holdExchange = resolve })
  const continueExchange = new Promise<void>(resolve => { releaseExchange = resolve })
  const cors = {
    'access-control-allow-origin': base,
    'access-control-allow-headers': 'content-type,x-center-wallet-request',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  }

  await context.route(`${issuer}/**`, async route => {
    const http = route.request()
    const url = new URL(http.url())
    if (http.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    const json = (value: unknown) => route.fulfill({ json: value, headers: cors })
    if (url.pathname === '/wallet/config') {
      return json({
        version: 'center-wallet-v1',
        issuer,
        audience,
        rpId: new URL(issuer).hostname,
        app: { origin: base, callbackUris: [`${base}/center/callback`], generation: 1 },
      })
    }
    if (url.pathname === '/wallet/handoff/prepare') {
      expect(http.headers().cookie).toBeUndefined()
      request = http.postDataJSON().request as HandoffRequest
      expect(request.callbackUri).toBe(`${base}/center/callback`)
      expect(request.origin).toBe(base)
      expect(request.issuer).toBe(issuer)
      expect(request.requestKey).toMatch(/^0x[0-9a-f]{40}$/)
      await continuing
      return json({ id: intentId, request, state: 'prepared', createdAtMs: Date.now(), expiresAtMs: request.expiresAtMs })
    }
    if (url.pathname === '/wallet') {
      expect(url.searchParams.get('intent')).toBe(intentId)
      const callback = new URL(`${base}/center/callback`)
      callback.searchParams.set('code', code)
      callback.searchParams.set('state', request!.state)
      callback.searchParams.set('iss', issuer)
      // The page keeps the theme each message brings: the connect SDK's tokens
      // and font, and Sticky's heading font. It returns the way Signa's
      // wallet.ts does, with location.replace, so the frame adds no history.
      return route.fulfill({
        contentType: 'text/html',
        body: `<h1>Modeled Signa approval</h1><a href="${callback.href.replaceAll('&', '&amp;')}"
        onclick="event.preventDefault();location.replace(this.href)">Return to Sticky</a>
      <script>addEventListener('message',event=>{if(event.source===parent&&event.origin===${JSON.stringify(base)}&&event.data?.type==='juicebox-center:theme'){
        const theme=event.data.theme||{};if(typeof theme.font==='string')document.documentElement.dataset.font=theme.font;
        if(typeof theme.headingFont==='string')document.documentElement.dataset.headingFont=theme.headingFont;
      }});parent.postMessage({type:'juicebox-center:size',height:240},${JSON.stringify(base)});</script>`,
      })
    }
    if (url.pathname === '/wallet/launch') {
      expect(http.method()).toBe('POST')
      expect(http.headers().origin).toBe(base)
      // The launch form is submitted into the frame the dialog shows, never into this page or a popup.
      expect(http.isNavigationRequest()).toBe(true)
      expect(http.resourceType()).toBe('document')
      expect(http.frame().name()).toBe('juicebox-center-frame')
      const form = new URLSearchParams(http.postData() ?? '')
      expect([...form.keys()].sort()).toEqual(['intentId', 'signature'])
      expect(form.get('intentId')).toBe(intentId)
      expect(form.get('signature')).toMatch(/^0x[0-9a-f]{130}$/)
      launches += 1
      // Use a new navigation to keep the modeled issuer entirely intercepted;
      // Playwright routes only the first request in an HTTP redirect chain.
      return route.fulfill({
        contentType: 'text/html',
        body: `<script>location.replace(${JSON.stringify(`${issuer}/wallet?intent=${intentId}`)})</script>`,
      })
    }
    if (url.pathname === '/wallet/handoff/exchange') {
      expect(http.headers().cookie).toBeUndefined()
      // The exchange runs in the original page after the frame handed its callback up.
      expect(page.url(), 'the page never left for the exchange').toBe(`${base}${PROJECT}`)
      const body = http.postDataJSON()
      if (originalExchange) expect(body, 'retry preserves the exact signed exchange').toEqual(originalExchange)
      else originalExchange = body
      expect(body.intentId).toBe(intentId)
      expect(body.code).toBe(code)
      expect(body.request).toEqual(request)
      exchanges += 1
      if (!grant) {
        const now = Math.floor(Date.now() / 1000)
        grant = {
          kind: 'wallet-app', id: randomUUID(), incarnation: '1', accountId: `eip155:8453:${wallet}`,
          signerAddress: request!.requestKey, scopes: ['read', 'plan', 'relay'], origin: base,
          callbackUri: `${base}/center/callback`, audience, appGeneration: 1, authorityEpoch: '1', sessionEpoch: '1',
          createdAt: now, expiresAt: now + 3600, revokedAt: null, retainUntil: now + 3600 + 86400,
        }
      }
      if (exchanges === 1) {
        holdExchange()
        await continueExchange
        return route.abort('failed')
      }
      return json({ grant, replayed: true })
    }
    return route.fulfill({ status: 404 })
  })

  const callbackPage = await context.request.get(`${base}/center/callback`)
  expect(callbackPage.headers()['cache-control']).toBe('no-store')
  expect(callbackPage.headers()['referrer-policy']).toBe('strict-origin')
  expect(await callbackPage.text(), 'callback content is hidden on the first server-rendered frame').toMatch(/visibility:hidden/)

  // The home, then a project, so the history has a page to go back to.
  await page.goto('/?network=testnet')
  await settled()
  await expect.poll(() => scrollOf(page), { message: 'the page loads scrolled past its top fold' }).toBe(50)
  const lists = page.getByRole('tablist', { name: 'Homepage lists' })
  await lists.getByRole('tab', { name: 'Stickiest' }).click()
  await page.locator(`a[data-card][href="${PROJECT}"]`).click()
  await expect(page).toHaveURL(`${base}${PROJECT}`)
  await settled()
  await expect.poll(() => scrollOf(page), { message: 'a new page folds again' }).toBe(50)

  const signIn = page.getByRole('button', { name: 'Sign in', exact: true })
  await signIn.click()
  await expect(page.locator('.jb-connect-powered')).toBeHidden()
  await expect(page.locator('.jb-connect-primary')).toHaveText(/^(Touch ID|Face ID|Windows Hello|Device)$/)
  const primaryBox = await page.locator('.jb-connect-primary').boundingBox()
  const dividerBox = await page.locator('.jb-connect-divider').boundingBox()
  expect(primaryBox && dividerBox && dividerBox.y - primaryBox.y - primaryBox.height < 24,
    'the wallet choices sit close to the primary button').toBe(true)
  const close = page.getByRole('button', { name: 'Cancel', exact: true })
  const closeBox = await close.boundingBox()
  const titleBox = await page.getByRole('heading', { name: 'Sign in', exact: true }).boundingBox()
  const dialogBox = await page.getByRole('dialog').boundingBox()
  expect(closeBox && titleBox && dialogBox && closeBox.width >= 44 && closeBox.height >= 44 &&
    closeBox.y < titleBox.y + titleBox.height && closeBox.x > dialogBox.x + dialogBox.width / 2 &&
    closeBox.x + closeBox.width <= dialogBox.x + dialogBox.width,
  'the accessible cancellation control is a full-size top-right X').toBe(true)
  await close.focus()
  await expect(close).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(signIn).toBeFocused()

  await signIn.click()
  await page.locator('.jb-connect-primary').click()
  await expect.poll(() => request, { timeout: 10_000 }).toBeDefined()
  await expect(page.locator('.jb-connect-status')).toHaveText('Connecting, just a sec...')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  release()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.waitForTimeout(300)
  expect(page.url(), 'closing the chooser cancels delayed navigation').toBe(`${base}${PROJECT}`)

  await signIn.click()
  await page.locator('.jb-connect-primary').click()
  // Signa opens in a frame inside the dialog; the page stays on the project and opens no window.
  const frame = page.frameLocator('iframe[name="juicebox-center-frame"]')
  await frame.getByRole('heading', { name: 'Modeled Signa approval' }).waitFor()
  await expect(page.locator('iframe[name="juicebox-center-frame"]')).toHaveAttribute('title', 'Signa')
  const headingFont = await page.getByRole('heading', { name: 'Sign in', exact: true })
    .evaluate(node => getComputedStyle(node).fontFamily)
  await expect(frame.locator('html')).toHaveAttribute('data-heading-font', headingFont)
  await expect(frame.locator('html')).toHaveAttribute('data-font', /sans-serif$/)
  // What Signa is told to draw with, for the report: next/font's generated
  // family names, then the fallbacks, where the old client named its faces.
  const fonts = await frame.locator('html').evaluate(node => ({
    font: node.getAttribute('data-font'),
    headingFont: node.getAttribute('data-heading-font'),
  }))
  testInfo.annotations.push({ type: 'signa-fonts', description: JSON.stringify(fonts) })
  await frame.locator('body').evaluate((_, target) =>
    parent.postMessage({ type: 'juicebox-center:page', page: 'signup' }, target), base)
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-label', 'Sign up')
  await expect(page.getByRole('heading', { name: 'Sign up', exact: true })).toBeVisible()
  await frame.locator('body').evaluate((_, target) =>
    parent.postMessage({ type: 'juicebox-center:page', page: 'signin' }, target), base)
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  expect(page.url()).toBe(`${base}${PROJECT}`)
  expect(context.pages(), 'no popup opened').toHaveLength(1)
  await expect(page.getByRole('dialog')).toBeVisible()

  await frame.getByRole('link', { name: 'Return to Sticky' }).click()
  await exchangeStarted
  await expect(frame.getByRole('heading', { name: 'Signing you in…' })).toBeVisible()
  await expect.poll(() => frame.locator('main').evaluate(node => getComputedStyle(node).paddingTop)).toBe('20px')
  await expect.poll(() => page.locator('iframe[name="juicebox-center-frame"]')
    .evaluate(node => node.getBoundingClientRect().height)).toBeLessThan(200)
  releaseExchange()
  // The callback page inside the frame hands its URL up to the page; the lost first exchange shows there.
  await expect(page.locator('.jb-connect-error')).toContainText('Retry the pending connection')
  await expect(page.locator('iframe[name="juicebox-center-frame"]')).toHaveCount(0)
  await page.locator('.jb-connect-primary').click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page).toHaveURL(`${base}${PROJECT}`)
  const signedIn = page.getByRole('button', { name: /^Signed in/ })
  await expect(signedIn).toBeVisible()
  expect(exchanges).toBe(2)
  expect(launches).toBe(1)
  expect(context.pages(), 'no window was opened').toHaveLength(1)
  await settled()
  expect(await scrollOf(page), 'signing in keeps the page past its fold').toBe(50)

  // The frame's navigations left no history in this tab: Back leaves the
  // project for the home, and Forward returns to it, signed in, past the fold.
  await page.goBack()
  await expect(page).toHaveURL(`${base}/?network=testnet`)
  await settled()
  await expect.poll(() => scrollOf(page)).toBeGreaterThanOrEqual(50)
  await page.goForward()
  await expect(page).toHaveURL(`${base}${PROJECT}`)
  await expect(signedIn).toBeVisible()
  await settled()
  await expect.poll(() => scrollOf(page)).toBeGreaterThanOrEqual(50)

  // A callback page reached without an opener scrubs its address before anything else, then completes on its own.
  const direct = await context.newPage()
  await direct.goto(`${base}/center/callback?code=${code}&state=x&iss=${encodeURIComponent(issuer)}`)
  await expect(direct.getByRole('status')).toContainText(/no matching wallet callback/i)
  expect(await direct.locator('main').evaluate(node => getComputedStyle(node).paddingTop),
    'full-page callback keeps its own spacing').toBe('64px')
  expect(await direct.evaluate(() => location.href), 'callback secrets are scrubbed').toBe(`${base}/center/callback`)
  await direct.close()

  await page.reload()
  await expect(signedIn).toBeVisible()
  await expect.poll(() => scrollOf(page), { message: 'a reload folds again' }).toBeGreaterThanOrEqual(50)
  const account = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(name => name.startsWith('center.wallet.connection.v1:'))
    return key ? JSON.parse(sessionStorage.getItem(key)!).grant.accountId : null
  })
  expect(account).toBe(`eip155:8453:${wallet}`)
  await signedIn.click()
  // The menu reads the account's balance on the project's chain before it goes.
  await expect(page.getByText('Base Sepolia', { exact: true })).toBeVisible()
  await expect(page.getByText('Loading…', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(signIn).toBeVisible()
  expect(await page.evaluate(() =>
    Object.keys(sessionStorage).filter(key => key.startsWith('center.wallet.connection.v1:')).length)).toBe(0)

  expect(errors).toEqual([])
  expect(externalTraffic).toEqual({ http: [], webSockets: [] })
})
