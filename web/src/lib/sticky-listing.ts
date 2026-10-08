import { jbContractAddress } from '@bananapus/nana-sdk-core'
import { JBCenterClient, isSponsorable, publishSignedIntent, type JBCenterIntentInput } from '@bananapus/nana-sdk-core/jbcenter'
import { TRUSTED_FORWARDER_ABI } from '@bananapus/nana-sdk-core/review/relayr'
import { isEip7702DelegatedEoaRuntime } from '@bananapus/nana-sdk-core/safe'
import type { Hex } from 'viem'
import { jbCenterBaseUrl } from '@/lib/jbcenter-config'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { isAddress, type LaunchPlan } from '@/lib/sticky-launch-plan'

export const STICKY_LISTING_FORWARDER = jbContractAddress[6].ERC2771Forwarder[1]

/** Preserve the legacy listing envelope; creation fees are paid separately and are not signed metadata. */
export function buildStickyEnvelope(plan: LaunchPlan): JBCenterIntentInput {
  if (!plan.targets.length) throw new Error('A listing needs at least one launch call.')
  if (!isAddress(plan.owner)) throw new Error('A listing needs the launching wallet.')
  const targets = [...plan.targets].sort((a, b) => a.chainId - b.chainId)
  const chainIds = targets.map(target => target.chainId)
  if (new Set(chainIds).size !== chainIds.length) throw new Error('A listing has one launch per chain.')
  return {
    format: 'sticky.center/deploy.v1', deploymentVersion: '6', chainIds,
    deploymentCalls: targets.map(({ chainId, call }) => ({ chainId, to: call.target, data: call.data.toLowerCase() as Hex })),
    jb: { app: 'sticky', kind: 'sticky', name: plan.name, owner: plan.owner, chainIds: [...chainIds],
      symbol: plan.symbol, stakedToken: plan.token, stakedTokenSymbol: plan.tokenSymbol,
      cashOutTaxRate: plan.cashOutTaxRate, soulbound: plan.soulbound, launchId: plan.id, projectUri: plan.projectUri },
  }
}

/** Unknown account code cannot authorize a listing. A contract account remains eligible for a self-paid launch. */
export async function listingCapability(plan: LaunchPlan): Promise<'sponsored' | 'self-paid' | 'unavailable'> {
  if (!plan.targets.length || !jbCenterBaseUrl()) return 'unavailable'
  const client = jbCenterPublicClient(plan.targets[0].chainId)
  // viem maps the successful empty-code answer to undefined; an RPC failure stays distinct.
  let code: Hex | undefined
  try { code = await client.getCode({ address: plan.owner }) } catch { return 'unavailable' }
  if (code !== undefined && code !== '0x' && !isEip7702DelegatedEoaRuntime(code)) return 'unavailable'
  if (!isSponsorable(plan.targets.map(target => target.chainId))) return 'self-paid'
  const trusted = await Promise.all(plan.targets.map(({ chainId, deployer }) =>
    jbCenterPublicClient(chainId).readContract({ address: deployer, abi: TRUSTED_FORWARDER_ABI,
      functionName: 'isTrustedForwarder', args: [STICKY_LISTING_FORWARDER] }).catch(() => false),
  ))
  return trusted.every(value => value === true) ? 'sponsored' : 'self-paid'
}

export function createStickyCenterClient(): JBCenterClient {
  return new JBCenterClient({ baseUrl: jbCenterBaseUrl() })
}

/** The SDK authenticates the whole envelope and signing message before invoking the adapter's signer. */
export function publishStickyListing(plan: LaunchPlan, sign: (message: string) => Promise<Hex>) {
  return publishSignedIntent(createStickyCenterClient(), buildStickyEnvelope(plan), sign, { publisher: plan.owner })
}
