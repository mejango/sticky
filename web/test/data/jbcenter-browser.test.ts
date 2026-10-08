import { base, optimism } from '@bananapus/nana-sdk-core/chains'
import { createPublicClient, erc20Abi, numberToHex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The browser's Center reader, with only `fetch` faked: every chain's requests and every reader's of the tab share
// the SDK's paced request starts, a page's requests go with its signal, and a 429's Retry-After holds new starts,
// viem's own retry included. Slow responses must never hold later chains behind a whole-request concurrency limit.

const ticks = async (count = 5) => {
  for (let at = 0; at < count; at += 1) await Promise.resolve()
}

/** Center's answer to one JSON-RPC request, or its refusal of the rest of the minute. */
const answered = (id: number, result: unknown) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json' } })
const refusal = (retryAfter: string) =>
  new Response(JSON.stringify({ error: { code: 'rate_limit', message: 'Request limit exceeded' } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
  })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the browser\'s Center reader', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  it('paces every chain\'s request starts independently of unresolved responses', async () => {
    const answers: (() => void)[] = []
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
        sent.push(`${input.slice(input.lastIndexOf('/') + 1)} ${method}`)
        await new Promise<void>(resolve => answers.push(resolve))
        return answered(id, numberToHex(100n))
      }),
    )
    const { jbCenterPublicClient } = await import('@/lib/jbcenter-rpc')
    // Three chains' heads, and a log scan's request with its signal.
    const reads = [8453, 10, 1].map(chainId => jbCenterPublicClient(chainId).getBlockNumber({ cacheTime: 0 }))
    const scan = jbCenterPublicClient(8453).request({ method: 'eth_chainId' }, { signal: new AbortController().signal })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['8453 eth_blockNumber'])
    await vi.advanceTimersByTimeAsync(124)
    expect(sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toEqual(['8453 eth_blockNumber', '10 eth_blockNumber'])
    await vi.advanceTimersByTimeAsync(250)
    expect(sent).toEqual(['8453 eth_blockNumber', '10 eth_blockNumber', '1 eth_blockNumber', '8453 eth_chainId'])
    expect(answers).toHaveLength(4)
    while (answers.length) answers.shift()!()
    await expect(Promise.all(reads)).resolves.toEqual([100n, 100n, 100n])
    await expect(scan).resolves.toBe('0x64')
    expect(sent[3]).toBe('8453 eth_chainId')
  })

  it('shares pacing with every reader of the tab, including wagmi and the Center wallet', async () => {
    const answers: (() => void)[] = []
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
        sent.push(`${input.slice(input.lastIndexOf('/') + 1)} ${method}`)
        await new Promise<void>(resolve => answers.push(resolve))
        return answered(id, numberToHex(100n))
      }),
    )
    const { jbCenterPublicClient, jbCenterRpcTransport } = await import('@/lib/jbcenter-rpc')
    // wagmi's client for a chain is built on the same transport, and the Center wallet asks through it directly.
    const wagmi = createPublicClient({ chain: optimism, transport: jbCenterRpcTransport(optimism.id) })
    const wallet = jbCenterRpcTransport(8453)({ chain: base })
    const reads = [
      wagmi.getBlockNumber({ cacheTime: 0 }),
      jbCenterPublicClient(8453).getBlockNumber({ cacheTime: 0 }),
      wallet.request({ method: 'eth_blockNumber' }),
    ]
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['10 eth_blockNumber'])
    await vi.advanceTimersByTimeAsync(250)
    expect(sent).toEqual(['10 eth_blockNumber', '8453 eth_blockNumber', '8453 eth_blockNumber'])
    while (answers.length) answers.shift()!()
    await expect(Promise.all(reads)).resolves.toEqual([100n, 100n, '0x64'])
  })

  it('aborts a page\'s in-flight request and queued request without delaying another reader', async () => {
    const sent: string[] = []
    const stopped: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
        const what = `${input.slice(input.lastIndexOf('/') + 1)} ${method}`
        sent.push(what)
        if (method !== 'eth_getLogs') return answered(id, numberToHex(100n))
        // Center holds a scan's answer until the request is stopped.
        return new Promise<Response>((_, reject) =>
          init.signal!.addEventListener('abort', () => {
            stopped.push(what)
            reject(init.signal!.reason)
          }),
        )
      }),
    )
    const { jbCenterPublicClient } = await import('@/lib/jbcenter-rpc')
    const page = new AbortController()
    const logs = { method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x1f4' }] } as never
    const scans = [8453, 10].map(chainId =>
      jbCenterPublicClient(chainId).request(logs, { signal: page.signal }).catch((error: unknown) => error),
    )
    const head = jbCenterPublicClient(1).getBlockNumber({ cacheTime: 0 })
    await vi.advanceTimersByTimeAsync(100)
    expect(sent).toEqual(['8453 eth_getLogs'])

    page.abort(new Error('left the page'))
    await vi.advanceTimersByTimeAsync(25)
    await expect(head).resolves.toBe(100n)
    expect(sent).toEqual(['8453 eth_getLogs', '1 eth_blockNumber'])
    expect(stopped).toEqual(['8453 eth_getLogs'])
    await Promise.all(scans)
  })

  it('sends every read of a page\'s reader with the page\'s signal: once the page is left, what waits is never sent', async () => {
    const answers: (() => void)[] = []
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
        sent.push(`${input.slice(input.lastIndexOf('/') + 1)} ${method}`)
        await new Promise<void>(resolve => answers.push(resolve))
        return answered(id, numberToHex(100n))
      }),
    )
    const [{ jbCenterPublicClient }, { freshHead }] = await Promise.all([import('@/lib/jbcenter-rpc'), import('@/lib/hook-logs')])
    // Another page's first read starts; the next waits for its paced start.
    const others = [10, 1].map(chainId => jbCenterPublicClient(chainId).getBlockNumber({ cacheTime: 0 }))
    await vi.advanceTimersByTimeAsync(0)

    // The page's head, its pinned block and a Multicall3 read wait for a paced start.
    const page = new AbortController()
    const reader = jbCenterPublicClient(8453, page.signal)
    const token = `0x${'a'.repeat(40)}` as const
    const reads = [
      freshHead(8453, page.signal),
      reader.getBlock(),
      reader.multicall({ contracts: [{ address: token, abi: erc20Abi, functionName: 'totalSupply' }], allowFailure: false }),
    ].map(read => read.catch((error: unknown) => error))
    await ticks(20)
    page.abort(new Error('left the page'))
    await vi.advanceTimersByTimeAsync(125)
    while (answers.length) answers.shift()!()

    await expect(Promise.all(others)).resolves.toEqual([100n, 100n])
    await Promise.all(reads)
    await ticks(20)
    expect(sent).toEqual(['10 eth_blockNumber', '1 eth_blockNumber'])
  })

  it('reads a page\'s head afresh each time it is asked for, sharing one already under way', async () => {
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string, init: RequestInit) => {
        const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
        sent.push(method)
        return answered(id, numberToHex(BigInt(100 + sent.length)))
      }),
    )
    const { jbCenterPublicClient } = await import('@/lib/jbcenter-rpc')
    const reader = jbCenterPublicClient(8453, new AbortController().signal)

    const shared = Promise.all([reader.getBlockNumber(), reader.getBlockNumber()])
    await vi.advanceTimersByTimeAsync(0)
    await expect(shared).resolves.toEqual([101n, 101n])
    const next = reader.getBlockNumber()
    await vi.advanceTimersByTimeAsync(125)
    await expect(next).resolves.toBe(102n)
    expect(sent).toEqual(['eth_blockNumber', 'eth_blockNumber'])
  })

  it('paces retries of a lagging block without waiting for other readers\' responses', async () => {
    const answers: (() => void)[] = []
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
        sent.push(`${input.slice(input.lastIndexOf('/') + 1)} ${method}`)
        // The node that answers first has not imported the pinned block yet.
        if (sent.length === 1) {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'RPC request failed' } }), {
            headers: { 'content-type': 'application/json' },
          })
        }
        await new Promise<void>(resolve => answers.push(resolve))
        return answered(id, numberToHex(100n))
      }),
    )
    const { jbCenterPublicClient } = await import('@/lib/jbcenter-rpc')
    const pinned = jbCenterPublicClient(8453).request({ method: 'eth_call', params: [{ to: `0x${'a'.repeat(40)}`, data: '0x' }, '0x64'] } as never)
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['8453 eth_call'])

    // While it waits to ask again, other readers start.
    const heads = [10, 1].map(chainId => jbCenterPublicClient(chainId).getBlockNumber({ cacheTime: 0 }))
    await vi.advanceTimersByTimeAsync(250)
    expect(sent).toEqual(['8453 eth_call', '10 eth_blockNumber', '1 eth_blockNumber'])

    // Its retry gets its own paced start, while both other reads remain unresolved.
    expect(sent).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(125)
    expect(sent[3]).toBe('8453 eth_call')
    while (answers.length) answers.shift()!()
    await expect(Promise.all([pinned, ...heads])).resolves.toEqual(['0x64', 100n, 100n])
  })

  it('starts review reads while page scans are unanswered and retains the 15-second request timeout', async () => {
    const sent: string[] = []
    const timedOut: number[] = []
    const start = Date.now()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
        sent.push(`${input.slice(input.lastIndexOf('/') + 1)} ${method}`)
        if (method !== 'eth_getLogs') return answered(id, numberToHex(100n))
        // Center never answers the page's scans.
        return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => {
          timedOut.push(Date.now() - start)
          reject(init.signal!.reason)
        }))
      }),
    )
    const { jbCenterPublicClient, jbCenterRpcTransport } = await import('@/lib/jbcenter-rpc')
    const page = new AbortController()
    const logs = { method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x1f4' }] } as never
    const scans = [8453, 10].map(chainId => jbCenterPublicClient(chainId, page.signal).request(logs).catch((error: unknown) => error))
    // A write's review reads through the Center wallet's transport.
    const review = jbCenterRpcTransport(8453)({ chain: base }).request({ method: 'eth_blockNumber' })
    await vi.advanceTimersByTimeAsync(250)
    expect(sent[2]).toBe('8453 eth_blockNumber')
    await expect(review).resolves.toBe('0x64')
    expect(timedOut).toEqual([])
    await vi.advanceTimersByTimeAsync(14_750)
    expect(timedOut).toContain(15_000)
    page.abort(new Error('left the page'))
    await Promise.all(scans)
  })

  it('sends nothing at all while a Retry-After runs, its own retry of the refused request included', async () => {
    const sent: { at: number; what: string }[] = []
    const start = Date.now()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
        sent.push({ at: Date.now() - start, what: `${input.slice(input.lastIndexOf('/') + 1)} ${method}` })
        // Center refuses the first request, and the rest of its minute.
        return sent.length === 1 ? refusal('60') : answered(id, numberToHex(100n))
      }),
    )
    const { jbCenterPublicClient } = await import('@/lib/jbcenter-rpc')
    const refused = jbCenterPublicClient(8453).getBlockNumber({ cacheTime: 0 })
    await vi.advanceTimersByTimeAsync(0)
    const other = jbCenterPublicClient(10).getBlockNumber({ cacheTime: 0 })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(sent.map(({ what }) => what)).toEqual(['8453 eth_blockNumber'])

    // When the minute is over, the refused request is asked again and the other goes, and both are answered.
    await vi.advanceTimersByTimeAsync(126)
    await expect(Promise.all([refused, other])).resolves.toEqual([100n, 100n])
    expect(sent.slice(1).map(({ what }) => what).sort()).toEqual(['10 eth_blockNumber', '8453 eth_blockNumber'])
    expect(sent.slice(1).every(({ at }) => at >= 60_000)).toBe(true)
  })

  it('paces fixture reads too, including their retries after a 429', async () => {
    vi.stubEnv('NEXT_PUBLIC_DETERMINISTIC_BROWSER', 'true')
    vi.stubEnv('NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN', 'http://127.0.0.1:4010')
    const start = Date.now()
    const sent: { at: number; what: string }[] = []
    const pending: ((answer: (id: number) => Response) => void)[] = []
    let open = 0
    let most = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
        sent.push({ at: Date.now() - start, what: `${input.slice(input.lastIndexOf('/') + 1)} ${method}` })
        open += 1
        most = Math.max(most, open)
        try {
          return await new Promise<Response>(resolve => pending.push(answer => resolve(answer(id))))
        } finally {
          open -= 1
        }
      }),
    )
    const { jbCenterPublicClient } = await import('@/lib/jbcenter-rpc')
    // Four chains' heads start 125 ms apart even while their responses remain pending.
    const heads = [84_532, 11_155_420, 11_155_111, 421_614].map(chainId =>
      jbCenterPublicClient(chainId).getBlockNumber({ cacheTime: 0 }),
    )
    await vi.advanceTimersByTimeAsync(125)
    expect(sent.map(({ what }) => what)).toEqual(['base-sepolia eth_blockNumber', 'optimism-sepolia eth_blockNumber'])

    // The fixture refuses the first for 2 s and answers the second; no new start precedes Retry-After.
    pending.shift()!(() => refusal('2'))
    await vi.advanceTimersByTimeAsync(0)
    pending.shift()!(id => answered(id, numberToHex(100n)))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(sent).toHaveLength(2)

    // The remaining reads and viem's retry start in turn, independently of their response completion.
    await vi.advanceTimersByTimeAsync(1)
    for (let turn = 0; turn < 20 && (sent.length < 5 || pending.length); turn += 1) {
      pending.shift()?.(id => answered(id, numberToHex(100n)))
      await vi.advanceTimersByTimeAsync(125)
    }
    await expect(Promise.all(heads)).resolves.toEqual([100n, 100n, 100n, 100n])
    expect(most).toBeGreaterThanOrEqual(2)
    expect(sent.slice(2).every(({ at }) => at >= 2_125)).toBe(true)
    expect(sent.slice(1).every(({ at }, index) => at - sent[index].at >= 125)).toBe(true)
    expect(sent.slice(2).map(({ what }) => what).sort()).toEqual([
      'arbitrum-sepolia eth_blockNumber',
      'base-sepolia eth_blockNumber',
      'sepolia eth_blockNumber',
    ])
  })

  it('paces starts under load across four chains, a 429 and a page left', async () => {
    // Center answers each request after 100 to 500 ms, the same for every run, and refuses the 30th for 2 s.
    let seed = 7
    const latency = () => 100 + ((seed = (seed * 48_271) % 2_147_483_647) % 401)
    const origin = Date.now()
    const sent: { at: number; chainId: number; method: string; from?: bigint }[] = []
    let open = 0
    let most = 0
    let refusedAt = -1
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const { id, method, params } = JSON.parse(String(init.body)) as { id: number; method: string; params: [{ fromBlock: string }] }
        const chainId = Number(input.slice(input.lastIndexOf('/') + 1))
        sent.push({ at: Date.now() - origin, chainId, method, from: method === 'eth_getLogs' ? BigInt(params[0].fromBlock) : undefined })
        const refuse = sent.length === 30
        open += 1
        most = Math.max(most, open)
        try {
          await new Promise(resolve => setTimeout(resolve, latency()))
          if (refuse) {
            refusedAt = Date.now() - origin
            return refusal('2')
          }
          return answered(id, method === 'eth_getLogs' ? [] : numberToHex(100n))
        } finally {
          open -= 1
        }
      }),
    )
    const [{ scanLogs }, { jbCenterPublicClient }] = await Promise.all([import('@/lib/hook-logs'), import('@/lib/jbcenter-rpc')])
    const address = `0x${'a'.repeat(40)}` as const
    // Each chain's scan is 12 windows of 500 blocks; Base's is a page that is left after 3 s.
    const left = new AbortController()
    const reason = new Error('left the page')
    const scans = [1, 10, 8453, 42161].map(chainId =>
      scanLogs(
        jbCenterPublicClient(chainId),
        { address, topics: [], fromBlock: 1_000n, toBlock: 6_999n },
        chainId === 8453 ? { signal: left.signal } : {},
      ),
    )
    const heads = [1, 10, 8453, 42161].map(chainId => jbCenterPublicClient(chainId).getBlockNumber({ cacheTime: 0 }))
    const baseScan = scans[2].catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(3_000)
    left.abort(reason)
    const abortedAt = Date.now() - origin
    await vi.advanceTimersByTimeAsync(60_000)

    await expect(Promise.all([scans[0], scans[1], scans[3], ...heads])).resolves.toEqual([[], [], [], 100n, 100n, 100n, 100n])
    expect(await baseScan).toBe(reason)
    expect(most).toBeGreaterThan(2)
    expect(sent.slice(1).every(({ at }, index) => at - sent[index].at >= 125)).toBe(true)
    // Nothing starts while the refusal's Retry-After runs, and no request of the page that was left starts once it is.
    expect(refusedAt).toBeGreaterThan(0)
    expect(sent.filter(({ at }) => at > refusedAt && at < refusedAt + 2_000)).toEqual([])
    expect(sent.filter(({ chainId, method, at }) => chainId === 8453 && method === 'eth_getLogs' && at > abortedAt)).toEqual([])
    // Every window of the other chains was asked for.
    for (const chainId of [1, 10, 42161]) {
      const windows = sent.filter(request => request.chainId === chainId && request.method === 'eth_getLogs').map(({ from }) => from)
      expect(new Set(windows).size).toBe(12)
    }
  })
})
