import { getAddress, type Address, type Hex } from 'viem'
import type { FeedRow } from '@/lib/sticky-feed'
import type { HomeCard, HomeChain } from '@/lib/sticky-home'
import type { StickyProjectInfo } from '@/lib/sticky-project'

// The home's fixtures, shared by its read model's, its hook's and its components' tests. A test sets the fields its
// expectations rest on and leaves the rest to these.

export const E18 = 10n ** 18n
export const E6 = 10n ** 6n
export const TOKEN = getAddress(`0x${'2'.repeat(40)}`)
export const HOLDER = `0x${'a'.repeat(40)}` as Address

/** A Sticky project as `readStickyProject` gives it: one share backed by one CPN, a 10% bonus, transferable, and
 * launched on its own. */
export function stickyInfo(
  chainId: number,
  projectId: bigint,
  extra: Partial<StickyProjectInfo> = {},
): StickyProjectInfo {
  return {
    chainId,
    projectId,
    stToken: `0x${'5'.repeat(40)}`,
    stSymbol: 'STK',
    stName: 'Sticky CPN',
    stakedToken: TOKEN,
    symbol: 'CPN',
    name: 'Coupon',
    decimals: 18,
    cashOutTaxRate: 1_000n,
    soulbound: false,
    totalSupply: E18,
    backing: E18,
    orphaned: 0n,
    rawBacking: E18,
    savedOrphaned: 0n,
    launchId: null,
    plannedChains: null,
    blockNumber: 1n,
    ...extra,
  }
}

export const homeCard = (
  chainId: number,
  projectId: bigint,
  extra: Partial<StickyProjectInfo> = {},
  sticks = 1,
): HomeCard => ({ info: stickyInfo(chainId, projectId, extra), sticks })

/** A chain's part of the home, with its cards and nothing else unless `extra` says so. */
export const homeChainOf = (chainId: number, cards: HomeCard[] = [], extra: Partial<HomeChain> = {}): HomeChain => ({
  chainId,
  cards,
  activity: [],
  airdrops: [],
  supply: [],
  ...extra,
})

let rows = 0

/** A feed row: one CPN stuck by HOLDER, in a transaction of its own. */
export function feedRow(chainId: number, projectId: bigint, timestamp: number, extra: Partial<FeedRow> = {}): FeedRow {
  rows += 1
  return {
    chainId,
    projectId,
    timestamp,
    txHash: `0x${rows.toString(16).padStart(64, '0')}` as Hex,
    logIndex: 0,
    direction: 'in',
    amount: { value: E18, decimals: 18, symbol: 'CPN' },
    line: { kind: 'stuck', holder: HOLDER },
    ...extra,
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

/** A Storage that lives in memory, for the persister. */
export function memoryStorage(): Storage {
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
