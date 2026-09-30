// @vitest-environment node

import { pad, toHex, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyDeployment } from '@/lib/sticky-addresses'

// The same scans as hook-logs.test.ts, but through the real Center reader, so viem's own retry, the SDK's
// request errors and the way viem wraps them are all in play and only the HTTP call to Center is faked.
// Telling a rate limit from a refused range rests on those shapes.

const CHAIN = 84532
const HOOK = stickyDeployment(CHAIN)!.hook

// A hook log as Center returned it for Base Sepolia.
const CENTER_LOG = {
  address: '0xa8dcd735031cf96c4213d9a3f66a1dffdcdba693',
  topics: [
    '0x768e177d7f9dac714049e6d43d9ac533cf0c6cc23cddcfe642bfd7a18bee3772',
    '0x0000000000000000000000000000000000000000000000000000000000000025',
  ],
  data: '0x000000000000000000000000ee528a64f4afe524ba220c7cf0ea0c0278d0f232000000000000000000000000da38ec48b5b1d186b02ba99f297e95153bee33a9',
  blockHash: '0xc1c0d29c16fb2cc2a9b627fb2607cae7b248cebf01d0c8dd4eaa7d2c59d77372',
  blockNumber: '0x2d1d3ca',
  blockTimestamp: '0x6ab70674',
  transactionHash: '0xf008185503b317dfa999c0644652bd06dd647e804ff0fc85ddb7079d25eebc08',
  transactionIndex: '0x4',
  logIndex: '0x15',
  removed: false,
}
const AT = BigInt(CENTER_LOG.blockNumber)

/** A request that reached Center: its range, the time, and how many requests were in flight then, itself included. */
type Call = { from: bigint; to: bigint; at: number; inFlight: number }
const json = { 'content-type': 'application/json' }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const hash = (n: bigint): Hex => pad(toHex(n), { size: 32 })
/** The fixture's log, moved to another block. */
const centerLogAt = (block: bigint) => ({
  ...CENTER_LOG,
  blockNumber: toHex(block),
  blockHash: hash(block + 0x1000n),
  transactionHash: hash(block),
})
const answer = (id: number, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: json })
const rpcError = (id: number, code: number, message: string) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { headers: json })
// Center's own refusals: a JSON body with an error code and message.
const refuse = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { ...json, ...headers } })

/** Center answering eth_getLogs, and nothing else. `respond` gets each request, with the log of the fixture
 * to hand back when its range holds one. `calls` lists every request that reached Center, and when. */
function center(respond: (id: number, call: Call, holds: boolean) => Response | Promise<Response>) {
  const calls: Call[] = []
  let running = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const { id, method, params } = JSON.parse(String(init.body)) as {
        id: number
        method: string
        params: [{ address: string; fromBlock: Hex; toBlock: Hex }]
      }
      if (method !== 'eth_getLogs') throw new Error(`unexpected ${method}`)
      running += 1
      const call = { from: BigInt(params[0].fromBlock), to: BigInt(params[0].toBlock), at: Date.now(), inFlight: running }
      calls.push(call)
      try {
        return await respond(id, call, call.from <= AT && AT <= call.to)
      } finally {
        running -= 1
      }
    }),
  )
  return calls
}

/** Center's rate limit for one client: a count for each window aligned to the epoch minute, in which refused
 * requests count too, and every refusal says to retry in a minute. A request let through takes `latency` ms
 * and answers with one log at the start of its range. `refusals` lists the time of each refused request. */
function rateLimited(perMinute: number, latency: number) {
  const counts = new Map<number, number>()
  const refusals: number[] = []
  const respond = async (id: number, call: Call) => {
    const window = Math.floor(Date.now() / 60_000)
    const count = (counts.get(window) ?? 0) + 1
    counts.set(window, count)
    if (count > perMinute) {
      refusals.push(Date.now())
      return refuse(429, 'rate_limit', 'Request limit exceeded', { 'retry-after': '60' })
    }
    await sleep(latency)
    return answer(id, [centerLogAt(call.from)])
  }
  return { respond, refusals }
}

// The Center reader is made once per chain, so each test loads its own copy.
async function load() {
  vi.resetModules()
  const [{ scanLogs }, { jbCenterPublicClient }] = await Promise.all([import('@/lib/hook-logs'), import('@/lib/jbcenter-rpc')])
  type Options = { maxInFlight?: number; maxRequests?: number; signal?: AbortSignal }
  /** A scan that has begun, for a test that acts while it is under way. */
  const begin = (fromBlock: bigint, toBlock: bigint, options?: Options) =>
    scanLogs(jbCenterPublicClient(CHAIN), { address: HOOK as Address, topics: [], fromBlock, toBlock }, options)
  /** A scan run to its end. */
  return { begin, scan: (fromBlock: bigint, toBlock: bigint, options?: Options) => ran(begin(fromBlock, toBlock, options)) }
}

/** Runs a scan to its end on fake time, so viem's retry and the scan's backoff cost no real waiting. */
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

beforeEach(() => {
  vi.useFakeTimers()
})

describe('scanLogs through the Center reader', () => {
  it('asks for 500 blocks at a time and reads a log as Center sends it, with its block timestamp', async () => {
    const calls = center((id, _call, holds) => answer(id, holds ? [CENTER_LOG] : []))
    const { scan } = await load()

    const found = await scan(AT - 100n, AT + 1_399n)

    expect(calls.map(({ from, to }) => [from, to])).toEqual([
      [AT - 100n, AT + 399n],
      [AT + 400n, AT + 899n],
      [AT + 900n, AT + 1_399n],
    ])
    expect(found).toEqual([
      {
        address: CENTER_LOG.address,
        topics: CENTER_LOG.topics,
        data: CENTER_LOG.data,
        blockHash: CENTER_LOG.blockHash,
        blockNumber: 47_305_674n,
        blockTimestamp: 0x6ab70674n,
        transactionHash: CENTER_LOG.transactionHash,
        transactionIndex: 4,
        logIndex: 21,
        removed: false,
      },
    ])
  })

  it('backs off on Center 429, which viem reports as an unknown RPC error around the SDK error, and finishes', async () => {
    let refused = 0
    const calls = center((id, _call, holds) => {
      // viem tries a failed request once more by itself, so one refusal by the scan is two of these.
      if (refused < 2) {
        refused += 1
        return refuse(429, 'rate_limit', 'Request limit exceeded', { 'retry-after': '60' })
      }
      return answer(id, holds ? [CENTER_LOG] : [])
    })
    const { scan } = await load()

    const found = await scan(AT - 100n, AT + 399n)

    expect(found).toHaveLength(1)
    // Never split: every request was for the whole range. Center said Retry-After: 60, which the SDK puts on its
    // error as 60, so the scan waited the minute rather than a second before its retry.
    expect(calls).toHaveLength(3)
    expect(calls.every(({ from, to }) => from === AT - 100n && to === AT + 399n)).toBe(true)
    expect(calls[2].at - calls[1].at).toBe(60_000)
  })

  it('waits 1 s, then 2 s, then 4 s when Center sends a 429 with no Retry-After', async () => {
    let refused = 0
    const calls = center((id, _call, holds) => {
      // Three refusals by the scan, each two requests with viem's own retry.
      if (refused < 6) {
        refused += 1
        return refuse(429, 'rate_limit', 'Request limit exceeded')
      }
      return answer(id, holds ? [CENTER_LOG] : [])
    })
    const { scan } = await load()

    expect(await scan(AT - 100n, AT + 399n)).toHaveLength(1)

    expect(calls).toHaveLength(7)
    // From the second request of one try to the first of the next.
    expect([2, 4, 6].map(at => calls[at].at - calls[at - 1].at)).toEqual([1_000, 2_000, 4_000])
  })

  it('backs off on a 429 sent as a JSON-RPC error too', async () => {
    let refused = 0
    const calls = center((id, _call, holds) => {
      if (refused < 2) {
        refused += 1
        return rpcError(id, 429, 'Too Many Requests')
      }
      return answer(id, holds ? [CENTER_LOG] : [])
    })
    const { scan } = await load()
    expect(await scan(AT - 100n, AT + 399n)).toHaveLength(1)
    expect(calls).toHaveLength(3)
    expect(calls.every(({ from, to }) => from === AT - 100n && to === AT + 399n)).toBe(true)
  })

  it('gives up after three retries of a range Center keeps refusing with 429, and reports the 429', async () => {
    const calls = center(() => refuse(429, 'rate_limit', 'Request limit exceeded', { 'retry-after': '60' }))
    const { scan } = await load()

    await expect(scan(AT - 100n, AT + 399n)).rejects.toMatchObject({ cause: { status: 429 } })

    // Four tries by the scan, two requests each with viem's own retry, all for the one range, and a minute, as
    // Center asked, before each retry.
    expect(calls).toHaveLength(8)
    expect(calls.every(({ from, to }) => from === AT - 100n && to === AT + 399n)).toBe(true)
    expect([2, 4, 6].map(at => calls[at].at - calls[at - 1].at)).toEqual([60_000, 60_000, 60_000])
  })

  it('completes a scan of 138 windows that runs into the rate window, waiting out the minute with at most 2 in flight', async () => {
    // At 2 requests in flight of 750 ms each a scan runs at 160 requests a minute, and this client is allowed 120:
    // from the start of a window, the 121st request at 45 s is refused and so are the ones after it.
    vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'))
    const limit = rateLimited(120, 750)
    const calls = center(limit.respond)
    const { scan } = await load()

    const found = await scan(1_000n, 1_000n + 138n * 500n - 1n)

    // Every window was read, in order.
    expect(found.map(entry => entry.blockNumber)).toEqual(Array.from({ length: 138 }, (_, at) => 1_000n + BigInt(at) * 500n))
    // It did run into the limit, and never had more than two requests in flight, waiting or not.
    expect(limit.refusals.length).toBeGreaterThan(0)
    expect(Math.max(...calls.map(call => call.inFlight))).toBe(2)
    // After the last refusal nothing was sent for a minute, so the retries fell in the next window.
    const lastRefusal = Math.max(...limit.refusals)
    expect(calls.filter(call => call.at > lastRefusal).every(call => call.at >= lastRefusal + 60_000)).toBe(true)
    // No window was tried more than three times: once refused twice by viem, then read.
    const tries = new Map<bigint, number>()
    for (const call of calls) tries.set(call.from, (tries.get(call.from) ?? 0) + 1)
    expect(Math.max(...tries.values())).toBeLessThanOrEqual(3)
  })

  it('halves a range Center refuses with -32005 "RPC request failed", which states no span', async () => {
    const calls = center((id, { from, to }, holds) => {
      if (to - from + 1n > 100n) return rpcError(id, -32005, 'RPC request failed')
      return answer(id, holds ? [CENTER_LOG] : [])
    })
    const { scan } = await load()

    const found = await scan(AT - 100n, AT + 399n)

    expect(found).toHaveLength(1)
    expect(found[0].blockNumber).toBe(AT)
    // The scan asked a range Center refused, then its halves, down to what Center answers.
    expect(calls.some(({ from, to }) => to - from + 1n > 100n)).toBe(true)
    expect(calls.filter(({ from, to }) => to - from + 1n <= 100n).length).toBeGreaterThanOrEqual(5)
  })

  it('splits into the span a refusal states, whether Center sends it with a 413 or as a JSON-RPC error', async () => {
    for (const refusal of [
      () => refuse(413, 'body_too_large', 'eth_getLogs is limited to a 100 range'),
      (id: number) => rpcError(id, -32614, 'eth_getLogs is limited to a 100 range'),
    ]) {
      const calls = center((id, { from, to }, holds) =>
        to - from + 1n > 100n ? refusal(id) : answer(id, holds ? [CENTER_LOG] : []),
      )
      const { scan } = await load()
      expect(await scan(AT - 100n, AT + 399n)).toHaveLength(1)
      // One refused range (twice, as viem asks again), then five windows of 100.
      expect(calls.filter(({ from, to }) => to - from + 1n === 100n)).toHaveLength(5)
      expect(calls.filter(({ from, to }) => to - from + 1n > 100n)).toHaveLength(2)
    }
  })

  describe('a signal that cancels the scan', () => {
    const reason = new Error('left the page')

    it('stops waiting out a Retry-After the moment it aborts, and sends nothing more', async () => {
      const calls = center(() => refuse(429, 'rate_limit', 'Request limit exceeded', { 'retry-after': '60' }))
      const { begin } = await load()
      const controller = new AbortController()

      const scan = begin(AT - 100n, AT + 399n, { signal: controller.signal })
      const outcome = expect(scan).rejects.toBe(reason)
      // viem has tried again by itself, and the scan is now waiting out the minute.
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls).toHaveLength(2)
      controller.abort(reason)
      await outcome
      await vi.runAllTimersAsync()
      expect(calls).toHaveLength(2)
    })

    it('reaches viem, whose own retry then does not go out', async () => {
      const calls = center(() => refuse(429, 'rate_limit', 'Request limit exceeded'))
      const { begin } = await load()
      const controller = new AbortController()

      const scan = begin(AT - 100n, AT + 399n, { signal: controller.signal })
      const outcome = expect(scan).rejects.toBe(reason)
      // The first request was refused and viem is waiting to send it again.
      await vi.advanceTimersByTimeAsync(20)
      expect(calls).toHaveLength(1)
      controller.abort(reason)
      await outcome
      await vi.runAllTimersAsync()
      expect(calls).toHaveLength(1)
    })
  })

  it.each([
    ['a bad gateway', () => refuse(502, 'bad_gateway', 'upstream failed')],
    ['a server error sent as a JSON-RPC error', (id: number) => rpcError(id, -32000, 'execution timeout')],
    ['an answer that is not JSON', () => new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } })],
  ])('fails, with nothing found, on %s', async (_what, failure) => {
    center((id, { from }, holds) => (from === AT - 100n + 500n ? failure(id) : answer(id, holds ? [CENTER_LOG] : [])))
    const { scan } = await load()
    await expect(scan(AT - 100n, AT + 899n)).rejects.toBeInstanceOf(Error)
  })
})
