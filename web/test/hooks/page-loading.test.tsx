import type { QueryClient } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { pad, toHex, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IndexedMove, IndexedPosition, IndexedSetting, IndexedStickyEvent } from '@/lib/sticky-indexed'
import {
  E18,
  STEP_MS,
  Traffic,
  fakeBendystraw,
  serveCenter,
  timeOf,
  type FakeChain,
  type FakeIndex,
  type FakeWorld,
} from '../center-load'
import { granterSet, staked, streakEnded, streakStarted, trustSet, unstaked } from '../lib/sticky-log-fixtures'

// How long the project page and the account page take to show each figure, in requests that stood one after another
// before it, and how many requests they send: the reads of the real hooks against a fake Center and a fake Bendystraw
// in which every request takes one step (`center-load.ts`). The worlds are the testnet pages staging was timed on
// (task A.2): /basesep:42, and the account that holds Base Sepolia #37 and #42 and OP Sepolia #23.

const bendystraw = vi.hoisted(() => ({
  events: vi.fn(),
  settings: vi.fn(),
  positions: vi.fn(),
  moves: vi.fn(),
  projects: vi.fn(),
  createTx: vi.fn(),
}))
vi.mock('@/lib/sticky-indexed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-indexed')>()),
  indexedStickyEvents: bendystraw.events,
  indexedStickySettings: bendystraw.settings,
  indexedStickyPositions: bendystraw.positions,
  indexedStickyMoves: bendystraw.moves,
  indexedStickyProjects: bendystraw.projects,
  indexedStickyCreateTx: bendystraw.createTx,
}))

const SEPOLIA = 11_155_111
const OP_SEPOLIA = 11_155_420
const BASE_SEPOLIA = 84_532
const ARB_SEPOLIA = 421_614
const TESTNET = [SEPOLIA, OP_SEPOLIA, BASE_SEPOLIA, ARB_SEPOLIA]

const A = '0x042f00000000000000000000000000000000203a' as Address
const B = '0x6dae00000000000000000000000000000000a25f' as Address
const GRANTER = `0x${'d'.repeat(40)}` as Address
const SENDER = `0x${'c'.repeat(40)}` as Address

/** Each chain's head, and how far Bendystraw's status trails it, as A.2 measured them (median, Arbitrum's p90). */
const HEADS: Record<number, { head: bigint; behind: bigint }> = {
  [SEPOLIA]: { head: 11_820_000n, behind: 1n },
  [OP_SEPOLIA]: { head: 49_505_000n, behind: 5n },
  [BASE_SEPOLIA]: { head: 47_520_000n, behind: 4n },
  [ARB_SEPOLIA]: { head: 314_460_000n, behind: 33n },
}

/** One hook event of a project's history, a transaction of its own at `block` unless another event shares the block. */
type Happening =
  | { kind: 'stick'; holder: Address; count: bigint; balance: bigint; block: bigint; logIndex?: number }
  | { kind: 'unstick'; holder: Address; count: bigint; balance: bigint; block: bigint; logIndex?: number }
  | { kind: 'streakStart'; holder: Address; block: bigint; logIndex?: number }
  | { kind: 'streakEnd'; holder: Address; duration: number; block: bigint; logIndex?: number }

const txOf = (block: bigint): Hex => pad(toHex(block), { size: 32 })
/** Where a log of `projectId`'s is: in the one transaction of `block`, with that block's time. */
const logAt = (projectId: bigint, block: bigint, logIndex = 0) => ({
  blockNumber: block,
  logIndex,
  project: projectId,
  txHash: txOf(block),
  time: BigInt(timeOf(block)),
})
/** A's position in a project, Bendystraw's way: `staked` shares, in a streak since `since`. */
const positionOf = (chainId: number, projectId: bigint, staked: bigint, since: bigint): IndexedPosition => ({
  chainId,
  projectId,
  holder: A,
  stakedBalance: staked,
  streakStartedAt: timeOf(since),
  longestCompletedStreak: 0,
})

/** A project's history as the chain logs it and as Bendystraw indexes it, with what the terminal took in or paid out. */
function historyOf(chainId: number, projectId: bigint, happenings: Happening[]) {
  const logs = happenings.map(happening => {
    const at = logAt(projectId, happening.block, happening.logIndex)
    switch (happening.kind) {
      case 'stick':
        return staked(happening.holder, happening.holder, happening.count, happening.balance, at)
      case 'unstick':
        return unstaked(happening.holder, happening.count, happening.balance, at)
      case 'streakStart':
        return streakStarted(happening.holder, at)
      case 'streakEnd':
        return streakEnded(happening.holder, BigInt(happening.duration), at)
    }
  })
  const placed = (happening: Happening) => ({
    chainId,
    projectId,
    txHash: txOf(happening.block),
    logIndex: happening.logIndex ?? 0,
    timestamp: timeOf(happening.block),
    holder: happening.holder,
  })
  const events = happenings.map((happening): IndexedStickyEvent => {
    switch (happening.kind) {
      case 'stick': {
        const { holder: payer, count, balance: stakedBalance } = happening
        return { ...placed(happening), type: 'staked', payer, count, stakedBalance }
      }
      case 'unstick':
        return { ...placed(happening), type: 'unstaked', count: happening.count, stakedBalance: happening.balance }
      case 'streakStart':
        return { ...placed(happening), type: 'streakStarted' }
      case 'streakEnd':
        return { ...placed(happening), type: 'streakEnded', duration: happening.duration }
    }
  })
  // A share is backed by one of the staked token, so a stick took in, and an unstick paid out, its count.
  const moves = happenings.flatMap((happening): IndexedMove[] =>
    happening.kind === 'stick'
      ? [{ ...placed(happening), kind: 'stick', payer: happening.holder, amount: happening.count, tokens: happening.count }]
      : happening.kind === 'unstick'
        ? [{ ...placed(happening), kind: 'unstick', amount: happening.count, tokens: happening.count }]
        : [],
  )
  return { logs, events, moves }
}

const BASE_HEAD = HEADS[BASE_SEPOLIA].head
/** Project 42's launch: 20 windows of 500 blocks below the head, so a scan of its whole history is 20 requests. */
const CREATED_42 = BASE_HEAD - 9_999n
const at42 = (offset: bigint) => CREATED_42 + offset

/** /basesep:42 as staging showed it: sticks 5, unsticks 3, streak starts 2 and a streak end, a granter and two trusts;
 * A holds 140 shares in a streak, and B has left. */
function project42(chainId = BASE_SEPOLIA) {
  const history = historyOf(chainId, 42n, [
    { kind: 'streakStart', holder: A, block: at42(100n) },
    { kind: 'stick', holder: A, count: 10n * E18, balance: 10n * E18, block: at42(100n), logIndex: 1 },
    { kind: 'streakStart', holder: B, block: at42(200n) },
    { kind: 'stick', holder: B, count: 5n * E18, balance: 5n * E18, block: at42(200n), logIndex: 1 },
    { kind: 'stick', holder: A, count: 50n * E18, balance: 60n * E18, block: at42(300n) },
    { kind: 'streakEnd', holder: B, duration: 346, block: at42(400n) },
    { kind: 'unstick', holder: B, count: 5n * E18, balance: 0n, block: at42(400n), logIndex: 1 },
    { kind: 'stick', holder: A, count: 100n * E18, balance: 160n * E18, block: at42(500n) },
    { kind: 'unstick', holder: A, count: 20n * E18, balance: 140n * E18, block: at42(600n) },
    { kind: 'stick', holder: B, count: 2n * E18, balance: 2n * E18, block: at42(700n) },
    { kind: 'unstick', holder: B, count: 2n * E18, balance: 0n, block: at42(800n) },
  ])
  const settingAt = (block: bigint) => ({ chainId, projectId: 42n, txHash: txOf(block), logIndex: 0, timestamp: timeOf(block) })
  const settings: IndexedSetting[] = [
    { ...settingAt(at42(5n)), type: 'granterSet', granter: GRANTER, caller: GRANTER },
    { ...settingAt(at42(150n)), type: 'trustedSenderSet', holder: A, sender: SENDER, trusted: true },
    { ...settingAt(at42(250n)), type: 'trustedSenderSet', holder: A, sender: SENDER, trusted: false },
  ]
  const settingLogs = [
    granterSet(GRANTER, logAt(42n, at42(5n))),
    trustSet(A, SENDER, true, logAt(42n, at42(150n))),
    trustSet(A, SENDER, false, logAt(42n, at42(250n))),
  ]
  const positions: IndexedPosition[] = [
    positionOf(chainId, 42n, 140n * E18, at42(100n)),
    { chainId, projectId: 42n, holder: B, stakedBalance: 0n, streakStartedAt: null, longestCompletedStreak: 346 },
  ]
  return { ...history, logs: [...history.logs, ...settingLogs], settings, positions }
}

/** A chain of the testnet world, Bendystraw indexed through `behind` blocks below its head. */
function chainOf(
  chainId: number,
  { projects, logs = [], events = [], settings = [], positions = [], moves = [] }: Partial<FakeIndex> &
    Pick<FakeChain, 'projects'> & { logs?: FakeChain['logs'] },
): FakeChain {
  const { head, behind } = HEADS[chainId]
  return { head, asOf: head - behind, projects, logs, index: { events, settings, positions, moves } }
}

const coupon = (created: bigint, holders: NonNullable<FakeChain['projects'][string]['holders']> = {}) => ({
  symbol: 'ART',
  decimals: 18,
  stSymbol: 'E2ES',
  supply: 140n * E18,
  backing: 140n * E18,
  created,
  holders,
})

/** The project page's world: Base Sepolia, with project 42 on it. */
function projectWorld({ bendystraw }: { bendystraw: boolean }): FakeWorld {
  const p42 = project42()
  return {
    bendystraw,
    chains: {
      [BASE_SEPOLIA]: chainOf(BASE_SEPOLIA, { projects: { '42': coupon(CREATED_42) }, ...p42 }),
    },
  }
}

/** The account page's world: A holds Base Sepolia #37 and #42 and OP Sepolia #23, and Sepolia and Arbitrum Sepolia have
 * nothing of A's. */
function accountWorld(): FakeWorld {
  const p42 = project42()
  const created37 = BASE_HEAD - 50_000n
  const p37 = historyOf(BASE_SEPOLIA, 37n, [
    { kind: 'streakStart', holder: A, block: created37 + 100n },
    { kind: 'stick', holder: A, count: 6n * E18, balance: 6n * E18, block: created37 + 100n, logIndex: 1 },
  ])
  const opHead = HEADS[OP_SEPOLIA].head
  const created23 = opHead - 60_000n
  const p23 = historyOf(OP_SEPOLIA, 23n, [
    { kind: 'streakStart', holder: A, block: created23 + 100n },
    { kind: 'stick', holder: A, count: 150n * E18, balance: 150n * E18, block: created23 + 100n, logIndex: 1 },
    { kind: 'unstick', holder: A, count: 10n * E18, balance: 140n * E18, block: created23 + 900n },
  ])
  const holdsA = (staked: bigint, since: bigint) => ({ [A.toLowerCase()]: { staked, start: timeOf(since), longest: 0 } })
  const ofA = <T extends { holder: Address }>(rows: T[]) => rows.filter(row => row.holder === A)
  return {
    bendystraw: true,
    chains: {
      [SEPOLIA]: chainOf(SEPOLIA, { projects: {} }),
      [OP_SEPOLIA]: chainOf(OP_SEPOLIA, {
        projects: { '23': coupon(created23, holdsA(140n * E18, created23 + 100n)) },
        logs: p23.logs,
        events: p23.events,
        moves: p23.moves,
        positions: [positionOf(OP_SEPOLIA, 23n, 140n * E18, created23 + 100n)],
      }),
      [BASE_SEPOLIA]: chainOf(BASE_SEPOLIA, {
        projects: {
          '37': coupon(created37, holdsA(6n * E18, created37 + 100n)),
          '42': coupon(CREATED_42, holdsA(140n * E18, at42(100n))),
        },
        logs: [...p37.logs, ...p42.logs],
        events: [...p37.events, ...ofA(p42.events)],
        moves: [...p37.moves, ...ofA(p42.moves)],
        positions: [positionOf(BASE_SEPOLIA, 37n, 6n * E18, created37 + 100n), ...ofA(p42.positions)],
      }),
      [ARB_SEPOLIA]: chainOf(ARB_SEPOLIA, { projects: {} }),
    },
  }
}

/** The modules a measurement renders with, loaded afresh for each: what a module keeps for the session (a chain's
 * reader and head, JBTokens' address) is then the same for every test, however they are run. */
async function load() {
  vi.resetModules()
  const [react, dom, query, project, account, metadata] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('@/hooks/useStickyProject'),
    import('@/hooks/useStickyAccount'),
    import('@/hooks/useProjectMetadata'),
  ])
  return { react, dom, query, project, account, metadata }
}
type Modules = Awaited<ReturnType<typeof load>>

/** When each figure first showed, in steps since the page opened, and the requests that began before the last of them:
 * Center's, Bendystraw's, and the most of Center's in flight at once. */
type Measured = { at: Record<string, number>; center: number; bendystraw: number; peak: number; traffic: Traffic }

/**
 * Opens `page` against `world` and moves the clock a step at a time until every one of `milestones` holds, each a
 * question about the query client. A milestone's time is when the query cache first changed with it holding.
 */
async function measure(
  modules: Modules,
  world: FakeWorld,
  page: ReactElement,
  milestones: Record<string, (client: QueryClient) => boolean>,
): Promise<Measured> {
  const { react, dom, query } = modules
  query.notifyManager.setScheduler(callback => queueMicrotask(callback))
  const traffic = new Traffic()
  serveCenter(world, traffic)
  const fakes = fakeBendystraw(world, traffic)
  bendystraw.events.mockImplementation(fakes.events)
  bendystraw.settings.mockImplementation(fakes.settings)
  bendystraw.positions.mockImplementation(fakes.positions)
  bendystraw.moves.mockImplementation(fakes.moves)
  bendystraw.projects.mockImplementation(fakes.projects)
  bendystraw.createTx.mockImplementation(fakes.createTx)

  // Providers' defaults.
  const client = new query.QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, gcTime: 10 * 60_000, retry: 1, refetchOnWindowFocus: false } },
  })
  const start = Date.now()
  const shown: Record<string, number> = {}
  const unsubscribe = client.getQueryCache().subscribe(() => {
    for (const [name, holds] of Object.entries(milestones)) {
      if (shown[name] === undefined && holds(client)) shown[name] = Date.now() - start
    }
  })
  const root = dom.createRoot(document.createElement('div'))
  await react.act(async () => root.render(react.createElement(query.QueryClientProvider, { client }, page)))
  const names = Object.keys(milestones)
  for (let steps = 0; steps < 1_000 && names.some(name => shown[name] === undefined); steps += 1) {
    await react.act(async () => void (await vi.advanceTimersByTimeAsync(STEP_MS)))
  }
  await react.act(async () => root.unmount())
  unsubscribe()
  client.clear()
  // viem gathers a moment's reads into one Multicall3 request a millisecond later, so a figure shows a few milliseconds
  // past its step. A request that began as the last figure showed was not one it waited for.
  const last = Math.max(...names.map(name => shown[name] ?? Infinity))
  return {
    at: Object.fromEntries(names.map(name => [name, Math.round(shown[name] / STEP_MS)])),
    center: traffic.of('center', last).length,
    bendystraw: traffic.of('bendystraw', last).length,
    peak: traffic.peak,
    traffic,
  }
}

/** What a measurement is held to: the times, the requests and the peak, and not the timeline itself. */
const summary = ({ at, center, bendystraw, peak }: Measured) => ({ at, center, bendystraw, peak })

/** The reads the project page makes for its header, its holder figures and Latest. The Overview's chart and chains
 * wait until those have answered, so they are left out: they hold up none of these figures. */
function projectPage({ react, project, metadata }: Modules, chainId: number, projectId: number) {
  function Logo({ token }: { token: Address }) {
    metadata.useProjectMetadata(chainId, token)
    return null
  }
  function Page() {
    const { info } = project.useStickyProject(chainId, projectId)
    project.useProjectSticks(chainId, projectId)
    project.useProjectLatest(chainId, projectId)
    return info ? react.createElement(Logo, { token: info.stakedToken }) : null
  }
  return react.createElement(Page)
}

const success = (client: QueryClient, key: readonly unknown[]) => client.getQueryState(key)?.status === 'success'

function projectMilestones(chainId: number, projectId: number) {
  return {
    header: (client: QueryClient) => success(client, ['sticky-project', chainId, projectId, 'info', 'v1']),
    sticks: (client: QueryClient) => success(client, ['sticky-project', chainId, projectId, 'sticks', 'v1']),
    latest: (client: QueryClient) => success(client, ['sticky-project', chainId, projectId, 'latest', 'v1']),
  }
}

/** The reads the account page makes: its positions and activity, and the logo of each position it shows. */
function accountPage({ react, account, metadata }: Modules, holder: Address) {
  function Logo({ chainId, token }: { chainId: number; token: Address }) {
    metadata.useProjectMetadata(chainId, token)
    return null
  }
  function Page() {
    const { positions } = account.useAccountPositions('testnet', holder)
    account.useAccountActivity('testnet', holder)
    return react.createElement(
      react.Fragment,
      null,
      positions.map(({ info }) =>
        react.createElement(Logo, { key: `${info.chainId}:${info.projectId}`, chainId: info.chainId, token: info.stakedToken }),
      ),
    )
  }
  return react.createElement(Page)
}

function accountMilestones(holder: Address, positions: number, rows: number) {
  const reads = (client: QueryClient, part: 'positions' | 'activity') =>
    TESTNET.map(chainId => client.getQueryState(['sticky-account', 'testnet', holder.toLowerCase(), part, chainId]))
  const shown = (client: QueryClient, part: 'positions' | 'activity') =>
    reads(client, part).reduce((sum, state) => {
      const data = state?.data as { positions?: unknown[]; rows?: unknown[] } | undefined
      return sum + ((part === 'positions' ? data?.positions?.length : data?.rows?.length) ?? 0)
    }, 0)
  const done = (client: QueryClient, part: 'positions' | 'activity') => reads(client, part).every(state => state?.status === 'success')
  return {
    firstPosition: (client: QueryClient) => shown(client, 'positions') > 0,
    allPositions: (client: QueryClient) => done(client, 'positions') && shown(client, 'positions') === positions,
    firstActivity: (client: QueryClient) => shown(client, 'activity') > 0,
    allActivity: (client: QueryClient) => done(client, 'activity') && shown(client, 'activity') === rows,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(1_790_000_000_000)
  localStorage.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  localStorage.clear()
})

// A step is one request's round trip, about 0.4 to 0.5 s on staging. A figure's step is its sequential depth: the
// requests that stood one after another before it, each waiting on another's answer or for its turn.

describe('how the project page loads', () => {
  it('with Bendystraw answering, as on the testnets: the header, Latest and then the holder figures', async () => {
    const modules = await load()
    const page = await measure(
      modules,
      projectWorld({ bendystraw: true }),
      projectPage(modules, BASE_SEPOLIA, 42),
      projectMilestones(BASE_SEPOLIA, 42),
    )
    // The header is the project's head and its two Multicall3 rounds. The holder figures wait for the history and its
    // tail scan, then for Latest's amounts (the pinned block beside them), then for Bendystraw's positions and their
    // tail scan: 7 steps after the header, the 10 Center requests and 5 relay calls staging counted.
    expect(summary(page)).toEqual({ at: { header: 3, sticks: 10, latest: 7 }, center: 10, bendystraw: 5, peak: 2 })
  })

  it('with Bendystraw down, as on the mainnets today: every figure waits on a scan of the history', async () => {
    const modules = await load()
    const page = await measure(
      modules,
      projectWorld({ bendystraw: false }),
      projectPage(modules, BASE_SEPOLIA, 42),
      projectMilestones(BASE_SEPOLIA, 42),
    )
    expect(summary(page)).toEqual({ at: { header: 3, sticks: 50, latest: 49 }, center: 70, bendystraw: 4, peak: 2 })
  })
})

describe('how the account page loads', () => {
  it('with Bendystraw answering, as on the testnets: one chain after another, the positions first', async () => {
    const modules = await load()
    const page = await measure(modules, accountWorld(), accountPage(modules, A), accountMilestones(A, 3, 7))
    expect(summary(page)).toEqual({
      at: { firstPosition: 9, allPositions: 17, firstActivity: 27, allActivity: 38 },
      center: 34,
      bendystraw: 10,
      peak: 2,
    })
  })
})
