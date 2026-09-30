import { encodeAbiParameters, parseAbiParameters, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScannedLog } from '@/lib/hook-logs'
import { backingFlows } from '@/lib/sticky-backing'
import type { IndexedMove } from '@/lib/sticky-indexed'
import { CHAIN, HOLDER, deployment, raw, topic, words } from './sticky-log-fixtures'

// backingFlows' own reads: Bendystraw's pays and cash outs (faked), and the terminal through Center's log scanner and
// the history this browser keeps, which run for real here. Center is a fake client that answers from a list of logs.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))
const bendystraw = vi.hoisted(() => ({ moves: vi.fn() }))
vi.mock('@/lib/sticky-indexed', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-indexed')>()),
  indexedStickyMoves: bendystraw.moves,
}))

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  bendystraw.moves.mockRejectedValue(new Error('Bendystraw is down'))
})

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
    // A block's time, for a log that came without it.
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      timestamp: 9_000n + blockNumber,
    })),
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
const on = (block: bigint, logIndex = 0, txHash?: Hex) => ({
  address: TERMINAL,
  blockNumber: block,
  logIndex,
  time: 7_000n + block,
  ...(txHash === undefined ? {} : { txHash }),
})
const PAID: Hex[] = [PAY, topic(1n), topic(1n), topic(42n)]
const CASHED_OUT: Hex[] = [CASH_OUT, topic(1n), topic(1n), topic(42n)]

describe('backingFlows, reading for itself', () => {
  it('scans the terminal through Center, its pays and cash outs and then its fees and additions, when Bendystraw cannot answer', async () => {
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

describe("backingFlows, reading Bendystraw's pays and cash outs", () => {
  // Past the deployer's block, so a tail from just below Bendystraw's block starts where it says.
  const START = deployment.fromBlock + 1_000n
  const AS_OF = START + 300n
  const tx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
  const indexedPay = (amount: bigint, txHash: Hex, timestamp: number): IndexedMove => ({
    kind: 'stick',
    chainId: CHAIN,
    projectId: 42n,
    txHash,
    logIndex: 0,
    timestamp,
    holder: HOLDER,
    payer: HOLDER,
    amount,
    tokens: amount,
  })
  const paid = (amount: bigint, block: bigint, txHash?: Hex) =>
    raw(PAID, words(HOLDER, HOLDER, amount, amount, 224n, 256n, HOLDER, 0n, 0n), on(block, 0, txHash))
  const fee = (amount: bigint, block: bigint) =>
    raw([PROCESS_FEE, topic(42n), topic(HOLDER), topic(amount)], words(false, HOLDER, HOLDER), on(block))
  const FEES = `sticky.history.v1:${CHAIN}:${TERMINAL.toLowerCase()}:42:fees`

  it('scans the terminal for pays and cash outs only past Bendystraw\'s block, and for fees over the project\'s life', async () => {
    bendystraw.moves.mockResolvedValue({ rows: [indexedPay(100n, tx(1), 50)], blocks: new Map([[CHAIN, AS_OF]]) })
    const head = AS_OF + 10n
    const center = node(head, [
      // Bendystraw has this pay, and the tail does not reach down to it: it is read once, from Bendystraw.
      paid(100n, START + 5n, tx(1)),
      paid(3n, AS_OF + 2n),
      fee(1n, START + 50n),
    ])
    expect(await backingFlows(CHAIN, 42n, START)).toEqual([
      { timestamp: 50, delta: 100n },
      { timestamp: 7_000 + Number(START + 50n), delta: -1n },
      { timestamp: 7_000 + Number(AS_OF + 2n), delta: 3n },
    ])
    expect(bendystraw.moves).toHaveBeenCalledWith(CHAIN, [42n], undefined)
    expect(center.requests).toEqual([
      {
        address: TERMINAL,
        topics: [[PAY, CASH_OUT], null, null, topic(42n)],
        fromBlock: toHex(AS_OF + 1n - 64n),
        toBlock: toHex(head),
      },
      {
        address: TERMINAL,
        topics: [[PROCESS_FEE, ADD_TO_BALANCE], topic(42n)],
        fromBlock: toHex(START),
        toBlock: toHex(head),
      },
    ])
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('a return visit scans the fees only past the block it kept them through', async () => {
    bendystraw.moves.mockResolvedValue({ rows: [], blocks: new Map([[CHAIN, AS_OF]]) })
    const first = START + 400n
    const logs = [fee(1n, START + 10n), fee(2n, first - 2n)]
    node(first, logs)
    expect((await backingFlows(CHAIN, 42n, START)).map(flow => flow.delta)).toEqual([-1n, -2n])
    // What a reorg can no longer replace is kept: through 64 blocks below the head, so not the second fee.
    const kept = JSON.parse(localStorage.getItem(FEES) ?? 'null') as { from: string; through: string; all: unknown[] }
    expect(kept).toMatchObject({ from: String(START), through: String(first - 64n) })
    expect(kept.all).toHaveLength(1)

    const second = first + 100n
    const center = node(second, [...logs, fee(3n, first + 50n)])
    expect((await backingFlows(CHAIN, 42n, START)).map(flow => flow.delta)).toEqual([-1n, -2n, -3n])
    const fees = center.requests.filter(request => request.topics[0]?.includes(PROCESS_FEE))
    expect(fees).toEqual([
      {
        address: TERMINAL,
        topics: [[PROCESS_FEE, ADD_TO_BALANCE], topic(42n)],
        fromBlock: toHex(first - 64n + 1n),
        toBlock: toHex(second),
      },
    ])
    // The fees' history is its own: the project's hook history is kept under another key, and this read wrote none.
    expect(Object.keys(localStorage)).toEqual([FEES])
  })

  it('reads the block time of a fee that came without it, as a transport other than Center sends them', async () => {
    bendystraw.moves.mockResolvedValue({ rows: [], blocks: new Map([[CHAIN, AS_OF]]) })
    const untimed = raw([PROCESS_FEE, topic(42n), topic(HOLDER), topic(4n)], words(false, HOLDER, HOLDER), {
      address: TERMINAL,
      blockNumber: START + 7n,
      time: null,
    })
    const center = node(AS_OF + 10n, [untimed])
    expect(await backingFlows(CHAIN, 42n, START)).toEqual([{ timestamp: 9_000 + Number(START + 7n), delta: -4n }])
    expect(center.getBlock).toHaveBeenCalledWith({ blockNumber: START + 7n })
  })

  it('keeps an addition with a memo far past the size cap, as its amounts, and resumes to the same flows', async () => {
    bendystraw.moves.mockResolvedValue({ rows: [], blocks: new Map([[CHAIN, AS_OF]]) })
    // A 200,000-character memo: 400,000 hex characters of data, over the 400,000-character cap on its own.
    const huge = encodeAbiParameters(parseAbiParameters('uint256, uint256, string, bytes, address'), [
      5n,
      2n,
      'x'.repeat(200_000),
      '0x',
      HOLDER,
    ])
    const addition = raw([ADD_TO_BALANCE, topic(42n)], huge, on(START + 20n))
    const first = START + 400n
    const logs = [addition, fee(1n, START + 30n)]
    node(first, logs)
    const flows = await backingFlows(CHAIN, 42n, START)
    expect(flows.map(flow => flow.delta)).toEqual([7n, -1n])

    const stored = localStorage.getItem(FEES)
    expect(stored).not.toBeNull()
    expect(stored!.length).toBeLessThan(5_000)
    expect(JSON.parse(stored!)).toMatchObject({ through: String(first - 64n) })

    const second = first + 100n
    const center = node(second, logs)
    expect(await backingFlows(CHAIN, 42n, START)).toEqual(flows)
    const asked = center.requests.filter(request => request.topics[0]?.includes(PROCESS_FEE))
    expect(asked.map(request => request.fromBlock)).toEqual([toHex(first - 64n + 1n)])
  })
})
