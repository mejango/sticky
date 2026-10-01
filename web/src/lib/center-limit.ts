/**
 * JB Center's rate limit, as this site reads it. Center counts each client's requests, every chain's together, in a
 * window of a fixed minute in which refused requests count too, and refuses the rest of the minute with a 429 whose
 * Retry-After says how long is left.
 */

/** What a link of an error chain can say about a refusal. */
export type Failure = { status?: unknown; code?: unknown; message?: unknown; details?: unknown; retryAfter?: unknown }

/** An error and what it wraps, outermost first. viem wraps whatever its transport throws, so the HTTP status or the
 * JSON-RPC code Center answered with usually sits on a cause. */
export function failures(error: unknown): Failure[] {
  const chain: Failure[] = []
  for (
    let next = error;
    typeof next === 'object' && next !== null && chain.length < 8;
    next = (next as { cause?: unknown }).cause
  ) {
    chain.push(next as Failure)
  }
  return chain
}

/** Whether `error` is a 429, as an HTTP status or a JSON-RPC code, on it or on anything it wraps. */
export const isRateLimited = (error: unknown) => failures(error).some(({ status, code }) => status === 429 || code === 429)

/** How long Center asked to wait, in seconds, or undefined when nothing says: the SDK reads Center's Retry-After header
 * into `retryAfter`, on the error it throws. */
export function retryAfterOf(error: unknown): number | undefined {
  return failures(error)
    .map(link => link.retryAfter)
    .find((seconds): seconds is number => typeof seconds === 'number' && Number.isFinite(seconds))
}
