// @vitest-environment jsdom

/**
 * The Transfer and Trust flows on the real engine: their one decoded review, core's reviewed send and the simulation
 * and wallet send behind it (core simulates while the review is open), with only the wallet, the chain and the review dialogs faked. What reaches the simulation and the
 * wallet is what the review showed, no step opens a review of its own, and the flow's second read of the chain comes
 * before either.
 */

import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { registerReviewHandler, REVIEWED_ACCOUNT_CHANGED_LINE, type ReviewModel } from '@bananapus/nana-sdk-core/review'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyHookAbi, stickyTokenAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import type { StickyPosition } from '@/lib/sticky-holders'
import { clearViewAs } from '@/lib/viewAs'
import { E18, stickyInfo } from '../home-fixtures'

const mocks = vi.hoisted(() => ({
  /** The account the page shows, which `getAccount` (the wallet's own) answers too unless a test says otherwise. */
  account: '' as string,
  publicClient: {
    chain: { id: 84532 }, getBlockNumber: vi.fn(async () => 100n), getTransactionCount: vi.fn(async () => 7), getChainId: vi.fn(), getTransaction: vi.fn(),
    getTransactionReceipt: vi.fn(), waitForTransactionReceipt: vi.fn(), getBlock: vi.fn(), estimateGas: vi.fn(async () => 50_000n), getGasPrice: vi.fn(async () => 1n),
    readContract: vi.fn(async () => { throw new Error('no reads here') }),
    /** The chain's answer to a simulation (eth_call): success, unless a test refuses it; a Safe's nonce() reads as 5. */
    request: vi.fn(),
  },
  /** The transaction's receipt, once the chain has it. */
  receipt: undefined as undefined | { status: 'success' | 'reverted'; transactionHash: string },
  /** Receipt waits, answered once the transaction is mined. */
  waiting: [] as (() => void)[],
  getAccount: vi.fn(),
  /** The action's one decoded review: the test sees its model; `hold` keeps it open until the test approves. */
  review: vi.fn(),
  hold: null as null | Promise<void>,
  /** The wallet. */
  sendTransaction: vi.fn(),
  safe: false,
  waitForSafeExecutionHash: vi.fn(),
  read: vi.fn(),
  position: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({
  getAccount: mocks.getAccount, getPublicClient: () => mocks.publicClient, switchChain: vi.fn(),
  getWalletClient: async () => ({ chain: { id: 84532 }, sendTransaction: mocks.sendTransaction }),
}))
vi.mock('wagmi', () => ({ usePublicClient: () => mocks.publicClient }))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: mocks.account, isCenterWallet: false, openSignIn: vi.fn() }),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safe,
  SAFE_NONCE_GUIDANCE: 'Safe nonce guidance',
  useSafeConnection: () => mocks.safe,
  waitForSafeExecutionHash: mocks.waitForSafeExecutionHash,
  atOnceExecution: async () => null,
  findPendingSafeAppProposal: async () => null,
  reportedSafeExecution: async () => null,
  chainAnswer: async () => null,
  watchSafeProposal: () => new Promise(() => {}),
}))
vi.mock('@/lib/sticky-rewards', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-rewards')>()),
  readAt: mocks.read,
}))
vi.mock('@/lib/sticky-holders', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-holders')>()),
  readStickyPosition: mocks.position,
}))
vi.mock('@/lib/ens', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/ens')>()),
  lookupEnsName: async () => null,
}))

import { TransferFlow } from '@/components/project/flows/TransferFlow'
import { TrustFlow } from '@/components/project/flows/TrustFlow'

const CHAIN = 84532
const HOOK = stickyDeployment(CHAIN)!.hook
const ALICE = getAddress(`0x${'a1'.repeat(20)}`)
const BOB = getAddress(`0x${'b2'.repeat(20)}`)
const STICKY = getAddress(`0x${'5'.repeat(40)}`)
const HASH = `0x${'c3'.repeat(32)}`
const BLOCK_HASH = `0x${'ed'.repeat(32)}` as const
const walletReceipt = () => ({ status: 'success' as const, transactionHash: HASH, blockNumber: 12n, blockHash: BLOCK_HASH, transactionIndex: 0, from: ALICE, to: STICKY, logs: [] })
const info = stickyInfo(CHAIN, 12n, { stToken: STICKY, stSymbol: 'STICKYART', symbol: 'ART', decimals: 6 })

const answer = (result: unknown) => [{ status: 'success', result }]
const position: StickyPosition = {
  staked: 2n * E18,
  wallet: 0n,
  start: 0,
  current: 0,
  longest: 0,
  blockNumber: 100n,
  timestamp: 1_800_000_000,
}

let host: HTMLDivElement
let root: Root
let client: QueryClient
let unregister = () => {}

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.receipt = undefined
  mocks.waiting = []
  mocks.account = ALICE
  mocks.safe = false
  mocks.publicClient.getChainId.mockResolvedValue(CHAIN)
  mocks.publicClient.request.mockReset().mockImplementation(async ({ method, params }: { method: string; params?: [{ data?: Hex }] }) => {
    if (method === 'eth_call') return params?.[0]?.data === '0xaffed0e0' ? `0x${'5'.padStart(64, '0')}` : '0x'
    throw new Error(`unexpected ${method}`)
  })
  mocks.publicClient.getTransactionReceipt.mockImplementation(async () => {
    if (!mocks.receipt) throw new Error('Receipt not found')
    return mocks.receipt
  })
  mocks.publicClient.waitForTransactionReceipt.mockImplementation(() => new Promise(resolve => {
    if (mocks.receipt) resolve(mocks.receipt)
    else mocks.waiting.push(() => resolve(mocks.receipt))
  }))
  mocks.publicClient.getTransaction.mockImplementation(async () => {
    const [sent] = mocks.sendTransaction.mock.lastCall!
    return { ...walletReceipt(), hash: HASH, chainId: CHAIN, to: sent.to, input: sent.data, value: sent.value ?? 0n }
  })
  mocks.publicClient.getBlock.mockResolvedValue({ number: 12n, hash: BLOCK_HASH })
  mocks.waitForSafeExecutionHash.mockReset().mockImplementation(() => new Promise(() => {}))
  mocks.getAccount.mockReset().mockImplementation(() => ({ address: mocks.account, chainId: CHAIN }))
  mocks.review.mockReset()
  mocks.hold = null
  unregister = registerReviewHandler(async prompt => {
    mocks.review(prompt.model)
    await mocks.hold
    return prompt.confirmation
  })
  mocks.sendTransaction.mockReset().mockResolvedValue(HASH)
  mocks.read.mockReset().mockResolvedValue(answer(2n * E18))
  mocks.position.mockReset().mockResolvedValue(position)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  unregister()
  await act(async () => root.unmount())
  host.remove()
  client.clear()
  clearViewAs()
})

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))
const render = async (flow: React.ReactNode) => {
  await act(async () => root.render(<QueryClientProvider client={client}>{flow}</QueryClientProvider>))
  await settle()
}
const modal = () => document.querySelector('dialog')!
const confirm = () => document.querySelector<HTMLElement>('section[data-tx-confirm]')!
const press = async (within: ParentNode, name: string) => {
  const button = [...within.querySelectorAll('button')].find(each => each.textContent === name)!
  await act(async () => button.click())
  await settle()
}
async function type(label: string, text: string) {
  const found = [...modal().querySelectorAll('label')].find(each => each.textContent === label)!
  const input = document.getElementById(found.htmlFor) as HTMLInputElement
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const transfer = () => <TransferFlow info={info} onClose={() => {}} />
/** The wallet switches to `account`, and the page renders `flow` for it. */
async function switchTo(account: Address, flow: React.ReactNode) {
  mocks.account = account
  await render(flow)
}
/** The wallet switches to `account`, and a click is handled before the page has rendered it. */
const switchWalletOnly = (account: Address) => mocks.getAccount.mockImplementation(() => ({ address: account, chainId: CHAIN }))
/** The confirm's main button, and the line under its step that says what the engine is doing. */
const primary = () => confirm().querySelector<HTMLButtonElement>('footer button.btn-primary')!
const statusLine = () => confirm().querySelector('p.text-bluebs-700')?.textContent ?? null
/** Holds the next decoded review open until the test approves it. */
function holdReview() {
  const open = Promise.withResolvers<void>()
  mocks.hold = open.promise
  return {
    approve: async () => {
      await act(async () => open.resolve())
      await settle()
      await settle()
    },
  }
}
/** What decoded review `at` showed. */
const shown = (at = 0) => mocks.review.mock.calls[at][0] as ReviewModel
/** What the wallet was asked to send, decoded. */
const sent = (at = 0) => {
  const [tx] = mocks.sendTransaction.mock.calls[at]
  return { to: tx.to as Address, ...decodeFunctionData({ abi: [...stickyTokenAbi, ...stickyHookAbi], data: tx.data }) }
}
/** The simulations the chain was asked for. */
const simulations = () => mocks.publicClient.request.mock.calls.filter(([{ method }]) => method === 'eth_call').length
/** The transaction is mined: its receipt comes to every wait. */
async function mine() {
  mocks.receipt = walletReceipt()
  for (const done of mocks.waiting.splice(0)) done()
  await settle(); await settle()
}

describe('a Safe review dismissed from its enclosing modal', () => {
  // The Safe's queue holds nothing yet.
  beforeEach(() => { vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ count: 0, results: [] }))) })
  const escape = () => act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })

  it.each(['transfer', 'trust'] as const)('retains a Safe proposal for a %s after its notice is dismissed', async kind => {
    mocks.safe = true
    // A Safe proposal hash is no transaction: the node has none for it.
    mocks.publicClient.getTransaction.mockImplementation(async () => { throw Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' }) })
    const onClose = vi.fn()
    const flow = kind === 'transfer'
      ? <TransferFlow info={info} onClose={onClose} />
      : <TrustFlow chainId={CHAIN} projectId={12} info={info} sender={null} onClose={onClose} />
    if (kind === 'trust') mocks.read.mockResolvedValue(answer(false))
    await render(flow)
    await type(kind === 'transfer' ? 'Recipient' : 'Sender address', BOB)
    if (kind === 'transfer') await type('Amount', '1.123456789')
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    // The review opens, and the send follows it, with no other press.
    await press(modal(), `Review ${kind}`)

    expect(mocks.review).toHaveBeenCalledOnce()
    expect(statusLine()).toContain('Proposed to your Safe. Its other signers can approve it there.')
    expect(primary().textContent).toBe('Done')
    expect(confirm().querySelector('li')?.getAttribute('data-state')).toBe('active')
    expect(invalidate).not.toHaveBeenCalled()
    await escape()
    expect(document.querySelector('[data-tx-confirm]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()

    // Escape closes the notice; another review still follows the original reservation.
    await press(modal(), `Review ${kind}`)
    expect(mocks.sendTransaction).toHaveBeenCalledOnce()
    await escape()
    await escape()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps a pending transfer held after Escape and reopening', async () => {
    mocks.safe = true
    mocks.publicClient.getTransaction.mockImplementation(async () => { throw Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' }) })
    await render(transfer())
    await type('Recipient', BOB)
    await type('Amount', '1.987654321')
    await press(modal(), 'Review transfer')
    expect(statusLine()).toBe('Proposed to your Safe. Its other signers can approve it there.')
    expect(primary().textContent).toBe('Done')
    await escape()
    await press(modal(), 'Review transfer')
    expect(mocks.sendTransaction).toHaveBeenCalledOnce()
    expect(primary().textContent).toBe('Done')
  })
})

describe('a transfer', () => {
  async function reviewed(amount = '1.5') {
    await render(transfer())
    await type('Recipient', BOB)
    await type('Amount', amount)
    await press(modal(), 'Review transfer')
  }

  it('wallet-action:transfer-sticky-tokens reaches its one review, the simulation and the wallet as the exact transfer it showed', async () => {
    const open = holdReview()
    await reviewed('1.000000000000000001')
    expect(confirm().textContent).toContain('1.000000000000000001 STICKYART')
    expect(mocks.sendTransaction).not.toHaveBeenCalled()

    const amount = 1_000_000_000_000_000_001n
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(shown()).toMatchObject({
      title: 'Transfer',
      calls: [expect.objectContaining({ chainId: CHAIN, functionName: 'transfer', to: STICKY, from: ALICE })],
      context: expect.arrayContaining([expect.objectContaining({ label: 'Transfer', value: '1.000000000000000001 STICKYART' })]),
    })
    await open.approve()

    // That review was the only confirmation: the send opened none of its own.
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(simulations()).toBeGreaterThan(0)
    expect(mocks.sendTransaction).toHaveBeenCalledOnce()
    expect(mocks.sendTransaction.mock.calls[0][0].data).toBe(shown().calls[0].data)
    expect(sent()).toMatchObject({ to: STICKY, functionName: 'transfer', args: [BOB, amount] })
    // The balance was read for the review, and again after it and before the wallet.
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(confirm().textContent).toContain('Waiting for confirmation…')

    await mine()
    expect(confirm().textContent).toContain('Sticky tokens transferred')
    expect(confirm().querySelector('a')!.getAttribute('href')).toBe(`https://sepolia.basescan.org/tx/${HASH}`)
  })

  it("says so while the wallet's prompt is open, on the button and under the step, then waits for the chain", async () => {
    const prompt = Promise.withResolvers<string>()
    mocks.sendTransaction.mockReturnValue(prompt.promise)
    await reviewed('1')
    await settle()

    expect(mocks.sendTransaction).toHaveBeenCalledOnce()
    expect(statusLine()).toBe('Confirm in your wallet…')
    expect(primary().textContent).toBe('Confirm in your wallet…')
    expect(primary().disabled).toBe(true)

    await act(async () => prompt.resolve(HASH))
    await settle()
    expect(statusLine()).toBe('Waiting for confirmation…')
    expect(primary().textContent).toBe('Confirming…')
  })

  it('stops before the wallet when the balance has fallen since the review', async () => {
    const open = holdReview()
    await reviewed('1.5')
    mocks.read.mockResolvedValue(answer(E18))
    await open.approve()

    expect(mocks.sendTransaction).not.toHaveBeenCalled()
    expect(confirm().textContent).toContain('Your token balance changed. Review the amount.')
    expect([...confirm().querySelectorAll('footer button')].map(each => each.textContent)).toEqual(['Cancel', 'Retry'])
  })

  it('stops at the simulation when the chain refuses the transfer, and the wallet is never asked', async () => {
    mocks.publicClient.request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'eth_call') throw new Error('execution reverted')
      throw new Error(`unexpected ${method}`)
    })
    await reviewed('1')
    await settle()
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
    expect(confirm().textContent).toContain('execution reverted')
  })

  it('wallet-action:transfer-sticky-tokens sends nothing once the account that reviewed it is no longer connected: its review goes, and nothing is asked of the wallet', async () => {
    const open = holdReview()
    await reviewed('1')
    expect(document.querySelector('section[data-tx-confirm]')).not.toBeNull()
    await switchTo(BOB, transfer())
    expect(document.querySelector('section[data-tx-confirm]')).toBeNull()
    await open.approve()

    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })

  it('wallet-action:transfer-sticky-tokens refuses a send after the wallet switched accounts and before the page shows it', async () => {
    const open = holdReview()
    await reviewed('1')
    switchWalletOnly(BOB)
    await open.approve()

    expect(confirm().textContent).toContain(REVIEWED_ACCOUNT_CHANGED_LINE)
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })

  it('wallet-action:transfer-sticky-tokens sends nothing for a review approved after the account switched away and back', async () => {
    const open = holdReview()
    await reviewed('1')
    await switchTo(BOB, transfer())
    await switchTo(ALICE, transfer())
    // The review was dropped with the account change: its approval sends nothing, and the form asks for a new one.
    expect(document.querySelector('section[data-tx-confirm]')).toBeNull()
    await open.approve()

    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })
})

describe('a change of trust', () => {
  const trust = (sender: Address | null) => (
    <TrustFlow chainId={CHAIN} projectId={12} info={info} sender={sender} onClose={() => {}} />
  )

  it('wallet-action:trust-or-untrust-a-sender reaches the wallet as setTrustedSenderFor(project, sender, true), after one review and the hook was read again', async () => {
    mocks.read.mockResolvedValue(answer(false))
    await render(trust(null))
    await type('Sender address', BOB)
    await press(modal(), 'Review trust')

    await settle()
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(shown()).toMatchObject({
      title: 'Trust this sender',
      calls: [expect.objectContaining({ chainId: CHAIN, functionName: 'setTrustedSenderFor', to: HOOK, from: ALICE })],
    })
    expect(simulations()).toBeGreaterThan(0)
    expect(mocks.sendTransaction).toHaveBeenCalledOnce()
    expect(sent()).toMatchObject({ to: HOOK, functionName: 'setTrustedSenderFor', args: [12n, BOB, true] })
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it("says so while the wallet's prompt is open, on the button and under the step", async () => {
    const prompt = Promise.withResolvers<string>()
    mocks.sendTransaction.mockReturnValue(prompt.promise)
    mocks.read.mockResolvedValue(answer(false))
    await render(trust(null))
    await type('Sender address', BOB)
    await press(modal(), 'Review trust')
    await settle()

    expect(statusLine()).toBe('Confirm in your wallet…')
    expect(primary().textContent).toBe('Confirm in your wallet…')
    await act(async () => prompt.resolve(HASH))
    await settle()
    expect(statusLine()).toBe('Waiting for confirmation…')
  })

  it('wallet-action:trust-or-untrust-a-sender reaches the wallet as setTrustedSenderFor(project, sender, false) for an untrust', async () => {
    mocks.read.mockResolvedValue(answer(true))
    await render(trust(BOB))
    await press(modal(), 'Review untrust')
    await settle()
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(shown().title).toBe('Untrust this sender')
    expect(sent()).toMatchObject({ to: HOOK, functionName: 'setTrustedSenderFor', args: [12n, BOB, false] })
  })

  it('stops before the wallet when someone else has already changed the trust', async () => {
    mocks.read.mockResolvedValue(answer(false))
    const open = holdReview()
    await render(trust(null))
    await type('Sender address', BOB)
    await press(modal(), 'Review trust')
    mocks.read.mockResolvedValue(answer(true))
    await open.approve()
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
    expect(confirm().textContent).toContain('This sender is already trusted.')
  })

  /** A review of trusting BOB, made as ALICE, held open until the test approves it. */
  async function reviewedTrust() {
    const open = holdReview()
    mocks.read.mockResolvedValue(answer(false))
    await render(trust(null))
    await type('Sender address', BOB)
    await press(modal(), 'Review trust')
    return open
  }

  it('wallet-action:trust-or-untrust-a-sender sends nothing once the account that reviewed it is no longer connected: its review goes, and nothing is asked of the wallet', async () => {
    const open = await reviewedTrust()
    expect(document.querySelector('section[data-tx-confirm]')).not.toBeNull()
    await switchTo(BOB, trust(null))
    expect(document.querySelector('section[data-tx-confirm]')).toBeNull()
    await open.approve()

    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })

  it('wallet-action:trust-or-untrust-a-sender refuses a send after the wallet switched accounts and before the page shows it', async () => {
    const open = await reviewedTrust()
    switchWalletOnly(BOB)
    await open.approve()

    expect(confirm().textContent).toContain(REVIEWED_ACCOUNT_CHANGED_LINE)
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })

  it('wallet-action:trust-or-untrust-a-sender sends nothing for a review approved after the account switched away and back', async () => {
    const open = await reviewedTrust()
    await switchTo(BOB, trust(null))
    await switchTo(ALICE, trust(null))
    expect(document.querySelector('section[data-tx-confirm]')).toBeNull()
    await open.approve()

    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })
})
