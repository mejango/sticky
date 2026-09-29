import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalWalletDialog } from '@/providers/ExternalWalletDialog'

// The dialog is rendered with the SDK's own modal and connect controller, so these tests exercise the
// behavior a visitor sees. Only the wagmi hook, the Signa runtime and the site's Signa configuration are
// replaced.
const ISSUER = 'https://signa.center'
// The page's own origin: the callback page inside the frame is served from it.
const ORIGIN = window.location.origin
const CALLBACK = `${ORIGIN}/center/callback?code=abc&state=def&iss=${encodeURIComponent(ISSUER)}`

type FakeConnector = {
  id: string
  name: string
  icon?: string
  emitter: { on: ReturnType<typeof vi.fn>; off: ReturnType<typeof vi.fn> }
}

const mocks = vi.hoisted(() => ({
  connectors: [] as unknown[],
  connectWith: vi.fn(),
  isConnected: false,
  config: null as { issuer: string } | null,
  saveCenterReturnPath: vi.fn(),
  wallet: {
    payments: () => ({ pendingPayment: () => null }),
    prepareConnection: vi.fn(),
    completeConnection: vi.fn(),
    restoreConnection: vi.fn(),
    retryConnection: vi.fn(),
    disconnect: vi.fn(),
  },
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ connectors: mocks.connectors, connectWith: mocks.connectWith, isConnected: mocks.isConnected }),
}))
vi.mock('@/providers/wallet-config', () => ({
  get CENTER_WALLET_CONFIG() { return mocks.config },
  get CENTER_WALLET_ENABLED() { return mocks.config !== null },
}))
vi.mock('@/providers/center-runtime', () => ({
  centerWalletClient: () => mocks.wallet,
  saveCenterReturnPath: mocks.saveCenterReturnPath,
}))

function connector(id: string, name: string, icon?: string): FakeConnector {
  return { id, name, icon, emitter: { on: vi.fn(), off: vi.fn() } }
}
const rabby = () => connector('io.rabby', 'Rabby', 'data:image/svg+xml;base64,PHN2Zy8+')
const sneaky = () => connector('sneaky', 'Sneaky', 'https://tracker.example/icon.png')

let host: HTMLDivElement
let root: Root
let strangers: HTMLIFrameElement[]
const onClose = vi.fn()
const launch = vi.fn()

beforeEach(() => {
  mocks.connectors = [rabby(), sneaky()]
  mocks.isConnected = false
  mocks.config = { issuer: ISSUER }
  mocks.connectWith.mockResolvedValue(undefined)
  mocks.wallet.prepareConnection.mockResolvedValue({ authorizationUrl: `${ISSUER}/authorize?request=1`, launch })
  mocks.wallet.completeConnection.mockImplementation(async (url: string) => ({ url }))
  strangers = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  for (const stranger of strangers) stranger.remove()
})

async function open() {
  await act(async () => root.render(<ExternalWalletDialog onClose={onClose} />))
}

// The controller and the SDK's frame poll settle on their own timers, so wait for them inside act.
async function until(condition: () => unknown) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(condition()).toBeTruthy()
}

const dialog = () => host.querySelector<HTMLDialogElement>('dialog.jb-connect.sticky-connect')!
const heading = () => dialog().querySelector('h2')!
const primary = () => dialog().querySelector<HTMLButtonElement>('.jb-connect-primary')!
const tiles = () => [...dialog().querySelectorAll<HTMLButtonElement>('.jb-connect-tile')]
const tile = (name: string) => tiles().find(item => item.getAttribute('aria-label') === name)!
const status = () => dialog().querySelector('.jb-connect-status')?.textContent
const errorAlert = () => dialog().querySelector('[role="alert"]')
const frame = () => dialog().querySelector<HTMLIFrameElement>('iframe')
const cancel = () => [...dialog().querySelectorAll('button')].find(button => button.textContent === 'Cancel')!

async function click(button: HTMLElement) {
  await act(async () => button.click())
}

// A message event from a window other than the frame: another frame on the page.
function otherWindow() {
  const other = document.createElement('iframe')
  document.body.append(other)
  strangers.push(other)
  return other.contentWindow!
}

async function fromFrame(origin: string, data: unknown, source: Window | null = frame()!.contentWindow) {
  await act(async () => { window.dispatchEvent(new MessageEvent('message', { data, origin, source })) })
}

function userAgent(value: string) {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(value)
}

describe('the sign-in chooser', () => {
  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Touch ID'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 'Face ID'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Windows Hello'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Device'],
  ])('labels the Signa button with the device’s own passkey name (%s)', async (agent, label) => {
    userAgent(agent)
    await open()
    expect(primary().textContent).toBe(label)
  })

  it('puts Signa first as the primary action, then every browser wallet as a tile named for assistive tech', async () => {
    userAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    await open()

    expect(dialog().open).toBe(true)
    expect(heading().textContent).toBe('Sign in')
    const order = [...dialog().querySelectorAll('.jb-connect-primary, .jb-connect-divider, .jb-connect-tile')]
    expect(order.map(node => node.className.split(' ').find(name => name.startsWith('jb-connect-')))).toEqual([
      'jb-connect-primary', 'jb-connect-divider', 'jb-connect-tile', 'jb-connect-tile',
    ])
    expect(primary().tagName).toBe('BUTTON')
    expect(primary().textContent).toBe('Touch ID')
    expect(dialog().querySelector('.jb-connect-divider')!.textContent).toBe('or connect a wallet')
    expect(tiles().map(item => item.getAttribute('aria-label'))).toEqual(['Rabby', 'Sneaky'])
    expect(tiles().map(item => item.getAttribute('title'))).toEqual(['Rabby', 'Sneaky'])
    expect(tiles().every(item => item.tagName === 'BUTTON' && item.childElementCount === 1)).toBe(true)
  })

  it('offers only browser wallets when Signa is not configured for the site', async () => {
    mocks.config = null
    await open()
    expect(primary()).toBeNull()
    expect(dialog().querySelector('.jb-connect-divider')!.textContent).toBe('Connect a wallet')
    expect(tiles().map(item => item.getAttribute('aria-label'))).toEqual(['Rabby', 'Sneaky'])
  })

  it('shows only inline images as wallet icons: a remote icon would tell its host about the visit', async () => {
    mocks.connectors = [
      rabby(),
      sneaky(),
      connector('metamask', 'MetaMask', 'data:image/svg+xml,%3Csvg%2F%3E'),
      connector('script', 'Script', 'data:text/html;base64,PHNjcmlwdD48L3NjcmlwdD4='),
      connector('js', 'Js', 'javascript:alert(1)'),
      connector('plain', 'Plain'),
    ]
    await open()

    expect(tile('Rabby').querySelector('img')!.getAttribute('src')).toBe('data:image/svg+xml;base64,PHN2Zy8+')
    expect(tile('Rabby').querySelector('img')!.getAttribute('alt')).toBe('')
    expect(tile('MetaMask').querySelector('img')!.getAttribute('src')).toBe('data:image/svg+xml,%3Csvg%2F%3E')
    for (const name of ['Sneaky', 'Script', 'Js', 'Plain']) {
      expect(tile(name).querySelector('img'), name).toBeNull()
      expect(tile(name).querySelector('svg')!.getAttribute('aria-hidden'), name).toBe('true')
    }
    expect(dialog().innerHTML).not.toContain('tracker.example')
  })

  it('offers Safe only inside a Safe frame', async () => {
    mocks.connectors = [rabby(), connector('safe', 'Safe')]
    await open()
    expect(tiles().map(item => item.getAttribute('aria-label'))).toEqual(['Rabby'])

    await act(async () => root.unmount())
    root = createRoot(host)
    vi.stubGlobal('top', {})
    await open()
    expect(tiles().map(item => item.getAttribute('aria-label'))).toEqual(['Rabby', 'Safe'])
  })

  it('says a Signa sign-in is connecting while it waits, and hides the wallet choices', async () => {
    mocks.wallet.prepareConnection.mockReturnValue(new Promise(() => {}))
    await open()

    await click(primary())

    await until(() => status() === 'Connecting, just a sec...')
    expect(primary()).toBeNull()
    expect(tiles()).toEqual([])
  })

  it('says which wallet is opening while it waits', async () => {
    mocks.connectWith.mockReturnValue(new Promise(() => {}))
    await open()

    await click(tile('Rabby'))

    await until(() => status() === 'Opening Rabby…')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the wallet’s own error as an alert, and nothing when the person declined', async () => {
    await open()
    mocks.connectWith.mockRejectedValueOnce(new Error('The wallet is locked.'))
    await click(tile('Rabby'))
    await until(() => errorAlert())
    expect(errorAlert()!.textContent).toBe('The wallet is locked.')
    expect(onClose).not.toHaveBeenCalled()

    mocks.connectWith.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { code: 4001 }))
    await click(tile('Sneaky'))
    await until(() => tiles().length === 2 && !errorAlert())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('connects the wallet that was picked, then closes', async () => {
    await open()
    await click(tile('Rabby'))
    await until(() => onClose.mock.calls.length === 1)
    expect(mocks.connectWith).toHaveBeenCalledExactlyOnceWith('io.rabby')
  })

  it('closes on its own when the wallet becomes connected while it is open', async () => {
    await open()
    expect(onClose).not.toHaveBeenCalled()
    mocks.isConnected = true
    await open()
    expect(onClose).toHaveBeenCalled()
  })

  it('hands a pairing link to the pairing code, and the link keeps working without a QR', async () => {
    const wallet = connector('walletConnect', 'WalletConnect')
    mocks.connectors = [wallet]
    mocks.connectWith.mockImplementation(async () => {
      const onMessage = wallet.emitter.on.mock.calls[0][1] as (message: { type: string; data: unknown }) => void
      onMessage({ type: 'display_uri', data: 'wc:abc@2?relay-protocol=irn' })
      await new Promise(() => {})
    })
    await open()

    await click(tile('WalletConnect'))
    await until(() => dialog().textContent?.includes('Scan with your wallet app'))
    expect(dialog().querySelector<HTMLAnchorElement>('a')!.getAttribute('href')).toBe('wc:abc@2?relay-protocol=irn')
    expect(wallet.emitter.on).toHaveBeenCalledWith('message', expect.any(Function))
  })
})

describe('the Signa frame', () => {
  async function startSignIn() {
    userAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    await open()
    await click(primary())
    await until(frame)
    await until(() => launch.mock.calls.length === 1)
  }

  it('delegates passkeys to Signa by origin, is named Signa, and survives a re-render', async () => {
    await startSignIn()
    const shown = frame()!

    expect(mocks.saveCenterReturnPath).toHaveBeenCalledOnce()
    expect(launch).toHaveBeenCalledExactlyOnceWith({ target: 'juicebox-center-frame' })
    expect(shown.getAttribute('name')).toBe('juicebox-center-frame')
    await until(() => shown.getAttribute('title') === 'Signa')
    expect(shown.getAttribute('allow')).toBe(`publickey-credentials-get ${ISSUER}; publickey-credentials-create ${ISSUER}`)
    expect(shown.getAttribute('referrerpolicy')).toBe('no-referrer')

    await open()
    expect(frame()).toBe(shown)
  })

  it('resizes to the height Signa reports, within bounds, and only for messages from the frame', async () => {
    await startSignIn()
    const posted = vi.spyOn(frame()!.contentWindow!, 'postMessage').mockImplementation(() => {})

    await fromFrame(ISSUER, { type: 'juicebox-center:size', height: 500 }, otherWindow())
    expect(frame()!.style.height).toBe('')

    await fromFrame(ISSUER, { type: 'juicebox-center:size', height: 5000 })
    expect(frame()!.style.height).toBe('1202px')
    await fromFrame(ISSUER, { type: 'juicebox-center:size', height: 10 })
    expect(frame()!.style.height).toBe('162px')
    expect(posted).toHaveBeenCalled()
  })

  it('answers Signa’s size message with the heading font, addressed to Signa only', async () => {
    await startSignIn()
    heading().style.fontFamily = 'Agrandir'
    const posted = vi.spyOn(frame()!.contentWindow!, 'postMessage').mockImplementation(() => {})
    const headingFontMessages = () => posted.mock.calls.filter(
      ([message]) => (message as { theme?: { headingFont?: string } })?.theme?.headingFont !== undefined,
    )

    // The callback page inside the frame is this site: it resizes the frame but is not sent the heading font.
    await fromFrame(ORIGIN, { type: 'juicebox-center:size', height: 100 })
    // Neither is a page that only claims to be Signa, or a window other than the frame.
    await fromFrame('https://evil.example', { type: 'juicebox-center:size', height: 100 })
    await fromFrame(ISSUER, { type: 'juicebox-center:size', height: 100 }, otherWindow())
    expect(headingFontMessages()).toEqual([])

    await fromFrame(ISSUER, { type: 'juicebox-center:size', height: 100 })
    expect(headingFontMessages()).toEqual([[{ type: 'juicebox-center:theme', theme: { headingFont: 'Agrandir' } }, ISSUER]])
  })

  it('retitles the dialog for the page Signa shows, only when Signa says so', async () => {
    await startSignIn()

    await fromFrame(ISSUER, { type: 'juicebox-center:page', page: 'signup' })
    expect(heading().textContent).toBe('Sign up')
    await fromFrame('https://evil.example', { type: 'juicebox-center:page', page: 'signin' })
    expect(heading().textContent).toBe('Sign up')
    await fromFrame(ISSUER, { type: 'juicebox-center:page', page: 'somewhere-else' })
    expect(heading().textContent).toBe('Sign up')
    await fromFrame(ISSUER, { type: 'juicebox-center:page', page: 'signin' })
    expect(heading().textContent).toBe('Sign in')
  })

  it('finishes the sign-in here when the frame delivers the callback, then acknowledges it and closes', async () => {
    await startSignIn()
    const posted = vi.spyOn(frame()!.contentWindow!, 'postMessage').mockImplementation(() => {})

    await fromFrame(ORIGIN, { type: 'juicebox-center:callback', url: CALLBACK })
    await until(() => onClose.mock.calls.length === 1)

    expect(mocks.wallet.completeConnection).toHaveBeenCalledExactlyOnceWith(CALLBACK)
    expect(mocks.connectWith).toHaveBeenCalledExactlyOnceWith('juicebox-center')
    expect(posted).toHaveBeenCalledWith({ type: 'juicebox-center:received' }, ORIGIN)
  })

  it('ignores a callback that does not come from the frame, from this origin', async () => {
    await startSignIn()

    await fromFrame('https://evil.example', { type: 'juicebox-center:callback', url: CALLBACK })
    await fromFrame(ISSUER, { type: 'juicebox-center:callback', url: CALLBACK })
    await fromFrame(ORIGIN, { type: 'juicebox-center:callback', url: CALLBACK }, otherWindow())
    await fromFrame(ORIGIN, { type: 'juicebox-center:other', url: CALLBACK })
    await fromFrame(ORIGIN, { type: 'juicebox-center:callback', url: 42 })

    expect(mocks.wallet.completeConnection).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('closing the chooser', () => {
  it('cancels the sign-in in progress, closes, and stops listening to the frame', async () => {
    userAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    await open()
    await click(primary())
    await until(frame)
    await until(() => launch.mock.calls.length === 1)
    const shown = frame()!.contentWindow!

    await act(async () => cancel().click())

    expect(onClose).toHaveBeenCalledOnce()
    expect(frame()).toBeNull()
    expect(primary()).not.toBeNull()
    expect(errorAlert()).toBeNull()
    // A callback that arrives after the cancel finds nobody waiting for it.
    await act(async () => { window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'juicebox-center:callback', url: CALLBACK }, origin: ORIGIN, source: shown,
    })) })
    expect(mocks.wallet.completeConnection).not.toHaveBeenCalled()
    expect(mocks.connectWith).not.toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    await open()
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('stops listening for Signa messages once it is gone', async () => {
    userAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    await open()
    await click(primary())
    await until(frame)
    const shown = frame()!.contentWindow!
    const posted = vi.spyOn(shown, 'postMessage').mockImplementation(() => {})

    await act(async () => root.unmount())
    await act(async () => { window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'juicebox-center:size', height: 100 }, origin: ISSUER, source: shown,
    })) })

    expect(posted).not.toHaveBeenCalled()
    root = createRoot(host)
  })
})
