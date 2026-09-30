import { getAddress, pad, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectHookLogs, scanLogs, statedRange, type ScannedLog } from '@/lib/hook-logs'
import { stickyDeployment } from '@/lib/sticky-addresses'

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))

type Topics = (Hex | Hex[] | null)[]
type Filter = { address: Address; topics: Topics; fromBlock: Hex; toBlock: Hex }
type Asked = { fromBlock: bigint; toBlock: bigint; address: Address; topics: Topics }
type FakeClient = PublicClient & { asked: Asked[]; filters: Filter[] }

const HOOK = getAddress(`0x${'a'.repeat(40)}`)
const hash = (n: bigint): Hex => pad(toHex(n), { size: 32 })
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function log(blockNumber: bigint, logIndex = 0, extra: Partial<ScannedLog> = {}): ScannedLog {
  return {
    address: HOOK,
    blockHash: hash(blockNumber + 0x1000n),
    blockNumber,
    data: '0x',
    logIndex,
    removed: false,
    topics: [],
    transactionHash: hash(blockNumber * 100n + BigInt(logIndex) + 0x50_0000n),
    transactionIndex: 0,
    ...extra,
  }
}

// A log as a node writes it on the wire, written here on its own so the tests do not lean on the code they test.
const rpcLog = (entry: ScannedLog) => ({
  address: entry.address,
  blockHash: entry.blockHash,
  blockNumber: toHex(entry.blockNumber),
  ...(entry.blockTimestamp === undefined ? {} : { blockTimestamp: toHex(entry.blockTimestamp) }),
  data: entry.data,
  logIndex: toHex(entry.logIndex),
  removed: entry.removed,
  topics: entry.topics,
  transactionHash: entry.transactionHash,
  transactionIndex: toHex(entry.transactionIndex),
})

const rangeOf = (filter: Filter): Asked => ({
  fromBlock: BigInt(filter.fromBlock),
  toBlock: BigInt(filter.toBlock),
  address: filter.address,
  topics: filter.topics,
})

/** A node that answers eth_getLogs with whatever `respond` says, on the wire, and nothing else: any other
 * way of reaching the chain is an error. `asked` lists every range requested, refused ones too, and
 * `filters` the same as they were sent. */
function wire(respond: (filter: Filter) => unknown): FakeClient {
  const asked: Asked[] = []
  const filters: Filter[] = []
  const request = vi.fn(async ({ method, params }: { method: string; params: [Filter] }) => {
    if (method !== 'eth_getLogs') throw new Error(`the fake node only answers eth_getLogs, not ${method}`)
    asked.push(rangeOf(params[0]))
    filters.push(params[0])
    return respond(params[0])
  })
  return { request, asked, filters } as unknown as FakeClient
}

function fakeClient(answer: (range: Asked) => ScannedLog[] | Promise<ScannedLog[]>): FakeClient {
  return wire(async filter => (await answer(rangeOf(filter))).map(rpcLog))
}

/** Runs a scan to its end on fake time, so a backoff or a slow node costs no real waiting. */
async function ran<T>(scan: Promise<T>): Promise<T> {
  const outcome = scan.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  )
  await vi.runAllTimersAsync()
  const settled = await outcome
  if ('error' in settled) throw settled.error
  return settled.value
}

const query = (fromBlock: bigint, toBlock: bigint, topics: Topics = []) => ({ address: HOOK, topics, fromBlock, toBlock })
const blocks = (found: ScannedLog[]) => found.map(entry => entry.blockNumber)
const size = ({ fromBlock, toBlock }: Asked) => toBlock - fromBlock + 1n
const tooMany = () => Object.assign(new Error('Too Many Requests'), { status: 429 })
const refusal = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra)

describe('statedRange', () => {
  it.each([
    ['eth_getLogs is limited to a 1,000 range', 1000n],
    ['eth_getLogs is limited to a 2,000 range', 2000n],
    ['exceed maximum block range: 5000', 5000n],
    ['block range exceeds limit', 0n],
    ['query returned more than 10000 results', 0n],
    ['up to a 2K block range', 0n],
    ['RPC request failed', 0n],
    ['eth_getLogs is limited to a 9 range', 0n],
    ['eth_getLogs is limited to a 10 range', 10n],
    ['eth_getLogs is limited to a 10,000,000 range', 10_000_000n],
    ['eth_getLogs is limited to a 10,000,001 range', 0n],
  ])('reads %j as %s', (message, span) => {
    expect(statedRange(message)).toBe(span)
  })
})

describe('scanLogs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  describe('the requests it makes', () => {
    it('asks for 500 blocks at a time, in hex, with the filter it was given', async () => {
      const topics: Topics = [['0x' + '11'.repeat(32), '0x' + '22'.repeat(32)] as Hex[], null, ('0x' + '33'.repeat(32)) as Hex]
      const client = wire(() => [])
      await ran(scanLogs(client, query(0n, 1_499n, topics)))
      expect(client.filters).toEqual([
        { address: HOOK, topics, fromBlock: '0x0', toBlock: '0x1f3' },
        { address: HOOK, topics, fromBlock: '0x1f4', toBlock: '0x3e7' },
        { address: HOOK, topics, fromBlock: '0x3e8', toBlock: '0x5db' },
      ])
    })

    it.each([
      [0n, 0n],
      [0n, 499n],
      [0n, 500n],
      [123n, 2_600n],
      [47_263_633n, 47_295_229n],
    ])('covers blocks %s to %s exactly, with no gap and no overlap', async (fromBlock, toBlock) => {
      const client = fakeClient(() => [])
      await ran(scanLogs(client, query(fromBlock, toBlock)))
      const windows = [...client.asked].sort((a, b) => Number(a.fromBlock - b.fromBlock))
      expect(windows[0].fromBlock).toBe(fromBlock)
      expect(windows.at(-1)?.toBlock).toBe(toBlock)
      expect(windows.every(window => size(window) <= 500n)).toBe(true)
      windows.slice(1).forEach((window, at) => expect(window.fromBlock).toBe(windows[at].toBlock + 1n))
    })

    it('answers an empty range without asking anyone', async () => {
      const client = fakeClient(() => [log(1n)])
      expect(await ran(scanLogs(client, query(10n, 9n)))).toEqual([])
      expect(client.asked).toEqual([])
    })

    it('never sends a range Center refuses: Center caps eth_getLogs at 500 blocks', async () => {
      const client = fakeClient(({ fromBlock, toBlock }) => {
        if (toBlock - fromBlock + 1n > 500n) throw refusal('RPC request failed', { code: -32005 })
        return [log(fromBlock)]
      })
      const found = await ran(scanLogs(client, query(0n, 1_999n)))
      expect(client.asked).toHaveLength(4)
      expect(blocks(found)).toEqual([0n, 500n, 1_000n, 1_500n])
    })
  })

  describe('a node that limits the range', () => {
    const entry = (n: bigint) => log(n)

    it('is complete, ordered and deduplicated', async () => {
      const client = fakeClient(({ fromBlock, toBlock }) => {
        if (toBlock - fromBlock > 2n) throw new Error('block range exceeds limit')
        const rows: ScannedLog[] = []
        for (let block = toBlock; block >= fromBlock; block -= 1n) rows.push(entry(block), entry(block))
        return rows
      })
      const found = await ran(scanLogs(client, query(2n, 7n)))
      expect(blocks(found)).toEqual([2n, 3n, 4n, 5n, 6n, 7n])
    })

    it('splits an HTTP 413 into the windows the node states, complete and in order', async () => {
      const spans: bigint[] = []
      const client = fakeClient(({ fromBlock, toBlock }) => {
        if (toBlock - fromBlock + 1n > 100n) {
          throw refusal('eth_getLogs is limited to a 100 range', { status: 413 })
        }
        spans.push(toBlock - fromBlock + 1n)
        const inside = (block: bigint) => fromBlock <= block && block <= toBlock
        return inside(47_263_700n) ? [entry(47_263_700n)] : inside(47_295_000n) ? [entry(47_295_000n)] : []
      })
      const found = await ran(scanLogs(client, query(47_263_633n, 47_295_229n)))
      expect(blocks(found)).toEqual([47_263_700n, 47_295_000n])
      // 31,597 blocks in 100s: 315 full windows and one of 97. A refused 500 goes straight to the stated
      // span, not to halves.
      expect(spans).toHaveLength(316)
      expect(new Set(spans)).toEqual(new Set([100n, 97n]))
    })

    it('halves an HTTP 413 that states no span', async () => {
      const client = fakeClient(({ fromBlock, toBlock }) => {
        if (toBlock - fromBlock > 2n) {
          throw refusal('The chain RPC returned HTTP 413. Please try again.', { status: 413 })
        }
        return [entry(toBlock)]
      })
      const found = await ran(scanLogs(client, query(0n, 7n)))
      expect(blocks(found)).toEqual([1n, 3n, 5n, 7n])
      expect(client.asked.map(({ fromBlock, toBlock }) => [fromBlock, toBlock])).toEqual([
        [0n, 7n],
        [0n, 3n],
        [4n, 7n],
        [0n, 1n],
        [2n, 3n],
        [4n, 5n],
        [6n, 7n],
      ])
    })

    it('halves a range Center refuses with -32005 and no stated span, until it is small enough', async () => {
      const accepted: Asked[] = []
      const client = fakeClient(range => {
        if (size(range) > 100n) throw refusal('RPC request failed', { code: -32005 })
        accepted.push(range)
        const rows: ScannedLog[] = []
        for (let block = range.fromBlock; block <= range.toBlock; block += 1n) if (block % 50n === 0n) rows.push(entry(block))
        return rows
      })
      const found = await ran(scanLogs(client, query(0n, 499n)))
      expect(blocks(found)).toEqual([0n, 50n, 100n, 150n, 200n, 250n, 300n, 350n, 400n, 450n])
      // 500, then 2 of 250, then 4 of 125 are refused; 8 of 62 or 63 are read.
      expect(client.asked).toHaveLength(15)
      expect(accepted).toHaveLength(8)
      // The halves that were read cover the range once, with no gap and no overlap.
      const parts = [...accepted].sort((a, b) => Number(a.fromBlock - b.fromBlock))
      expect(parts[0].fromBlock).toBe(0n)
      expect(parts.at(-1)?.toBlock).toBe(499n)
      parts.slice(1).forEach((part, at) => expect(part.fromBlock).toBe(parts[at].toBlock + 1n))
    })

    it('reads the span a -32005 error states, and goes straight to it', async () => {
      const client = fakeClient(range => {
        if (size(range) > 100n) throw refusal('eth_getLogs is limited to a 100 range', { code: -32005 })
        return [entry(range.toBlock)]
      })
      const found = await ran(scanLogs(client, query(0n, 499n)))
      expect(blocks(found)).toEqual([99n, 199n, 299n, 399n, 499n])
      expect(client.asked).toHaveLength(6)
    })

    it('does not split a single block, however the node words its refusal', async () => {
      const client = fakeClient(() => {
        throw new Error('range limit')
      })
      await expect(ran(scanLogs(client, query(0n, 3n)))).rejects.toThrow('range limit')
      expect(client.asked.length).toBeLessThan(10)
      expect(client.asked.every(({ fromBlock, toBlock }) => fromBlock <= toBlock)).toBe(true)
    })

    it('halves a range whose refusal states a span no smaller than the range itself', async () => {
      // "Limited to 1,000" of a range of 500 says nothing about where to split it.
      const client = fakeClient(range => {
        if (size(range) > 100n) throw refusal('eth_getLogs is limited to a 1,000 range', { status: 413 })
        return [entry(range.toBlock)]
      })
      const found = await ran(scanLogs(client, query(0n, 499n)))
      expect(found).toHaveLength(8)
      expect(client.asked).toHaveLength(15)
    })

    it('reads the refusal from what the node said, not from the framing viem puts around it', async () => {
      // viem's message carries the URL and version; its `details` carry the node's words.
      const client = fakeClient(range => {
        if (size(range) > 100n) {
          throw refusal('HTTP request failed.\n\nURL: https://rpc.example/limit/7500\nVersion: viem@2.55.19', {
            status: 413,
            details: 'eth_getLogs is limited to a 100 range',
          })
        }
        return [entry(range.toBlock)]
      })
      expect(blocks(await ran(scanLogs(client, query(0n, 499n))))).toEqual([99n, 199n, 299n, 399n, 499n])
      expect(client.asked).toHaveLength(6)
    })

    it('finishes the walk down a chain of causes that leads back to itself', async () => {
      const loop = new Error('loop')
      loop.cause = loop
      const client = fakeClient(() => {
        throw loop
      })
      await expect(ran(scanLogs(client, query(0n, 9n)))).rejects.toBe(loop)
      expect(client.asked).toHaveLength(1)
    })

    it('fails on an error that is not about the range, without splitting the range or going on', async () => {
      const client = fakeClient(() => {
        throw refusal('Internal Server Error', { status: 500 })
      })
      await expect(ran(scanLogs(client, query(0n, 4_999n)))).rejects.toMatchObject({ status: 500 })
      expect(client.asked).toHaveLength(2)
    })

    it('bisects a range refused without a stated span in parallel, in order, and never above the bound', async () => {
      const run = async (options?: { maxInFlight: number }) => {
        let inFlight = 0
        let peak = 0
        const client = fakeClient(async ({ fromBlock, toBlock }) => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await sleep(2)
          inFlight -= 1
          if (toBlock - fromBlock > 15n) throw new Error('query returned more than 10000 results')
          const rows: ScannedLog[] = []
          for (let block = fromBlock; block <= toBlock; block += 1n) if (block % 7n === 0n) rows.push(entry(block))
          return rows
        })
        const found = await ran(scanLogs(client, query(0n, 1_023n), options))
        return { found, peak }
      }
      const expected = Array.from({ length: 147 }, (_, at) => BigInt(at * 7))

      const byDefault = await run()
      expect(blocks(byDefault.found)).toEqual(expected)
      expect(byDefault.peak).toBe(2)

      const wider = await run({ maxInFlight: 4 })
      expect(blocks(wider.found)).toEqual(expected)
      expect(wider.peak).toBeGreaterThan(2)
      expect(wider.peak).toBeLessThanOrEqual(4)
    })
  })

  describe('never a partial history', () => {
    it('rejects when a block cannot be read, however far the range was split', async () => {
      const client = fakeClient(({ fromBlock, toBlock }) => {
        if (fromBlock === toBlock) throw new Error('archive unavailable')
        throw new Error('range limit')
      })
      await expect(ran(scanLogs(client, query(0n, 2n)))).rejects.toThrow(/archive unavailable/)
    })

    it('rejects, with nothing, when one window fails after the others were read', async () => {
      const client = fakeClient(({ fromBlock, toBlock }) => {
        if (fromBlock === 1_500n) throw new Error('boom')
        return [log(fromBlock), log(toBlock)]
      })
      await expect(ran(scanLogs(client, query(0n, 2_499n)))).rejects.toThrow('boom')
    })

    it('asks for nothing more once one window has failed', async () => {
      const failing = fakeClient(() => {
        throw new Error('archive unavailable')
      })
      await expect(ran(scanLogs(failing, query(0n, 4_999n), { maxInFlight: 1 }))).rejects.toThrow('archive unavailable')
      expect(failing.asked).toHaveLength(1)

      // Two in flight: the second was already asked when the first failed, and nothing follows it.
      const slowSecond = fakeClient(async ({ fromBlock }) => {
        if (fromBlock === 0n) throw new Error('archive unavailable')
        await sleep(10)
        return []
      })
      await expect(ran(scanLogs(slowSecond, query(0n, 4_999n)))).rejects.toThrow('archive unavailable')
      expect(slowSecond.asked).toHaveLength(2)
    })
  })

  describe('a rate limit (429)', () => {
    it('backs off on 429 and finishes the scan without surfacing an error', async () => {
      let calls = 0
      const client = fakeClient(async ({ fromBlock, toBlock }) => {
        calls += 1
        if (calls <= 2) throw Object.assign(new Error('Too Many Requests'), { status: 429 })
        return [log(fromBlock), log(toBlock)]
      })
      const logs = await ran(scanLogs(client, { address: HOOK, topics: [], fromBlock: 0n, toBlock: 10n }, { maxInFlight: 1 }))
      expect(logs.map(entry => entry.blockNumber)).toEqual([0n, 10n])
      expect(calls).toBe(3)
    })

    it('waits 1 s, then 2 s, then 4 s, gives up after the third retry, and never splits the range', async () => {
      const client = fakeClient(() => {
        throw tooMany()
      })
      const outcome = expect(scanLogs(client, query(0n, 10n))).rejects.toMatchObject({ status: 429 })
      await vi.advanceTimersByTimeAsync(0)
      expect(client.asked).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(client.asked).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.asked).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(client.asked).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.asked).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(3_999)
      expect(client.asked).toHaveLength(3)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.asked).toHaveLength(4)
      await outcome
      await vi.runAllTimersAsync()
      // "Too Many Requests" reads like a range refusal, but a 429 is retried and then reported, not split.
      expect(client.asked).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ fromBlock: 0n, toBlock: 10n })))
    })

    it.each([
      ['a status on the error', () => Object.assign(new Error('slow down'), { status: 429 })],
      ['a JSON-RPC code on the error', () => Object.assign(new Error('slow down'), { code: 429 })],
      ['a status on its cause, as viem wraps what Center throws', () => new Error('An unknown RPC error occurred.', { cause: Object.assign(new Error('slow down'), { status: 429 }) })],
      ['a code two causes down', () => new Error('outer', { cause: new Error('middle', { cause: Object.assign(new Error('slow down'), { code: 429 }) }) })],
    ])('recognises a 429 carried as %s', async (_where, make) => {
      let calls = 0
      const client = fakeClient(({ fromBlock }) => {
        calls += 1
        if (calls === 1) throw make()
        return [log(fromBlock)]
      })
      expect(blocks(await ran(scanLogs(client, query(5n, 9n))))).toEqual([5n])
      expect(client.asked).toHaveLength(2)
    })

    it('keeps its slot while it backs off, so nothing waiting for one is asked in the meantime', async () => {
      // A refused 500 leaves five parts of 100 waiting for the one slot; the first is refused with a 429.
      let limited = false
      const client = fakeClient(range => {
        if (size(range) > 100n) throw refusal('eth_getLogs is limited to a 100 range', { status: 413 })
        if (range.fromBlock === 0n && !limited) {
          limited = true
          throw tooMany()
        }
        return [log(range.fromBlock)]
      })
      const done = scanLogs(client, query(0n, 499n), { maxInFlight: 1 })
      await vi.advanceTimersByTimeAsync(999)
      expect(client.asked.map(range => [range.fromBlock, range.toBlock])).toEqual([
        [0n, 499n],
        [0n, 99n],
      ])
      const found = await ran(done)
      expect(blocks(found)).toEqual([0n, 100n, 200n, 300n, 400n])
      expect(client.asked.map(range => range.fromBlock)).toEqual([0n, 0n, 0n, 100n, 200n, 300n, 400n])
    })

    it('sends nothing more for a range that waited for a slot while another failed', async () => {
      const client = fakeClient(range => {
        if (size(range) > 100n) throw refusal('eth_getLogs is limited to a 100 range', { status: 413 })
        throw new Error('boom')
      })
      await expect(ran(scanLogs(client, query(0n, 499n), { maxInFlight: 1 }))).rejects.toThrow('boom')
      expect(client.asked.map(range => [range.fromBlock, range.toBlock])).toEqual([
        [0n, 499n],
        [0n, 99n],
      ])
    })

    it('counts its retries toward the request budget', async () => {
      const client = fakeClient(() => {
        throw tooMany()
      })
      await expect(ran(scanLogs(client, query(0n, 10n), { maxRequests: 3 }))).rejects.toMatchObject({ status: 429 })
      expect(client.asked).toHaveLength(3)
    })
  })

  describe('the request budget', () => {
    it('refuses a history too long for it before sending anything', async () => {
      const client = fakeClient(() => [])
      await expect(ran(scanLogs(client, query(0n, 600_000n)))).rejects.toThrow(
        'This history spans 600001 blocks, more than this RPC can scan in 1024 requests.',
      )
      await expect(ran(scanLogs(client, query(0n, 1_500n), { maxRequests: 3 }))).rejects.toThrow(/in 3 requests/)
      expect(client.asked).toEqual([])
    })

    it('accepts a history that takes exactly the budget, and refuses one block more', async () => {
      const client = fakeClient(() => [])
      expect(await ran(scanLogs(client, query(0n, 1_024n * 500n - 1n)))).toEqual([])
      expect(client.asked).toHaveLength(1_024)
      await expect(ran(scanLogs(client, query(0n, 1_024n * 500n)))).rejects.toThrow(/in 1024 requests/)
      expect(client.asked).toHaveLength(1_024)
    })

    it('fails when splitting outgrows it, having sent no more than it allows and returned nothing', async () => {
      const client = fakeClient(range => {
        if (size(range) > 1n) throw new Error('range too large')
        return [log(range.fromBlock)]
      })
      await expect(ran(scanLogs(client, query(0n, 499n), { maxRequests: 50 }))).rejects.toThrow(
        'This history spans 500 blocks, more than this RPC can scan in 50 requests.',
      )
      expect(client.asked).toHaveLength(50)
    })
  })

  describe('the requests in flight', () => {
    it.each([1, 2, 3])('never has more than %s in flight', async cap => {
      let inFlight = 0
      let peak = 0
      const client = fakeClient(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await sleep(5)
        inFlight -= 1
        return []
      })
      await ran(scanLogs(client, query(0n, 4_999n), { maxInFlight: cap }))
      expect(client.asked).toHaveLength(10)
      expect(peak).toBe(cap)
    })

    it.each([0, -1, 1.5, Number.NaN])('refuses a maxInFlight of %s, which could never make progress', async cap => {
      await expect(scanLogs(fakeClient(() => []), query(0n, 9n), { maxInFlight: cap })).rejects.toThrow(RangeError)
    })
  })

  describe('what it returns', () => {
    it('orders by block, then by index, however the windows finish', async () => {
      const client = fakeClient(async ({ fromBlock }) => {
        // Later windows answer first.
        await sleep(Number(1_000n - fromBlock))
        return fromBlock === 0n ? [log(300n, 1), log(300n, 0), log(10n)] : [log(700n), log(600n, 2), log(600n, 1)]
      })
      const found = await ran(scanLogs(client, query(0n, 999n)))
      expect(found.map(entry => [entry.blockNumber, entry.logIndex])).toEqual([
        [10n, 0],
        [300n, 0],
        [300n, 1],
        [600n, 1],
        [600n, 2],
        [700n, 0],
      ])
    })

    it('keeps one copy of a log the node returned twice, in one window or across two', async () => {
      const client = fakeClient(({ fromBlock }) => [log(499n), log(499n), fromBlock === 0n ? log(1n) : log(499n)])
      const found = await ran(scanLogs(client, query(0n, 999n)))
      expect(found.map(entry => [entry.blockNumber, entry.logIndex])).toEqual([
        [1n, 0],
        [499n, 0],
      ])
    })

    it('tells two logs of one transaction apart by their index', async () => {
      const client = fakeClient(() => [log(9n, 0), log(9n, 0, { logIndex: 1 })])
      expect(await ran(scanLogs(client, query(0n, 9n)))).toHaveLength(2)
    })

    it('tells the same transaction and index in two blocks apart by the block hash', async () => {
      const client = fakeClient(() => [log(9n, 0), log(9n, 0, { blockHash: hash(0xbeefn) })])
      expect(await ran(scanLogs(client, query(0n, 9n)))).toHaveLength(2)
    })

    it('drops a log the node marks removed, even one with nothing else on it', async () => {
      const client = wire(() => [rpcLog(log(1n)), { removed: true }, { ...rpcLog(log(2n)), removed: true }])
      expect(blocks(await ran(scanLogs(client, query(0n, 9n))))).toEqual([1n])
    })

    it('reads a log into viem numbers: a bigint block and numeric indexes', async () => {
      const entry = log(0x2d1d3can, 0x15, { transactionIndex: 4 })
      const client = wire(() => [rpcLog(entry)])
      expect(await ran(scanLogs(client, query(0x2d1d3can, 0x2d1d3can)))).toEqual([entry])
    })

    it('keeps the block timestamp Center sends with a log, and none when it sends none', async () => {
      const client = wire(() => [rpcLog(log(1n, 0, { blockTimestamp: 0x6ab70674n })), rpcLog(log(2n))])
      const [stamped, plain] = await ran(scanLogs(client, query(0n, 9n)))
      expect(stamped.blockTimestamp).toBe(0x6ab70674n)
      expect(plain.blockTimestamp).toBeUndefined()
    })

    it.each([
      ['an answer that is not a list', () => ({ logs: [] })],
      ['a null answer', () => null],
      ['a log with no block number', () => [{ ...rpcLog(log(1n)), blockNumber: null }]],
      ['a log with no transaction hash', () => [{ ...rpcLog(log(1n)), transactionHash: undefined }]],
      ['a log with no index', () => [{ ...rpcLog(log(1n)), logIndex: undefined }]],
      ['a block number that is not hex', () => [{ ...rpcLog(log(1n)), blockNumber: 'latest' }]],
      ['a topic that is not a hash', () => [{ ...rpcLog(log(1n)), topics: ['0x12'] }]],
      ['a timestamp that is not hex', () => [{ ...rpcLog(log(1n)), blockTimestamp: 'soon' }]],
      ['an address that is not one', () => [{ ...rpcLog(log(1n)), address: '0x12' }]],
      ['data that is not hex', () => [{ ...rpcLog(log(1n)), data: 'zz' }]],
      ['a log with no block hash', () => [{ ...rpcLog(log(1n)), blockHash: undefined }]],
      ['a log with no transaction index', () => [{ ...rpcLog(log(1n)), transactionIndex: undefined }]],
      ['something that is not a log', () => ['0x1']],
    ])('rejects %s', async (_what, answer) => {
      const client = wire(answer)
      await expect(ran(scanLogs(client, query(0n, 9n)))).rejects.toThrow(/RPC returned (invalid project history|an incomplete project event)/)
    })
  })
})

describe('projectHookLogs', () => {
  const CHAIN = 84532
  const deployment = stickyDeployment(CHAIN)!
  const KEY = `sticky.history.v1:${CHAIN}:${deployment.hook.toLowerCase()}:7`
  // The topics the old client scanned a project's history with, precomputed with `cast keccak`.
  const TOPICS = {
    Staked: '0xd6d3230e3db876114bd3eea9c8a9b54a70c8263b762d4086170e2089e4506aa9',
    Unstaked: '0x169f9c267fbc671daf3188c40c7ac44f00fbd8d51133fe23364b771c207297cc',
    StreakStarted: '0xbf35648fc2c3b2611046bd0e40788ec1f1ccec09ab1d1188dd0ce73b8683009d',
    StreakEnded: '0x633ff8e26572566ae370cee18c8b3c0a5370f533bb490764ab6586c0a404e4ea',
    SetGranter: '0xb1493c7092cfd1c7e27c08ccd5e2f65f3408075032bdcc2983702abb376f9521',
    SetTrustedSender: '0x19cb6ea1a683846f033314fc7883a280ffee4abf9e75f0c699a947575f182e69',
    ExcludeOrphanedBalance: '0xa0b9b2db99d31a6b0fbb43cedfc627f78ae7c1b1f39d286ed7c61b5c9bba83fa',
    Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  } as const satisfies Record<string, Hex>
  const PROJECT_TOPICS = Object.values(TOPICS).slice(0, 7)
  const word = (n: bigint) => pad(toHex(n), { size: 32 })
  const HOLDER = pad(`0x${'ab'.repeat(20)}`, { size: 32 })

  const hookLog = (block: bigint, projectId = 7n, index = 0, topic: Hex = TOPICS.Staked): ScannedLog =>
    log(block, index, { address: deployment.hook, topics: [topic, word(projectId), HOLDER] })

  // The chain the fake Center reads: `events` is everything on it, `head` its latest block. The node
  // honours the filter, so a scan that asked for the wrong project or the wrong events reads nothing.
  let events: ScannedLog[]
  let head: bigint
  let failWith: Error | null
  function serve() {
    const node = wire(filter => {
      if (failWith) throw failWith
      const wanted = rangeOf(filter)
      return events
        .filter(
          entry =>
            entry.address.toLowerCase() === wanted.address.toLowerCase() &&
            entry.blockNumber >= wanted.fromBlock &&
            entry.blockNumber <= wanted.toBlock &&
            wanted.topics.every((topic, at) =>
              topic === null ? true : Array.isArray(topic) ? topic.includes(entry.topics[at]) : topic === entry.topics[at],
            ),
        )
        .map(rpcLog)
    })
    const client = { request: node.request, asked: node.asked, getBlockNumber: vi.fn(async () => head) }
    center.client.mockReturnValue(client as unknown as PublicClient)
    return node
  }
  const saved = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as { through: string; all: Record<string, unknown>[] } | null
  const savedBlocks = () => saved()?.all.map(entry => BigInt(entry.blockNumber as string))
  const firstAsked = (node: FakeClient) => node.asked[0]?.fromBlock

  beforeEach(() => {
    center.client.mockReset()
    localStorage.clear()
    events = []
    head = 0x1000n
    failWith = null
  })

  it('scans the project a hook logs for, from the block it was given, and for the project alone', async () => {
    events = [hookLog(0x20n), hookLog(0x30n, 8n), hookLog(0x40n, 7n, 0, TOPICS.Transfer), hookLog(0x50n, 7n, 0, TOPICS.SetGranter)]
    const node = serve()
    const found = await projectHookLogs(CHAIN, 7n, 0x10n)
    expect(blocks(found)).toEqual([0x20n, 0x50n])
    expect(center.client).toHaveBeenCalledWith(CHAIN)
    // The events the old client scanned with, for the project alone.
    expect(node.asked[0]).toMatchObject({ fromBlock: 0x10n, address: deployment.hook })
    expect(node.asked.every(range => range.topics.length === 2 && range.topics[1] === word(7n))).toBe(true)
    expect(new Set(node.asked[0].topics[0])).toEqual(new Set(PROJECT_TOPICS))
    expect(node.asked.at(-1)?.toBlock).toBe(0x1000n)
  })

  it('says so when Sticky is not deployed on the chain, without asking anyone', async () => {
    const node = serve()
    await expect(projectHookLogs(1234, 7n, 0n)).rejects.toThrow('Sticky is not deployed on chain 1234.')
    expect(node.asked).toEqual([])
  })

  describe('the history it keeps in the browser', () => {
    it('keeps what a reorg cannot replace, 64 blocks below the head, and only that', async () => {
      events = [hookLog(0x20n), hookLog(0xff0n)]
      serve()
      expect(blocks(await projectHookLogs(CHAIN, 7n, 0x10n))).toEqual([0x20n, 0xff0n])
      expect(saved()?.through).toBe(String(0x1000n - 64n))
      // 0xff0 is inside the last 64 blocks: it is returned but not kept.
      expect(savedBlocks()).toEqual([0x20n])
    })

    it('scans only the blocks after what it kept, and never doubles a kept event', async () => {
      events = [hookLog(0x20n), hookLog(0xff0n)]
      serve()
      await projectHookLogs(CHAIN, 7n, 0x10n)

      events = [...events, hookLog(0x1005n)]
      head = 0x1100n
      const node = serve()
      const found = await projectHookLogs(CHAIN, 7n, 0x10n)

      expect(blocks(found)).toEqual([0x20n, 0xff0n, 0x1005n])
      expect(firstAsked(node)).toBe(0x1000n - 64n + 1n)
      expect(node.asked.every(range => range.fromBlock > 0x1000n - 64n)).toBe(true)
      expect(saved()?.through).toBe(String(0x1100n - 64n))
      expect(savedBlocks()).toEqual([0x20n, 0xff0n, 0x1005n])
    })

    it('never moves what it kept backwards, when a lagging node reports an older head', async () => {
      events = [hookLog(0x20n), hookLog(0xff0n)]
      serve()
      await projectHookLogs(CHAIN, 7n, 0x10n)
      head = 0x1100n
      serve()
      await projectHookLogs(CHAIN, 7n, 0x10n)
      const before = localStorage.getItem(KEY)

      head = 0x1080n
      const node = serve()
      const found = await projectHookLogs(CHAIN, 7n, 0x10n)

      expect(localStorage.getItem(KEY)).toBe(before)
      expect(blocks(found)).toEqual([0x20n, 0xff0n])
      expect(node.asked).toEqual([])
    })

    it.each([60n, 64n])('keeps nothing while the head is at block %s, within 64 blocks of the start', async at => {
      head = at
      events = [hookLog(0x20n)]
      serve()
      expect(blocks(await projectHookLogs(CHAIN, 7n, 0n))).toEqual([0x20n])
      expect(localStorage.getItem(KEY)).toBeNull()
    })

    it('keeps a history through block 1 once the head is at block 65', async () => {
      head = 65n
      events = [hookLog(0x20n)]
      serve()
      expect(blocks(await projectHookLogs(CHAIN, 7n, 0n))).toEqual([0x20n])
      expect(saved()).toMatchObject({ through: '1', all: [] })
    })

    it('returns each log once and in order, even when what it kept did not', async () => {
      const [a, b] = [rpcLog(hookLog(0x20n)), rpcLog(hookLog(0x30n))]
      localStorage.setItem(KEY, JSON.stringify({ through: '4032', all: [b, a, b, a] }))
      events = [hookLog(0x1000n)]
      serve()
      expect(blocks(await projectHookLogs(CHAIN, 7n, 0n))).toEqual([0x20n, 0x30n, 0x1000n])
    })

    it('keeps the block timestamp and every other field of what it kept, exactly', async () => {
      events = [
        hookLog(0x20n),
        { ...hookLog(0x21n, 7n, 3), blockTimestamp: 0x6ab70674n, transactionIndex: 9, data: '0x1234' },
      ]
      serve()
      const first = await projectHookLogs(CHAIN, 7n, 0n)
      head = 0x1100n
      const node = serve()
      const second = await projectHookLogs(CHAIN, 7n, 0n)
      expect(second).toEqual(first)
      expect(second[1]).toEqual(events[1])
      expect(firstAsked(node)).toBe(0x1000n - 64n + 1n)
    })

    it('writes what the old client wrote: the block after `through`, as JSON-RPC logs', async () => {
      events = [hookLog(0x20n, 7n, 2)]
      serve()
      await projectHookLogs(CHAIN, 7n, 0n)
      expect(saved()).toEqual({
        through: '4032',
        all: [
          {
            address: deployment.hook,
            blockHash: hash(0x20n + 0x1000n),
            blockNumber: '0x20',
            data: '0x',
            logIndex: '0x2',
            removed: false,
            topics: [TOPICS.Staked, word(7n), HOLDER],
            transactionHash: hash(0x20n * 100n + 2n + 0x50_0000n),
            transactionIndex: '0x0',
          },
        ],
      })
    })

    it('reads a history the old client saved, timestamps and all, and resumes after it', async () => {
      const old = {
        ...JSON.parse(JSON.stringify(rpcLog(hookLog(0x20n)))),
        ts: 1_700_000_000,
      }
      localStorage.setItem(KEY, JSON.stringify({ through: String(0xf00), all: [old] }))
      events = [hookLog(0x20n), hookLog(0xf80n)]
      const node = serve()
      const found = await projectHookLogs(CHAIN, 7n, 0n)
      expect(blocks(found)).toEqual([0x20n, 0xf80n])
      expect(firstAsked(node)).toBe(0xf01n)
      expect(found[0]).toEqual(hookLog(0x20n))
    })

    it('keeps its history per chain, hook and project', async () => {
      events = [hookLog(0x20n), hookLog(0x21n, 8n)]
      serve()
      await projectHookLogs(CHAIN, 7n, 0n)
      expect(localStorage.length).toBe(1)
      expect(localStorage.key(0)).toBe(KEY)

      // Another project starts from its own beginning, whatever this one kept.
      const node = serve()
      expect(blocks(await projectHookLogs(CHAIN, 8n, 0x5n))).toEqual([0x21n])
      expect(firstAsked(node)).toBe(0x5n)
      expect(localStorage.getItem(`sticky.history.v1:${CHAIN}:${deployment.hook.toLowerCase()}:8`)).not.toBeNull()
    })

    it('leaves what it kept as it was when a scan fails', async () => {
      events = [hookLog(0x20n)]
      serve()
      await projectHookLogs(CHAIN, 7n, 0n)
      const before = localStorage.getItem(KEY)

      head = 0x1100n
      failWith = new Error('archive unavailable')
      serve()
      await expect(projectHookLogs(CHAIN, 7n, 0n)).rejects.toThrow('archive unavailable')
      expect(localStorage.getItem(KEY)).toBe(before)
    })

    describe('the size it keeps', () => {
      // A history that takes exactly `chars` once stored, found by measuring what it writes.
      async function stored(data: string) {
        localStorage.clear()
        events = [hookLog(0x20n, 7n, 0)]
        events[0] = { ...events[0], data: `0x${data}` as Hex }
        serve()
        await projectHookLogs(CHAIN, 7n, 0n)
        return localStorage.getItem(KEY)
      }

      it('keeps a history of 400,000 characters and drops one of 400,001', async () => {
        const base = (await stored(''))!.length
        expect((await stored('a'.repeat(400_000 - base)))?.length).toBe(400_000)
        expect(await stored('a'.repeat(400_001 - base))).toBeNull()
      })

      it('drops what it had kept when the history has outgrown the limit', async () => {
        events = [hookLog(0x20n)]
        serve()
        await projectHookLogs(CHAIN, 7n, 0n)
        expect(localStorage.getItem(KEY)).not.toBeNull()

        // A thousand events after the saved block, each carrying some data.
        head = 0x2000n
        events = Array.from({ length: 1_000 }, (_, at) => ({ ...hookLog(BigInt(0x1000 + at)), data: `0x${'ab'.repeat(100)}` as Hex }))
        serve()
        // The one it had kept, and the thousand since.
        expect(await projectHookLogs(CHAIN, 7n, 0n)).toHaveLength(1_001)
        expect(localStorage.getItem(KEY)).toBeNull()
      })
    })

    describe('storage that cannot be trusted', () => {
      const kept = () => hookLog(0x20n)

      it.each([
        ['text that is not JSON', '{'],
        ['null', 'null'],
        ['a list', '[]'],
        ['a `through` that is not text', '{"through":5,"all":[]}'],
        ['a `through` that is not a block number', '{"through":"abc","all":[]}'],
        ['a negative `through`', '{"through":"-5","all":[]}'],
        ['no list of logs', '{"through":"4032"}'],
        ['a log with fields missing', '{"through":"4032","all":[{"blockNumber":"0x20"}]}'],
        ['a log past `through`', `{"through":"1","all":[${JSON.stringify(rpcLog(kept()))}]}`],
      ])('scans everything again when it finds %s', async (_what, garbage) => {
        localStorage.setItem(KEY, garbage)
        events = [hookLog(0x20n), hookLog(0x30n)]
        const node = serve()
        expect(blocks(await projectHookLogs(CHAIN, 7n, 0x10n))).toEqual([0x20n, 0x30n])
        expect(firstAsked(node)).toBe(0x10n)
        // And what it writes after is a history it can read.
        expect(saved()?.through).toBe(String(0x1000n - 64n))
        expect(savedBlocks()).toEqual([0x20n, 0x30n])
      })

      it('scans and answers as usual when the browser will not read storage', async () => {
        events = [hookLog(0x20n)]
        serve()
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
          throw new DOMException('denied', 'SecurityError')
        })
        expect(blocks(await projectHookLogs(CHAIN, 7n, 0n))).toEqual([0x20n])
      })

      it('answers as usual when the browser will not write storage', async () => {
        events = [hookLog(0x20n)]
        serve()
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
          throw new DOMException('full', 'QuotaExceededError')
        })
        expect(blocks(await projectHookLogs(CHAIN, 7n, 0n))).toEqual([0x20n])
      })

      it('answers as usual when there is no storage at all', async () => {
        events = [hookLog(0x20n)]
        serve()
        const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          get() {
            throw new DOMException('denied', 'SecurityError')
          },
        })
        try {
          expect(blocks(await projectHookLogs(CHAIN, 7n, 0n))).toEqual([0x20n])
        } finally {
          if (original) Object.defineProperty(globalThis, 'localStorage', original)
        }
      })
    })
  })
})
