'use client'

import { AutoStickCard } from '@/components/project/AutoStickCard'
import { StickFlow } from '@/components/project/flows/StickFlow'
import { RewardsCard } from '@/components/project/RewardsCard'
import { TrustedSenders } from '@/components/project/TrustedSenders'
import { ShowingPanel } from '@/hooks/useShowing'

/**
 * A Sticky project's Airdrops tab: sticking for someone else, the viewer's rewards, their auto-stick, and who they
 * trust to stick for them. What it reads about the viewer goes on only while its panel is showing.
 */
export function AirdropsTab({ chainId, projectId }: { chainId: number; projectId: number }) {
  return (
    <ShowingPanel className="flex flex-col gap-5">
      <section aria-labelledby="stick-for-title" className="card p-5">
        <h2 id="stick-for-title" className="mb-2 font-agrandir-wide text-base leading-tight">
          Stick for someone else
        </h2>
        <p className="mb-2.5 text-muted">They must trust your wallet, unless you are a trusted sender.</p>
        <StickFlow chainId={chainId} projectId={projectId} forSomeoneElse />
      </section>
      <RewardsCard chainId={chainId} projectId={projectId} />
      <AutoStickCard chainId={chainId} projectId={projectId} />
      <TrustedSenders chainId={chainId} projectId={projectId} />
    </ShowingPanel>
  )
}
