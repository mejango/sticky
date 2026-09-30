import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Next hands out one router object for the life of the app, so the mock does too.
const mocks = vi.hoisted(() => {
  const replace = vi.fn()
  return { replace, router: { replace } }
})

vi.mock('next/navigation', () => ({ useRouter: () => mocks.router }))

import { LegacyHashRedirect } from '@/components/LegacyHashRedirect'

const HOLDER = '0x1234567890abcdef1234567890abcdef12345678'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  // What the router does: the address becomes the path it was sent to.
  mocks.replace.mockImplementation((path: string) => window.history.replaceState(null, '', path))
  window.history.replaceState(null, '', '/')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  window.history.replaceState(null, '', '/')
})

const at = (address: string) => window.history.replaceState(null, '', address)
const mount = () => act(async () => root.render(<LegacyHashRedirect />))

describe('the old link redirect', () => {
  it.each([
    ['/?chain=8453#/project/23', '/base:23'],
    ['/?chain=8453#/project/23/tokens', '/base:23#tokens'],
    ['/?chain=11155420#/project/7/airdrops', '/opsep:7#airdrops'],
    ['/#/project/5', '/eth:5'],
    ['/#/@banny/tokens', '/@banny#tokens'],
    [`/?chain=8453#/account/${HOLDER}`, `/account/${HOLDER}`],
    [`/?chain=84532#/account/${HOLDER}`, `/account/${HOLDER}?network=testnet`],
    ['/?chain=84532#/', '/?network=testnet'],
    ['/?chain=84532', '/?network=testnet'],
  ])('replaces %s with %s, once', async (address, path) => {
    at(address)
    await mount()
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(path)
  })

  it.each(['/', '/?network=testnet', '/?chain=8453', '/?chain=8453#/', '/#tokens', '/#/project/abc', '/?chain=999#/project/23'])(
    'leaves %s where it is: it is no old link, or one with nowhere to go',
    async address => {
      at(address)
      await mount()
      expect(mocks.replace).not.toHaveBeenCalled()
    },
  )

  it('draws nothing', async () => {
    at('/?chain=8453#/project/23')
    await mount()
    expect(host.innerHTML).toBe('')
  })

  it('runs when the page loads, and not as the page draws again', async () => {
    at('/?chain=8453#/project/23')
    await mount()
    await mount()
    expect(mocks.replace).toHaveBeenCalledTimes(1)
  })

  // The home mounts the redirect on every visit, so what the router leaves behind must read as no old link.
  it.each(['/?chain=8453#/project/23', '/?chain=84532#/', `/?chain=84532#/account/${HOLDER}`])(
    'finds nothing left to send once the router has replaced %s',
    async address => {
      at(address)
      await mount()
      await act(async () => root.unmount())
      root = createRoot(host)
      await mount()
      expect(mocks.replace).toHaveBeenCalledTimes(1)
    },
  )
})
