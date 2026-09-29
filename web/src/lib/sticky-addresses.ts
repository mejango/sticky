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
