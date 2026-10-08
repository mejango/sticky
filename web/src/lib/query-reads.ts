/**
 * What the project page's read hooks share: how long a read that others build on stays fresh, how a read of the
 * viewer's is made again, and how a read that fails tells the console.
 */

/** How long a read stays fresh: the reads that others build on are shared for this long. */
export const FRESH_MS = 30_000

/** How often what belongs to the viewer is read again while the page is in view. */
export const REFRESH_MS = 15_000

/**
 * Viewer evidence is reused for one refresh interval when a panel or tab is shown again. Polling and explicit
 * post-transaction invalidation still refresh it, and final send guards read live state independently. These
 * account-scoped queries stay in memory only; query persistence never stores them in the browser.
 */
export const VIEWER_REFRESH = {
  staleTime: REFRESH_MS,
  refetchInterval: REFRESH_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
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
