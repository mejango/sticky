import { createSavedAttemptRecovery, createWriteHold, followHeldWrite, writeExitMessage, type HeldWriteView, type WriteHoldClient, type WriteHoldHandle } from '@bananapus/nana-sdk-core/review'

/** One controller for every held write of the app: storage, locks, the states and the exits live in the SDK. */
export const holds = createWriteHold()
/** One recovery for every saved attempt (launches, bridge and collector writes), over the same holds. */
export const attempts = createSavedAttemptRecovery({ hold: holds })

/** What a held write's exit risks: the hold's own warning, else the SDK's line for its call (a hashless hold has none). */
export function exitWarning(view: Pick<HeldWriteView, 'state' | 'warning' | 'exit'>): string | undefined {
  if (view.warning) return view.warning
  return view.exit && view.state && view.state.status !== 'clear' ? writeExitMessage(view.state.record.call) : undefined
}

/**
 * Keep following a held write whose flow closed, with the SDK's own follower, until the hold is clear; then `onSettled`
 * hears an authenticated success. Returns the stop. (A Safe proposal still refreshes its reads once it runs.)
 */
export function followDetached(handle: WriteHoldHandle, client: WriteHoldClient, onSettled: () => void): () => void {
  const stop = new AbortController()
  void followHeldWrite(handle, client, { signal: stop.signal }).then(end => {
    if (end?.status === 'clear' && end.settled && 'hash' in end.settled && end.settled.result === 'success') onSettled()
  }, () => undefined)
  return () => stop.abort()
}
