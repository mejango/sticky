import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_ROUTE_STALE_MS, projectRouteIsFresh, readProjectRouteSnapshot } from '@/lib/project-route'

const NOW = 1_800_000_000_000
const proof = () => ({ chainId: 8453, projectId: 23, handle: 'design', checkedAt: NOW, serverNow: NOW })
beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW) })

describe('project route proof age', () => {
  it('conservatively includes both server age and transit despite clock skew', () => {
    const received = readProjectRouteSnapshot({ ...proof(), checkedAt: NOW + 59_000, serverNow: NOW + 60_000 }, NOW - 500)
    expect(received.checkedAt).toBe(NOW - 1_500)
    expect(projectRouteIsFresh(received, NOW + 3_499)).toBe(true)
    expect(projectRouteIsFresh(received, NOW + 3_500)).toBe(false)
  })

  it('rejects a lease that expires in transit instead of restarting its age on receipt', () => {
    expect(() => readProjectRouteSnapshot(proof(), NOW - PROJECT_ROUTE_STALE_MS)).toThrow('expired')
  })

  it.each([
    { chainId: 0 }, { projectId: 0 }, { projectId: 1.5 }, { projectId: '23' },
    { handle: null }, { handle: '' }, { checkedAt: NaN }, { serverNow: NOW - 1 },
  ])('rejects malformed proof fields %j', changed => {
    expect(() => readProjectRouteSnapshot({ ...proof(), ...changed }, NOW)).toThrow()
  })

  it.each([null, false, 'proof'])('rejects a non-object response %j', value => {
    expect(() => readProjectRouteSnapshot(value, NOW)).toThrow()
  })
})
