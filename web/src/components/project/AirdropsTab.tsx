'use client'

import { AutoStickCard } from '@/components/project/AutoStickCard'
import { RewardsCard } from '@/components/project/RewardsCard'
import { TrustedSenders } from '@/components/project/TrustedSenders'
import { ShowingPanel } from '@/hooks/useShowing'

/**
 * A Sticky project's Airdrops tab: the viewer's rewards, their auto-stick, and who they trust to stick for them. What
 * it reads about the viewer goes on only while its panel is showing.
 */
export function AirdropsTab({ chainId, projectId }: { chainId: number; projectId: number }) {
  return (
    <ShowingPanel className="flex flex-col gap-5">
      <RewardsCard chainId={chainId} projectId={projectId} />
      <AutoStickCard chainId={chainId} projectId={projectId} />
      <TrustedSenders chainId={chainId} projectId={projectId} />
    </ShowingPanel>
  )
}
