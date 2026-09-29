// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

describe('GET /api/healthz', () => {
  it('reports ready with the build revision', async () => {
    vi.stubEnv('NEXT_PUBLIC_VERSION', 'abc1234')
    const { GET } = await import('@/app/api/healthz/route')
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, revision: 'abc1234' })
  })

  it('is never cached, so a probe reaches the running server', async () => {
    const { GET } = await import('@/app/api/healthz/route')
    const response = await GET()
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  // A Dockerfile `ENV X=$ARG_X` turns an unset build argument into "", which `??` keeps.
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '  '],
  ])('names the revision unknown when the version is %s', async (_case, version) => {
    vi.stubEnv('NEXT_PUBLIC_VERSION', version)
    const { GET } = await import('@/app/api/healthz/route')
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, revision: 'unknown' })
  })
})
