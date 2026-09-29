import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearViewAs, setViewAs } from '@/lib/viewAs'

const ALICE = '0x1111111111111111111111111111111111111111'
// The checksummed form of this address is all lowercase where it is shortened, so its label is exactly `0x1234…abcd`.
const VIEWED = '0x123400000000000000000000000000000028abcd'

const mocks = vi.hoisted(() => ({
  wallet: { address: undefined as string | undefined, isConnected: false, isCenterWallet: false },
  disconnect: vi.fn(),
  openSignIn: vi.fn(),
  preload: vi.fn(),
  pathname: '/',
  ensName: undefined as string | undefined,
  balance: undefined as { value: bigint; symbol: string } | undefined,
  balanceError: false,
  balanceQuery: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ ...mocks.wallet, disconnect: mocks.disconnect, openSignIn: mocks.openSignIn }),
}))
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }))
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: ReactNode }) => createElement('a', props, children),
}))
vi.mock('wagmi', () => ({
  useEnsName: (query: { address?: string }) => ({ data: query.address === ALICE ? mocks.ensName : undefined }),
  useBalance: (query: unknown) => {
    mocks.balanceQuery(query)
    return { data: mocks.balance, isError: mocks.balanceError }
  },
}))
vi.mock('@/providers/preload-center', () => ({ preloadCenterWallet: mocks.preload }))
vi.mock('@/providers/Providers', () => ({ IS_DETERMINISTIC_BROWSER: false }))

import { WalletButton } from '@/components/WalletButton'
import { ProjectRouteProvider, ProjectRouteSync } from '@/providers/ProjectRouteContext'

let renderer: TestRenderer.ReactTestRenderer | undefined

beforeEach(() => {
  mocks.wallet = { address: undefined, isConnected: false, isCenterWallet: false }
  mocks.pathname = '/'
  mocks.ensName = undefined
  mocks.balance = undefined
  mocks.balanceError = false
  mocks.writeText.mockResolvedValue(undefined)
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { clipboard: { writeText: mocks.writeText } }))
})

afterEach(() => {
  act(() => {
    renderer?.unmount()
    clearViewAs()
  })
  renderer = undefined
})

const connect = (address = ALICE) => {
  mocks.wallet = { address, isConnected: true, isCenterWallet: false }
}

async function render(tree: ReactElement = createElement(WalletButton)) {
  await act(async () => {
    if (renderer) renderer.update(tree)
    else renderer = TestRenderer.create(tree)
  })
}

function textOf(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(textOf).join('')
}

/** The header button. It comes first in the tree, ahead of the menu it opens. */
const trigger = () => renderer!.root.findAllByType('button')[0]!
const label = () => textOf(trigger())

/** The panel the trigger controls, or undefined while it is closed. */
function panel() {
  const id = trigger().props['aria-controls'] as string | undefined
  return id ? renderer!.root.findAll(node => node.type === 'div' && node.props.id === id)[0] : undefined
}

const itemsIn = (container: ReactTestInstance) =>
  container.findAll(node => node.type === 'a' || node.type === 'button')
const menuLabels = () => itemsIn(panel()!).map(textOf)
const item = (name: string) => itemsIn(panel()!).find(node => textOf(node) === name)!

const openMenu = () => act(async () => trigger().props.onClick())
const press = (name: string) => act(async () => item(name).props.onClick({ preventDefault() {}, stopPropagation() {} }))

describe('the button label', () => {
  it('reads exactly "Sign in" when no wallet is connected', async () => {
    await render()
    expect(label()).toBe('Sign in')
  })

  it('reads "Signed in" with the ENS name of the connected account', async () => {
    connect()
    mocks.ensName = 'jango.eth'
    await render()
    expect(label()).toContain('Signed in')
    expect(label()).toContain('jango.eth')
    expect(label()).not.toContain('0x1111')
  })

  it('shows the short address while the account has no ENS name', async () => {
    connect()
    await render()
    expect(label()).toBe('Signed in0x1111…1111')
  })

  it('reads "Viewing as 0x1234…abcd" while another account is being viewed', async () => {
    await render()
    await act(async () => setViewAs(VIEWED))
    expect(label()).toBe('Viewing as 0x1234…abcd')
  })

  it('keeps the viewed account in the label when a wallet is connected too', async () => {
    connect()
    mocks.ensName = 'jango.eth'
    await render()
    await act(async () => setViewAs(VIEWED))
    expect(label()).toBe('Viewing as 0x1234…abcd')
  })

  it('renders the signed-out shell on the server, whatever the wallet state', () => {
    connect()
    mocks.ensName = 'jango.eth'
    const html = renderToString(createElement(WalletButton))
    expect(html).toContain('Sign in')
    expect(html).not.toContain('Signed in')
    expect(html).not.toContain('jango.eth')
  })

  it('names the full address, and a Signa account as one', async () => {
    connect()
    await render()
    expect(trigger().props.title).toBe(ALICE)
    mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: true }
    await render()
    expect(trigger().props.title).toBe(`Signa account ${ALICE}`)
  })
})

describe('signing in', () => {
  it('opens the sign-in chooser, and warms the Signa runtime as the pointer arrives', async () => {
    await render()
    expect(panel()).toBeUndefined()
    for (const event of ['onMouseEnter', 'onFocus', 'onTouchStart']) await act(async () => trigger().props[event]())
    expect(mocks.preload).toHaveBeenCalledTimes(3)
    await act(async () => trigger().props.onClick())
    expect(mocks.openSignIn).toHaveBeenCalledTimes(1)
    expect(panel()).toBeUndefined()
  })
})

describe('the menu', () => {
  it('lists Account, Copy address, Disconnect and View as for a connected wallet', async () => {
    connect()
    await render()
    expect(panel()).toBeUndefined()
    await openMenu()
    expect(menuLabels()).toEqual(['Account', 'Copy address', 'Disconnect', 'View as…'])
    expect(item('Account').props.href).toBe(`/account/${ALICE}`)
    expect(trigger().props['aria-expanded']).toBe(true)
  })

  it('lists Account, Exit View as and View as another account while viewing without a wallet', async () => {
    await render()
    await act(async () => setViewAs(VIEWED))
    await openMenu()
    expect(menuLabels()).toEqual(['Account', 'Exit View as', 'View as another account…'])
    expect(item('Account').props.href).toBe(`/account/${VIEWED}`)
  })

  it('offers the connected wallet back while viewing with one', async () => {
    connect()
    await render()
    await act(async () => setViewAs(VIEWED))
    await openMenu()
    expect(menuLabels()).toEqual(['Account', 'View as connected wallet', 'View as another account…'])
  })

  it('copies the connected address and closes', async () => {
    connect()
    await render()
    await openMenu()
    await press('Copy address')
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(ALICE)
    expect(panel()).toBeUndefined()
  })

  it('still closes when the clipboard refuses', async () => {
    connect()
    mocks.writeText.mockRejectedValue(new Error('denied'))
    await render()
    await openMenu()
    await press('Copy address')
    expect(panel()).toBeUndefined()
  })

  it('disconnects and closes', async () => {
    connect()
    await render()
    await openMenu()
    await press('Disconnect')
    expect(mocks.disconnect).toHaveBeenCalledTimes(1)
    expect(panel()).toBeUndefined()
  })

  it('leaves the viewed account, and keeps the wallet', async () => {
    connect()
    await render()
    await act(async () => setViewAs(VIEWED))
    await openMenu()
    await press('View as connected wallet')
    expect(label()).toContain('Signed in')
    expect(panel()).toBeUndefined()
    expect(mocks.disconnect).not.toHaveBeenCalled()
  })

  it('takes a 0x address to view as, and rejects anything else', async () => {
    connect()
    await render()
    await openMenu()
    await press('View as…')
    const input = () => panel()!.findByType('input')
    const form = () => panel()!.findByType('form')
    expect(input().props['aria-label']).toBe('Account address to preview')

    await act(async () => input().props.onChange({ target: { value: 'vitalik.eth' } }))
    await act(async () => form().props.onSubmit({ preventDefault() {} }))
    expect(textOf(panel()!)).toContain('Enter an address')
    expect(label()).toContain('Signed in')

    await act(async () => input().props.onChange({ target: { value: ` ${VIEWED} ` } }))
    await act(async () => form().props.onSubmit({ preventDefault() {} }))
    expect(label()).toBe('Viewing as 0x1234…abcd')
    expect(panel()).toBeUndefined()
  })
})

describe('the balances', () => {
  it('shows none when no project is in view', async () => {
    connect()
    mocks.balance = { value: 10n ** 18n, symbol: 'ETH' }
    await render()
    await openMenu()
    expect(textOf(panel()!)).not.toContain('ETH')
    expect(mocks.balanceQuery).not.toHaveBeenCalledWith(expect.objectContaining({ address: ALICE }))
  })

  it('shows the wallet balance on the chain of the project in view', async () => {
    connect()
    mocks.pathname = '/base:23'
    mocks.balance = { value: 1_500_000_000_000_000_000n, symbol: 'ETH' }
    await render()
    await openMenu()
    expect(mocks.balanceQuery).toHaveBeenCalledWith(expect.objectContaining({ address: ALICE, chainId: 8453 }))
    expect(textOf(panel()!)).toContain('Base')
    expect(textOf(panel()!)).toContain('1.5 ETH')
    expect(menuLabels()).toEqual(['Account', 'Copy address', 'Disconnect', 'View as…'])
  })

  it('shows the viewed account, not the connected wallet, while viewing', async () => {
    connect()
    mocks.pathname = '/op:7'
    await render()
    await act(async () => setViewAs(VIEWED))
    await openMenu()
    expect(mocks.balanceQuery).toHaveBeenCalledWith(expect.objectContaining({ address: VIEWED, chainId: 10 }))
  })

  it('shows a balance that is still loading as loading', async () => {
    connect()
    mocks.pathname = '/base:23'
    await render()
    await openMenu()
    expect(textOf(panel()!)).toContain('Loading…')
  })

  it('says so when the balance cannot be read, rather than loading for ever', async () => {
    connect()
    mocks.pathname = '/base:23'
    mocks.balanceError = true
    await render()
    await openMenu()
    expect(textOf(panel()!)).toContain('Unavailable')
    expect(textOf(panel()!)).not.toContain('Loading…')
  })

  it('follows a handle route to the project the page resolved it to', async () => {
    connect()
    mocks.pathname = '/@design'
    mocks.balance = { value: 2n * 10n ** 18n, symbol: 'ETH' }
    const resolved = { chainId: 10 as const, projectId: 3, handle: 'design' }
    await render(
      createElement(
        ProjectRouteProvider,
        null,
        createElement(ProjectRouteSync, { route: resolved }),
        createElement(WalletButton),
      ),
    )
    await openMenu()
    expect(mocks.balanceQuery).toHaveBeenCalledWith(expect.objectContaining({ address: ALICE, chainId: 10 }))
    expect(textOf(panel()!)).toContain('Optimism')
  })

  it('ignores a resolved project that belongs to another handle', async () => {
    connect()
    mocks.pathname = '/@other'
    await render(
      createElement(
        ProjectRouteProvider,
        null,
        createElement(ProjectRouteSync, { route: { chainId: 10 as const, projectId: 3, handle: 'design' } }),
        createElement(WalletButton),
      ),
    )
    await openMenu()
    expect(mocks.balanceQuery).not.toHaveBeenCalledWith(expect.objectContaining({ address: ALICE }))
    expect(textOf(panel()!)).not.toContain('Optimism')
  })
})
