import { base, optimism } from '@bananapus/nana-sdk-core/chains'
import { createPublicClient, erc20Abi, numberToHex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The browser's Center reader, with only `fetch` faked: every chain's requests and every reader's of the tab share
// Center's two slots, a page's requests go with its signal, and a 429's Retry-After holds every one of them, viem's own
// retry included. The slots are the SDK's limiter, whose own tests cover how a limiter lines up, pauses and lets go of
// what waits.

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
  })

  it('sends every chain\'s requests through the slots: two in flight at once, the next as one answers', async () => {
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
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    await ticks(20)
    expect(sent).toEqual(['8453 eth_blockNumber', '10 eth_blockNumber'])

    answers.shift()!()
    await vi.waitFor(() => expect(sent).toHaveLength(3))
    expect(sent[2]).toBe('1 eth_blockNumber')
    while (sent.length < 4 || answers.length) {
      answers.shift()?.()
      await ticks()
    }
    await expect(Promise.all(reads)).resolves.toEqual([100n, 100n, 100n])
    await expect(scan).resolves.toBe('0x64')
    expect(sent[3]).toBe('8453 eth_chainId')
  })

  it('shares the slots with every other reader of the tab, as wagmi\'s and the Center wallet\'s are built', async () => {
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
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    await ticks(20)
    expect(sent).toEqual(['10 eth_blockNumber', '8453 eth_blockNumber'])
    while (sent.length < 3 || answers.length) {
      answers.shift()?.()
      await ticks()
    }
    await expect(Promise.all(reads)).resolves.toEqual([100n, 100n, '0x64'])
  })

  it('frees the slots of a page\'s requests the moment the page is left, so the next request goes at once', async () => {
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
    await vi.waitFor(() => expect(sent).toHaveLength(2))
    await ticks(20)
    expect(sent).toEqual(['8453 eth_getLogs', '10 eth_getLogs'])

    page.abort(new Error('left the page'))
    await expect(head).resolves.toBe(100n)
    expect(sent).toEqual(['8453 eth_getLogs', '10 eth_getLogs', '1 eth_blockNumber'])
    expect(stopped).toEqual(['8453 eth_getLogs', '10 eth_getLogs'])
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
    // Another page's reads hold both slots.
    const others = [10, 1].map(chainId => jbCenterPublicClient(chainId).getBlockNumber({ cacheTime: 0 }))
    await vi.waitFor(() => expect(sent).toHaveLength(2))

    // The page's head, its pinned block and a Multicall3 read wait for a slot.
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

    await expect(Promise.all([reader.getBlockNumber(), reader.getBlockNumber()])).resolves.toEqual([101n, 101n])
    await expect(reader.getBlockNumber()).resolves.toBe(102n)
    expect(sent).toEqual(['eth_blockNumber', 'eth_blockNumber'])
  })

  it('lets go of a slot while a read waits out a node behind the head, and takes one again to ask once more', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
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

    // While it waits to ask again, both slots are the other readers'.
    const heads = [10, 1].map(chainId => jbCenterPublicClient(chainId).getBlockNumber({ cacheTime: 0 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['8453 eth_call', '10 eth_blockNumber', '1 eth_blockNumber'])

    // Its next try waits for a slot like any other request.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent).toHaveLength(3)
    answers.shift()!()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent[3]).toBe('8453 eth_call')
    while (answers.length) answers.shift()!()
    await expect(Promise.all([pinned, ...heads])).resolves.toEqual(['0x64', 100n, 100n])
  })

  it('lets two page reads Center does not answer hold the tab\'s reads for 15 s at most, the try every reader waits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const sent: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
        sent.push(`${input.slice(input.lastIndexOf('/') + 1)} ${method}`)
        if (method !== 'eth_getLogs') return answered(id, numberToHex(100n))
        // Center never answers the page's scans.
        return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
      }),
    )
    const { jbCenterPublicClient, jbCenterRpcTransport } = await import('@/lib/jbcenter-rpc')
    const page = new AbortController()
    const logs = { method: 'eth_getLogs', params: [{ fromBlock: '0x1', toBlock: '0x1f4' }] } as never
    const scans = [8453, 10].map(chainId => jbCenterPublicClient(chainId, page.signal).request(logs).catch((error: unknown) => error))
    // A write's review reads through the Center wallet's transport.
    const review = jbCenterRpcTransport(8453)({ chain: base }).request({ method: 'eth_blockNumber' })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(sent).toEqual(['8453 eth_getLogs', '10 eth_getLogs'])

    await vi.advanceTimersByTimeAsync(1)
    expect(sent[2]).toBe('8453 eth_blockNumber')
    await expect(review).resolves.toBe('0x64')
    page.abort(new Error('left the page'))
    await Promise.all(scans)
  })

  it('sends nothing at all while a Retry-After runs, its own retry of the refused request included', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
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
    await vi.advanceTimersByTimeAsync(1)
    await expect(Promise.all([refused, other])).resolves.toEqual([100n, 100n])
    expect(sent.slice(1).map(({ what }) => what).sort()).toEqual(['10 eth_blockNumber', '8453 eth_blockNumber'])
    expect(sent.slice(1).every(({ at }) => at >= 60_000)).toBe(true)
  })

  it('keeps two in flight at most under load: four chains\' scans and heads at once, a 429 and a page left', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
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
        open += 1
        most = Math.max(most, open)
        try {
          await new Promise(resolve => setTimeout(resolve, latency()))
          if (sent.length === 30) {
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
    expect(most).toBe(2)
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
