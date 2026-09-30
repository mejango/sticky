import { toHex, type Address, type Hex, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import { backingFlows } from '@/lib/sticky-backing'
import { CHAIN, HOLDER, deployment, raw, topic, words } from './sticky-log-fixtures'

// backingFlows' own read: the terminal through Center's log scanner, which runs for real here. Center is a fake
// client that answers from a list of logs.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))

const TERMINAL = deployment.terminal
const PAY = '0x133161f1c9161488f777ab9a26aae91d47c0d9a3fafb398960f138db02c73797'
const CASH_OUT = '0xfaf1d4bf1b08470c7ed8c351c5065f51af70b36b237723173f898453b9724142'
const PROCESS_FEE = '0xb514e730b3f8ad3aa94b6857bcc5ff4a46954bdcf8c4b0346705b1d0ac7a4325'
const ADD_TO_BALANCE = '0x9ecaf7fc3dfffd6867c175d6e684b1f1e3aef019398ba8db2c1ffab4a09db253'

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

const FROM = 1_000n
const HEAD = FROM + 200n
const on = (block: bigint, logIndex = 0) => ({ address: TERMINAL, blockNumber: block, logIndex, time: 7_000n + block })
const PAID: Hex[] = [PAY, topic(1n), topic(1n), topic(42n)]
const CASHED_OUT: Hex[] = [CASH_OUT, topic(1n), topic(1n), topic(42n)]

describe('backingFlows, reading for itself', () => {
  it('scans the terminal through Center, its pays and cash outs and then its fees and additions, from the block given', async () => {
    const center = node(HEAD, [
      raw(PAID, words(HOLDER, HOLDER, 100n, 100n, 224n, 256n, HOLDER, 0n, 0n), on(FROM + 1n)),
      raw([PROCESS_FEE, topic(42n), topic(HOLDER), topic(1n)], words(false, HOLDER, HOLDER), on(FROM + 5n, 0)),
      raw(CASHED_OUT, words(HOLDER, HOLDER, 40n, 1000n, 39n, 224n, HOLDER, 0n), on(FROM + 5n, 1)),
      raw([ADD_TO_BALANCE, topic(42n)], words(5n, 2n, 160n, 192n, HOLDER, 0n, 0n), on(FROM + 9n)),
      // Before the block given: not asked for.
      raw(PAID, words(HOLDER, HOLDER, 9n, 9n, 224n, 256n, HOLDER, 0n, 0n), on(FROM - 1n)),
    ])
    expect(await backingFlows(CHAIN, 42n, FROM)).toEqual([
      { timestamp: 7_000 + Number(FROM + 1n), delta: 100n },
      { timestamp: 7_000 + Number(FROM + 5n), delta: -1n },
      { timestamp: 7_000 + Number(FROM + 5n), delta: -39n },
      { timestamp: 7_000 + Number(FROM + 9n), delta: 7n },
    ])
    const range = { fromBlock: toHex(FROM), toBlock: toHex(HEAD) }
    expect(center.requests).toEqual([
      { address: TERMINAL, topics: [[PAY, CASH_OUT], null, null, topic(42n)], ...range },
      { address: TERMINAL, topics: [[PROCESS_FEE, ADD_TO_BALANCE], topic(42n)], ...range },
    ])
  })

  it('refuses a history longer than a scan may read, before it sends a request', async () => {
    const center = node(FROM + 1_024n * 500n)
    await expect(backingFlows(CHAIN, 42n, FROM)).rejects.toThrow('more than this RPC can scan in 1024 requests')
    expect(center.request).not.toHaveBeenCalled()
  })
})
