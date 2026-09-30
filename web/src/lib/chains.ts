import {
  arbitrum,
  arbitrumSepolia,
  base,
  baseSepolia,
  mainnet,
  optimism,
  optimismSepolia,
  sepolia,
} from '@bananapus/nana-sdk-core/chains'

export const PRODUCTION_CHAINS = [mainnet, optimism, base, arbitrum] as const
export const TESTNET_CHAINS = [
  sepolia,
  optimismSepolia,
  baseSepolia,
  arbitrumSepolia,
] as const
export const SUPPORTED_CHAINS = [
  ...PRODUCTION_CHAINS,
  ...TESTNET_CHAINS,
] as const

export type ChainEnvironment = 'production' | 'testnet'

export function chainsForEnvironment(environment: ChainEnvironment) {
  return environment === 'production' ? PRODUCTION_CHAINS : TESTNET_CHAINS
}

export function environmentForChainIds(
  chainIds: readonly number[],
): ChainEnvironment {
  const firstChainId = chainIds.find(chainId =>
    SUPPORTED_CHAINS.some(chain => chain.id === chainId),
  )
  return TESTNET_CHAINS.some(chain => chain.id === firstChainId)
    ? 'testnet'
    : 'production'
}
