import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import type { StickyEvent } from '@/lib/sticky-events'
import type { IndexedProjects } from '@/lib/sticky-indexed'
import {
  E18,
  E6,
  HOLDER,
  OTHER,
  chainsOf,
  fakeCenter,
  oneAfterAnother,
  positionRow,
  stick,
  type Call,
  type FakeChain,
} from '../account-fixtures'
import { POSITION_TOPICS, deployment, staked, streakStarted, topic, unstaked } from '../lib/sticky-log-fixtures'

const mocks = vi.hoisted(() => ({
  positions: vi.fn(),
  projects: vi.fn(),
  projectsOn: vi.fn(),
  events: vi.fn(),
  scan: vi.fn(),
  moves: vi.fn(),
  client: vi.fn(),
  /** The connected wallet. */
  address: undefined as string | undefined,
}))

vi.mock('@/lib/sticky-indexed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-indexed')>()),
  indexedStickyPositions: mocks.positions,
  indexedStickyProjects: mocks.projects,
}))
vi.mock('@/lib/sticky-events', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-events')>()),
  stickyHolderEvents: mocks.events,
  stickyProjectsOn: mocks.projectsOn,
  scanToHead: mocks.scan,
}))
vi.mock('@/lib/sticky-feed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-feed')>()),
  terminalMoves: mocks.moves,
}))
vi.mock('@/lib/activity-groups', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/activity-groups')>()
  return { ...actual, groupSameTx: vi.fn(actual.groupSameTx) }
})
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: mocks.client }))
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))
vi.mock('@/hooks/useProjectMetadata', () => ({
  useProjectMetadata: () => ({ data: undefined, isPending: false, isError: false, error: null }),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: mocks.address }) }))
vi.mock('@/lib/ens', () => ({ ensAvailable: () => false, lookupEnsName: async () => null }))

import AccountPage, { generateMetadata } from '@/app/account/[address]/page'
import { AccountActivity } from '@/components/account/AccountActivity'
import { AccountHeader } from '@/components/account/AccountHeader'
import { AccountPositions } from '@/components/account/AccountPositions'
import { groupSameTx } from '@/lib/activity-groups'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { scanFrom } from '@/lib/sticky-events'
import { moveKey } from '@/lib/sticky-feed'
import { clearViewAs, setViewAs } from '@/lib/viewAs'

const MAINNET = [1, 10, 8453, 42161]
const TESTNET = [11155111, 11155420, 84532, 421614]
const NOW = 1_790_000_000
const CHECKSUMMED = getAddress(HOLDER)
const short = (address: Address) => `${address.slice(0, 6)}…${address.slice(-4)}`

let host: HTMLDivElement
let root: Root
let client: QueryClient
/** What each chain holds, and the requests the chains got. */
let world: Record<number, FakeChain>
let calls: Call[]
let broken: Set<number>
/** What each chain's hook logged for the account past the block Bendystraw is indexed through, or why it cannot say. */
let tails: Record<number, ScannedLog[] | Error>

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
/** A Bendystraw answer that lists `rows` and covers `chainIds`, indexed through block `through`. */
const listing = (rows: ReturnType<typeof positionRow>[], chainIds = MAINNET, through = 100n) => ({
  rows,
  blocks: new Map(chainIds.map(chainId => [chainId, through])),
})

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000)
  world = {}
  calls = []
  broken = new Set()
  tails = {}
  mocks.address = undefined
  clearViewAs()
  mocks.positions.mockReset().mockImplementation(async ({ chainIds }: { chainIds: number[] }) => listing([], chainIds))
  mocks.projects.mockReset().mockResolvedValue({ blocks: new Map(), projects: [] } satisfies IndexedProjects)
  mocks.projectsOn.mockReset().mockResolvedValue({ projects: [], source: 'scanned', degraded: 'indexer-error' })
  mocks.events.mockReset().mockResolvedValue({ events: [], source: 'indexed', degraded: null })
  mocks.scan.mockReset().mockImplementation(async (chainId: number) => {
    calls.push({ chainId, phase: 'start', what: 'scan' })
    try {
      await Promise.resolve()
      await Promise.resolve()
      if (broken.has(chainId)) throw new Error('rpc down')
      const tail = tails[chainId] ?? []
      if (tail instanceof Error) throw tail
      return tail
    } finally {
      calls.push({ chainId, phase: 'end', what: 'scan' })
    }
  })
  mocks.moves.mockReset().mockResolvedValue(new Map())
  mocks.client.mockReset().mockImplementation(fakeCenter(world, calls, { broken }))
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

const settle = (ms = 0) => act(async () => void (await new Promise(resolve => setTimeout(resolve, ms))))
const inClient = (node: ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>
async function renderNode(node: ReactNode) {
  await act(async () => root.render(inClient(node)))
  await settle()
}
const renderPositions = (network: 'mainnet' | 'testnet' = 'mainnet', address: Address = CHECKSUMMED) =>
  renderNode(<AccountPositions address={address} network={network} />)
const renderActivity = (network: 'mainnet' | 'testnet' = 'mainnet', address: Address = CHECKSUMMED) =>
  renderNode(<AccountActivity address={address} network={network} />)

const cards = () => [...host.querySelectorAll<HTMLAnchorElement>('a[data-position]')]
const note = () => host.querySelector('[role="status"]')!.textContent ?? ''
const retryButton = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Retry') ?? null
const feed = () => [...host.querySelectorAll('li')]
const lines = () => feed().map(item => item.querySelector('p')?.textContent)
const amounts = () => feed().map(item => item.querySelector('[data-amount]')?.textContent)
const classes = (element: Element) => element.className.split(/\s+/)
/** The requests a chain got for StickyHook's views of the account. */
const balanceReads = (chainId: number) =>
  calls.filter(call => call.chainId === chainId && call.phase === 'start' && call.what.includes('stakedBalanceOf'))

describe('the account route', () => {
  const props = (address: string, query: Record<string, string | string[]> = {}) => ({
    params: Promise.resolve({ address }),
    searchParams: Promise.resolve(query),
  })
  const parts = async (address: string, query?: Record<string, string | string[]>) => {
    const page = await AccountPage(props(address, query))
    const [header, columns] = page.props.children
    return { header, positions: columns.props.children[0], activity: columns.props.children[1] }
  }

  it('shows the account\'s header, positions and activity, for its checksummed address', async () => {
    const { header, positions, activity } = await parts(HOLDER)
    expect(header.type).toBe(AccountHeader)
    expect(positions.type).toBe(AccountPositions)
    expect(activity.type).toBe(AccountActivity)
    for (const part of [header, positions, activity]) expect(part.props.address).toBe(CHECKSUMMED)
  })

  it.each([
    [{ network: 'testnet' }, 'testnet'],
    [{}, 'mainnet'],
    [{ network: 'mainnet' }, 'mainnet'],
    [{ network: ['testnet', 'testnet'] }, 'mainnet'],
  ])('reads the chains of the network %o names, which is %s', async (query, network) => {
    const { positions, activity } = await parts(HOLDER, query)
    expect(positions.props.network).toBe(network)
    expect(activity.props.network).toBe(network)
  })

  it('reads an address of any case, and is not found for what is not an address', async () => {
    const { header } = await parts(`0x${'A'.repeat(40)}`)
    expect(header.props.address).toBe(getAddress(`0x${'a'.repeat(40)}`))
    for (const not of ['0x123', 'alice.eth', `0x${'g'.repeat(40)}`]) {
      await expect(AccountPage(props(not))).rejects.toMatchObject({ digest: expect.stringContaining('404') })
    }
  })

  it('names the tab after the account', async () => {
    expect(await generateMetadata(props(HOLDER))).toEqual({ title: `Account ${short(CHECKSUMMED)}` })
    expect(await generateMetadata(props('nobody'))).toEqual({ title: 'Account' })
  })
})

describe('the account\'s title', () => {
  const title = () => host.querySelector('h1')!.textContent

  it('is "Your account" for the connected wallet, however its address is written, and "Account" for any other', async () => {
    mocks.address = HOLDER
    await renderNode(<AccountHeader address={CHECKSUMMED} />)
    expect(title()).toBe('Your account')

    mocks.address = OTHER
    await renderNode(<AccountHeader address={CHECKSUMMED} />)
    expect(title()).toBe('Account')

    mocks.address = undefined
    await renderNode(<AccountHeader address={CHECKSUMMED} />)
    expect(title()).toBe('Account')
  })

  it('is "Account" for the account the site is viewed as: viewing as an account does not make it yours', async () => {
    mocks.address = OTHER
    await act(async () => setViewAs(CHECKSUMMED))
    await renderNode(<AccountHeader address={CHECKSUMMED} />)
    expect(title()).toBe('Account')

    mocks.address = undefined
    await renderNode(<AccountHeader address={CHECKSUMMED} />)
    expect(title()).toBe('Account')

    await act(async () => setViewAs(getAddress(OTHER)))
    expect(title()).toBe('Account')
  })

  it('is still "Your account" for the connected wallet while the site is viewed as another account', async () => {
    mocks.address = HOLDER
    await act(async () => setViewAs(getAddress(OTHER)))
    await renderNode(<AccountHeader address={CHECKSUMMED} />)
    expect(title()).toBe('Your account')
  })

  it('shows the whole address, and a logo of its own that a screen reader skips', async () => {
    await renderNode(<AccountHeader address={CHECKSUMMED} />)
    expect(host.textContent).toContain(CHECKSUMMED)
    const logo = host.querySelector('svg')!
    expect(logo.getAttribute('aria-hidden')).toBe('true')
    expect(logo.textContent).toBe('A')
  })
})

describe('the account\'s positions', () => {
  it('asks Bendystraw once for the network\'s positions of the account, on every one of its chains', async () => {
    await renderPositions()
    expect(mocks.positions).toHaveBeenCalledTimes(1)
    expect(mocks.positions).toHaveBeenCalledWith({ holder: HOLDER, chainIds: MAINNET }, expect.any(AbortSignal))

    mocks.positions.mockClear()
    await act(async () => root.unmount())
    client = newClient()
    root = createRoot(host)
    await renderPositions('testnet')
    expect(mocks.positions).toHaveBeenCalledTimes(1)
    expect(mocks.positions).toHaveBeenCalledWith({ holder: HOLDER, chainIds: TESTNET }, expect.any(AbortSignal))
  })

  it('reads each listed position\'s balance on its own chain, one chain after another, and asks no chain for one it lists none in', async () => {
    mocks.positions.mockResolvedValue(
      listing([positionRow(1, 5n), positionRow(10, 4n), positionRow(8453, 23n), positionRow(8453, 24n)]),
    )
    world[1] = { '5': { staked: E18 } }
    world[10] = { '4': { staked: E18 } }
    world[8453] = { '23': { staked: E18 }, '24': { staked: E18 } }
    await renderPositions()

    // Chain 1's requests all end before chain 10's begin, and so on. Arbitrum lists nothing, so its balances are not read.
    expect(chainsOf(calls)).toEqual(MAINNET)
    expect(oneAfterAnother(calls)).toBe(true)
    const first = (chainId: number) => calls.findIndex(call => call.chainId === chainId)
    const last = (chainId: number) => calls.findLastIndex(call => call.chainId === chainId)
    expect(last(1)).toBeLessThan(first(10))
    expect(last(10)).toBeLessThan(first(8453))
    expect(last(8453)).toBeLessThan(first(42161))
    expect(balanceReads(8453)).toHaveLength(1)
    expect(balanceReads(42161)).toHaveLength(0)
    expect(cards().map(card => card.getAttribute('href'))).toEqual(['/eth:5', '/op:4', '/base:23', '/base:24'])
  })

  it('does not start another chain while one is still being read', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(1, 5n), positionRow(10, 4n)]))
    world[1] = { '5': { staked: E18 } }
    world[10] = { '4': { staked: E18 } }
    const slow = Promise.withResolvers<void>()
    const center = fakeCenter(world, calls)
    mocks.client.mockImplementation((chainId: number) => {
      const chain = center(chainId)
      if (chainId !== 1) return chain
      const multicall = chain.multicall.bind(chain)
      return { ...chain, multicall: async (parameters: never) => (await slow.promise, multicall(parameters)) }
    })
    await renderPositions()
    // Chain 1 has read the account's position events, and its balances are stuck: no other chain has begun.
    expect(chainsOf(calls)).toEqual([1])
    expect(cards()).toHaveLength(0)

    await act(async () => slow.resolve())
    await settle()
    expect(chainsOf(calls)).toEqual(MAINNET)
    expect(oneAfterAnother(calls)).toBe(true)
    expect(cards()).toHaveLength(2)
  })

  it('takes the balance from the chain, not from what Bendystraw last saw', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n, { stakedBalance: 999n * E18 })]))
    world[8453] = { '23': { symbol: 'SLOPSHOP', decimals: 6, supply: 100n * E18, backing: 200n * E6, staked: 10n * E18 } }
    await renderPositions()
    expect(cards()[0].textContent).toContain('Stuck: 20 SLOPSHOP')
  })

  it('shows what the shares can claim in the underlying token, never the Sticky shares', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n), positionRow(8453, 24n)]))
    world[8453] = {
      // 50 of 100 shares claim half of 202 SLOPSHOP.
      '23': { symbol: 'SLOPSHOP', decimals: 6, stSymbol: 'STICKYSLOPSHOP', supply: 100n * E18, backing: 202n * E6, staked: 50n * E18 },
      // With no shares in circulation there is nothing to claim.
      '24': { symbol: 'SLOPSHOP', decimals: 6, stSymbol: 'STICKYSLOPSHOP', supply: 0n, backing: 0n, staked: 50n * E18 },
    }
    await renderPositions()
    const [claim, none] = cards().map(card => card.textContent)
    expect(claim).toContain('Stuck: 101 SLOPSHOP')
    expect(claim).not.toContain('50 STICKYSLOPSHOP')
    expect(none).toContain('Stuck: 0 SLOPSHOP')
  })

  it('shows the project, its chain, its stuck amount, its streak and the longest streak', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n), positionRow(8453, 24n)]))
    world[8453] = {
      '23': { symbol: 'CPN', stSymbol: 'STICKYCPN', staked: E18, start: NOW - 90_000, longest: 100_000 },
      // The streak that is running counts among the longest.
      '24': { staked: E18, start: NOW - 90_000, longest: 3_600 },
    }
    await renderPositions()
    const [first, second] = cards()
    expect(first.getAttribute('href')).toBe('/base:23')
    expect(first.textContent).toContain('STICKYCPN #23')
    expect(first.querySelector('[role="img"]')!.getAttribute('aria-label')).toBe('Base')
    expect(first.textContent).toContain('Stuck: 1 CPN')
    expect(first.textContent).toContain('Time: 1d 1h')
    expect(first.textContent).toContain('Longest: 1d 3h')
    expect(second.textContent).toContain('Longest: 1d 1h')
  })

  it('lets the name of a token wrap, so that a very long one does not widen the page', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n)]))
    world[8453] = { '23': { symbol: 'X'.repeat(200), stSymbol: 'Y'.repeat(200), staked: E18 } }
    await renderPositions()
    const details = cards()[0].querySelector('.break-words')!
    expect(details.textContent).toContain('Y'.repeat(200))
    expect(classes(details)).toContain('min-w-0')
  })

  it('shows no streak for an account that has none, and lists a position it has unstuck from once it had one', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n), positionRow(8453, 24n), positionRow(8453, 25n)]))
    world[8453] = {
      '23': { staked: E18 },
      '24': { staked: 0n, longest: 7_200 },
      // Nothing staked and no streak ever: not a position.
      '25': { staked: 0n },
    }
    await renderPositions()
    expect(cards().map(card => card.getAttribute('href'))).toEqual(['/base:23', '/base:24'])
    expect(cards()[0].textContent).toContain('Time: 0d')
    expect(cards()[0].textContent).toContain('Longest: 0d')
    expect(cards()[1].textContent).toContain('Stuck: 0 CPN')
    expect(cards()[1].textContent).toContain('Longest: 2h 0m')
  })

  it('lists positions in the order of the chains, whichever chain answers first, and by project ID', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 30n), positionRow(1, 9n), positionRow(8453, 4n)]))
    world[1] = { '9': { staked: E18 } }
    world[8453] = { '30': { staked: E18 }, '4': { staked: E18 } }
    await renderPositions()
    expect(cards().map(card => card.getAttribute('href'))).toEqual(['/eth:9', '/base:4', '/base:30'])
  })

  it('draws a placeholder while it loads, and says nothing of loading', async () => {
    const pending = Promise.withResolvers<ReturnType<typeof listing>>()
    mocks.positions.mockReturnValue(pending.promise)
    await renderPositions()
    const section = host.querySelector('section')!
    expect(section.getAttribute('aria-busy')).toBe('true')
    expect(section.querySelector('.skeleton-shimmer')).not.toBeNull()
    expect(host.textContent).not.toMatch(/loading|No positions/i)

    pending.resolve(listing([]))
    await settle()
    expect(section.getAttribute('aria-busy')).toBe('false')
    expect(section.querySelector('.skeleton-shimmer')).toBeNull()
  })

  it('says the account has no positions when every chain has answered and none has one', async () => {
    await renderPositions()
    expect(host.textContent).toContain('No positions yet')
    expect(note()).toBe('')
    expect(retryButton()).toBeNull()
    // Nothing is listed and no position event has come since, so no balance is read.
    expect(chainsOf(calls)).toEqual(MAINNET)
    expect(calls.every(call => call.what === 'scan')).toBe(true)
  })

  it('draws the positions of the chains that have answered while another is read', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(1, 5n), positionRow(10, 4n)]))
    world[1] = { '5': { staked: E18 } }
    world[10] = { '4': { staked: E18 } }
    const slow = Promise.withResolvers<void>()
    const center = fakeCenter(world, calls)
    mocks.client.mockImplementation((chainId: number) => {
      const chain = center(chainId)
      if (chainId !== 10) return chain
      const multicall = chain.multicall.bind(chain)
      return { ...chain, multicall: async (parameters: never) => (await slow.promise, multicall(parameters)) }
    })
    await renderPositions()
    expect(cards().map(card => card.getAttribute('href'))).toEqual(['/eth:5'])
    expect(host.textContent).not.toContain('No positions yet')

    await act(async () => slow.resolve())
    await settle()
    expect(cards().map(card => card.getAttribute('href'))).toEqual(['/eth:5', '/op:4'])
  })
})

describe('the account\'s positions, past the block Bendystraw is indexed through', () => {
  const THROUGH = deployment.fromBlock + 1_000n
  /** A stick of HOLDER's in `projectId` that came after the block the listing is indexed through. */
  const opened = (projectId: bigint) => staked(HOLDER, HOLDER, E18, E18, { project: projectId, blockNumber: THROUGH + 5n })
  const hrefs = () => cards().map(card => card.getAttribute('href'))

  it('lists a position opened after the block the listing is indexed through, which its position events show', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n)], MAINNET, THROUGH))
    tails[8453] = [opened(24n)]
    world[8453] = { '23': { staked: E18 }, '24': { staked: 2n * E18, symbol: 'NEW' } }
    await renderPositions()
    expect(hrefs()).toEqual(['/base:23', '/base:24'])
    expect(cards()[1].textContent).toContain('Stuck: 2 NEW')
  })

  it('shows an account whose only position is new, and not "No positions yet"', async () => {
    mocks.positions.mockResolvedValue(listing([], MAINNET, THROUGH))
    tails[1] = [opened(5n)]
    world[1] = { '5': { staked: E18 } }
    await renderPositions()
    expect(hrefs()).toEqual(['/eth:5'])
    expect(host.textContent).not.toContain('No positions yet')
  })

  it('reads the account\'s position events on each chain from just below the block, one chain after another', async () => {
    mocks.positions.mockResolvedValue(listing([], MAINNET, THROUGH))
    await renderPositions()

    expect(mocks.scan.mock.calls.map(([chainId]) => chainId)).toEqual(MAINNET)
    for (const [chainId, filter, options] of mocks.scan.mock.calls) {
      const on = stickyDeployment(chainId)!
      // The position events of StickyHook that name the account, the way a holder's activity is tailed.
      expect(filter).toEqual({ address: on.hook, topics: [POSITION_TOPICS, null, topic(HOLDER)], fromBlock: scanFrom(THROUGH, on) })
      expect(options).toEqual({ signal: expect.any(AbortSignal) })
    }
    // Just below the block: 64 blocks, and never before the deployer's block (Arbitrum's is later than this one).
    expect(mocks.scan.mock.calls[0][1].fromBlock).toBe(THROUGH + 1n - 64n)
    expect(mocks.scan.mock.calls[3][1].fromBlock).toBe(stickyDeployment(42161)!.fromBlock)
    expect(oneAfterAnother(calls)).toBe(true)
  })

  it('counts a position once when the listing and the position events both have it', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n)], MAINNET, THROUGH))
    tails[8453] = [opened(23n), opened(23n)]
    world[8453] = { '23': { staked: E18 } }
    await renderPositions()
    expect(hrefs()).toEqual(['/base:23'])
  })

  it('finds the project of every kind of position event, and only the account\'s', async () => {
    mocks.positions.mockResolvedValue(listing([], MAINNET, THROUGH))
    tails[10] = [
      unstaked(HOLDER, E18, 0n, { project: 4n, blockNumber: THROUGH + 5n }),
      streakStarted(HOLDER, { project: 6n, blockNumber: THROUGH + 6n }),
      // Whatever the node sends, another account's event is not this account's position.
      staked(OTHER, OTHER, E18, E18, { project: 7n, blockNumber: THROUGH + 7n }),
    ]
    world[10] = { '4': { staked: 0n, longest: 3_600 }, '6': { staked: E18 }, '7': { staked: E18 } }
    await renderPositions()
    expect(hrefs()).toEqual(['/op:4', '/op:6'])
  })

  it('counts a chain whose position events cannot be read, warns why, and never shows its listing as the whole', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockResolvedValue(listing([positionRow(1, 5n), positionRow(10, 4n)], MAINNET, THROUGH))
    world[1] = { '5': { staked: E18 } }
    world[10] = { '4': { staked: E18 } }
    const failure = new Error('This history spans 600000 blocks, more than this RPC can scan in 1024 requests.')
    tails[10] = failure
    await renderPositions()

    expect(hrefs()).toEqual(['/eth:5'])
    expect(note()).toBe("Couldn't read 1 chain (Optimism). Retry")
    expect(balanceReads(10)).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/positions/), { network: 'mainnet', chainId: 10 }, failure)

    tails[10] = []
    await act(async () => retryButton()!.click())
    await settle()
    expect(hrefs()).toEqual(['/eth:5', '/op:4'])
    expect(note()).toBe('')
  })

  it('is never "No positions yet" when the position events of every chain cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockResolvedValue(listing([], MAINNET, THROUGH))
    for (const chainId of MAINNET) tails[chainId] = new Error('down')
    await renderPositions()
    expect(host.textContent).not.toContain('No positions yet')
    expect(note()).toBe("Couldn't read 4 chains (Ethereum, Optimism, Base, Arbitrum). Retry")
  })

  it('reads them again with each refresh, so a position opened while the page is open shows without waiting for the index', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(NOW * 1_000)
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n)], MAINNET, THROUGH))
    world[8453] = { '23': { staked: E18 }, '24': { staked: E18 } }
    await act(async () => root.render(inClient(<AccountPositions address={CHECKSUMMED} network="mainnet" />)))
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    expect(hrefs()).toEqual(['/base:23'])
    expect(mocks.scan.mock.calls.filter(([chainId]) => chainId === 8453)).toHaveLength(1)

    // The index still has not caught up, but the chain has the new position.
    tails[8453] = [opened(24n)]
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)))
    expect(mocks.scan.mock.calls.filter(([chainId]) => chainId === 8453)).toHaveLength(2)
    expect(hrefs()).toEqual(['/base:23', '/base:24'])
  })
})

describe('the account\'s positions, when Bendystraw cannot list them', () => {
  it('reads every deployed project on each chain, one chain after another, and shows those the account holds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const down = new Error('Cannot query field "stickyPositions"')
    mocks.positions.mockRejectedValue(down)
    mocks.projects.mockRejectedValue(new Error('down too'))
    mocks.projectsOn.mockImplementation(async (chainId: number) => ({
      projects: [5n, 6n, 7n].map(projectId => ({ chainId, projectId })),
      source: 'scanned',
      degraded: 'indexer-error',
    }))
    world[1] = { '5': { staked: E18 }, '6': {}, '7': {} }
    world[10] = { '5': {}, '6': {}, '7': {} }
    world[8453] = { '5': {}, '6': { staked: 3n * E18 }, '7': {} }
    world[42161] = { '5': {}, '6': {}, '7': { staked: E18, start: NOW - 60 } }
    await renderPositions()

    // Each chain's deployed projects are asked in the order of the chains, and every one of them is read.
    expect(mocks.projectsOn.mock.calls.map(([chainId]) => chainId)).toEqual(MAINNET)
    for (const [, index] of mocks.projectsOn.mock.calls) expect(index).toBeNull()
    expect(chainsOf(calls)).toEqual(MAINNET)
    expect(oneAfterAnother(calls)).toBe(true)
    expect(cards().map(card => card.getAttribute('href'))).toEqual(['/eth:5', '/base:6', '/arb:7'])
    expect(note()).toBe('')
    // Every project was asked about, so there is no listing whose block the position events would follow.
    expect(mocks.scan).not.toHaveBeenCalled()
    // The console hears why, once for Bendystraw's positions and once for its projects.
    expect(warn.mock.calls.map(([label]) => label)).toEqual([
      "Bendystraw could not list the account's Sticky positions; reading every Sticky project instead.",
      'Bendystraw could not list the Sticky projects; scanning each chain instead.',
    ])
    expect(warn.mock.calls[0][2]).toBe(down)
  })

  it('uses Bendystraw\'s project list to find the deployed projects, when only its positions fail', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const index: IndexedProjects = { blocks: new Map([[8453, 90n]]), projects: [{ chainId: 8453, projectId: 6n }] }
    mocks.positions.mockRejectedValue(new Error('down'))
    mocks.projects.mockResolvedValue(index)
    await renderPositions()
    expect(mocks.projects).toHaveBeenCalledTimes(1)
    expect(mocks.projects).toHaveBeenCalledWith('mainnet', expect.any(AbortSignal))
    for (const [, given] of mocks.projectsOn.mock.calls) expect(given).toBe(index)
  })

  it('asks a chain Bendystraw has no status for about every project, and takes the others from its positions', async () => {
    mocks.positions.mockResolvedValue({
      rows: [positionRow(1, 5n), positionRow(8453, 23n)],
      blocks: new Map([[1, 100n], [10, 100n], [8453, 100n]]),
    })
    mocks.projectsOn.mockResolvedValue({ projects: [{ chainId: 42161, projectId: 8n }], source: 'scanned', degraded: 'not-indexed' })
    world[1] = { '5': { staked: E18 } }
    world[8453] = { '23': { staked: E18 } }
    world[42161] = { '8': { staked: E18 } }
    await renderPositions()
    expect(mocks.projectsOn.mock.calls.map(([chainId]) => chainId)).toEqual([42161])
    expect(cards().map(card => card.getAttribute('href'))).toEqual(['/eth:5', '/base:23', '/arb:8'])
  })

  it('finds a chain\'s deployed projects once for the positions and the activity together', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockRejectedValue(new Error('down'))
    mocks.projectsOn.mockImplementation(async (chainId: number) => ({
      projects: [{ chainId, projectId: 5n }],
      source: 'scanned',
      degraded: 'indexer-error',
    }))
    world[1] = { '5': { staked: E18 } }
    await renderNode(
      <>
        <AccountPositions address={CHECKSUMMED} network="mainnet" />
        <AccountActivity address={CHECKSUMMED} network="mainnet" />
      </>,
    )
    expect(mocks.projectsOn.mock.calls.map(([chainId]) => chainId)).toEqual(MAINNET)
    expect(mocks.events).toHaveBeenCalledTimes(4)
  })

  it('does not scan a chain\'s deployer again on the next read of its balances', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockRejectedValue(new Error('down'))
    mocks.projectsOn.mockImplementation(async (chainId: number) => ({
      projects: [{ chainId, projectId: 5n }],
      source: 'scanned',
      degraded: 'indexer-error',
    }))
    world[1] = { '5': { staked: E18 } }
    await renderPositions()
    expect(mocks.projectsOn).toHaveBeenCalledTimes(4)

    await act(async () => void (await client.refetchQueries({ queryKey: ['sticky-account', 'mainnet', HOLDER, 'positions'] })))
    await settle()
    expect(balanceReads(1)).toHaveLength(2)
    expect(mocks.projectsOn).toHaveBeenCalledTimes(4)
  })
})

describe('the account\'s positions, when a read fails', () => {
  it('counts a chain that could not be read, names it, and shows the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockResolvedValue(listing([positionRow(1, 5n), positionRow(10, 4n), positionRow(8453, 23n)]))
    world[1] = { '5': { staked: E18 } }
    world[8453] = { '23': { staked: E18 } }
    broken.add(10)
    await renderPositions()

    expect(cards().map(card => card.getAttribute('href'))).toEqual(['/eth:5', '/base:23'])
    expect(note()).toBe("Couldn't read 1 chain (Optimism). Retry")
    expect(host.textContent).not.toContain('No positions yet')
    // The console hears which chain, and why, once.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/chain/), { network: 'mainnet', chainId: 10 }, new Error('rpc down'))
  })

  it('is never an account with no positions when every chain fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockResolvedValue(listing(MAINNET.map(chainId => positionRow(chainId, 5n))))
    for (const chainId of MAINNET) broken.add(chainId)
    await renderPositions()
    expect(cards()).toHaveLength(0)
    expect(host.textContent).not.toContain('No positions yet')
    expect(note()).toBe("Couldn't read 4 chains (Ethereum, Optimism, Base, Arbitrum). Retry")
  })

  it('reads again on Retry, and shows what the chain holds once it answers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockResolvedValue(listing([positionRow(1, 5n), positionRow(10, 4n)]))
    world[1] = { '5': { staked: E18 } }
    world[10] = { '4': { staked: 2n * E18, symbol: 'OPT' } }
    broken.add(10)
    await renderPositions()
    expect(retryButton()).not.toBeNull()

    broken.clear()
    await act(async () => retryButton()!.click())
    await settle()
    expect(cards().map(card => card.getAttribute('href'))).toEqual(['/eth:5', '/op:4'])
    expect(note()).toBe('')
    expect(retryButton()).toBeNull()
  })

  it('leaves out a project whose token cannot be read, counts it, and still shows the account\'s others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n), positionRow(8453, 24n)]))
    // Project 24's staked token loses every request that asks it something, and with them the other project's.
    world[8453] = { '23': { staked: E18, symbol: 'CPN' }, '24': { staked: E18, hostile: true } }
    await renderPositions()

    expect(cards().map(card => card.getAttribute('href'))).toEqual(['/base:23'])
    expect(note()).toBe("Couldn't read 1 project. Retry")
    expect(host.textContent).not.toContain('No positions yet')
    expect(warn).toHaveBeenCalledWith('Could not read a Sticky project; leaving it out.', { chainId: 8453, projectId: 24n }, expect.any(Error))

    // Retry reads the chain again, and the project that could not be read is asked about again with it.
    expect(balanceReads(8453)).toHaveLength(1)
    await act(async () => retryButton()!.click())
    await settle()
    expect(balanceReads(8453)).toHaveLength(2)
    expect(note()).toBe("Couldn't read 1 project. Retry")
  })

  it('counts projects and chains together', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockResolvedValue(
      listing([positionRow(1, 5n), positionRow(10, 4n), positionRow(10, 5n), positionRow(8453, 23n)]),
    )
    world[1] = { '5': { staked: E18 } }
    world[10] = { '4': { staked: E18 }, '5': { staked: E18, hostile: true } }
    world[8453] = { '23': { staked: E18 } }
    broken.add(8453)
    await renderPositions()
    expect(note()).toBe("Couldn't read 1 chain (Base) and 1 project. Retry")
  })
})

describe('the account\'s positions, as they are read again', () => {
  const hidden = { visibility: '' as 'hidden' | 'visible' }
  beforeEach(() => {
    hidden.visibility = 'visible'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => hidden.visibility)
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden.visibility === 'hidden')
    // Queries go stale as the clock moves.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(NOW * 1_000)
  })
  const later = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  it('reads every 15 seconds, from Bendystraw and from the chain, and shows the balance the chain now holds', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n)]))
    world[8453] = { '23': { symbol: 'CPN', staked: E18 } }
    await act(async () => root.render(inClient(<AccountPositions address={CHECKSUMMED} network="mainnet" />)))
    await later(0)
    expect(cards()[0].textContent).toContain('Stuck: 1 CPN')
    expect(balanceReads(8453)).toHaveLength(1)

    world[8453] = { '23': { symbol: 'CPN', staked: 3n * E18, supply: 3n * E18, backing: 3n * E18 } }
    await later(14_999)
    expect(balanceReads(8453)).toHaveLength(1)
    await later(1)
    expect(balanceReads(8453)).toHaveLength(2)
    expect(mocks.positions).toHaveBeenCalledTimes(2)
    expect(cards()[0].textContent).toContain('Stuck: 3 CPN')

    await later(15_000)
    expect(balanceReads(8453)).toHaveLength(3)
  })

  it('lists a position that has appeared in the index since', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n)]))
    world[8453] = { '23': { staked: E18 }, '24': { staked: E18 } }
    await act(async () => root.render(inClient(<AccountPositions address={CHECKSUMMED} network="mainnet" />)))
    await later(0)
    expect(cards()).toHaveLength(1)

    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n), positionRow(8453, 24n)]))
    await later(15_000)
    expect(cards().map(card => card.getAttribute('href'))).toEqual(['/base:23', '/base:24'])
  })

  it('reads nothing while the tab is hidden, and again on the next 15 seconds once it is shown', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n)]))
    world[8453] = { '23': { staked: E18 } }
    await act(async () => root.render(inClient(<AccountPositions address={CHECKSUMMED} network="mainnet" />)))
    await later(0)
    expect(balanceReads(8453)).toHaveLength(1)

    hidden.visibility = 'hidden'
    await later(60_000)
    expect(balanceReads(8453)).toHaveLength(1)
    expect(mocks.positions).toHaveBeenCalledTimes(1)

    hidden.visibility = 'visible'
    await later(15_000)
    expect(balanceReads(8453)).toHaveLength(2)
  })

  it('keeps the chains in turn as it reads them again, and does not read a chain again while its read is under way', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(1, 5n), positionRow(10, 4n)]))
    world[1] = { '5': { staked: E18 } }
    world[10] = { '4': { staked: E18 } }
    await act(async () => root.render(inClient(<AccountPositions address={CHECKSUMMED} network="mainnet" />)))
    await later(0)
    await later(15_000)
    expect(chainsOf(calls)).toEqual(MAINNET)
    expect(oneAfterAnother(calls)).toBe(true)
    expect(balanceReads(1)).toHaveLength(2)

    // Chain 1's next read does not end: the ticks that follow start nothing, on chain 1 or on chain 10 behind it.
    const stuck = Promise.withResolvers<void>()
    const center = fakeCenter(world, calls)
    const started: number[] = []
    mocks.client.mockImplementation((chainId: number) => {
      const chain = center(chainId)
      const multicall = chain.multicall.bind(chain)
      return { ...chain, multicall: async (parameters: never) => (started.push(chainId), await stuck.promise, multicall(parameters)) }
    })
    await later(15_000)
    await later(60_000)
    expect(started).toEqual([1])

    await act(async () => stuck.resolve())
    await later(0)
    expect(started.slice(0, 2)).toEqual([1, 1])
  })
})

describe('the account\'s activity', () => {
  const T = NOW - 10_000
  const events = (byChain: Record<number, StickyEvent[]>) =>
    mocks.events.mockImplementation(async (chainId: number) => ({
      events: byChain[chainId] ?? [],
      source: 'indexed',
      degraded: null,
    }))
  /** Amounts the terminal gave for these events: 5 of the underlying token each. */
  const paid = () =>
    mocks.moves.mockImplementation(
      async (given: StickyEvent[]) =>
        new Map(
          given.flatMap(event =>
            event.kind === 'stick' || event.kind === 'unstick'
              ? [[moveKey({ ...event, kind: event.kind, count: event.count! }), 5n * E6] as [string, bigint]]
              : [],
          ),
        ),
    )

  it('comes from the holder\'s events on each chain, read one chain after another, and lists them newest first with their projects', async () => {
    world[8453] = { '23': { symbol: 'SLOPSHOP', stSymbol: 'STICKYSLOPSHOP', decimals: 6 } }
    world[10] = { '4': { symbol: 'ART', stSymbol: 'STICKYART', decimals: 6 } }
    events({ 8453: [stick(8453, 23n, T)], 10: [stick(10, 4n, T + 100)] })
    paid()
    await renderActivity()

    expect(mocks.events.mock.calls.map(([chainId]) => chainId)).toEqual(MAINNET)
    for (const [, holder] of mocks.events.mock.calls) expect(holder).toBe(HOLDER)
    expect(amounts()).toEqual(['5 ART', '5 SLOPSHOP'])
    const projects = feed().map(item => item.querySelector<HTMLAnchorElement>('a[href^="/"]'))
    expect(projects.map(link => [link!.getAttribute('href'), link!.textContent])).toEqual([
      ['/op:4', 'STICKYART'],
      ['/base:23', 'STICKYSLOPSHOP'],
    ])
    expect(lines()).toEqual([`stuck by ${short(HOLDER)}`, `stuck by ${short(HOLDER)}`])
  })

  it('groups what happened in one transaction into one row, and shows a stick another paid for as a gift', async () => {
    world[8453] = { '23': { symbol: 'SLOPSHOP', stSymbol: 'STICKYSLOPSHOP', decimals: 6 } }
    const first = stick(8453, 23n, T)
    const gift = stick(8453, 23n, T + 50, { payer: OTHER })
    events({
      8453: [
        first,
        // The streak this stick started is in its transaction, and reads on its row.
        { kind: 'streakStart', chainId: 8453, projectId: 23n, holder: HOLDER, txHash: first.txHash, logIndex: 0, blockNumber: null, timestamp: T },
        gift,
      ],
    })
    paid()
    await renderActivity()

    // Three events, grouped by transaction: two rows.
    expect(groupSameTx).toHaveBeenCalled()
    expect(vi.mocked(groupSameTx).mock.calls[0][0]).toHaveLength(3)
    expect(feed()).toHaveLength(2)
    expect(lines()).toEqual([`to ${short(HOLDER)} from ${short(OTHER)}`, `stuck by ${short(HOLDER)} and got sticky`])
  })

  it('shows Sticky shares when the terminal\'s amount cannot be read', async () => {
    world[8453] = { '23': { symbol: 'SLOPSHOP', stSymbol: 'STICKYSLOPSHOP', decimals: 6 } }
    events({ 8453: [stick(8453, 23n, T, { count: 3n * E18 })] })
    await renderActivity()
    expect(amounts()).toEqual(['3 STICKYSLOPSHOP'])
  })

  it('tells each chain\'s read which projects Bendystraw lists the account in, so a scan need not start at the deployer', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(8453, 23n), positionRow(8453, 30n)]))
    await renderActivity()
    const given = new Map(mocks.events.mock.calls.map(([chainId, , options]) => [chainId, options.projects]))
    expect(given.get(8453)).toEqual([23n, 30n])
    // Nothing listed on a chain the index covers: nothing to start from.
    expect(given.get(1)).toEqual([])
    for (const [, , options] of mocks.events.mock.calls) expect(options.signal).toBeInstanceOf(AbortSignal)
  })

  it('gives no project when Bendystraw cannot list them', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockRejectedValue(new Error('down'))
    mocks.projects.mockRejectedValue(new Error('down'))
    await renderActivity()
    for (const [, , options] of mocks.events.mock.calls) expect(options.projects).toBeUndefined()
  })

  it('reads no events of a chain with no Sticky project, when Bendystraw cannot list the positions, and is not a failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockRejectedValue(new Error('down'))
    mocks.projects.mockRejectedValue(new Error('down too'))
    mocks.projectsOn.mockImplementation(async (chainId: number) => ({
      projects: chainId === 8453 ? [{ chainId, projectId: 23n }] : [],
      source: 'scanned',
      degraded: 'indexer-error',
    }))
    world[8453] = { '23': { symbol: 'CPN' } }
    events({ 8453: [stick(8453, 23n, T)] })
    await renderActivity()

    // The chains that have no project are not scanned, however slow or over budget that scan would be.
    expect(mocks.events.mock.calls.map(([chainId]) => chainId)).toEqual([8453])
    expect(feed()).toHaveLength(1)
    expect(note()).toBe('')
  })

  it('shows no activity for an account on a network where no chain has a Sticky project, and reads none of its events', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.positions.mockRejectedValue(new Error('down'))
    mocks.projects.mockRejectedValue(new Error('down too'))
    await renderActivity()
    expect(mocks.events).not.toHaveBeenCalled()
    expect(host.textContent).toContain('No activity yet')
    expect(note()).toBe('')
  })

  it('does not look for a chain\'s projects when Bendystraw lists the positions', async () => {
    await renderActivity()
    expect(mocks.projectsOn).not.toHaveBeenCalled()
    expect(mocks.events).toHaveBeenCalledTimes(4)
  })

  it('reads the newest 40 events of a chain and no more', async () => {
    world[8453] = { '23': {} }
    events({ 8453: Array.from({ length: 60 }, (_, at) => stick(8453, 23n, T + at)) })
    await renderActivity()
    expect(feed()).toHaveLength(40)
    expect(mocks.moves.mock.calls[0][0]).toHaveLength(40)
    expect(mocks.moves.mock.calls[0][0][0].timestamp).toBe(T + 20)
  })

  it('draws a placeholder while it loads, says when there is no activity, and names no project it cannot read', async () => {
    const pending = Promise.withResolvers<{ events: StickyEvent[]; source: string; degraded: null }>()
    mocks.events.mockReturnValue(pending.promise)
    await renderActivity()
    expect(host.querySelector('section')!.getAttribute('aria-busy')).toBe('true')
    expect(host.querySelector('.skeleton-shimmer')).not.toBeNull()
    expect(host.textContent).not.toMatch(/loading|No activity/i)

    vi.spyOn(console, 'warn').mockImplementation(() => {})
    world[8453] = { '23': { hostile: true } }
    pending.resolve({ events: [], source: 'indexed', degraded: null })
    await settle()
    expect(host.textContent).toContain('No activity yet')
    expect(note()).toBe('')
  })

  it('leaves out the rows of a project that cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    world[8453] = { '23': { symbol: 'CPN' }, '24': { hostile: true } }
    events({ 8453: [stick(8453, 23n, T), stick(8453, 24n, T + 5)] })
    await renderActivity()
    expect(feed()).toHaveLength(1)
    expect(feed()[0].querySelector('a[href^="/"]')!.getAttribute('href')).toBe('/base:23')
  })

  it('counts a chain that could not be read, is never "No activity yet" for it, and reads again on Retry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    world[10] = { '4': { symbol: 'ART' } }
    const failure = new Error('This history spans 600000 blocks, more than this RPC can scan in 1024 requests.')
    mocks.events.mockImplementation(async (chainId: number) => {
      if (chainId === 8453) throw failure
      return { events: chainId === 10 ? [stick(10, 4n, T)] : [], source: 'indexed', degraded: null }
    })
    await renderActivity()
    expect(feed()).toHaveLength(1)
    expect(note()).toBe("Couldn't read 1 chain (Base). Retry")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/activity/), { network: 'mainnet', chainId: 8453 }, failure)

    events({ 10: [stick(10, 4n, T)], 8453: [stick(8453, 23n, T + 9)] })
    world[8453] = { '23': { symbol: 'CPN' } }
    await act(async () => retryButton()!.click())
    await settle()
    expect(feed()).toHaveLength(2)
    expect(note()).toBe('')
  })

  it('does not say there is no activity when every chain fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.events.mockRejectedValue(new Error('down'))
    await renderActivity()
    expect(host.textContent).not.toContain('No activity yet')
    expect(note()).toBe("Couldn't read 4 chains (Ethereum, Optimism, Base, Arbitrum). Retry")
  })

  it('is read once, when the page opens, and not again on its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    await act(async () => root.render(inClient(<AccountActivity address={CHECKSUMMED} network="mainnet" />)))
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
    expect(mocks.events).toHaveBeenCalledTimes(4)
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)))
    expect(mocks.events).toHaveBeenCalledTimes(4)
  })
})

describe('the account page as a whole', () => {
  it('reads the positions of every chain before the activity of any, one request after another, and keeps nothing in the browser', async () => {
    mocks.positions.mockResolvedValue(listing([positionRow(1, 5n), positionRow(8453, 23n)]))
    world[1] = { '5': { staked: E18 } }
    world[8453] = { '23': { staked: E18 }, '24': {} }
    mocks.events.mockImplementation(async (chainId: number) => {
      calls.push({ chainId, phase: 'start', what: 'events' })
      await Promise.resolve()
      calls.push({ chainId, phase: 'end', what: 'events' })
      return { events: chainId === 1 ? [stick(1, 5n, NOW - 100)] : chainId === 8453 ? [stick(8453, 23n, NOW - 50)] : [], source: 'indexed', degraded: null }
    })
    await renderNode(
      <>
        <AccountPositions address={CHECKSUMMED} network="mainnet" />
        <AccountActivity address={CHECKSUMMED} network="mainnet" />
      </>,
    )

    expect(oneAfterAnother(calls)).toBe(true)
    const lastBalance = calls.findLastIndex(call => call.what.includes('stakedBalanceOf'))
    const firstEvents = calls.findIndex(call => call.what === 'events')
    expect(lastBalance).toBeGreaterThan(-1)
    expect(firstEvents).toBeGreaterThan(lastBalance)
    expect(cards()).toHaveLength(2)
    expect(feed().filter(item => !item.querySelector('a[data-position]'))).toHaveLength(2)
    // Every query is about the account, and none is kept.
    const queries = client.getQueryCache().findAll({ queryKey: ['sticky-account'] })
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.every(query => query.meta === undefined || !('persist' in query.meta))).toBe(true)
  })
})
