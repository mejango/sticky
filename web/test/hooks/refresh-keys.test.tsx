// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HolderRow, StickyPosition } from '@/lib/sticky-holders'
import type { RewardPot } from '@/lib/sticky-rewards'
import { stickyInfo, TOKEN } from '../home-fixtures'

// The refreshes after a send against the queries the hooks really make: the hooks of a project's page and of an account
// page are rendered with every read answered by a marker, and each refresh must invalidate exactly the queries that
// hold what its send changed. A query is told by what it holds, never by its key, so a key that a hook and a refresh
// spell differently fails here instead of leaving a page unrefreshed.

const CHAIN = 84532
const PROJECT = 23
const HOLDER = getAddress(`0x${'ab'.repeat(20)}`)

/** What each read answers. Each is its own object, which the query that holds it is found by. */
const INFO = stickyInfo(CHAIN, BigInt(PROJECT), { launchId: 'launch' })
const EVENTS = { events: [], source: 'indexed', degraded: null }
const HOLDERS = { rows: [] as HolderRow[], source: 'indexed', degraded: null }
const ROWS: HolderRow[] = [{ holder: HOLDER, staked: 1n, start: 0, current: 0, longest: 0 }]
const BALANCE = 777n
const LATEST: unknown[] = []
const POSITION: StickyPosition = {
  staked: 1n,
  wallet: 0n,
  start: 0,
  current: 0,
  longest: 0,
  blockNumber: 9n,
  timestamp: 1_790_000_000,
}
const TRANCHES = { tranches: [], total: 0n, page: 0, start: 0n }
const POTS: RewardPot[] = [{ groupId: 0n, token: TOKEN, funded: 0n }]
const FUNDING: unknown[] = []
const REWARDS: unknown[] = []
const AUTOSTICK = { enabled: false }
const TRUSTED: unknown[] = []
const FLOWS: unknown[] = []
const SIBLING = { chainId: CHAIN, projectId: BigInt(PROJECT), self: true, info: INFO }
const INDEX = { positions: null, projects: null }
const DEPLOYED = [BigInt(PROJECT)]
const POSITIONS = { chainId: CHAIN, positions: [], skipped: 0 }
const ACTIVITY = { chainId: CHAIN, rows: [], labels: {} }

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  events: vi.fn(),
  creation: vi.fn(),
  holders: vi.fn(),
  pinned: vi.fn(),
  position: vi.fn(),
  verify: vi.fn(),
  moves: vi.fn(),
  feed: vi.fn(),
  tranches: vi.fn(),
  funding: vi.fn(),
  rewards: vi.fn(),
  autoStick: vi.fn(),
  trusted: vi.fn(),
  flows: vi.fn(),
  launch: vi.fn(),
  siblings: vi.fn(),
  index: vi.fn(),
  deployed: vi.fn(),
  positions: vi.fn(),
  activity: vi.fn(),
}))

vi.mock('@/lib/sticky-project', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-project')>()),
  readStickyProject: mocks.project,
}))
vi.mock('@/lib/sticky-events', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-events')>()),
  stickyEvents: mocks.events,
  projectCreationBlock: mocks.creation,
}))
vi.mock('@/lib/sticky-holders', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-holders')>()),
  stickyHolders: mocks.holders,
  pinnedBlock: mocks.pinned,
  readStickyPosition: mocks.position,
  verifyHolderPage: mocks.verify,
}))
vi.mock('@/lib/sticky-feed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-feed')>()),
  terminalMoves: mocks.moves,
  feedRows: mocks.feed,
}))
vi.mock('@/lib/sticky-tranches', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-tranches')>()),
  readTranchePage: mocks.tranches,
}))
vi.mock('@/lib/sticky-rewards', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-rewards')>()),
  discoverFunding: mocks.funding,
  readRewards: mocks.rewards,
}))
vi.mock('@/lib/sticky-autostick', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-autostick')>()),
  readAutoStick: mocks.autoStick,
  trustedSenders: mocks.trusted,
}))
vi.mock('@/lib/sticky-backing', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-backing')>()),
  backingFlows: mocks.flows,
}))
vi.mock('@/lib/sticky-siblings', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-siblings')>()),
  launchSiblings: mocks.launch,
  siblingRows: mocks.siblings,
}))
vi.mock('@/lib/sticky-account', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-account')>()),
  accountChains: () => [84532],
  accountIndex: mocks.index,
  deployedProjects: mocks.deployed,
  accountPositions: mocks.positions,
  accountActivity: mocks.activity,
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: undefined }) }))

import { useAccountActivity, useAccountPositions } from '@/hooks/useStickyAccount'
import { useAutoStick, useRewards, useTrustedSenders } from '@/hooks/useStickyAirdrops'
import { useBackingSeries, useProjectSiblings } from '@/hooks/useStickyOverview'
import { useProjectLatest, useProjectSticks, useStickyPosition, useStickyProject } from '@/hooks/useStickyProject'
import { useCheckedBalances, useHolderTranches } from '@/hooks/useStickyTokens'
import {
  refreshAfterAutoStick,
  refreshAfterCollect,
  refreshAfterFund,
  refreshAfterRewardStick,
  refreshAfterStick,
  refreshAfterTransfer,
  refreshAfterTrust,
  refreshAfterUnstick,
} from '@/lib/sticky-refresh'

/** Each read the hooks make, by what its query holds. */
const READS: Record<string, (data: unknown) => boolean> = {
  info: data => data === INFO,
  events: data => data === EVENTS,
  holders: data => (data as { rows?: unknown } | undefined)?.rows === HOLDERS.rows,
  sticks: data => typeof (data as { sticks?: unknown } | undefined)?.sticks === 'number',
  latest: data => data === LATEST,
  'page balances': data => Array.isArray(data) && data[0] === BALANCE,
  position: data => data === POSITION,
  tranches: data => (data as { tranches?: unknown } | undefined)?.tranches === TRANCHES.tranches,
  funding: data => data === FUNDING,
  rewards: data => data === REWARDS,
  'auto-stick': data => data === AUTOSTICK,
  trusted: data => data === TRUSTED,
  flows: data => data === FLOWS,
  siblings: data => Array.isArray(data) && data[0] === SIBLING,
  'account index': data => data === INDEX,
  "a chain's projects": data => data === DEPLOYED,
  'account positions': data => data === POSITIONS,
  'account activity': data => data === ACTIVITY,
}

/** A project's page and the holder's account page, all at once. */
function Pages() {
  useStickyProject(CHAIN, PROJECT)
  useProjectSticks(CHAIN, PROJECT)
  useProjectLatest(CHAIN, PROJECT)
  useStickyPosition(CHAIN, PROJECT, HOLDER, INFO)
  useHolderTranches(CHAIN, PROJECT, HOLDER, 0, POSITION)
  useCheckedBalances(CHAIN, PROJECT, ROWS)
  useRewards(CHAIN, PROJECT, HOLDER, POTS)
  useAutoStick(CHAIN, PROJECT, HOLDER)
  useTrustedSenders(CHAIN, PROJECT, HOLDER)
  useBackingSeries(CHAIN, PROJECT)
  useProjectSiblings(CHAIN, PROJECT)
  useAccountPositions('testnet', HOLDER)
  useAccountActivity('testnet', HOLDER)
  return null
}

let host: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.project.mockReset().mockResolvedValue(INFO)
  mocks.events.mockReset().mockResolvedValue(EVENTS)
  mocks.creation.mockReset().mockResolvedValue(1n)
  mocks.holders.mockReset().mockResolvedValue(HOLDERS)
  mocks.pinned.mockReset().mockResolvedValue({ number: 9n, timestamp: 1_790_000_000 })
  mocks.position.mockReset().mockResolvedValue(POSITION)
  mocks.verify.mockReset().mockResolvedValue([{ ...ROWS[0], staked: BALANCE }])
  mocks.moves.mockReset().mockResolvedValue(new Map())
  mocks.feed.mockReset().mockReturnValue(LATEST)
  mocks.tranches.mockReset().mockResolvedValue(TRANCHES)
  mocks.funding.mockReset().mockResolvedValue(FUNDING)
  mocks.rewards.mockReset().mockResolvedValue(REWARDS)
  mocks.autoStick.mockReset().mockResolvedValue(AUTOSTICK)
  mocks.trusted.mockReset().mockResolvedValue(TRUSTED)
  mocks.flows.mockReset().mockResolvedValue(FLOWS)
  mocks.launch.mockReset().mockResolvedValue([])
  mocks.siblings.mockReset().mockResolvedValue([SIBLING])
  mocks.index.mockReset().mockResolvedValue(INDEX)
  mocks.deployed.mockReset().mockResolvedValue(DEPLOYED)
  mocks.positions.mockReset().mockResolvedValue(POSITIONS)
  mocks.activity.mockReset().mockResolvedValue(ACTIVITY)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  root = createRoot(host)
})

afterEach(() => {
  client.clear()
  vi.useRealTimers()
})

/** The names of the reads each query in the cache holds. A query that has never answered holds none: a hook whose key
 * changed as its inputs settled leaves the one it had first, disabled and empty. */
const readsIn = () =>
  client
    .getQueryCache()
    .getAll()
    .filter(query => query.state.data !== undefined)
    .map(query => Object.keys(READS).filter(name => READS[name](query.state.data)))

/** Renders both pages until every read has answered, then closes them: a refresh then marks the queries it names
 * and reads none of them again. */
async function readAll() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <Pages />
      </QueryClientProvider>,
    ),
  )
  for (let round = 0; round < 50 && readsIn().flat().length < Object.keys(READS).length; round += 1) {
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)))
  }
  await act(async () => root.unmount())
}

/** The reads `refresh` invalidates, when everything was just read. */
function refreshed(refresh: (client: QueryClient) => void): string[] {
  for (const query of client.getQueryCache().getAll()) client.setQueryData(query.queryKey, query.state.data)
  refresh(client)
  return client
    .getQueryCache()
    .getAll()
    .filter(query => query.state.isInvalidated)
    .flatMap(query => Object.keys(READS).filter(name => READS[name](query.state.data)))
    .sort()
}

const PAGE = ['info', 'events', 'holders', 'sticks', 'latest', 'page balances']
const ACCOUNT = ['account index', 'account positions', 'account activity']

describe("the refreshes against the hooks' own queries", () => {
  it('finds each read of the pages in exactly one query, and no query it cannot name', async () => {
    await readAll()
    expect(readsIn().every(names => names.length === 1)).toBe(true)
    expect(readsIn().flat().sort()).toEqual(Object.keys(READS).sort())
  })

  it.each<[string, (client: QueryClient) => void, string[]]>([
    ['a stick', client => refreshAfterStick(client, CHAIN, PROJECT), [...PAGE, 'position', 'tranches', 'rewards', ...ACCOUNT]],
    [
      'an unstick',
      client => refreshAfterUnstick(client, CHAIN, PROJECT, HOLDER),
      [...PAGE, 'position', 'tranches', 'rewards', 'auto-stick', ...ACCOUNT],
    ],
    ['a change of auto-stick', client => refreshAfterAutoStick(client, CHAIN, PROJECT, HOLDER), ['auto-stick', 'trusted']],
    [
      'a transfer',
      client => refreshAfterTransfer(client, CHAIN, PROJECT),
      [...PAGE.filter(read => read !== 'info'), 'position', 'tranches', 'rewards', ...ACCOUNT],
    ],
    ['a change of trust', client => refreshAfterTrust(client, CHAIN, PROJECT), ['events', 'auto-stick', 'trusted']],
    ['an airdrop', client => refreshAfterFund(client, CHAIN, PROJECT, HOLDER), ['funding', 'position', 'rewards', 'auto-stick']],
    ['a collect', client => refreshAfterCollect(client, CHAIN, PROJECT, HOLDER), ['position', 'rewards', 'auto-stick']],
    [
      'a stick of rewards',
      client => refreshAfterRewardStick(client, CHAIN, PROJECT, HOLDER),
      [...PAGE, 'position', 'tranches', 'rewards', 'auto-stick', 'trusted', ...ACCOUNT],
    ],
  ])('reads again after %s what it changed, and nothing else', async (_send, refresh, expected) => {
    await readAll()
    expect(refreshed(refresh)).toEqual([...expected].sort())
  })
})
