import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act, StrictMode, type AnchorHTMLAttributes, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Address, Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inTurn } from '@/lib/in-turn'
import { installQueryPersistence } from '@/lib/query-persist'
import type { Flow } from '@/lib/sticky-backing'
import { stickyDeployment } from '@/lib/sticky-addresses'
import type { StickyEvent, StickyEventsResult } from '@/lib/sticky-events'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import type { Sibling } from '@/lib/sticky-siblings'
import { E18, E6, HOLDER, TOKEN, stickyInfo } from '../home-fixtures'
import { memoryStorage } from '../memory-storage'

// The Overview tab: the chart of what is stuck, the Details card and the Chains card. Every read is a mock; the read
// model has tests of its own. The clock is fake, Date included, so a chart's dates and the copy label's timer are
// exact and move only when a test moves it.

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  events: vi.fn(),
  creation: vi.fn(),
  flows: vi.fn(),
  siblings: vi.fn(),
  holders: vi.fn(),
  pinned: vi.fn(),
  moves: vi.fn(),
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
vi.mock('@/lib/sticky-backing', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-backing')>()),
  backingFlows: mocks.flows,
}))
vi.mock('@/lib/sticky-siblings', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-siblings')>()),
  launchSiblings: mocks.siblings,
}))
vi.mock('@/lib/sticky-holders', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-holders')>()),
  stickyHolders: mocks.holders,
  pinnedBlock: mocks.pinned,
}))
vi.mock('@/lib/sticky-feed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-feed')>()),
  terminalMoves: mocks.moves,
}))
vi.mock('@/lib/sticky-handles', () => ({ resolveProjectHandle: vi.fn() }))
vi.mock('next/navigation', () => ({ notFound: vi.fn() }))
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))

import ProjectPage from '@/app/[urn]/page'
import { OverviewTab } from '@/components/project/OverviewTab'
import { ProjectTabs, type TabDef } from '@/components/project/Tabs'

const NOW = 1_800_000_000
const DAY = 86_400
const LAUNCH = '11111111-2222-4333-8444-555555555555'
const SECOND = `0x${'b'.repeat(40)}` as Address
const THIRD = `0x${'c'.repeat(40)}` as Address
const ST_TOKEN = `0x${'5'.repeat(40)}` as Address
const HOOK = stickyDeployment(8453)!.hook
const ADAPTER = stickyDeployment(8453)!.autoStick
const XSS = '<img src=x onerror=alert(1)>'

/** STICKYSLOPSHOP #23 on Base: SLOPSHOP has 6 decimals, its Sticky shares always 18. 1,000 shares claim 1,010 SLOPSHOP
 * (a 10% stickiness bonus, transferable), and the launch planned Optimism and Base. */
const slopshop = (extra: Partial<StickyProjectInfo> = {}) =>
  stickyInfo(8453, 23n, {
    stToken: ST_TOKEN,
    stSymbol: 'STICKYSLOPSHOP',
    stName: 'Sticky Slop Shop',
    stakedToken: TOKEN,
    symbol: 'SLOPSHOP',
    name: 'Slop Shop',
    decimals: 6,
    cashOutTaxRate: 1_000n,
    totalSupply: 1_000n * E18,
    backing: 1_010n * E6,
    rawBacking: 1_010n * E6,
    launchId: LAUNCH,
    plannedChains: [10, 8453],
    ...extra,
  })

/** The launch's copy on Optimism: 400 shares claim 500 SLOPSHOP. */
const optimism = (extra: Partial<StickyProjectInfo> = {}) =>
  slopshop({ chainId: 10, projectId: 5n, totalSupply: 400n * E18, backing: 500n * E6, rawBacking: 500n * E6, ...extra })

const HERE: Sibling = { chainId: 8453, projectId: 23n, self: true }
const THERE: Sibling = { chainId: 10, projectId: 5n, self: false }

const tx = (at: number) => `0x${at.toString(16).padStart(64, '0')}` as Hex
let logs = 0
function event(kind: StickyEvent['kind'], timestamp: number, extra: Partial<StickyEvent> = {}): StickyEvent {
  logs += 1
  return { kind, chainId: 8453, projectId: 23n, holder: HOLDER, txHash: tx(logs), logIndex: 0, blockNumber: null, timestamp, ...extra }
}
const stick = (timestamp: number, count: bigint) =>
  event('stick', timestamp, { payer: HOLDER, count, balance: count })
const history = (...events: StickyEvent[]): StickyEventsResult => ({ events, source: 'indexed', degraded: null })

/** HOLDER stuck 1,000 shares three days ago, paying 1,010 SLOPSHOP. */
const stuck = () => [stick(NOW - 3 * DAY, 1_000n * E18), event('streakStart', NOW - 3 * DAY)]
const paid: Flow[] = [{ timestamp: NOW - 3 * DAY, delta: 1_010n * E6 }]

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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW * 1_000)
  mocks.project.mockReset().mockImplementation(async (chainId: number) => (chainId === 10 ? optimism() : slopshop()))
  mocks.events.mockReset().mockResolvedValue(history(...stuck()))
  mocks.creation.mockReset().mockResolvedValue(1_234n)
  mocks.flows.mockReset().mockResolvedValue(paid)
  mocks.siblings.mockReset().mockResolvedValue([HERE, THERE])
  mocks.holders.mockReset().mockResolvedValue({ rows: [], source: 'indexed', degraded: null })
  mocks.pinned.mockReset().mockResolvedValue({ number: 100n, timestamp: NOW })
  mocks.moves.mockReset().mockResolvedValue(new Map())
  client = newClient()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  client.clear()
  Reflect.deleteProperty(navigator, 'clipboard')
})

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
const inClient = (node: ReactNode, using = client) => <QueryClientProvider client={using}>{node}</QueryClientProvider>

async function renderTab(using = client) {
  await act(async () => root.render(inClient(<OverviewTab chainId={8453} projectId={23} />, using)))
  await settle()
}

const section = (id: string) => host.querySelector<HTMLElement>(`section[aria-labelledby="${id}"]`)
const detailsCard = () => section('details-title')!
const chainsCard = () => section('chains-title')
const chart = () => host.querySelector<SVGSVGElement>('svg[role="img"]')
const text = (node: Element | null | undefined) => node?.textContent ?? ''
const revalidating = (node: Element | null | undefined) => node?.closest('.revalidating') ?? node?.querySelector('.revalidating') ?? null

/** The Details card's rows, label and value, in order. */
const rows = () => [...detailsCard().querySelector('dl')!.querySelectorAll('dt')].map(dt => [text(dt), text(dt.nextElementSibling)])
const value = (label: string) => rows().find(([each]) => each === label)?.[1]
const rules = () => [...detailsCard().querySelectorAll('details ul li')].map(text)
const contracts = () => {
  const list = detailsCard().querySelector('details dl')!
  return [...list.querySelectorAll('dt')].map(dt => [text(dt), text(dt.nextElementSibling?.querySelector('span'))])
}
const copyButton = (label: string) =>
  detailsCard().querySelector<HTMLButtonElement>(`button[aria-label="Copy ${label} address"]`)

/** The Chains card's rows, each as the text of its cells. */
const chainRows = () => [...chainsCard()!.querySelectorAll('tbody tr')].map(row => [...row.children].map(text))
const chainNote = () => text(chainsCard()!.querySelector('p'))

/** The chart's two peak labels, and what its legend calls the plotted amount. */
const peaks = () => [...chart()!.querySelectorAll('text')].map(text).filter(label => label.startsWith('Peak:'))
const legend = () => [...host.querySelectorAll('[data-legend]')].map(text)

/** One holder stuck 1,000 shares three days ago for 1,010 SLOPSHOP and unstuck 400 of them a day ago for 404. */
async function threeDays() {
  mocks.events.mockResolvedValue(
    history(
      stick(NOW - 3 * DAY, 1_000n * E18),
      event('streakStart', NOW - 3 * DAY),
      event('unstick', NOW - DAY, { count: 400n * E18, balance: 600n * E18 }),
    ),
  )
  mocks.project.mockResolvedValue(slopshop({ totalSupply: 600n * E18, backing: 606n * E6, rawBacking: 606n * E6 }))
  mocks.flows.mockResolvedValue([
    { timestamp: NOW - 3 * DAY, delta: 1_010n * E6 },
    { timestamp: NOW - DAY, delta: -404n * E6 },
  ])
  await renderTab()
}

describe('the Details card', () => {
  it('lists Token, Sticks, Supply, Backing, Backing per token, Unowned backing, Stickiness bonus and Transfers', async () => {
    mocks.project.mockResolvedValue(slopshop({ orphaned: 5n * E6, savedOrphaned: 5n * E6, rawBacking: 1_015n * E6 }))
    await renderTab()
    expect(detailsCard().querySelector('h2')?.textContent).toBe('Details')
    expect(rows()).toEqual([
      ['Token', 'Sticky Slop Shop (STICKYSLOPSHOP)'],
      ['Sticks', 'Slop Shop (SLOPSHOP)'],
      ['Supply', '1,000 STICKYSLOPSHOP'],
      ['Backing', '1,010 SLOPSHOP'],
      ['Backing per token', '1.01 SLOPSHOP'],
      ['Unowned backing', '5 SLOPSHOP'],
      ['Stickiness bonus', '10%'],
      ['Transfers', 'On'],
    ])
    const unowned = [...detailsCard().querySelectorAll('dd')].find(dd => dd.previousElementSibling?.textContent === 'Unowned backing')
    expect(unowned?.getAttribute('title')).toBe('Left when nobody was stuck. No one can claim it.')
  })

  it('shows Supply in Sticky shares with 18 decimals and Backing in the underlying token with its own', async () => {
    // A token with 6 decimals: the shares that claim it always have 18.
    mocks.project.mockResolvedValue(slopshop({ totalSupply: 3n * E18, backing: 12_345n }))
    await renderTab()
    expect(value('Supply')).toBe('3 STICKYSLOPSHOP')
    expect(value('Backing')).toBe('0.0123 SLOPSHOP')
    // What a share claims: the backing over the supply, 0.004115 in the underlying token's decimals.
    expect(value('Backing per token')).toBe('0.0041 SLOPSHOP')
    expect(detailsCard().textContent).not.toContain('SLOPSHOP STICKYSLOPSHOP')

    mocks.project.mockResolvedValue(slopshop({ decimals: 18, totalSupply: 2n * E18, backing: 5n * E18 }))
    await act(async () => void (await client.invalidateQueries()))
    await settle()
    expect(value('Backing')).toBe('5 SLOPSHOP')
    expect(value('Backing per token')).toBe('2.5 SLOPSHOP')
  })

  it('leaves out Backing per token while no shares exist, and Unowned backing when none is unowned', async () => {
    mocks.project.mockResolvedValue(slopshop({ totalSupply: 0n, backing: 0n, orphaned: 1_010n * E6, rawBacking: 1_010n * E6 }))
    await renderTab()
    expect(rows().map(([label]) => label)).toEqual(['Token', 'Sticks', 'Supply', 'Backing', 'Unowned backing', 'Stickiness bonus', 'Transfers'])
    expect(value('Supply')).toBe('0 STICKYSLOPSHOP')

    mocks.project.mockResolvedValue(slopshop())
    await act(async () => void (await client.invalidateQueries()))
    await settle()
    expect(rows().map(([label]) => label)).toEqual(['Token', 'Sticks', 'Supply', 'Backing', 'Backing per token', 'Stickiness bonus', 'Transfers'])
  })

  it.each([
    [0n, '0%'],
    [1n, '0.01%'],
    [250n, '2.5%'],
    [1_000n, '10%'],
    [10_000n, '100%'],
  ])('reads a stickiness bonus of %s out of 10,000 as %s', async (rate, shown) => {
    mocks.project.mockResolvedValue(slopshop({ cashOutTaxRate: rate }))
    await renderTab()
    expect(value('Stickiness bonus')).toBe(shown)
  })

  it('reads Transfers as Off for a soulbound token', async () => {
    mocks.project.mockResolvedValue(slopshop({ soulbound: true }))
    await renderTab()
    expect(value('Transfers')).toBe('Off')
  })

  it('gives every value as its own tooltip, for the ones the card cuts short', async () => {
    await renderTab()
    const titles = [...detailsCard().querySelector('dl')!.querySelectorAll('dd')].map(dd => [text(dd), dd.getAttribute('title')])
    for (const [shown, title] of titles) expect(title).toBe(shown)
  })

  it('draws placeholders before the project is read, and no values', async () => {
    mocks.project.mockReturnValue(new Promise(() => {}))
    await renderTab()
    expect(detailsCard().querySelector('h2')?.textContent).toBe('Details')
    expect(detailsCard().querySelector('dl')).toBeNull()
    expect(detailsCard().querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0)
  })

  it('says the details could not be read, tells the console why, and reads again on Try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('Project 23 is not a Sticky token of this deployer.')
    mocks.project.mockRejectedValue(failure)
    await renderTab()
    expect(detailsCard().querySelector('[role="alert"]')?.textContent).toContain('Could not read the details.')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not read a Sticky project'), { chainId: 8453, projectId: 23 }, failure)

    mocks.project.mockImplementation(async (chainId: number) => (chainId === 10 ? optimism() : slopshop()))
    const retry = [...detailsCard().querySelectorAll('button')].find(button => button.textContent === 'Try again')!
    await act(async () => retry.click())
    await settle()
    expect(detailsCard().querySelector('[role="alert"]')).toBeNull()
    expect(value('Backing')).toBe('1,010 SLOPSHOP')
  })
})

describe('Rules and contracts', () => {
  it('sits under a disclosure that starts closed', async () => {
    await renderTab()
    const disclosure = detailsCard().querySelector('details')!
    expect(disclosure.querySelector('summary')?.textContent).toBe('Rules and contracts')
    expect(disclosure.open).toBe(false)
  })

  it.each([
    [{ cashOutTaxRate: 1_000n, soulbound: false }, ['Unsticking leaves up to 10% behind for holders who stay.', 'Transferred tokens start a new stick for the recipient.']],
    [{ cashOutTaxRate: 250n, soulbound: true }, ['Unsticking leaves up to 2.5% behind for holders who stay.', "Sticky tokens can't be transferred."]],
    [{ cashOutTaxRate: 0n, soulbound: false }, ['Unsticking returns your share of the backing.', 'Transferred tokens start a new stick for the recipient.']],
  ])('states what unsticking and transfers do for %o', async (extra, expected) => {
    mocks.project.mockResolvedValue(slopshop(extra))
    await renderTab()
    expect(rules().slice(0, 2)).toEqual(expected)
  })

  it('counts the granters the hook named as trusted senders, once each and never the auto-stick adapter', async () => {
    const granters = [SECOND, THIRD, SECOND, ADAPTER.toLowerCase() as Address].map(holder => event('granter', NOW - DAY, { holder, trusted: true }))
    mocks.events.mockResolvedValue(history(...stuck(), ...granters))
    await renderTab()
    expect(rules()[2]).toBe('2 trusted senders can stick for any holder.')

    mocks.events.mockResolvedValue(history(...stuck(), event('granter', NOW - DAY, { holder: SECOND, trusted: true })))
    await act(async () => void (await client.invalidateQueries()))
    await settle()
    expect(rules()[2]).toBe('1 trusted sender can stick for any holder.')
  })

  it('says holders choose who can stick for them when the hook named no granter', async () => {
    mocks.events.mockResolvedValue(history(...stuck(), event('granter', NOW, { holder: ADAPTER.toLowerCase() as Address, trusted: true })))
    await renderTab()
    expect(rules()[2]).toBe('Holders choose who can stick for them.')
  })

  it('draws a placeholder for the trusted-sender rule while the history is read, and no claim about it', async () => {
    mocks.events.mockReturnValue(new Promise(() => {}))
    await renderTab()
    expect(rules().filter(Boolean)).toHaveLength(2)
    expect(detailsCard().querySelector('details ul .skeleton-shimmer')).not.toBeNull()
    // The rest of the card does not wait for it.
    expect(value('Backing')).toBe('1,010 SLOPSHOP')
  })

  it('lists the Sticky token, the underlying token and Stick accounting, each with its full address', async () => {
    await renderTab()
    expect(contracts()).toEqual([
      ['STICKYSLOPSHOP token', ST_TOKEN],
      ['SLOPSHOP token', TOKEN],
      ['Stick accounting', HOOK],
    ])
    for (const label of ['STICKYSLOPSHOP token', 'SLOPSHOP token', 'Stick accounting']) {
      expect(text(copyButton(label))).toBe('Copy')
    }
  })

  it('copies an address, says so for a moment, and says when the browser refuses', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await renderTab()

    await act(async () => copyButton('SLOPSHOP token')!.click())
    expect(writeText).toHaveBeenCalledWith(TOKEN)
    expect(text(copyButton('SLOPSHOP token'))).toBe('Copied!')
    // Only the button that was pressed says so.
    expect(text(copyButton('Stick accounting'))).toBe('Copy')
    await settle(1_500)
    expect(text(copyButton('SLOPSHOP token'))).toBe('Copy')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const refused = new Error('denied')
    writeText.mockRejectedValue(refused)
    await act(async () => copyButton('Stick accounting')!.click())
    expect(text(copyButton('Stick accounting'))).toBe('Could not copy')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('copy'), refused)
    await settle(1_500)
    expect(text(copyButton('Stick accounting'))).toBe('Copy')
  })

  it('says so, and tells the console, when the browser has no clipboard to copy to', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await renderTab()
    await act(async () => copyButton('SLOPSHOP token')!.click())
    expect(text(copyButton('SLOPSHOP token'))).toBe('Could not copy')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('copy'), expect.any(TypeError))
  })
})

describe('a copy button\'s result', () => {
  const region = (label: string) => copyButton(label)!.parentElement!.querySelector<HTMLElement>('[role="status"]')!

  it('is said in a live region beside the button, which its name hides from a screen reader, and which stays in place', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await renderTab()
    const pressed = region('SLOPSHOP token')
    expect(pressed.textContent).toBe('')
    expect(pressed.getAttribute('aria-atomic')).toBe('true')
    expect(copyButton('SLOPSHOP token')!.getAttribute('aria-label')).toBe('Copy SLOPSHOP token address')
    expect(copyButton('SLOPSHOP token')!.contains(pressed)).toBe(false)

    await act(async () => copyButton('SLOPSHOP token')!.click())
    // The same element says it: a region that appears with its message is not reliably announced.
    expect(region('SLOPSHOP token')).toBe(pressed)
    expect(pressed.textContent).toBe('Address copied.')
    expect(region('Stick accounting').textContent).toBe('')
    await settle(1_500)
    expect(pressed.textContent).toBe('')
  })

  it('says when the browser refuses, and when it has no clipboard to copy to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await renderTab()
    await act(async () => copyButton('Stick accounting')!.click())
    expect(region('Stick accounting').textContent).toBe('Could not copy the address.')
    await settle(1_500)
    expect(region('Stick accounting').textContent).toBe('')

    Reflect.deleteProperty(navigator, 'clipboard')
    await act(async () => copyButton('SLOPSHOP token')!.click())
    expect(region('SLOPSHOP token').textContent).toBe('Could not copy the address.')
  })
})

describe('the contracts\' names', () => {
  const symbol = 'S'.repeat(256)
  const stSymbol = `ST${'S'.repeat(254)}`

  it('are cut where their column ends, held to a width, and whole in their tooltips, at 256 characters', async () => {
    mocks.project.mockResolvedValue(slopshop({ symbol, stSymbol }))
    await renderTab()
    const names = [...detailsCard().querySelectorAll('details dl dt')]
    expect(names.map(name => name.getAttribute('title'))).toEqual([`${stSymbol} token`, `${symbol} token`, 'Stick accounting'])
    expect(names.map(text)).toEqual([`${stSymbol} token`, `${symbol} token`, 'Stick accounting'])
    for (const name of names) {
      const classes = name.className.split(' ')
      expect(classes).toEqual(expect.arrayContaining(['min-w-0', 'max-w-[16rem]', 'truncate', 'max-[560px]:max-w-full']))
    }
    // Nothing is lost to the cut: each address is there in full, with its copy button.
    expect(contracts()).toEqual([
      [`${stSymbol} token`, ST_TOKEN],
      [`${symbol} token`, TOKEN],
      ['Stick accounting', HOOK],
    ])
    expect(copyButton(`${symbol} token`)).not.toBeNull()
    expect(copyButton(`${stSymbol} token`)).not.toBeNull()
  })

  it('keep the details\' own rows as they were', async () => {
    mocks.project.mockResolvedValue(slopshop({ symbol, stSymbol }))
    await renderTab()
    const labels = [...detailsCard().querySelector('dl')!.querySelectorAll('dt')]
    for (const label of labels) expect(label.className).not.toContain('truncate')
    expect(value('Sticks')).toBe(`Slop Shop (${symbol})`)
  })
})

describe('the Chains card', () => {
  it('lists each chain\'s project with its backing and supply, and the totals', async () => {
    await renderTab()
    expect(chainsCard()!.querySelector('h2')?.textContent).toBe('Chains')
    expect([...chainsCard()!.querySelectorAll('th')].map(text)).toEqual(['CHAIN', 'BACKING', 'SUPPLY'])
    expect(chainRows()).toEqual([
      ['Base #23 (this page)', '1,010 SLOPSHOP', '1,000 STICKYSLOPSHOP'],
      ['Optimism #5', '500 SLOPSHOP', '400 STICKYSLOPSHOP'],
      ['Total', '1,510 SLOPSHOP', '1,400 STICKYSLOPSHOP'],
    ])
  })

  it('links a copy on another chain to its own page, and the page\'s own project to nothing', async () => {
    await renderTab()
    const [own, other] = [...chainsCard()!.querySelectorAll('tbody tr')]
    expect(own.querySelector('a')).toBeNull()
    expect(other.querySelector('a')?.getAttribute('href')).toBe('/op:5')
    expect(text(other.querySelector('a'))).toBe('Optimism #5')
  })

  it('reads each chain\'s figures for itself, the page\'s own included, and searches for the copies from the page\'s project', async () => {
    await renderTab()
    expect(mocks.siblings).toHaveBeenCalledTimes(1)
    expect(mocks.siblings.mock.calls[0][0]).toMatchObject({
      chainId: 8453,
      projectId: 23n,
      launchId: LAUNCH,
      cashOutTaxRate: 1_000n,
      soulbound: false,
      plannedChains: [10, 8453],
    })
    expect(mocks.siblings.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal) })
    // A copy's figures clamp an unowned balance recorded above the terminal's, where the page's own read does not.
    expect(mocks.project.mock.calls).toEqual([
      [8453, 23n],
      [8453, 23n, { orphans: 'clamp' }],
      [10, 5n, { orphans: 'clamp' }],
    ])
  })

  it('has a row for a planned chain with no copy: "Planned at launch. Not deployed yet."', async () => {
    mocks.project.mockImplementation(async (chainId: number) => (chainId === 10 ? optimism() : slopshop({ plannedChains: [10, 8453, 42161] })))
    await renderTab()
    expect(chainRows()).toEqual([
      ['Base #23 (this page)', '1,010 SLOPSHOP', '1,000 STICKYSLOPSHOP'],
      ['Optimism #5', '500 SLOPSHOP', '400 STICKYSLOPSHOP'],
      ['Arbitrum', 'Planned at launch. Not deployed yet.'],
      ['Total', '1,510 SLOPSHOP', '1,400 STICKYSLOPSHOP'],
    ])
    const planned = chainsCard()!.querySelectorAll('tbody tr')[2].querySelector('td:last-child')!
    expect(planned.getAttribute('colspan')).toBe('2')
  })

  it('shows a launch that only one chain has yet, with each planned chain that is not deployed', async () => {
    mocks.siblings.mockResolvedValue([HERE])
    await renderTab()
    expect(chainRows()).toEqual([
      ['Base #23 (this page)', '1,010 SLOPSHOP', '1,000 STICKYSLOPSHOP'],
      ['Optimism', 'Planned at launch. Not deployed yet.'],
      ['Total', '1,010 SLOPSHOP', '1,000 STICKYSLOPSHOP'],
    ])
  })

  it('totals the backing only when every chain is backed by the same token, and the supply always', async () => {
    mocks.project.mockImplementation(async (chainId: number) => (chainId === 10 ? optimism({ symbol: 'USDC' }) : slopshop()))
    await renderTab()
    expect(chainRows().at(-1)).toEqual(['Total', 'Backed by different tokens', '1,400 STICKYSLOPSHOP'])
    // Each chain stands alone.
    expect(chainRows()[1]).toEqual(['Optimism #5', '500 USDC', '400 STICKYSLOPSHOP'])
    expect(chainNote()).toBe('')
  })

  it('counts the same symbol with other decimals as another token', async () => {
    mocks.project.mockImplementation(async (chainId: number) => (chainId === 10 ? optimism({ decimals: 18 }) : slopshop()))
    await renderTab()
    expect(chainRows().at(-1)?.[1]).toBe('Backed by different tokens')
  })

  it('gives a chain that could not be searched a row that says so, and totals the chains it could read', async () => {
    mocks.siblings.mockResolvedValue([HERE, { chainId: 10, error: new Error('down') }])
    await renderTab()
    expect(chainRows()).toEqual([
      ['Base #23 (this page)', '1,010 SLOPSHOP', '1,000 STICKYSLOPSHOP'],
      ['Optimism', 'Could not read this chain.'],
      ['Total', '1,010 SLOPSHOP', '1,000 STICKYSLOPSHOP'],
    ])
    expect(chainNote()).toBe('Some chains could not be read. Totals cover the chains shown.')
    expect(chainsCard()!.querySelectorAll('tbody tr')[1].querySelector('a')).toBeNull()
  })

  it('tells the console why a chain could not be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const down = new Error('down')
    mocks.siblings.mockResolvedValue([HERE, { chainId: 10, error: down }])
    await renderTab()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chains'), { chainId: 10 }, down)
  })

  it('gives a copy whose figures could not be read a row that says so, still linked, and reads the others', async () => {
    mocks.project.mockImplementation(async (chainId: number) => {
      if (chainId === 10) throw new Error('down')
      return slopshop()
    })
    await renderTab()
    expect(chainRows()).toEqual([
      ['Base #23 (this page)', '1,010 SLOPSHOP', '1,000 STICKYSLOPSHOP'],
      ['Optimism #5', 'Could not read this chain.'],
      ['Total', '1,010 SLOPSHOP', '1,000 STICKYSLOPSHOP'],
    ])
    expect(chainNote()).toContain('Some chains could not be read.')
  })

  it('shows no total where nothing could be read, rather than a total of nothing', async () => {
    mocks.project.mockImplementation(async (chainId: number, _projectId: bigint, options?: unknown) => {
      if (options) throw new Error('down')
      return chainId === 10 ? optimism() : slopshop()
    })
    await renderTab()
    expect(chainRows()).toEqual([
      ['Base #23 (this page)', 'Could not read this chain.'],
      ['Optimism #5', 'Could not read this chain.'],
      ['Total', '–', '–'],
    ])
    expect(chainNote()).toContain('Some chains could not be read.')
  })

  it.each([
    ['carries no launch and plans no chain', { launchId: null, plannedChains: null }],
    ['plans only its own chain', { launchId: null, plannedChains: [8453] }],
  ])('has no card for a project whose uri %s, and searches nothing', async (_what, extra) => {
    mocks.project.mockResolvedValue(slopshop(extra))
    await renderTab()
    expect(chainsCard()).toBeNull()
    expect(mocks.siblings).not.toHaveBeenCalled()
  })

  it('has no card for a launch that only its own chain has and planned no other', async () => {
    mocks.project.mockResolvedValue(slopshop({ plannedChains: [8453] }))
    mocks.siblings.mockResolvedValue([HERE])
    await renderTab()
    expect(chainsCard()).toBeNull()
  })

  it('draws placeholders while the copies are searched for', async () => {
    mocks.siblings.mockReturnValue(new Promise(() => {}))
    await renderTab()
    expect(chainsCard()!.querySelector('h2')?.textContent).toBe('Chains')
    expect(chainsCard()!.querySelector('table')).toBeNull()
    expect(chainsCard()!.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThan(0)
  })

  it('says the chains could not be read, tells the console why, and searches again on Try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('429')
    mocks.siblings.mockRejectedValueOnce(failure)
    await renderTab()
    expect(chainsCard()!.querySelector('[role="alert"]')?.textContent).toContain('Could not read the chains.')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chains'), { chainId: 8453, projectId: 23 }, failure)

    const retry = [...chainsCard()!.querySelectorAll('button')].find(button => button.textContent === 'Try again')!
    await act(async () => retry.click())
    await settle()
    expect(chainRows()).toHaveLength(3)
  })
})

describe('the chart', () => {
  it('plots Total stuck in the underlying token beside the active sticks, each captioned with its peak', async () => {
    await renderTab()
    expect(legend()).toEqual(['Total stuck', 'Active sticks'])
    expect(peaks()).toEqual(['Peak: 1 active stick', 'Peak: 1,010 SLOPSHOP stuck'])
    expect(chart()!.getAttribute('aria-label')).toBe('Active sticks and total stuck over time')
    expect(chart()!.textContent).not.toContain('STICKYSLOPSHOP')
    expect(mocks.creation).toHaveBeenCalledWith(8453, 23n, { signal: expect.any(AbortSignal) })
    expect(mocks.flows).toHaveBeenCalledWith(8453, 23n, 1_234n, { signal: expect.any(AbortSignal) })
  })

  it('steps each series where the history changes, each scaled to its own peak', async () => {
    await threeDays()
    expect(peaks()).toEqual(['Peak: 1 active stick', 'Peak: 1,010 SLOPSHOP stuck'])
    const [stuckLine, streaksLine] = [...chart()!.querySelectorAll('path')]
    // x runs from 34 to 630 over the three days, and y from 186 (nothing) to 20 (the peak).
    // Streaks: 0 until the stick's streak starts three days ago, then 1 until now.
    expect(streaksLine.getAttribute('d')).toBe('M 34.0 186.0 H 34.0 H 34.0 V 20.0 H 431.3 H 630.0')
    // Stuck: 1,010 three days ago, 606 from the unstick a day ago (606 of 1,010 is 0.6 of the height).
    expect(stuckLine.getAttribute('d')).toBe('M 34.0 186.0 H 34.0 V 20.0 H 34.0 H 431.3 V 86.4 H 630.0')
    expect(streaksLine.getAttribute('stroke')).toBe('#2fb3c7')
    expect(stuckLine.getAttribute('stroke')).toBe('#1c2d33')
  })

  it('says active sticks in the plural for more than one, in its caption and where it is pointed at', async () => {
    mocks.events.mockResolvedValue(
      history(
        stick(NOW - 3 * DAY, 1_000n * E18),
        event('streakStart', NOW - 3 * DAY),
        stick(NOW - 2 * DAY, 500n * E18),
        event('streakStart', NOW - 2 * DAY, { holder: SECOND }),
      ),
    )
    mocks.project.mockResolvedValue(slopshop({ totalSupply: 1_500n * E18, backing: 1_515n * E6, rawBacking: 1_515n * E6 }))
    mocks.flows.mockResolvedValue([
      { timestamp: NOW - 3 * DAY, delta: 1_010n * E6 },
      { timestamp: NOW - 2 * DAY, delta: 505n * E6 },
    ])
    await renderTab()
    expect(peaks()).toEqual(['Peak: 2 active sticks', 'Peak: 1,515 SLOPSHOP stuck'])
    await act(async () => chart()!.focus())
    expect(chart()!.querySelector('[data-hover]')?.textContent).toContain('2 active sticks')
  })

  it('dates a chart that spans less than two days by the hour and minute', async () => {
    mocks.events.mockResolvedValue(history(stick(NOW - 3 * 3_600, 1_000n * E18), event('streakStart', NOW - 3 * 3_600)))
    mocks.flows.mockResolvedValue([{ timestamp: NOW - 3 * 3_600, delta: 1_010n * E6 }])
    await renderTab()
    const time = (timestamp: number) =>
      new Date(timestamp * 1_000).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' })
    const labels = [...chart()!.querySelectorAll('text')].map(text)
    expect(labels).toContain(time(NOW - 3 * 3_600))
    // The three guides sit a quarter, a half and three quarters of the way.
    for (const fraction of [0.25, 0.5, 0.75]) expect(labels).toContain(time(NOW - 3 * 3_600 + fraction * 3 * 3_600))
  })

  it('falls back to the Sticky supply, in the Sticky symbol, and its labels say so, when the balance history cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('too many blocks to scan')
    mocks.flows.mockRejectedValue(failure)
    await renderTab()
    expect(legend()).toEqual(['Sticky supply', 'Active sticks'])
    expect(peaks()).toEqual(['Peak: 1 active stick', 'Peak: 1,000 STICKYSLOPSHOP supply'])
    expect(chart()!.getAttribute('aria-label')).toBe('Active sticks and Sticky supply over time')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('balance history'), { chainId: 8453, projectId: 23 }, failure)
  })

  it('scans from the deployer\'s block, and still plots Total stuck, when the creation block cannot be found', async () => {
    mocks.creation.mockResolvedValue(null)
    await renderTab()
    expect(mocks.flows).toHaveBeenCalledWith(8453, 23n, null, { signal: expect.any(AbortSignal) })
    expect(legend()).toEqual(['Total stuck', 'Active sticks'])
  })

  it('falls back to the Sticky supply when the creation block read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('down')
    mocks.creation.mockRejectedValue(failure)
    await renderTab()
    expect(legend()).toEqual(['Sticky supply', 'Active sticks'])
    expect(mocks.flows).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('balance history'), { chainId: 8453, projectId: 23 }, failure)
  })

  it('says there are no sticks yet, and draws no chart, for a project nobody has stuck in', async () => {
    mocks.events.mockResolvedValue(history(event('granter', NOW - DAY, { holder: SECOND, trusted: true })))
    await renderTab()
    expect(host.textContent).toContain('no sticks yet')
    expect(chart()).toBeNull()
  })

  it('draws a placeholder, not the Sticky supply, while the balance history is read', async () => {
    mocks.flows.mockReturnValue(new Promise(() => {}))
    await renderTab()
    expect(chart()).toBeNull()
    expect(host.querySelector('.skeleton-shimmer')).not.toBeNull()
    expect(legend()).toEqual(['Total stuck', 'Active sticks'])
  })

  it('stops pulsing its placeholder, and draws no chains, when the project itself cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.project.mockRejectedValue(new Error('429'))
    await renderTab()
    expect(chart()).toBeNull()
    const placeholder = host.querySelector('section .skeleton-shimmer')!
    expect(placeholder.className).toContain('[animation:none]')
    expect(chainsCard()).toBeNull()
    expect(detailsCard().querySelector('[role="alert"]')).not.toBeNull()
  })

  it('says the chart could not be drawn, and tells the console why, when the history is not one it can draw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A stick that lacks its share count: the lib refuses to guess it.
    mocks.events.mockResolvedValue(history(event('stick', NOW - DAY)))
    await renderTab()
    expect(chart()).toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not read the chart.')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('draw'), { chainId: 8453, projectId: 23 }, expect.any(TypeError))
  })

  it('tells the console once, from the page and not from its render, which a strict page runs twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.events.mockResolvedValue(history(event('stick', NOW - DAY)))
    await act(async () => root.render(<StrictMode>{inClient(<OverviewTab chainId={8453} projectId={23} />)}</StrictMode>))
    await settle()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not read the chart.')
    expect(warn.mock.calls.filter(([message]) => String(message).includes('draw'))).toHaveLength(1)
  })

  it('says the chart could not be read, and reads the history again on Try again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.events.mockRejectedValueOnce(new Error('429'))
    await renderTab()
    const note = [...host.querySelectorAll('[role="alert"]')].find(alert => alert.textContent?.includes('chart'))!
    expect(note.textContent).toContain('Could not read the chart.')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('history'), { chainId: 8453, projectId: 23 }, expect.any(Error))
    // The balance history of a project whose history cannot be read is not scanned.
    expect(mocks.flows).not.toHaveBeenCalled()
    await act(async () => [...note.querySelectorAll('button')].find(button => button.textContent === 'Try again')!.click())
    await settle()
    expect(peaks()).toEqual(['Peak: 1 active stick', 'Peak: 1,010 SLOPSHOP stuck'])
    expect(mocks.flows).toHaveBeenCalledTimes(1)
  })

  describe('pointing at it', () => {
    /** The plot is 640 units wide and 320 px on the page, its left edge at 100: a pointer at x is at unit 2(x - 100). */
    const plotted = async () => {
      await threeDays()
      chart()!.getBoundingClientRect = () => ({ left: 100, width: 320, top: 0, height: 105, right: 420, bottom: 105, x: 100, y: 0, toJSON: () => ({}) })
    }
    const at = (unit: number) => 100 + unit / 2
    /** The time at a unit of the plot: 34 is three days ago and 630 is now. */
    const timeAt = (unit: number) => NOW - 3 * DAY + ((unit - 34) / 596) * 3 * DAY
    const pointer = (type: string, clientX: number) =>
      act(async () => void chart()!.dispatchEvent(new PointerEvent(type, { clientX, bubbles: true })))
    const hover = () => chart()!.querySelector('[data-hover]')
    const date = (timestamp: number) =>
      new Date(timestamp * 1_000).toLocaleString(undefined, { month: 'short', day: 'numeric' })

    it('shows the date, the active sticks and the amount stuck at that time, and lets go when the pointer leaves', async () => {
      await plotted()
      expect(hover()).toBeNull()
      // Two days ago, or near it: 1,000 shares, 1,010 stuck.
      await pointer('pointermove', at(236))
      expect([...hover()!.querySelectorAll('text')].map(text)).toEqual([date(timeAt(236)), '1 active stick', '1,010 SLOPSHOP'])
      expect(chart()!.getAttribute('aria-label')).toBe(`${date(timeAt(236))}: 1 active stick; 1,010 SLOPSHOP`)

      // Past the unstick: 600 shares, 606 stuck. A pointer beyond the plot is held to its edge.
      await pointer('pointermove', at(640))
      expect([...hover()!.querySelectorAll('text')].map(text)).toEqual([date(NOW), '1 active stick', '606 SLOPSHOP'])
      await pointer('pointermove', at(0))
      expect([...hover()!.querySelectorAll('text')].map(text)).toEqual([date(NOW - 3 * DAY), '1 active stick', '1,010 SLOPSHOP'])

      await act(async () => void chart()!.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })))
      expect(hover()).toBeNull()
      expect(chart()!.getAttribute('aria-label')).toBe('Active sticks and total stuck over time')
    })

    it('shows nothing for a pointer while the plot has no width to measure it against', async () => {
      await threeDays()
      await pointer('pointermove', 150)
      expect(hover()).toBeNull()
    })

    it('shows the latest point when it takes focus, and hides it when it loses it', async () => {
      await plotted()
      await act(async () => chart()!.focus())
      expect([...hover()!.querySelectorAll('text')].map(text)).toEqual([date(NOW), '1 active stick', '606 SLOPSHOP'])
      await act(async () => chart()!.blur())
      expect(hover()).toBeNull()
    })

    it('keeps the card inside the plot: to the left of a pointer near the right edge', async () => {
      await plotted()
      await pointer('pointermove', at(600))
      expect(hover()!.querySelector('[data-card]')?.getAttribute('transform')).toBe('translate(438 25)')
      await pointer('pointermove', at(40))
      expect(hover()!.querySelector('[data-card]')?.getAttribute('transform')).toBe('translate(48 25)')
    })
  })
})

describe('leaving the page', () => {
  it('cancels the balance flows and the chains being read side by side, and tells the console of no failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const untilAborted = (signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
    const started: [string, AbortSignal][] = []
    mocks.flows.mockImplementation(async (_chainId: number, _projectId: bigint, _from: bigint | null, { signal }: { signal: AbortSignal }) => {
      started.push(['flows', signal])
      return untilAborted(signal)
    })
    mocks.siblings.mockImplementation((_info: StickyProjectInfo, { signal }: { signal: AbortSignal }) => {
      started.push(['chains', signal])
      return untilAborted(signal)
    })
    await renderTab()
    // Both are under way: the flows have their turn first, and read the creation block before the balance history.
    expect(started.map(([name]) => name).sort()).toEqual(['chains', 'flows'])
    await act(async () => root.unmount())
    root = createRoot(host)
    await settle()
    expect(started.every(([, signal]) => signal.aborted)).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('cancels the holders and Latest reads under way, and the reads that wait for them, and tells the console of no failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const started: AbortSignal[] = []
    // A read that answers only when it is cancelled. Its options come last: the holders' third, Latest's second.
    const hangs = (...args: unknown[]) =>
      new Promise<never>((_resolve, reject) => {
        const { signal } = args.at(-1) as { signal: AbortSignal }
        started.push(signal)
        signal.addEventListener('abort', () => reject(signal.reason))
      })
    mocks.holders.mockImplementation(hangs)
    mocks.moves.mockImplementation(hangs)
    await renderTab()
    // The holders are read beside the history, and Latest's amounts once the history is in: both are under way.
    expect(started).toHaveLength(2)
    expect(started.some(signal => signal.aborted)).toBe(false)

    await act(async () => root.unmount())
    root = createRoot(host)
    await settle()
    expect(started.every(signal => signal.aborted)).toBe(true)
    // Neither the balance flows nor the chains, which wait for both, ever start.
    expect(mocks.flows).not.toHaveBeenCalled()
    expect(mocks.siblings).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('cancels a search for the chains under way, and tells the console of no failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.siblings.mockImplementation(
      (_info: StickyProjectInfo, { signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
    )
    await renderTab()
    expect(mocks.siblings).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    root = createRoot(host)
    await settle()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('what the browser shows for a symbol that is markup', () => {
  it('renders every place a token\'s symbol or name appears as text, and creates no element from it', async () => {
    const name = `${XSS} name`
    mocks.project.mockImplementation(async (chainId: number) =>
      chainId === 10
        ? optimism({ symbol: XSS, stSymbol: XSS })
        : slopshop({ symbol: XSS, name, stSymbol: XSS, stName: name, plannedChains: [10, 8453, 42161] }),
    )
    mocks.events.mockResolvedValue(history(...stuck(), event('granter', NOW, { holder: SECOND, trusted: true })))
    await renderTab()

    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('[onerror]')).toBeNull()
    expect(value('Token')).toBe(`${name} (${XSS})`)
    expect(value('Sticks')).toBe(`${name} (${XSS})`)
    expect(value('Supply')).toBe(`1,000 ${XSS}`)
    expect(value('Backing')).toBe(`1,010 ${XSS}`)
    expect(contracts().map(([label]) => label)).toEqual([`${XSS} token`, `${XSS} token`, 'Stick accounting'])
    expect(copyButton(`${XSS} token`)).not.toBeNull()
    expect(peaks()).toEqual(['Peak: 1 active stick', `Peak: 1,010 ${XSS} stuck`])
    expect(chainRows()[1]).toEqual(['Optimism #5', `500 ${XSS}`, `400 ${XSS}`])
    expect(chainRows().at(-1)).toEqual(['Total', `1,510 ${XSS}`, `1,400 ${XSS}`])
    // The same on the fallback, where the chart is in the Sticky symbol.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.flows.mockRejectedValue(new Error('down'))
    await act(async () => void (await client.invalidateQueries({ queryKey: ['sticky-project', 8453, 23, 'flows'] })))
    await settle()
    expect(peaks()[1]).toBe(`Peak: 1,000 ${XSS} supply`)
    expect(host.querySelector('img')).toBeNull()
  })
})

describe('the reads behind the tab', () => {
  it('read the project\'s history once, for the chart and for the trusted senders', async () => {
    await renderTab()
    expect(mocks.events).toHaveBeenCalledTimes(1)
    expect(mocks.events).toHaveBeenCalledWith(8453, 23n, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(mocks.flows).toHaveBeenCalledTimes(1)
  })

  it('run the history beside the header\'s holders, then Latest, then the balance flows beside the chains: never more than two at once', async () => {
    const order: string[] = []
    let running = 0
    let most = 0
    const slow = <T,>(name: string, answer: T) => async () => {
      order.push(name)
      running += 1
      most = Math.max(most, running)
      await new Promise(resolve => setTimeout(resolve, 100))
      running -= 1
      return answer
    }
    mocks.events.mockImplementation(slow('history', history(...stuck())))
    mocks.holders.mockImplementation(slow('holders', { rows: [], source: 'indexed', degraded: null }))
    mocks.moves.mockImplementation(slow('moves', new Map()))
    mocks.flows.mockImplementation(slow('flows', paid))
    mocks.siblings.mockImplementation(slow('chains', [HERE, THERE]))
    // The pinned block takes longer than the holders' own read, and the holders are through once it is in.
    mocks.pinned.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
      return { number: 100n, timestamp: NOW }
    })
    await renderTab()
    await settle(2_000)
    // The chart's balance flows are the longest read, and the header's holders and Latest are not held up by them.
    expect(order.slice(0, 3)).toEqual(['history', 'holders', 'moves'])
    // The flows and the chains are read side by side, the flows in line first: they read the creation block first.
    expect(order.slice(3).sort()).toEqual(['chains', 'flows'])
    expect(mocks.creation.mock.invocationCallOrder[0]).toBeLessThan(mocks.siblings.mock.invocationCallOrder[0])
    expect(most).toBe(2)
    expect(peaks()).toEqual(['Peak: 1 active stick', 'Peak: 1,010 SLOPSHOP stuck'])
    expect(chainRows()).toHaveLength(3)
  })

  it('draw the chart, and search for the chains, when the header\'s holders and Latest cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.holders.mockRejectedValue(new Error('429'))
    mocks.moves.mockRejectedValue(new Error('429'))
    await renderTab()
    expect(peaks()).toEqual(['Peak: 1 active stick', 'Peak: 1,010 SLOPSHOP stuck'])
    expect(chainRows()).toHaveLength(3)
  })

  it('read the balance flows again without reading the history, the holders or Latest again for it', async () => {
    await renderTab()
    await settle(60_000)
    await act(async () => void (await client.invalidateQueries({ queryKey: ['sticky-project', 8453, 23, 'flows'] })))
    await settle()
    expect(mocks.flows).toHaveBeenCalledTimes(2)
    for (const read of [mocks.events, mocks.holders, mocks.moves]) expect(read).toHaveBeenCalledTimes(1)
  })

  it('read nothing of the project\'s history when the project cannot be read, and read it once it can', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.project.mockRejectedValue(new Error('Project 23 is not a Sticky token of this deployer.'))
    await renderTab()
    await settle(60_000)
    // One read of the project, never a scan: not the history, the holders, Latest, the balance flows or the chains.
    expect(mocks.project).toHaveBeenCalledTimes(1)
    for (const read of [mocks.events, mocks.holders, mocks.pinned, mocks.moves, mocks.creation, mocks.flows, mocks.siblings]) {
      expect(read).not.toHaveBeenCalled()
    }
    expect(chart()).toBeNull()
    expect(chainsCard()).toBeNull()

    mocks.project.mockImplementation(async (chainId: number) => (chainId === 10 ? optimism() : slopshop()))
    const retry = [...detailsCard().querySelectorAll('button')].find(button => button.textContent === 'Try again')!
    await act(async () => retry.click())
    await settle()
    for (const read of [mocks.events, mocks.holders, mocks.moves, mocks.creation, mocks.flows, mocks.siblings]) {
      expect(read).toHaveBeenCalledTimes(1)
    }
    expect(peaks()).toEqual(['Peak: 1 active stick', 'Peak: 1,010 SLOPSHOP stuck'])
    expect(chainRows()).toHaveLength(3)
  })

  it('read the history of a project that an earlier visit read, before this visit\'s read of it answers', async () => {
    const storage = memoryStorage()
    const earlier = newClient()
    const stop = installQueryPersistence(earlier, storage)
    await renderTab(earlier)
    await settle(1_000)
    stop()
    await act(async () => root.unmount())
    root = createRoot(host)
    // A minute later, what was kept of the chains is no longer fresh.
    await settle(60_000)
    for (const read of [mocks.events, mocks.holders, mocks.flows, mocks.siblings]) read.mockClear()

    // The copy the browser kept names a Sticky project, which is all the history and the holders wait for. Latest, which
    // the balance flows and the chains wait behind, waits for this visit's read.
    const read = Promise.withResolvers<StickyProjectInfo>()
    mocks.project.mockReset().mockReturnValue(read.promise)
    const now = newClient()
    installQueryPersistence(now, storage)
    await renderTab(now)
    for (const each of [mocks.events, mocks.holders]) expect(each).toHaveBeenCalledTimes(1)
    for (const each of [mocks.flows, mocks.siblings]) expect(each).not.toHaveBeenCalled()

    await act(async () => read.resolve(slopshop()))
    await settle()
    for (const each of [mocks.flows, mocks.siblings]) expect(each).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['balance history', () => mocks.flows.mockRejectedValue(new Error('429')), () => mocks.flows],
    ['search for the chains', () => mocks.siblings.mockRejectedValue(new Error('429')), () => mocks.siblings],
  ])('read a failing %s once, with the site\'s own query defaults', async (_what, fail, read) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    fail()
    const site = siteClient()
    await renderTab(site)
    await settle(120_000)
    expect(read()).toHaveBeenCalledTimes(1)
    site.clear()
  })

  it('take their turn with every other read of the page: the flows and the chains wait while two are under way', async () => {
    await renderTab()
    // Two reads of another tab are under way, and hold both turns.
    const done = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    for (const read of done) void inTurn(client, new AbortController().signal, () => read.promise)
    // The reads are invalidated, and are under way but not started: what an invalidation waits for is not over.
    await act(async () => {
      void client.invalidateQueries({ queryKey: ['sticky-project', 8453, 23, 'flows'] })
      void client.invalidateQueries({ queryKey: ['sticky-project', 8453, 23, 'siblings'] })
    })
    await settle()
    expect([mocks.creation, mocks.flows, mocks.siblings].map(read => read.mock.calls.length)).toEqual([1, 1, 1])

    // When one of them ends, they are read in the turn it leaves, the flows first.
    await act(async () => done[0].resolve())
    await settle()
    expect([mocks.creation, mocks.flows, mocks.siblings].map(read => read.mock.calls.length)).toEqual([2, 2, 2])
    expect(mocks.flows.mock.invocationCallOrder[1]).toBeLessThan(mocks.siblings.mock.invocationCallOrder[1])
    await act(async () => done[1].resolve())
  })

  it('wait for a retry of the header\'s Latest, and read the flows and the chains again only once they have gone stale', async () => {
    await renderTab()
    const latest = ['sticky-project', 8453, 23, 'latest']
    // A retry of Latest while what was read is fresh: only Latest is read again.
    await act(async () => void (await client.invalidateQueries({ queryKey: latest })))
    await settle()
    expect(mocks.moves).toHaveBeenCalledTimes(2)
    expect([mocks.flows, mocks.siblings].map(read => read.mock.calls.length)).toEqual([1, 1])

    // A minute on, the flows and the chains are stale, and are read again once Latest is.
    await settle(60_000)
    await act(async () => void (await client.invalidateQueries({ queryKey: latest })))
    await settle()
    expect(mocks.moves).toHaveBeenCalledTimes(3)
    expect([mocks.flows, mocks.siblings].map(read => read.mock.calls.length)).toEqual([2, 2])
    // The holders, which nothing invalidated, were read once.
    expect(mocks.holders).toHaveBeenCalledTimes(1)
  })

  it('show the details at once, before the history and the chains are read', async () => {
    mocks.events.mockReturnValue(new Promise(() => {}))
    await renderTab()
    expect(value('Supply')).toBe('1,000 STICKYSLOPSHOP')
    expect(mocks.flows).not.toHaveBeenCalled()
    expect(mocks.siblings).not.toHaveBeenCalled()
  })

  it('search for the chains even when the history cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.events.mockRejectedValue(new Error('429'))
    await renderTab()
    expect(chainRows()).toHaveLength(3)
    expect(rules().filter(Boolean)).toHaveLength(2)
  })

  it('drop what they showed when the page names another project, even when its read lands late', async () => {
    const first = Promise.withResolvers<StickyProjectInfo>()
    mocks.project.mockImplementation(async (_chainId: number, projectId: bigint) =>
      projectId === 23n ? first.promise : slopshop({ projectId, stSymbol: `STICKY${projectId}` }),
    )
    mocks.siblings.mockImplementation(async (info: StickyProjectInfo) => [{ chainId: info.chainId, projectId: info.projectId, self: true }])
    await renderTab()
    await act(async () => root.render(inClient(<OverviewTab chainId={8453} projectId={24} />)))
    await settle()
    expect(value('Token')).toBe('Sticky Slop Shop (STICKY24)')

    await act(async () => first.resolve(slopshop()))
    await settle()
    expect(value('Token')).toBe('Sticky Slop Shop (STICKY24)')
    expect(host.textContent).not.toContain('STICKYSLOPSHOP')
  })
})

describe('what the browser keeps', () => {
  it('shows the details and the chains of the last visit at once, unconfirmed until this visit reads them again', async () => {
    const storage = memoryStorage()
    // An earlier visit read the project, and the browser kept its details and chains.
    const earlier = newClient()
    const stop = installQueryPersistence(earlier, storage)
    await renderTab(earlier)
    await settle(1_000)
    stop()
    await act(async () => root.unmount())
    root = createRoot(host)
    // A minute later: what was read is no longer fresh.
    await settle(60_000)

    // This visit: none of the reads has answered yet.
    for (const read of [mocks.project, mocks.events, mocks.siblings]) read.mockReset().mockReturnValue(new Promise(() => {}))
    const now = newClient()
    installQueryPersistence(now, storage)
    await renderTab(now)

    expect(value('Supply')).toBe('1,000 STICKYSLOPSHOP')
    expect(revalidating(detailsCard())).not.toBeNull()
    expect(chainRows()).toEqual([
      ['Base #23 (this page)', '1,010 SLOPSHOP', '1,000 STICKYSLOPSHOP'],
      ['Optimism #5', '500 SLOPSHOP', '400 STICKYSLOPSHOP'],
      ['Total', '1,510 SLOPSHOP', '1,400 STICKYSLOPSHOP'],
    ])
    expect(revalidating(chainsCard())).not.toBeNull()
    // What grows with the project's history is not kept: the chart waits for this visit's.
    expect(chart()).toBeNull()
  })

  it('keeps a chain that could not be read as its reason in text, not as the error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const storage = memoryStorage()
    const down = Object.assign(new Error('down'), { details: 'x'.repeat(10_000) })
    mocks.siblings.mockResolvedValue([HERE, { chainId: 10, error: down }, { chainId: 42161, error: 'not an error object' }])
    const stop = installQueryPersistence(client, storage)
    await renderTab()
    await settle(1_000)
    stop()
    const kept = storage.getItem('sticky:query-cache:v1')!
    expect(kept).toContain('"error":"down"')
    expect(kept).toContain('"error":"not an error object"')
    expect(kept).not.toContain('xxxxxxxxxx')
  })

  it('keeps the details and the chains, and nothing of the history the chart is drawn from', async () => {
    const storage = memoryStorage()
    const stop = installQueryPersistence(client, storage)
    await renderTab()
    await settle(1_000)
    stop()
    const kept = storage.getItem('sticky:query-cache:v1')!
    expect(kept).toContain('"info"')
    expect(kept).toContain('"siblings"')
    expect(kept).not.toContain('"events"')
    expect(kept).not.toContain('"flows"')
    expect(kept).not.toContain('"holders"')
  })

  it('draws the chart from a kept copy of the project as unconfirmed, until this visit has read the project', async () => {
    const storage = memoryStorage()
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
    expect(peaks()).toEqual(['Peak: 1 active stick', 'Peak: 1,010 SLOPSHOP stuck'])
    expect(revalidating(chart())).not.toBeNull()
    await act(async () => read.resolve(slopshop()))
    await settle()
    expect(revalidating(chart())).toBeNull()
  })

  it('shows the details unconfirmed only until this visit has read the project', async () => {
    const storage = memoryStorage()
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
    expect(revalidating(detailsCard())).not.toBeNull()
    await act(async () => read.resolve(slopshop({ totalSupply: 2_000n * E18 })))
    await settle()
    expect(revalidating(detailsCard())).toBeNull()
    expect(value('Supply')).toBe('2,000 STICKYSLOPSHOP')
  })
})

describe('the project page', () => {
  it('opens on the Overview tab, with this project\'s chart, details and chains', async () => {
    const page = (await ProjectPage({ params: Promise.resolve({ urn: 'base:23' }), searchParams: Promise.resolve({}) })) as ReactElement<{
      children: ReactElement<{ tabs?: TabDef[] }>[]
    }>
    const tabs = page.props.children.find(child => child.type === ProjectTabs)!.props.tabs!
    expect(tabs.map(tab => tab.label)).toEqual(['Overview', 'Tokens', 'Airdrops'])
    const overview = tabs[0].content as ReactElement
    expect(overview.type).toBe(OverviewTab)
    expect(overview.props).toEqual({ chainId: 8453, projectId: 23 })
  })
})
