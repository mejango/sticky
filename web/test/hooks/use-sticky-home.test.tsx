import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deserializeState, installQueryPersistence } from '@/lib/query-persist'
import { FEED_WINDOW, type FeedRow } from '@/lib/sticky-feed'
import { HOME_VERSION, type HomeCard, type HomeChain } from '@/lib/sticky-home'
import type { IndexedProjects, IndexedRows, IndexedStickyEvent } from '@/lib/sticky-indexed'
import type { StickyProjectInfo } from '@/lib/sticky-project'

const mocks = vi.hoisted(() => ({ index: vi.fn(), latest: vi.fn(), chain: vi.fn(), prices: vi.fn() }))
vi.mock('@/lib/sticky-home', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-home')>()),
  homeIndex: mocks.index,
  homeLatest: mocks.latest,
  homeChain: mocks.chain,
  homePrices: mocks.prices,
}))

import { refreshStickyHome, useStickyHome } from '@/hooks/useStickyHome'

const E18 = 10n ** 18n
const E6 = 10n ** 6n
const TOKEN = getAddress(`0x${'2'.repeat(40)}`)
const OTHER_TOKEN = getAddress(`0x${'3'.repeat(40)}`)
const MAINNET = [1, 10, 8453, 42161]
const INDEX: IndexedProjects = { blocks: new Map([[1, 5n]]), projects: [] }
const LATEST: IndexedRows<IndexedStickyEvent> = { rows: [], blocks: new Map([[1, 5n]]) }
const STORE_KEY = 'sticky:query-cache:v1'

function info(chainId: number, projectId: bigint, extra: Partial<StickyProjectInfo> = {}): StickyProjectInfo {
  return {
    chainId,
    projectId,
    stToken: `0x${'5'.repeat(40)}`,
    stSymbol: 'STK',
    stName: 'Sticky CPN',
    stakedToken: TOKEN,
    symbol: 'CPN',
    name: 'Coupon',
    decimals: 6,
    cashOutTaxRate: 0n,
    soulbound: false,
    totalSupply: E18,
    backing: E6,
    orphaned: 0n,
    rawBacking: E6,
    savedOrphaned: 0n,
    launchId: null,
    plannedChains: null,
    blockNumber: 1n,
    ...extra,
  }
}
const card = (chainId: number, projectId: bigint, extra: Partial<StickyProjectInfo> = {}): HomeCard => ({
  info: info(chainId, projectId, extra),
  sticks: 1,
})
const chainResult = (chainId: number, cards: HomeCard[] = [], extra: Partial<HomeChain> = {}): HomeChain => ({
  chainId,
  cards,
  activity: [],
  airdrops: [],
  supply: [],
  ...extra,
})
const row = (chainId: number, timestamp: number, logIndex = 0): FeedRow => ({
  chainId,
  projectId: 1n,
  timestamp,
  txHash: `0x${timestamp.toString(16).padStart(64, '0')}` as Hex,
  logIndex,
  direction: 'in',
  amount: { value: 1n, decimals: 6, symbol: 'CPN' },
  line: { kind: 'stuck', holder: `0x${'a'.repeat(40)}` },
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: key => map.get(key) ?? null,
    key: index => [...map.keys()][index] ?? null,
    removeItem: key => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  } as Storage
}

type Seen = ReturnType<typeof useStickyHome>
let seen: Seen
let host: HTMLDivElement
let root: Root
let client: QueryClient

function Probe({ network, report }: { network: 'mainnet' | 'testnet'; report: (value: Seen) => void }) {
  report(useStickyHome(network))
  return null
}
const render = (network: 'mainnet' | 'testnet' = 'mainnet') =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe
          network={network}
          report={value => {
            seen = value
          }}
        />
      </QueryClientProvider>,
    ),
  )
/** Lets the reads under way answer. The clock is fake, so the persister's one-second write and a refresh's later
 * reads happen only when a test moves it. */
const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mocks.index.mockReset().mockResolvedValue(INDEX)
  mocks.latest.mockReset().mockResolvedValue(LATEST)
  mocks.chain.mockReset().mockImplementation(async (chainId: number) => chainResult(chainId))
  mocks.prices.mockReset().mockResolvedValue(new Map())
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
})

describe('useStickyHome', () => {
  it('reads the chains one after another, with the network\'s project list and newest events read once for all', async () => {
    const reads = new Map(MAINNET.map(chainId => [chainId, deferred<HomeChain>()]))
    mocks.chain.mockImplementation((chainId: number) => reads.get(chainId)!.promise)
    await render()
    await settle()
    expect(mocks.chain.mock.calls.map(([chainId]) => chainId)).toEqual([1])

    for (const [at, chainId] of MAINNET.entries()) {
      await act(async () => reads.get(chainId)!.resolve(chainResult(chainId)))
      await settle()
      expect(mocks.chain.mock.calls.map(([id]) => id)).toEqual(MAINNET.slice(0, Math.min(at + 2, MAINNET.length)))
    }
    expect(mocks.index).toHaveBeenCalledTimes(1)
    expect(mocks.index).toHaveBeenCalledWith('mainnet', { signal: expect.any(AbortSignal) })
    expect(mocks.latest).toHaveBeenCalledTimes(1)
    expect(mocks.latest).toHaveBeenCalledWith('mainnet', { signal: expect.any(AbortSignal) })
    for (const [chainId, options] of mocks.chain.mock.calls) {
      expect([chainId, options]).toEqual([chainId, { index: INDEX, latest: LATEST, signal: expect.any(AbortSignal) }])
    }
  })

  it('does not ask for the newest events when Bendystraw could not list the projects', async () => {
    mocks.index.mockResolvedValue(null)
    await render()
    await settle()
    expect(mocks.latest).not.toHaveBeenCalled()
    expect(mocks.chain.mock.calls[0][1]).toEqual({ index: null, latest: null, signal: expect.any(AbortSignal) })
  })

  it('keeps each chain\'s cards and lists for the next visit under its network and chain, and nothing else', async () => {
    const storage = memoryStorage()
    installQueryPersistence(client, storage)
    const supply = [{ projectId: 2n, timestamp: 5, delta: E18 }]
    mocks.chain.mockImplementation(async (chainId: number) =>
      chainResult(chainId, chainId === 1 ? [card(1, 2n)] : [], chainId === 1 ? { supply } : {}),
    )
    await render()
    await settle(1_500)

    const stored = deserializeState(storage.getItem(STORE_KEY)!).queries
    // The key names the version of what is kept, which changes when its shape does.
    expect(HOME_VERSION).toBe('v1')
    expect(stored.map(query => query.queryKey)).toEqual(
      MAINNET.map(chainId => ['sticky-home', 'mainnet', 'chain', chainId, 'v1']),
    )
    expect(client.getQueryCache().find({ queryKey: ['sticky-home', 'mainnet', 'chain', 1, 'v1'] })!.meta).toEqual({
      persist: 'revalidate',
    })
    // The chart's history grows with every stick and unstick, so it stays in memory.
    expect(Object.keys(stored[0].state.data as object).sort()).toEqual(['activity', 'airdrops', 'cards', 'chainId'])
    expect(client.getQueryData(['sticky-home', 'mainnet', 'history', 1])).toEqual(supply)
  })

  it('shows a return visit\'s kept cards at once, and draws the chart once the chains have been read again', async () => {
    const storage = memoryStorage()
    installQueryPersistence(client, storage)
    mocks.chain.mockImplementation(async (chainId: number) => chainResult(chainId, chainId === 1 ? [card(1, 2n)] : []))
    mocks.prices.mockResolvedValue(new Map([[TOKEN, 1]]))
    await render()
    await settle(1_500)
    expect(seen.secured).not.toBeNull()
    await act(async () => root.unmount())
    client.clear()

    // The next visit: a new client restores what was kept before anything is read.
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    installQueryPersistence(client, storage)
    const reads = deferred<void>()
    mocks.chain.mockImplementation(async (chainId: number) => {
      await reads.promise
      return chainResult(chainId, chainId === 1 ? [card(1, 2n)] : [])
    })
    root = createRoot(host)
    await render()
    await settle()
    expect(seen.cards.map(group => group.cards[0].info.projectId)).toEqual([2n])
    expect(seen.revalidating).toBe(true)
    expect(seen.secured).toBeNull()

    await act(async () => reads.resolve())
    await settle()
    expect(seen.revalidating).toBe(false)
    expect(seen.secured).toMatchObject({ hasValue: true, total: 1_000_000n })
  })

  it('merges the chains\' lists, newest first, and keeps the newest FEED_WINDOW of each', async () => {
    mocks.chain.mockImplementation(async (chainId: number) =>
      chainResult(chainId, [], {
        activity: Array.from({ length: 30 }, (_, at) => row(chainId, chainId * 1_000 + 29 - at)),
        airdrops: chainId === 10 ? [row(10, 5)] : [],
      }),
    )
    await render()
    await settle()
    expect(seen.activity).toHaveLength(FEED_WINDOW)
    expect(seen.activity.slice(0, 2).map(item => item.timestamp)).toEqual([42_161 * 1_000 + 29, 42_161 * 1_000 + 28])
    expect(seen.activity.every((item, at) => at === 0 || item.timestamp <= seen.activity[at - 1].timestamp)).toBe(true)
    expect(seen.airdrops.map(item => item.chainId)).toEqual([10])
  })

  it('groups the loaded chains\' cards and names the chains that failed', async () => {
    mocks.chain.mockImplementation(async (chainId: number) => {
      if (chainId === 10) throw new Error('rpc down')
      return chainResult(chainId, [card(chainId, 1n, { totalSupply: BigInt(chainId) })])
    })
    await render()
    await settle()
    expect(seen.failedChains).toEqual([10])
    expect(seen.pending).toBe(false)
    expect(seen.cards.map(group => group.cards[0].info.chainId)).toEqual([42161, 8453, 1])
  })

  it('is pending while a chain has neither answered nor failed, and revalidating while one with data is read again', async () => {
    const slow = deferred<HomeChain>()
    mocks.chain.mockImplementation(async (chainId: number) => (chainId === 8453 ? slow.promise : chainResult(chainId)))
    await render()
    await settle()
    expect(seen.pending).toBe(true)
    expect(seen.revalidating).toBe(false)
    await act(async () => slow.resolve(chainResult(8453)))
    await settle()
    expect(seen.pending).toBe(false)

    const again = deferred<HomeChain>()
    mocks.chain.mockImplementation(async (chainId: number) => (chainId === 1 ? again.promise : chainResult(chainId)))
    await act(async () => void client.invalidateQueries({ queryKey: ['sticky-home'] }))
    await settle()
    expect(seen.pending).toBe(false)
    expect(seen.revalidating).toBe(true)
    await act(async () => again.resolve(chainResult(1)))
    await settle()
    expect(seen.revalidating).toBe(false)
  })

  it('asks each loaded chain\'s prices for its staked tokens, and has no chart until every one has answered', async () => {
    mocks.chain.mockImplementation(async (chainId: number) =>
      chainResult(
        chainId,
        chainId === 1 ? [card(1, 1n), card(1, 2n, { stakedToken: OTHER_TOKEN }), card(1, 3n)] : chainId === 10 ? [card(10, 4n)] : [],
      ),
    )
    const slow = deferred<Map<Address, number> | null>()
    mocks.prices.mockImplementation(async (chainId: number) => (chainId === 10 ? slow.promise : new Map([[TOKEN, 1]])))
    await render()
    await settle()
    // Each token once, and nothing asked of a chain with no Sticky token.
    expect(mocks.prices.mock.calls.map(([chainId, tokens]) => [chainId, tokens])).toEqual([
      [1, [TOKEN, OTHER_TOKEN]],
      [10, [TOKEN]],
    ])
    expect(seen.secured).toBeNull()

    // A chain whose prices could not be read has none, and the chart still draws.
    await act(async () => slow.resolve(null))
    await settle()
    expect(seen.secured).toMatchObject({ hasValue: true, total: 2n * 1_000_000n, missing: ['CPN'] })
  })

  it('starts again from nothing on retry: every chain, the project list and the newest events are read again', async () => {
    mocks.chain.mockRejectedValue(new Error('fetch failed'))
    await render()
    await settle()
    expect(seen.failedChains).toEqual(MAINNET)

    mocks.chain.mockReset().mockImplementation(async (chainId: number) => chainResult(chainId, [card(chainId, 1n)]))
    await act(async () => seen.retry())
    await settle()
    expect(seen.failedChains).toEqual([])
    expect(seen.cards).toHaveLength(4)
    expect(mocks.index).toHaveBeenCalledTimes(2)
    expect(mocks.latest).toHaveBeenCalledTimes(2)
  })
})

describe('refreshStickyHome', () => {
  it('reads the home again now, at +4 s and at +12 s, while the index catches up with a launch', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue(undefined)
    refreshStickyHome(client)
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['sticky-home'] })
    vi.advanceTimersByTime(3_999)
    expect(invalidate).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(invalidate).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(8_000)
    expect(invalidate).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(60_000)
    expect(invalidate).toHaveBeenCalledTimes(3)
  })

  it('reads the project list again each time, not only the chains', async () => {
    await render()
    await settle()
    expect(mocks.index).toHaveBeenCalledTimes(1)
    await act(async () => refreshStickyHome(client))
    await settle()
    expect(mocks.index).toHaveBeenCalledTimes(2)
    await settle(12_000)
    expect(mocks.index).toHaveBeenCalledTimes(4)
  })
})
