import { BackingChart } from '@/components/project/BackingChart'
import { ChainsCard } from '@/components/project/ChainsCard'
import { DetailsCard } from '@/components/project/DetailsCard'

/** A Sticky project's Overview tab: the chart of what is stuck, the Details card, and the chains of its launch. */
export function OverviewTab({ chainId, projectId }: { chainId: number; projectId: number }) {
  return (
    <div>
      <BackingChart chainId={chainId} projectId={projectId} />
      <DetailsCard chainId={chainId} projectId={projectId} />
      <ChainsCard chainId={chainId} projectId={projectId} />
    </div>
  )
}
