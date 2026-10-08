// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedProjectRoute } from '@/lib/project-route.server'

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('@/lib/project-route.server', () => ({
  resolveProjectRoute: mocks.resolve,
  projectRouteSnapshot: (route: ResolvedProjectRoute) => ({ ...route, serverNow: Date.now() }),
}))
import { GET } from '@/app/api/project-route/route'

const route = { chainId: 8453, projectId: 23, handle: 'sticky.juicebox', checkedAt: 1_000_000 }
const request = (segment: string, fresh?: string) =>
  new Request(`https://sticky.test/api/project-route?${new URLSearchParams({ segment, ...(fresh ? { fresh } : {}) })}`)

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_001_000)
  mocks.resolve.mockReset().mockResolvedValue(route)
})

describe('GET /api/project-route', () => {
  it('normalizes explicit aliases, returns proof and server timestamps, and prohibits HTTP caching', async () => {
    const response = await GET(request('%40STICKY.juicebox.eth', '1'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ...route, serverNow: 1_001_000 })
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('@sticky.juicebox', true)
  })

  it.each([undefined, '0', 'true'])('uses the bounded lease unless fresh is exactly 1 (%s)', async fresh => {
    expect((await GET(request('@sticky.juicebox', fresh))).status).toBe(200)
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('@sticky.juicebox', false)
  })

  it.each(['', 'base:23', 'sticky.juicebox', '%2540sticky.juicebox', '%', '@', '@bad/name', ' @sticky.juicebox'])(
    'rejects invalid or non-alias segment %s without invoking verification', async segment => {
      const response = await GET(request(segment))
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({ error: 'Invalid project alias' })
      expect(mocks.resolve).not.toHaveBeenCalled()
    },
  )

  it('rejects a missing segment', async () => {
    const response = await GET(new Request('https://sticky.test/api/project-route'))
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.resolve).not.toHaveBeenCalled()
  })

  it.each(['missing', 'unavailable'])('reports %s verification as unavailable without leaking or caching a proof', async failure => {
    if (failure === 'missing') mocks.resolve.mockResolvedValue(null)
    else mocks.resolve.mockRejectedValue(new Error('private RPC credentials'))
    const response = await GET(request('@sticky.juicebox'))
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: 'Project link could not be verified.' })
  })
})
