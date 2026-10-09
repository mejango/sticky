// @vitest-environment node

import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query'
import { getAddress } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REFRESH_AFTER_MS,
  refreshAfterAutoStick,
  refreshAfterCollect,
  refreshAfterConfirmedWrite,
  refreshAfterFund,
  refreshAfterReceiver,
  refreshAfterRewardStick,
  refreshAfterSettle,
  refreshAfterStick,
  refreshAfterTransfer,
  refreshAfterTrust,
  refreshAfterUnstick,
} from '@/lib/sticky-refresh'

// What each confirmed send reads again, and when, among keys written out as the hooks read under them
// (src/hooks/useStickyProject.ts, useStickyOverview.ts, useStickyTokens.ts, useStickyAirdrops.ts, useStickyAccount.ts).
// test/hooks/refresh-keys.test.tsx asks the same of the hooks' own queries.

const CHAIN = 8453
const HOLDER = getAddress(`0x${'ab'.repeat(20)}`)
const OTHER = getAddress(`0x${'cd'.repeat(20)}`)

/** The reads of project 23 on Base, of the holder and of another account, and some of other pages. The holder's
 * tranches are keyed in lowercase: a refresh for one holder finds their reads in any case. */
const KEYS: Record<string, QueryKey> = {
  info: ['sticky-project', CHAIN, 23, 'info', 'v1'],
  events: ['sticky-project', CHAIN, 23, 'events'],
  holders: ['sticky-project', CHAIN, 23, 'holders'],
  sticks: ['sticky-project', CHAIN, 23, 'sticks', 'v1'],
  latest: ['sticky-project', CHAIN, 23, 'latest', 'v1'],
  'page balances': ['sticky-project', CHAIN, 23, 'page-balances', [HOLDER]],
  flows: ['sticky-project', CHAIN, 23, 'flows'],
  funding: ['sticky-project', CHAIN, 23, 'funding'],
  receiver: ['sticky-project', CHAIN, 23, 'receiver', '4000'],
  arrivals: ['sticky-project', CHAIN, 23, 'receiver', 'arrivals', '0x8', '0x2'],
  position: ['sticky-position', CHAIN, 23, HOLDER],
  tranches: ['sticky-tranches', CHAIN, 23, HOLDER.toLowerCase(), 0, '100'],
  rewards: ['sticky-rewards', CHAIN, 23, HOLDER, '0:0x1'],
  'auto-stick': ['sticky-autostick', CHAIN, 23, HOLDER, '0'],
  trusted: ['sticky-trusted', CHAIN, 23, HOLDER, ''],
  "another's position": ['sticky-position', CHAIN, 23, OTHER],
  "another's tranches": ['sticky-tranches', CHAIN, 23, OTHER, 0, '100'],
  "another's rewards": ['sticky-rewards', CHAIN, 23, OTHER, '0:0x1'],
  "another's auto-stick": ['sticky-autostick', CHAIN, 23, OTHER, '0'],
  "another's trusted": ['sticky-trusted', CHAIN, 23, OTHER, ''],
  'account index': ['sticky-account', 'mainnet', HOLDER.toLowerCase(), 'index'],
  'account positions': ['sticky-account', 'mainnet', HOLDER.toLowerCase(), 'positions', CHAIN],
  'account activity': ['sticky-account', 'testnet', HOLDER.toLowerCase(), 'activity', 84532],
  "another's account": ['sticky-account', 'mainnet', OTHER.toLowerCase(), 'positions', CHAIN],
  "a chain's projects": ['sticky-account', 'mainnet', 'deployed', CHAIN],
  'another project': ['sticky-project', CHAIN, 24, 'info', 'v1'],
  'another chain': ['sticky-project', 10, 23, 'info', 'v1'],
  "another project's position": ['sticky-position', CHAIN, 24, HOLDER],
  home: ['sticky-home', 'mainnet', 'index'],
}

const PAGE = ['info', 'events', 'holders', 'sticks', 'latest', 'page balances']
const ACCOUNT = ['account index', 'account positions', 'account activity']

const SCOPES: [string, (client: QueryClient) => void, string[]][] = [
  [
    'a stick: the page, every account\'s stick, tranches and rewards in the project, and the account pages but a chain\'s projects',
    client => refreshAfterStick(client, CHAIN, 23),
    [
      ...PAGE,
      'position',
      'tranches',
      'rewards',
      "another's position",
      "another's tranches",
      "another's rewards",
      ...ACCOUNT,
      "another's account",
    ],
  ],
  [
    "an unstick: the page, and the holder's own stick, tranches, rewards, auto-stick and account page",
    client => refreshAfterUnstick(client, CHAIN, 23, HOLDER),
    [...PAGE, 'position', 'tranches', 'rewards', 'auto-stick', ...ACCOUNT],
  ],
  [
    "a change of auto-stick: the holder's auto-stick and who they trust",
    client => refreshAfterAutoStick(client, CHAIN, 23, HOLDER),
    ['auto-stick', 'trusted'],
  ],
  [
    'a transfer: the page but its figures, every account\'s stick, tranches and rewards in the project, and the account pages',
    client => refreshAfterTransfer(client, CHAIN, 23),
    [
      ...PAGE.filter(read => read !== 'info'),
      'position',
      'tranches',
      'rewards',
      "another's position",
      "another's tranches",
      "another's rewards",
      ...ACCOUNT,
      "another's account",
    ],
  ],
  [
    'a change of trust: the history, and every account\'s trusted senders and auto-stick in the project',
    client => refreshAfterTrust(client, CHAIN, 23),
    ['events', 'auto-stick', 'trusted', "another's auto-stick", "another's trusted"],
  ],
  [
    "a collect: the holder's own rewards, auto-stick and stick, whose wallet it pays",
    client => refreshAfterCollect(client, CHAIN, 23, HOLDER),
    ['position', 'rewards', 'auto-stick'],
  ],
  [
    "a stick of rewards: the page, and the holder's own stick, tranches, rewards, auto-stick, trusted senders and account page",
    client => refreshAfterRewardStick(client, CHAIN, 23, HOLDER),
    [...PAGE, 'position', 'tranches', 'rewards', 'auto-stick', 'trusted', ...ACCOUNT],
  ],
  [
    "an airdrop: the pots, every account's rewards and auto-stick in the project, and what the funder holds",
    client => refreshAfterFund(client, CHAIN, 23, HOLDER),
    ['funding', 'position', 'rewards', 'auto-stick', "another's rewards", "another's auto-stick"],
  ],
  [
    'a reward address created: the reward addresses and what they hold',
    client => refreshAfterReceiver(client, CHAIN, 23),
    ['receiver', 'arrivals'],
  ],
  [
    "a settle: the pots, every account's rewards and auto-stick in the project, and the reward addresses",
    client => refreshAfterSettle(client, CHAIN, 23),
    ['funding', 'receiver', 'arrivals', 'rewards', 'auto-stick', "another's rewards", "another's auto-stick"],
  ],
]

/** The refreshes after a send that adds a pot, which read the pots again. */
const FUNDING = new Set(SCOPES.filter(([, , expected]) => expected.includes('funding')).map(([, refresh]) => refresh))

let client: QueryClient
beforeEach(() => {
  vi.useFakeTimers()
  client = new QueryClient()
  readAgain()
})
afterEach(() => {
  client.clear()
  vi.useRealTimers()
})

/** The names of the keys that are invalidated, in the order of KEYS. */
const invalidated = () => Object.keys(KEYS).filter(name => client.getQueryState(KEYS[name])?.isInvalidated)
/** Marks everything read again, as a refetch would. */
function readAgain() {
  for (const key of Object.values(KEYS)) client.setQueryData(key, 'read')
}
/** `names` in the order of KEYS. */
const inOrder = (names: string[]) => Object.keys(KEYS).filter(name => names.includes(name))

describe('the refresh after a send', () => {
  it.each(['scheduled', 'detached'] as const)('%s refresh discards an initial old read and leaves unrelated reads running', async mode => {
    client.removeQueries({ queryKey: KEYS.info })
    client.removeQueries({ queryKey: KEYS['another chain'] })
    let finishOld!: (value: string) => void
    let finishOther!: (value: string) => void
    const options = {
      queryKey: KEYS.info,
      staleTime: 30_000,
      queryFn: vi.fn()
        .mockImplementationOnce(() => new Promise<string>(resolve => { finishOld = resolve }))
        .mockResolvedValue('confirmed'),
    }
    const old = client.fetchQuery(options).catch(() => undefined)
    const other = client.fetchQuery({
      queryKey: KEYS['another chain'],
      queryFn: () => new Promise<string>(resolve => { finishOther = resolve }),
    })

    if (mode === 'scheduled') refreshAfterStick(client, CHAIN, 23)
    else refreshAfterConfirmedWrite(client, CHAIN)
    await vi.advanceTimersByTimeAsync(0)

    expect(client.getQueryState(KEYS.info)?.fetchStatus).toBe('idle')
    expect(client.getQueryState(KEYS.info)?.isInvalidated).toBe(true)
    expect(client.getQueryState(KEYS['another chain'])?.fetchStatus).toBe('fetching')
    expect(options.queryFn).toHaveBeenCalledTimes(1)
    expect(await client.fetchQuery(options)).toBe('confirmed')
    finishOld('before confirmation')
    finishOther('other chain')
    await old
    expect(await other).toBe('other chain')
    expect(client.getQueryData(KEYS.info)).toBe('confirmed')
  })

  it('marks a detached confirmed write\'s chain stale without refetching or discarding other chains and histories', async () => {
    const extra: Record<string, QueryKey> = {
      'home latest': ['sticky-home', 'mainnet', 'latest'],
      'home chain': ['sticky-home', 'mainnet', 'chain', CHAIN, 'v1'],
      'home history': ['sticky-home', 'mainnet', 'history', CHAIN],
      'home prices': ['sticky-home', 'mainnet', 'prices', CHAIN, []],
      'other home chain': ['sticky-home', 'mainnet', 'chain', 10, 'v1'],
      'other home network': ['sticky-home', 'testnet', 'index'],
      'other account chain': ['sticky-account', 'mainnet', HOLDER, 'positions', 10],
      'other account network': ['sticky-account', 'testnet', HOLDER, 'index'],
      unrelated: ['some-other-query', CHAIN],
    }
    for (const key of Object.values(extra)) client.setQueryData(key, 'read')
    const queryFn = vi.fn(async () => 'new')
    const observer = new QueryObserver(client, { queryKey: KEYS.info, queryFn, staleTime: Infinity })
    const stop = observer.subscribe(() => {})

    refreshAfterConfirmedWrite(client, CHAIN)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(invalidated()).toEqual(inOrder([
      ...PAGE, 'funding', 'receiver', 'arrivals',
      'position', 'tranches', 'rewards', 'auto-stick', 'trusted',
      "another's position", "another's tranches", "another's rewards", "another's auto-stick", "another's trusted",
      'account index', 'account positions', "another's account", 'another project', "another project's position", 'home',
    ]))
    expect(Object.keys(extra).filter(name => client.getQueryState(extra[name])?.isInvalidated)).toEqual([
      'home latest', 'home chain',
    ])
    expect(queryFn).not.toHaveBeenCalled()
    for (const key of [...Object.values(KEYS), ...Object.values(extra)]) expect(client.getQueryData(key)).toBe('read')
    stop()
  })

  it('reads again now, at +4 s and at +12 s', () => {
    expect(REFRESH_AFTER_MS).toEqual([0, 4_000, 12_000])
  })

  it.each(SCOPES)('after %s, and nothing else', async (_what, refresh, expected) => {
    expect(expected.every(name => name in KEYS)).toBe(true)
    refresh(client)
    await vi.advanceTimersByTimeAsync(0)
    expect(invalidated()).toEqual(inOrder(expected))
    readAgain()

    await vi.advanceTimersByTimeAsync(3_999)
    expect(invalidated()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(invalidated()).toEqual(inOrder(expected))
    readAgain()

    await vi.advanceTimersByTimeAsync(7_999)
    expect(invalidated()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(invalidated()).toEqual(inOrder(expected))
    readAgain()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(invalidated()).toEqual([])
  })

  it("never reads a project's whole page again, nor another project's, another chain's or the home", async () => {
    for (const [, refresh] of SCOPES) refresh(client)
    await vi.advanceTimersByTimeAsync(0)
    const untouched = ['flows', 'another project', 'another chain', "another project's position", 'home']
    expect(invalidated().filter(name => untouched.includes(name))).toEqual([])
  })

  it('reads the pots again only after a send that adds one', async () => {
    for (const [, refresh] of SCOPES) if (!FUNDING.has(refresh)) refresh(client)
    await vi.advanceTimersByTimeAsync(0)
    expect(invalidated()).not.toContain('funding')
  })

  it("reads again only the holder's own reads after an unstick, not another account's", async () => {
    refreshAfterUnstick(client, CHAIN, 23, OTHER)
    await vi.advanceTimersByTimeAsync(0)
    expect(invalidated()).toEqual(
      inOrder([...PAGE, "another's position", "another's tranches", "another's rewards", "another's auto-stick", "another's account"]),
    )
  })
})
