// @vitest-environment jsdom

import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { QueryClient, QueryClientProvider, notifyManager, type QueryKey } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress, type Abi, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyRewardReceiverFactoryAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED, WalletAuthContext } from '@/providers/WalletAuthContext'
import { stickyInfo } from '../home-fixtures'

// The reward address of a group of a project's holders: where it is, whether it is created, what it holds to settle,
// and creating it and settling what it holds into airdrops. The reads and the engine are mocks: the builders, the reads
// and the engine have tests of their own (test/lib/sticky-builders.test.ts, sticky-receivers.test.ts,
// sticky-rewards.test.ts, preflight.test.ts and test/transactions).

const CHAIN = 84532
const PROJECT = 12
const FACTORY = stickyDeployment(CHAIN)!.rewardReceiverFactory
const ALICE = getAddress(`0x${'a1'.repeat(20)}`)
const CAROL = getAddress(`0x${'c4'.repeat(20)}`)
const ART = getAddress(`0x${'2'.repeat(40)}`)
const USDC = getAddress(`0x${'6b'.repeat(20)}`)
const RECEIVER = getAddress(`0x${'8'.repeat(40)}`)
const HASH = `0x${'c3'.repeat(32)}` as Hex
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
  receiver: vi.fn(),
  arrivals: vi.fn(),
  meta: vi.fn(),
  preflight: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/hooks/useSafeTx', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hooks/useSafeTx')>()),
  useSafeTx: () => mocks.tx,
}))
vi.mock('@/lib/sticky-receivers', () => ({ readReceiver: mocks.receiver, readArrivals: mocks.arrivals }))
vi.mock('@/lib/sticky-rewards', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-rewards')>()),
  rewardTokenMeta: mocks.meta,
}))
vi.mock('@/lib/preflight', () => ({ preflight: mocks.preflight }))

import { ReceiverFlow } from '@/components/project/flows/ReceiverFlow'

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
    send: vi.fn(async () => {
      state.phase = 'pending'
      state.busy = true
      state.error = null
      state.hash = null
      state.receipt = null
      return HASH
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

let host: HTMLDivElement
let root: Root
let client: QueryClient
const onSettled = vi.fn()

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: false, openSignIn: vi.fn() }
  mocks.requestSignIn.mockReset().mockResolvedValue(undefined)
  mocks.tx = engine()
  mocks.receiver.mockReset().mockResolvedValue({ address: RECEIVER, created: false })
  mocks.arrivals.mockReset().mockResolvedValue(1_500_000n)
  mocks.meta.mockReset().mockImplementation(async (_chain: number, token: Address) =>
    token.toLowerCase() === NATIVE_TOKEN.toLowerCase() ? { symbol: 'ETH', decimals: 18 } : token === USDC ? { symbol: 'USDC', decimals: 6 } : { symbol: 'ART', decimals: 6 },
  )
  mocks.preflight.mockReset().mockResolvedValue(undefined)
  onSettled.mockReset()
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
          <ReceiverFlow chainId={CHAIN} projectId={PROJECT} info={INFO} onSettled={onSettled} />
        </WalletAuthContext.Provider>
      </QueryClientProvider>,
    ),
  )
  await settled()
}
/** The panel opened, as a person opens its disclosure. */
async function open() {
  await render()
  const details = host.querySelector('details')!
  await act(async () => {
    details.open = true
    details.dispatchEvent(new Event('toggle'))
  })
  await settled()
}

const panel = () => host.querySelector('details')!
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
  const found = [...panel().querySelectorAll('label')].find(each => each.textContent === label)
  return found ? (document.getElementById(found.htmlFor) as HTMLInputElement) : null
}
async function type(label: string, text: string) {
  const input = field(label)!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settled()
}
/** The panel's rows, by label. */
const shown = () =>
  Object.fromEntries([...panel().querySelectorAll('[data-receiver] dt')].map(term => [term.textContent, term.nextElementSibling?.textContent]))
const arrivals = () => panel().querySelector('[data-arrivals]')?.textContent ?? null
const errorText = () => host.querySelector('p.wrap-anywhere')?.textContent ?? null
const steps = () =>
  [...(confirm()?.querySelectorAll('ol li') ?? [])].map(item => item.textContent!.replace(/^(?:\d+|✓)Step \d+ of \d+: /, ''))
const rowsOf = () =>
  Object.fromEntries(
    [...confirm()!.querySelectorAll('.grid > span')].reduce<string[][]>((pairs, cell, at) => {
      if (at % 2 === 0) pairs.push([cell.textContent ?? ''])
      else pairs[pairs.length - 1].push(cell.textContent ?? '')
      return pairs
    }, []),
  )
type Sent = { chainId: number; address: Address; abi: Abi; functionName: string; args: readonly unknown[] }
const sent = (at: number) => mocks.tx.send.mock.calls[at] as [Sent, { reviewedAccount: Address }]
async function confirmed() {
  mocks.tx.phase = 'success'
  mocks.tx.busy = false
  mocks.tx.hash = HASH
  mocks.tx.receipt = { blockNumber: 10n }
  await render()
}

describe('the reward address', () => {
  it('is behind its disclosure, and nothing is read until it is opened', async () => {
    await render()
    expect(panel().querySelector('summary')?.textContent).toBe('Reward address for fee payouts and transfers')
    expect(mocks.receiver).not.toHaveBeenCalled()
    await open()
    expect(panel().textContent).toContain('Tokens sent here become airdrops once anyone settles them.')
    expect(mocks.receiver).toHaveBeenCalledWith(CHAIN, INFO.stToken, 0n, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('Status: the predicted address shows "Created" when it has code, else "Not created yet"', async () => {
    await open()
    expect(shown()).toEqual({
      'Reward address': `${RECEIVER}Copy`,
      Status: 'Not created yet',
    })
    expect(buttonIn(panel(), 'Create onchain')).toBeDefined()
    expect(panel().querySelector('button[aria-label="Copy reward address"]')).not.toBeNull()

    mocks.receiver.mockResolvedValue({ address: RECEIVER, created: true })
    await act(async () => void (await client.invalidateQueries()))
    await settled()
    expect(shown().Status).toBe('Created')
    expect(buttonIn(panel(), 'Create onchain')).toBeUndefined()
  })

  it('receiver prediction and settlement are per group: the weeks name the group whose address it is', async () => {
    await open()
    await type('Minimum stake age (weeks)', '4')
    expect(mocks.receiver).toHaveBeenLastCalledWith(CHAIN, INFO.stToken, 4000n, expect.anything())
    expect(panel().querySelector('[data-group-note]')?.textContent).toContain('at least 4 weeks old')

    mocks.receiver.mockClear()
    await type('Minimum stake age (weeks)', '0')
    await type('Maximum stake age (weeks)', '4')
    expect(panel().querySelector('[data-group-note]')?.textContent).toBe('A maximum stake age needs a minimum of at least 1 week.')
    expect(mocks.receiver).not.toHaveBeenCalled()
    expect(shown()).toEqual({})
  })

  it('Wrong factory: a factory whose DISTRIBUTOR() differs from the deployment\'s distributor is refused before review', async () => {
    mocks.receiver.mockRejectedValue(new Error('the reward receiver factory uses a different distributor'))
    await open()
    expect(panel().querySelector('[role="alert"]')?.textContent).toContain('The reward receiver factory uses a different distributor.')
    expect(shown()).toEqual({})
    await press(panel(), 'Settle into airdrops')
    expect(errorText()).toBe('The reward receiver factory uses a different distributor.')
    expect(confirm()).toBeNull()
    expect(mocks.preflight).not.toHaveBeenCalled()
    expect(mocks.tx.send).not.toHaveBeenCalled()
  })
})

describe('creating it', () => {
  it('wallet-action:create-a-reward-address Create: a preflight eth_call, then factory.deployReceiverFor(stToken, groupId)', async () => {
    await open()
    await type('Minimum stake age (weeks)', '4')
    await press(panel(), 'Create onchain')
    const [tried, account, , refusal] = mocks.preflight.mock.calls[0]
    expect(account).toBe(ALICE)
    expect(refusal).toBe('The reward receiver factory would refuse this')
    expect(tried).toMatchObject({ address: FACTORY, functionName: 'deployReceiverFor', args: [INFO.stToken, 4000n] })
    expect(steps()).toEqual(['Create reward address'])
    expect(rowsOf()).toEqual({ Who: 'Staked 4+ weeks', 'Reward address': RECEIVER, On: 'Base Sepolia' })

    await press(confirm(), 'Confirm & create')
    const [request, options] = sent(0)
    expect(request).toBe(tried)
    expect(request).toMatchObject({ abi: stickyRewardReceiverFactoryAbi, functionName: 'deployReceiverFor', args: [INFO.stToken, 4000n] })
    expect(options.reviewedAccount).toBe(ALICE)
  })

  it('says it is created, links it, and reads the reward address again', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await open()
    await press(panel(), 'Create onchain')
    await press(confirm(), 'Confirm & create')
    await confirmed()
    expect(confirm()!.textContent).toContain('Reward address created')
    expect(invalidate.mock.calls.map(([filters]) => filters!.queryKey as QueryKey)).toEqual([['sticky-project', CHAIN, PROJECT, 'receiver']])
  })

  it('refuses to create an address that is created already, and one the factory would refuse', async () => {
    await open()
    mocks.receiver.mockResolvedValue({ address: RECEIVER, created: true })
    await press(panel(), 'Create onchain')
    expect(errorText()).toBe('This reward address is created already.')
    expect(confirm()).toBeNull()

    mocks.receiver.mockResolvedValue({ address: RECEIVER, created: false })
    mocks.preflight.mockRejectedValue(new Error('The reward receiver factory would refuse this: FailedDeployment', { cause: new Error('revert') }))
    await act(async () => void (await client.invalidateQueries()))
    await settled()
    await press(panel(), 'Create onchain')
    expect(errorText()).toBe('The reward receiver factory would refuse this: FailedDeployment.')
  })
})

describe('settling it', () => {
  it('wallet-action:settle-arrivals-into-airdrops receiver settlement uses the selected destination reward token, verifies distributor, and rejects empty arrivals', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await open()
    await type('Token to settle', USDC.toLowerCase())
    expect(mocks.arrivals).toHaveBeenLastCalledWith(CHAIN, RECEIVER, USDC, expect.anything())
    expect(arrivals()).toBe('1.5 USDC waiting to settle')

    await press(panel(), 'Settle into airdrops')
    // The review reads the reward address again, which holds the factory to the deployment's distributor.
    expect(mocks.receiver).toHaveBeenLastCalledWith(CHAIN, INFO.stToken, 0n, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(steps()).toEqual(['Settle arrivals'])
    expect(rowsOf()).toEqual({
      Settle: '1.5 USDC',
      Who: 'Everyone',
      Receiver: RECEIVER,
      Effect: "The receiver's whole balance becomes this round's rewards for those holders.",
      On: 'Base Sepolia',
    })
    expect(mocks.preflight.mock.calls[0][0]).toMatchObject({ functionName: 'settleFor', args: [INFO.stToken, 0n, USDC] })

    await press(confirm(), 'Confirm & settle')
    expect(sent(0)[0]).toMatchObject({ address: FACTORY, functionName: 'settleFor', args: [INFO.stToken, 0n, USDC] })
    expect(sent(0)[1].reviewedAccount).toBe(ALICE)
    invalidate.mockClear()
    await confirmed()
    expect(confirm()!.textContent).toContain('Arrivals settled into rewards')
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(USDC.toLowerCase())
    expect(invalidate.mock.calls.map(([filters]) => filters!.queryKey as QueryKey)).toEqual([
      ['sticky-project', CHAIN, PROJECT, 'funding'],
      ['sticky-project', CHAIN, PROJECT, 'receiver'],
      ['sticky-rewards', CHAIN, PROJECT],
      ['sticky-autostick', CHAIN, PROJECT],
    ])
  })

  it('rejects empty arrivals before review', async () => {
    mocks.arrivals.mockResolvedValue(0n)
    await open()
    await type('Token to settle', USDC)
    await press(panel(), 'Settle into airdrops')
    expect(errorText()).toBe('There are no USDC arrivals to settle.')
    expect(confirm()).toBeNull()
  })

  it('settles the staked token when no token is named', async () => {
    await open()
    expect(arrivals()).toBe('1.5 ART waiting to settle')
    await press(panel(), 'Settle into airdrops')
    expect(mocks.preflight.mock.calls[0][0].args).toEqual([INFO.stToken, 0n, ART])
  })

  it('receivers reject native ETH rather than falsely describing an ERC20 settlement', async () => {
    await open()
    await type('Token to settle', 'ETH')
    expect(arrivals()).toBe('Enter an ERC-20 token address')
    expect(mocks.arrivals).not.toHaveBeenCalledWith(CHAIN, RECEIVER, NATIVE_TOKEN, expect.anything())
    await press(panel(), 'Settle into airdrops')
    expect(errorText()).toBe('Reward receivers settle ERC-20 tokens. Fund ETH rewards directly.')
    expect(confirm()).toBeNull()
  })

  it('refuses a token field that names no token', async () => {
    await open()
    await type('Token to settle', 'usdc')
    expect(arrivals()).toBe('Enter an ERC-20 token address')
    await press(panel(), 'Settle into airdrops')
    expect(errorText()).toBe('Enter an ERC-20 token address.')
  })
})

describe('a wallet that cannot send', () => {
  it('is refused, for Signa, when a review starts, and "Connect a wallet" opens the external wallets', async () => {
    mocks.wallet = { ...mocks.wallet, isCenterWallet: true }
    await open()
    mocks.receiver.mockClear()
    await press(panel(), 'Create onchain')
    expect(errorText()).toBe(`${EXTERNAL_WALLET_REQUIRED} Connect a wallet`)
    expect(mocks.receiver).not.toHaveBeenCalled()
    await press(panel(), 'Connect a wallet')
    expect(mocks.requestSignIn).toHaveBeenCalledWith({ walletsOnly: true })
  })

  it('is refused in View as when a review starts', async () => {
    setViewAs(CAROL)
    await open()
    await press(panel(), 'Settle into airdrops')
    expect(errorText()).toBe(VIEW_AS_WRITE_BLOCKED)
    expect(mocks.preflight).not.toHaveBeenCalled()
  })

  it('names the account that reviewed it on its step, whichever account is connected by then', async () => {
    await open()
    await press(panel(), 'Create onchain')
    mocks.wallet = { ...mocks.wallet, address: CAROL }
    await render()
    await press(confirm(), 'Confirm & create')
    expect(sent(0)[1].reviewedAccount).toBe(ALICE)
  })
})
