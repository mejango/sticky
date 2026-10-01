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
  autoStickOffTxs,
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

  it('resets a nonzero allowance that is not the amount first, then approves the exact amount', () => {
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

  it('brings a larger allowance down to the amount, unless it is only asked to cover it', () => {
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
  it('pays the project\'s terminal the staked token, for the beneficiary, with the quote as its minimum', () => {
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

  it('names someone else as the beneficiary when a holder sticks for them', () => {
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

  it('cashes the Sticky tokens out of the project\'s terminal to the holder, in the staked token, with the net as the minimum', () => {
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

  it('takes a full exit through the holder\'s auto-stick first: off, the adapter untrusted, and its allowance withdrawn', () => {
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
})

describe('transferTx', () => {
  it('moves Sticky tokens, of 18 decimals, to the recipient', () => {
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
  it('trusts a sender to stick for the holder in a project, or takes that back', () => {
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
