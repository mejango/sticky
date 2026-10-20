'use client'

import dynamic from 'next/dynamic'
import { SkeletonLines } from '@/components/ui/Skeleton'

// ProjectTabs mounts a panel only once it is selected. Declaring these boundaries in a Client Component lets Next emit
// on-demand chunks for them instead of folding them into the project route. The loading renderer is a local Suspense
// boundary: without it, a first-open chunk falls through to [urn]/loading.tsx and replaces the whole project.
function TabSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="card p-5">
      <SkeletonLines lines={4} />
    </div>
  )
}

export const TokensTab = dynamic(
  () => import('@/components/project/TokensTab').then(module => module.TokensTab),
  { loading: () => <TabSkeleton label="Loading tokens" /> },
)
export const AirdropsTab = dynamic(
  () => import('@/components/project/AirdropsTab').then(module => module.AirdropsTab),
  { loading: () => <TabSkeleton label="Loading airdrops" /> },
)

/** Fetches the tab chunks ahead of a click: the tab row calls it on hover or focus, and once the page is idle. */
export function preloadProjectTabs() {
  void import('@/components/project/TokensTab')
  void import('@/components/project/AirdropsTab')
}
