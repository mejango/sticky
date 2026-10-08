import type { JBChainId } from '@bananapus/nana-sdk-core'

/**
 * How a client reads a project route from the address bar. These two functions live apart from `project-handles.ts`
 * so that the header and the route provider, which every page loads, can read a route without loading the ENSIP-15
 * name normalization that the rest of that file brings (about 26 KB gzipped). Handles are resolved on the server; see
 * `sticky-handles.ts`.
 */

/** Next may expose a dynamic path segment in either encoded or decoded form. */
export function decodeProjectRouteSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * Read a top-level project route from a client pathname and decode it exactly
 * once. A residual percent escape is a double-encoded route (for example,
 * `/%2540design` -> `%40design`) and must not be decoded again downstream.
 */
export function projectRouteSegmentFromPathname(
  pathname: string,
): string | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length !== 1) return null

  const decoded = decodeProjectRouteSegment(segments[0])
  if (decoded === null || /%[0-9a-f]{2}/i.test(decoded)) return null
  return decoded
}

/** Browsing evidence has a short lease; it never authorizes a transaction. */
export const PROJECT_ROUTE_STALE_MS = 5_000

export type ProjectRouteSnapshot = {
  chainId: JBChainId
  projectId: number
  handle: string | null
  checkedAt: number
  serverNow: number
}

/** Sticky projects have immutable deployer ownership. */
export function projectRouteIdentity(route: Pick<ProjectRouteSnapshot, 'chainId' | 'projectId'>): string {
  return `${route.chainId}:${route.projectId}`
}

/** Exact decoded alias path; ENS normalization remains on the server. */
export function projectRouteQueryKey(alias: string) {
  return ['projectRoute', alias] as const
}

export function projectRouteIsFresh(route: ProjectRouteSnapshot, now = Date.now()): boolean {
  return route.checkedAt <= now && now - route.checkedAt < PROJECT_ROUTE_STALE_MS
}

/** Endpoint proof age includes server age and request transit; local clocks cannot renew it. */
export function readProjectRouteSnapshot(value: unknown, requestStartedAt: number): ProjectRouteSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Project link could not be verified.')
  const row = value as ProjectRouteSnapshot
  if (
    typeof row.handle !== 'string' || !row.handle ||
    !Number.isSafeInteger(row.chainId) || row.chainId <= 0 ||
    !Number.isSafeInteger(row.projectId) || row.projectId <= 0 ||
    !Number.isFinite(row.checkedAt) || !Number.isFinite(row.serverNow) || row.serverNow < row.checkedAt
  ) throw new Error('Project link verification expired. Try again.')
  const local = { ...row, checkedAt: requestStartedAt - (row.serverNow - row.checkedAt), serverNow: requestStartedAt }
  if (!projectRouteIsFresh(local)) throw new Error('Project link verification expired. Try again.')
  return local
}
