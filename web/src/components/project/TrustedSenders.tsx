'use client'

import { useState } from 'react'
import type { Address } from 'viem'
import { TrustFlow } from '@/components/project/flows/TrustFlow'
import { Skeleton } from '@/components/ui/Skeleton'
import { useTrustedSenders, useViewer } from '@/hooks/useStickyAirdrops'
import { useStickyEvents } from '@/hooks/useStickyProject'

/**
 * The addresses the viewer trusts to stick tokens for them in this project, as the hook has them now. The auto-stick
 * adapter is not one: its card presents its trust. With no viewer there is no list. Trust, and each sender's Untrust,
 * open the trust flow.
 */
export function TrustedSenders({ chainId, projectId }: { chainId: number; projectId: number }) {
  const holder = useViewer()
  /** The flow that is open: for a sender to untrust, or (with none) to trust one. */
  const [flow, setFlow] = useState<{ sender: Address | null } | null>(null)
  const events = useStickyEvents(chainId, projectId)
  const trusted = useTrustedSenders(chainId, projectId, holder)
  const senders = trusted.data
  const failed = senders === undefined && (trusted.isError || (events.isError && events.data === undefined))

  return (
    <section aria-labelledby="trusted-title" className="card p-5">
      <h2 id="trusted-title" className="mb-2 font-agrandir-wide text-base leading-tight">
        Who can stick for you
      </h2>
      <p className="mb-2.5 text-muted">Addresses you trust can stick tokens for you.</p>
      {holder === null ? null : failed ? (
        <p role="alert" className="text-err">
          Could not read who can stick for you.{' '}
          <button
            type="button"
            className="btn-link font-semibold"
            onClick={() => void (trusted.isError ? trusted.refetch() : events.refetch())}
          >
            Try again
          </button>
        </p>
      ) : senders === undefined ? (
        <div aria-busy="true" className="space-y-2.5">
          <Skeleton className="h-3 w-[80%] rounded" />
          <Skeleton className="h-3 w-[65%] rounded" />
        </div>
      ) : senders.length ? (
        <ul className="m-0 list-none divide-y divide-line p-0">
          {senders.map(sender => (
            <li key={sender} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 break-all">{sender}</span>
              <button type="button" onClick={() => setFlow({ sender })} className="btn-secondary px-3 py-1 text-sm">
                Untrust
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div>
          <strong className="block font-medium">None yet</strong>
          <span className="block text-[13px] text-muted">Only you and the project&apos;s trusted senders can stick for you.</span>
        </div>
      )}
      <button type="button" onClick={() => setFlow({ sender: null })} className="btn-secondary mt-3 px-3 py-1.5 text-sm">
        Trust
      </button>
      {flow ? (
        <TrustFlow key={flow.sender ?? 'trust'} chainId={chainId} projectId={projectId} sender={flow.sender} onClose={() => setFlow(null)} />
      ) : null}
    </section>
  )
}
