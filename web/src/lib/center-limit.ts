import { createTransport, type Transport } from 'viem'
import { line } from '@/lib/line'

/**
 * JB Center's rate limit, as this site reads it and keeps to it. Center counts each client's requests, every chain's
 * together, in a window of a fixed minute in which refused requests count too: 600 a minute for this site's origins.
 * It refuses the rest of the minute with a 429 whose Retry-After says how long is left, and a page that trips it stalls
 * until then.
 *
 * So in the browser every request to Center, every chain's and every reader's together, waits for one of CENTER_SLOTS
 * slots, and a page's reads run side by side without asking Center for more at once than one log scan always could.
 * The rate is then bounded by Center's round trip: two in flight are at most 343 requests a minute at the quickest
 * round trip staging measured (0.35 s), against Center's 600.
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

/** How many requests the browser keeps in flight to Center, every chain's together: what one log scan of the hook
 * always kept (`hook-logs.ts`), so reads that run side by side ask no more of Center at once than one scan did. */
const CENTER_SLOTS = 2

/** The longest a refusal holds the slots: Center's window is a minute. */
const MAX_PAUSE_MS = 60_000

/** When the slots open again after a refusal, by the clock, and the timer that opens them. */
let resumeAt = 0
let paused: ReturnType<typeof setTimeout> | undefined

const slots = line(CENTER_SLOTS, () => paused !== undefined)

/** Holds the slots for `ms`, or until a later end a refusal already set. */
function pause(ms: number): void {
  const until = Date.now() + ms
  if (paused !== undefined && until <= resumeAt) return
  clearTimeout(paused)
  resumeAt = until
  paused = setTimeout(() => {
    paused = undefined
    slots.resume()
  }, ms)
}

/**
 * `send`, once one of Center's slots is free: requests start in the order they came, at most CENTER_SLOTS at once.
 * When Center refuses one with a Retry-After, no other starts until that has passed: every request in the minute would
 * be refused, and would count. A request whose `signal` aborts while it waits leaves the line, rejecting with the
 * reason, and is never sent; one under way is not stopped.
 */
export function inCenterSlot<T>(send: () => Promise<T>, { signal }: { signal?: AbortSignal } = {}): Promise<T> {
  const task = async () => {
    try {
      return await send()
    } catch (error) {
      const seconds = isRateLimited(error) ? retryAfterOf(error) : undefined
      if (seconds !== undefined && seconds > 0) pause(Math.min(seconds * 1_000, MAX_PAUSE_MS))
      throw error
    }
  }
  return slots.join(task, { signal })
}

/** `send`, with each request it makes in one of Center's slots (`inCenterSlot`). A request made with a signal, as a
 * page's reads are, leaves the line when it aborts, and goes on to `send` with it. */
export function inCenterSlots<A>(
  send: (args: A, options?: { signal?: AbortSignal }) => Promise<unknown>,
): (args: A, options?: { signal?: AbortSignal }) => Promise<unknown> {
  return (args, options) => inCenterSlot(() => send(args, options), { signal: options?.signal })
}

/** `transport`, with each request it sends in one of Center's slots (`inCenterSlots`): every try, so viem's own retry
 * of a refused request waits out the Retry-After with the rest. */
export function throughCenterSlots(transport: Transport): Transport {
  return parameters => {
    const { config, value } = transport(parameters)
    return createTransport({ ...config, request: inCenterSlots(config.request) as typeof config.request }, value)
  }
}
