import { JBCENTER_RPC_METHODS } from '@bananapus/nana-sdk-core/jbcenter'
import { describe, expect, it, vi } from 'vitest'
import { feeBuybackContext } from '../src/lib/fee-buyback-client'

describe('fee simulation transport', () => {
  it('uses the shared SDK transport for eth_simulateV1', async () => {
    expect(JBCENTER_RPC_METHODS).toContain('eth_simulateV1')
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [] }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const { client, options } = feeBuybackContext(
        8453,
        '0x3333333333333333333333333333333333333333',
      )
      await client.request({
        method: 'eth_simulateV1',
        params: [{ blockStateCalls: [{ calls: [] }] }, 'latest'],
      } as never)
      expect(fetchMock).toHaveBeenCalled()
      const [url, init] = fetchMock.mock.lastCall!
      expect(String(url)).toContain('/v1/rpc/8453')
      expect(JSON.parse(String(init?.body)).method).toBe('eth_simulateV1')
      expect(options.trustedHooks.length).toBeGreaterThan(0)
      expect(options.feePayers.length).toBeGreaterThan(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
