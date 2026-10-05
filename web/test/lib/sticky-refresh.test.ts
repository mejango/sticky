// @vitest-environment node

import { QueryClient, type QueryKey } from '@tanstack/react-query'
import { getAddress } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REFRESH_AFTER_MS,
  refreshAfterAutoStick,
  refreshAfterCollect,
  refreshAfterFund,
  refreshAfterRewardStick,
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
  siblings: ['sticky-project', CHAIN, 23, 'siblings', 'v1'],
  funding: ['sticky-project', CHAIN, 23, 'funding'],
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
]

/** The refreshes after a send that adds a pot, which read the pots again. */
const FUNDING = new Set<(typeof SCOPES)[number][1]>([SCOPES[SCOPES.length - 1][1]])

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
  it('reads again now, at +4 s and at +12 s', () => {
    expect(REFRESH_AFTER_MS).toEqual([0, 4_000, 12_000])
  })

  it.each(SCOPES)('after %s, and nothing else', async (_what, refresh, expected) => {
    expect(expected.every(name => name in KEYS)).toBe(true)
    refresh(client)
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

  it("never reads a project's whole page again, nor another project's, another chain's or the home", () => {
    for (const [, refresh] of SCOPES) refresh(client)
    const untouched = ['flows', 'siblings', 'another project', 'another chain', "another project's position", 'home']
    expect(invalidated().filter(name => untouched.includes(name))).toEqual([])
  })

  it('reads the pots again only after a send that adds one', () => {
    for (const [, refresh] of SCOPES) if (!FUNDING.has(refresh)) refresh(client)
    expect(invalidated()).not.toContain('funding')
  })

  it("reads again only the holder's own reads after an unstick, not another account's", () => {
    refreshAfterUnstick(client, CHAIN, 23, OTHER)
    expect(invalidated()).toEqual(
      inOrder([...PAGE, "another's position", "another's tranches", "another's rewards", "another's auto-stick", "another's account"]),
    )
  })
})
