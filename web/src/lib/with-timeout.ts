/**
 * Runs `work` with a signal that aborts after `ms`, with a `TimeoutError`, or with the caller's reason when the
 * caller's own signal aborts, whichever comes first. Nothing is left running when the work ends: the timer is
 * cleared and the caller's signal is let go of. The work's own signal is left alone then, so a response the work
 * hands back can still be read.
 */
export async function withTimeout<T>(
  ms: number,
  caller: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (caller?.aborted) throw caller.reason
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException(`No answer within ${ms} ms.`, 'TimeoutError')), ms)
  const relay = () => controller.abort(caller?.reason)
  caller?.addEventListener('abort', relay, { once: true })
  try {
    return await work(controller.signal)
  } finally {
    clearTimeout(timer)
    caller?.removeEventListener('abort', relay)
  }
}
