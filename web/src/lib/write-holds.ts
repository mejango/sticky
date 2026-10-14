import { createSavedAttemptRecovery, createWriteHold, writeExitMessage, type HeldWriteView } from '@bananapus/nana-sdk-core/review'

/** One controller for every held write of the app: storage, locks, the states and the exits live in the SDK. */
export const holds = createWriteHold()
/** One recovery for every saved attempt (launches, bridge and collector writes), over the same holds. */
export const attempts = createSavedAttemptRecovery({ hold: holds })

/** What a held write's exit risks: the hold's own warning, else the SDK's line for its call (a hashless hold has none). */
export function exitWarning(view: Pick<HeldWriteView, 'state' | 'warning' | 'exit'>): string | undefined {
  if (view.warning) return view.warning
  return view.exit && view.state && view.state.status !== 'clear' ? writeExitMessage(view.state.record.call) : undefined
}
