// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), deployment: vi.fn() }))
vi.mock('@/lib/sticky-handles', () => ({ resolveProjectHandle: mocks.resolve }))
vi.mock('@/lib/sticky-addresses', () => ({ stickyDeployment: mocks.deployment }))

const target = { chainId: 8453, projectId: 23, handle: 'sticky.juicebox' }

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  mocks.resolve.mockReset().mockResolvedValue(target)
  mocks.deployment.mockReset().mockReturnValue({ chainId: 8453 })
})

describe('verified Sticky route lease', () => {
  it('shares normalized aliases and expires success after five seconds without renewing its proof time', async () => {
    const { resolveProjectRoute, projectRouteSnapshot } = await import('@/lib/project-route.server')
    const [first, second] = await Promise.all([
      resolveProjectRoute('@STICKY.juicebox.eth'),
      resolveProjectRoute('%40sticky.juicebox'),
    ])
    expect(first).toEqual({ ...target, checkedAt: 1_000_000 })
    expect(second).toEqual(first)
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith('@sticky.juicebox')
    vi.advanceTimersByTime(4_999)
    expect(await resolveProjectRoute('@sticky.juicebox')).toEqual(first)
    expect(projectRouteSnapshot(first!)).toEqual({ ...first, serverNow: 1_004_999 })
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(await resolveProjectRoute('@sticky.juicebox')).toEqual({ ...target, checkedAt: 1_005_000 })
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it('checks a forced proof even while a successful lease remains fresh', async () => {
    const { resolveProjectRoute } = await import('@/lib/project-route.server')
    await resolveProjectRoute('@sticky.juicebox')
    mocks.resolve.mockResolvedValue({ ...target, projectId: 24 })
    expect((await resolveProjectRoute('@sticky.juicebox', true))?.projectId).toBe(24)
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it('waits for an earlier proof then shares a new proof between forced waiters', async () => {
    const pending = Promise.withResolvers<typeof target>()
    mocks.resolve.mockReturnValueOnce(pending.promise)
    const { resolveProjectRoute } = await import('@/lib/project-route.server')
    const first = resolveProjectRoute('@sticky.juicebox')
    mocks.resolve.mockResolvedValue({ ...target, projectId: 24 })
    const forced = resolveProjectRoute('@sticky.juicebox', true)
    const concurrent = resolveProjectRoute('@sticky.juicebox', true)
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    pending.resolve(target)
    expect((await first)?.projectId).toBe(23)
    expect((await forced)?.projectId).toBe(24)
    expect((await concurrent)?.projectId).toBe(24)
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it('starts the forced proof even when the earlier pending proof fails', async () => {
    const pending = Promise.withResolvers<typeof target>()
    mocks.resolve.mockReturnValueOnce(pending.promise)
    const { resolveProjectRoute } = await import('@/lib/project-route.server')
    const first = resolveProjectRoute('@sticky.juicebox').catch(error => error)
    const forced = resolveProjectRoute('@sticky.juicebox', true)
    pending.reject(new Error('RPC unavailable'))
    expect(await first).toMatchObject({ message: 'RPC unavailable' })
    expect((await forced)?.projectId).toBe(23)
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it('retries missing and unavailable proofs immediately without disguising a read failure as a miss', async () => {
    const { resolveProjectRoute } = await import('@/lib/project-route.server')
    mocks.resolve.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('RPC unavailable'))
    expect(await resolveProjectRoute('@sticky.juicebox')).toBeNull()
    await expect(resolveProjectRoute('@sticky.juicebox')).rejects.toThrow('RPC unavailable')
    expect(await resolveProjectRoute('@sticky.juicebox')).toEqual({ ...target, checkedAt: 1_000_000 })
    expect(mocks.resolve).toHaveBeenCalledTimes(3)
  })

  it.each(['missing', 'unavailable'])('invalidates an earlier success immediately when a forced proof is %s', async failure => {
    const { resolveProjectRoute } = await import('@/lib/project-route.server')
    await resolveProjectRoute('@sticky.juicebox')
    if (failure === 'missing') {
      mocks.resolve.mockResolvedValueOnce(null)
      expect(await resolveProjectRoute('@sticky.juicebox', true)).toBeNull()
    } else {
      mocks.resolve.mockRejectedValueOnce(new Error('RPC unavailable'))
      await expect(resolveProjectRoute('@sticky.juicebox', true)).rejects.toThrow('RPC unavailable')
    }
    expect((await resolveProjectRoute('@sticky.juicebox'))?.projectId).toBe(23)
    expect(mocks.resolve).toHaveBeenCalledTimes(3)
  })

  it('keeps alias proofs separate and numeric routes subject to supported deployments', async () => {
    const { resolveProjectRoute } = await import('@/lib/project-route.server')
    expect(await resolveProjectRoute('base%3A23')).toEqual({ chainId: 8453, projectId: 23, handle: null, checkedAt: 1_000_000 })
    expect(mocks.resolve).not.toHaveBeenCalled()
    mocks.deployment.mockReturnValueOnce(null)
    expect(await resolveProjectRoute('base:23')).toBeNull()
    await resolveProjectRoute('@sticky.juicebox')
    mocks.resolve.mockResolvedValue({ ...target, projectId: 24, handle: 'other.juicebox' })
    expect((await resolveProjectRoute('@other.juicebox'))?.projectId).toBe(24)
    expect((await resolveProjectRoute('@sticky.juicebox'))?.projectId).toBe(23)
  })

  it.each(['', '%', 'base%253A23', '%2540sticky.juicebox', 'sticky.juicebox', '@', '@invalid/name', 'unknown:23'])(
    'rejects invalid route %s before resolving a handle', async segment => {
      const { resolveProjectRoute } = await import('@/lib/project-route.server')
      expect(await resolveProjectRoute(segment)).toBeNull()
      expect(mocks.resolve).not.toHaveBeenCalled()
    },
  )
})
