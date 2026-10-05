// @vitest-environment jsdom

import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { QueryClient, QueryClientProvider, notifyManager, type QueryKey } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress, type Abi, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyDistributorAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED, WalletAuthContext } from '@/providers/WalletAuthContext'
import { stickyInfo } from '../home-fixtures'

// Sending an airdrop: the form, the review that reads the token, the distributor and the wallet again, and the steps it
// sends one press at a time. The reads and the engine are mocks: the builder, the reads and the engine have tests of
// their own (test/lib/sticky-builders.test.ts, sticky-rewards.test.ts, sticky-allowance.test.ts and test/transactions).
// The clock is fake, so the refreshes after a send happen only when a test moves it.

const CHAIN = 84532
const PROJECT = 12
const DISTRIBUTOR = stickyDeployment(CHAIN)!.distributor
const ALICE = getAddress(`0x${'a1'.repeat(20)}`)
const CAROL = getAddress(`0x${'c4'.repeat(20)}`)
const ART = getAddress(`0x${'2'.repeat(40)}`)
const USDC = getAddress(`0x${'6b'.repeat(20)}`)
const APPROVAL_HASH = `0x${'a1'.repeat(32)}` as Hex
const FUND_HASH = `0x${'f2'.repeat(32)}` as Hex
const E6 = 10n ** 6n
/** Project 12 on Base Sepolia sticks ART, of 6 decimals, for STICKYART. */
const INFO = stickyInfo(CHAIN, BigInt(PROJECT), { stakedToken: ART, symbol: 'ART', decimals: 6, stSymbol: 'STICKYART' })

type Phase = 'idle' | 'review' | 'simulating' | 'signing' | 'pending' | 'success' | 'error'
type EngineState = {
  phase: Phase
  busy: boolean
  error: string | null
  hash: Hex | null
  receipt: { blockNumber: bigint } | null
  isSafe: boolean
  safeProposalHash: null
  safeNonceGuidance: null
  send: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  wallet: {} as { address: string | undefined; isConnected: boolean; isCenterWallet: boolean; openSignIn: ReturnType<typeof vi.fn> },
  requestSignIn: vi.fn(),
  tx: {} as EngineState,
  read: vi.fn(),
  meta: vi.fn(),
  funds: vi.fn(),
  native: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
// The engine's hook is a mock; its labels for the phases it reports are its own.
vi.mock('@/hooks/useSafeTx', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hooks/useSafeTx')>()),
  useSafeTx: () => mocks.tx,
}))
vi.mock('@/lib/sticky-rewards', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-rewards')>()),
  readAt: mocks.read,
  rewardTokenMeta: mocks.meta,
}))
vi.mock('@/lib/sticky-allowance', () => ({ readBalanceAndAllowance: mocks.funds, readNativeBalance: mocks.native }))

import { FundFlow } from '@/components/project/flows/FundFlow'

const engine = (): EngineState => {
  const state: EngineState = {
    phase: 'idle',
    busy: false,
    error: null,
    hash: null,
    receipt: null,
    isSafe: false,
    safeProposalHash: null,
    safeNonceGuidance: null,
    // A send takes the engine out of whatever it was in, as the real one does.
    send: vi.fn(async () => {
      state.phase = 'pending'
      state.busy = true
      state.error = null
      state.hash = null
      state.receipt = null
      return FUND_HASH
    }),
    reset: vi.fn(() => {
      state.phase = 'idle'
      state.busy = false
      state.error = null
      state.hash = null
      state.receipt = null
    }),
  }
  return state
}

/** What the distributor says of a group: `isValidGroupId`. */
const accepted = (value: boolean) => [{ status: 'success', result: value }]

let host: HTMLDivElement
let root: Root
let client: QueryClient
const onClose = vi.fn()
const onFunded = vi.fn()

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: false, openSignIn: vi.fn() }
  mocks.requestSignIn.mockReset().mockResolvedValue(undefined)
  mocks.tx = engine()
  mocks.read.mockReset().mockResolvedValue(accepted(true))
  mocks.meta.mockReset().mockImplementation(async (_chain: number, token: Address) =>
    token.toLowerCase() === NATIVE_TOKEN.toLowerCase()
      ? { symbol: 'ETH', decimals: 18 }
      : token === USDC
        ? { symbol: 'USDC', decimals: 6 }
        : { symbol: 'ART', decimals: 6 },
  )
  mocks.funds.mockReset().mockResolvedValue({ balance: 100n * E6, allowance: 0n })
  mocks.native.mockReset().mockResolvedValue(10n ** 18n)
  onClose.mockReset()
  onFunded.mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  client.clear()
  clearViewAs()
  vi.useRealTimers()
})

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
async function settled() {
  for (let round = 0; round < 5; round += 1) await settle()
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WalletAuthContext.Provider value={{ requestSignIn: mocks.requestSignIn }}>
          <FundFlow chainId={CHAIN} projectId={PROJECT} info={INFO} onClose={onClose} onFunded={onFunded} />
        </WalletAuthContext.Provider>
      </QueryClientProvider>,
    ),
  )
  await settled()
}

const modal = () => document.querySelector('dialog')!
const confirm = () => document.querySelector<HTMLElement>('section[data-tx-confirm]')
const buttonIn = (within: ParentNode | null, name: string) =>
  [...(within?.querySelectorAll('button') ?? [])].find(each => each.textContent === name) as HTMLButtonElement | undefined
const press = async (within: ParentNode | null, name: string) => {
  const button = buttonIn(within, name)
  if (!button) throw new Error(`no ${name} button`)
  await act(async () => button.click())
  await settled()
}
const field = (label: string) => {
  const found = [...modal().querySelectorAll('label')].find(each => each.textContent === label)
  return found ? (document.getElementById(found.htmlFor) as HTMLInputElement | HTMLSelectElement) : null
}
async function type(label: string, text: string) {
  const input = field(label) as HTMLInputElement
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** What the form says under its fields, and its error. */
const note = () => modal().querySelector('[data-group-note]')?.textContent ?? null
const errorText = () => modal().querySelector('p.wrap-anywhere')?.textContent ?? null
/** The steps the review lists, as the titles the person reads: past the step's number, and what a screen reader hears. */
const steps = () =>
  [...(confirm()?.querySelectorAll('ol li') ?? [])].map(item => item.textContent!.replace(/^(?:\d+|✓)Step \d+ of \d+: /, ''))
const stepStates = () => [...(confirm()?.querySelectorAll('ol li') ?? [])].map(item => item.getAttribute('data-state'))
const primary = () => confirm()!.querySelector<HTMLButtonElement>('footer button.btn-primary')!
/** The confirmation's rows, by label. */
const rowsOf = () =>
  Object.fromEntries(
    [...confirm()!.querySelectorAll('.grid > span')].reduce<string[][]>((pairs, cell, at) => {
      if (at % 2 === 0) pairs.push([cell.textContent ?? ''])
      else pairs[pairs.length - 1].push(cell.textContent ?? '')
      return pairs
    }, []),
  )
type Sent = { chainId: number; address: Address; abi: Abi; functionName: string; args: readonly unknown[]; value?: bigint; label?: string }
const sent = (at: number) => mocks.tx.send.mock.calls[at] as [Sent, { reviewedAccount: Address; simulationBlockNumber?: bigint; reverify: () => Promise<unknown> }]

/** An airdrop of `amount` of `token`, for the group the weeks name, up to its review. */
async function review({ token = ART as string, amount = '5', min = '', max = '' } = {}) {
  await render()
  await type('Airdropped token', token)
  await type('Minimum stake age (weeks)', min)
  await type('Maximum stake age (weeks)', max)
  await type('Amount', amount)
  await press(modal(), 'Send')
}

/** The engine's answer once its transaction is confirmed in block `block`. */
async function confirmed(hash: Hex, block: bigint) {
  mocks.tx.phase = 'success'
  mocks.tx.busy = false
  mocks.tx.hash = hash
  mocks.tx.receipt = { blockNumber: block }
  await render()
}

describe('the form', () => {
  it('lists only this chain to send from', async () => {
    await render()
    expect(modal().querySelector('h2')?.textContent).toBe('Airdrop')
    const from = field('From chain') as HTMLSelectElement
    expect([...from.options].map(option => option.textContent)).toEqual(['Base Sepolia'])
  })

  it('says who a group rewards as the weeks are typed, and why weeks name none', async () => {
    await render()
    expect(note()).toBe("Everyone holding at the round's snapshot shares it.")
    await type('Minimum stake age (weeks)', '4')
    await type('Maximum stake age (weeks)', '8')
    expect(note()).toBe(
      'Only stake between 4 weeks and 8 weeks old when the round starts shares it, and holders who unstick before claiming forfeit their share.',
    )
    await type('Minimum stake age (weeks)', '0')
    expect(note()).toBe('A maximum stake age needs a minimum of at least 1 week.')
  })

  it('asks to sign in instead of reviewing when nobody is signed in', async () => {
    mocks.wallet = { address: undefined, isConnected: false, isCenterWallet: false, openSignIn: vi.fn() }
    await render()
    expect(buttonIn(modal(), 'Send')).toBeUndefined()
    await press(modal(), 'Sign in to send')
    expect(mocks.wallet.openSignIn).toHaveBeenCalledOnce()
    expect(mocks.meta).not.toHaveBeenCalled()
    expect(confirm()).toBeNull()
  })
})

describe('the review', () => {
  it('wallet-action:approve-a-reward-token-for-an-airdrop wallet-action:send-an-airdrop An ERC-20 fund plans an exact approval to the distributor, then fund', async () => {
    await review()
    expect(mocks.funds).toHaveBeenCalledWith(CHAIN, { token: ART, owner: ALICE, spender: DISTRIBUTOR }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(steps()).toEqual(['Approve 5 ART', 'Fund stuck holders'])
    expect(stepStates()).toEqual(['active', 'pending'])
    expect(confirm()!.textContent).toContain('2 transactions left.')
    expect(primary().textContent).toBe('Confirm & approve')

    await press(confirm(), 'Confirm & approve')
    const [approval, approvalOptions] = sent(0)
    expect(approval).toMatchObject({ chainId: CHAIN, address: ART, functionName: 'approve', args: [DISTRIBUTOR, 5n * E6] })
    expect(approvalOptions).toMatchObject({ reviewedAccount: ALICE, simulationBlockNumber: undefined })

    await confirmed(APPROVAL_HASH, 100n)
    expect(stepStates()).toEqual(['complete', 'active'])
    expect(primary().textContent).toBe('Confirm & send')
    await press(confirm(), 'Confirm & send')
    const [fund, fundOptions] = sent(1)
    expect(fund).toMatchObject({ chainId: CHAIN, address: DISTRIBUTOR, abi: stickyDistributorAbi, functionName: 'fund', args: [INFO.stToken, ART, 5n * E6, 0n] })
    expect(fund.value).toBeUndefined()
    expect(Object.isFrozen(fund)).toBe(true)
    // The airdrop is simulated where its approval is.
    expect(fundOptions).toMatchObject({ reviewedAccount: ALICE, simulationBlockNumber: 100n })
  })

  it('wallet-action:send-an-airdrop native ETH reward funding attaches exact value and never approves a sentinel', async () => {
    await review({ token: 'ETH', amount: '0.000000000000000001' })
    expect(mocks.meta).toHaveBeenCalledWith(CHAIN, NATIVE_TOKEN, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(mocks.native).toHaveBeenCalledWith(CHAIN, ALICE, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(mocks.funds).not.toHaveBeenCalled()
    expect(steps()).toEqual(['Fund stuck holders'])
    expect(rowsOf().Send).toBe('0.000000000000000001 ETH')

    await press(confirm(), 'Confirm & send')
    const [fund] = sent(0)
    expect(fund).toMatchObject({ address: DISTRIBUTOR, functionName: 'fund', args: [INFO.stToken, NATIVE_TOKEN, 1n, 0n], value: 1n })
    expect(mocks.tx.send).toHaveBeenCalledOnce()
  })

  it('wallet-action:send-an-airdrop funding passes the chosen group, describes it, and rejects windows the distributor refuses', async () => {
    await review({ min: '4', max: '8' })
    expect(mocks.read).toHaveBeenCalledWith(
      CHAIN,
      [{ address: DISTRIBUTOR, abi: stickyDistributorAbi, functionName: 'isValidGroupId', args: [4008n] }],
      undefined,
      expect.any(AbortSignal),
    )
    expect(rowsOf()).toEqual({
      Send: '5 ART',
      To: 'Staked 4–8 weeks',
      How: 'Only stake between 4 weeks and 8 weeks old when the round starts shares it, and holders who unstick before claiming forfeit their share.',
      Project: 'STICKYART #12',
      On: 'Base Sepolia',
    })
    await press(confirm(), 'Confirm & approve')
    await confirmed(APPROVAL_HASH, 100n)
    await press(confirm(), 'Confirm & send')
    expect(sent(1)[0].args).toEqual([INFO.stToken, ART, 5n * E6, 4008n])
  })

  it('refuses weeks that name no group before it reads anything', async () => {
    await review({ min: '0', max: '4' })
    expect(errorText()).toBe('A maximum stake age needs a minimum of at least 1 week.')
    expect(confirm()).toBeNull()
    expect(mocks.meta).not.toHaveBeenCalled()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('A group that fails isValidGroupId is refused before review, and the wallet is never called', async () => {
    mocks.read.mockResolvedValue(accepted(false))
    await review({ min: '4' })
    expect(errorText()).toBe('The distributor does not accept this stake-age window.')
    expect(confirm()).toBeNull()
    expect(mocks.tx.send).not.toHaveBeenCalled()
  })

  it.each([
    ['', '', 'Everyone'],
    ['4', '', 'Staked 4+ weeks'],
    ['4', '12', 'Staked 4–12 weeks'],
  ])('The review names the group in words: weeks "%s" to "%s" are %s', async (min, max, words) => {
    await review({ min, max })
    expect(rowsOf().To).toBe(words)
  })

  it('airdrops the staked token when no token is named', async () => {
    await review({ token: '' })
    expect(mocks.meta).toHaveBeenCalledWith(CHAIN, ART, expect.anything())
    expect(steps()).toEqual(['Approve 5 ART', 'Fund stuck holders'])
  })

  it('takes another ERC-20, named by its address in either case, and names it by its symbol', async () => {
    await review({ token: USDC.toLowerCase(), amount: '2.5' })
    expect(mocks.meta).toHaveBeenCalledWith(CHAIN, USDC, expect.anything())
    expect(rowsOf().Send).toBe('2.5 USDC')
    expect(steps()).toEqual(['Approve 2.5 USDC', 'Fund stuck holders'])
  })

  it('wallet-action:approve-a-reward-token-for-an-airdrop asks for no approval when the allowance already covers the amount, and resets one that does not', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * E6, allowance: 5n * E6 })
    await review()
    expect(steps()).toEqual(['Fund stuck holders'])

    await act(async () => root.unmount())
    root = createRoot(host)
    mocks.funds.mockResolvedValue({ balance: 100n * E6, allowance: 2n * E6 })
    await review()
    expect(steps()).toEqual(['Reset ART allowance', 'Approve 5 ART', 'Fund stuck holders'])
  })

  it('reward token decimals fail closed instead of silently assuming 18', async () => {
    mocks.meta.mockRejectedValue(new Error("the reward token's decimals could not be read."))
    await review({ token: USDC })
    expect(errorText()).toBe("The reward token's decimals could not be read.")
    expect(confirm()).toBeNull()
    expect(mocks.funds).not.toHaveBeenCalled()
  })

  it.each([
    ['a word', 'usdc', 'Enter a valid reward token address or ETH.'],
    ['the zero address', `0x${'0'.repeat(40)}`, 'Enter a valid reward token address or ETH.'],
  ])('refuses %s for a token before it reads anything', async (_name, token, message) => {
    await review({ token })
    expect(errorText()).toBe(message)
    expect(mocks.meta).not.toHaveBeenCalled()
  })

  it.each([
    ['nothing', '0', 'Enter an amount greater than zero.'],
    ['more places than the token has', '1.0000001', 'This token supports at most 6 decimal places.'],
    ['text', 'five', 'Enter a valid amount.'],
  ])('refuses an amount of %s', async (_name, amount, message) => {
    await review({ amount })
    expect(errorText()).toBe(message)
    expect(confirm()).toBeNull()
  })

  it('refuses more than the wallet holds', async () => {
    mocks.funds.mockResolvedValue({ balance: 4n * E6, allowance: 0n })
    await review()
    expect(errorText()).toBe('That is more than you hold.')
    expect(confirm()).toBeNull()

    await act(async () => root.unmount())
    root = createRoot(host)
    mocks.native.mockResolvedValue(0n)
    await review({ token: 'eth', amount: '1' })
    expect(errorText()).toBe('That is more than you hold.')
  })

  it('says what could not be read, tells the console why, and opens no review', async () => {
    const cause = new Error('429')
    mocks.funds.mockRejectedValue(new Error('the balance and the allowance could not be read.', { cause }))
    await review()
    expect(errorText()).toBe('The balance and the allowance could not be read.')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('airdrop'), { chainId: CHAIN, projectId: PROJECT }, expect.objectContaining({ cause }))
    expect(confirm()).toBeNull()
  })
})

describe('the send', () => {
  it('names the account that reviewed the airdrop on every step, whichever account is connected by then', async () => {
    await review()
    // The review stays for the account it was made for, and the engine refuses another.
    mocks.wallet = { ...mocks.wallet, address: CAROL }
    await render()
    await press(confirm(), 'Confirm & approve')
    expect(sent(0)[1].reviewedAccount).toBe(ALICE)
  })

  it('reads the balance again before each step, and stops one that no longer fits', async () => {
    await review()
    await press(confirm(), 'Confirm & approve')
    const [request, { reverify }] = sent(0)
    mocks.funds.mockClear()
    await expect(reverify()).resolves.toBeUndefined()
    expect(mocks.funds).toHaveBeenCalledWith(CHAIN, { token: ART, owner: ALICE, spender: DISTRIBUTOR })
    mocks.funds.mockResolvedValue({ balance: 4n * E6, allowance: 0n })
    await expect(reverify()).rejects.toThrow('Your ART balance changed. Review the amount.')
    expect(request.functionName).toBe('approve')
  })

  it('shows the engine\'s error with a way to send the same step again', async () => {
    await review()
    mocks.tx.phase = 'error'
    mocks.tx.error = 'Transaction cancelled.'
    await render()
    expect(confirm()!.textContent).toContain('Transaction cancelled.')
    await press(confirm(), 'Retry')
    expect(sent(0)[0].functionName).toBe('approve')
  })

  it('says it went through, links it, reads the pots again, checks the token and stays open until Done', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const keys = (): QueryKey[] => invalidate.mock.calls.map(([filters]) => filters!.queryKey!)
    mocks.funds.mockResolvedValue({ balance: 100n * E6, allowance: 5n * E6 })
    await review({ token: USDC })
    await press(confirm(), 'Confirm & send')
    await confirmed(FUND_HASH, 101n)

    const dialog = confirm()!
    expect(dialog.textContent).toContain('Airdrop sent')
    expect(dialog.textContent).toContain('All transactions confirmed.')
    expect(dialog.querySelector('a')?.getAttribute('href')).toBe(`https://sepolia.basescan.org/tx/${FUND_HASH}`)
    expect(onFunded).toHaveBeenCalledExactlyOnceWith(USDC.toLowerCase())
    expect(keys()).toEqual([
      ['sticky-project', CHAIN, PROJECT, 'funding'],
      ['sticky-rewards', CHAIN, PROJECT],
      ['sticky-autostick', CHAIN, PROJECT],
      ['sticky-position', CHAIN, PROJECT],
    ])
    await settle(60_000)
    expect(confirm()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await press(confirm(), 'Done')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('brings the form back as it was when the review is cancelled', async () => {
    await review({ amount: '7' })
    await press(confirm(), 'Cancel')
    expect(confirm()).toBeNull()
    expect((field('Amount') as HTMLInputElement).value).toBe('7')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('a wallet that cannot send', () => {
  it('is refused, for Signa, when the review starts: nothing is read, and "Connect a wallet" opens the external wallets', async () => {
    mocks.wallet = { ...mocks.wallet, isCenterWallet: true }
    await review()
    expect(errorText()).toBe(`${EXTERNAL_WALLET_REQUIRED} Connect a wallet`)
    expect(mocks.meta).not.toHaveBeenCalled()
    expect(confirm()).toBeNull()
    await press(modal(), 'Connect a wallet')
    expect(mocks.requestSignIn).toHaveBeenCalledWith({ walletsOnly: true })
  })

  it('is refused in View as when the review starts', async () => {
    setViewAs(CAROL)
    await review()
    expect(errorText()).toBe(VIEW_AS_WRITE_BLOCKED)
    expect(mocks.meta).not.toHaveBeenCalled()
    expect(mocks.tx.send).not.toHaveBeenCalled()
  })
})
