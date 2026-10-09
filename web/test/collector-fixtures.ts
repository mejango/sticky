import type { Address, Hex } from 'viem'
import type { BridgeRoute } from '@/lib/sticky-bridge'
import type { CollectorSource } from '@/lib/sticky-collector'
import { stickyInfo } from './home-fixtures'

export const collectorAddress = (n: number) => `0x${BigInt(n).toString(16).padStart(40, '0')}` as Address
export const collectorHash = (n: number) => `0x${BigInt(n).toString(16).padStart(64, '0')}` as Hex
export const COLLECTOR_OWNER = collectorAddress(40)
export const COLLECTOR_RECEIVER = collectorAddress(41)
export const COLLECTOR_HASH = collectorHash(90)
export const COLLECTOR_INFO = stickyInfo(10, 22n, { stToken: collectorAddress(20) })
export const COLLECTOR_ROUTE: BridgeRoute = {
  source: { chainId: 1 }, destination: { chainId: 10 }, sourceSucker: collectorAddress(1), destinationSucker: collectorAddress(2),
  sourceProjectId: '3', destinationProjectId: '7', sourceToken: collectorAddress(3), rewardToken: collectorAddress(4),
  backingToken: collectorAddress(5), remoteBackingToken: collectorAddress(6), terminal: collectorAddress(7),
  sourceMeta: { symbol: 'SRC', decimals: 18 }, rewardMeta: { symbol: 'DST', decimals: 18 },
  backingMeta: { symbol: 'ETH', decimals: 18 }, canPrepare: true,
}
export const COLLECTOR_SOURCE: CollectorSource = {
  allocation: {
    deployment: {
      sourceChainId: 1, destinationChainId: 10, address: collectorAddress(10), runtimeCodeHash: collectorHash(1),
      feePayer: collectorAddress(11), feePayerRuntimeCodeHash: collectorHash(2), registry: collectorAddress(12),
      tokens: collectorAddress(13), directory: collectorAddress(14), receiverFactory: collectorAddress(15),
    },
    sourceProjectId: 3n, stickyToken: COLLECTOR_INFO.stToken, groupId: 4000n,
  },
  verified: { sourceToken: COLLECTOR_ROUTE.sourceToken, rewardToken: COLLECTOR_ROUTE.rewardToken, receiver: COLLECTOR_RECEIVER, destinationProjectId: 7n },
  bridgeRoute: COLLECTOR_ROUTE,
}
export const localCollectorSource = (): CollectorSource => ({
  ...COLLECTOR_SOURCE,
  allocation: { ...COLLECTOR_SOURCE.allocation, deployment: { ...COLLECTOR_SOURCE.allocation.deployment, sourceChainId: 10 } },
  verified: { ...COLLECTOR_SOURCE.verified, rewardToken: COLLECTOR_ROUTE.sourceToken, destinationProjectId: 3n },
  bridgeRoute: undefined,
})
