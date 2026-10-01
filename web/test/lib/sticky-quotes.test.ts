// @vitest-environment node

import { getAddress, zeroAddress, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { feelessAddressesAbi, stickyHookAbi, terminalAbi } from '@/lib/sticky-abis'
import { stickTx, unstickTxs } from '@/lib/sticky-builders'
import {
  CHAIN,
  HEAD,
  HOLDER,
  OTHER,
  PROJECT,
  REVERT,
  STAKED,
  blockHex,
  deployment,
  returning,
  rewardChain,
  shape,
} from './sticky-reward-fixtures'

// What a stick mints and what an unstick pays, asked of the terminal through the real Center reader against a fake
// Center (sticky-reward-fixtures.ts): only the HTTP call is faked, so what viem sends and batches is what is tested.

async function load() {
  vi.resetModules()
  return import('@/lib/sticky-quotes')
}

const TERMINAL = deployment.terminal
const HOOK = deployment.hook
const FEELESS = getAddress(`0x${'f'.repeat(40)}`)
type Chain = ReturnType<typeof rewardChain>

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const RULESET = {
  cycleNumber: 1,
  id: 1,
  basedOnId: 0,
  start: 0,
  duration: 0,
  weight: 0n,
  weightCutPercent: 0,
  approvalHook: zeroAddress,
  metadata: 0n,
}
/** The one callback a Sticky project's hook asks of every pay: itself, with nothing forwarded. */
const STICKY_HOOK = { hook: HOOK, noop: false, amount: 0n, metadata: '0x1234' as Hex }

const preview = (count: bigint, hooks: unknown[] = [STICKY_HOOK], reserved = 0n) => [RULESET, count, reserved, hooks]
const uint = (value: bigint | number) => BigInt(value).toString(16).padStart(64, '0')
/** An answer as the words it is made of: the nine of the ruleset, two amounts, the hook list's offset and its length. */
const words = (amount: bigint, second: bigint, offset: bigint, hooks: bigint): Hex =>
  `0x${[...Array(9).fill(0), amount, second, offset, hooks].map(uint).join('')}`

describe('quoteStick', () => {
  it('asks the terminal what the payer would mint for the beneficiary, as the payer, and gives the count', async () => {
    const chain = rewardChain()
    chain.stock(TERMINAL, terminalAbi, 'previewPayFor', preview(777n))
    const { quoteStick } = await load()

    expect(await quoteStick(CHAIN, PROJECT, STAKED, 12_345n, HOLDER, OTHER)).toBe(777n)

    // One request of its own: a read that names a sender cannot share Multicall3, whose sender it would be.
    expect(chain.requests).toEqual([
      {
        method: 'eth_call',
        block: 'latest',
        from: HOLDER,
        reads: [{ target: TERMINAL, functionName: 'previewPayFor', args: [PROJECT, STAKED, 12_345n, OTHER, '0x'] }],
      },
    ])
  })

  it('takes a visitor without a wallet as the zero address', async () => {
    const chain = rewardChain()
    chain.stock(TERMINAL, terminalAbi, 'previewPayFor', preview(5n))
    const { quoteStick } = await load()
    expect(await quoteStick(CHAIN, PROJECT, STAKED, 1n, zeroAddress, zeroAddress)).toBe(5n)
    expect(chain.requests[0].from).toBe(zeroAddress)
  })

  it('takes the Sticky hook\'s own callback, and a preview with none', async () => {
    const chain = rewardChain()
    const { quoteStick } = await load()
    chain.stock(TERMINAL, terminalAbi, 'previewPayFor', preview(9n, [STICKY_HOOK]))
    expect(await quoteStick(CHAIN, PROJECT, STAKED, 1n, HOLDER, HOLDER)).toBe(9n)
    chain.stock(TERMINAL, terminalAbi, 'previewPayFor', preview(9n, []))
    expect(await quoteStick(CHAIN, PROJECT, STAKED, 1n, HOLDER, HOLDER)).toBe(9n)
  })

  it('refuses an amount that mints nothing', async () => {
    const chain = rewardChain()
    chain.stock(TERMINAL, terminalAbi, 'previewPayFor', preview(0n))
    const { quoteStick } = await load()
    await expect(quoteStick(CHAIN, PROJECT, STAKED, 1n, HOLDER, HOLDER)).rejects.toThrow(/too small/)
  })

  it.each([
    ['nothing', returning('0x')],
    ['one word', returning(`0x${uint(1)}`)],
    ['reserved tokens', returning(words(1n, 1n, 384n, 0n))],
    ['a ruleset that is not nine words', returning(words(1n, 0n, 32n, 0n))],
    ['half a word over', returning(`${words(1n, 0n, 384n, 0n)}00`)],
  ])('refuses an answer of %s as no quote', async (_what, answer) => {
    const chain = rewardChain()
    chain.stock(TERMINAL, terminalAbi, 'previewPayFor', answer)
    const { quoteStick } = await load()
    await expect(quoteStick(CHAIN, PROJECT, STAKED, 1n, HOLDER, HOLDER)).rejects.toThrow(/valid Sticky mint quote/)
  })

  it('takes a preview that reverts, or that Center refuses, for what it is, and never for a count of nothing', async () => {
    const { quoteStick } = await load()
    const reverting = rewardChain()
    reverting.stock(TERMINAL, terminalAbi, 'previewPayFor', REVERT)
    await expect(quoteStick(CHAIN, PROJECT, STAKED, 1n, HOLDER, OTHER)).rejects.toMatchObject({
      message: "the terminal's stick preview could not be read.",
      cause: expect.any(Error),
    })

    const busy = rewardChain()
    busy.stock(TERMINAL, terminalAbi, 'previewPayFor', preview(1n))
    busy.lose(() => true)
    await expect(quoteStick(CHAIN, PROJECT, STAKED, 1n, HOLDER, OTHER)).rejects.toThrow(/could not be read/)
  })

  it('stops with the reason of a signal that aborts', async () => {
    const chain = rewardChain()
    chain.stock(TERMINAL, terminalAbi, 'previewPayFor', preview(1n))
    const { quoteStick } = await load()
    const controller = new AbortController()
    controller.abort(new Error('the page moved on'))
    await expect(quoteStick(CHAIN, PROJECT, STAKED, 1n, HOLDER, HOLDER, { signal: controller.signal })).rejects.toThrow(
      'the page moved on',
    )
  })
})

describe('assertCanStickFor', () => {
  function stockTrust(chain: Chain, { granter, trusted }: { granter: boolean; trusted: boolean }) {
    chain.stock(HOOK, stickyHookAbi, 'isGranterOf', granter)
    chain.stock(HOOK, stickyHookAbi, 'isTrustedSenderOf', trusted)
  }

  it('asks nothing of a holder who sticks for themselves', async () => {
    const chain = rewardChain()
    const { assertCanStickFor } = await load()
    await assertCanStickFor(CHAIN, PROJECT, HOLDER, HOLDER)
    expect(chain.requests).toEqual([])
  })

  it('wallet-action:stick-for-someone-else lets a granter of the project stick for anyone, and a sender the beneficiary trusts stick for them', async () => {
    const { assertCanStickFor } = await load()
    for (const { granter, trusted } of [
      { granter: true, trusted: false },
      { granter: false, trusted: true },
    ]) {
      const chain = rewardChain()
      stockTrust(chain, { granter, trusted })
      await expect(assertCanStickFor(CHAIN, PROJECT, HOLDER, OTHER)).resolves.toBeUndefined()
      // Both in one request: whether the sender is a granter, and whether the beneficiary trusts the sender.
      expect(chain.reads().map(read => [read.functionName, read.args])).toEqual([
        ['isGranterOf', [PROJECT, HOLDER]],
        ['isTrustedSenderOf', [PROJECT, OTHER, HOLDER]],
      ])
      expect(shape(chain.requests)).toEqual([['eth_call', 'latest', 2]])
    }
  })

  it('refuses a sender that is neither', async () => {
    const chain = rewardChain()
    stockTrust(chain, { granter: false, trusted: false })
    const { assertCanStickFor } = await load()
    await expect(assertCanStickFor(CHAIN, PROJECT, HOLDER, OTHER)).rejects.toThrow(
      'this holder must trust your address before you can stick for them',
    )
  })

  it('does not take a read that failed for a refusal, or for a yes', async () => {
    const chain = rewardChain()
    chain.stock(HOOK, stickyHookAbi, 'isGranterOf', false)
    chain.stock(HOOK, stickyHookAbi, 'isTrustedSenderOf', REVERT)
    const { assertCanStickFor } = await load()
    await expect(assertCanStickFor(CHAIN, PROJECT, HOLDER, OTHER)).rejects.toThrow(/could not be read/)
  })
})

describe('quoteUnstick', () => {
  const stockTerminal = (chain: Chain, { gross, tax, feeFree = 0n, feeless = false }: { gross: bigint; tax: bigint; feeFree?: bigint; feeless?: boolean }) => {
    chain.stock(TERMINAL, terminalAbi, 'previewCashOutFrom', [RULESET, gross, tax, []])
    chain.stock(TERMINAL, terminalAbi, 'feeFreeSurplusOf', feeFree)
    chain.stock(TERMINAL, terminalAbi, 'FEELESS_ADDRESSES', FEELESS)
    chain.stock(FEELESS, feelessAddressesAbi, 'isFeelessFor', feeless)
  }
  const quote = async (count = 10n ** 18n) => {
    const { quoteUnstick } = await load()
    return quoteUnstick(CHAIN, PROJECT, STAKED, HOLDER, count)
  }

  it('reads the terminal\'s views at one block, the preview as the holder, and applies the terminal\'s fee rule', async () => {
    const chain = rewardChain()
    stockTerminal(chain, { gross: 1_000_000n, tax: 1_000n })

    // A positive tax puts the fee on the whole reclaim, floored as the terminal floors it.
    expect(await quote()).toEqual({ gross: 1_000_000n, tax: 1_000n, fee: 25_000n, net: 975_000n, feeless: false, blockNumber: HEAD })

    const [head, ...reads] = shape(chain.requests)
    expect(head).toEqual(['eth_blockNumber', undefined, undefined])
    // The preview, and the fee-free surplus with the registry's address, then whether the holder is feeless there.
    expect(reads).toHaveLength(3)
    expect(reads.slice(0, 2)).toEqual(expect.arrayContaining([['eth_call', blockHex, 1], ['eth_call', blockHex, 2]]))
    expect(reads[2]).toEqual(['eth_call', blockHex, 1])
    const asked = chain.requests.filter(request => request.from !== undefined)
    expect(asked).toHaveLength(1)
    expect(asked[0].from).toBe(HOLDER)
    expect(asked[0].reads![0]).toEqual({
      target: TERMINAL,
      functionName: 'previewCashOutFrom',
      args: [HOLDER, PROJECT, 10n ** 18n, STAKED, HOLDER, '0x'],
    })
    expect(chain.reads().map(read => [read.target, read.functionName, read.args])).toEqual(
      expect.arrayContaining([
        [TERMINAL, 'feeFreeSurplusOf', [PROJECT, STAKED]],
        [TERMINAL, 'FEELESS_ADDRESSES', []],
        [FEELESS, 'isFeelessFor', [HOLDER, PROJECT, HOLDER]],
      ]),
    )
  })

  it('charges a zero tax the fee only on the part the fee-free surplus covers', async () => {
    const partly = rewardChain()
    stockTerminal(partly, { gross: 1_000_000n, tax: 0n, feeFree: 400_000n })
    expect(await quote()).toMatchObject({ fee: 10_000n, net: 990_000n })
    const fully = rewardChain()
    stockTerminal(fully, { gross: 1_000_000n, tax: 0n, feeFree: 0n })
    expect(await quote()).toMatchObject({ fee: 0n, net: 1_000_000n })
  })

  it('charges a feeless holder nothing', async () => {
    const chain = rewardChain()
    stockTerminal(chain, { gross: 1_000_000n, tax: 1_000n, feeless: true })
    expect(await quote()).toMatchObject({ fee: 0n, net: 1_000_000n, feeless: true })
  })

  it('reads a full bonus as a quote of nothing', async () => {
    const chain = rewardChain()
    stockTerminal(chain, { gross: 0n, tax: 10_000n })
    expect(await quote()).toMatchObject({ gross: 0n, tax: 10_000n, fee: 0n, net: 0n })
  })

  it.each([
    ['nothing', returning('0x')],
    ['a hook list', returning(words(1n, 1n, 384n, 1n))],
    ['a ruleset that is not nine words', returning(words(1n, 1n, 32n, 0n))],
    ['a tax over 100%', returning(words(1n, 10_001n, 384n, 0n))],
    ['a word too many', returning(`${words(1n, 1n, 384n, 0n)}${uint(0)}`)],
  ])('refuses an answer of %s as no quote', async (_what, answer) => {
    const chain = rewardChain()
    stockTerminal(chain, { gross: 1n, tax: 1n })
    chain.stock(TERMINAL, terminalAbi, 'previewCashOutFrom', answer)
    await expect(quote()).rejects.toThrow(/valid unstick quote/)
  })

  it.each([
    ['the preview', TERMINAL, terminalAbi, 'previewCashOutFrom', "the terminal's unstick preview"],
    ['the fee-free surplus', TERMINAL, terminalAbi, 'feeFreeSurplusOf', 'the fee-free surplus'],
    ['the registry of feeless addresses', TERMINAL, terminalAbi, 'FEELESS_ADDRESSES', "the terminal's registry of feeless addresses"],
    ["the holder's fee status", FEELESS, feelessAddressesAbi, 'isFeelessFor', "the holder's fee status"],
  ] as const)('does not quote when %s cannot be read', async (_what, target, abi, functionName, said) => {
    const chain = rewardChain()
    stockTerminal(chain, { gross: 1_000_000n, tax: 1_000n })
    chain.stock(target, abi, functionName, REVERT)
    await expect(quote()).rejects.toThrow(`${said} could not be read.`)
  })

  it('does not quote when Center refuses a read, or the head block', async () => {
    const refused = rewardChain()
    stockTerminal(refused, { gross: 1_000_000n, tax: 1_000n })
    refused.lose(reads => reads.some(read => read.functionName === 'feeFreeSurplusOf'))
    await expect(quote()).rejects.toThrow(/could not be read/)

    const down = rewardChain()
    stockTerminal(down, { gross: 1_000_000n, tax: 1_000n })
    down.takeDown()
    await expect(quote()).rejects.toThrow('the current block could not be read.')
  })

  it('asks for the head afresh each time, since what it quotes becomes a minimum', async () => {
    const chain = rewardChain()
    stockTerminal(chain, { gross: 1_000_000n, tax: 1_000n })
    const { quoteUnstick } = await load()
    await quoteUnstick(CHAIN, PROJECT, STAKED, HOLDER, 1n)
    await quoteUnstick(CHAIN, PROJECT, STAKED, HOLDER, 2n)
    expect(chain.requests.filter(request => request.method === 'eth_blockNumber')).toHaveLength(2)
  })

  it('stops with the reason of a signal that aborts', async () => {
    const chain = rewardChain()
    stockTerminal(chain, { gross: 1_000_000n, tax: 1_000n })
    const { quoteUnstick } = await load()
    const controller = new AbortController()
    controller.abort(new Error('the page moved on'))
    await expect(quoteUnstick(CHAIN, PROJECT, STAKED, HOLDER, 1n, { signal: controller.signal })).rejects.toThrow('the page moved on')
  })
})

describe('the words of a quote', () => {
  const project = { symbol: 'ART', decimals: 6, stSymbol: 'STICKYART', cashOutTaxRate: 1_000n }
  const pool = { ...project, totalSupply: 10n * 10n ** 18n, backing: 25_000_000n }
  const priced = { gross: 2_000_000n, tax: 1_000n, fee: 50_000n, net: 1_950_000n, feeless: false, blockNumber: HEAD }

  it('say what an unstick gives, what stays with the holders who remain, and what the protocol takes', async () => {
    const { unstickQuoteSentence } = await load()
    // The holder's tenth of a 25 ART backing is 2.5 ART; the terminal pays 2 of it, and the rest stays.
    expect(unstickQuoteSentence(priced, 10n ** 18n, pool)).toBe(
      'You get 1.95 ART. 0.5 ART stays with the holders who remain. 0.05 ART goes to the protocol fee. ' +
        'The review uses this as your minimum.',
    )
  })

  it('leave out what stays when nothing does, and say when there is no fee, and why', async () => {
    const { unstickQuoteSentence } = await load()
    const even = { ...priced, gross: 2_500_000n, fee: 0n, net: 2_500_000n, tax: 0n }
    expect(unstickQuoteSentence(even, 10n ** 18n, pool)).toBe(
      'You get 2.5 ART. No protocol fee on this unstick. The review uses this as your minimum.',
    )
    expect(unstickQuoteSentence({ ...even, feeless: true }, 10n ** 18n, pool)).toBe(
      'You get 2.5 ART. No protocol fee for this wallet. The review uses this as your minimum.',
    )
  })

  it('share out the whole backing when the holder unsticks every share', async () => {
    const { unstickQuoteSentence } = await load()
    const all = pool.totalSupply
    expect(unstickQuoteSentence({ ...priced, gross: 24_000_000n, fee: 600_000n, net: 23_400_000n }, all, pool)).toContain(
      '1 ART stays with the holders who remain.',
    )
    // Asking for more than exists is asked about as all of it.
    expect(unstickQuoteSentence({ ...priced, gross: 24_000_000n, fee: 600_000n, net: 23_400_000n }, all * 2n, pool)).toContain(
      '1 ART stays with the holders who remain.',
    )
  })

  it('say what a stick mints at least, for the holder or for someone else', async () => {
    const { stickQuoteSentence } = await load()
    expect(stickQuoteSentence(5n * 10n ** 18n, project)).toBe('You get at least 5 STICKYART')
    expect(stickQuoteSentence(5n * 10n ** 18n, project, true)).toBe('They get at least 5 STICKYART')
    expect(stickQuoteSentence(1_234_500_000_000_000_000n, project)).toBe('You get at least 1.2345 STICKYART')
  })

  it('warn when unsticking returns nothing at a full bonus', async () => {
    const { stickQuoteSentence } = await load()
    expect(stickQuoteSentence(10n ** 18n, { ...project, cashOutTaxRate: 10_000n })).toBe(
      'You get at least 1 STICKYART. Unsticking returns nothing at a 100% bonus.',
    )
  })

  it('cut a token name that is longer than a name is kept', async () => {
    const { stickQuoteSentence, unstickQuoteSentence } = await load()
    const long = 'x'.repeat(300)
    expect(stickQuoteSentence(1n, { ...project, stSymbol: long })).toBe(`You get at least 0.000000000000000001 ${'x'.repeat(256)}`)
    expect(unstickQuoteSentence(priced, 1n, { ...pool, symbol: long })).toContain(`You get 1.95 ${'x'.repeat(256)}.`)
  })

  it('never say soon, and never use a dash', async () => {
    const { stickQuoteSentence, unstickQuoteSentence } = await load()
    const text = [stickQuoteSentence(1n, project), stickQuoteSentence(1n, project, true), unstickQuoteSentence(priced, 1n, pool)]
    for (const line of text) expect(line).not.toMatch(/soon|—|–/)
  })
})

describe('a quote as the minimum of its call', () => {
  const project = {
    chainId: CHAIN,
    projectId: PROJECT,
    stakedToken: STAKED,
    symbol: 'ART',
    decimals: 6,
    stSymbol: 'STICKYART',
    cashOutTaxRate: 1_000n,
    totalSupply: 10n * 10n ** 18n,
    backing: 25_000_000n,
  }

  it('wallet-action:stick wallet-action:stick-for-someone-else is what a stick mints at least, for the holder or for someone else', async () => {
    const chain = rewardChain()
    chain.stock(TERMINAL, terminalAbi, 'previewPayFor', preview(777n))
    const { quoteStick } = await load()
    const minted = await quoteStick(CHAIN, PROJECT, STAKED, 1_000_001n, HOLDER, OTHER)
    expect(stickTx(project, OTHER, 1_000_001n, minted).args).toEqual([PROJECT, STAKED, 1_000_001n, OTHER, 777n, '', '0x'])
  })

  it('wallet-action:unstick-sticky-tokens is what an unstick pays at least: the dialog says it, and the review sends it', async () => {
    const chain = rewardChain()
    chain.stock(TERMINAL, terminalAbi, 'previewCashOutFrom', [RULESET, 2_000_000n, 1_000n, []])
    chain.stock(TERMINAL, terminalAbi, 'feeFreeSurplusOf', 0n)
    chain.stock(TERMINAL, terminalAbi, 'FEELESS_ADDRESSES', FEELESS)
    chain.stock(FEELESS, feelessAddressesAbi, 'isFeelessFor', false)
    const { quoteUnstick, unstickQuoteSentence } = await load()
    const count = 10n ** 18n

    const quote = await quoteUnstick(CHAIN, PROJECT, STAKED, HOLDER, count)

    expect(unstickQuoteSentence(quote, count, project)).toBe(
      'You get 1.95 ART. 0.5 ART stays with the holders who remain. 0.05 ART goes to the protocol fee. ' +
        'The review uses this as your minimum.',
    )
    const [unstick] = unstickTxs(project, HOLDER, count, quote.net)
    expect(unstick).toMatchObject({ label: 'Unstick', args: [HOLDER, PROJECT, count, STAKED, 1_950_000n, HOLDER, '0x'] })
  })

  it('is nothing at a full bonus, and the unstick says it gives nothing back', async () => {
    const chain = rewardChain()
    chain.stock(TERMINAL, terminalAbi, 'previewCashOutFrom', [RULESET, 0n, 10_000n, []])
    chain.stock(TERMINAL, terminalAbi, 'feeFreeSurplusOf', 0n)
    chain.stock(TERMINAL, terminalAbi, 'FEELESS_ADDRESSES', FEELESS)
    chain.stock(FEELESS, feelessAddressesAbi, 'isFeelessFor', false)
    const { quoteUnstick } = await load()
    const quote = await quoteUnstick(CHAIN, PROJECT, STAKED, HOLDER, 10n ** 18n)
    expect(unstickTxs(project, HOLDER, 10n ** 18n, quote.net)[0].label).toBe('Unstick without reclaiming tokens')
  })
})
