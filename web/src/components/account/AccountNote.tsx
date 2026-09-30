import { chainName } from '@/lib/urn'

/**
 * What a list could not read, counted, with a Retry that reads it again. It says nothing when the list was read whole.
 * The note sits in a live region that is always there, so a note that appears is announced.
 */
export function AccountNote({
  failedChains,
  skipped = 0,
  onRetry,
}: {
  failedChains: readonly number[]
  /** The projects that could not be read on chains that could. */
  skipped?: number
  onRetry: () => void
}) {
  const unread = [
    failedChains.length
      ? `${failedChains.length} ${failedChains.length === 1 ? 'chain' : 'chains'} (${failedChains.map(chainName).join(', ')})`
      : '',
    skipped ? `${skipped} ${skipped === 1 ? 'project' : 'projects'}` : '',
  ].filter(Boolean)
  return (
    <div role="status" aria-live="polite">
      {unread.length ? (
        <p className="py-3.5 text-sm text-muted">
          {`Couldn't read ${unread.join(' and ')}.`}{' '}
          <button type="button" className="btn-link font-semibold" onClick={onRetry}>
            Retry
          </button>
        </p>
      ) : null}
    </div>
  )
}
