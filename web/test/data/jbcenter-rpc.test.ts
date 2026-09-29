// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mainnet } from 'viem/chains'
import { createPublicClient } from 'viem'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'
import {
  jbCenterAppOrigin,
  jbCenterBaseUrl,
} from '@/lib/jbcenter-config'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Juicebox Center RPC transport', () => {
  it('does not treat other localhost ports as trusted dev clients', () => {
    expect(jbCenterBaseUrl('http://localhost:8788')).toBe(
      'https://juicebox.center',
    )
    expect(jbCenterAppOrigin('http://localhost:8788')).toBe(
      'http://localhost:8788',
    )
  })

  it('routes server reads through Center with the trusted app origin', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = createPublicClient({
      chain: mainnet,
      transport: jbCenterRpcTransport(mainnet.id),
    })

    await expect(client.getChainId()).resolves.toBe(mainnet.id)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://juicebox.center/v1/rpc/1')
    expect(new Headers(init.headers).get('origin')).toBe(
      'https://sticky.center',
    )
  })

  it('calls browser fetch with the Window receiver', async () => {
    const browserWindow = {
      fetch: vi.fn(function (this: unknown) {
        if (this !== browserWindow) throw new TypeError('Illegal invocation')
        return Promise.resolve(
          new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )
      }),
    }
    vi.stubGlobal('window', browserWindow)
    vi.stubGlobal(
      'fetch',
      vi.fn(function () {
        throw new TypeError('Illegal invocation')
      }),
    )
    const client = createPublicClient({
      chain: mainnet,
      transport: jbCenterRpcTransport(mainnet.id),
    })

    await expect(client.getChainId()).resolves.toBe(mainnet.id)
    expect(browserWindow.fetch).toHaveBeenCalledOnce()
  })

  it.each([
    'https://dev.sticky.center',
    'https://sticky-dev.up.railway.app',
    'http://127.0.0.1:8788',
  ])('uses the configured dev Center and app origin for %s', async (siteUrl) => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', siteUrl)
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const client = createPublicClient({
      chain: mainnet,
      transport: jbCenterRpcTransport(mainnet.id),
    })

    await expect(client.getChainId()).resolves.toBe(mainnet.id)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://dev.juicebox.center/v1/rpc/1')
    expect(new Headers(init.headers).get('origin')).toBe(siteUrl)
  })
})
