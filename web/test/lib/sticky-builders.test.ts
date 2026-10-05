import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress, maxUint256, type Abi } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  stickyAutoStickAbi,
  stickyDeployerAbi,
  stickyDistributorAbi,
  stickyHookAbi,
  stickyRewardReceiverFactoryAbi,
} from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import {
  approveSteps,
  autoStickLeftoverTxs,
  autoStickOffTxs,
  autoStickOnTxs,
  autoStickSettingsTx,
  beginVestingTx,
  claimAndStickTxs,
  collectTx,
  compoundTx,
  createReceiverTx,
  fundTxs,
  repairTxs,
  settleTx,
  stickTx,
  transferTx,
  trustTx,
  unstickTxs,
  type TxRequest,
} from '@/lib/sticky-builders'
import fixtures from './calldata-fixtures.json'

// The calls a holder sends to stick, unstick, transfer and trust. Each is a request for the transaction engine, and
// its calldata is held to what Foundry's `cast calldata` encoded for the same values (calldata-fixtures.json).

const CHAIN = 84532
const deployment = stickyDeployment(CHAIN)!
const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`)
const A = address('1')
const B = address('2')
const C = address('3')

/** Project 12, sticking a token of 6 decimals. */
const info = {
  chainId: CHAIN,
  projectId: 12n,
  stakedToken: A,
  symbol: 'ART',
  decimals: 6,
  stToken: C,
  stSymbol: 'STICKYART',
  soulbound: false,
}
const ART = { symbol: 'ART', decimals: 6 }

const encoded = ({ abi, functionName, args }: TxRequest) => encodeFunctionData({ abi, functionName, args })
const calls = (txs: readonly TxRequest[]) => txs.map(({ address: to, functionName, args }) => [to, functionName, args])

describe('calldata', () => {
  it('is what cast calldata encoded, byte for byte, for every call these builders make', () => {
    const tx = (txs: TxRequest[]) => encoded(txs.at(-1)!)
    expect(tx(approveSteps(CHAIN, A, A, 0n, maxUint256, { ...ART, mode: 'exact' }))).toBe(fixtures.approve)
    expect(encoded(transferTx(info, B, 5n * 10n ** 18n))).toBe(fixtures.transfer)
    expect(encoded(stickTx(info, B, 10_000_000n, 9_990_000_000_000_000_000n))).toBe(fixtures.pay)
    expect(tx(unstickTxs(info, B, 10n ** 18n, 975_000n))).toBe(fixtures.cashOutTokensOf)
    expect(encoded(trustTx(CHAIN, 12n, C, true))).toBe(fixtures.setTrustedSenderFor)
  })

  // The builders of later tasks send these; the contracts' ABIs encode them as cast did.
  it.each([
    ['deployStickyFor', stickyDeployerAbi],
    ['fund', stickyDistributorAbi],
    ['beginVesting', stickyDistributorAbi],
    ['collectVestedRewards', stickyDistributorAbi],
    ['setConfigFor', stickyAutoStickAbi],
    ['compoundFor', stickyAutoStickAbi],
    ['stickRewardsFor', stickyAutoStickAbi],
    ['beginVestingFor', stickyAutoStickAbi],
    ['settleFor', stickyRewardReceiverFactoryAbi],
    ['deployReceiverFor', stickyRewardReceiverFactoryAbi],
  ] as [keyof typeof fixtures, Abi][])('of %s round-trips through the ABI', (name, abi) => {
    const data = fixtures[name] as `0x${string}`
    const { functionName, args } = decodeFunctionData({ abi, data })
    expect(functionName).toBe(name)
    expect(encodeFunctionData({ abi, functionName, args })).toBe(data)
  })
})

describe('approveSteps', () => {
  const steps = (allowance: bigint, amount: bigint, mode: 'exact' | 'covering' = 'exact') =>
    approveSteps(CHAIN, A, B, allowance, amount, { ...ART, mode })

  it('approves the exact amount when nothing is approved yet', () => {
    const [approval, ...rest] = steps(0n, 100_000_000n)
    expect(rest).toEqual([])
    expect(approval).toMatchObject({
      chainId: CHAIN,
      address: A,
      functionName: 'approve',
      args: [B, 100_000_000n],
      label: 'Approve 100 ART',
    })
  })

  it('declares no output for approve, so a token that returns nothing (USDT) still simulates, with the same calldata as erc20Abi', () => {
    const [approval] = steps(0n, 100_000_000n)
    expect(encoded(approval)).toBe(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [B, 100_000_000n] }))
    expect(decodeFunctionResult({ abi: approval.abi, functionName: 'approve', data: '0x' })).toBeUndefined()
    expect(() => decodeFunctionResult({ abi: erc20Abi, functionName: 'approve', data: '0x' })).toThrow()
  })

  it('wallet-action:approve-the-staked-token-for-a-stick resets a nonzero allowance that is not the amount first, then approves the exact amount', () => {
    const txs = steps(25_000_000n, 100_000_000n)
    expect(calls(txs)).toEqual([
      [A, 'approve', [B, 0n]],
      [A, 'approve', [B, 100_000_000n]],
    ])
    expect(txs.map(({ label }) => label)).toEqual(['Reset ART allowance', 'Approve 100 ART'])
  })

  it('plans nothing when the allowance is already the amount, as after an approval that landed before a reload', () => {
    expect(steps(100_000_000n, 100_000_000n)).toEqual([])
    expect(steps(0n, 0n)).toEqual([])
  })

  it('wallet-action:approve-the-staked-token-for-a-stick brings a larger allowance down to the amount, unless it is only asked to cover it', () => {
    expect(calls(steps(100_000_000n, 50_000_000n))).toEqual([
      [A, 'approve', [B, 0n]],
      [A, 'approve', [B, 50_000_000n]],
    ])
    expect(steps(100_000_000n, 50_000_000n, 'covering')).toEqual([])
    expect(steps(50_000_000n, 50_000_000n, 'covering')).toEqual([])
    // An allowance that falls short is brought to the amount in either mode.
    expect(calls(steps(25_000_000n, 50_000_000n, 'covering'))).toEqual(calls(steps(25_000_000n, 50_000_000n, 'exact')))
  })

  it('takes an allowance back with one step, not a reset and a second approval of zero', () => {
    const txs = steps(25_000_000n, 0n)
    expect(calls(txs)).toEqual([[A, 'approve', [B, 0n]]])
    expect(txs[0].label).toBe('Reset ART allowance')
  })

  it('names an unlimited approval as unlimited, and keeps every digit of any other', () => {
    expect(steps(0n, maxUint256)[0].label).toBe('Approve unlimited')
    expect(steps(0n, 1_000_001n)[0].label).toBe('Approve 1.000001 ART')
  })
})

describe('stickTx', () => {
  it('wallet-action:stick pays the project\'s terminal the staked token, for the beneficiary, with the quote as its minimum', () => {
    const tx = stickTx(info, B, 10_000_000n, 9_990_000_000_000_000_000n)
    expect(tx).toMatchObject({
      chainId: CHAIN,
      address: deployment.terminal,
      functionName: 'pay',
      // The project, the token, the amount, the beneficiary, the minimum, an empty memo and no metadata.
      args: [12n, A, 10_000_000n, B, 9_990_000_000_000_000_000n, '', '0x'],
      value: 0n,
      label: 'Stick',
    })
  })

  it('wallet-action:stick-for-someone-else names someone else as the beneficiary when a holder sticks for them', () => {
    expect(stickTx(info, C, 1n, 1n).args[3]).toBe(C)
  })

  it('is never built without a minimum, which would leave the stick unprotected', () => {
    expect(() => stickTx(info, B, 10_000_000n, 0n)).toThrow(/minimum/)
  })

  it('needs a Sticky deployment on the chain', () => {
    expect(() => stickTx({ ...info, chainId: 1_337 }, B, 1n, 1n)).toThrow('Sticky is not deployed on chain 1337.')
  })
})

describe('unstickTxs', () => {
  const adapter = deployment.autoStick
  const balance = 10n ** 18n
  const on = { enabled: true, minimum: 1_000_000n, cooldown: 86_400, personallyTrusted: true, allowance: 100n }

  it('wallet-action:unstick-sticky-tokens cashes the Sticky tokens out of the project\'s terminal to the holder, in the staked token, with the net as the minimum', () => {
    const txs = unstickTxs(info, B, balance, 1_950_000n)
    expect(txs).toHaveLength(1)
    expect(txs[0]).toMatchObject({
      chainId: CHAIN,
      address: deployment.terminal,
      functionName: 'cashOutTokensOf',
      args: [B, 12n, balance, A, 1_950_000n, B, '0x'],
      label: 'Unstick',
    })
  })

  it('says so when the tokens come back for nothing', () => {
    expect(unstickTxs(info, B, balance, 0n)[0].label).toBe('Unstick without reclaiming tokens')
  })

  it('wallet-action:turn-off-auto-stick wallet-action:take-back-the-auto-stick-adapter-s-trust wallet-action:take-back-the-auto-stick-adapter-s-allowance takes a full exit through the holder\'s auto-stick first: off, the adapter untrusted, and its allowance withdrawn', () => {
    const txs = unstickTxs(info, B, balance, 975_000n, { state: on, balance })
    expect(calls(txs)).toEqual([
      [adapter, 'setConfigFor', [12n, false, 1_000_000n, 86_400]],
      [deployment.hook, 'setTrustedSenderFor', [12n, adapter, false]],
      [A, 'approve', [adapter, 0n]],
      [deployment.terminal, 'cashOutTokensOf', [B, 12n, balance, A, 975_000n, B, '0x']],
    ])
    expect(txs.map(({ label }) => label)).toEqual([
      'Turn off auto-stick',
      'Stop the auto-stick contract from sticking ART for you',
      "Remove the auto-stick contract's ART allowance",
      'Unstick',
    ])
  })

  it('leaves auto-stick alone on a partial exit, and when it is off', () => {
    const cashOut = [[deployment.terminal, 'cashOutTokensOf', [B, 12n, balance / 2n, A, 1n, B, '0x']]]
    expect(calls(unstickTxs(info, B, balance / 2n, 1n, { state: on, balance }))).toEqual(cashOut)
    expect(calls(unstickTxs(info, B, balance / 2n, 1n, { state: { ...on, enabled: false }, balance: balance / 2n }))).toEqual(cashOut)
    expect(calls(unstickTxs(info, B, balance / 2n, 1n))).toEqual(cashOut)
  })

  it('takes back only what the holder gave: no trust step when the project granted the adapter, none for a spent allowance', () => {
    const txs = unstickTxs(info, B, balance, 1n, { state: { ...on, personallyTrusted: false, allowance: 0n }, balance })
    expect(txs.map(({ functionName }) => functionName)).toEqual(['setConfigFor', 'cashOutTokensOf'])
    const trusted = unstickTxs(info, B, balance, 1n, { state: { ...on, allowance: 0n }, balance })
    expect(trusted.map(({ functionName }) => functionName)).toEqual(['setConfigFor', 'setTrustedSenderFor', 'cashOutTokensOf'])
    const approved = unstickTxs(info, B, balance, 1n, { state: { ...on, personallyTrusted: false }, balance })
    expect(approved.map(({ functionName }) => functionName)).toEqual(['setConfigFor', 'approve', 'cashOutTokensOf'])
  })

  it('has the same teardown for turning auto-stick off on its own', () => {
    expect(calls(autoStickOffTxs(info, on))).toEqual(calls(unstickTxs(info, B, balance, 1n, { state: on, balance })).slice(0, 3))
  })

  it('wallet-action:take-back-the-auto-stick-adapter-s-trust wallet-action:take-back-the-auto-stick-adapter-s-allowance takes back what a holder left the adapter once it is off: its trust, its allowance, or both, and nothing to turn off', () => {
    const left = (personallyTrusted: boolean, allowance: bigint) => calls(autoStickLeftoverTxs(info, { personallyTrusted, allowance }))
    expect(left(true, 100n)).toEqual([
      [deployment.hook, 'setTrustedSenderFor', [12n, adapter, false]],
      [A, 'approve', [adapter, 0n]],
    ])
    expect(left(true, 0n)).toEqual([[deployment.hook, 'setTrustedSenderFor', [12n, adapter, false]]])
    expect(left(false, 1n)).toEqual([[A, 'approve', [adapter, 0n]]])
    expect(left(false, 0n)).toEqual([])
    // What a teardown takes back after turning the adapter off.
    expect(calls(autoStickOffTxs(info, on)).slice(1)).toEqual(left(true, 100n))
  })
})

describe('fundTxs', () => {
  const ART_POT = { stToken: C, token: A, amount: 5_000_000n, groupId: 4008n, allowance: 0n, ...ART }

  it('wallet-action:approve-a-reward-token-for-an-airdrop wallet-action:send-an-airdrop approves the distributor for exactly the amount of an ERC-20, then funds the group', () => {
    const txs = fundTxs(CHAIN, ART_POT)
    expect(calls(txs)).toEqual([
      [A, 'approve', [deployment.distributor, 5_000_000n]],
      [deployment.distributor, 'fund', [C, A, 5_000_000n, 4008n]],
    ])
    expect(txs.map(({ label }) => label)).toEqual(['Approve 5 ART', 'Fund stuck holders'])
    expect(txs[1]).toMatchObject({ chainId: CHAIN, abi: stickyDistributorAbi })
    expect(txs[1].value).toBeUndefined()
  })

  it('wallet-action:approve-a-reward-token-for-an-airdrop asks for no approval when the allowance covers the amount, and resets one that does not first', () => {
    expect(calls(fundTxs(CHAIN, { ...ART_POT, allowance: 5_000_000n }))).toEqual([
      [deployment.distributor, 'fund', [C, A, 5_000_000n, 4008n]],
    ])
    expect(calls(fundTxs(CHAIN, { ...ART_POT, allowance: 9_000_000n }))).toEqual([
      [deployment.distributor, 'fund', [C, A, 5_000_000n, 4008n]],
    ])
    expect(calls(fundTxs(CHAIN, { ...ART_POT, allowance: 1n })).map(([, name, args]) => [name, args])).toEqual([
      ['approve', [deployment.distributor, 0n]],
      ['approve', [deployment.distributor, 5_000_000n]],
      ['fund', [C, A, 5_000_000n, 4008n]],
    ])
  })

  it('wallet-action:send-an-airdrop native ETH reward funding attaches exact value and never approves a sentinel', () => {
    const txs = fundTxs(CHAIN, { ...ART_POT, token: NATIVE_TOKEN, amount: 1n, groupId: 0n, allowance: 0n, symbol: 'ETH', decimals: 18 })
    expect(calls(txs)).toEqual([[deployment.distributor, 'fund', [C, NATIVE_TOKEN, 1n, 0n]]])
    expect(txs[0].value).toBe(1n)
    // The value is the amount whatever case the native token is written in.
    expect(fundTxs(CHAIN, { ...ART_POT, token: NATIVE_TOKEN.toLowerCase() as typeof A, allowance: 0n })[0].value).toBe(5_000_000n)
  })

  it('refuses a group the distributor does not accept, and an amount of nothing', () => {
    expect(() => fundTxs(CHAIN, { ...ART_POT, groupId: 4n })).toThrow('the distributor does not accept this stake-age window')
    expect(() => fundTxs(CHAIN, { ...ART_POT, groupId: 8004n })).toThrow('the distributor does not accept this stake-age window')
    expect(() => fundTxs(CHAIN, { ...ART_POT, amount: 0n })).toThrow('enter an amount greater than zero')
  })

  it("encodes fund as cast did, the four-argument overload: ETH under JB's native token with its value, and an ERC-20", () => {
    const [eth, ...more] = fundTxs(CHAIN, { ...ART_POT, stToken: C, token: NATIVE_TOKEN, amount: 10n ** 18n, symbol: 'ETH', decimals: 18 })
    expect(more).toEqual([])
    expect(encoded(eth)).toBe(fixtures.fund)
    expect(eth.value).toBe(10n ** 18n)
    const erc20 = fundTxs(CHAIN, { ...ART_POT, stToken: C, token: A, amount: 10n ** 18n, allowance: 10n ** 18n }).at(-1)!
    expect(encoded(erc20)).toBe(fixtures.fundErc20)
    expect(erc20.value).toBeUndefined()
  })
})

describe('collectTx', () => {
  it('wallet-action:collect-rewards-or-start-vesting normal reward collection is one transaction because the distributor already starts vesting', () => {
    const tx = collectTx(CHAIN, { stToken: C, groupId: 4008n, holder: B, token: A, collectable: 1n })
    expect(tx).toMatchObject({
      chainId: CHAIN,
      address: deployment.distributor,
      abi: stickyDistributorAbi,
      functionName: 'collectVestedRewards',
      // The Sticky token, the group, the holder as the distributor's token ID, the reward token, and the holder again as
      // the beneficiary.
      args: [C, 4008n, [BigInt(B)], [A], B],
      label: 'Collect unlocked rewards',
    })
    expect(Object.isFrozen(tx.args[2])).toBe(true)
    expect(Object.isFrozen(tx.args[3])).toBe(true)
  })

  it('wallet-action:collect-rewards-or-start-vesting starts vesting with the same call when nothing has unlocked, and says so', () => {
    const tx = collectTx(CHAIN, { stToken: C, groupId: 0n, holder: B, token: A, collectable: 0n })
    expect(tx.functionName).toBe('collectVestedRewards')
    expect(tx.label).toBe('Start unlocking eligible rewards')
  })

  it('encodes collectVestedRewards as cast did, the five-argument overload', () => {
    expect(encoded(collectTx(CHAIN, { stToken: C, groupId: 0n, holder: B, token: A, collectable: 1n }))).toBe(
      fixtures.collectVestedRewards,
    )
  })
})

describe('claimAndStickTxs', () => {
  const adapter = deployment.autoStick
  const claim = { groupIds: [4000n, 4008n], collectable: 500n, allowance: 0n, canStick: false }

  it('wallet-action:approve-the-staked-token-for-a-claim-and-stick wallet-action:trust-the-auto-stick-adapter wallet-action:claim-and-stick-rewards claim-and-stick adds missing holder trust before the atomic claim', () => {
    const txs = claimAndStickTxs(info, claim)
    expect(calls(txs)).toEqual([
      [A, 'approve', [adapter, 500n]],
      [deployment.hook, 'setTrustedSenderFor', [12n, adapter, true]],
      [adapter, 'stickRewardsFor', [12n, [4000n, 4008n]]],
    ])
    expect(txs.map(({ label }) => label)).toEqual([
      'Allow the auto-stick contract to move this claim of 0.0005 ART',
      'Allow the auto-stick contract to stick ART for you',
      'Claim & stick',
    ])
    expect(txs[2]).toMatchObject({ abi: stickyAutoStickAbi })
    expect(Object.isFrozen(txs[2].args[1])).toBe(true)
  })

  it('wallet-action:claim-and-stick-rewards asks for no trust when the adapter can stick already, and no approval when the allowance covers the claim', () => {
    expect(calls(claimAndStickTxs(info, { ...claim, canStick: true, allowance: 500n }))).toEqual([
      [adapter, 'stickRewardsFor', [12n, [4000n, 4008n]]],
    ])
    expect(calls(claimAndStickTxs(info, { ...claim, canStick: true, allowance: 10n ** 30n }))).toEqual([
      [adapter, 'stickRewardsFor', [12n, [4000n, 4008n]]],
    ])
  })

  it('wallet-action:approve-the-staked-token-for-a-claim-and-stick resets an allowance that falls short before approving the claim', () => {
    expect(calls(claimAndStickTxs(info, { ...claim, canStick: true, allowance: 7n })).map(([, name, args]) => [name, args])).toEqual([
      ['approve', [adapter, 0n]],
      ['approve', [adapter, 500n]],
      ['stickRewardsFor', [12n, [4000n, 4008n]]],
    ])
  })

  it('refuses a claim of nothing', () => {
    expect(() => claimAndStickTxs(info, { ...claim, collectable: 0n })).toThrow(
      'nothing is claimable yet. Rewards unlock a round after you collect them',
    )
  })

  it('encodes stickRewardsFor as cast did', () => {
    const txs = claimAndStickTxs(info, { groupIds: [0n], collectable: 1n, allowance: 1n, canStick: true })
    expect(encoded(txs.at(-1)!)).toBe(fixtures.stickRewardsFor)
  })
})

describe('auto-stick', () => {
  const adapter = deployment.autoStick
  const DAY = 86_400
  const WEEK = 604_800
  /** Auto-stick off and never set up, the holder trusting nothing and having approved nothing. */
  const fresh = { enabled: false, minimum: 0n, cooldown: 0, allowance: 0n, projectGranter: false, personallyTrusted: false }
  const settings = { minimum: 2_000_000n, cooldown: DAY, cap: maxUint256 }

  it('auto-stick configuration validates contract-width bounds', () => {
    const on = (minimum: bigint, cooldown: number) => autoStickSettingsTx(info, { enabled: true }, { minimum, cooldown })
    expect(() => on(0n, DAY)).toThrow('the auto-stick minimum must fit in uint128 and be greater than zero')
    expect(() => on(1n << 128n, DAY)).toThrow('the auto-stick minimum must fit in uint128 and be greater than zero')
    expect(on((1n << 128n) - 1n, DAY).args).toEqual([12n, true, (1n << 128n) - 1n, DAY])
    // A cooldown of nothing, or of a day past the adapter's 30 days, and one below a day.
    expect(() => on(1n, 0)).toThrow('auto-stick cooldown must be between 1 and 30 days')
    expect(() => on(1n, 31 * DAY)).toThrow('auto-stick cooldown must be between 1 and 30 days')
    expect(() => on(1n, 60)).toThrow('auto-stick cooldown must be between 1 and 30 days')
    expect(on(1n, 30 * DAY).args[3]).toBe(30 * DAY)
    expect(() => autoStickOnTxs(info, fresh, { ...settings, cooldown: 31 * DAY })).toThrow('between 1 and 30 days')
    expect(() => autoStickOnTxs(info, fresh, { ...settings, minimum: 0n })).toThrow('greater than zero')
  })

  it('wallet-action:approve-the-auto-stick-adapter-s-allowance wallet-action:trust-the-auto-stick-adapter wallet-action:turn-on-auto-stick turns it on: the allowance, the trust, and the settings last', () => {
    const txs = autoStickOnTxs(info, fresh, settings)
    expect(calls(txs)).toEqual([
      [A, 'approve', [adapter, maxUint256]],
      [deployment.hook, 'setTrustedSenderFor', [12n, adapter, true]],
      [adapter, 'setConfigFor', [12n, true, 2_000_000n, DAY]],
    ])
    expect(txs.map(({ label }) => label)).toEqual([
      'Allow the auto-stick contract to move eligible ART rewards',
      'Allow the auto-stick contract to stick ART for you',
      'Turn on auto-stick',
    ])
  })

  it('wallet-action:turn-off-auto-stick wallet-action:approve-the-auto-stick-adapter-s-allowance wallet-action:turn-on-auto-stick auto-stick renewal disables old settings before increasing allowance, then enables new settings last', () => {
    const on = { ...fresh, enabled: true, minimum: 1_000_000n, cooldown: WEEK, allowance: 3_000_000n, personallyTrusted: true }
    const txs = autoStickOnTxs(info, on, { ...settings, cap: 50_000_000n })
    expect(calls(txs)).toEqual([
      // The old settings, which the adapter keeps, with the adapter turned off.
      [adapter, 'setConfigFor', [12n, false, 1_000_000n, WEEK]],
      [A, 'approve', [adapter, 0n]],
      [A, 'approve', [adapter, 50_000_000n]],
      [adapter, 'setConfigFor', [12n, true, 2_000_000n, DAY]],
    ])
    expect(txs[0].label).toBe('Turn off auto-stick')
  })

  it('asks for no approval when the allowance already is the cap, and no trust when the project granted the adapter', () => {
    const granted = { ...fresh, allowance: maxUint256, projectGranter: true }
    expect(calls(autoStickOnTxs(info, granted, settings))).toEqual([[adapter, 'setConfigFor', [12n, true, 2_000_000n, DAY]]])
    // An exact cap brings a larger allowance down to it.
    expect(calls(autoStickOnTxs(info, granted, { ...settings, cap: 5n })).map(([, name, args]) => [name, args])).toEqual([
      ['approve', [adapter, 0n]],
      ['approve', [adapter, 5n]],
      ['setConfigFor', [12n, true, 2_000_000n, DAY]],
    ])
  })

  it('refuses an allowance cap of nothing', () => {
    expect(() => autoStickOnTxs(info, fresh, { ...settings, cap: 0n })).toThrow('set an allowance cap, or choose unlimited')
  })

  it('wallet-action:change-auto-stick-settings changes the settings of an auto-stick that is on with one call, and refuses one that is off', () => {
    const txs = [autoStickSettingsTx(info, { enabled: true }, { minimum: 7n, cooldown: WEEK })]
    expect(calls(txs)).toEqual([[adapter, 'setConfigFor', [12n, true, 7n, WEEK]]])
    expect(txs[0].label).toBe('Save auto-stick settings')
    expect(() => autoStickSettingsTx(info, { enabled: false }, { minimum: 7n, cooldown: WEEK })).toThrow(
      'auto-stick is off. Turn it on to change its settings',
    )
  })

  it('wallet-action:trust-the-auto-stick-adapter repairs a permission that was taken back, and refuses one that stands', () => {
    expect(calls(repairTxs(info, { projectGranter: false, personallyTrusted: false }))).toEqual([
      [deployment.hook, 'setTrustedSenderFor', [12n, adapter, true]],
    ])
    expect(() => repairTxs(info, { projectGranter: false, personallyTrusted: true })).toThrow('auto-stick permission is already enabled')
    expect(() => repairTxs(info, { projectGranter: true, personallyTrusted: false })).toThrow('auto-stick permission is already enabled')
  })

  it('wallet-action:stick-ready-rewards-now sticks the ready rewards of the groups holding them, for the holder', () => {
    const tx = compoundTx(info, B, [0n, 4000n])
    expect(tx).toMatchObject({ address: adapter, abi: stickyAutoStickAbi, functionName: 'compoundFor', args: [12n, B, [0n, 4000n]] })
    expect(tx.label).toBe('Stick ready rewards now')
    expect(Object.isFrozen(tx.args[2])).toBe(true)
    expect(encoded(compoundTx(info, B, [0n, 4000n]))).toBe(fixtures.compoundFor)
  })

  it('wallet-action:start-unlocking-rewards starts unlocking the finished rounds of the groups holding them, for the holder', () => {
    const tx = beginVestingTx(info, B, [4008n])
    expect(tx).toMatchObject({ address: adapter, abi: stickyAutoStickAbi, functionName: 'beginVestingFor', args: [12n, B, [4008n]] })
    expect(tx.label).toBe('Start unlocking')
    expect(encoded(tx)).toBe(fixtures.beginVestingFor)
  })

  it('encodes setConfigFor as cast did', () => {
    expect(encoded(autoStickSettingsTx(info, { enabled: true }, { minimum: 1_000_000n, cooldown: WEEK }))).toBe(fixtures.setConfigFor)
  })
})

describe('reward addresses', () => {
  const factory = deployment.rewardReceiverFactory

  it('wallet-action:create-a-reward-address creates the receiver of a Sticky token\'s group at the factory', () => {
    const tx = createReceiverTx(CHAIN, { stToken: C, groupId: 4000n })
    expect(tx).toMatchObject({
      chainId: CHAIN,
      address: factory,
      abi: stickyRewardReceiverFactoryAbi,
      functionName: 'deployReceiverFor',
      args: [C, 4000n],
      label: 'Create reward address',
    })
    expect(encoded(tx)).toBe(fixtures.deployReceiverFor)
  })

  it('wallet-action:settle-arrivals-into-airdrops settles the ERC-20 a reward address holds into its group\'s airdrops', () => {
    const tx = settleTx(CHAIN, { stToken: C, groupId: 1004n, token: A })
    expect(tx).toMatchObject({
      address: factory,
      abi: stickyRewardReceiverFactoryAbi,
      functionName: 'settleFor',
      args: [C, 1004n, A],
      label: 'Settle arrivals',
    })
    expect(encoded(tx)).toBe(fixtures.settleFor)
  })

  it('receivers reject native ETH rather than falsely describing an ERC20 settlement', () => {
    expect(() => settleTx(CHAIN, { stToken: C, groupId: 0n, token: NATIVE_TOKEN })).toThrow(
      'reward receivers settle ERC-20 tokens. Fund ETH rewards directly',
    )
  })

  it('refuses a group the factory does not accept', () => {
    expect(() => createReceiverTx(CHAIN, { stToken: C, groupId: 4n })).toThrow('this stake-age window is not valid')
    expect(() => settleTx(CHAIN, { stToken: C, groupId: 8004n, token: A })).toThrow('this stake-age window is not valid')
  })
})

describe('transferTx', () => {
  it('wallet-action:transfer-sticky-tokens moves Sticky tokens, of 18 decimals, to the recipient', () => {
    const tx = transferTx(info, B, 1_000_000_000_000_000_001n)
    expect(tx).toMatchObject({
      chainId: CHAIN,
      address: C,
      functionName: 'transfer',
      args: [B, 1_000_000_000_000_000_001n],
      label: 'Transfer 1.000000000000000001 STICKYART',
    })
  })
})

describe('trustTx', () => {
  it('wallet-action:trust-or-untrust-a-sender trusts a sender to stick for the holder in a project, or takes that back', () => {
    expect(trustTx(CHAIN, 12n, B, true)).toMatchObject({
      chainId: CHAIN,
      address: deployment.hook,
      abi: stickyHookAbi,
      functionName: 'setTrustedSenderFor',
      args: [12n, B, true],
      label: 'Trust sender',
    })
    expect(trustTx(CHAIN, 12n, B, false)).toMatchObject({ args: [12n, B, false], label: 'Untrust sender' })
  })
})

describe('what a builder returns', () => {
  it('names the chain, the project and the amounts it was built for, and cannot be changed afterwards', () => {
    const project = { ...info }
    const txs = [
      ...approveSteps(CHAIN, A, B, 1n, 9n, { ...ART, mode: 'exact' }),
      stickTx(project, B, 9n, 1n),
      ...unstickTxs(project, B, 9n, 1n),
      ...autoStickOffTxs(project, { minimum: 1n, cooldown: 86_400, personallyTrusted: true, allowance: 1n }),
      ...fundTxs(CHAIN, { stToken: C, token: A, amount: 9n, groupId: 0n, allowance: 1n, ...ART }),
      collectTx(CHAIN, { stToken: C, groupId: 0n, holder: B, token: A, collectable: 1n }),
      ...autoStickOnTxs(project, { enabled: true, minimum: 1n, cooldown: 86_400, allowance: 0n, projectGranter: false, personallyTrusted: false }, { minimum: 1n, cooldown: 86_400, cap: 9n }),
      ...repairTxs(project, { projectGranter: false, personallyTrusted: false }),
      compoundTx(project, B, [0n]),
      beginVestingTx(project, B, [0n]),
      createReceiverTx(CHAIN, { stToken: C, groupId: 0n }),
      settleTx(CHAIN, { stToken: C, groupId: 0n, token: A }),
      ...claimAndStickTxs(project, { groupIds: [0n], collectable: 9n, allowance: 1n, canStick: false }),
      transferTx(project, B, 9n),
      trustTx(CHAIN, 12n, B, true),
    ]
    // The project on the page moves on while a review is open.
    project.chainId = 1
    project.projectId = 99n
    for (const tx of txs) {
      expect(tx.chainId).toBe(CHAIN)
      expect(Object.isFrozen(tx)).toBe(true)
      expect(Object.isFrozen(tx.args)).toBe(true)
      expect(() => {
        ;(tx.args as unknown[])[0] = 0n
      }).toThrow(TypeError)
    }
    expect(txs.find(tx => tx.functionName === 'pay')!.args[0]).toBe(12n)
    expect(txs.find(tx => tx.functionName === 'cashOutTokensOf')!.args[1]).toBe(12n)
  })
})
