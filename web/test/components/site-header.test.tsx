import { act, type AnchorHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pathname: '/' }))

vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }))
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))
vi.mock('@/components/WalletButton', () => ({ WalletButton: () => <button type="button">wallet</button> }))

import { SiteHeader } from '@/components/SiteHeader'

let host: HTMLDivElement
let root: Root
let scrollY: number
let scrollTo: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
  scrollY = 0
  scrollTo = vi.fn((_x: number, y: number) => {
    scrollY = y
  })
  vi.stubGlobal('scrollTo', scrollTo)
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  mocks.pathname = '/'
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const render = () => act(async () => root.render(<SiteHeader />))
const wallet = () => host.querySelector('.site-header-wallet')!
const pinned = () => wallet().classList.contains('top-fold-fixed')
const frame = () => act(async () => void vi.advanceTimersByTime(16))
const scrolled = (to: number) =>
  act(async () => {
    scrollY = to
    window.dispatchEvent(new Event('scroll'))
  })

describe('the logo', () => {
  it('links home, once for assistive technology', async () => {
    await render()
    const named = [...host.querySelectorAll<HTMLAnchorElement>('a[href="/"]')].filter(
      link => link.getAttribute('aria-hidden') !== 'true',
    )
    expect(named).toHaveLength(1)
    expect(named[0].getAttribute('aria-label')).toBe('Go to homepage')
    expect(named[0].querySelector('img')?.getAttribute('alt')).toBe('')
  })

  it('draws the reflected half of the drip in the fold, out of the tab order', async () => {
    await render()
    const reflection = host.querySelector<HTMLAnchorElement>('a.overscroll-slime')!
    expect(reflection.getAttribute('href')).toBe('/')
    expect(reflection.getAttribute('aria-hidden')).toBe('true')
    expect(reflection.tabIndex).toBe(-1)
    expect(reflection.querySelector('img')).not.toBeNull()
  })

  it('carries the wallet button', async () => {
    await render()
    expect(wallet().textContent).toBe('wallet')
  })
})

describe('the top fold', () => {
  it('pins the wallet control while the page loads, then scrolls the fold away', async () => {
    await render()
    expect(pinned()).toBe(true)
    expect(scrollTo).not.toHaveBeenCalled()
    await frame()
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 50)
    expect(pinned()).toBe(false)
  })

  it('leaves a page that is already past the fold where it is', async () => {
    scrollY = 400
    await render()
    await frame()
    await act(async () => void vi.advanceTimersByTime(200))
    expect(scrollTo).not.toHaveBeenCalled()
    expect(pinned()).toBe(false)
  })

  it('pins the control whenever the page is scrolled back into the fold', async () => {
    await render()
    await frame()
    await scrolled(80)
    expect(pinned()).toBe(false)
    await scrolled(49)
    expect(pinned()).toBe(true)
    await scrolled(50)
    expect(pinned()).toBe(false)
    expect(scrollTo).toHaveBeenCalledTimes(1)
  })

  it('folds again when the browser restores the scroll position late', async () => {
    await render()
    await frame()
    scrollTo.mockClear()
    scrollY = 0
    await act(async () => void vi.advanceTimersByTime(150))
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 50)
  })

  it('folds again when the page is shown again from the back-forward cache', async () => {
    await render()
    await frame()
    scrollTo.mockClear()
    await act(async () => {
      scrollY = 0
      window.dispatchEvent(new Event('pageshow'))
    })
    await frame()
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 50)
  })

  it('folds again when the page changes, and only if it landed in the fold', async () => {
    await render()
    await frame()
    scrollTo.mockClear()

    scrollY = 0
    mocks.pathname = '/base:23'
    await render()
    await frame()
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 50)

    scrollTo.mockClear()
    scrollY = 300
    mocks.pathname = '/account/0x1111111111111111111111111111111111111111'
    await render()
    await frame()
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('stops listening when the header goes away', async () => {
    const removed = vi.spyOn(window, 'removeEventListener')
    await render()
    await act(async () => root.unmount())
    const events = removed.mock.calls.map(([type]) => type)
    expect(events).toEqual(expect.arrayContaining(['scroll', 'load', 'pageshow']))
    scrollTo.mockClear()
    await act(async () => void vi.advanceTimersByTime(500))
    expect(scrollTo).not.toHaveBeenCalled()
    root = createRoot(host)
  })
})
