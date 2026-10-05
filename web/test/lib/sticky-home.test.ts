import { getAddress, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryTooLongError, type ScannedLog } from '@/lib/hook-logs'
import { stickyChainIds } from '@/lib/sticky-addresses'
import type { StickyEvent, StickyProjectsResult } from '@/lib/sticky-events'
import { FEED_WINDOW, type FeedRow } from '@/lib/sticky-feed'
import {
  groupHomeCards,
  homeChain,
  homeIndex,
  homeLatest,
  homePrices,
  homeSecuredSeries,
  securedBars,
  type HomeCard,
  type HomeCardGroup,
  type HomeChain,
  type HomeReadDeps,
} from '@/lib/sticky-home'
import type { IndexedMove, IndexedProjects, IndexedRows, IndexedStickyEvent } from '@/lib/sticky-indexed'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { E18, E6, TOKEN, homeCard as card, stickyInfo } from '../home-fixtures'
import {
  CHAIN,
  CREATED,
  HOLDER,
  HOOK,
  OTHER,
  POSITION_TOPICS,
  SENDER,
  deployment,
  staked,
  streakStarted,
  timeAt,
  unstaked,
} from './sticky-log-fixtures'

// Every read goes through the deps a call is given, so nothing here reaches Bendystraw, Center or DexScreener.

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const ADAPTER = deployment.autoStick.toLowerCase() as Address
const FUNDER = `0x${'f'.repeat(40)}` as Address

/** A project on the tests' chain. Its Sticky symbol tells its share counts from the staked token's amounts. */
const info = (projectId: bigint, extra: Partial<StickyProjectInfo> = {}) =>
  stickyInfo(CHAIN, projectId, { stSymbol: 'STICKYCPN', ...extra })

type Place = { tx: string; logIndex?: number; timestamp: number; projectId?: bigint }
const hash = (tx: string) => `0x${tx.padStart(64, '0')}` as Hex
const placed = ({ tx, logIndex = 0, timestamp, projectId = 23n }: Place) => ({
  chainId: CHAIN,
  projectId,
  txHash: hash(tx),
  logIndex,
  timestamp,
})
/** Bendystraw's pays and cash outs, as indexedStickyMoves gives them. */
const pay = (holder: Address, payer: Address, tokens: bigint, amount: bigint, at: Place): IndexedMove => ({
  ...placed(at),
  kind: 'stick',
  holder,
  payer,
  tokens,
  amount,
})
const cashOut = (holder: Address, tokens: bigint, amount: bigint, at: Place): IndexedMove => ({
  ...placed(at),
  kind: 'unstick',
  holder,
  tokens,
  amount,
})
/** Bendystraw's hook events, as indexedStickyEvents gives them. */
const stakedRow = (holder: Address, payer: Address, count: bigint, balance: bigint, at: Place): IndexedStickyEvent => ({
  ...placed(at),
  holder,
  type: 'staked',
  payer,
  count,
  stakedBalance: balance,
})

const indexedOn = (block: bigint, projects: bigint[] = [23n]): IndexedProjects => ({
  blocks: new Map([[CHAIN, block]]),
  projects: projects.map(projectId => ({ chainId: CHAIN, projectId })),
})
const moves = (rows: IndexedMove[], block: bigint | null = 100n): IndexedRows<IndexedMove> => ({
  rows,
  blocks: block === null ? new Map() : new Map([[CHAIN, block]]),
})

type Fakes = { [K in keyof HomeReadDeps]: ReturnType<typeof vi.fn> }
function fakes(projects: bigint[], overrides: Partial<Fakes> = {}): Fakes {
  const result = (source: StickyProjectsResult['source']): StickyProjectsResult => ({
    projects: projects.map(projectId => ({ chainId: CHAIN, projectId })),
    source,
    degraded: source === 'indexed' ? null : 'indexer-error',
  })
  return {
    projectsOn: vi.fn(async (_chainId: number, index: IndexedProjects | null) => result(index ? 'indexed' : 'scanned')),
    readProjects: vi.fn(async (_chainId: number, projectIds: readonly bigint[]) => projectIds.map(id => info(id))),
    indexedMoves: vi.fn(async () => moves([])),
    scan: vi.fn(async (): Promise<ScannedLog[]> => []),
    terminalMoves: vi.fn(async () => new Map<string, bigint>()),
    creationBlock: vi.fn(async () => null),
    ...overrides,
  }
}
const deps = (given: Fakes) => given as unknown as HomeReadDeps

const lines = (rows: FeedRow[]) => rows.map(row => row.line)
const amounts = (rows: FeedRow[]) => rows.map(row => row.amount && `${row.amount.value}:${row.amount.symbol}`)

describe('homeChain, with Bendystraw', () => {
  it('reads each project from the chain, and builds Sticks, the chart and both lists from the pays and cash outs', async () => {
    const rows = [
      pay(HOLDER, HOLDER, 1_000n * E18, 1_010n * E6, { tx: 'a1', timestamp: 100 }),
      pay(OTHER, FUNDER, 5n * E18, 5n * E6, { tx: 'a2', timestamp: 200 }),
      cashOut(HOLDER, 100n * E18, 99n * E6, { tx: 'a3', timestamp: 300 }),
      pay(SENDER, ADAPTER, 2n * E18, 2n * E6, { tx: 'a4', timestamp: 400 }),
    ]
    const given = fakes([23n], { indexedMoves: vi.fn(async () => moves(rows)) })
    const chain = await homeChain(CHAIN, { index: indexedOn(100n), latest: null, ...deps(given) })

    expect(given.projectsOn).toHaveBeenCalledWith(CHAIN, indexedOn(100n), { signal: undefined })
    expect(given.readProjects).toHaveBeenCalledWith(CHAIN, [23n], { signal: undefined })
    expect(given.indexedMoves).toHaveBeenCalledWith(CHAIN, [23n], undefined)
    expect(chain.cards).toEqual<HomeCard[]>([{ info: info(23n), sticks: 3 }])
    expect(chain.supply).toEqual([
      { projectId: 23n, timestamp: 100, delta: 1_000n * E18 },
      { projectId: 23n, timestamp: 200, delta: 5n * E18 },
      { projectId: 23n, timestamp: 300, delta: -100n * E18 },
      { projectId: 23n, timestamp: 400, delta: 2n * E18 },
    ])
    expect(lines(chain.activity)).toEqual([
      { kind: 'autoStuck', holder: SENDER },
      { kind: 'unstuck', holder: HOLDER },
      { kind: 'gift', holder: OTHER, payer: FUNDER },
      { kind: 'stuck', holder: HOLDER },
    ])
    expect(amounts(chain.activity)).toEqual([`${2n * E6}:CPN`, `${99n * E6}:CPN`, `${5n * E6}:CPN`, `${1_010n * E6}:CPN`])
    expect(lines(chain.airdrops)).toEqual([{ kind: 'gift', holder: OTHER, payer: FUNDER }])
    // Nothing is scanned: the pays and cash outs are the whole answer.
    expect(given.scan).not.toHaveBeenCalled()
    expect(given.terminalMoves).not.toHaveBeenCalled()
    expect(given.creationBlock).not.toHaveBeenCalled()
  })

  it('counts a holder in Sticks while their sticks outweigh their unsticks, per project', async () => {
    const rows = [
      pay(HOLDER, HOLDER, 5n, 5n, { tx: 'b1', timestamp: 1 }),
      cashOut(HOLDER, 5n, 5n, { tx: 'b2', timestamp: 2 }),
      pay(OTHER, OTHER, 1n, 1n, { tx: 'b3', timestamp: 3 }),
      pay(OTHER, OTHER, 1n, 1n, { tx: 'b4', timestamp: 4, projectId: 24n }),
      pay(SENDER, SENDER, 1n, 1n, { tx: 'b5', timestamp: 5, projectId: 24n }),
    ]
    const given = fakes([23n, 24n], { indexedMoves: vi.fn(async () => moves(rows)) })
    const chain = await homeChain(CHAIN, { index: indexedOn(100n, [23n, 24n]), latest: null, ...deps(given) })
    expect(chain.cards.map(card => [card.info.projectId, card.sticks])).toEqual([
      [23n, 1],
      [24n, 2],
    ])
  })

  it('asks the relay for at most 1,000 projects at a time, one request after another', async () => {
    const projects = Array.from({ length: 2_500 }, (_, at) => BigInt(at + 1))
    let reading = 0
    const indexedMoves = vi.fn(async (_chainId: number, ids: readonly bigint[]) => {
      reading += 1
      expect(reading).toBe(1)
      await Promise.resolve()
      reading -= 1
      const first = ids[0]
      return moves([pay(HOLDER, HOLDER, 1n, 1n, { tx: `c${first}`, timestamp: Number(3_000n - first), projectId: first })])
    })
    const given = fakes(projects, { indexedMoves })
    const chain = await homeChain(CHAIN, { index: indexedOn(100n, projects), latest: null, ...deps(given) })

    expect(indexedMoves.mock.calls.map(([, ids]) => [ids.length, ids[0], ids.at(-1)])).toEqual([
      [1_000, 1n, 1_000n],
      [1_000, 1_001n, 2_000n],
      [500, 2_001n, 2_500n],
    ])
    // One list, in the order of time, whichever request each move came in.
    expect(chain.supply.map(move => move.timestamp)).toEqual([999, 1_999, 2_999])
    expect(given.scan).not.toHaveBeenCalled()
  })

  it('scans the chain when one request of the moves has no status for it', async () => {
    const projects = Array.from({ length: 1_001 }, (_, at) => BigInt(at + 1))
    const indexedMoves = vi.fn(async (_chainId: number, ids: readonly bigint[]) => moves([], ids[0] === 1n ? 100n : null))
    const given = fakes(projects, { indexedMoves, creationBlock: vi.fn(async () => 5n) })
    await homeChain(CHAIN, { index: indexedOn(100n, projects), latest: null, ...deps(given) })
    expect(indexedMoves).toHaveBeenCalledTimes(2)
    expect(given.scan).toHaveBeenCalledTimes(1)
  })

  it('builds Latest from Bendystraw\'s newest events and a scan past their block, with each event\'s amount', async () => {
    const rows = [
      pay(HOLDER, HOLDER, 10n * E18, 10n * E6, { tx: 'd1', timestamp: 100 }),
      pay(OTHER, FUNDER, 5n * E18, 5n * E6, { tx: 'd2', timestamp: 200 }),
    ]
    const latest: IndexedRows<IndexedStickyEvent> = {
      rows: [
        stakedRow(HOLDER, HOLDER, 10n * E18, 10n * E18, { tx: 'd1', timestamp: 100 }),
        stakedRow(OTHER, FUNDER, 5n * E18, 5n * E18, { tx: 'd2', timestamp: 200 }),
        // Another chain's row is that chain's.
        { ...stakedRow(HOLDER, HOLDER, 1n, 1n, { tx: 'd9', timestamp: 250 }), chainId: 10 },
      ],
      blocks: new Map([
        [CHAIN, CREATED],
        [10, 7n],
      ]),
    }
    const tail = [
      staked(SENDER, SENDER, 3n * E18, 3n * E18, { txHash: hash('d3'), blockNumber: CREATED + 10n, logIndex: 1 }),
      streakStarted(SENDER, { txHash: hash('d3'), blockNumber: CREATED + 10n, logIndex: 0 }),
    ]
    const terminalMoves = vi.fn(async (events: readonly StickyEvent[]) =>
      new Map(events.map(event => [`${event.txHash}`, 1n] as [string, bigint])),
    )
    const given = fakes([23n], {
      indexedMoves: vi.fn(async () => moves(rows)),
      scan: vi.fn(async () => tail),
      terminalMoves,
    })
    const chain = await homeChain(CHAIN, { index: indexedOn(100n), latest, ...deps(given) })

    // The tail starts 64 blocks below the block Bendystraw's events are as of.
    expect(given.scan).toHaveBeenCalledWith(
      CHAIN,
      { address: HOOK, topics: [POSITION_TOPICS], fromBlock: CREATED + 1n - 64n },
      { signal: undefined },
    )
    expect(lines(chain.activity)).toEqual([
      { kind: 'stuck', holder: SENDER, streak: 'started' },
      { kind: 'gift', holder: OTHER, payer: FUNDER },
      { kind: 'stuck', holder: HOLDER },
    ])
    // Bendystraw's events take their amounts from its pays; only the scanned stick is read from the terminal.
    expect(terminalMoves).toHaveBeenCalledTimes(1)
    expect(terminalMoves.mock.calls[0][0].map((event: StickyEvent) => event.txHash)).toEqual([hash('d3'), hash('d3')])
    expect(amounts(chain.activity).slice(1)).toEqual([`${5n * E6}:CPN`, `${10n * E6}:CPN`])
    expect(chain.activity[0].timestamp).toBe(timeAt(CREATED + 10n))
  })

  it('builds Latest from the pays and cash outs when the scan past Bendystraw\'s block fails, and says why', async () => {
    const rows = [pay(HOLDER, HOLDER, 1n, 1n, { tx: 'e1', timestamp: 100 })]
    const latest = { rows: [stakedRow(HOLDER, HOLDER, 1n, 1n, { tx: 'e1', timestamp: 100 })], blocks: new Map([[CHAIN, 50n]]) }
    const failure = new Error('429')
    const given = fakes([23n], {
      indexedMoves: vi.fn(async () => moves(rows)),
      scan: vi.fn(async () => {
        throw failure
      }),
    })
    const chain = await homeChain(CHAIN, { index: indexedOn(100n), latest, ...deps(given) })
    expect(lines(chain.activity)).toEqual([{ kind: 'stuck', holder: HOLDER }])
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ["Could not read a chain's newest blocks; Latest shows Bendystraw's pays and cash outs.", { chainId: CHAIN }, failure],
    ])
  })

  it('builds Latest from the pays and cash outs, as when Bendystraw has no newest events, when the tail is too long to scan', async () => {
    // Bendystraw answers, but is far behind the head, as when it replays its history.
    const rows = [pay(HOLDER, HOLDER, 1n, 1n, { tx: 'e2', timestamp: 100 })]
    const latest = { rows: [stakedRow(HOLDER, HOLDER, 1n, 1n, { tx: 'e2', timestamp: 100 })], blocks: new Map([[CHAIN, 50n]]) }
    const tooLong = new HistoryTooLongError('This history spans 600000 blocks, more than this RPC can scan in 1024 requests.')
    const given = fakes([23n], {
      indexedMoves: vi.fn(async () => moves(rows)),
      scan: vi.fn(async () => {
        throw tooLong
      }),
    })
    const chain = await homeChain(CHAIN, { index: indexedOn(100n), latest, ...deps(given) })
    expect(lines(chain.activity)).toEqual([{ kind: 'stuck', holder: HOLDER }])
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ['Bendystraw could not list the newest Sticky events; Latest shows its pays and cash outs.', { chainId: CHAIN }, tooLong],
    ])
  })

  it('builds Latest from the pays and cash outs when Bendystraw has no newest events for the chain', async () => {
    const rows = [pay(HOLDER, HOLDER, 1n, 1n, { tx: 'f1', timestamp: 100 })]
    const latest = { rows: [], blocks: new Map([[10, 50n]]) }
    const given = fakes([23n], { indexedMoves: vi.fn(async () => moves(rows)) })
    const chain = await homeChain(CHAIN, { index: indexedOn(100n), latest, ...deps(given) })
    expect(lines(chain.activity)).toEqual([{ kind: 'stuck', holder: HOLDER }])
    expect(given.scan).not.toHaveBeenCalled()
  })

  it('shows the newest FEED_WINDOW of each list, and the Airdrops window holds airdrops', async () => {
    const gifts = Array.from({ length: 50 }, (_, at) =>
      pay(OTHER, FUNDER, 1n, 1n, { tx: `g${at}`, timestamp: 1_000 + at }),
    )
    const own = Array.from({ length: 10 }, (_, at) => pay(HOLDER, HOLDER, 1n, 1n, { tx: `h${at}`, timestamp: 2_000 + at }))
    const given = fakes([23n], { indexedMoves: vi.fn(async () => moves([...gifts, ...own])) })
    const chain = await homeChain(CHAIN, { index: indexedOn(100n), latest: null, ...deps(given) })
    expect(chain.activity).toHaveLength(FEED_WINDOW)
    expect(chain.activity.filter(row => row.line.kind === 'gift')).toHaveLength(FEED_WINDOW - 10)
    expect(chain.airdrops).toHaveLength(FEED_WINDOW)
    expect(chain.airdrops[0].txHash).toBe(hash('g49'))
  })

  it('scans the chain when Bendystraw cannot list its pays and cash outs, and says why', async () => {
    const failure = new Error('Bendystraw unavailable')
    const given = fakes([23n], {
      indexedMoves: vi.fn(async () => {
        throw failure
      }),
      creationBlock: vi.fn(async () => 777n),
    })
    await homeChain(CHAIN, { index: indexedOn(100n), latest: null, ...deps(given) })
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/scanning/), { chainId: CHAIN }, failure)
    expect(given.scan).toHaveBeenCalledWith(
      CHAIN,
      { address: HOOK, topics: [POSITION_TOPICS], fromBlock: 777n },
      { signal: undefined },
    )
  })

  it('scans the chain when Bendystraw\'s pays and cash outs have no status for it', async () => {
    const given = fakes([23n], { indexedMoves: vi.fn(async () => moves([], null)), creationBlock: vi.fn(async () => 5n) })
    await homeChain(CHAIN, { index: indexedOn(100n), latest: null, ...deps(given) })
    expect(given.scan).toHaveBeenCalledTimes(1)
  })
})

describe('homeChain, without Bendystraw', () => {
  it('lists the projects from the deployer\'s logs, then scans the hook from the first launch\'s block', async () => {
    const logs = [
      staked(HOLDER, HOLDER, 5n * E18, 5n * E18, { project: 37n, blockNumber: 1_000n }),
      staked(OTHER, OTHER, 1n * E18, 1n * E18, { project: 37n, blockNumber: 1_001n }),
      unstaked(OTHER, 1n * E18, 0n, { project: 37n, blockNumber: 1_002n }),
      staked(SENDER, HOLDER, 2n * E18, 2n * E18, { project: 38n, blockNumber: 1_003n }),
    ]
    const given = fakes([38n, 37n], {
      scan: vi.fn(async () => logs),
      creationBlock: vi.fn(async () => 0x99n),
      terminalMoves: vi.fn(async () => new Map()),
    })
    const chain = await homeChain(CHAIN, { index: null, latest: null, ...deps(given) })

    expect(given.projectsOn).toHaveBeenCalledWith(CHAIN, null, { signal: undefined })
    // The first launch is the lowest project ID.
    expect(given.creationBlock).toHaveBeenCalledWith(CHAIN, 37n, { signal: undefined })
    expect(given.scan).toHaveBeenCalledWith(
      CHAIN,
      { address: HOOK, topics: [POSITION_TOPICS], fromBlock: 0x99n },
      { signal: undefined },
    )
    expect(given.indexedMoves).not.toHaveBeenCalled()
    expect(chain.cards.map(card => [card.info.projectId, card.sticks])).toEqual([
      [38n, 1],
      [37n, 1],
    ])
    expect(chain.supply).toEqual([
      { projectId: 37n, timestamp: timeAt(1_000n), delta: 5n * E18 },
      { projectId: 37n, timestamp: timeAt(1_001n), delta: 1n * E18 },
      { projectId: 37n, timestamp: timeAt(1_002n), delta: -1n * E18 },
      { projectId: 38n, timestamp: timeAt(1_003n), delta: 2n * E18 },
    ])
    // Transfers and burns keep their Sticky counts when the terminal has no amount.
    expect(lines(chain.activity)).toEqual([
      { kind: 'gift', holder: SENDER, payer: HOLDER },
      { kind: 'removed', holder: OTHER },
      { kind: 'stuck', holder: OTHER },
      { kind: 'stuck', holder: HOLDER },
    ])
    expect(amounts(chain.activity)[0]).toBe(`${2n * E18}:STICKYCPN`)
    expect(lines(chain.airdrops)).toEqual([{ kind: 'gift', holder: SENDER, payer: HOLDER }])
    // One terminal read for both lists.
    expect(given.terminalMoves).toHaveBeenCalledTimes(1)
  })

  it('scans from the deployer\'s block when the first launch\'s block cannot be found', async () => {
    const given = fakes([23n])
    await homeChain(CHAIN, { index: null, latest: null, ...deps(given) })
    expect(given.scan.mock.calls[0][1].fromBlock).toBe(deployment.fromBlock)
  })

  it('leaves out events of projects that are not this chain\'s Sticky projects', async () => {
    const logs = [
      staked(HOLDER, HOLDER, 1n, 1n, { project: 23n, blockNumber: 10n }),
      staked(HOLDER, HOLDER, 1n, 1n, { project: 99n, blockNumber: 11n }),
    ]
    const given = fakes([23n], { scan: vi.fn(async () => logs) })
    const chain = await homeChain(CHAIN, { index: null, latest: null, ...deps(given) })
    expect(chain.activity.map(row => row.projectId)).toEqual([23n])
    expect(chain.supply.map(move => move.projectId)).toEqual([23n])
  })
})

describe('homeChain, its projects', () => {
  it('is empty, and reads nothing more, on a chain with no Sticky projects', async () => {
    const given = fakes([])
    const chain = await homeChain(CHAIN, { index: indexedOn(100n, []), latest: null, ...deps(given) })
    expect(chain).toEqual<HomeChain>({ chainId: CHAIN, cards: [], activity: [], airdrops: [], supply: [] })
    expect(given.readProjects).not.toHaveBeenCalled()
    expect(given.indexedMoves).not.toHaveBeenCalled()
    expect(given.scan).not.toHaveBeenCalled()
  })

  it('reads all of the chain\'s projects together, and shows the ones that can be read', async () => {
    // readStickyProjects leaves out, and tells the console of, a project it cannot read: 24 here.
    const readProjects = vi.fn(async () => [info(23n), info(25n)])
    const given = fakes([23n, 24n, 25n], { readProjects })
    const chain = await homeChain(CHAIN, { index: indexedOn(100n, [23n, 24n, 25n]), latest: null, ...deps(given) })
    expect(readProjects).toHaveBeenCalledTimes(1)
    expect(readProjects).toHaveBeenCalledWith(CHAIN, [23n, 24n, 25n], { signal: undefined })
    expect(chain.cards.map(card => card.info.projectId)).toEqual([23n, 25n])
  })

  it('is an error for the chain when none of its projects can be read', async () => {
    const given = fakes([37n], { readProjects: vi.fn(async () => []) })
    await expect(homeChain(CHAIN, { index: null, latest: null, ...deps(given) })).rejects.toThrow(
      'Could not read any Sticky token on Base.',
    )
  })

  it('rejects with the caller\'s reason once cancelled, and reads nothing more', async () => {
    const controller = new AbortController()
    const reason = new Error('left the page')
    const readProjects = vi.fn(async (_chainId: number, projectIds: readonly bigint[]) => {
      controller.abort(reason)
      return projectIds.map(id => info(id))
    })
    const given = fakes([23n, 24n], { readProjects })
    await expect(
      homeChain(CHAIN, { index: indexedOn(100n, [23n, 24n]), latest: null, signal: controller.signal, ...deps(given) }),
    ).rejects.toBe(reason)
    expect(given.indexedMoves).not.toHaveBeenCalled()
  })
})

describe('the network\'s reads', () => {
  it('homeIndex is Bendystraw\'s project list, or null when it cannot answer, which the console hears about', async () => {
    const index = indexedOn(1n)
    expect(await homeIndex('mainnet', { indexedProjects: vi.fn(async () => index) })).toBe(index)
    const failure = new Error('timeout')
    const indexedProjects = vi.fn(async () => {
      throw failure
    })
    expect(await homeIndex('testnet', { indexedProjects })).toBeNull()
    expect(indexedProjects).toHaveBeenCalledWith('testnet', undefined)
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/Bendystraw/), { network: 'testnet' }, failure)
  })

  it('homeLatest asks for the newest FEED_WINDOW events of the network\'s Sticky chains', async () => {
    const answer = { rows: [], blocks: new Map() }
    const indexedEvents = vi.fn(async () => answer)
    expect(await homeLatest('testnet', { indexedEvents })).toBe(answer)
    expect(indexedEvents).toHaveBeenCalledWith({ chainIds: stickyChainIds('testnet'), newest: FEED_WINDOW }, undefined)
    const failure = new Error('Cannot query field "stickyEvents"')
    expect(await homeLatest('mainnet', { indexedEvents: vi.fn(async () => Promise.reject(failure)) })).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/newest/), { network: 'mainnet' }, failure)
  })

  it('a cancelled network read rejects with the caller\'s reason instead of reading as a failure', async () => {
    const controller = new AbortController()
    const reason = new Error('gone')
    controller.abort(reason)
    await expect(
      homeIndex('mainnet', { signal: controller.signal, indexedProjects: vi.fn(async () => Promise.reject(new Error('x'))) }),
    ).rejects.toBe(reason)
  })

  it('homePrices is DexScreener\'s prices, or null when it cannot answer, which the console hears about', async () => {
    const prices = new Map([[TOKEN, 2]])
    expect(await homePrices(CHAIN, [TOKEN], { usdPrices: vi.fn(async () => prices) })).toBe(prices)
    const failure = new Error('price request failed (503)')
    expect(await homePrices(CHAIN, [TOKEN], { usdPrices: vi.fn(async () => Promise.reject(failure)) })).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/price/), { chainId: CHAIN }, failure)
  })
})


describe('groupHomeCards', () => {
  it('collapses one launch\'s projects into one card, one project per chain, and keeps the others apart', () => {
    const groups = groupHomeCards([
      card(84532, 37n, { launchId: 'L1' }),
      card(84532, 38n, { launchId: 'L1' }),
      card(84532, 39n),
      card(11155420, 20n, { launchId: 'L1' }),
      card(11155420, 21n),
    ])
    expect(groups.map(group => group.cards.map(({ info: { chainId, projectId } }) => `${chainId}:${projectId}`))).toEqual([
      ['84532:37', '11155420:20'],
      ['84532:38'],
      ['84532:39'],
      ['11155420:21'],
    ])
    expect(groups[0].totalStaked).toBe(2n * E18)
  })

  it('needs the same stickiness bonus and transfer mode to be one launch', () => {
    const groups = groupHomeCards([
      card(1, 1n, { launchId: 'L' }),
      card(10, 2n, { launchId: 'L', cashOutTaxRate: 5n }),
      card(8453, 3n, { launchId: 'L' }),
      card(42161, 4n, { launchId: 'L', soulbound: true }),
    ])
    expect(groups.map(group => group.cards.map(({ info }) => info.chainId))).toEqual([[1, 8453], [10], [42161]])
  })

  it('keeps a copy of a launch\'s uri on a chain the launch was not planned on apart, even when it comes first', () => {
    const plan = { launchId: 'L', plannedChains: [84532, 11155420] }
    const groups = groupHomeCards([
      // Ethereum Sepolia comes first in the site's order of chains; the launch was planned on the other two.
      card(11155111, 5n, plan),
      card(11155420, 20n, plan),
      card(84532, 37n, plan),
    ])
    expect(groups.map(group => group.cards.map(({ info: { chainId, projectId } }) => `${chainId}:${projectId}`))).toEqual([
      ['11155420:20', '84532:37'],
      ['11155111:5'],
    ])
  })

  it('keeps a copy apart whose uri adds its own chain to the launch\'s plan, whichever comes first', () => {
    const plan = { launchId: 'L', plannedChains: [84532, 11155420] }
    // The copier edits the uri's chains to name its own chain, Ethereum Sepolia, beside the launch's two.
    const copied = { launchId: 'L', plannedChains: [84532, 11155420, 11155111] }
    const named = (groups: HomeCardGroup[]) =>
      groups.map(group => group.cards.map(({ info: { chainId, projectId } }) => `${chainId}:${projectId}`))

    expect(named(groupHomeCards([card(84532, 37n, plan), card(11155111, 5n, copied), card(11155420, 20n, plan)]))).toEqual([
      ['84532:37', '11155420:20'],
      ['11155111:5'],
    ])
    // Ethereum Sepolia comes first in the site's order of chains, so the copy heads a group the launch must not join.
    expect(named(groupHomeCards([card(11155111, 5n, copied), card(11155420, 20n, plan), card(84532, 37n, plan)]))).toEqual([
      ['11155420:20', '84532:37'],
      ['11155111:5'],
    ])
  })

  it('ranks by Sticky supply, most first, and keeps the order of cards that tie', () => {
    const groups = groupHomeCards([
      card(1, 1n, { totalSupply: 1n }),
      card(1, 2n, { totalSupply: 5n }),
      card(1, 3n, { totalSupply: 1n }),
    ])
    expect(groups.map(group => group.cards[0].info.projectId)).toEqual([2n, 1n, 3n])
  })
})

describe('homeSecuredSeries', () => {
  const NOW = 1_000_000
  const chainOf = (cards: HomeCard[], supply: HomeChain['supply'] = []): HomeChain => ({
    chainId: CHAIN,
    cards,
    activity: [],
    airdrops: [],
    supply,
  })
  const priced = (price: number | undefined) => (chainId: number, token: Address) =>
    chainId === CHAIN && token === TOKEN ? price : undefined

  it('values today\'s claimable backing at today\'s price, and past share counts at today\'s backing per share', () => {
    // 10 shares back 20 CPN (6 decimals) at $2: $40 now. Five of the shares were stuck at 100, the rest at 200.
    const chain = chainOf(
      [card(CHAIN, 23n, { decimals: 6, totalSupply: 10n * E18, backing: 20n * E6 })],
      [
        { projectId: 23n, timestamp: 100, delta: 5n * E18 },
        { projectId: 23n, timestamp: 200, delta: 5n * E18 },
      ],
    )
    const series = homeSecuredSeries([chain], priced(2), NOW)
    expect(series.total).toBe(40_000_000n)
    expect(series.hasValue).toBe(true)
    expect(series.missing).toEqual([])
    expect(series.points).toEqual([
      { timestamp: 100, value: 20_000_000n },
      { timestamp: 200, value: 40_000_000n },
      { timestamp: NOW, value: 40_000_000n },
    ])
  })

  it('adds up projects whose moves interleave, each at the last of its own points before a time', () => {
    const chain = chainOf(
      [
        card(CHAIN, 23n, { decimals: 6, totalSupply: 10n * E18, backing: 20n * E6 }),
        card(CHAIN, 24n, { decimals: 6, totalSupply: 4n * E18, backing: 4n * E6 }),
      ],
      [
        { projectId: 23n, timestamp: 100, delta: 5n * E18 },
        { projectId: 24n, timestamp: 200, delta: 4n * E18 },
        { projectId: 23n, timestamp: 300, delta: 5n * E18 },
      ],
    )
    expect(homeSecuredSeries([chain], priced(2), NOW).points).toEqual([
      { timestamp: 100, value: 20_000_000n },
      { timestamp: 200, value: 28_000_000n },
      { timestamp: 300, value: 48_000_000n },
      { timestamp: NOW, value: 48_000_000n },
    ])
  })

  it('anchors the history to today\'s supply, so moves it never saw only shift older points', () => {
    const chain = chainOf(
      [card(CHAIN, 23n, { decimals: 6, totalSupply: 10n * E18, backing: 10n * E6 })],
      [{ projectId: 23n, timestamp: 100, delta: -4n * E18 }],
    )
    // Running supply 0 → 0 (never below zero), corrected by today's 10 shares.
    expect(homeSecuredSeries([chain], priced(1), NOW).points).toEqual([
      { timestamp: 100, value: 10_000_000n },
      { timestamp: NOW, value: 10_000_000n },
    ])
  })

  it('draws a project with no moves flat over the last 30 days', () => {
    const chain = chainOf([card(CHAIN, 23n, { decimals: 6, totalSupply: E18, backing: 3n * E6 })])
    expect(homeSecuredSeries([chain], priced(1), NOW).points).toEqual([
      { timestamp: NOW - 30 * 86_400, value: 3_000_000n },
      { timestamp: NOW, value: 3_000_000n },
    ])
  })

  it('names the stuck tokens it could not price, and has no value when it could price none', () => {
    const chain = chainOf([
      card(CHAIN, 23n, { symbol: 'CPN' }),
      card(CHAIN, 24n, { symbol: 'NIL', totalSupply: 0n, stakedToken: getAddress(`0x${'9'.repeat(40)}`) }),
    ])
    const series = homeSecuredSeries([chain], () => undefined, NOW)
    expect(series).toMatchObject({ total: 0n, hasValue: false, missing: ['CPN'] })
    expect(series.points).toEqual([
      { timestamp: NOW - 30 * 86_400, value: 0n },
      { timestamp: NOW, value: 0n },
    ])
  })

  it('names a token it has no price for only once its chain\'s prices have answered', () => {
    const chain = chainOf([card(CHAIN, 23n, { symbol: 'ART', stakedToken: getAddress(`0x${'9'.repeat(40)}`) })])
    expect(homeSecuredSeries([chain], () => undefined, NOW, () => false).missing).toEqual([])
    expect(homeSecuredSeries([chain], () => undefined, NOW, chainId => chainId === CHAIN).missing).toEqual(['ART'])
  })
})

describe('securedBars', () => {
  it('samples 28 bars from the first point to now, the last one today\'s total, each a share of the tallest', () => {
    const bars = securedBars({
      points: [
        { timestamp: 0, value: 0n },
        { timestamp: 1_350, value: 50n },
        { timestamp: 2_700, value: 100n },
      ],
      total: 200n,
      missing: [],
      hasValue: true,
    })
    expect(bars).toHaveLength(28)
    expect(bars[0]).toEqual({ timestamp: 0, value: 0n, height: 0 })
    expect(bars[13]).toEqual({ timestamp: 1_300, value: 0n, height: 0 })
    expect(bars[14]).toEqual({ timestamp: 1_400, value: 50n, height: 25 })
    expect(bars[27]).toEqual({ timestamp: 2_700, value: 200n, height: 100 })
  })

  it('gives a tiny nonzero bar at least 1% so it still shows', () => {
    const bars = securedBars({
      points: [
        { timestamp: 0, value: 1n },
        { timestamp: 10, value: 1n },
      ],
      total: 10_000n,
      missing: [],
      hasValue: true,
    })
    expect(bars[0].height).toBe(1)
  })
})
