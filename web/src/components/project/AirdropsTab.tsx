'use client'

import { AutoStickCard } from '@/components/project/AutoStickCard'
import { RewardsCard } from '@/components/project/RewardsCard'
import { TrustedSenders } from '@/components/project/TrustedSenders'

/** A Sticky project's Airdrops tab: the viewer's rewards, their auto-stick, and who they trust to stick for them. */
export function AirdropsTab({ chainId, projectId }: { chainId: number; projectId: number }) {
  return (
    <div className="flex flex-col gap-5">
      <RewardsCard chainId={chainId} projectId={projectId} />
      <AutoStickCard chainId={chainId} projectId={projectId} />
      <TrustedSenders chainId={chainId} projectId={projectId} />
    </div>
  )
}
