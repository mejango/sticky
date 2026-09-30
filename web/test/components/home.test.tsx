import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HomeCard, HomeChain, SecuredSeries } from '@/lib/sticky-home'
import {
  E18,
  E6,
  HOLDER,
  TOKEN,
  deferred,
  feedRow as row,
  homeCard as card,
  homeChainOf as chainResult,
} from '../home-fixtures'

const mocks = vi.hoisted(() => ({
  index: vi.fn(),
  latest: vi.fn(),
  chain: vi.fn(),
  prices: vi.fn(),
  chainIds: vi.fn(),
  actualChainIds: null as null | ((environment: 'production' | 'testnet') => number[]),
  address: undefined as string | undefined,
  /** The chains whose accounts ENS names, and the names it has. */
  ensChains: new Set<number>(),
  names: new Map<string, string>(),
}))

vi.mock('@/lib/sticky-home', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-home')>()),
  homeIndex: mocks.index,
  homeLatest: mocks.latest,
  homeChain: mocks.chain,
  homePrices: mocks.prices,
}))
vi.mock('@/lib/sticky-addresses', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/sticky-addresses')>()
  mocks.actualChainIds = actual.stickyChainIds
  return { ...actual, stickyChainIds: mocks.chainIds }
})
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))
vi.mock('@/hooks/useProjectMetadata', () => ({
  useProjectMetadata: () => ({ data: undefined, isPending: false, isError: false, error: null }),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: mocks.address }) }))
vi.mock('@/lib/ens', () => ({
  ensAvailable: (chainId: number) => mocks.ensChains.has(chainId),
  lookupEnsName: async (address: string) => mocks.names.get(address.toLowerCase()) ?? null,
}))

import Home from '@/app/page'
import { HomeLists } from '@/components/home/HomeLists'
import { SecuredChart } from '@/components/home/SecuredChart'
import { StickiestCard } from '@/components/home/StickiestCard'
import { StickyFeed } from '@/components/StickyFeed'

const FUNDER = `0x${'b'.repeat(40)}` as Address
const RECIPIENT = `0x${'c'.repeat(40)}` as Address
const short = (address: Address) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** A viewport `width` px wide, for the home's `matchMedia` queries, which name Tailwind's breakpoints in rem. */
function stubWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number(/min-width:\s*([\d.]+)rem/.exec(query)?.[1]) * 16,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))
}

let host: HTMLDivElement
let root: Root
let client: QueryClient
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  stubWidth(1280)
  mocks.address = undefined
  mocks.ensChains = new Set()
  mocks.names = new Map()
  mocks.chainIds.mockReset().mockImplementation(mocks.actualChainIds!)
  mocks.index.mockReset().mockResolvedValue(null)
  mocks.latest.mockReset().mockResolvedValue(null)
  mocks.chain.mockReset().mockImplementation(async (chainId: number) => chainResult(chainId))
  mocks.prices.mockReset().mockResolvedValue(new Map())
  client = newClient()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  client.clear()
})

const settle = () => act(async () => void (await new Promise(resolve => setTimeout(resolve, 0))))
const inClient = (node: ReactNode, using = client) => <QueryClientProvider client={using}>{node}</QueryClientProvider>
async function renderHome(network: 'mainnet' | 'testnet' = 'mainnet', using = client) {
  await act(async () => root.render(inClient(<HomeLists network={network} />, using)))
  await settle()
}
async function renderNode(node: ReactNode) {
  await act(async () => root.render(inClient(node)))
}

const home = () => host.querySelector<HTMLElement>('[data-state]')!
const state = () => home().dataset.state
const status = () => host.querySelector('[role="status"]')!
const note = () => status().querySelector('span')?.textContent ?? ''
const retryButton = () =>
  [...host.querySelectorAll('button')].find(button => button.textContent === 'Try again') ?? null
const panel = (name: string) => host.querySelector<HTMLElement>(`#home-panel-${name}`)
const cards = () => [...(panel('stickiest')?.querySelectorAll<HTMLAnchorElement>('a[data-card]') ?? [])]
const tablist = (label: string) => host.querySelector<HTMLElement>(`[role="tablist"][aria-label="${label}"]`)
const tabs = (label: string) => [...(tablist(label)?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])]
const classes = (element: Element | null | undefined) => element?.className.split(/\s+/) ?? []

describe('the home route', () => {
  it.each([
    [{ network: 'testnet' }, 'testnet'],
    [{}, 'mainnet'],
    [{ network: 'mainnet' }, 'mainnet'],
    [{ network: ['testnet', 'testnet'] }, 'mainnet'],
  ])('reads the home of %o as %s', async (query, network) => {
    const page = await Home({ params: Promise.resolve({}), searchParams: Promise.resolve(query) })
    const [lists] = page.props.children
    expect(lists.type).toBe(HomeLists)
    expect(lists.props).toEqual({ network })
  })
})

describe('the home page, as its chains are read', () => {
  it('starts loading, busy, with no note, a placeholder in every list and the chart, and no caption', async () => {
    const pending = deferred<HomeChain>()
    mocks.chain.mockReturnValue(pending.promise)
    await renderHome()

    expect(state()).toBe('loading')
    expect(home().getAttribute('aria-busy')).toBe('true')
    expect(note()).toBe('')
    expect(retryButton()).toBeNull()
    for (const name of ['latest', 'stickiest', 'airdrops']) {
      expect(panel(name)?.querySelector('.skeleton-shimmer')).not.toBeNull()
    }
    expect(host.querySelector('#home-secured .skeleton-shimmer')).not.toBeNull()
    expect(host.textContent).not.toContain('History estimates')
    // No page-wide loading pill: the home draws its own placeholders and says nothing.
    expect(host.textContent).not.toMatch(/loading/i)
    pending.resolve(chainResult(1))
  })

  it('reads every Sticky chain of the network its link names, in the site\'s order of chains', async () => {
    await renderHome('mainnet')
    expect(mocks.chain.mock.calls.map(([chainId]) => chainId)).toEqual([1, 10, 8453, 42161])

    mocks.chain.mockClear()
    await act(async () => root.unmount())
    root = createRoot(host)
    await renderHome('testnet', newClient())
    expect(mocks.chain.mock.calls.map(([chainId]) => chainId)).toEqual([11155111, 11155420, 84532, 421614])
  })

  it('keeps loading, and says nothing, while one chain is still read after the others came back empty', async () => {
    const slow = deferred<HomeChain>()
    mocks.chain.mockImplementation(async (chainId: number) => (chainId === 8453 ? slow.promise : chainResult(chainId)))
    await renderHome()
    expect(state()).toBe('loading')
    expect(note()).toBe('')

    await act(async () => slow.resolve(chainResult(8453)))
    await settle()
    expect(state()).toBe('empty')
  })

  it('shows the zero state when no production chain has a Sticky token', async () => {
    await renderHome()
    expect(state()).toBe('empty')
    expect(home().getAttribute('aria-busy')).toBe('false')
    expect(note()).toBe('No sticky tokens yet.')
    expect(retryButton()).toBeNull()
  })

  it('names testnets in the testnet zero state', async () => {
    await renderHome('testnet')
    expect(note()).toBe('No sticky tokens on testnets yet.')
  })

  it('drops the dashboard in the zero state and shows the three steps, without dashes or dots', async () => {
    await renderHome()
    expect(host.querySelector('#home-secured')).toBeNull()
    expect(panel('latest')).toBeNull()
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    const steps = host.querySelector('ol[aria-label="How Sticky works"]')!
    expect([...steps.querySelectorAll('li')].map(step => step.querySelector('b')?.textContent)).toEqual([
      'Stick',
      'Earn',
      'Unstick',
    ])
    expect(steps.textContent).not.toMatch(/—|·/)
  })

  it('says it could not read Sticky tokens, with a retry, when every chain fails, and is no zero state', async () => {
    mocks.chain.mockRejectedValue(new Error('fetch failed'))
    await renderHome()
    expect(state()).toBe('error')
    expect(note()).toBe('Could not read Sticky tokens.')
    expect(retryButton()).not.toBeNull()
    expect(host.querySelector('#home-secured')).toBeNull()
    expect(host.querySelector('ol[aria-label="How Sticky works"]')).toBeNull()
  })

  it('is an error naming the chain that failed among empty ones', async () => {
    mocks.chain.mockImplementation(async (chainId: number) => {
      if (chainId === 8453) throw new Error('rpc down')
      return chainResult(chainId)
    })
    await renderHome()
    expect(state()).toBe('error')
    expect(note()).toBe('Could not read Sticky tokens on Base.')
    expect(retryButton()).not.toBeNull()
  })

  it('never blanks the chains that loaded because another failed, and names the one that did', async () => {
    mocks.chain.mockImplementation(async (chainId: number) => {
      if (chainId === 10) throw new Error('rpc down')
      return chainResult(chainId, chainId === 1 ? [card(1, 4n)] : chainId === 8453 ? [card(8453, 9n)] : [])
    })
    await renderHome()
    expect(state()).toBe('ready')
    expect(cards()).toHaveLength(2)
    expect(note()).toBe('Could not read Sticky tokens on Optimism.')
    expect(retryButton()).not.toBeNull()
  })

  it('draws the dashboard as each chain arrives', async () => {
    const slow = deferred<HomeChain>()
    mocks.chain.mockImplementation(async (chainId: number) =>
      chainId === 8453 ? slow.promise : chainResult(chainId, chainId === 1 ? [card(1, 4n)] : []),
    )
    await renderHome()
    expect(state()).toBe('ready')
    expect(cards()).toHaveLength(1)

    await act(async () => slow.resolve(chainResult(8453, [card(8453, 9n)])))
    await settle()
    expect(cards()).toHaveLength(2)
  })

  it('merges cards and feeds across chains, each card linking to its project on its own chain', async () => {
    mocks.chain.mockImplementation(async (chainId: number) => {
      const projectId = chainId === 84532 ? 37n : 20n
      return chainResult(chainId, chainId === 84532 || chainId === 11155420 ? [card(chainId, projectId)] : [], {
        activity: chainId === 84532 || chainId === 11155420 ? [row(chainId, projectId, chainId === 84532 ? 5 : 9)] : [],
      })
    })
    await renderHome('testnet')

    const links = cards().map(link => link.getAttribute('href'))
    expect(links).toContain('/basesep:37')
    expect(links).toContain('/opsep:20')
    const icons = cards().map(link => link.querySelector('[role="img"]')?.getAttribute('aria-label'))
    expect(icons).toContain('Base Sepolia')
    expect(icons).toContain('Optimism Sepolia')
    // Newest first, across chains.
    const feed = [...panel('latest')!.querySelectorAll('li')].map(item => item.querySelector('a[href^="/"]')?.getAttribute('href'))
    expect(feed).toEqual(['/opsep:20', '/basesep:37'])
  })

  it('collapses one launch\'s projects on different chains into one card with every chain\'s icon', async () => {
    const launch = { launchId: 'L1' }
    mocks.chain.mockImplementation(async (chainId: number) => {
      if (chainId === 84532) return chainResult(chainId, [card(84532, 37n, launch), card(84532, 38n, launch), card(84532, 39n)])
      if (chainId === 11155420) return chainResult(chainId, [card(11155420, 20n, launch)])
      return chainResult(chainId)
    })
    await renderHome('testnet')

    // A second project on the same chain with a copied launch id keeps a card of its own.
    expect(cards()).toHaveLength(3)
    // Chains come in the site's order, Optimism Sepolia before Base Sepolia, and the card opens the first one's project.
    const grouped = cards().find(link => link.querySelector('[role="img"]')?.getAttribute('aria-label') === 'Optimism Sepolia, Base Sepolia')!
    expect(grouped.getAttribute('href')).toBe('/opsep:20')
    expect(grouped.textContent).toContain('Sticks: 2')
    expect(grouped.textContent).toContain('Backing: 2 CPN')
    // A launch's card names no project ID: it stands for one on each chain.
    expect(grouped.textContent).not.toContain('#37')
  })

  it('goes back to loading on Try again, reads every chain again, and draws what it finds', async () => {
    mocks.chain.mockRejectedValue(new Error('fetch failed'))
    await renderHome()
    expect(state()).toBe('error')

    const reads = deferred<void>()
    mocks.chain.mockReset().mockImplementation(async (chainId: number) => {
      await reads.promise
      return chainResult(chainId, chainId === 1 ? [card(1, 4n)] : [])
    })
    await act(async () => retryButton()!.click())
    await settle()
    expect(state()).toBe('loading')
    expect(note()).toBe('')
    expect(cards()).toHaveLength(0)

    await act(async () => reads.resolve())
    await settle()
    expect(mocks.chain.mock.calls.map(([chainId]) => chainId)).toEqual([1, 10, 8453, 42161])
    expect(state()).toBe('ready')
    expect(note()).toBe('')
    expect(cards()[0].textContent).toContain('STK')
  })

  it('stays ready, marked as unconfirmed, while a return visit reads the chains again', async () => {
    mocks.chain.mockImplementation(async (chainId: number) => chainResult(chainId, [card(chainId, 1n)]))
    await renderHome()
    expect(state()).toBe('ready')
    await act(async () => root.unmount())

    const again = deferred<void>()
    mocks.chain.mockImplementation(async (chainId: number) => {
      await again.promise
      return chainResult(chainId, [card(chainId, 1n)])
    })
    root = createRoot(host)
    await renderHome()
    expect(state()).toBe('ready')
    expect(panel('stickiest')!.querySelector('.revalidating')).not.toBeNull()

    await act(async () => again.resolve())
    await settle()
    expect(state()).toBe('ready')
    expect(panel('stickiest')!.querySelector('.revalidating')).toBeNull()
  })

  it.each([
    ['mainnet', 'Sticky is not deployed yet.'],
    ['testnet', 'Sticky is not on testnets yet.'],
  ] as const)('says Sticky is not on %s when its network has no deployment, and reads nothing', async (network, text) => {
    mocks.chainIds.mockReturnValue([])
    await renderHome(network)
    expect(state()).toBe('error')
    expect(note()).toBe(text)
    expect(retryButton()).toBeNull()
    expect(mocks.chain).not.toHaveBeenCalled()
    expect(mocks.index).not.toHaveBeenCalled()
  })
})

describe('the home page\'s lists and tabs', () => {
  beforeEach(() => {
    mocks.chain.mockImplementation(async (chainId: number) => chainResult(chainId, chainId === 1 ? [card(1, 4n)] : []))
  })

  it('gives phones Latest, Stickiest and Airdrops tabs, tablets Stickiest and Airdrops, and desktops all three lists', async () => {
    await renderHome()
    // Phones (below 640 px): one tab row for the three lists.
    expect(tabs('Homepage lists').map(tab => tab.textContent)).toEqual(['Latest', 'Stickiest', 'Airdrops'])
    expect(classes(tablist('Homepage lists'))).toEqual(expect.arrayContaining(['flex', 'sm:hidden']))
    // Tablets (640 to 1279 px): Latest stands on its own, the rankings share a tab row.
    expect(tabs('Sticky rankings').map(tab => tab.textContent)).toEqual(['Stickiest', 'Airdrops'])
    expect(classes(tablist('Sticky rankings'))).toEqual(expect.arrayContaining(['hidden', 'sm:flex', 'xl:hidden']))
    // Latest shows from 640 px up, and Stickiest and Airdrops both show from 1280 px up.
    expect(classes(panel('latest'))).toEqual(expect.arrayContaining(['block', 'sm:block']))
    expect(classes(panel('stickiest'))).toEqual(expect.arrayContaining(['hidden', 'sm:block', 'xl:block']))
    expect(classes(panel('airdrops'))).toEqual(expect.arrayContaining(['hidden', 'sm:hidden', 'xl:block']))
  })

  it.each([
    [390, { latest: 'home-tab-latest', stickiest: 'home-tab-stickiest', airdrops: 'home-tab-airdrops' }],
    [768, { latest: null, stickiest: 'home-rank-stickiest', airdrops: 'home-rank-airdrops' }],
    [1280, { latest: null, stickiest: null, airdrops: null }],
  ])('at %i px names each list after the one tab that shows it, and makes no tab panel of a list no tab shows', async (width, labels) => {
    stubWidth(width)
    await renderHome()
    for (const [name, label] of Object.entries(labels)) {
      const list = panel(name)!
      expect([name, list.getAttribute('role'), list.getAttribute('aria-labelledby')]).toEqual(
        label ? [name, 'tabpanel', label] : [name, null, null],
      )
    }
  })

  it('switches the phone list and the tablet ranking by their tabs', async () => {
    await renderHome()
    await act(async () => tabs('Homepage lists')[2].click())
    expect(classes(panel('airdrops'))).toContain('block')
    expect(classes(panel('latest'))).toContain('hidden')
    expect(tabs('Homepage lists')[2].getAttribute('aria-selected')).toBe('true')

    await act(async () => tabs('Sticky rankings')[1].click())
    expect(classes(panel('airdrops'))).toContain('sm:block')
    expect(classes(panel('stickiest'))).toContain('sm:hidden')
    expect(tabs('Sticky rankings')[1].getAttribute('aria-selected')).toBe('true')
  })

  it.each([
    ['Homepage lists', ['Latest', 'Stickiest', 'Airdrops']],
    ['Sticky rankings', ['Stickiest', 'Airdrops']],
  ] as const)('moves between the %s tabs with the arrow keys, Home and End', async (label, names) => {
    await renderHome()
    const selected = () => tabs(label).find(tab => tab.getAttribute('aria-selected') === 'true')!.textContent
    const focused = () => (document.activeElement as HTMLElement).textContent
    const press = (key: string) =>
      act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))

    tabs(label)[0].focus()
    expect(tabs(label).map(tab => tab.tabIndex)).toEqual(names.map((_, at) => (at === 0 ? 0 : -1)))
    await press('ArrowRight')
    expect([selected(), focused()]).toEqual([names[1], names[1]])
    await press('End')
    expect([selected(), focused()]).toEqual([names.at(-1), names.at(-1)])
    await press('ArrowRight')
    expect([selected(), focused()]).toEqual([names[0], names[0]])
    await press('ArrowLeft')
    expect([selected(), focused()]).toEqual([names.at(-1), names.at(-1)])
    await press('Home')
    expect([selected(), focused()]).toEqual([names[0], names[0]])
    // The selected tab is the one in the page's tab order.
    expect(tabs(label).map(tab => tab.tabIndex)).toEqual(names.map((_, at) => (at === 0 ? 0 : -1)))
  })
})

describe('the secured chart on the home page', () => {
  it('waits for every loaded chain\'s prices, then draws 28 bars and today\'s value', async () => {
    mocks.chain.mockImplementation(async (chainId: number) =>
      chainResult(chainId, chainId === 1 || chainId === 10 ? [card(chainId, 1n, { decimals: 6, backing: 3n * E6 })] : []),
    )
    const slow = deferred<Map<Address, number>>()
    mocks.prices.mockImplementation(async (chainId: number) => (chainId === 10 ? slow.promise : new Map([[TOKEN, 2]])))
    await renderHome()
    expect(host.querySelectorAll('#home-secured [data-bar]')).toHaveLength(0)
    expect(host.querySelector('#home-secured .skeleton-shimmer')).not.toBeNull()

    await act(async () => slow.resolve(new Map([[TOKEN, 1]])))
    await settle()
    expect(host.querySelectorAll('#home-secured [data-bar]')).toHaveLength(28)
    // $6 on Ethereum and $3 on Optimism.
    expect(host.querySelector('#home-secured-value')!.textContent).toBe('$9.00')
    expect(host.textContent).toContain('History estimates past shares at today\'s backing per share and token price.')
  })

  it('asks for each loaded chain\'s staked tokens once', async () => {
    mocks.chain.mockImplementation(async (chainId: number) => chainResult(chainId, chainId === 8453 ? [card(8453, 23n)] : []))
    await renderHome()
    expect(mocks.prices).toHaveBeenCalledWith(8453, [TOKEN], expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })
})

const NOW = 1_790_000_000
const series = (extra: Partial<SecuredSeries> = {}): SecuredSeries => ({
  points: [
    { timestamp: NOW - 27 * 86_400, value: 1_000_000n },
    { timestamp: NOW, value: 28_000_000n },
  ],
  total: 28_000_000n,
  missing: [],
  hasValue: true,
  ...extra,
})
const day = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

describe('SecuredChart', () => {
  const plot = () => host.querySelector<HTMLElement>('[role="img"]')!
  const active = () => [...host.querySelectorAll('[data-bar]')].findIndex(bar => bar.getAttribute('data-active') === 'true')
  const readout = () => host.querySelector<HTMLElement>('[aria-live="polite"]')!
  const renderChart = async (value: SecuredSeries | null = series()) => {
    await renderNode(<SecuredChart series={value} pending={false} />)
    const bars = host.querySelector<HTMLElement>('[data-bars]')
    if (bars) {
      bars.getBoundingClientRect = () => ({ left: 100, width: 280, top: 0, height: 0, right: 380, bottom: 0, x: 100, y: 0, toJSON: () => ({}) })
    }
  }
  const pointer = (type: string, clientX: number, pointerType = 'mouse') =>
    act(async () => void plot().dispatchEvent(new PointerEvent(type, { clientX, pointerType, bubbles: true })))
  // React makes onPointerLeave of a pointerout whose next target is outside the element.
  const leave = (pointerType: string) =>
    act(
      async () =>
        void plot().dispatchEvent(new PointerEvent('pointerout', { pointerType, bubbles: true, relatedTarget: document.body })),
    )
  const key = (name: string) => act(async () => void plot().dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })))

  it('shows today\'s value, the caption and a named plot, with no bar picked', async () => {
    await renderChart()
    expect(host.querySelector('#home-secured-value')!.textContent).toBe('$28.00')
    expect(plot().getAttribute('aria-label')).toBe('$28.00 secured by Sticky')
    expect(plot().tabIndex).toBe(0)
    expect(active()).toBe(-1)
    expect(readout().className).toContain('invisible')
  })

  it('says the value is unavailable, and drops the caption, when no stuck token has a price', async () => {
    await renderChart(series({ hasValue: false, total: 0n, missing: ['CPN'] }))
    expect(host.querySelector('#home-secured-value')!.textContent).toBe('$—')
    expect(host.querySelector('#home-secured-value')!.getAttribute('title')).toBe('Could not price CPN')
    expect(host.textContent).not.toContain('History estimates')
    expect(plot().getAttribute('aria-label')).toBe('USD value unavailable secured by Sticky')
  })

  it('draws a placeholder and no bars until it has a series', async () => {
    await renderChart(null)
    expect(host.querySelectorAll('[data-bar]')).toHaveLength(0)
    expect(host.querySelector('.skeleton-shimmer')).not.toBeNull()
  })

  it('picks the bar under the pointer and shows its date and value, and lets go when a mouse leaves', async () => {
    await renderChart()
    // 280 px for 28 bars: x = 100 + 10 * 14 + 5 is inside bar 14.
    await pointer('pointermove', 245)
    expect(active()).toBe(14)
    expect(readout().className).not.toContain('invisible')
    expect(readout().textContent).toContain(`Date: ${day(NOW - 13 * 86_400)}`)
    expect(readout().textContent).toContain('Value: ≈ $1.00')
    expect(plot().getAttribute('aria-label')).toBe(`${day(NOW - 13 * 86_400)}: $1.00 secured by Sticky`)

    await leave('touch')
    expect(active()).toBe(14)
    await leave('mouse')
    expect(active()).toBe(-1)
    expect(plot().getAttribute('aria-label')).toBe('$28.00 secured by Sticky')
  })

  it('picks a bar where a touch lands, and keeps a pointer past the edge on the last bar', async () => {
    await renderChart()
    await pointer('pointerdown', 101, 'touch')
    expect(active()).toBe(0)
    await pointer('pointermove', 1_000)
    expect(active()).toBe(27)
  })

  it('keeps the bar a tap picked when the plot takes focus after it', async () => {
    await renderChart()
    // A tap is a pointerdown, and then the plot takes focus.
    await pointer('pointerdown', 145, 'touch')
    await act(async () => plot().focus())
    expect(active()).toBe(4)
  })

  it('picks today\'s bar on focus, walks the bars with ← and →, and lets go on blur', async () => {
    await renderChart()
    await act(async () => plot().focus())
    expect(active()).toBe(27)
    expect(readout().textContent).toContain('Value: ≈ $28.00')
    await key('ArrowLeft')
    expect(active()).toBe(26)
    await key('ArrowRight')
    await key('ArrowRight')
    expect(active()).toBe(27)
    await key('ArrowUp')
    expect(active()).toBe(27)
    await act(async () => plot().blur())
    expect(active()).toBe(-1)
  })

  it('labels the first and last day on its axis, and each bar with its estimate', async () => {
    await renderChart()
    expect(host.textContent).toContain(day(NOW - 27 * 86_400))
    expect(host.textContent).toContain(day(NOW))
    expect(host.querySelectorAll('[data-bar]')[27].getAttribute('title')).toBe(
      `${day(NOW)}: $28.00 (current backing and price estimate)`,
    )
  })
})

describe('StickyFeed', () => {
  const SLOPSHOP = { value: 1_010n * E6, decimals: 6, symbol: 'SLOPSHOP' }
  const items = () => [...host.querySelectorAll('li')]
  const amountOf = (item: Element) => item.querySelector('[data-amount]')?.textContent

  it('shows a stick and an unstick in the underlying token, and a transfer in Sticky shares', async () => {
    const rows = [
      row(8453, 23n, NOW, { direction: 'out', amount: { value: 99n * E6, decimals: 6, symbol: 'SLOPSHOP' }, line: { kind: 'unstuck', holder: HOLDER } }),
      row(8453, 23n, NOW, { direction: 'in', amount: SLOPSHOP, line: { kind: 'stuck', holder: HOLDER } }),
      row(8453, 23n, NOW, {
        direction: 'in',
        amount: { value: 10n * E18, decimals: 18, symbol: 'STICKYSLOPSHOP' },
        line: { kind: 'gift', holder: RECIPIENT, payer: HOLDER },
      }),
    ]
    await renderNode(<StickyFeed rows={rows} empty="No activity yet" />)
    expect(items().map(amountOf)).toEqual(['99 SLOPSHOP', '1,010 SLOPSHOP', '10 STICKYSLOPSHOP'])
    expect(items().map(item => item.querySelector('[data-direction]')?.textContent)).toEqual(['out', 'in', 'in'])
    expect(items().map(item => item.querySelector('p')?.textContent)).toEqual([
      `unstuck by ${short(HOLDER)}`,
      `stuck by ${short(HOLDER)}`,
      `to ${short(RECIPIENT)} from ${short(HOLDER)}`,
    ])
  })

  it('reads a streak on the row of the stick or unstick it came with, and gives a lone streak its own', async () => {
    const rows = [
      row(8453, 23n, NOW, { direction: 'out', amount: { value: 10n * E18, decimals: 18, symbol: 'STK' }, line: { kind: 'removed', holder: HOLDER, streak: { endedAfter: 86_400n } } }),
      row(8453, 23n, NOW, { direction: null, amount: null, line: { kind: 'gotSticky', holder: RECIPIENT } }),
      row(8453, 23n, NOW, { line: { kind: 'stuck', holder: HOLDER, streak: 'started' } }),
      row(8453, 23n, NOW, { direction: null, amount: null, line: { kind: 'cameUnstuck', holder: FUNDER, length: 3_700n } }),
      row(8453, 23n, NOW, { line: { kind: 'autoStuck', holder: HOLDER } }),
    ]
    await renderNode(<StickyFeed rows={rows} empty="No activity yet" />)
    expect(items()[0].querySelector('p')!.textContent).toBe(`removed by ${short(HOLDER)} and came unstuck after 1d 0h`)
    expect(items()[1].textContent).toContain(`${short(RECIPIENT)} got sticky`)
    expect(items()[1].querySelector('[data-direction]')).toBeNull()
    expect(items()[2].querySelector('p')!.textContent).toBe(`stuck by ${short(HOLDER)} and got sticky`)
    expect(items()[3].textContent).toContain(`${short(FUNDER)} came unstuck after 1h 1m`)
    expect(items()[4].querySelector('p')!.textContent).toBe(`auto-stuck by ${short(HOLDER)}`)
  })

  it('links the age and the chain to the transaction, with its full time on the age', async () => {
    const shown = row(8453, 23n, NOW - 7_200)
    vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
    await renderNode(<StickyFeed rows={[shown]} empty="No activity yet" />)
    const links = [...items()[0].querySelectorAll<HTMLAnchorElement>(`a[href="https://basescan.org/tx/${shown.txHash}"]`)]
    expect(links.map(link => link.textContent || link.getAttribute('aria-label'))).toEqual([
      '2h ago',
      'View transaction on Base',
    ])
    expect(links[0].title).toBe(new Date((NOW - 7_200) * 1000).toLocaleString())
    expect(links.every(link => link.target === '_blank' && link.rel === 'noopener noreferrer')).toBe(true)
  })

  it('links each row\'s project when given its label, as the home does, and not otherwise', async () => {
    await renderNode(<StickyFeed rows={[row(8453, 23n, NOW)]} empty="No activity yet" label={() => 'STICKYCPN'} />)
    const project = items()[0].querySelector<HTMLAnchorElement>('a[href="/base:23"]')!
    expect(project.textContent).toBe('STICKYCPN')

    await renderNode(<StickyFeed rows={[row(8453, 23n, NOW)]} empty="No activity yet" />)
    expect(items()[0].querySelector('a[href="/base:23"]')).toBeNull()
  })

  it('names an account by ENS on a production chain\'s rows only, even once the name is known', async () => {
    mocks.ensChains = new Set([8453])
    mocks.names = new Map([[HOLDER, 'alice.eth']])
    await renderNode(<StickyFeed rows={[row(8453, 23n, NOW)]} empty="No activity yet" />)
    await settle()
    expect(items()[0].querySelector('p')!.textContent).toBe('stuck by alice.eth')

    await renderNode(<StickyFeed rows={[row(84532, 23n, NOW)]} empty="No activity yet" />)
    await settle()
    expect(items()[0].querySelector('p')!.textContent).toBe(`stuck by ${short(HOLDER)}`)
  })

  it('marks the viewer\'s own airdrop', async () => {
    const gift = row(8453, 23n, NOW, { line: { kind: 'gift', holder: RECIPIENT, payer: FUNDER } })
    await renderNode(<StickyFeed rows={[gift]} empty="No airdrops yet" you={getAddress(RECIPIENT)} />)
    expect(items()[0].querySelector('p')!.textContent).toBe(`to ${short(RECIPIENT)} (you) from ${short(FUNDER)}`)
  })

  it('says when a list is empty, and draws a placeholder while it has no rows yet', async () => {
    await renderNode(<StickyFeed rows={[]} empty="No airdrops yet" />)
    expect(host.textContent).toBe('No airdrops yet')
    await renderNode(<StickyFeed rows={undefined} empty="No airdrops yet" />)
    expect(host.querySelector('.skeleton-shimmer')).not.toBeNull()
    expect(host.textContent).toBe('')
  })
})

describe('StickiestCard', () => {
  const renderCard = (group: HomeCard[], rank = 1) =>
    renderNode(<StickiestCard group={{ cards: group, totalStaked: 0n }} rank={rank} />)

  it('shows the backing holders can claim in the underlying token, never the Sticky supply', async () => {
    await renderCard([card(8453, 23n, { decimals: 6, symbol: 'SLOPSHOP', backing: 7n * E6, totalSupply: 5n * E18 })])
    expect(host.textContent).toContain('Backing: 7 SLOPSHOP')
    expect(host.textContent).not.toContain('Backing: 5')
  })

  it('shows its rank, its Sticky name, its project ID and chain, its Sticks and its stickiness bonus', async () => {
    await renderCard([card(8453, 23n, { stSymbol: 'STICKYCPN', cashOutTaxRate: 1_250n }, 4)], 3)
    const link = host.querySelector<HTMLAnchorElement>('a[data-card]')!
    expect(link.getAttribute('href')).toBe('/base:23')
    expect(link.textContent).toContain('3')
    expect(link.textContent).toContain('STICKYCPN #23')
    expect(link.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Base')
    expect(link.textContent).toContain('Sticks: 4')
    expect(link.textContent).toContain('Bonus: 12.5%')
  })

  it('names a Sticky token without its own symbol after the token it sticks', async () => {
    await renderCard([card(8453, 23n, { stSymbol: '' })])
    expect(host.textContent).toContain('Sticky CPN')
  })

  it('lists each chain\'s backing when a launch\'s chains back it with different tokens', async () => {
    await renderCard([
      card(1, 2n, { launchId: 'L', symbol: 'CPN', decimals: 18, backing: E18 }),
      card(10, 3n, { launchId: 'L', symbol: 'USDC', decimals: 6, backing: 2n * E6 }),
    ])
    expect(host.textContent).toContain('Backing: 1 CPN, 2 USDC')
  })
})
