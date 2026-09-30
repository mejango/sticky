import { act, type AnchorHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearViewAs } from '@/lib/viewAs'

const ALICE = '0x1111111111111111111111111111111111111111'

const mocks = vi.hoisted(() => ({
  wallet: { address: undefined as string | undefined, isConnected: false, isCenterWallet: false },
  writeText: vi.fn(),
  pathname: '/',
  search: '',
  balance: undefined as { value: bigint; symbol: string } | undefined,
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ ...mocks.wallet, disconnect: vi.fn(), openSignIn: vi.fn() }),
}))
vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
}))
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))
vi.mock('wagmi', () => ({
  useEnsName: () => ({ data: undefined }),
  useBalance: () => ({ data: mocks.balance }),
}))
vi.mock('@/providers/preload-center', () => ({ preloadCenterWallet: vi.fn() }))
vi.mock('@/providers/Providers', () => ({ IS_DETERMINISTIC_BROWSER: false }))

import { WalletButton } from '@/components/WalletButton'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: false }
  mocks.pathname = '/'
  mocks.search = ''
  mocks.balance = undefined
  mocks.writeText.mockResolvedValue(undefined)
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText: mocks.writeText } }))
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    clearViewAs()
  })
  host.remove()
})

const render = () => act(async () => root.render(<WalletButton />))
const trigger = () => host.querySelector('button')!
const panel = () => host.querySelector('div[id]')
const item = (name: string) =>
  [...host.querySelectorAll<HTMLElement>('a, button')].find(node => node.textContent === name)!
const openMenu = () => act(async () => trigger().click())
const press = (target: Element, key: string) =>
  act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))

describe('the account menu', () => {
  it('tells the button which panel it opens, and whether it is open', async () => {
    await render()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(trigger().hasAttribute('aria-controls')).toBe(false)
    await openMenu()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(trigger().getAttribute('aria-controls')).toBe(panel()!.id)
  })

  it('moves focus to the first item when it opens', async () => {
    await render()
    await openMenu()
    expect(document.activeElement).toBe(item('Account'))
  })

  it('closes on Escape and puts focus back on the button', async () => {
    await render()
    await openMenu()
    await press(document.activeElement!, 'Escape')
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('ignores Escape while it is closed', async () => {
    await render()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => void trigger().dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  })

  it('closes on a press outside it, and leaves focus where the person put it', async () => {
    const outside = document.createElement('input')
    document.body.append(outside)
    await render()
    await openMenu()
    await act(async () => {
      outside.focus()
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('stays open for a press inside it', async () => {
    await render()
    await openMenu()
    await act(async () => void item('View as…').dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(panel()).not.toBeNull()
  })

  it('keeps the keyboard where it was after copying the address', async () => {
    await render()
    await openMenu()
    await act(async () => item('Copy address').click())
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(ALICE)
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('focuses the address prompt when it opens', async () => {
    await render()
    await openMenu()
    await act(async () => item('View as…').click())
    expect(item('View as…').getAttribute('aria-expanded')).toBe('true')
    const input = host.querySelector('input')!
    expect(document.activeElement).toBe(input)
    expect(input.getAttribute('placeholder')).toBe('0x address')
  })

  it('closes the address prompt along with the menu, and reopens without it', async () => {
    await render()
    await openMenu()
    await act(async () => item('View as…').click())
    expect(host.querySelector('input')).not.toBeNull()
    expect(item('View as…').getAttribute('aria-expanded')).toBe('true')

    await openMenu()
    expect(panel()).toBeNull()

    await openMenu()
    expect(host.querySelector('input')).toBeNull()
    expect(item('View as…').getAttribute('aria-expanded')).toBe('false')
  })

  it('does not reopen for the next account after the wallet goes away', async () => {
    await render()
    await openMenu()
    expect(panel()).not.toBeNull()

    mocks.wallet = { address: undefined, isConnected: false, isCenterWallet: false }
    await render()
    expect(host.textContent).toBe('Sign in')

    mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: false }
    await render()
    expect(host.textContent).toContain('Signed in')
    expect(panel()).toBeNull()
  })
})

describe('the balance amounts', () => {
  const balanceShown = async (value: bigint) => {
    mocks.pathname = '/base:23'
    mocks.balance = { value, symbol: 'ETH' }
    await render()
    await openMenu()
    return panel()!.querySelector('dl')!.textContent
  }

  it.each([
    ['nothing', '0', 0n],
    ['dust, to its first significant figure', '0.00003', 30_000_000_000_000n],
    ['a tiny amount, cut to its first significant figure', '0.00001', 12_300_000_000_000n],
    ['a single wei', '0.000000000000000001', 1n],
    ['the smallest amount that is not dust', '0.0001', 10n ** 14n],
    ['a whole amount', '1', 10n ** 18n],
    ['more decimals than four, rounded', '1.2346', 1_234_567_890_000_000_000n],
    ['thousands, grouped', '1,234.5', 1_234_500_000_000_000_000_000n],
    ['millions, grouped', '1,000,000', 10n ** 24n],
  ])('reads %s as %s ETH', async (_name, expected, wei) => {
    expect(await balanceShown(wei)).toBe(`ETH${expected} ETH`)
  })

  it('reads the same in every locale', async () => {
    const toLocaleString = Number.prototype.toLocaleString
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number, locales?: never, options?: never) {
      return toLocaleString.call(this, locales ?? 'de-DE', options)
    } as never)
    expect(await balanceShown(1_234_500_000_000_000_000_000n)).toBe('ETH1,234.5 ETH')
  })
})
