import * as sdk from '@bananapus/nana-sdk-core'
import { toFunctionSelector, type Abi, type AbiFunction, type Hex } from 'viem'
import { formatAbiItem } from 'viem/utils'
import { describe, expect, it } from 'vitest'
import * as sticky from '@/lib/sticky-abis'

// Where each function the old client calls lives now. The five Sticky ABIs come from the SDK, the
// lists below them are this app's own, and the last is the SDK's full ABI for calls the old client
// makes that Sticky's lists do not carry.
const SOURCES: Record<string, Abi> = {
  stickyDeployerAbi: sticky.stickyDeployerAbi,
  stickyHookAbi: sticky.stickyHookAbi,
  stickyDistributorAbi: sticky.stickyDistributorAbi,
  stickyRewardReceiverFactoryAbi: sticky.stickyRewardReceiverFactoryAbi,
  stickyAutoStickAbi: sticky.stickyAutoStickAbi,
  stickyTokenAbi: sticky.stickyTokenAbi,
  terminalAbi: sticky.terminalAbi,
  feelessAddressesAbi: sticky.feelessAddressesAbi,
  terminalStoreAbi: sticky.terminalStoreAbi,
  projectsAbi: sticky.projectsAbi,
  tokensAbi: sticky.tokensAbi,
  controllerAbi: sticky.controllerAbi,
  'jbMultiTerminalAbi (SDK)': sdk.jbMultiTerminalAbi,
}

// Every entry of the old client's SEL table (webclient/app.js, lines 8-80) except three this module has
// no use for: `mint`, which that client never calls, and `handleOf` and `ensReverseWithGateways`, which
// read JBProjectHandles and the ENS resolver and take their ABIs from the modules that use them.
// Columns: the SEL name, where the function lives now, its signature, and the selector it had there.
const SEL: [string, string, string, Hex][] = [
  ['HOOK', 'stickyDeployerAbi', 'HOOK()', '0xa54eb242'],
  ['CONTROLLER', 'stickyDeployerAbi', 'CONTROLLER()', '0xee0fc121'],
  ['TOKENS', 'stickyDeployerAbi', 'TOKENS()', '0x1d831d5c'],
  ['TERMINAL', 'stickyDeployerAbi', 'TERMINAL()', '0x160668af'],
  ['PROJECTS', 'controllerAbi', 'PROJECTS()', '0x293c4999'],
  ['count', 'projectsAbi', 'count()', '0x06661abd'],
  ['creationFee', 'projectsAbi', 'creationFee()', '0xdce0b4e4'],
  ['stakedTokenOf', 'stickyDeployerAbi', 'stakedTokenOf(uint256)', '0xdbced5db'],
  [
    'deployStickyFor',
    'stickyDeployerAbi',
    'deployStickyFor(address,string,string,string,uint256,address[],bool)',
    '0x00d5ce37',
  ],
  ['SOULBOUND', 'stickyTokenAbi', 'SOULBOUND()', '0x32a9ba68'],
  ['setTrustedSenderFor', 'stickyHookAbi', 'setTrustedSenderFor(uint256,address,bool)', '0x3a799596'],
  ['isTrustedSenderOf', 'stickyHookAbi', 'isTrustedSenderOf(uint256,address,address)', '0x5d0bc3bb'],
  ['cashOutTaxRateOf', 'stickyDeployerAbi', 'cashOutTaxRateOf(uint256)', '0x7aac1c6f'],
  ['STORE', 'terminalAbi', 'STORE()', '0x507f1465'],
  ['storeBalanceOf', 'terminalStoreAbi', 'balanceOf(address,uint256,address)', '0x467f4cb9'],
  ['orphanedBalanceOf', 'stickyHookAbi', 'orphanedBalanceOf(uint256)', '0x325fcad5'],
  ['tranchesOf', 'stickyHookAbi', 'tranchesOf(uint256,address)', '0x8cc1b370'],
  ['trancheCountOf', 'stickyHookAbi', 'trancheCountOf(uint256,address)', '0x56dbba3b'],
  ['tranchesRangeOf', 'stickyHookAbi', 'tranchesOf(uint256,address,uint256,uint256)', '0xc964d0f3'],
  ['stakedBalanceOf', 'stickyHookAbi', 'stakedBalanceOf(uint256,address)', '0x7bd208b2'],
  ['streakStartOf', 'stickyHookAbi', 'streakStartOf(uint256,address)', '0xac609038'],
  ['longestStreakOf', 'stickyHookAbi', 'longestStreakOf(uint256,address)', '0x62a82139'],
  ['decimals', 'stickyTokenAbi', 'decimals()', '0x313ce567'],
  ['symbol', 'stickyTokenAbi', 'symbol()', '0x95d89b41'],
  ['name', 'stickyTokenAbi', 'name()', '0x06fdde03'],
  ['balanceOf', 'stickyTokenAbi', 'balanceOf(address)', '0x70a08231'],
  ['allowance', 'stickyTokenAbi', 'allowance(address,address)', '0xdd62ed3e'],
  ['approve', 'stickyTokenAbi', 'approve(address,uint256)', '0x095ea7b3'],
  ['totalSupply', 'stickyTokenAbi', 'totalSupply()', '0x18160ddd'],
  ['tokenOf', 'tokensAbi', 'tokenOf(uint256)', '0xea78803f'],
  ['projectIdOf', 'tokensAbi', 'projectIdOf(address)', '0x0f85421b'],
  ['uriOf', 'controllerAbi', 'uriOf(uint256)', '0xa312889b'],
  [
    'pay',
    'jbMultiTerminalAbi (SDK)',
    'pay(uint256,address,uint256,address,uint256,string,bytes)',
    '0xfef43257',
  ],
  ['previewPayFor', 'terminalAbi', 'previewPayFor(uint256,address,uint256,address,bytes)', '0x0aff0c31'],
  [
    'cashOutTokensOf',
    'jbMultiTerminalAbi (SDK)',
    'cashOutTokensOf(address,uint256,uint256,address,uint256,address,bytes)',
    '0x13da8317',
  ],
  ['fund', 'stickyDistributorAbi', 'fund(address,address,uint256,uint256)', '0x77531866'],
  ['beginVesting', 'stickyDistributorAbi', 'beginVesting(address,uint256,uint256[],address[])', '0x83d96f8f'],
  [
    'collectVestedRewards',
    'stickyDistributorAbi',
    'collectVestedRewards(address,uint256,uint256[],address[],address)',
    '0x4d355ce6',
  ],
  ['collectableFor', 'stickyDistributorAbi', 'collectableFor(address,uint256,uint256,address)', '0x5710be41'],
  ['nextClaimRoundOf', 'stickyDistributorAbi', 'nextClaimRoundOf(address,uint256,uint256,address)', '0x5fef1a8a'],
  ['rewardRoundOf', 'stickyDistributorAbi', 'rewardRoundOf(address,uint256,address,uint256)', '0xc45c9bf6'],
  ['isValidGroupId', 'stickyDistributorAbi', 'isValidGroupId(uint256)', '0x0468459c'],
  ['snapshotEpochOf', 'stickyDistributorAbi', 'snapshotEpochOf(uint256)', '0x09ff1c3f'],
  ['currentRound', 'stickyDistributorAbi', 'currentRound()', '0x8a19c8bc'],
  ['ROUND_DURATION', 'stickyDistributorAbi', 'ROUND_DURATION()', '0x6641ea08'],
  ['VESTING_ROUNDS', 'stickyDistributorAbi', 'VESTING_ROUNDS()', '0xaf29da14'],
  ['STARTING_TIMESTAMP', 'stickyDistributorAbi', 'STARTING_TIMESTAMP()', '0x20e9fcd4'],
  ['claimedFor', 'stickyDistributorAbi', 'claimedFor(address,uint256,uint256,address)', '0x51e0706c'],
  ['latestVestedIndexOf', 'stickyDistributorAbi', 'latestVestedIndexOf(address,uint256,uint256,address)', '0x4d5bf2a8'],
  ['vestingDataOf', 'stickyDistributorAbi', 'vestingDataOf(address,uint256,uint256,address,uint256)', '0xa50ae7da'],
  ['getPastVotes', 'stickyTokenAbi', 'getPastVotes(address,uint256)', '0x3a46b1a8'],
  [
    'previewCashOutFrom',
    'terminalAbi',
    'previewCashOutFrom(address,uint256,uint256,address,address,bytes)',
    '0x4aa71dbc',
  ],
  ['feeFreeSurplusOf', 'terminalAbi', 'feeFreeSurplusOf(uint256,address)', '0xc66d192b'],
  ['FEELESS_ADDRESSES', 'terminalAbi', 'FEELESS_ADDRESSES()', '0x659a2047'],
  ['isFeelessFor', 'feelessAddressesAbi', 'isFeelessFor(address,uint256,address)', '0x8717d7c2'],
  [
    'stakedBalanceThroughEpochOf',
    'stickyHookAbi',
    'stakedBalanceThroughEpochOf(uint256,address,uint256)',
    '0x0fdcc877',
  ],
  ['DISTRIBUTOR', 'stickyRewardReceiverFactoryAbi', 'DISTRIBUTOR()', '0x9c26149f'],
  ['predictReceiverOf', 'stickyRewardReceiverFactoryAbi', 'predictReceiverOf(address,uint256)', '0x330b5eea'],
  ['deployReceiverFor', 'stickyRewardReceiverFactoryAbi', 'deployReceiverFor(address,uint256)', '0x18d82376'],
  ['settleFor', 'stickyRewardReceiverFactoryAbi', 'settleFor(address,uint256,address)', '0xa4b4e8bf'],
  ['ownerOf', 'projectsAbi', 'ownerOf(uint256)', '0x6352211e'],
  ['isGranterOf', 'stickyHookAbi', 'isGranterOf(uint256,address)', '0xb9f2a2ba'],
  ['asConfigOf', 'stickyAutoStickAbi', 'configOf(uint256,address)', '0x7f1a9379'],
  ['asStatusOf', 'stickyAutoStickAbi', 'statusOf(uint256,address,uint256[])', '0x7d33ed0f'],
  ['asSetConfigFor', 'stickyAutoStickAbi', 'setConfigFor(uint256,bool,uint128,uint48)', '0x415174c8'],
  ['asCompoundFor', 'stickyAutoStickAbi', 'compoundFor(uint256,address,uint256[])', '0x8244fb99'],
  ['asStickRewardsFor', 'stickyAutoStickAbi', 'stickRewardsFor(uint256,uint256[])', '0x40b5a05d'],
  ['asBeginVestingFor', 'stickyAutoStickAbi', 'beginVestingFor(uint256,address,uint256[])', '0xa15557e8'],
  // Not in the SEL table: webclient/app.js:4660 hard-codes it for the Sticky token's transfer.
  ['transfer (app.js:4660)', 'stickyTokenAbi', 'transfer(address,uint256)', '0xa9059cbb'],
]

const functionNamed = (abi: Abi, signature: string) =>
  abi.find(
    (item): item is AbiFunction =>
      item.type === 'function' && formatAbiItem(item) === signature,
  )

describe('the functions the old client calls', () => {
  it.each(SEL)('SEL.%s is %s %s', (_name, source, signature, selector) => {
    const item = functionNamed(SOURCES[source], signature)
    expect(item, `${source} has no ${signature}`).toBeDefined()
    expect(toFunctionSelector(item!)).toBe(selector)
  })

  it('has one row each', () => {
    expect(new Set(SEL.map(([name]) => name)).size).toBe(SEL.length)
  })
})

// Selectors say nothing about what a call returns, so each list this app writes is held to the
// SDK's ABI for the functions it names. The SDK's JSON carries two things an encoder and decoder
// never read: each parameter's Solidity `internalType`, and an empty name on an unnamed output.
const canonical = (item: unknown) =>
  JSON.parse(
    JSON.stringify(item, (key, value) =>
      key === 'internalType' || (key === 'name' && value === '') ? undefined : value,
    ),
  )

describe('the lists this app writes', () => {
  it.each([
    ['terminalAbi', sticky.terminalAbi, sdk.jbMultiTerminalAbi],
    ['terminalStoreAbi', sticky.terminalStoreAbi, sdk.jbTerminalStoreAbi],
    ['projectsAbi', sticky.projectsAbi, sdk.jbProjectsAbi],
    ['tokensAbi', sticky.tokensAbi, sdk.jbTokensAbi],
    ['controllerAbi', sticky.controllerAbi, sdk.jbControllerAbi],
  ] as [string, Abi, Abi][])(
    '%s describes each function it lists exactly as the SDK does',
    (_name, list, full) => {
      expect(list.length).toBeGreaterThan(0)
      for (const item of list) {
        const sdkItem = full.find(
          entry => entry.type === item.type && 'name' in entry && 'name' in item && entry.name === item.name,
        )
        expect(sdkItem, `the SDK has no ${'name' in item ? item.name : item.type}`).toBeDefined()
        expect(canonical(item)).toEqual(canonical(sdkItem))
      }
    },
  )

  it('re-exports the SDK\'s five Sticky ABIs rather than copying them', () => {
    expect(sticky.stickyHookAbi).toBe(sdk.stickyHookAbi)
    expect(sticky.stickyDeployerAbi).toBe(sdk.stickyDeployerAbi)
    expect(sticky.stickyDistributorAbi).toBe(sdk.stickyDistributorAbi)
    expect(sticky.stickyRewardReceiverFactoryAbi).toBe(sdk.stickyRewardReceiverFactoryAbi)
    expect(sticky.stickyAutoStickAbi).toBe(sdk.stickyAutoStickAbi)
  })
})
