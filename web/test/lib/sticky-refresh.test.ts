// @vitest-environment node

import { QueryClient, type QueryKey } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshStickyProject } from '@/lib/sticky-refresh'

// What a write to a Sticky project has read again, and when. The keys are the ones the project page's hooks use
// (src/hooks/useStickyProject.ts, useStickyOverview.ts, useStickyTokens.ts, useStickyAirdrops.ts, useStickyAccount.ts).

const HOLDER = `0x${'a'.repeat(40)}`
const CHAIN = 8453

/** Keys a stick changes: [chain, project] is this project's. */
const REFRESHED: QueryKey[] = [
  ['sticky-project', CHAIN, 23, 'info', 'v1'],
  ['sticky-project', CHAIN, 23, 'events'],
  ['sticky-project', CHAIN, 23, 'holders'],
  ['sticky-project', CHAIN, 23, 'sticks', 'v1'],
  ['sticky-project', CHAIN, 23, 'latest', 'v1'],
  ['sticky-project', CHAIN, 23, 'page-balances', [HOLDER]],
  ['sticky-position', CHAIN, 23, HOLDER],
  ['sticky-tranches', CHAIN, 23, HOLDER, 0, '100'],
  ['sticky-rewards', CHAIN, 23, HOLDER, '0:0x1'],
  ['sticky-account', 'mainnet', HOLDER, 'index'],
  ['sticky-account', 'mainnet', HOLDER, 'positions', CHAIN],
  ['sticky-account', 'mainnet', HOLDER, 'activity', CHAIN],
]

/** Keys it leaves alone: the Overview's scans, the airdrops' pots, another project's page, every list of projects. */
const LEFT: QueryKey[] = [
  ['sticky-project', CHAIN, 23, 'flows'],
  ['sticky-project', CHAIN, 23, 'siblings', 'v1'],
  ['sticky-project', CHAIN, 23, 'funding'],
  ['sticky-project', CHAIN, 24, 'info', 'v1'],
  ['sticky-project', 10, 23, 'info', 'v1'],
  ['sticky-position', CHAIN, 24, HOLDER],
  ['sticky-autostick', CHAIN, 23, HOLDER, '0'],
  ['sticky-trusted', CHAIN, 23, HOLDER, ''],
  ['sticky-account', 'mainnet', 'deployed', CHAIN],
  ['sticky-home', 'mainnet', 'index'],
]

let client: QueryClient
beforeEach(() => {
  vi.useFakeTimers()
  client = new QueryClient()
  for (const key of [...REFRESHED, ...LEFT]) client.setQueryData(key, 'read')
})
afterEach(() => {
  client.clear()
  vi.useRealTimers()
})

const invalidated = (keys: QueryKey[]) => keys.filter(key => client.getQueryState(key)?.isInvalidated)
/** Marks everything read again, as a refetch would. */
const readAgain = () => [...REFRESHED, ...LEFT].forEach(key => client.setQueryData(key, 'read'))

describe('refreshStickyProject', () => {
  it('invalidates what a write changed at once, and nothing else', () => {
    refreshStickyProject(client, CHAIN, 23)
    expect(invalidated(REFRESHED)).toEqual(REFRESHED)
    expect(invalidated(LEFT)).toEqual([])
  })

  it('does it again after 4 seconds and after 12, and then stops', async () => {
    refreshStickyProject(client, CHAIN, 23)
    readAgain()

    await vi.advanceTimersByTimeAsync(3_999)
    expect(invalidated(REFRESHED)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(invalidated(REFRESHED)).toEqual(REFRESHED)
    readAgain()

    await vi.advanceTimersByTimeAsync(7_999)
    expect(invalidated(REFRESHED)).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(invalidated(REFRESHED)).toEqual(REFRESHED)
    readAgain()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(invalidated([...REFRESHED, ...LEFT])).toEqual([])
    expect(invalidated(LEFT)).toEqual([])
  })
})
