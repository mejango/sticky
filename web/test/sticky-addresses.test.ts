import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stickyChainIds, stickyContractName, stickyDeployment } from '@/lib/sticky-addresses'

describe('Sticky deployments', () => {
  it('lists every chain with verified records, in both families', () => {
    expect(stickyChainIds('production')).toEqual([1, 10, 8453, 42161])
    expect(stickyChainIds('testnet')).toEqual([84532, 421614, 11155111, 11155420])
  })
  it('returns checksummed addresses and the deployer block', () => {
    const base = stickyDeployment(8453)!
    expect(base.deployer).toBe('0xdA38Ec48B5b1d186B02BA99F297e95153BEE33a9')
    expect(base.rewardReceiverFactory).toBe('0x41AEC7AacEa4759F2c8AaBD68D4a4C1574A6A737')
    expect(base.fromBlock).toBe(51791252n)
  })
  it('knows nothing about other chains', () => {
    expect(stickyDeployment(137)).toBeNull()
  })
  it('matches the deployment records', () => {
    expect(() => execFileSync('node', ['scripts/sync-deployments.mjs', '--check'])).not.toThrow()
  })
  it('returns every contract of a chain', () => {
    expect(stickyDeployment(84532)).toEqual({
      chainId: 84532,
      deployer: '0xdA38Ec48B5b1d186B02BA99F297e95153BEE33a9',
      hook: '0xa8DcD735031cf96C4213D9A3f66a1DFFDCdba693',
      terminal: '0x130f5Dd2bD8805443Cf41755253D778a75a67f53',
      controller: '0x3Fcec3572e84b624477BcfF4E2CF1f7dEAb648F1',
      distributor: '0xc62b3fED668Cd8a3879ba34890a67C48a52b1Bb8',
      rewardReceiverFactory: '0x41AEC7AacEa4759F2c8AaBD68D4a4C1574A6A737',
      autoStick: '0x9B091e21d25c424De67751F4b6Ae8494351218C5',
      fromBlock: 47301559n,
    })
  })
})

describe('stickyContractName', () => {
  const NAMES = {
    deployer: 'StickyDeployer',
    hook: 'StickyHook',
    terminal: 'JBMultiTerminal',
    controller: 'JBController',
    distributor: 'StickyDistributor',
    rewardReceiverFactory: 'StickyRewardReceiverFactory',
    autoStick: 'StickyAutoStick',
  } as const

  it('names each Sticky contract on every chain it is deployed to, in any letter case', () => {
    for (const chainId of [...stickyChainIds('production'), ...stickyChainIds('testnet')]) {
      const deployment = stickyDeployment(chainId)!
      for (const [field, name] of Object.entries(NAMES)) {
        const address = deployment[field as keyof typeof NAMES]
        expect(stickyContractName(chainId, address), `${chainId} ${field}`).toBe(name)
        expect(stickyContractName(chainId, address.toLowerCase())).toBe(name)
      }
    }
  })

  it('knows no other address, and no chain without Sticky', () => {
    expect(stickyContractName(8453, '0x1111111111111111111111111111111111111111')).toBeNull()
    expect(stickyContractName(137, stickyDeployment(8453)!.hook)).toBeNull()
  })

  it('names a redeployed contract from the records, before anything else knows its address', async () => {
    const { default: recorded } = await import('@/lib/sticky-deployments.json')
    const redeployed = '0x00000000000000000000000000000000000000Aa'
    vi.resetModules()
    vi.doMock('@/lib/sticky-deployments.json', () => ({
      default: { ...recorded, '8453': { ...recorded['8453'], hook: redeployed } },
    }))
    const accessor = await import('@/lib/sticky-addresses')
    expect(accessor.stickyContractName(8453, redeployed)).toBe('StickyHook')
    expect(accessor.stickyContractName(8453, recorded['8453'].hook)).toBeNull()
    vi.doUnmock('@/lib/sticky-deployments.json')
    vi.resetModules()
  })
})

describe('A record for a chain the app does not support', () => {
  afterEach(() => {
    vi.doUnmock('@/lib/sticky-deployments.json')
    vi.resetModules()
  })

  it('is left out, not filed under production', async () => {
    const { default: recorded } = await import('@/lib/sticky-deployments.json')
    vi.resetModules()
    vi.doMock('@/lib/sticky-deployments.json', () => ({
      default: { ...recorded, '137': recorded['8453'] },
    }))
    const accessor = await import('@/lib/sticky-addresses')
    expect(accessor.stickyDeployment(137)).toBeNull()
    expect(accessor.stickyChainIds('production')).toEqual([1, 10, 8453, 42161])
    expect(accessor.stickyChainIds('testnet')).toEqual([84532, 421614, 11155111, 11155420])
  })
})
