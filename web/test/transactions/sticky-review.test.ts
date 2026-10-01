// @vitest-environment jsdom

/**
 * Every write Sticky sends, as the review dialog shows it before the wallet does: the decoded call, never the
 * "ABI is not available" fallback, with Sticky's contracts named by the SDK's address table, which carries Sticky's
 * deployment records (`test/sticky-addresses.test.ts` holds the two together). The writes are the old client's
 * (`webclient/calldata.js`, its `ABIS` less the unused `beginVesting`), each held to the old client's selector.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, erc20Abi, pad, parseAbi, zeroHash, type Abi, type Address, type Hex } from 'viem'
import { jbMultiTerminalAbi } from '@bananapus/nana-sdk-core'
import { jbSuckerV6Abi, stickyGroupId } from '@bananapus/nana-sdk-core/v6'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', chainId: 84532 }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'asset' }),
}))
// A stick and an unstick pay protocol fees, so their reviews check the fee return. That check reads the chain; here
// it has no chain to read, and the notice says automatic checks are unavailable.
vi.mock('@/lib/fee-buyback-client', () => ({
  feeBuybackContext: () => {
    throw new Error('Unsupported chain')
  },
}))
import { describeSplitGroups } from '@bananapus/nana-sdk-core/review/decode'
import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import {
  stickyAutoStickAbi,
  stickyDeployerAbi,
  stickyDistributorAbi,
  stickyHookAbi,
  stickyRewardReceiverFactoryAbi,
} from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import {
  requestContractTransactionReview,
  type ContractTransactionReviewCall,
} from '@/lib/transaction-review'

const CHAIN = 84532
const sticky = stickyDeployment(CHAIN)!
const HOLDER: Address = '0x1111111111111111111111111111111111111111'
const TOKEN: Address = '0x2222222222222222222222222222222222222222'
const ST: Address = '0x3333333333333333333333333333333333333333'
const RELAYR: Address = '0x4444444444444444444444444444444444444444'
const SUCKER: Address = '0x5555555555555555555555555555555555555555'
const GRANTER: Address = '0x6666666666666666666666666666666666666666'
const SENDER: Address = '0xabc0000000000000000000000000000000000abc'
const BUNDLE: Hex = '0x0123456789abcdef0123456789abcdef'
const ONE = 10n ** 18n
// Relayr's payment contract. Nothing in the SDK carries its ABI yet; the launch flow (Phase 5) will.
const relayrPaymentAbi = parseAbi(['function prepayment(bytes16 bundle, uint40 deadline) payable'])

type Write = {
  selector: Hex
  call: ContractTransactionReviewCall
  /** An argument of the call, and text its row shows. */
  row: [name: string, text: string]
  /** The destination's name, when the dialog knows it. */
  destination?: string
}

function write(
  selector: Hex,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  row: Write['row'],
  { value, destination }: { value?: bigint; destination?: string } = {},
): Write {
  return {
    selector,
    call: { chainId: CHAIN, address, abi, functionName, args, account: HOLDER, ...(value ? { value } : {}) },
    row,
    destination,
  }
}

const WRITES: Record<string, Write> = {
  approve: write('0x095ea7b3', TOKEN, erc20Abi, 'approve', [sticky.terminal, 5n * ONE], [
    'spender',
    `JBMultiTerminal | ${sticky.terminal}`,
  ]),
  transfer: write('0xa9059cbb', ST, erc20Abi, 'transfer', [GRANTER, ONE], ['recipient', GRANTER]),
  deployStickyFor: write(
    '0x00d5ce37',
    sticky.deployer,
    stickyDeployerAbi,
    'deployStickyFor',
    [TOKEN, 'Sticky Banny', 'STBANNY', 'data:application/json,{}', 500n, [GRANTER], false],
    ['symbol', 'STBANNY'],
    { destination: 'StickyDeployer' },
  ),
  pay: write(
    '0xfef43257',
    sticky.terminal,
    jbMultiTerminalAbi,
    'pay',
    [23n, TOKEN, 5n * ONE, HOLDER, 4n * ONE, '', '0x'],
    ['beneficiary', HOLDER],
    { destination: 'JBMultiTerminal' },
  ),
  cashOutTokensOf: write(
    '0x13da8317',
    sticky.terminal,
    jbMultiTerminalAbi,
    'cashOutTokensOf',
    [HOLDER, 23n, ONE, TOKEN, 9n * 10n ** 17n, HOLDER, '0x'],
    ['tokenToReclaim', TOKEN],
    { destination: 'JBMultiTerminal' },
  ),
  fund: write(
    '0x77531866',
    sticky.distributor,
    stickyDistributorAbi,
    'fund',
    [ST, TOKEN, ONE, stickyGroupId({ minWeeks: 4 })],
    ['groupId', '4000'],
    { destination: 'StickyDistributor' },
  ),
  collectVestedRewards: write(
    '0x4d355ce6',
    sticky.distributor,
    stickyDistributorAbi,
    'collectVestedRewards',
    [ST, 0n, [BigInt(HOLDER)], [TOKEN], HOLDER],
    ['beneficiary', HOLDER],
    { destination: 'StickyDistributor' },
  ),
  setConfigFor: write(
    '0x415174c8',
    sticky.autoStick,
    stickyAutoStickAbi,
    'setConfigFor',
    [23n, true, ONE, 604_800],
    ['enabled', 'true'],
    { destination: 'StickyAutoStick' },
  ),
  compoundFor: write(
    '0x8244fb99',
    sticky.autoStick,
    stickyAutoStickAbi,
    'compoundFor',
    [23n, HOLDER, [0n, 4052n]],
    ['groupIds', '4052'],
    { destination: 'StickyAutoStick' },
  ),
  stickRewardsFor: write(
    '0x40b5a05d',
    sticky.autoStick,
    stickyAutoStickAbi,
    'stickRewardsFor',
    [23n, [4000n]],
    ['groupIds', '4000'],
    { destination: 'StickyAutoStick' },
  ),
  beginVestingFor: write(
    '0xa15557e8',
    sticky.autoStick,
    stickyAutoStickAbi,
    'beginVestingFor',
    [23n, HOLDER, [0n]],
    ['holder', HOLDER],
    { destination: 'StickyAutoStick' },
  ),
  setTrustedSenderFor: write(
    '0x3a799596',
    sticky.hook,
    stickyHookAbi,
    'setTrustedSenderFor',
    [23n, SENDER, true],
    ['sender', SENDER],
    { destination: 'StickyHook' },
  ),
  settleFor: write(
    '0xa4b4e8bf',
    sticky.rewardReceiverFactory,
    stickyRewardReceiverFactoryAbi,
    'settleFor',
    [ST, 4000n, TOKEN],
    ['groupId', '4000'],
    { destination: 'StickyRewardReceiverFactory' },
  ),
  deployReceiverFor: write(
    '0x18d82376',
    sticky.rewardReceiverFactory,
    stickyRewardReceiverFactoryAbi,
    'deployReceiverFor',
    [ST, 0n],
    ['stickyToken', ST],
    { destination: 'StickyRewardReceiverFactory' },
  ),
  prepayment: write('0x103903a7', RELAYR, relayrPaymentAbi, 'prepayment', [BUNDLE, 1_900_000_000], ['bundle', BUNDLE], {
    value: 10n ** 15n,
  }),
  prepare: write(
    '0xaf629bbb',
    SUCKER,
    jbSuckerV6Abi,
    'prepare',
    [ONE, pad(HOLDER), 0n, TOKEN, zeroHash],
    ['token', TOKEN],
  ),
  toRemote: write('0xb71c1179', SUCKER, jbSuckerV6Abi, 'toRemote', [TOKEN], ['token', TOKEN], { value: 10n ** 15n }),
  claim: write(
    '0xcbb2adce',
    SUCKER,
    jbSuckerV6Abi,
    'claim',
    [
      {
        token: TOKEN,
        leaf: { index: 3n, beneficiary: pad(HOLDER), projectTokenCount: ONE, terminalTokenAmount: ONE, metadata: zeroHash },
        proof: Array.from({ length: 32 }, () => zeroHash),
      },
    ],
    ['claimData', `Beneficiary:${HOLDER}`],
  ),
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

/** Opens the review of `call` and returns its dialog. */
async function review(call: ContractTransactionReviewCall) {
  await act(async () => root.render(createElement(TransactionReviewProvider, null, null)))
  await act(async () => {
    requestContractTransactionReview(call, { label: 'Sticky write' }).catch(() => {})
  })
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  return document.querySelector('dialog')!
}

/** The text of the argument called `name`: its row, or its decoded view. */
function argument(dialog: Element, name: string): string {
  const block = [...dialog.querySelectorAll('div.bg-grey-25')].find(
    element => element.querySelector('p')?.firstChild?.textContent === name,
  )
  expect(block, `no ${name} argument`).toBeDefined()
  return block!.textContent ?? ''
}

describe('the review of every write Sticky sends', () => {
  it('covers the old client’s eighteen writes', () => {
    expect(Object.keys(WRITES)).toHaveLength(18)
    for (const { selector, call } of Object.values(WRITES)) {
      const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args })
      expect(data.slice(0, 10)).toBe(selector)
    }
  })

  it.each(Object.entries(WRITES))('shows %s decoded, with its arguments', async (functionName, { call, row, destination }) => {
    const dialog = await review(call)
    const text = dialog.textContent ?? ''
    expect(text).toContain('Contract function')
    expect(text).toContain(`${functionName}(`)
    expect(text).not.toContain('ABI is not available')
    // Sticky's copy has no dot separators: a decoded view is named "tuple, decoded", as Homerun's dialog does.
    expect(text).not.toContain('·')
    expect(argument(dialog, row[0])).toContain(row[1])
    if (destination) expect(text).toContain(`Destination | ${destination}`)
  })

  it('decodes a split group that pays Sticky holders, never as a project', () => {
    const steps = describeSplitGroups(CHAIN, [
      {
        groupId: 1n,
        splits: [
          { percent: 250_000_000, projectId: 4052n, beneficiary: ST, preferAddToBalance: false, lockedUntil: 0, hook: sticky.distributor },
        ],
      },
    ])!
    const text = steps.flatMap(step => step.rows.map(row => row.join('='))).join('\n')
    expect(text).toContain(`Sticky holders stuck 4 to 52 weeks → Sticky token ${ST}`)
    expect(text).not.toContain('project #4052')
  })
})
