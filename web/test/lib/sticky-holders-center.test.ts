import { toHex, type Address, type Hex, type PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import { stickyHolders } from '@/lib/sticky-holders'
import {
  CHAIN,
  CREATED,
  HOLDER,
  HOOK,
  OTHER,
  POSITION_TOPICS,
  staked,
  streakStarted,
  timeAt,
  topic,
} from './sticky-log-fixtures'

// The reads stickyHolders makes when a caller gives it none: Bendystraw's positions, the hook through Center's log
// scanner, which runs for real here, and stickyEvents for the fallback. Center is a fake client that answers from a
// list of logs.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))
const bendystraw = vi.hoisted(() => ({ positions: vi.fn() }))
vi.mock('@/lib/sticky-indexed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-indexed')>()),
  indexedStickyPositions: bendystraw.positions,
}))
const history = vi.hoisted(() => ({ events: vi.fn() }))
vi.mock('@/lib/sticky-events', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-events')>()),
  stickyEvents: history.events,
}))

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

type Filter = { address: Address; topics: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex }

/** A log as a node writes it on the wire. */
const rpcLog = (entry: ScannedLog) => ({
  address: entry.address,
  blockHash: entry.blockHash,
  blockNumber: toHex(entry.blockNumber),
  ...(entry.blockTimestamp === undefined ? {} : { blockTimestamp: toHex(entry.blockTimestamp) }),
  data: entry.data,
  logIndex: toHex(entry.logIndex),
  removed: false,
  topics: entry.topics,
  transactionHash: entry.transactionHash,
  transactionIndex: toHex(entry.transactionIndex),
})

function matches(entry: ScannedLog, { address, topics, fromBlock, toBlock }: Filter): boolean {
  const inRange = entry.blockNumber >= BigInt(fromBlock) && entry.blockNumber <= BigInt(toBlock)
  const topicsMatch = topics.every(
    (wanted, i) =>
      wanted === null || (Array.isArray(wanted) ? wanted.includes(entry.topics[i]!) : wanted === entry.topics[i]),
  )
  return entry.address.toLowerCase() === address.toLowerCase() && inRange && topicsMatch
}

/** Center, as the one client every chain read goes through. `requests` lists each eth_getLogs filter sent. */
function node(head: bigint, logs: ScannedLog[] = []) {
  const requests: Filter[] = []
  const client = {
    getBlockNumber: vi.fn(async () => head),
    request: vi.fn(async ({ method, params }: { method: string; params: [Filter] }, _options?: unknown) => {
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`)
      requests.push(params[0])
      return logs.filter(entry => matches(entry, params[0])).map(rpcLog)
    }),
  }
  center.client.mockReturnValue(client as unknown as PublicClient)
  return { ...client, requests }
}

const AS_OF = CREATED + 1_000n
const HEAD = AS_OF + 100n
const NOW = timeAt(HEAD)

describe('stickyHolders, reading for itself', () => {
  it('brings Bendystraw\'s positions to the head with one scan of the hook through Center', async () => {
    bendystraw.positions.mockResolvedValue({
      rows: [
        {
          chainId: CHAIN,
          projectId: 23n,
          holder: HOLDER,
          stakedBalance: 5n,
          streakStartedAt: NOW - 5_000,
          longestCompletedStreak: 0,
        },
      ],
      blocks: new Map([[CHAIN, AS_OF]]),
    })
    const center = node(HEAD, [
      // Below the scan's start: Bendystraw's positions already count it, and it is never asked for.
      staked(HOLDER, HOLDER, 5n, 5n, { blockNumber: AS_OF - 200n }),
      staked(HOLDER, HOLDER, 3n, 8n, { blockNumber: AS_OF + 10n }),
      streakStarted(OTHER, { blockNumber: AS_OF + 20n, logIndex: 0 }),
      staked(OTHER, HOLDER, 1n, 1n, { blockNumber: AS_OF + 20n, logIndex: 1 }),
    ])
    const result = await stickyHolders(CHAIN, 23n, { now: NOW })
    expect(result).toEqual({
      rows: [
        { holder: HOLDER, staked: 8n, start: NOW - 5_000, current: 5_000, longest: 5_000 },
        { holder: OTHER, staked: 1n, start: timeAt(AS_OF + 20n), current: 80, longest: 80 },
      ],
      source: 'indexed',
      degraded: null,
    })
    expect(bendystraw.positions).toHaveBeenCalledWith({ chainId: CHAIN, projectId: 23n }, undefined)
    expect(center.requests).toEqual([
      { address: HOOK, topics: [POSITION_TOPICS, topic(23n)], fromBlock: toHex(AS_OF + 1n - 64n), toBlock: toHex(HEAD) },
    ])
    expect(history.events).not.toHaveBeenCalled()
  })

  it('builds the rows from stickyEvents when Bendystraw\'s positions cannot answer', async () => {
    bendystraw.positions.mockRejectedValue(new Error('Cannot query field "stickyPositions"'))
    history.events.mockResolvedValue({
      events: [
        {
          kind: 'stick',
          chainId: CHAIN,
          projectId: 23n,
          holder: HOLDER,
          payer: HOLDER,
          count: 4n,
          balance: 4n,
          txHash: `0x${'1'.repeat(64)}`,
          logIndex: 0,
          blockNumber: AS_OF,
          timestamp: NOW - 10,
        },
      ],
      source: 'scanned',
      degraded: 'indexer-error',
    })
    const center = node(HEAD)
    const { signal } = new AbortController()
    const result = await stickyHolders(CHAIN, 23n, { now: NOW, signal })
    expect(result).toEqual({
      rows: [{ holder: HOLDER, staked: 4n, start: 0, current: 0, longest: 0 }],
      source: 'scanned',
      degraded: 'indexer-error',
    })
    expect(history.events).toHaveBeenCalledWith(CHAIN, 23n, { signal })
    expect(center.requests).toEqual([])
  })
})
