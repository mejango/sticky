// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/bendystraw/[net]/query/route'
import { bendystraw } from '@/lib/bendystraw'
import { bendystrawOperationId } from '@/lib/bendystraw-operation-id'

// A fixed document stands in for the registry, so the relay is tested whatever the real registry holds.
const query = vi.hoisted(
  () => `query RelayCacheProject($chainId: Int!, $projectId: Int!) {
  project(chainId: $chainId, projectId: $projectId, version: 6) { projectId chainId }
}`,
)

vi.mock('@/lib/bendystraw-operation-registry.json', async () => {
  const { createHash } = await import('node:crypto')
  return {
    default: {
      [createHash('sha256').update(query, 'utf8').digest('hex')]: query,
    },
  }
})

const operation = await bendystrawOperationId(query)

const answer = () =>
  new Response(JSON.stringify({ data: { project: null } }), {
    headers: { 'content-type': 'application/json' },
  })

function relay(
  net: 'mainnet' | 'testnet',
  variables: Record<string, unknown>,
) {
  return POST(
    new Request(`https://sticky.center/api/bendystraw/${net}/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation, variables }),
    }),
    { params: Promise.resolve({ net }) },
  )
}

function indexerAnswers() {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => answer())
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('the relay keeps indexer answers out of Next’s fetch cache', () => {
  it.each([
    ['mainnet', 1],
    ['testnet', 84532],
  ] as const)(
    'asks for the %s answer with no-store and no revalidate window',
    async (net, chainId) => {
      const fetcher = indexerAnswers()

      const response = await relay(net, { chainId, projectId: 11 })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: { project: null } })
      expect(fetcher).toHaveBeenCalledOnce()
      const init = fetcher.mock.calls[0][1]
      expect(init).toMatchObject({ cache: 'no-store' })
      expect(init).not.toHaveProperty('next')
    },
  )

  it('stays uncached in the deterministic browser build', async () => {
    vi.stubEnv('NEXT_PUBLIC_DETERMINISTIC_BROWSER', 'true')
    vi.resetModules()
    const fetcher = indexerAnswers()
    const deterministic = await import('@/lib/bendystraw')
    const route = await import('@/app/api/bendystraw/[net]/query/route')

    await route.POST(
      new Request('https://sticky.center/api/bendystraw/mainnet/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation,
          variables: { chainId: 1, projectId: 11 },
        }),
      }),
      { params: Promise.resolve({ net: 'mainnet' }) },
    )
    await deterministic.bendystraw(query, { chainId: 1, projectId: 11 })

    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: 'no-store' })
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('next')
    expect(fetcher.mock.calls[1][1]).toMatchObject({ next: { revalidate: 1 } })
  })
})

describe('server-side reads keep their revalidate window', () => {
  it.each([
    ['live', 15],
    ['standard', 30],
    ['stable', 60],
    [undefined, 60],
  ] as const)(
    'a read with policy %s revalidates every %s seconds',
    async (policy, seconds) => {
      const fetcher = indexerAnswers()

      await bendystraw(query, { chainId: 1, projectId: 11 }, { policy })

      const init = fetcher.mock.calls[0][1]
      expect(init).toMatchObject({ next: { revalidate: seconds } })
      expect(init).not.toHaveProperty('cache')
    },
  )

  it('skips the cache only for a read that asks for no-store', async () => {
    const fetcher = indexerAnswers()

    await bendystraw(
      query,
      { chainId: 1, projectId: 11 },
      { policy: 'no-store' },
    )

    const init = fetcher.mock.calls[0][1]
    expect(init).toMatchObject({ cache: 'no-store' })
    expect(init).not.toHaveProperty('next')
  })
})
