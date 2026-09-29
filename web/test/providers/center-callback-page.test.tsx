import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ISSUER = 'https://signa.center'
const ORIGIN = window.location.origin
const CONFIG = {
  issuer: ISSUER,
  audience: 'https://api.signa.center',
  manifest: { id: 'reviewed-base-passkey', revision: `0x${'11'.repeat(32)}` },
  maximumNetworkFee: '100000000000000',
}
const RETURN_KEY = 'sticky:center:return:v2'
const CODE_PATH = `/center/callback?code=abc&state=def&iss=${encodeURIComponent(ISSUER)}`

const mocks = vi.hoisted(() => {
  const payments = { pendingPayment: vi.fn(), refreshPayment: vi.fn(), completePayment: vi.fn() }
  return {
    payments,
    deliver: vi.fn(),
    connect: vi.fn(),
    createClient: vi.fn(),
    config: null as unknown,
    signa: { id: 'juicebox-center', uid: 'signa-uid' },
    wagmi: { connectors: [] as { id: string; uid: string }[], state: { current: null as string | null } },
    wallet: {
      completeConnection: vi.fn(),
      retryConnection: vi.fn(),
      payments: () => payments,
    },
  }
})

vi.mock('@bananapus/nana-sdk-connect/core', () => ({
  createCenterWalletClient: mocks.createClient,
  deliverCenterCallback: mocks.deliver,
}))
vi.mock('@wagmi/core', () => ({ connect: mocks.connect }))
vi.mock('@/providers/Providers', () => ({ get wagmiConfig() { return mocks.wagmi } }))
vi.mock('@/providers/wallet-config', () => ({ get CENTER_WALLET_CONFIG() { return mocks.config } }))

let host: HTMLDivElement
let root: Root
let replace: ReturnType<typeof vi.fn>
/** What the address bar showed each time the SDK was handed the callback. */
let searchSeenBySdk: string[]

beforeEach(() => {
  mocks.config = CONFIG
  mocks.wagmi.connectors = [{ id: 'injected', uid: 'injected-uid' }, mocks.signa]
  mocks.wagmi.state.current = null
  mocks.payments.pendingPayment.mockReturnValue(null)
  mocks.deliver.mockImplementation(async () => {
    searchSeenBySdk.push(document.location.search)
    return false
  })
  mocks.createClient.mockReturnValue(mocks.wallet)
  mocks.wallet.completeConnection.mockResolvedValue({})
  mocks.wallet.retryConnection.mockResolvedValue({})
  mocks.payments.completePayment.mockResolvedValue({})
  mocks.payments.refreshPayment.mockResolvedValue({})
  searchSeenBySdk = []
  window.sessionStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  window.history.replaceState(null, '', '/')
  window.sessionStorage.clear()
})

// The page is a fresh load every time: the address bar first, then the page's own modules.
async function load(path: string) {
  window.history.replaceState(null, '', path)
  vi.resetModules()
  return (await import('@/app/center/callback/page')).default
}

// jsdom cannot navigate: watch where the page would send the tab. Everything else is the real address bar.
function watchNavigation() {
  replace = vi.fn()
  vi.stubGlobal('location', {
    get href() { return document.location.href },
    get pathname() { return document.location.pathname },
    get search() { return document.location.search },
    get hash() { return document.location.hash },
    origin: ORIGIN,
    replace,
  })
}

async function openCallback(path: string) {
  const CenterCallbackPage = await load(path)
  watchNavigation()
  // Next's router writes back the URL it booted with, callback data included, as it mounts.
  window.history.replaceState(null, '', path)
  expect(document.location.search).toBe(new URL(path, ORIGIN).search)
  await act(async () => root.render(<CenterCallbackPage />))
}

async function until(condition: () => unknown) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(condition()).toBeTruthy()
}

const heading = () => host.querySelector('h1')!.textContent
const message = () => host.querySelector('[role="status"]')?.textContent
const retry = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry')
const page = () => host.querySelector('main')!

describe('the Center callback page', () => {
  it('finishes a full-page sign-in with the pinned callback, connects Signa and returns to the saved page', async () => {
    window.sessionStorage.setItem(RETURN_KEY, '/base:23')
    await openCallback(CODE_PATH)
    await until(() => replace.mock.calls.length === 1)

    expect(mocks.createClient).toHaveBeenCalledExactlyOnceWith({ ...CONFIG, callbackUri: `${ORIGIN}/center/callback` })
    expect(mocks.wallet.completeConnection).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}${CODE_PATH}`)
    expect(mocks.wallet.retryConnection).not.toHaveBeenCalled()
    expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(mocks.wagmi, { connector: mocks.signa })
    expect(replace).toHaveBeenCalledExactlyOnceWith('/base:23')
  })

  it('does not connect again when Signa is already the connected wallet', async () => {
    mocks.wagmi.state.current = mocks.signa.uid
    await openCallback(CODE_PATH)
    await until(() => replace.mock.calls.length === 1)

    expect(mocks.connect).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledExactlyOnceWith('/')
  })

  it('completes a payment review as a payment, not a sign-in', async () => {
    await openCallback('/center/callback?review=1&state=def')
    await until(() => replace.mock.calls.length === 1)

    expect(mocks.payments.completePayment).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}/center/callback?review=1&state=def`)
    expect(mocks.wallet.completeConnection).not.toHaveBeenCalled()
  })

  it('has cleared the code from the address bar again, after the router wrote it back, before the SDK is asked anything', async () => {
    await openCallback(CODE_PATH)
    await until(() => replace.mock.calls.length === 1)

    expect(searchSeenBySdk).toEqual([''])
    expect(document.location.search).toBe('')
    expect(document.location.pathname).toBe('/center/callback')
  })

  it('hands the callback to the Sticky page that opened this window, and says the window can be closed', async () => {
    mocks.deliver.mockResolvedValue(true)
    await openCallback(CODE_PATH)
    await until(() => message() === 'Done. You can close this window.')

    expect(mocks.deliver).toHaveBeenCalledOnce()
    const [url, options] = mocks.deliver.mock.calls[0] as [string, { window: unknown }]
    expect(url).toBe(`${ORIGIN}${CODE_PATH}`)
    expect(options.window).toBe(window)
    expect(heading()).toBe('Your Signa account')
    expect(mocks.createClient).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
    expect(page().style.visibility).toBe('visible')
  })

  describe('inside the sign-in frame', () => {
    const parent = { postMessage: vi.fn() }
    let resize: () => void

    beforeEach(() => {
      vi.stubGlobal('parent', parent)
      vi.stubGlobal('ResizeObserver', class {
        constructor(callback: () => void) { resize = callback }
        observe() {}
        disconnect() {}
      })
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 123.2 } as DOMRect)
    })

    it('lets the page that framed it finish the sign-in, and says so', async () => {
      mocks.deliver.mockResolvedValue(true)
      await openCallback(CODE_PATH)
      await until(() => heading() === 'Signing you in…')

      expect(message()).toBeUndefined()
      expect(mocks.wallet.completeConnection).not.toHaveBeenCalled()
      expect(page().style.visibility).toBe('visible')
    })

    it('reports its height to the page that framed it, addressed to this origin only', async () => {
      mocks.deliver.mockResolvedValue(true)
      await openCallback(CODE_PATH)
      await until(() => heading() === 'Signing you in…')

      resize()

      expect(parent.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'juicebox-center:size', height: 124 }, ORIGIN)
    })
  })

  it('renders hidden on the server, so a framed sign-in never flashes the full-page layout', async () => {
    const CenterCallbackPage = await load('/center/callback')
    expect(renderToString(<CenterCallbackPage />)).toContain('visibility:hidden')
  })

  describe('after a reload, when the code is already gone from the address bar', () => {
    it('retries the saved sign-in without offering anything upward', async () => {
      window.sessionStorage.setItem(RETURN_KEY, '/@jango')
      await openCallback('/center/callback')
      await until(() => replace.mock.calls.length === 1)

      expect(mocks.deliver).not.toHaveBeenCalled()
      expect(mocks.wallet.retryConnection).toHaveBeenCalledOnce()
      expect(mocks.wallet.completeConnection).not.toHaveBeenCalled()
      expect(mocks.connect).toHaveBeenCalledExactlyOnceWith(mocks.wagmi, { connector: mocks.signa })
      expect(replace).toHaveBeenCalledExactlyOnceWith('/@jango')
    })

    it('refreshes a payment that was waiting instead', async () => {
      mocks.payments.pendingPayment.mockReturnValue({ status: 'pending' })
      await openCallback('/center/callback')
      await until(() => replace.mock.calls.length === 1)

      expect(mocks.payments.refreshPayment).toHaveBeenCalledOnce()
      expect(mocks.wallet.retryConnection).not.toHaveBeenCalled()
    })
  })

  describe('when it cannot finish', () => {
    it('refuses on a site with no Signa configuration, and finishes when Retry is pressed once it has', async () => {
      mocks.config = null
      await openCallback(CODE_PATH)
      await until(() => message() === 'Juicebox account is not configured for this site.')

      expect(heading()).toBe('Your Signa account')
      expect(replace).not.toHaveBeenCalled()
      expect(page().style.visibility).toBe('visible')

      mocks.config = CONFIG
      await act(async () => retry()!.click())
      await until(() => replace.mock.calls.length === 1)
      expect(mocks.wallet.completeConnection).toHaveBeenCalledExactlyOnceWith(`${ORIGIN}${CODE_PATH}`)
    })

    it('shows the SDK’s reason, and stays put', async () => {
      mocks.wallet.completeConnection.mockRejectedValue(new Error('The sign-in expired.'))
      await openCallback(CODE_PATH)
      await until(() => message() === 'The sign-in expired.')

      expect(retry()).toBeDefined()
      expect(replace).not.toHaveBeenCalled()
      expect(mocks.connect).not.toHaveBeenCalled()
    })

    it('says so when the failure has no reason', async () => {
      mocks.wallet.completeConnection.mockRejectedValue('nope')
      await openCallback(CODE_PATH)
      await until(() => message() === 'The wallet connection could not be restored.')
    })

    it('says so when Signa is not among the site’s connectors', async () => {
      mocks.wagmi.connectors = [{ id: 'injected', uid: 'injected-uid' }]
      await openCallback(CODE_PATH)
      await until(() => message() === 'Signa is not configured for this site.')
      expect(replace).not.toHaveBeenCalled()
    })

    it('follows only a safe route back: anything else under the saved key is refused', async () => {
      for (const saved of ['//evil.example', 'https://evil.example/', '#/project/12', '/center/callback', '/base:23?code=x']) {
        window.sessionStorage.setItem(RETURN_KEY, saved)
        await act(async () => root.unmount())
        root = createRoot(host)
        await openCallback(CODE_PATH)
        await until(() => message() === 'The original Sticky page is unavailable.')
        expect(replace, saved).not.toHaveBeenCalled()
      }
    })

    it('does nothing with a callback it could not clear from the address bar', async () => {
      window.history.replaceState(null, '', CODE_PATH)
      vi.spyOn(window.history, 'replaceState').mockImplementation(() => { throw new Error('blocked') })
      vi.resetModules()
      const { default: CenterCallbackPage } = await import('@/app/center/callback/page')
      watchNavigation()
      await act(async () => root.render(<CenterCallbackPage />))
      await until(() => message() === 'The wallet callback could not be cleared safely.')

      expect(mocks.deliver).not.toHaveBeenCalled()
      expect(mocks.createClient).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
    })
  })
})
