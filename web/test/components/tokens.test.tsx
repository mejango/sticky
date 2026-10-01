import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installQueryPersistence } from '@/lib/query-persist'
import type { HolderRow, StickyHoldersResult, StickyPosition } from '@/lib/sticky-holders'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import type { Tranche, TranchePage } from '@/lib/sticky-tranches'
import { clearViewAs, setViewAs } from '@/lib/viewAs'
import { E18, E6, stickyInfo } from '../home-fixtures'
import { memoryStorage } from '../memory-storage'
import { FakeObserver, siteClient } from '../panel-fixtures'

// The Tokens tab: what the viewer has stuck, their tranches, everyone's holdings and the stickiness bonus. Every read
// is a mock; the read model has tests of its own (sticky-holders, sticky-tranches). The clock is fake, so the 15-second
// refresh and the persister's one-second write happen only when a test moves it.

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  events: vi.fn(),
  holders: vi.fn(),
  pinned: vi.fn(),
  position: vi.fn(),
  verify: vi.fn(),
  tranches: vi.fn(),
  moves: vi.fn(),
  handle: vi.fn(),
  address: undefined as string | undefined,
}))

vi.mock('@/lib/sticky-project', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-project')>()),
  readStickyProject: mocks.project,
}))
vi.mock('@/lib/sticky-events', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-events')>()),
  stickyEvents: mocks.events,
}))
vi.mock('@/lib/sticky-holders', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-holders')>()),
  stickyHolders: mocks.holders,
  pinnedBlock: mocks.pinned,
  readStickyPosition: mocks.position,
  verifyHolderPage: mocks.verify,
}))
vi.mock('@/lib/sticky-tranches', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-tranches')>()),
  readTranchePage: mocks.tranches,
}))
vi.mock('@/lib/sticky-feed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-feed')>()),
  terminalMoves: mocks.moves,
}))
vi.mock('@/lib/sticky-handles', () => ({ resolveProjectHandle: mocks.handle }))
// The flow has tests of its own (unstick-flow.test.tsx); here only what the card gives it is held.
vi.mock('@/components/project/flows/UnstickFlow', () => ({
  UnstickFlow: (props: { chainId: number; projectId: number; info: StickyProjectInfo; onClose: () => void }) => (
    <div data-unstick-flow={`${props.chainId}:${props.projectId}:${props.info.symbol}`}>
      <button type="button" onClick={props.onClose}>
        Close flow
      </button>
    </div>
  ),
}))
vi.mock('next/navigation', () => ({ notFound: vi.fn() }))
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))
vi.mock('@/hooks/useProjectMetadata', () => ({
  useProjectMetadata: () => ({ data: undefined, isPending: false, isError: false, error: null }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ address: mocks.address, isConnected: mocks.address !== undefined, isCenterWallet: false, openSignIn: vi.fn() }),
}))
// The Stick card's transaction engine, idle: sending has tests of its own (stick-flow.test.tsx).
vi.mock('@/hooks/useSafeTx', () => ({
  useSafeTx: () => ({ phase: 'idle', busy: false, error: null, hash: null, receipt: null, send: vi.fn(), reset: vi.fn() }),
}))
vi.mock('@/lib/ens', () => ({ ensAvailable: () => false, lookupEnsName: async () => null }))
vi.mock('@/components/project/flows/TransferFlow', () => ({
  TransferFlow: ({ info, onClose }: { info: StickyProjectInfo; onClose: () => void }) => (
    <div data-flow="transfer" data-token={info.stToken} data-project={String(info.projectId)}>
      <button type="button" onClick={onClose}>
        Close transfer
      </button>
    </div>
  ),
}))

import ProjectPage from '@/app/[urn]/page'
import { BonusSplit } from '@/components/project/BonusSplit'
import { TokensTab } from '@/components/project/TokensTab'
import { useHolderTranches } from '@/hooks/useStickyTokens'
import { refreshAfterTransfer } from '@/lib/sticky-refresh'
import { ProjectRouteProvider } from '@/providers/ProjectRouteContext'

const NOW = 1_800_000_000
const DAY = 86_400
const VIEWER = `0x${'f'.repeat(40)}` as Address
const other = (digit: string) => `0x${digit.repeat(40)}` as Address
const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map(other)
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** STICKYSLOPSHOP #23 on Base: SLOPSHOP has 6 decimals, its Sticky shares always 18. 1,000 shares claim 1,010 SLOPSHOP,
 * and the bonus is 10%. */
const slopshop = (extra: Partial<StickyProjectInfo> = {}) =>
  stickyInfo(8453, 23n, {
    symbol: 'SLOPSHOP',
    name: 'Slop Shop',
    decimals: 6,
    stSymbol: 'STICKYSLOPSHOP',
    stName: 'Sticky Slop Shop',
    totalSupply: 1_000n * E18,
    backing: 1_010n * E6,
    rawBacking: 1_010n * E6,
    ...extra,
  })

/** The viewer holds half the shares, which claim half the backing, and has held them for a day; their record is two. */
const position: StickyPosition = {
  staked: 500n * E18,
  wallet: 25n * E6,
  start: NOW - DAY,
  current: DAY,
  longest: 2 * DAY,
  blockNumber: 100n,
  timestamp: NOW,
}

const holder = (address: Address, shares: bigint, current: number): HolderRow => ({
  holder: address,
  staked: shares * E18,
  start: current ? NOW - current : 0,
  current,
  longest: current,
})
/** Everyone's shares are the supply. Oldest first is C, B, D, A, E; biggest first is A, C, B, D, E. */
const everyone = [holder(A, 300n, 2 * DAY), holder(B, 250n, 5 * DAY), holder(C, 250n, 9 * DAY), holder(D, 150n, 5 * DAY), holder(E, 50n, 0)]
const result = (rows: HolderRow[]): StickyHoldersResult => ({ rows, source: 'indexed', degraded: null })

/** `count` holders A0, A1, … whose shares make up a supply of 1,000 and whose streaks are all different, oldest first. */
const crowd = (count: number) =>
  Array.from({ length: count }, (_, at) => holder(`0x${(at + 1).toString(16).padStart(40, '0')}` as Address, 20n, (count - at) * DAY))

/** The tranches of a holder with `total` of them, newest last, and the page a read of `requested` gives. */
const tranche = (at: number): Tranche => ({ amount: BigInt(at + 1) * E18, timestamp: NOW - (500 - at) * 60 })
const pageOf = (total: number, requested: number): TranchePage => {
  const page = Math.min(requested, Math.floor((total - 1) / 50))
  const end = total - page * 50
  const start = Math.max(end - 50, 0)
  return { tranches: Array.from({ length: end - start }, (_, at) => tranche(start + at)), total: BigInt(total), page, start: BigInt(start) }
}
const stuckSince = (timestamp: number) =>
  new Date(timestamp * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

let host: HTMLDivElement
let root: Root
let client: QueryClient
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  mocks.address = undefined
  mocks.project.mockReset().mockImplementation(async () => slopshop())
  mocks.events.mockReset().mockResolvedValue({ events: [], source: 'indexed', degraded: null })
  mocks.holders.mockReset().mockResolvedValue(result(everyone))
  mocks.pinned.mockReset().mockResolvedValue({ number: 100n, timestamp: NOW })
  mocks.position.mockReset().mockResolvedValue(position)
  mocks.verify.mockReset().mockImplementation(async (_chainId: number, _projectId: bigint, rows: HolderRow[]) => rows)
  mocks.tranches.mockReset().mockImplementation(async (_c: number, _p: bigint, _h: Address, requested: number) => pageOf(3, requested))
  mocks.moves.mockReset().mockResolvedValue(new Map())
  mocks.handle.mockReset().mockResolvedValue(null)
  client = newClient()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  client.clear()
  clearViewAs()
  window.history.replaceState(null, '', '/')
})

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

async function renderTab(using = client) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={using}>
        <TokensTab chainId={8453} projectId={23} />
      </QueryClientProvider>,
    ),
  )
  await settle()
}

const you = () => host.querySelector<HTMLElement>('section[aria-labelledby="tokens-you-title"]')!
const all = () => host.querySelector<HTMLElement>('section[aria-labelledby="tokens-all-title"]')!
const bonus = () => host.querySelector<HTMLElement>('section[aria-labelledby="tokens-bonus-title"]')
/** The value above a label in the You section. */
const stat = (label: string) =>
  [...you().querySelectorAll('span')].find(each => each.textContent === label)?.parentElement?.querySelector('b') ?? null
const button = (within: ParentNode, name: string) =>
  [...within.querySelectorAll('button')].find(each => each.textContent === name) as HTMLButtonElement | undefined
const click = (target: HTMLElement | undefined) => act(async () => target!.click())
const trancheRows = () => [...you().querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent))
const trancheLabel = () => [...you().querySelectorAll('p')].find(each => each.textContent?.startsWith('Tranches '))?.textContent
const boardRows = () => [...all().querySelectorAll('tbody tr')] as HTMLTableRowElement[]
const cells = (row: Element) => [...row.querySelectorAll('td')].map(cell => cell.textContent)
const accounts = () => boardRows().map(row => cells(row)[1])
const boardLabel = () => [...all().querySelectorAll('span')].find(each => /holders$/.test(each.textContent ?? ''))?.textContent
const pressed = () => [...all().querySelectorAll('button[aria-pressed="true"]')].map(each => each.textContent)
const slices = () => [...all().querySelectorAll('svg circle[role="img"]')]
const centre = () => [...all().querySelectorAll('svg g text')].map(each => each.textContent)

describe('You', () => {
  it('shows Stuck as the backing the viewer\'s shares claim, in the underlying token, with the Sticky shares in its title, then Active oldest and Record', async () => {
    mocks.address = VIEWER
    await renderTab()
    expect(stat('Stuck')?.textContent).toBe('505 SLOPSHOP')
    expect(stat('Stuck')?.getAttribute('title')).toBe('500 STICKYSLOPSHOP')
    expect(stat('Active oldest')?.textContent).toBe('1d 0h')
    expect(stat('Record')?.textContent).toBe('2d 0h')
    expect([...you().querySelectorAll('b')].map(each => each.nextElementSibling?.textContent)).toEqual([
      'Stuck',
      'Active oldest',
      'Record',
    ])
    expect(mocks.position).toHaveBeenCalledWith(8453, expect.objectContaining({ projectId: 23n }), VIEWER, expect.anything())
  })

  it('takes Stuck from the backing, never from the Sticky supply: one share of five claims a fifth of 7.5', async () => {
    mocks.address = VIEWER
    mocks.project.mockResolvedValue(slopshop({ totalSupply: 5n * E18, backing: 7_500_000n, rawBacking: 9_000_000n }))
    mocks.position.mockResolvedValue({ ...position, staked: E18 })
    await renderTab()
    expect(stat('Stuck')?.textContent).toBe('1.5 SLOPSHOP')
    expect(stat('Stuck')?.getAttribute('title')).toBe('1 STICKYSLOPSHOP')
  })

  it('shows zero in each stat\'s unit when nobody is signed in, and reads nothing for a viewer', async () => {
    await renderTab()
    expect(stat('Stuck')?.textContent).toBe('0 SLOPSHOP')
    expect(stat('Active oldest')?.textContent).toBe('0d')
    expect(stat('Record')?.textContent).toBe('0d')
    expect(trancheRows()).toEqual([])
    expect(you().textContent).toContain('No active tranches')
    expect(mocks.position).not.toHaveBeenCalled()
    expect(mocks.tranches).not.toHaveBeenCalled()
  })

  it('draws placeholders while the project and the stick are read', async () => {
    mocks.address = VIEWER
    mocks.project.mockReturnValue(new Promise(() => {}))
    await renderTab()
    for (const label of ['Stuck', 'Active oldest', 'Record']) {
      expect(stat(label)?.querySelector('.skeleton-shimmer')).not.toBeNull()
      expect(stat(label)?.textContent).toBe('')
    }
    expect(you().querySelector('.skeleton-shimmer')).not.toBeNull()
  })

  it('shows – and says so when the stick cannot be read, never zero, and reads it again on Try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.address = VIEWER
    const failure = new Error('429')
    mocks.position.mockRejectedValueOnce(failure)
    await renderTab()
    expect(stat('Stuck')?.textContent).toBe('–')
    expect(stat('Record')?.textContent).toBe('–')
    const alert = [...you().querySelectorAll('[role="alert"]')].find(each => each.textContent?.includes('Could not read your stick'))!
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stick'), { chainId: 8453, projectId: 23 }, failure)
    await click(button(alert, 'Try again'))
    await settle()
    expect(stat('Stuck')?.textContent).toBe('505 SLOPSHOP')
    expect(you().querySelector('[role="alert"]')).toBeNull()
  })

  it('reads the stick of the account in View as, not the connected wallet\'s', async () => {
    mocks.address = VIEWER
    setViewAs(A)
    await renderTab()
    expect(mocks.position).toHaveBeenCalledWith(8453, expect.anything(), expect.stringMatching(new RegExp(A, 'i')), expect.anything())
    expect(mocks.tranches).toHaveBeenCalledWith(8453, 23n, expect.stringMatching(new RegExp(A, 'i')), 0, 100n, expect.anything())
  })

  it('reads the stick again every 15 seconds and the tranches at each block it is read at, and neither while the browser tab is hidden', async () => {
    mocks.address = VIEWER
    let block = 100n
    mocks.position.mockImplementation(async () => ({ ...position, blockNumber: (block += 1n) }))
    await renderTab()
    expect(mocks.position).toHaveBeenCalledTimes(1)
    expect(mocks.tranches).toHaveBeenCalledTimes(1)
    expect(mocks.tranches).toHaveBeenLastCalledWith(8453, 23n, VIEWER, 0, 101n, expect.anything())

    await settle(15_000)
    expect(mocks.position).toHaveBeenCalledTimes(2)
    expect(mocks.tranches).toHaveBeenCalledTimes(2)
    expect(mocks.tranches).toHaveBeenLastCalledWith(8453, 23n, VIEWER, 0, 102n, expect.anything())

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await settle(45_000)
    expect(mocks.position).toHaveBeenCalledTimes(2)
    expect(mocks.tranches).toHaveBeenCalledTimes(2)

    hidden.mockReturnValue(false)
    state.mockReturnValue('visible')
    await settle(15_000)
    expect(mocks.position).toHaveBeenCalledTimes(3)
    expect(mocks.tranches).toHaveBeenCalledTimes(3)
  })

  it('reads the stick again as soon as the tab is shown again, and the tranches at the block that read gives', async () => {
    mocks.address = VIEWER
    let block = 100n
    mocks.position.mockImplementation(async () => ({ ...position, blockNumber: (block += 1n) }))
    // Providers' defaults refetch nothing on focus; the stick is read again anyway, and the tranches follow it.
    const site = siteClient()
    await renderTab(site)
    expect(mocks.tranches).toHaveBeenCalledTimes(1)

    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    await settle()
    expect(mocks.tranches).toHaveBeenCalledTimes(1)

    state.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    await settle()
    expect(mocks.position).toHaveBeenCalledTimes(2)
    expect(mocks.tranches).toHaveBeenCalledTimes(2)
    expect(mocks.tranches).toHaveBeenLastCalledWith(8453, 23n, VIEWER, 0, 102n, expect.anything())
    site.clear()
  })

  it('shows a refreshed stick when the read lands, and keeps the last one, and tells the console, when a refresh fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.address = VIEWER
    await renderTab()
    mocks.position.mockResolvedValueOnce({ ...position, staked: 700n * E18, current: 2 * DAY, longest: 3 * DAY })
    await settle(15_000)
    expect(stat('Stuck')?.textContent).toBe('707 SLOPSHOP')
    expect(stat('Active oldest')?.textContent).toBe('2d 0h')

    const failure = new Error('429')
    mocks.position.mockRejectedValue(failure)
    await settle(15_000)
    expect(stat('Stuck')?.textContent).toBe('707 SLOPSHOP')
    expect(you().querySelector('[role="alert"]')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stick'), { chainId: 8453, projectId: 23 }, failure)
  })

  it('keeps nothing of an account in the browser: not its stick, not its tranches', async () => {
    const storage = memoryStorage()
    mocks.address = VIEWER
    const stop = installQueryPersistence(client, storage)
    await renderTab()
    await settle(1_000)
    stop()
    const kept = storage.getItem('sticky:query-cache:v1')!
    expect(kept).toContain('sticky-project')
    expect(kept).not.toContain('sticky-position')
    expect(kept).not.toContain('sticky-tranches')
    expect(kept.toLowerCase()).not.toContain(VIEWER.toLowerCase())
  })

  it('opens the unstick flow for the project once this visit has read it, and closes it again', async () => {
    await renderTab()
    const unstick = button(you(), 'Unstick SLOPSHOP')!
    expect(unstick.disabled).toBe(false)
    expect(host.querySelector('[data-unstick-flow]')).toBeNull()

    await click(unstick)
    expect(host.querySelector('[data-unstick-flow]')!.getAttribute('data-unstick-flow')).toBe('8453:23:SLOPSHOP')
    await click(button(host, 'Close flow'))
    expect(host.querySelector('[data-unstick-flow]')).toBeNull()
  })

  it('opens the transfer flow for the project\'s Sticky token, and shows the tab again when it closes', async () => {
    await renderTab()
    const transfer = button(you(), 'Transfer')!
    expect(transfer.disabled).toBe(false)
    expect(host.querySelector('[data-flow="transfer"]')).toBeNull()

    await click(transfer)
    const flow = host.querySelector('[data-flow="transfer"]')!
    expect(flow.getAttribute('data-token')).toBe(`0x${'5'.repeat(40)}`)
    expect(flow.getAttribute('data-project')).toBe('23')
    expect(stat('Stuck')).not.toBeNull()

    await click(button(flow, 'Close transfer'))
    expect(host.querySelector('[data-flow="transfer"]')).toBeNull()
    expect(button(you(), 'Transfer')).toBeDefined()
  })

  it('reads again, after a transfer, what it changed: the stick, the tranches, the holders and their history, and not the project', async () => {
    mocks.address = VIEWER
    await renderTab()
    const reads = [mocks.position, mocks.tranches, mocks.holders, mocks.verify, mocks.events]
    const before = reads.map(read => read.mock.calls.length)
    const project = mocks.project.mock.calls.length

    await act(async () => refreshAfterTransfer(client, 8453, 23))
    await settle()
    reads.forEach((read, at) => expect(read.mock.calls.length, String(read.getMockName())).toBeGreaterThan(before[at]))
    expect(mocks.project.mock.calls.length).toBe(project)
  })

  it('opens the transfer flow for a signed-out visitor too: the flow asks them to sign in', async () => {
    mocks.address = undefined
    await renderTab()
    await click(button(you(), 'Transfer'))
    expect(host.querySelector('[data-flow="transfer"]')).not.toBeNull()
  })

  it.each([
    [true, false],
    [false, true],
  ])('shows Transfer only when the token is not soulbound: soulbound %s, shown %s', async (soulbound, shown) => {
    mocks.project.mockResolvedValue(slopshop({ soulbound }))
    await renderTab()
    expect(button(you(), 'Unstick SLOPSHOP')).toBeDefined()
    expect(button(you(), 'Transfer') !== undefined).toBe(shown)
  })

  it('shows Transfer only once the project says the token is not soulbound, and keeps Unstick closed until it does', async () => {
    mocks.project.mockReturnValue(new Promise(() => {}))
    await renderTab()
    expect(button(you(), 'Unstick')!.disabled).toBe(true)
    expect(button(you(), 'Transfer')).toBeUndefined()
  })

  it('offers to read the project again when it cannot be read and nothing is kept of it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.project.mockRejectedValueOnce(new Error('429'))
    await renderTab()
    const alert = host.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Could not read this Sticky token.')
    expect(host.querySelector('section')).toBeNull()
    await click(button(alert, 'Try again'))
    await settle()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(stat('Stuck')?.textContent).toBe('0 SLOPSHOP')
  })
})

describe('the tranche table', () => {
  it('lists each tranche\'s amount in Sticky shares, when it was stuck and how old it is at the pinned block, oldest first', async () => {
    mocks.address = VIEWER
    await renderTab()
    expect([...you().querySelectorAll('th')].map(each => each.textContent)).toEqual([
      'AMOUNT (STICKYSLOPSHOP)',
      'STUCK SINCE',
      'TRANCHE AGE',
    ])
    expect(trancheRows()).toEqual([
      ['1', stuckSince(tranche(0).timestamp), '8h 20m'],
      ['2', stuckSince(tranche(1).timestamp), '8h 19m'],
      ['3', stuckSince(tranche(2).timestamp), '8h 18m'],
    ])
    // The pagination is for lists that need it.
    expect(trancheLabel()).toBeUndefined()
    expect(button(you(), 'Older')).toBeUndefined()
  })

  it('reads a page at the block of the stick beside it, and measures the ages at that block\'s time', async () => {
    mocks.address = VIEWER
    mocks.position.mockResolvedValue({ ...position, blockNumber: 77n, timestamp: NOW + 3 * DAY })
    // The leaderboard is pinned at a block of its own, which the tranches do not use.
    mocks.pinned.mockResolvedValue({ number: 55n, timestamp: NOW })
    await renderTab()
    expect(mocks.tranches).toHaveBeenCalledWith(8453, 23n, VIEWER, 0, 77n, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(mocks.tranches.mock.calls.every(call => call[4] === 77n)).toBe(true)
    expect(trancheRows()[0][2]).toBe('3d 8h')
  })

  it('reads nothing of the tranches until the project has been read, and then at the block of the stick', async () => {
    mocks.address = VIEWER
    const read = Promise.withResolvers<StickyProjectInfo>()
    mocks.project.mockReturnValue(read.promise)
    await renderTab()
    expect(mocks.position).not.toHaveBeenCalled()
    expect(mocks.tranches).not.toHaveBeenCalled()
    expect(you().querySelector('[aria-busy="true"]')).not.toBeNull()

    await act(async () => read.resolve(slopshop()))
    await settle()
    expect(mocks.position).toHaveBeenCalledTimes(1)
    expect(mocks.tranches).toHaveBeenCalledTimes(1)
    expect(mocks.tranches).toHaveBeenCalledWith(8453, 23n, VIEWER, 0, 100n, expect.anything())
  })

  it('waits for the stick, which the card above says it could not read, and shows no table skeleton for it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.address = VIEWER
    mocks.position.mockRejectedValueOnce(new Error('429'))
    await renderTab()
    expect(mocks.tranches).not.toHaveBeenCalled()
    expect(you().querySelector('[aria-busy="true"]')).toBeNull()
    expect(you().textContent).not.toContain('No active tranches')
    expect(trancheRows()).toEqual([])

    const alert = [...you().querySelectorAll('[role="alert"]')].find(each => each.textContent?.includes('Could not read your stick'))!
    await click(button(alert, 'Try again'))
    await settle()
    expect(mocks.tranches).toHaveBeenCalledTimes(1)
    expect(trancheRows()).toHaveLength(3)
  })

  it('says there are no active tranches for a holder without any', async () => {
    mocks.address = VIEWER
    mocks.tranches.mockResolvedValue({ tranches: [], total: 0n, page: 0, start: 0n })
    await renderTab()
    expect(trancheRows()).toEqual([])
    expect(you().textContent).toContain('No active tranches')
  })

  it('shows 50 rows a page, newest first by page, and pages back with Older and forward with Newer', async () => {
    mocks.address = VIEWER
    mocks.tranches.mockImplementation(async (_c: number, _p: bigint, _h: Address, requested: number) => pageOf(120, requested))
    await renderTab()
    expect(trancheRows()).toHaveLength(50)
    expect(trancheLabel()).toBe('Tranches 71–120 of 120')
    expect(trancheRows()[0][0]).toBe('71')
    expect(trancheRows()[49][0]).toBe('120')
    expect(button(you(), 'Newer')!.disabled).toBe(true)
    expect(button(you(), 'Older')!.disabled).toBe(false)

    await click(button(you(), 'Older'))
    await settle()
    expect(mocks.tranches).toHaveBeenLastCalledWith(8453, 23n, VIEWER, 1, 100n, expect.anything())
    expect(trancheLabel()).toBe('Tranches 21–70 of 120')
    expect(trancheRows()).toHaveLength(50)
    expect(button(you(), 'Newer')!.disabled).toBe(false)

    await click(button(you(), 'Older'))
    await settle()
    expect(trancheLabel()).toBe('Tranches 1–20 of 120')
    expect(trancheRows()).toHaveLength(20)
    expect(button(you(), 'Older')!.disabled).toBe(true)

    await click(button(you(), 'Newer'))
    await settle()
    expect(mocks.tranches).toHaveBeenLastCalledWith(8453, 23n, VIEWER, 1, 100n, expect.anything())
    expect(trancheLabel()).toBe('Tranches 21–70 of 120')
  })

  it('keeps the page it shows while the next is read, and does not skip a page when Older is pressed twice', async () => {
    mocks.address = VIEWER
    mocks.tranches.mockImplementation(async (_c: number, _p: bigint, _h: Address, requested: number) => pageOf(120, requested))
    await renderTab()
    const next = Promise.withResolvers<TranchePage>()
    mocks.tranches.mockReturnValueOnce(next.promise)
    await click(button(you(), 'Older'))
    expect(trancheLabel()).toBe('Tranches 71–120 of 120')
    expect(you().querySelector('.skeleton-shimmer')).toBeNull()
    await click(button(you(), 'Older'))
    expect(mocks.tranches.mock.calls.map(call => call[3])).toEqual([0, 1])
    await act(async () => next.resolve(pageOf(120, 1)))
    await settle()
    expect(trancheLabel()).toBe('Tranches 21–70 of 120')
  })

  it('reads one bounded page under a million dust tranches', async () => {
    mocks.address = VIEWER
    mocks.tranches.mockResolvedValue({
      tranches: Array.from({ length: 50 }, () => ({ amount: 1n, timestamp: NOW - 60 })),
      total: 1_000_000n,
      page: 0,
      start: 999_950n,
    })
    await renderTab()
    expect(mocks.tranches).toHaveBeenCalledTimes(1)
    expect(trancheRows()).toHaveLength(50)
    expect(trancheLabel()).toBe('Tranches 999,951–1,000,000 of 1,000,000')
    expect(button(you(), 'Newer')!.disabled).toBe(true)
    expect(button(you(), 'Older')!.disabled).toBe(false)
  })

  it('asks for the page a read clamped to from then on, when burns shortened the list', async () => {
    mocks.address = VIEWER
    let block = 100n
    mocks.position.mockImplementation(async () => ({ ...position, blockNumber: (block += 1n) }))
    mocks.tranches.mockImplementation(async (_c: number, _p: bigint, _h: Address, requested: number) => pageOf(120, requested))
    await renderTab()
    await click(button(you(), 'Older'))
    await settle()
    await click(button(you(), 'Older'))
    await settle()
    expect(trancheLabel()).toBe('Tranches 1–20 of 120')

    // The holder unsticks most of them: 30 remain, and the page asked for is beyond the last.
    mocks.tranches.mockImplementation(async (_c: number, _p: bigint, _h: Address, requested: number) => pageOf(30, requested))
    await settle(15_000)
    expect(trancheRows()).toHaveLength(30)
    expect(trancheLabel()).toBeUndefined()
    // A later read asks for the first page, not the one that was asked for before.
    mocks.tranches.mockImplementation(async (_c: number, _p: bigint, _h: Address, requested: number) => pageOf(120, requested))
    await settle(15_000)
    expect(mocks.tranches.mock.calls.at(-1)?.[3]).toBe(0)
    expect(trancheLabel()).toBe('Tranches 71–120 of 120')
  })

  it('says the tranches could not be read, and tells the console why, instead of showing none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.address = VIEWER
    const failure = new Error('429')
    mocks.tranches.mockRejectedValueOnce(failure)
    await renderTab()
    const alert = [...you().querySelectorAll('[role="alert"]')].find(each => each.textContent?.includes('Could not read your tranches'))!
    expect(alert).toBeDefined()
    expect(you().textContent).not.toContain('No active tranches')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('tranches'), { chainId: 8453, projectId: 23 }, failure)
    await click(button(alert, 'Try again'))
    await settle()
    expect(trancheRows()).toHaveLength(3)
  })

  it('shows another account\'s tranches only once they are read, never the last account\'s', async () => {
    mocks.address = VIEWER
    await renderTab()
    expect(trancheRows()).toHaveLength(3)

    const next = Promise.withResolvers<TranchePage>()
    mocks.tranches.mockReturnValue(next.promise)
    await act(async () => setViewAs(A))
    await settle()
    expect(trancheRows()).toEqual([])
    expect(you().querySelector('.skeleton-shimmer')).not.toBeNull()
    await act(async () => next.resolve(pageOf(1, 0)))
    await settle()
    expect(trancheRows().map(row => row[0])).toEqual(['1'])
  })
})

describe('the tranche read', () => {
  /** What a read of `holder`'s first page has, as a component that uses the hook sees it. */
  function Probe({ holder }: { holder: Address }) {
    const read = useHolderTranches(8453, 23, holder, 0, position)
    return <output>{read.data ? String(read.data.total) : 'none'}</output>
  }
  const output = () => host.querySelector('output')!.textContent
  const show = async (holder: Address) => {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe holder={holder} />
        </QueryClientProvider>,
      ),
    )
    await settle()
  }

  it('never gives one account\'s page in place of another\'s while that is read, though the same account\'s stays', async () => {
    mocks.tranches.mockImplementation(async (_c: number, _p: bigint, holder: Address) => pageOf(holder === VIEWER ? 7 : 3, 0))
    await show(VIEWER)
    expect(output()).toBe('7')

    const next = Promise.withResolvers<TranchePage>()
    mocks.tranches.mockReturnValue(next.promise)
    await show(A)
    expect(output()).toBe('none')
    await act(async () => next.resolve(pageOf(3, 0)))
    await settle()
    expect(output()).toBe('3')
  })

  it('reads nothing without a holder', async () => {
    function Nobody() {
      const read = useHolderTranches(8453, 23, null, 0, position)
      return <output>{read.fetchStatus}</output>
    }
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Nobody />
        </QueryClientProvider>,
      ),
    )
    await settle()
    expect(output()).toBe('idle')
    expect(mocks.tranches).not.toHaveBeenCalled()
    expect(mocks.pinned).not.toHaveBeenCalled()
  })
})

describe('a panel that is hidden', () => {
  beforeEach(() => {
    FakeObserver.all = []
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    let block = 100n
    mocks.position.mockImplementation(async () => ({ ...position, blockNumber: (block += 1n) }))
  })

  it('is watched by its own element, which the tabs hide and show, with a margin around the screen', async () => {
    mocks.address = VIEWER
    await renderTab()
    expect(FakeObserver.all).toHaveLength(1)
    expect(FakeObserver.all[0].options).toEqual({ rootMargin: '600px 0px' })
    expect(FakeObserver.all[0].element).toBe(host.firstElementChild)
    expect(host.firstElementChild?.contains(you())).toBe(true)
  })

  it('reads no more tranches, and shows the ones it had, and reads the page of the stick\'s latest block when it is shown', async () => {
    mocks.address = VIEWER
    await renderTab()
    expect(mocks.tranches).toHaveBeenCalledTimes(1)

    await act(async () => FakeObserver.tell(false))
    await settle(60_000)
    expect(mocks.tranches).toHaveBeenCalledTimes(1)
    expect(trancheRows()).toHaveLength(3)
    expect(you().querySelector('[aria-busy="true"]')).toBeNull()
    // The stick is the page's: the Stick card beside every tab reads it, so it is read on.
    expect(mocks.position).toHaveBeenCalledTimes(5)

    await act(async () => FakeObserver.tell(true))
    await settle()
    expect(mocks.tranches).toHaveBeenCalledTimes(2)
    expect(mocks.tranches).toHaveBeenLastCalledWith(8453, 23n, VIEWER, 0, 105n, expect.anything())
    await settle(15_000)
    expect(mocks.tranches).toHaveBeenCalledTimes(3)
    expect(mocks.tranches).toHaveBeenLastCalledWith(8453, 23n, VIEWER, 0, 106n, expect.anything())
  })

  it('is not read when the browser tab is shown again while it is hidden, and is when it is shown', async () => {
    mocks.address = VIEWER
    const site = siteClient()
    await renderTab(site)
    await act(async () => FakeObserver.tell(false))

    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    state.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    await settle()
    expect(mocks.position).toHaveBeenCalledTimes(2)
    expect(mocks.tranches).toHaveBeenCalledTimes(1)

    await act(async () => FakeObserver.tell(true))
    await settle()
    expect(mocks.tranches).toHaveBeenCalledTimes(2)
    expect(mocks.tranches).toHaveBeenLastCalledWith(8453, 23n, VIEWER, 0, 102n, expect.anything())
    site.clear()
  })

  it('does not read the holders again when it is shown again: they are the page\'s, read once', async () => {
    await renderTab()
    await act(async () => FakeObserver.tell(false))
    await settle(60_000)
    await act(async () => FakeObserver.tell(true))
    await settle(60_000)
    expect(mocks.holders).toHaveBeenCalledTimes(1)
    expect(boardRows()).toHaveLength(5)
  })
})

describe('the leaderboard', () => {
  it('ranks by Oldest first: the longest active streak, then the most shares', async () => {
    await renderTab()
    expect(pressed()).toEqual(['Oldest'])
    expect(accounts()).toEqual([C, B, D, A, E].map(short))
    expect(boardRows().map(row => cells(row)[0])).toEqual(['1', '2', '3', '4', '5'])
  })

  it('ranks by Biggest when asked: the most shares, then the longest streak', async () => {
    await renderTab()
    await click(button(all(), 'Biggest'))
    expect(pressed()).toEqual(['Biggest'])
    expect(accounts()).toEqual([A, C, B, D, E].map(short))
    await click(button(all(), 'Oldest'))
    expect(pressed()).toEqual(['Oldest'])
    expect(accounts()).toEqual([C, B, D, A, E].map(short))
  })

  it('shows each holder\'s share of the supply, what they have stuck in the underlying token, and how long', async () => {
    await renderTab()
    expect([...all().querySelectorAll('th')].map(each => each.textContent)).toEqual(['#', 'ACCOUNT', '%', 'STUCK', 'AGE'])
    // C, B, D, A, E: shares over the supply, their shares' claim on the backing, and their streaks.
    expect(boardRows().map(row => cells(row).slice(2))).toEqual([
      ['25.0%', '252.5 SLOPSHOP', '9d 0h'],
      ['25.0%', '252.5 SLOPSHOP', '5d 0h'],
      ['15.0%', '151.5 SLOPSHOP', '5d 0h'],
      ['30.0%', '303 SLOPSHOP', '2d 0h'],
      ['5.0%', '50.5 SLOPSHOP', '0d'],
    ])
    // The Sticky shares are in the title, not in the cell.
    expect(boardRows()[0].querySelectorAll('td')[3].getAttribute('title')).toBe('250 STICKYSLOPSHOP')
  })

  it('takes the Stuck column from the backing, never the Sticky supply: 50 of 100 shares claim 101', async () => {
    mocks.project.mockResolvedValue(slopshop({ totalSupply: 100n * E18, backing: 202n * E6, rawBacking: 202n * E6 }))
    mocks.holders.mockResolvedValue(result([holder(A, 50n, DAY), holder(B, 50n, 0)]))
    await renderTab()
    expect(boardRows().map(row => cells(row)[3])).toEqual(['101 SLOPSHOP', '101 SLOPSHOP'])
  })

  it('shows nothing claimed, and never NaN, for holders while the supply reads zero', async () => {
    mocks.project.mockResolvedValue(slopshop({ totalSupply: 0n, backing: 0n, rawBacking: 0n }))
    mocks.holders.mockResolvedValue(result([holder(A, 50n, DAY)]))
    await renderTab()
    expect(cells(boardRows()[0]).slice(2, 4)).toEqual(['0.0%', '0 SLOPSHOP'])
    expect(all().textContent).toContain('0.00% of all STICKYSLOPSHOP')
  })

  it('marks the viewer\'s own row with (you)', async () => {
    mocks.address = VIEWER
    mocks.holders.mockResolvedValue(result([...everyone.slice(0, 4), holder(VIEWER, 50n, 0)]))
    await renderTab()
    const yours = boardRows().filter(row => cells(row)[1]?.includes('(you)'))
    expect(yours).toHaveLength(1)
    expect(cells(yours[0])[1]).toBe(`${short(VIEWER)} (you)`)
  })

  it('shows 20 holders a page, numbers them across pages, and goes back to the first page when the order changes', async () => {
    mocks.holders.mockResolvedValue(result(crowd(45)))
    mocks.project.mockResolvedValue(slopshop({ totalSupply: 900n * E18 }))
    await renderTab()
    expect(boardRows()).toHaveLength(20)
    expect(boardLabel()).toBe('1–20 of 45 holders')
    expect(button(all(), 'Previous')!.disabled).toBe(true)

    await click(button(all(), 'Next'))
    expect(boardRows()).toHaveLength(20)
    expect(boardLabel()).toBe('21–40 of 45 holders')
    expect(cells(boardRows()[0])[0]).toBe('21')

    await click(button(all(), 'Next'))
    expect(boardRows()).toHaveLength(5)
    expect(boardLabel()).toBe('41–45 of 45 holders')
    expect(cells(boardRows()[4])[0]).toBe('45')
    expect(button(all(), 'Next')!.disabled).toBe(true)

    await click(button(all(), 'Previous'))
    expect(boardLabel()).toBe('21–40 of 45 holders')
    await click(button(all(), 'Biggest'))
    expect(boardLabel()).toBe('1–20 of 45 holders')
  })

  it('has no pages for 20 holders or fewer', async () => {
    mocks.holders.mockResolvedValue(result(crowd(20)))
    await renderTab()
    expect(boardRows()).toHaveLength(20)
    expect(boardLabel()).toBeUndefined()
    expect(button(all(), 'Next')).toBeUndefined()
  })

  it('reads the visible page again from the hook at a pinned block, one page at a time', async () => {
    mocks.holders.mockResolvedValue(result(crowd(45)))
    await renderTab()
    expect(mocks.verify).toHaveBeenCalledTimes(1)
    const [chainId, projectId, rows, block, options] = mocks.verify.mock.calls[0]
    expect([chainId, projectId, block]).toEqual([8453, 23n, 100n])
    expect((rows as HolderRow[]).map(row => row.holder)).toEqual(crowd(45).slice(0, 20).map(row => row.holder))
    expect(options).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }))

    await click(button(all(), 'Next'))
    await settle()
    expect(mocks.verify).toHaveBeenCalledTimes(2)
    expect((mocks.verify.mock.calls[1][2] as HolderRow[]).map(row => row.holder)).toEqual(
      crowd(45).slice(20, 40).map(row => row.holder),
    )
  })

  it('replaces a balance the hook says otherwise, in its share and its Stuck amount', async () => {
    mocks.verify.mockImplementation(async (_c: number, _p: bigint, rows: HolderRow[]) =>
      rows.map(row => (row.holder === B ? { ...row, staked: 100n * E18 } : row)),
    )
    await renderTab()
    const row = boardRows().find(each => cells(each)[1] === short(B))!
    expect(cells(row).slice(2, 4)).toEqual(['10.0%', '101 SLOPSHOP'])
    expect(cells(boardRows().find(each => cells(each)[1] === short(A))!).slice(2, 4)).toEqual(['30.0%', '303 SLOPSHOP'])
    // Its place in the order is the one the index gave: only the balance is corrected.
    expect(accounts()).toEqual([C, B, D, A, E].map(short))
  })

  it('keeps the balances the index gave, and tells the console, when the hook cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('429')
    mocks.verify.mockRejectedValue(failure)
    await renderTab()
    expect(boardRows()).toHaveLength(5)
    expect(cells(boardRows()[0]).slice(2, 4)).toEqual(['25.0%', '252.5 SLOPSHOP'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('balances'), { chainId: 8453, projectId: 23 }, failure)
  })

  it('draws placeholders, not an empty list, while the holders are read', async () => {
    mocks.holders.mockReturnValue(new Promise(() => {}))
    await renderTab()
    expect(all().querySelector('.skeleton-shimmer')).not.toBeNull()
    expect(all().querySelector('table')).toBeNull()
    expect(all().textContent).not.toContain('Nobody')
  })

  it('says the holders could not be read, never that nobody is stuck, and reads them again on Try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('429')
    mocks.holders.mockRejectedValueOnce(failure)
    await renderTab()
    const alert = all().querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Could not read the holders')
    expect(all().textContent).not.toContain('Nobody')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('holders'), { chainId: 8453, projectId: 23 }, failure)
    await click(button(alert, 'Try again'))
    await settle()
    expect(boardRows()).toHaveLength(5)
  })

  it('says nobody is stuck when the holders were read and are none, and reads no page', async () => {
    mocks.holders.mockResolvedValue(result([]))
    await renderTab()
    expect(all().textContent).toContain('Nobody is stuck yet.')
    expect(all().querySelector('table')).toBeNull()
    expect(mocks.verify).not.toHaveBeenCalled()
  })

  it('names each holder by its ENS name when it has one, and by its short address otherwise', async () => {
    await renderTab()
    const first = boardRows()[0].querySelector('td:nth-child(2) span')!
    expect(first.getAttribute('title')).toBe(C)
    expect(first.textContent).toBe(short(C))
  })
})

describe('the holder pie', () => {
  it('draws a slice for each holder, by shares, labelled with who, how much and what share', async () => {
    await renderTab()
    expect(slices().map(each => each.getAttribute('aria-label'))).toEqual([
      `${short(A)}: 300 STICKYSLOPSHOP, 30.00%`,
      `${short(B)}: 250 STICKYSLOPSHOP, 25.00%`,
      `${short(C)}: 250 STICKYSLOPSHOP, 25.00%`,
      `${short(D)}: 150 STICKYSLOPSHOP, 15.00%`,
      `${short(E)}: 50 STICKYSLOPSHOP, 5.00%`,
    ])
    expect(all().textContent).toContain('1,000 STICKYSLOPSHOP')
    expect(all().textContent).toContain('100.00% of all STICKYSLOPSHOP')
  })

  it('marks the viewer\'s slice', async () => {
    mocks.address = VIEWER
    mocks.holders.mockResolvedValue(result([holder(VIEWER, 1000n, DAY)]))
    await renderTab()
    expect(slices()[0].getAttribute('aria-label')).toBe(`${short(VIEWER)}, you: 1,000 STICKYSLOPSHOP, 100.00%`)
  })

  it('shows the biggest holder in the middle at first, then whichever slice is pointed at, and clears when the pointer leaves', async () => {
    await renderTab()
    expect(centre()).toEqual([short(A), '300 STICKYSLOPSHOP', '30.00%'])
    await act(async () => void slices()[3].dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
    // React's pointer enter is made from pointer over, which jsdom raises from the target.
    expect(centre()).toEqual([short(D), '150 STICKYSLOPSHOP', '15.00%'])
    await act(async () => void slices()[3].dispatchEvent(new FocusEvent('focusout', { bubbles: true })))
    expect(centre()).toEqual(['', '', ''])
  })

  it('fits each line in the middle of the pie: a font that shrinks, and past the smallest, an ellipsis', async () => {
    await renderTab()
    const sizes = () => [...all().querySelectorAll('svg g text')].map(each => each.getAttribute('font-size'))
    // A line that fits keeps its size; the balance line is a little too wide for 8 and settles at 7.5.
    expect(sizes()).toEqual(['7.5', '7.5', '9'])

    await act(async () => root.unmount())
    root = createRoot(host)
    client.clear()
    mocks.project.mockResolvedValue(slopshop({ stSymbol: 'STICKYSLOPSHOPSLOPSHOP' }))
    await renderTab()
    const line = centre()[1]!
    expect(line.endsWith('…')).toBe(true)
    expect(line.startsWith('300 STICKYSLOPSHOP')).toBe(true)
    expect(sizes()[1]).toBe('6')
  })

  it('shows a slice when it is tapped, and clears when the pointer leaves the pie', async () => {
    await renderTab()
    await act(async () => void slices()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(centre()).toEqual([short(B), '250 STICKYSLOPSHOP', '25.00%'])
    const pie = all().querySelector('svg')!
    await act(async () => void pie.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })))
    expect(centre()).toEqual(['', '', ''])
  })

  it('highlights the leaderboard row of the slice that is showing', async () => {
    await renderTab()
    const active = () => boardRows().filter(row => row.getAttribute('data-active') === 'true').map(row => cells(row)[1])
    expect(active()).toEqual([short(A)])
    await act(async () => void slices()[2].dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    expect(active()).toEqual([short(C)])
  })

  it('has no pie for nobody', async () => {
    mocks.holders.mockResolvedValue(result([]))
    await renderTab()
    expect(all().querySelector('svg')).toBeNull()
  })
})

describe('the stickiness bonus', () => {
  it('shows only when the bonus is above 0', async () => {
    mocks.project.mockResolvedValue(slopshop({ cashOutTaxRate: 0n }))
    await renderTab()
    expect(bonus()).toBeNull()
    expect(host.textContent).not.toContain('Stickiness bonus')

    await act(async () => root.unmount())
    root = createRoot(host)
    client.clear()
    mocks.project.mockResolvedValue(slopshop({ cashOutTaxRate: 1_000n }))
    await renderTab()
    expect(bonus()?.querySelector('h2')?.textContent).toBe('Stickiness bonus')
  })

  it('says how much an unstick leaves behind and where 100 Sticky shares\' value goes, at what they are backed by', async () => {
    mocks.project.mockResolvedValue(slopshop({ cashOutTaxRate: 1_000n }))
    await renderTab()
    const text = bonus()!.textContent!
    // 1,000 shares claim 1,010 SLOPSHOP, so 100 are worth 101: 10.1 stays, 2.3 is the 2.5% fee, 88.6 goes to the leaver.
    expect(text).toContain('Unsticks leave up to 10% behind for holders who stay.')
    expect(text).toContain('1 STICKYSLOPSHOP is currently backed by 1.01 SLOPSHOP.')
    expect(text).toContain('Unsticking 100 STICKYSLOPSHOP, a small share of supply')
    expect(text).toContain('88.6 SLOPSHOP to the unstickers')
    expect(text).toContain('10.1 stays with stickers')
    expect(text).toContain('2.3 protocol fee')
  })

  it('leaves out what a share is backed by when it is backed by no more than one, and follows a custom bonus', async () => {
    mocks.project.mockResolvedValue(slopshop({ cashOutTaxRate: 250n, decimals: 18, totalSupply: E18, backing: E18, rawBacking: E18 }))
    await renderTab()
    const text = bonus()!.textContent!
    expect(text).toContain('Unsticks leave up to 2.5% behind for holders who stay.')
    expect(text).not.toContain('is currently backed by')
    // 100 are worth 100: 2.5 stays, 2.4 is the fee, 95.1 goes to the leaver.
    expect(text).toContain('95.1 SLOPSHOP to the unstickers')
    expect(text).toContain('2.5 stays with stickers')
    expect(text).toContain('2.4 protocol fee')
  })

  it('groups a large split by thousands, rounded', async () => {
    // A share backed by 20 SLOPSHOP: 100 are worth 2,000, of which 200 stays and 45 is the fee.
    mocks.project.mockResolvedValue(
      slopshop({ cashOutTaxRate: 1_000n, totalSupply: E18, backing: 20n * E6, rawBacking: 20n * E6 }),
    )
    await renderTab()
    const text = bonus()!.textContent!
    expect(text).toContain('1,755 SLOPSHOP to the unstickers')
    expect(text).toContain('200 stays with stickers')
    expect(text).toContain('45 protocol fee')
    expect(text).toContain('1 STICKYSLOPSHOP is currently backed by 20 SLOPSHOP.')
  })

  it('draws the split as three bars that fill the width, the leaver\'s first', () => {
    const svg = renderStatic(<BonusSplit info={slopshop({ cashOutTaxRate: 1_000n })} pending={false} />)
    const widths = [...svg!.querySelectorAll('rect')].map(bar => Number(bar.getAttribute('width')))
    expect(widths).toHaveLength(3)
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(460, 0)
    expect(widths[0]).toBeGreaterThan(widths[1])
    expect(widths[1]).toBeGreaterThan(widths[2])
  })

  it('renders token metadata as text: a symbol that is markup creates no element in the illustration', () => {
    // OLD/test/metadata-rendering.test.cjs, for a share backed by one: 100 are worth 100, and 87.75 goes to the leaver.
    const hostile = '<img src=x onerror="window.stickyXss=1">'
    const card = renderStatic(
      <BonusSplit
        info={slopshop({ cashOutTaxRate: 1_000n, decimals: 18, totalSupply: E18, backing: E18, rawBacking: E18, symbol: hostile, stSymbol: hostile })}
        pending={false}
      />,
      'section',
    )!
    expect(card.querySelector('img')).toBeNull()
    expect(card.textContent).toContain(`Unsticking 100 ${hostile}, a small share of supply`)
    expect(card.textContent).toContain(`87.8 ${hostile} to the unstickers`)
  })

  it('renders a symbol that is markup as text everywhere on the tab', async () => {
    const hostile = '<img src=x onerror="window.stickyXss=1">'
    mocks.address = VIEWER
    mocks.project.mockResolvedValue(slopshop({ cashOutTaxRate: 1_000n, symbol: hostile, stSymbol: hostile }))
    await renderTab()
    expect(host.querySelector('img')).toBeNull()
    expect(stat('Stuck')?.textContent).toBe(`505 ${hostile}`)
    expect(all().textContent).toContain(`of all ${hostile}`)
    expect(boardRows()[0].querySelectorAll('td')[3].textContent).toBe(`252.5 ${hostile}`)
    expect(bonus()!.textContent).toContain(`to the unstickers`)
  })

  it('calls the shares sticky tokens when the Sticky token has no symbol, and prices them at one while there is no supply', () => {
    const card = renderStatic(
      <BonusSplit info={slopshop({ cashOutTaxRate: 1_000n, stSymbol: '', totalSupply: 0n, backing: 0n, rawBacking: 0n })} pending={false} />,
      'section',
    )!
    expect(card.textContent).toContain('Unsticking 100 sticky tokens, a small share of supply')
    expect(card.textContent).not.toContain('is currently backed by')
    expect(card.textContent).toContain('87.8 SLOPSHOP to the unstickers')
  })

  it('renders nothing for a project with no bonus', () => {
    expect(renderStatic(<BonusSplit info={slopshop({ cashOutTaxRate: 0n })} pending={false} />, 'section')).toBeNull()
  })

  it('reads as unconfirmed, and so does Stuck, while the project is a copy the browser kept from an earlier visit', async () => {
    const storage = memoryStorage()
    mocks.address = VIEWER
    mocks.project.mockResolvedValue(slopshop({ cashOutTaxRate: 1_000n }))
    const earlier = newClient()
    const stop = installQueryPersistence(earlier, storage)
    await renderTab(earlier)
    await settle(1_000)
    stop()
    await act(async () => root.unmount())
    root = createRoot(host)

    const read = Promise.withResolvers<StickyProjectInfo>()
    mocks.project.mockReset().mockReturnValue(read.promise)
    const now = newClient()
    installQueryPersistence(now, storage)
    await renderTab(now)
    expect(bonus()?.querySelector('.revalidating')).not.toBeNull()
    expect(stat('Stuck')?.querySelector('.revalidating')).not.toBeNull()
    // Nothing is sent on the word of a copy the browser kept: no unstick, and no transfer of the Sticky token it names.
    expect(button(you(), 'Unstick SLOPSHOP')!.disabled).toBe(true)
    expect(button(you(), 'Transfer')!.disabled).toBe(true)

    await act(async () => read.resolve(slopshop({ cashOutTaxRate: 1_000n })))
    await settle()
    expect(bonus()?.querySelector('.revalidating')).toBeNull()
    expect(stat('Stuck')?.querySelector('.revalidating')).toBeNull()
    expect(button(you(), 'Unstick SLOPSHOP')!.disabled).toBe(false)
    expect(button(you(), 'Transfer')!.disabled).toBe(false)
  })
})

/** What `element` renders to, without the query client: `selector` is what to look for in it. */
function renderStatic(element: ReactNode, selector = 'svg'): Element | null {
  const target = document.createElement('div')
  const staticRoot = createRoot(target)
  act(() => staticRoot.render(element))
  const found = target.querySelector(selector)
  act(() => staticRoot.unmount())
  return found
}

describe('the project page', () => {
  it('opens the tab on #tokens with You, All and the bonus, in that order', async () => {
    mocks.address = VIEWER
    mocks.project.mockResolvedValue(slopshop({ cashOutTaxRate: 1_000n }))
    window.history.replaceState(null, '', '/base:23#tokens')
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
    const page = await ProjectPage({ params: Promise.resolve({ urn: 'base:23' }), searchParams: Promise.resolve({}) })
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ProjectRouteProvider>{page}</ProjectRouteProvider>
        </QueryClientProvider>,
      ),
    )
    await settle()

    const sections = [you(), all(), bonus()!]
    expect(sections.map(section => section.querySelector('h2')?.textContent)).toEqual(['You', 'All', 'Stickiness bonus'])
    expect(sections.every(section => section.closest('[hidden]') === null)).toBe(true)
    expect(stat('Stuck')?.textContent).toBe('505 SLOPSHOP')
    expect(boardRows()).toHaveLength(5)
  })

  it('reads the project, the viewer\'s stick and the holders once for the header, the Stick card and the tab', async () => {
    mocks.address = VIEWER
    window.history.replaceState(null, '', '/base:23#tokens')
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }))
    const page = await ProjectPage({ params: Promise.resolve({ urn: 'base:23' }), searchParams: Promise.resolve({}) })
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ProjectRouteProvider>{page}</ProjectRouteProvider>
        </QueryClientProvider>,
      ),
    )
    await settle()
    expect(mocks.project).toHaveBeenCalledTimes(1)
    expect(mocks.position).toHaveBeenCalledTimes(1)
    expect(mocks.holders).toHaveBeenCalledTimes(1)
    expect(mocks.events).toHaveBeenCalledTimes(1)

    await settle(15_000)
    expect(mocks.position).toHaveBeenCalledTimes(2)
  })
})
