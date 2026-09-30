import { toHex, type Address, type Hex, type PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import type { StickyEvent } from '@/lib/sticky-events'
import { feedRows, terminalMoves, type FeedOptions } from '@/lib/sticky-feed'
import type { IndexedMove } from '@/lib/sticky-indexed'
import { CHAIN, HOLDER, deployment, raw, topic, words } from './sticky-log-fixtures'

// The reads sticky-feed makes when a caller gives it none: Bendystraw's pays and cash outs, and Center through the
// log scanner, which runs for real here. Center is a fake client that answers from a list of logs.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))
const bendystraw = vi.hoisted(() => ({ moves: vi.fn() }))
vi.mock('@/lib/sticky-indexed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-indexed')>()),
  indexedStickyMoves: bendystraw.moves,
}))

const TERMINAL = deployment.terminal
const PAY = '0x133161f1c9161488f777ab9a26aae91d47c0d9a3fafb398960f138db02c73797'
const CASH_OUT = '0xfaf1d4bf1b08470c7ed8c351c5065f51af70b36b237723173f898453b9724142'
const FUNDER = `0x${'b'.repeat(40)}` as Address
const E18 = 10n ** 18n
const E6 = 10n ** 6n
const TOKENS = { symbol: 'SLOPSHOP', stSymbol: 'STICKYSLOPSHOP', decimals: 6 }
const options: FeedOptions = { adapter: null, tokens: () => TOKENS }
const tx = (short: string) => `0x${short.padStart(64, '0')}` as Hex

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

const payLog = (beneficiary: Address, amount: bigint, count: bigint, short: string, block: bigint) =>
  raw([PAY, topic(1n), topic(1n), topic(42n)], words(FUNDER, beneficiary, amount, count, 224n, 256n, FUNDER, 0n, 0n), {
    address: TERMINAL,
    txHash: tx(short),
    blockNumber: block,
  })
const cashOutLog = (holder: Address, count: bigint, reclaim: bigint, short: string, block: bigint) =>
  raw([CASH_OUT, topic(1n), topic(1n), topic(42n)], words(holder, holder, count, 0n, reclaim, 224n, holder, 0n), {
    address: TERMINAL,
    txHash: tx(short),
    blockNumber: block,
  })

const stick = (count: bigint, short: string, blockNumber: bigint | null): StickyEvent => ({
  kind: 'stick',
  chainId: CHAIN,
  projectId: 42n,
  holder: HOLDER,
  payer: HOLDER,
  count,
  balance: count,
  txHash: tx(short),
  logIndex: 0,
  blockNumber,
  timestamp: 100,
})
const unstick = (count: bigint, short: string, blockNumber: bigint | null): StickyEvent => ({
  kind: 'unstick',
  chainId: CHAIN,
  projectId: 42n,
  holder: HOLDER,
  count,
  balance: 0n,
  txHash: tx(short),
  logIndex: 0,
  blockNumber,
  timestamp: 100,
})
const indexedStick = (amount: bigint, tokens: bigint, short: string): IndexedMove => ({
  kind: 'stick',
  chainId: CHAIN,
  projectId: 42n,
  txHash: tx(short),
  logIndex: 0,
  timestamp: 100,
  holder: HOLDER,
  payer: HOLDER,
  amount,
  tokens,
})

beforeEach(() => {
  for (const mock of [center.client, bendystraw.moves]) mock.mockReset()
  // A read that fails tells the console why; sticky-feed.test.ts checks what it says.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('terminalMoves through Center', () => {
  it("scans the terminal for the shown projects' pays and cash outs, from the oldest block to the head", async () => {
    const chain = node(1_200n, [
      payLog(HOLDER, 1010n * E6, 1000n * E18, 'a1', 1_000n),
      cashOutLog(HOLDER, 100n * E18, 99n * E6, 'a2', 1_100n),
      // Before the scan starts, and another contract's.
      payLog(HOLDER, 5n * E6, 5n * E18, 'a0', 999n),
      { ...payLog(HOLDER, 6n * E6, 6n * E18, 'a3', 1_100n), address: HOLDER },
    ])
    const events = [stick(1000n * E18, 'a1', 1_000n), unstick(100n * E18, 'a2', 1_100n)]
    const { signal } = new AbortController()

    const moves = await terminalMoves(events, { signal })

    expect(bendystraw.moves).not.toHaveBeenCalled()
    expect(center.client).toHaveBeenCalledWith(CHAIN)
    expect(chain.requests).toEqual([
      {
        address: TERMINAL,
        topics: [[PAY, CASH_OUT], null, null, [topic(42n)]],
        fromBlock: toHex(1_000n),
        toBlock: toHex(1_200n),
      },
    ])
    expect(chain.request.mock.calls[0][1]).toEqual({ signal })
    expect(feedRows(events, moves, options).map(({ amount }) => amount)).toEqual([
      { value: 99n * E6, decimals: 6, symbol: 'SLOPSHOP' },
      { value: 1010n * E6, decimals: 6, symbol: 'SLOPSHOP' },
    ])
  })

  it("asks Bendystraw for the projects' pays and cash outs, with the caller's signal, and not Center", async () => {
    bendystraw.moves.mockResolvedValue([indexedStick(1010n * E6, 1000n * E18, 'a1')])
    const events = [stick(1000n * E18, 'a1', null)]
    const { signal } = new AbortController()

    const moves = await terminalMoves(events, { signal })

    expect(bendystraw.moves).toHaveBeenCalledWith(CHAIN, [42n], signal)
    expect(center.client).not.toHaveBeenCalled()
    expect([...moves.values()]).toEqual([1010n * E6])
  })

  it('reads both for a list that has both', async () => {
    bendystraw.moves.mockResolvedValue([indexedStick(11n * E6, 1n * E18, 'a1')])
    const chain = node(2_000n, [payLog(HOLDER, 12n * E6, 2n * E18, 'a2', 1_900n)])
    const events = [stick(1n * E18, 'a1', null), stick(2n * E18, 'a2', 1_900n)]

    const moves = await terminalMoves(events)

    expect([...moves.values()]).toEqual([11n * E6, 12n * E6])
    expect(chain.requests).toEqual([
      {
        address: TERMINAL,
        topics: [[PAY, CASH_OUT], null, null, [topic(42n)]],
        fromBlock: toHex(1_900n),
        toBlock: toHex(2_000n),
      },
    ])
  })

  it('keeps Sticky token counts, and tells the console, when Center cannot answer', async () => {
    const failure = new Error('HTTP request failed.')
    const chain = node(1_200n)
    chain.request.mockRejectedValue(failure)
    const events = [stick(3n * E18, 'a1', 1_000n)]

    const rows = feedRows(events, await terminalMoves(events), options)

    expect(rows.map(({ amount }) => amount)).toEqual([{ value: 3n * E18, decimals: 18, symbol: 'STICKYSLOPSHOP' }])
    expect(vi.mocked(console.warn).mock.calls).toEqual([
      ['Could not read stick and unstick amounts; showing Sticky token counts.', { chainId: CHAIN }, failure],
    ])
  })

  it("stops with the caller's reason when the caller cancels while Center is asked for the head", async () => {
    const reason = new Error('navigated away')
    const chain = node(1_200n)
    chain.getBlockNumber.mockImplementation(() => new Promise<bigint>(() => {}))
    const controller = new AbortController()
    const pending = terminalMoves([stick(1n, 'a1', 1_000n)], { signal: controller.signal })

    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
    expect(chain.request).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })
})
