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
