import { execFileSync } from 'node:child_process'
import { getAddress } from 'viem'
import { knownAddressName } from '@bananapus/nana-sdk-core/review/decode'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isLostRecipient, stickyChainIds, stickyContracts, stickyDeployment } from '@/lib/sticky-addresses'

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

describe('the names the review shows', () => {
  // The review dialog names a destination or an address argument from the SDK's address table, as jbm's does. A
  // contract redeployed before the SDK carries its address would read there as a bare address, so the records and the
  // table must agree before either ships.
  const NAMES = {
    deployer: 'StickyDeployer',
    hook: 'StickyHook',
    terminal: 'JBMultiTerminal',
    controller: 'JBController',
    distributor: 'StickyDistributor',
    rewardReceiverFactory: 'StickyRewardReceiverFactory',
    autoStick: 'StickyAutoStick',
  } as const

  it("names each contract of every Sticky deployment as the SDK's address table does", () => {
    for (const chainId of [...stickyChainIds('production'), ...stickyChainIds('testnet')]) {
      const deployment = stickyDeployment(chainId)!
      for (const [field, name] of Object.entries(NAMES)) {
        const address = deployment[field as keyof typeof NAMES]
        expect(knownAddressName(chainId, address), `${chainId} ${field}`).toBe(name)
        expect(knownAddressName(chainId, address.toLowerCase())).toBe(name)
      }
    }
  })
})

describe('isLostRecipient', () => {
  const project = (chainId: number) => ({
    chainId,
    stToken: '0x5555555555555555555555555555555555555555',
    stakedToken: '0x2222222222222222222222222222222222222222',
  })

  it('refuses every address in the record of the project\'s chain, on every chain, in any letter case', () => {
    for (const chainId of [...stickyChainIds('production'), ...stickyChainIds('testnet')]) {
      const { deployer, hook, terminal, controller, distributor, rewardReceiverFactory, autoStick } = stickyDeployment(chainId)!
      expect(new Set(stickyContracts(chainId))).toEqual(
        new Set([deployer, hook, terminal, controller, distributor, rewardReceiverFactory, autoStick]),
      )
      expect(stickyContracts(chainId)).toHaveLength(7)
      for (const address of stickyContracts(chainId)) {
        expect(isLostRecipient(project(chainId), address), `${chainId} ${address}`).toBe(true)
        expect(isLostRecipient(project(chainId), address.toLowerCase())).toBe(true)
      }
    }
  })

  it("refuses the project's Sticky token and the token it sticks, in any letter case", () => {
    const sticky = getAddress('0xb4591bfc2cf3507228af5e34763c2f379179529c')
    const staked = getAddress('0x65e7500aba73f45997acb1f5ce9202d771699629')
    const of = { chainId: 84532, stToken: sticky, stakedToken: staked }
    for (const address of [sticky, sticky.toLowerCase(), staked, staked.toLowerCase()]) {
      expect(isLostRecipient(of, address)).toBe(true)
    }
  })

  it('takes any other address, another project\'s tokens among them, and refuses none on a chain without Sticky', () => {
    expect(isLostRecipient(project(84532), '0x1111111111111111111111111111111111111111')).toBe(false)
    expect(isLostRecipient({ ...project(84532), stToken: '0x3333333333333333333333333333333333333333' }, project(84532).stToken)).toBe(false)
    expect(stickyContracts(137)).toEqual([])
    expect(isLostRecipient(project(137), stickyDeployment(8453)!.autoStick)).toBe(false)
  })

  it('refuses a contract the record gains, whatever field holds it', async () => {
    const { default: recorded } = await import('@/lib/sticky-deployments.json')
    const added = '0x00000000000000000000000000000000000000Bb'
    vi.resetModules()
    vi.doMock('@/lib/sticky-deployments.json', () => ({
      default: { ...recorded, '84532': { ...recorded['84532'], priceFeed: added } },
    }))
    const accessor = await import('@/lib/sticky-addresses')
    expect(accessor.isLostRecipient(project(84532), added)).toBe(true)
    expect(accessor.isLostRecipient(project(84532), added.toLowerCase())).toBe(true)
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
