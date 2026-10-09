import { SplitPortion } from '@bananapus/nana-sdk-core'
import {
  buildStickyReservedSplit, getProjectIdForToken, getStickyCollectorPending,
  stickySourceCollectorDeployment, verifyStickyCollectorRoute,
  type StickyCollectorAllocation, type StickyCollectorRoute, type StickySourceCollectorDeployment,
} from '@bananapus/nana-sdk-core/v6'
import type { Address, PublicClient } from 'viem'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { parseAmount } from '@/lib/sticky-amount'
import { createStickyBridge, type BridgeRoute } from '@/lib/sticky-bridge'
import { parseTokenInput } from '@/lib/sticky-launch-plan'
import { stickySourceCollectors } from '@/lib/sticky-source-collectors'

/** A configured source allocation, with live SDK evidence and its optional direct bridge lane. */
export type CollectorSource = {
  allocation: StickyCollectorAllocation
  verified: StickyCollectorRoute
  bridgeRoute?: BridgeRoute
}

/** Exact percent text in the SDK split precision; never round a source allocation. */
export function reservedSplitPercent(text: string): number {
  const portion = new SplitPortion(0)
  portion.value = parseAmount(text, portion.decimals - 2)
  if (portion.value === 0n) throw new Error('Enter a positive share of reserved tokens.')
  return Number(portion.value)
}

/** UI orchestration only: SDK owns family identity, allocation encoding and route qualification. */
export function createStickyCollector(
  clientFor: (chainId: number) => PublicClient = jbCenterPublicClient,
  deployments: readonly StickySourceCollectorDeployment[] = stickySourceCollectors,
) {
  const bridge = createStickyBridge(clientFor)
  const deployment = (sourceChainId: number, homeChainId: number) =>
    stickySourceCollectorDeployment(sourceChainId, homeChainId, deployments)

  async function verify(source: CollectorSource): Promise<StickyCollectorRoute> {
    const { allocation, bridgeRoute } = source
    const { sourceChainId, destinationChainId } = allocation.deployment
    const result = await verifyStickyCollectorRoute(clientFor(sourceChainId), clientFor(destinationChainId), {
      ...allocation,
      ...(bridgeRoute ? { sucker: bridgeRoute.sourceSucker, backingToken: bridgeRoute.backingToken } : {}),
    })
    if (bridgeRoute) await bridge.validateRoute(bridgeRoute, { preparing: true, sending: true })
    return result
  }

  async function discover({ sourceChainId, homeChainId, sourceProject, stickyToken, groupId }: {
    sourceChainId: number
    homeChainId: number
    sourceProject: string
    stickyToken: Address
    groupId: bigint
  }): Promise<CollectorSource[]> {
    const configured = deployment(sourceChainId, homeChainId)
    if (!configured) throw new Error('No verified collector deployment is configured for this source and home chain.')
    const input = parseTokenInput(sourceProject)
    if (input.kind !== 'project' && input.kind !== 'address') throw new Error('Enter a Juicebox V6 project ID or project token address.')
    if (input.kind === 'project' && input.chainId !== null && input.chainId !== sourceChainId) {
      throw new Error('The project prefix must match the selected source chain.')
    }
    const sourceProjectId = input.kind === 'project' ? input.projectId : await getProjectIdForToken(clientFor(sourceChainId), {
      chainId: configured.sourceChainId, token: input.address,
    })
    if (!sourceProjectId) throw new Error('This is not a Juicebox V6 project token on the selected source chain.')
    const allocation = { deployment: configured, sourceProjectId, stickyToken, groupId }
    // Validate the SDK allocation before discovery reads; no recipe is displayed until live verification succeeds.
    buildStickyReservedSplit({ ...allocation, percent: 0 })
    if (sourceChainId === homeChainId) {
      const verified = await verifyStickyCollectorRoute(clientFor(sourceChainId), clientFor(homeChainId), allocation)
      return [{ allocation, verified }]
    }
    const routes = await bridge.discover({
      source: { chainId: configured.sourceChainId }, destination: { chainId: configured.destinationChainId }, sourceProjectId,
    })
    const checked = await Promise.allSettled(routes.filter(route => route.canPrepare).map(async bridgeRoute => {
      const verified = await verifyStickyCollectorRoute(clientFor(sourceChainId), clientFor(homeChainId), {
        ...allocation, sucker: bridgeRoute.sourceSucker, backingToken: bridgeRoute.backingToken,
      })
      return { allocation, verified, bridgeRoute }
    }))
    const sources = checked.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    if (!sources.length) {
      const refused = checked.find(result => result.status === 'rejected')
      throw refused?.reason ?? new Error('No usable direct route connects this source project to the pool’s home chain.')
    }
    return sources
  }

  return {
    deployment, discover, verify,
    pending: (source: CollectorSource) => getStickyCollectorPending(clientFor(source.allocation.deployment.sourceChainId), source.allocation),
    recipe: (source: CollectorSource, percent: number) => buildStickyReservedSplit({ ...source.allocation, percent }),
  }
}

export const stickyCollector = createStickyCollector()
