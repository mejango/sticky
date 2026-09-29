import { act, type AnchorHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearViewAs } from '@/lib/viewAs'

const ALICE = '0x1111111111111111111111111111111111111111'

const mocks = vi.hoisted(() => ({
  wallet: { address: undefined as string | undefined, isConnected: false, isCenterWallet: false },
  writeText: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ ...mocks.wallet, disconnect: vi.fn(), openSignIn: vi.fn() }),
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/' }))
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))
vi.mock('wagmi', () => ({
  useEnsName: () => ({ data: undefined }),
  useBalance: () => ({ data: undefined }),
}))
vi.mock('@/providers/preload-center', () => ({ preloadCenterWallet: vi.fn() }))
vi.mock('@/providers/Providers', () => ({ IS_DETERMINISTIC_BROWSER: false }))

import { WalletButton } from '@/components/WalletButton'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: false }
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
