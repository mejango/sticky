import { afterEach, describe, expect, it, vi } from 'vitest'
import { base } from 'viem/chains'
import { createPublicClient, erc20Abi } from 'viem'
import { jbCenterRpcTransport, retryWhileBehindHead } from '@/lib/jbcenter-rpc'

/** JB Center load balances reads across RPC nodes. A read pinned to a block one
 * node has already imported can land on a sibling that has not, and the sibling
 * answers JSON-RPC -32001 — which viem renders as "Requested resource not
 * found." and, before this retry, killed a payment between its approval and its
 * swap. */
const blockAhead = () =>
  Object.assign(new Error('RPC request failed'), { code: -32001 })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('RPC block lag', () => {
  it('retries a read pinned to a block the answering node has not imported yet', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(blockAhead())
      .mockRejectedValueOnce(blockAhead())
      .mockResolvedValue('0x2a')

    await expect(
      retryWhileBehindHead({ request }, [0, 0, 0]).request({
        method: 'eth_call',
      }),
    ).resolves.toBe('0x2a')
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('rethrows once the lag retries are spent', async () => {
    const request = vi.fn().mockRejectedValue(blockAhead())

    await expect(
      retryWhileBehindHead({ request }, [0, 0]).request({ method: 'eth_call' }),
    ).rejects.toMatchObject({ code: -32001 })
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('never retries a revert or any other RPC error', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('reverted'), { code: 3 }))

    await expect(
      retryWhileBehindHead({ request }, [0, 0]).request({ method: 'eth_call' }),
    ).rejects.toMatchObject({ code: 3 })
    expect(request).toHaveBeenCalledOnce()
  })

  it('carries a pinned read through a lagging backend on the wired transport', async () => {
    const envelope = (id: unknown, body: Record<string, unknown>) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }), {
        headers: { 'content-type': 'application/json' },
      })
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
})
