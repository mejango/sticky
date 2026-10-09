import {
  buildStickyCollectorSendTx, buildStickyCollectorSettleTx, stickySourceCollectorAbi,
  type StickyCollectorRoute,
} from '@bananapus/nana-sdk-core/v6'
import { decodeFunctionData, isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'
import type { TxRequest } from '@/hooks/useSafeTx'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { bridgeCalldata, createStickyBridge, type BridgeToken } from '@/lib/sticky-bridge'
import type { PendingBridgeWrite } from '@/lib/sticky-bridge-journal'
import { createStickyCollector, type CollectorSource } from '@/lib/sticky-collector'

export type CollectorDelivery = {
  source: CollectorSource
  amount: bigint
  pending: bigint
  verified: StickyCollectorRoute
  meta: BridgeToken
  request: TxRequest
}

/** Pending prepare records belong to BridgeFlow. Only this allocation's direct collector writes belong here. */
export function collectorWriteKind(source: CollectorSource, pending: PendingBridgeWrite): 'send' | 'settle' | null {
  const { deployment, sourceProjectId, stickyToken, groupId } = source.allocation
  if (pending.recordKey || pending.metadata || pending.request.chainId !== deployment.sourceChainId ||
    !isAddressEqual(pending.request.address, deployment.address)) return null
  try {
    const decoded = decodeFunctionData({ abi: stickySourceCollectorAbi, data: pending.request.data })
    if ((decoded.functionName !== 'send' && decoded.functionName !== 'settle') ||
      decoded.args[0] !== sourceProjectId || !isAddressEqual(decoded.args[1], stickyToken) || decoded.args[2] !== groupId) return null
    if (decoded.functionName === 'send' && (!source.bridgeRoute ||
      !isAddressEqual(decoded.args[4], source.bridgeRoute.sourceSucker) ||
      !isAddressEqual(decoded.args[5], source.bridgeRoute.backingToken))) return null
    return decoded.functionName
  } catch { return null }
}

/** Execution preparation reuses SDK identity/builders and the bridge's exact-call transport simulation. */
export function createStickyCollectorDelivery(clientFor: (chainId: number) => PublicClient = jbCenterPublicClient) {
  const collector = createStickyCollector(clientFor)
  const bridge = createStickyBridge(clientFor)

  async function read(source: CollectorSource) {
    const pending = await collector.pending(source)
    const meta = isAddressEqual(source.verified.sourceToken, zeroAddress)
      ? { symbol: `Project #${source.allocation.sourceProjectId} credits`, decimals: 18 }
      : await bridge.tokenMeta({ chainId: source.allocation.deployment.sourceChainId }, source.verified.sourceToken)
    return { pending, meta }
  }

  async function prepare(source: CollectorSource, owner: Address, amount: bigint): Promise<CollectorDelivery> {
    const verified = await collector.verify(source)
    if (isAddressEqual(verified.sourceToken, zeroAddress)) {
      throw new Error('The allocation is queued. Deploy the source project’s ERC-20 before delivering it.')
    }
    const { pending, meta } = await read({ ...source, verified })
    if (amount <= 0n || amount > pending) throw new Error('Choose a positive amount within the remaining queued allocation.')
    const { sourceChainId, destinationChainId } = source.allocation.deployment
    let request: TxRequest
    if (sourceChainId === destinationChainId) {
      request = { ...buildStickyCollectorSettleTx({ ...source.allocation, amount }), label: 'Settle queued rewards' }
    } else {
      const route = source.bridgeRoute
      if (!route) throw new Error('A verified direct bridge to this pool’s home chain is required.')
      const build = (value: bigint): TxRequest => ({
        ...buildStickyCollectorSendTx({ ...source.allocation, amount, sucker: route.sourceSucker, backingToken: route.backingToken, value }),
        label: 'Deliver queued rewards',
      })
      request = build(await bridge.transportValue(route, owner, build))
    }
    return { source, amount, pending, verified, meta, request }
  }

  async function reverify(reviewed: CollectorDelivery, owner: Address) {
    const fresh = await prepare(reviewed.source, owner, reviewed.amount)
    if (fresh.request.chainId !== reviewed.request.chainId || !isAddressEqual(fresh.request.address, reviewed.request.address) ||
      bridgeCalldata(fresh.request) !== bridgeCalldata(reviewed.request) || (fresh.request.value ?? 0n) > (reviewed.request.value ?? 0n) ||
      !isAddressEqual(fresh.verified.receiver, reviewed.verified.receiver) ||
      !isAddressEqual(fresh.verified.sourceToken, reviewed.verified.sourceToken) ||
      !isAddressEqual(fresh.verified.rewardToken, reviewed.verified.rewardToken)) {
      throw new Error('The allocation, receiver or bridge budget changed. Review delivery again.')
    }
  }

  return { read, prepare, reverify }
}
