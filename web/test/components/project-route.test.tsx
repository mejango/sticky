import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Address, Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installQueryPersistence } from '@/lib/query-persist'
import type { StickyEvent, StickyEventsResult } from '@/lib/sticky-events'
import { moveKey } from '@/lib/sticky-feed'
import type { HolderRow, StickyHoldersResult, StickyPosition } from '@/lib/sticky-holders'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { clearViewAs, setViewAs } from '@/lib/viewAs'
import { E18, E6, HOLDER, stickyInfo } from '../home-fixtures'
import { memoryStorage } from '../memory-storage'

// The project page: its route, its header, its Stick card and its tabs. Every read is a mock; the real read model has
// tests of its own. The clock is fake, so the persister's one-second write and the Stick card's 15-second refresh
// happen only when a test moves it.

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  events: vi.fn(),
  holders: vi.fn(),
  pinned: vi.fn(),
  position: vi.fn(),
  moves: vi.fn(),
  creation: vi.fn(),
  flows: vi.fn(),
  siblings: vi.fn(),
  rows: vi.fn(),
  handle: vi.fn(),
  notFound: vi.fn(),
  address: undefined as string | undefined,
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
}))
vi.mock('@/lib/sticky-feed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-feed')>()),
  terminalMoves: mocks.moves,
}))
// The Overview tab's reads, which have tests of their own (overview.test.tsx).
vi.mock('@/lib/sticky-backing', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-backing')>()),
  backingFlows: mocks.flows,
}))
vi.mock('@/lib/sticky-siblings', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-siblings')>()),
  launchSiblings: mocks.siblings,
  siblingRows: mocks.rows,
}))
vi.mock('@/lib/sticky-handles', () => ({ resolveProjectHandle: mocks.handle }))
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))
vi.mock('@/hooks/useProjectMetadata', () => ({
  useProjectMetadata: () => ({ data: undefined, isPending: false, isError: false, error: null }),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: mocks.address }) }))
vi.mock('@/lib/ens', () => ({ ensAvailable: () => false, lookupEnsName: async () => null }))
// The Airdrops tab's reads have tests of their own (airdrops.test.tsx). Here they answer at once, with nothing.
vi.mock('@/lib/sticky-rewards', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-rewards')>()),
  discoverFunding: async () => [],
  readRewards: async () => [],
}))
vi.mock('@/lib/sticky-autostick', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-autostick')>()),
  readAutoStick: async () => ({
    groupIds: [0n],
    status: 1,
    collectable: 0n,
    allowance: 0n,
    nextCompoundAt: 0,
    minimum: 0n,
    cooldown: 0,
    lastCompoundedAt: 0,
    enabled: false,
    projectGranter: false,
    personallyTrusted: false,
    canBeginVesting: false,
  }),
  trustedSenders: async () => [],
}))

import ProjectPage from '@/app/[urn]/page'
import { ProjectRouteProvider, useResolvedProjectRoute } from '@/providers/ProjectRouteContext'

const NOT_FOUND = 'NEXT_HTTP_ERROR_FALLBACK;404'
const NOW = 1_800_000_000
const DAY = 86_400
const VIEWER = `0x${'d'.repeat(40)}` as Address
const TX = `0x${'e1'.repeat(32)}` as Hex

/** STICKYSLOPSHOP #23 on Base: SLOPSHOP has 6 decimals, its Sticky shares always 18. 1,000 shares claim 1,010 SLOPSHOP,
 * and the launch planned Optimism and Base. */
const slopshop = (projectId = 23n, extra: Partial<StickyProjectInfo> = {}) =>
  stickyInfo(8453, projectId, {
    symbol: 'SLOPSHOP',
    name: 'Slop Shop',
    decimals: 6,
    stSymbol: projectId === 23n ? 'STICKYSLOPSHOP' : `STICKY${projectId}`,
    stName: 'Sticky Slop Shop',
    totalSupply: 1_000n * E18,
    backing: 1_010n * E6,
    rawBacking: 1_010n * E6,
    plannedChains: [10, 8453],
    ...extra,
  })

/** HOLDER stuck 1,000 shares for 1,010 SLOPSHOP three days ago. */
const stuck: StickyEvent = {
  kind: 'stick',
  chainId: 8453,
  projectId: 23n,
  holder: HOLDER,
  payer: HOLDER,
  count: 1_000n * E18,
  balance: 1_000n * E18,
  txHash: TX,
  logIndex: 1,
  blockNumber: null,
  timestamp: NOW - 3 * DAY,
}
const history: StickyEventsResult = { events: [stuck], source: 'indexed', degraded: null }
const holderRow = (start: number): HolderRow => ({ holder: HOLDER, staked: 1_000n * E18, start, current: NOW - start, longest: NOW - start })
/** Two holders, stuck for three days and for one. */
const holders: StickyHoldersResult = { rows: [holderRow(NOW - 3 * DAY), holderRow(NOW - DAY)], source: 'indexed', degraded: null }
/** The viewer holds half the shares, which claim half the backing, and 25 SLOPSHOP in their wallet. */
const position: StickyPosition = {
  staked: 500n * E18,
  wallet: 25n * E6,
  start: NOW - DAY,
  current: DAY,
  longest: 2 * DAY,
  blockNumber: 100n,
  timestamp: NOW,
}
const paid = new Map([[moveKey({ ...stuck, kind: 'stick', count: stuck.count! }), 1_010n * E6]])

function stubWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width <= Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))
}

let host: HTMLDivElement
let root: Root
let client: QueryClient
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
/** A client with Providers' defaults: fresh for 30 seconds, one more try after a failure, no refetch on focus. */
const siteClient = () =>
  new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, gcTime: 10 * 60_000, retry: 1, refetchOnWindowFocus: false } },
  })

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  stubWidth(1280)
  mocks.address = undefined
  mocks.project.mockReset().mockImplementation(async (_chainId: number, projectId: bigint) => slopshop(projectId))
  mocks.events.mockReset().mockResolvedValue(history)
  mocks.holders.mockReset().mockResolvedValue(holders)
  mocks.pinned.mockReset().mockResolvedValue({ number: 100n, timestamp: NOW })
  mocks.position.mockReset().mockResolvedValue(position)
  mocks.moves.mockReset().mockResolvedValue(paid)
  mocks.creation.mockReset().mockResolvedValue(1n)
  mocks.flows.mockReset().mockResolvedValue([])
  mocks.siblings.mockReset().mockImplementation(async (info: StickyProjectInfo) => [
    { chainId: info.chainId, projectId: info.projectId, self: true },
  ])
  // The Overview's chains are read through `readStickyProject`, whose calls these tests count.
  mocks.rows
    .mockReset()
    .mockImplementation(async (siblings: { chainId: number; projectId: bigint; self: boolean }[]) =>
      siblings.map(sibling => ({ ...sibling, info: slopshop(sibling.projectId) })),
    )
  mocks.handle.mockReset().mockResolvedValue(null)
  mocks.notFound.mockReset().mockImplementation(() => {
    throw new Error(NOT_FOUND)
  })
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
const props = (urn: string) => ({ params: Promise.resolve({ urn }), searchParams: Promise.resolve({}) })

function Route() {
  const route = useResolvedProjectRoute()
  return <output>{route ? `${route.chainId}:${route.projectId}:${route.handle}` : 'none'}</output>
}

async function renderPage(urn: string, using = client) {
  const page = await ProjectPage(props(urn))
  const tree: ReactNode = (
    <QueryClientProvider client={using}>
      <ProjectRouteProvider>
        <Route />
        {page}
      </ProjectRouteProvider>
    </QueryClientProvider>
  )
  await act(async () => root.render(tree))
  await settle()
}

const header = () => host.querySelector('header')!
const pairs = () => [...header().querySelectorAll('.meta-pair')]
const labels = () => pairs().map(pair => pair.firstElementChild?.textContent)
const pair = (label: string) => pairs().find(each => each.firstElementChild?.textContent === `${label}:`)
const value = (label: string) => pair(label)?.querySelector('b')?.textContent ?? null
const stickCard = () => host.querySelector<HTMLElement>('section[aria-labelledby="stick-title"]')!
const stickButton = () => [...stickCard().querySelectorAll('button')].at(-1)!
const amountInput = () => stickCard().querySelector<HTMLInputElement>('input')!
const walletLine = () =>
  [...stickCard().querySelectorAll('p')].find(line => line.textContent?.endsWith(' in wallet'))?.textContent ?? null
const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Project sections"] [role="tab"]')]
const selected = () => tabs().filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.textContent)
const amounts = () => [...host.querySelectorAll('[data-amount]')].map(amount => amount.textContent)

/** Types into a React input: its value setter is the prototype's, so React sees the change. */
async function type(input: HTMLInputElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('the project route', () => {
  it('opens /base:23, and tells the header which project is in view', async () => {
    await renderPage('base:23')
    expect(mocks.project).toHaveBeenCalledWith(8453, 23n)
    expect(host.querySelector('output')?.textContent).toBe('8453:23:null')
    expect(header().querySelector('h1')?.textContent).toBe('STICKYSLOPSHOP Sticky Slop Shop')
    expect(mocks.handle).not.toHaveBeenCalled()
  })

  it.each(['@banny', '%40banny'])('opens the project that the handle %s names, and keeps the handle in view', async urn => {
    mocks.handle.mockResolvedValue({ chainId: 8453, projectId: 23, handle: 'banny' })
    await renderPage(urn)
    expect(mocks.handle).toHaveBeenCalledWith('@banny')
    expect(host.querySelector('output')?.textContent).toBe('8453:23:banny')
    expect(header().querySelector('h1')?.textContent).toBe('STICKYSLOPSHOP Sticky Slop Shop')
  })

  it('is not found for a handle that names no project', async () => {
    mocks.handle.mockResolvedValue(null)
    await expect(ProjectPage(props('@nobody'))).rejects.toThrow(NOT_FOUND)
    expect(mocks.handle).toHaveBeenCalledWith('@nobody')
  })

  it('says a handle could not be read, and offers to try again, when its read fails: that is no 404', async () => {
    mocks.handle.mockRejectedValue(new Error('429'))
    await renderPage('@banny')
    expect(mocks.notFound).not.toHaveBeenCalled()
    const alert = host.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Could not read this handle.')
    const retry = [...alert.querySelectorAll('a')].find(link => link.textContent === 'Try again')!
    expect(retry.getAttribute('href')).toBe('/%40banny')
    expect(host.querySelector('header')).toBeNull()
    expect(host.querySelector('output')?.textContent).toBe('none')
  })

  it('reads a failed handle again on the next visit: a failure is never kept as a miss', async () => {
    mocks.handle.mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce({ chainId: 8453, projectId: 23, handle: 'banny' })
    await renderPage('@banny')
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
    await renderPage('@banny')
    expect(mocks.handle).toHaveBeenCalledTimes(2)
    expect(host.querySelector('output')?.textContent).toBe('8453:23:banny')
  })

  it.each(['foo', 'base', 'base:0', 'base:-1', 'base:2.5', 'base:abc', 'moon:5', '%E0%A4%A', '%2540banny', 'banny'])(
    'is not found for %j, and asks nothing of ENS',
    async urn => {
      await expect(ProjectPage(props(urn))).rejects.toThrow(NOT_FOUND)
      expect(mocks.handle).not.toHaveBeenCalled()
    },
  )
})

describe('the header', () => {
  it('reads Stuck, Sticks, On, Average active stick and Longest active stick, in that order', async () => {
    await renderPage('base:23')
    expect(labels()).toEqual(['Stuck:', 'Sticks:', 'On:', 'Average active stick:', 'Longest active stick:'])
    expect(value('Stuck')).toBe('1,010 SLOPSHOP')
    expect(value('Sticks')).toBe('2')
    expect(value('Average active stick')).toBe('2d 0h')
    expect(value('Longest active stick')).toBe('3d 0h')
    const on = pair('On')!
    expect(on.getAttribute('title')).toBe('Chains chosen at launch.')
    expect([...on.querySelectorAll('img')].map(icon => icon.getAttribute('alt'))).toEqual(['Optimism', 'Base'])
  })

  it('shows Stuck as the backing the shares claim, in the underlying token, never the Sticky supply', async () => {
    mocks.project.mockResolvedValue(slopshop(23n, { totalSupply: 5n * E18, backing: 7_500_000n, rawBacking: 9_000_000n }))
    await renderPage('base:23')
    expect(value('Stuck')).toBe('7.5 SLOPSHOP')
  })

  it('paints Stuck from the project read while the holders are still read', async () => {
    mocks.holders.mockReturnValue(new Promise(() => {}))
    await renderPage('base:23')
    expect(value('Stuck')).toBe('1,010 SLOPSHOP')
    for (const label of ['Sticks', 'Average active stick', 'Longest active stick']) {
      expect(value(label)).toBe('')
      expect(pair(label)?.querySelector('.skeleton-shimmer')).not.toBeNull()
    }
  })

  it('draws placeholders, and no chains, before the project is read', async () => {
    mocks.project.mockReturnValue(new Promise(() => {}))
    await renderPage('base:23')
    expect(header().getAttribute('aria-busy')).toBe('true')
    expect(header().querySelector('h1')).toBeNull()
    expect(value('Stuck')).toBe('')
    expect(pair('On')).toBeUndefined()
    expect(labels()).toEqual(['Stuck:', 'Sticks:', 'Average active stick:', 'Longest active stick:'])
  })

  it('names only the page\'s chain when the launch planned none', async () => {
    mocks.project.mockResolvedValue(slopshop(23n, { plannedChains: null }))
    await renderPage('base:23')
    expect([...pair('On')!.querySelectorAll('img')].map(icon => icon.getAttribute('alt'))).toEqual(['Base'])
  })

  it('says a project could not be read, tells the console why, and reads it again on Try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('Project 23 is not a Sticky token of this deployer.')
    mocks.project.mockRejectedValueOnce(failure)
    await renderPage('base:23')

    const alert = header().querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Could not read this Sticky token.')
    expect(value('Stuck')).toBe('–')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not read a Sticky project'), { chainId: 8453, projectId: 23 }, failure)
    expect(stickButton().textContent).toBe('Stick')
    expect(stickButton().disabled).toBe(true)

    const retry = [...alert.querySelectorAll('button')].find(button => button.textContent === 'Try again')!
    await act(async () => retry.click())
    await settle()
    expect(header().querySelector('[role="alert"]')).toBeNull()
    expect(value('Stuck')).toBe('1,010 SLOPSHOP')
  })

  it('shows – for the holder figures, and tells the console, when the holders cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('429')
    mocks.holders.mockRejectedValue(failure)
    await renderPage('base:23')
    expect(value('Stuck')).toBe('1,010 SLOPSHOP')
    for (const label of ['Sticks', 'Average active stick', 'Longest active stick']) expect(value(label)).toBe('–')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('holders'), { chainId: 8453, projectId: 23 }, failure)
  })
})

describe('the tabs', () => {
  it('are Overview, Tokens and Airdrops, with Latest as a tab of its own on a phone', async () => {
    await renderPage('base:23')
    expect(tabs().map(tab => tab.textContent)).toEqual(['Latest', 'Overview', 'Tokens', 'Airdrops'])
    expect(selected()).toEqual(['Overview'])
  })

  it.each([
    [320, 'Latest'],
    [820, 'Latest'],
    [821, 'Overview'],
    [1280, 'Overview'],
  ])('open on %s px wide with %s selected', async (width, tab) => {
    stubWidth(width)
    await renderPage('base:23')
    expect(selected()).toEqual([tab])
  })

  it('open Tokens for #tokens, and Latest for #latest on a phone', async () => {
    window.history.replaceState(null, '', '/base:23#tokens')
    await renderPage('base:23')
    expect(selected()).toEqual(['Tokens'])

    await act(async () => root.unmount())
    root = createRoot(host)
    stubWidth(390)
    window.history.replaceState(null, '', '/base:23#latest')
    await renderPage('base:23')
    expect(selected()).toEqual(['Latest'])
  })

  it('keep the tab in the address when one is picked', async () => {
    await renderPage('base:23')
    const airdrops = tabs().find(tab => tab.textContent === 'Airdrops')!
    await act(async () => airdrops.click())
    expect(window.location.hash).toBe('#airdrops')
    expect(selected()).toEqual(['Airdrops'])
  })

  it('show the Airdrops under the Airdrops tab, which reads nothing until it is picked', async () => {
    mocks.address = VIEWER
    await renderPage('base:23')
    expect(host.textContent).not.toContain('Your rewards')
    const airdrops = tabs().find(tab => tab.textContent === 'Airdrops')!
    await act(async () => airdrops.click())
    await settle()
    expect([...host.querySelectorAll('h2')].map(heading => heading.textContent)).toEqual(
      expect.arrayContaining(['Your rewards', 'Who can stick for you']),
    )
  })

  it('show Latest beside the tabs: the project\'s newest sticks, in the underlying token', async () => {
    await renderPage('base:23')
    expect(amounts()).toEqual(['1,010 SLOPSHOP'])
    expect(host.textContent).toContain(`stuck by ${HOLDER.slice(0, 6)}…${HOLDER.slice(-4)}`)
    expect(mocks.moves).toHaveBeenCalledWith([stuck], expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('show the newest 40 sticks, unsticks and streaks in Latest, however many settings changed after them', async () => {
    const tx = (at: number) => `0x${at.toString(16).padStart(64, '0')}` as Hex
    const sticks = Array.from({ length: 41 }, (_, at) => ({ ...stuck, txHash: tx(at + 1), timestamp: NOW - 100 + at }))
    const trusts = [60, 61, 62].map(
      (at): StickyEvent => ({ kind: 'trust', chainId: 8453, projectId: 23n, holder: HOLDER, sender: VIEWER, trusted: true, txHash: tx(at), logIndex: 0, blockNumber: null, timestamp: NOW }),
    )
    mocks.events.mockResolvedValue({ events: [...sticks, ...trusts], source: 'indexed', degraded: null })
    await renderPage('base:23')
    expect(mocks.moves.mock.calls[0][0]).toEqual(sticks.slice(1))
  })

  it('show Latest\'s Sticky shares when the terminal cannot say what a stick paid', async () => {
    mocks.moves.mockResolvedValue(new Map())
    await renderPage('base:23')
    expect(amounts()).toEqual(['1,000 STICKYSLOPSHOP'])
  })

  it('say Latest could not be read, and offer to try again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.events.mockRejectedValueOnce(new Error('429'))
    await renderPage('base:23')
    const note = [...host.querySelectorAll('[role="alert"]')].find(alert => alert.textContent?.includes('Latest'))!
    expect(note.textContent).toContain('Could not read Latest.')
    await act(async () => [...note.querySelectorAll('button')].find(button => button.textContent === 'Try again')!.click())
    await settle()
    expect(amounts()).toEqual(['1,010 SLOPSHOP'])
  })
})

describe('the reads behind the page', () => {
  it('read the project\'s history once, for Latest and for the holders', async () => {
    await renderPage('base:23')
    expect(mocks.events).toHaveBeenCalledTimes(1)
    expect(mocks.events).toHaveBeenCalledWith(8453, 23n, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const [chainId, projectId, options] = mocks.holders.mock.calls[0]
    expect([chainId, projectId, options.now]).toEqual([8453, 23n, NOW])
    // When Bendystraw's positions cannot answer, the holders are built from the history the page read.
    expect(await options.events(8453, 23n, {})).toBe(history)
  })

  it('run their scans one after another', async () => {
    let running = 0
    let most = 0
    const scan = <T,>(answer: T) => async () => {
      running += 1
      most = Math.max(most, running)
      await new Promise(resolve => setTimeout(resolve, 100))
      running -= 1
      return answer
    }
    mocks.events.mockImplementation(scan(history))
    mocks.holders.mockImplementation(scan(holders))
    mocks.moves.mockImplementation(scan(paid))
    await renderPage('base:23')
    await settle(1_000)
    expect(mocks.events).toHaveBeenCalledTimes(1)
    expect(mocks.holders).toHaveBeenCalledTimes(1)
    expect(mocks.moves).toHaveBeenCalledTimes(1)
    expect(most).toBe(1)
    expect(value('Sticks')).toBe('2')
    expect(amounts()).toEqual(['1,010 SLOPSHOP'])
  })

  it('read nothing of a project\'s history when the project cannot be read, and read it once it can', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.project.mockRejectedValueOnce(new Error('Project 23 is not a Sticky token of this deployer.'))
    await renderPage('base:23')
    await settle(60_000)
    expect(mocks.events).not.toHaveBeenCalled()
    expect(mocks.holders).not.toHaveBeenCalled()
    expect(mocks.pinned).not.toHaveBeenCalled()
    expect(mocks.moves).not.toHaveBeenCalled()
    // Nor does the Overview tab: not the balance flows, and not the search for the launch's chains.
    expect(mocks.creation).not.toHaveBeenCalled()
    expect(mocks.flows).not.toHaveBeenCalled()
    expect(mocks.siblings).not.toHaveBeenCalled()
    for (const label of ['Stuck', 'Sticks', 'Average active stick', 'Longest active stick']) expect(value(label)).toBe('–')
    const note = [...host.querySelectorAll('[role="alert"]')].find(alert => alert.textContent?.includes('Latest'))!
    expect(note.textContent).toContain('Could not read Latest.')

    // Trying Latest again reads the project, and then its history.
    await act(async () => [...note.querySelectorAll('button')].find(button => button.textContent === 'Try again')!.click())
    await settle()
    expect(mocks.project).toHaveBeenCalledTimes(2)
    expect(mocks.events).toHaveBeenCalledTimes(1)
    expect(mocks.flows).toHaveBeenCalledTimes(1)
    expect(mocks.siblings).toHaveBeenCalledTimes(1)
    expect(value('Sticks')).toBe('2')
    expect(amounts()).toEqual(['1,010 SLOPSHOP'])
  })

  it.each([
    ['history', () => mocks.events.mockRejectedValue(new Error('429')), () => mocks.events],
    ['holders', () => mocks.holders.mockRejectedValue(new Error('429')), () => mocks.holders],
  ])('read a failing %s once, with the site\'s own query defaults', async (_what, fail, read) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fail()
    const site = siteClient()
    await renderPage('base:23', site)
    await settle(120_000)
    expect(read()).toHaveBeenCalledTimes(1)
    site.clear()
  })

  it('cancel a project\'s scans when its page closes, so the next project\'s scans start', async () => {
    const signals = new Map<bigint, AbortSignal>()
    // A scan that answers only when it is cancelled, as the history's scan rejects with the caller's reason.
    mocks.events.mockImplementation((_chainId: number, projectId: bigint, { signal }: { signal: AbortSignal }) => {
      signals.set(projectId, signal)
      if (projectId === 24n) return Promise.resolve(history)
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    await renderPage('base:23')
    expect(signals.get(23n)?.aborted).toBe(false)

    await renderPage('base:24')
    expect(signals.get(23n)?.aborted).toBe(true)
    expect(mocks.events).toHaveBeenCalledWith(8453, 24n, expect.anything())
    expect(mocks.holders).toHaveBeenCalledWith(8453, 24n, expect.anything())
  })

  it('drop the project they showed when the route names another, even when its read lands late', async () => {
    const first = Promise.withResolvers<StickyProjectInfo>()
    mocks.project.mockImplementation(async (_chainId: number, projectId: bigint) =>
      projectId === 23n ? first.promise : slopshop(projectId),
    )
    await renderPage('base:23')
    await type(amountInput(), '12')
    expect(amountInput().value).toBe('12')

    await renderPage('base:24')
    expect(header().querySelector('h1')?.textContent).toBe('STICKY24 Sticky Slop Shop')
    expect(amountInput().value).toBe('')

    await act(async () => first.resolve(slopshop(23n)))
    await settle()
    expect(host.textContent).not.toContain('STICKYSLOPSHOP')
    expect(header().querySelector('h1')?.textContent).toBe('STICKY24 Sticky Slop Shop')
  })

  it('keep the project for a return visit, unconfirmed until this visit reads it again', async () => {
    const storage = memoryStorage()
    // An earlier visit read the project, and the browser kept it.
    const earlier = newClient()
    const stop = installQueryPersistence(earlier, storage)
    await renderPage('base:23', earlier)
    await settle(1_000)
    stop()
    await act(async () => root.unmount())
    root = createRoot(host)

    // This visit, moments later: the project's read has not answered yet.
    const read = Promise.withResolvers<StickyProjectInfo>()
    mocks.project.mockReset().mockReturnValue(read.promise)
    const now = newClient()
    installQueryPersistence(now, storage)
    await renderPage('base:23', now)

    expect(header().querySelector('h1')?.textContent).toBe('STICKYSLOPSHOP Sticky Slop Shop')
    expect(value('Stuck')).toBe('1,010 SLOPSHOP')
    expect(pair('Stuck')?.querySelector('.revalidating')).not.toBeNull()
    expect(value('Sticks')).toBe('2')
    expect(amounts()).toEqual(['1,010 SLOPSHOP'])
    // Nothing is stuck from a kept copy: the button waits for this visit's read.
    expect(mocks.project).toHaveBeenCalledTimes(1)
    expect(stickButton().disabled).toBe(true)
    expect(stickButton().textContent).toBe('Checking…')

    await act(async () => read.resolve(slopshop(23n)))
    await settle()
    expect(pair('Stuck')?.querySelector('.revalidating')).toBeNull()
    expect(stickButton().textContent).toBe('Stick')
  })

  it('keep no account\'s stick', async () => {
    const storage = memoryStorage()
    mocks.address = VIEWER
    const stop = installQueryPersistence(client, storage)
    await renderPage('base:23')
    await settle(1_000)
    stop()
    const kept = storage.getItem('sticky:query-cache:v1')!
    expect(kept).toContain('sticky-project')
    expect(kept.toLowerCase()).not.toContain(VIEWER.toLowerCase())
  })
})

describe('the Stick card', () => {
  it('stays closed and reads "Checking…" until this visit has read the project', async () => {
    const read = Promise.withResolvers<StickyProjectInfo>()
    mocks.project.mockReturnValue(read.promise)
    await renderPage('base:23')
    expect(stickButton().disabled).toBe(true)
    expect(stickButton().textContent).toBe('Checking…')

    await act(async () => read.resolve(slopshop(23n)))
    await settle()
    expect(stickCard().querySelector('h2')?.textContent).toBe('Stick SLOPSHOP')
    expect(stickButton().textContent).toBe('Stick')
    // Sticking opens with the transaction engine; the page reads only.
    expect(stickButton().disabled).toBe(true)
  })

  it('shows no wallet, and reads no stick, without an account', async () => {
    await renderPage('base:23')
    expect(mocks.position).not.toHaveBeenCalled()
    expect(stickCard().textContent).not.toContain('in wallet')
  })

  it('shows what the viewer holds of the staked token, as the old card did, and not their stick, which the Tokens tab shows', async () => {
    mocks.address = VIEWER
    await renderPage('base:23')
    expect(mocks.position).toHaveBeenCalledWith(8453, expect.objectContaining({ projectId: 23n }), VIEWER, expect.anything())
    expect(walletLine()).toBe('25 SLOPSHOP in wallet')
    expect(stickCard().textContent).not.toMatch(/stuck/i)
  })

  it('fills the amount with the whole wallet balance from its max link', async () => {
    mocks.address = VIEWER
    mocks.position.mockResolvedValue({ ...position, wallet: 1_234_567n })
    await renderPage('base:23')
    const max = stickCard().querySelector<HTMLButtonElement>('button[title="Use full wallet balance"]')!
    expect(max.textContent).toBe('1.2346')
    await act(async () => max.click())
    expect(amountInput().value).toBe('1.234567')
  })

  it('reads the stick of the account in View as', async () => {
    mocks.address = VIEWER
    setViewAs(HOLDER)
    await renderPage('base:23')
    expect(mocks.position).toHaveBeenCalledWith(8453, expect.anything(), expect.stringMatching(new RegExp(HOLDER, 'i')), expect.anything())
  })

  it('reads the viewer\'s stick again every 15 seconds, and not while the tab is hidden', async () => {
    mocks.address = VIEWER
    await renderPage('base:23')
    expect(mocks.position).toHaveBeenCalledTimes(1)

    mocks.position.mockResolvedValue({ ...position, wallet: 30n * E6 })
    await settle(15_000)
    expect(mocks.position).toHaveBeenCalledTimes(2)
    expect(walletLine()).toBe('30 SLOPSHOP in wallet')

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await settle(45_000)
    expect(mocks.position).toHaveBeenCalledTimes(2)

    hidden.mockReturnValue(false)
    state.mockReturnValue('visible')
    await settle(15_000)
    expect(mocks.position).toHaveBeenCalledTimes(3)
  })

  it('reads the viewer\'s stick again as soon as the tab is shown again, as the old page did', async () => {
    mocks.address = VIEWER
    // Providers' defaults refetch nothing on focus; the stick is read again anyway.
    const site = siteClient()
    await renderPage('base:23', site)
    expect(mocks.position).toHaveBeenCalledTimes(1)

    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    await act(async () => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    await settle()
    expect(mocks.position).toHaveBeenCalledTimes(1)

    state.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })))
    await settle()
    expect(mocks.position).toHaveBeenCalledTimes(2)
    site.clear()
  })

  it('keeps the wallet it showed, and tells the console, when a refresh fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.address = VIEWER
    await renderPage('base:23')
    const failure = new Error('429')
    mocks.position.mockRejectedValue(failure)
    await settle(15_000)
    expect(walletLine()).toBe('25 SLOPSHOP in wallet')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stick'), { chainId: 8453, projectId: 23 }, failure)
  })
})
