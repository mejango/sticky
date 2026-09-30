'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { environmentForChainIds } from '@/lib/chains'
import { projectRouteSegmentFromPathname } from '@/lib/project-route'
import { parseUrn } from '@/lib/urn'
import { useResolvedProjectRoute } from '@/providers/ProjectRouteContext'

/**
 * The project the page in view is for, or null when it is no project's page. A route such as `/base:23` names its
 * project itself. A `/@handle` route names it once the server has resolved the handle, which the project page tells
 * the layout through `ProjectRouteSync`.
 */
export function useProjectInView() {
  const segment = projectRouteSegmentFromPathname(usePathname()) ?? ''
  // The handle a `/@handle` route names, spelled the way the server resolved it.
  const handle = segment.startsWith('@') ? segment.slice(1).replace(/\.eth$/i, '').toLowerCase() : null
  const resolved = useResolvedProjectRoute()
  return parseUrn(segment) ?? (handle && resolved?.handle === handle ? resolved : null)
}

/**
 * Whether the page in view is on the testnets. A project's chain names its network; the home and an account's page
 * carry theirs as `?network=testnet`. Reading the search parameters makes a prerendered page wait for the browser, so a
 * component that calls this needs a Suspense boundary above it unless only the client ever renders it.
 */
export function useTestnetInView() {
  const project = useProjectInView()
  const searchParams = useSearchParams()
  return project ? environmentForChainIds([project.chainId]) === 'testnet' : searchParams.get('network') === 'testnet'
}
