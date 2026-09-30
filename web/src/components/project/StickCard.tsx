'use client'

import { StickFlow } from '@/components/project/flows/StickFlow'
import { Skeleton } from '@/components/ui/Skeleton'
import { useStickyProject } from '@/hooks/useStickyProject'

/**
 * The Stick card: an amount of the staked token to stick and, for the viewed or connected account, what it holds of
 * that token in its wallet, a link that fills in all of it. The button reads "Checking…" until this visit has read the
 * project, since nothing is stuck on the word of a copy the browser kept.
 */
export function StickCard({ chainId, projectId }: { chainId: number; projectId: number }) {
  const { info } = useStickyProject(chainId, projectId)

  return (
    <section
      aria-labelledby="stick-title"
      className="rounded-xl border-2 border-accent bg-card p-5 shadow-[0_0_0_4px_rgb(14_123_144/0.1),0_4px_20px_-4px_rgb(14_123_144/0.25)]"
    >
      <h2 id="stick-title" className="mb-3.5 font-agrandir-wide text-base leading-tight">
        {info ? `Stick ${info.symbol}` : <Skeleton as="span" className="block h-5 w-[120px] rounded" />}
      </h2>
      <StickFlow chainId={chainId} projectId={projectId} />
    </section>
  )
}
