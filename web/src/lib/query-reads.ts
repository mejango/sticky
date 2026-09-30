/**
 * What the project page's read hooks share: how long a read that others build on stays fresh, how a read of the
 * viewer's is made again, and how a read that fails tells the console.
 */

/** How long a read stays fresh: the reads that others build on are shared for this long. */
export const FRESH_MS = 30_000

/** How often what belongs to the viewer is read again while the page is in view. */
export const REFRESH_MS = 15_000

/**
 * How a read of the viewer's is made again: every 15 seconds while the page is in view, and at once when the tab is
 * shown again, however new it is. It is never fresh, so a panel that is shown again reads again as well. A read of an
 * account is never kept by the browser, so none of this is about what is kept.
 */
export const VIEWER_REFRESH = {
  staleTime: 0,
  refetchInterval: REFRESH_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: 'always',
} as const

/** What `read` gives, or its failure, which the console hears about under `label` unless the read was cancelled. */
export async function warned<T>(label: string, about: object, signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (!signal.aborted) console.warn(label, about, error)
    throw error
  }
}
