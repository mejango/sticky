import type { Address } from 'viem'
import {
  SUPPORTED_CHAINS,
  environmentForChainIds,
  type ChainEnvironment,
} from '@/lib/chains'
import records from '@/lib/sticky-deployments.json'

export type StickyDeployment = {
  chainId: number
  deployer: Address
  hook: Address
  terminal: Address
  controller: Address
  distributor: Address
  rewardReceiverFactory: Address
  autoStick: Address
  /** The block the deployer was created in: no Sticky project is older. */
  fromBlock: bigint
}

// scripts/sync-deployments.mjs writes these from the repository's records,
// with the block as a decimal string.
type Recorded = Omit<StickyDeployment, 'chainId' | 'fromBlock'> & {
  fromBlock: string
}

const recorded = records as Record<string, Recorded>

// A record for a chain the app does not support is left out: the environment
// rule would file it under production.
const supported = new Set<number>(SUPPORTED_CHAINS.map(chain => chain.id))
const chainIds = Object.keys(recorded)
  .map(Number)
  .filter(chainId => supported.has(chainId))
  .sort((a, b) => a - b)

export function stickyChainIds(environment: ChainEnvironment): number[] {
  return chainIds.filter(
    chainId => environmentForChainIds([chainId]) === environment,
  )
}

export function stickyDeployment(chainId: number): StickyDeployment | null {
  if (!chainIds.includes(chainId)) return null
  const { fromBlock, ...addresses } = recorded[chainId]
  return { chainId, ...addresses, fromBlock: BigInt(fromBlock) }
}

/** The deployment record of `chainId`, for a read or a call that needs one: it throws on a chain Sticky is not deployed
 * on. */
export function deploymentOn(chainId: number): StickyDeployment {
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  return deployment
}

/** Every address in the deployment record of `chainId`, whatever field holds it; none for a chain without Sticky. */
export function stickyContracts(chainId: number): Address[] {
  const deployment = stickyDeployment(chainId)
  return deployment ? Object.values(deployment).filter((value): value is Address => typeof value === 'string') : []
}

/** What a flow says of a recipient that `isLostRecipient` refuses. */
export const LOST_RECIPIENT = 'Sticky tokens sent to this contract are lost. Choose a different recipient.'

/**
 * Whether a project's Sticky tokens sent to `address`, in any letter case, are lost for good: it is one of the contracts
 * in the deployment record of the project's chain (the terminal, the hook, the auto-stick adapter, the distributor and
 * every other), or one of the project's two tokens, its Sticky token and the token it sticks. None of them hands on
 * Sticky tokens it was simply sent.
 */
export function isLostRecipient(
  { chainId, stToken, stakedToken }: { chainId: number; stToken: string; stakedToken: string },
  address: string,
): boolean {
  const lower = address.toLowerCase()
  return [...stickyContracts(chainId), stToken, stakedToken].some(contract => contract.toLowerCase() === lower)
}
