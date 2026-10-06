import { afterEach, describe, expect, it, vi } from 'vitest'
import { base } from 'viem/chains'
import { createPublicClient, erc20Abi } from 'viem'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'

/** JB Center load balances reads across RPC nodes. A read pinned to a block one
 * node has already imported can land on a sibling that has not, and the sibling
 * answers JSON-RPC -32001, which viem renders as "Requested resource not
 * found." The SDK's provider asks again, and its tests cover how; these cases
 * check that the transport this site reads through waits it out. */

const envelope = (id: unknown, body: Record<string, unknown>) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }), {
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RPC block lag', () => {
  it('carries a pinned read through a lagging backend on the wired transport', async () => {
    let calls = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const { id } = JSON.parse(String(init.body)) as { id: number }
      calls += 1
      return calls === 1
        ? envelope(id, { error: { code: -32001, message: 'RPC request failed' } })
        : envelope(id, {
            result: `0x${(1_000_000n).toString(16).padStart(64, '0')}`,
          })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const client = createPublicClient({
      chain: base,
      transport: jbCenterRpcTransport(base.id),
    })

    const balance = client.readContract({
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: ['0x000000000000000000000000000000000000dEaD'],
      blockNumber: 50_623_163n,
    })
    await vi.advanceTimersByTimeAsync(10_000)

    await expect(balance).resolves.toBe(1_000_000n)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('waits 250, 500, 1,000, 2,000 and 2,000 ms for a lagging node, then gives up', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const asked: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const { id } = JSON.parse(String(init.body)) as { id: number }
        asked.push(Date.now() - start)
        return envelope(id, { error: { code: -32001, message: 'RPC request failed' } })
      }),
    )
    const client = createPublicClient({
      chain: base,
      transport: jbCenterRpcTransport(base.id),
    })

    const balance = client
      .request({ method: 'eth_getBalance', params: [`0x${'d'.repeat(40)}`, '0x3047fcb'] })
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(asked).toEqual([0, 250, 750, 1_750, 3_750, 5_750])
    expect(await balance).toMatchObject({ code: -32001 })
  })
})
