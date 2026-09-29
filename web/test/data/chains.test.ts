import { describe, expect, it } from 'vitest'
import {
  PRODUCTION_CHAINS,
  SUPPORTED_CHAINS,
  TESTNET_CHAINS,
  chainsForEnvironment,
  environmentForChainIds,
} from '@/lib/chains'

describe('dual-environment chain configuration', () => {
  it('supports all four production and all four testnet chains', () => {
    expect(PRODUCTION_CHAINS.map(chain => chain.id)).toEqual([
      1, 10, 8453, 42161,
    ])
    expect(TESTNET_CHAINS.map(chain => chain.id)).toEqual([
      11155111, 11155420, 84532, 421614,
    ])
    expect(SUPPORTED_CHAINS).toHaveLength(8)
  })

  it('selects and restores one environment at a time', () => {
    expect(chainsForEnvironment('production')).toBe(PRODUCTION_CHAINS)
    expect(chainsForEnvironment('testnet')).toBe(TESTNET_CHAINS)
    expect(environmentForChainIds([8453, 10])).toBe('production')
    expect(environmentForChainIds([84532, 11155111])).toBe('testnet')
    expect(environmentForChainIds([])).toBe('production')
  })
})
