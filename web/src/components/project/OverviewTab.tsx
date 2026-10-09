import { BackingChart } from '@/components/project/BackingChart'
import { DetailsCard } from '@/components/project/DetailsCard'

/** A Sticky project's Overview tab: its local backing chart and Details card. */
export function OverviewTab({ chainId, projectId }: { chainId: number; projectId: number }) {
  return (
    <div>
      <BackingChart chainId={chainId} projectId={projectId} />
      <DetailsCard chainId={chainId} projectId={projectId} />
    </div>
  )
}
