import { QueryClient } from '@tanstack/query-core'
import { normalizeProjectHandle } from '@/lib/project-handles'
import { decodeProjectRouteSegment, PROJECT_ROUTE_STALE_MS, type ProjectRouteSnapshot } from '@/lib/project-route'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { resolveProjectHandle } from '@/lib/sticky-handles'
import { parseUrn } from '@/lib/urn'

export type ResolvedProjectRoute = Omit<ProjectRouteSnapshot, 'serverNow'>

const aliasQueries = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
})
class UnverifiedProjectAlias extends Error {}

/** A verified alias has a short lease; failed checks never reuse its old proof or cache a miss. */
export async function resolveProjectRoute(segment: string, force = false): Promise<ResolvedProjectRoute | null> {
  const decoded = decodeProjectRouteSegment(segment)
  if (decoded === null || /%[0-9a-f]{2}/i.test(decoded)) return null
  const urn = parseUrn(decoded)
  if (urn) return stickyDeployment(urn.chainId) ? { ...urn, handle: null, checkedAt: Date.now() } : null
  const requested = decoded.startsWith('@') ? normalizeProjectHandle(decoded) : null
  if (!requested) return null

  const queryKey = ['verifiedProjectAlias', requested.handle] as const
  if (force) {
    // A mutation-triggered check must start after any proof already in flight.
    const pending = aliasQueries.getQueryCache().find({ queryKey, exact: true })
    if (pending?.state.fetchStatus === 'fetching') await pending.promise?.catch(() => undefined)
  }
  try {
    return await aliasQueries.fetchQuery({
      queryKey,
      staleTime: force ? 0 : PROJECT_ROUTE_STALE_MS,
      queryFn: async () => {
        const route = await resolveProjectHandle(`@${requested.handle}`)
        if (!route) throw new UnverifiedProjectAlias('Unverified project alias')
        return { ...route, checkedAt: Date.now() }
      },
    })
  } catch (error) {
    void aliasQueries.invalidateQueries({ queryKey, exact: true, refetchType: 'none' })
    if (error instanceof UnverifiedProjectAlias) return null
    throw error
  }
}

export function projectRouteSnapshot(route: ResolvedProjectRoute): ProjectRouteSnapshot {
  return { ...route, serverNow: Date.now() }
}
