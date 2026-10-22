// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress, toHex, type Hex, type TransactionReceipt } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { TOKEN, stickyInfo } from '../home-fixtures'

// The normal path of a stick (a pay) and an unstick (a cash-out) on the real transaction engine: the clicks it takes
// and every line the dialog shows on the way, from the first confirm to the confirmed result. These are main's
// numbers and lines; adopting the SDK's held write adds no step, notice or wait.

const CHAIN = 84532
const PROJECT = 23
const TERMINAL = stickyDeployment(CHAIN)!.terminal
const ALICE = getAddress(`0x${'a'.repeat(40)}`)
const CPN = 10n ** 6n
const APPROVAL = `0x${'a1'.repeat(32)}` as Hex
const STICK = `0x${'b2'.repeat(32)}` as Hex
const UNSTICK = `0x${'c3'.repeat(32)}` as Hex

const mocks = vi.hoisted(() => ({
  publicClient: {
    chain: { id: 84532 }, getBlockNumber: vi.fn(async () => 100n), getTransactionCount: vi.fn(async () => 7), simulateContract: vi.fn(), estimateContractGas: vi.fn(),
    estimateGas: vi.fn(async () => 50_000n), getGasPrice: vi.fn(async () => 1n), getChainId: vi.fn(), getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getBlock: vi.fn(),
    waitForTransactionReceipt: vi.fn(), readContract: vi.fn(async () => { throw new Error('no reads here') }),
    request: vi.fn(async ({ method }: { method: string }) => { if (method === 'eth_call') return '0x'; throw new Error(`unexpected ${method}`) }),
  },
  getAccount: vi.fn(),
  /** An action's one decoded review of every step. */
  review: vi.fn(),
  /** The wallet: what it was asked to send, by the hash it answered. */
  sendTransaction: vi.fn(),
  sent: {} as Record<string, { to: Hex; data: Hex; value: bigint }>,
  receipts: {} as Record<string, TransactionReceipt>,
  transactions: {} as Record<string, unknown>,
  blocks: {} as Record<string, { hash: Hex; number: bigint; timestamp: bigint }>,
  readAt: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({
  getAccount: mocks.getAccount, getPublicClient: () => mocks.publicClient, switchChain: vi.fn(),
  getWalletClient: async () => ({ chain: { id: 84532 }, sendTransaction: mocks.sendTransaction }),
}))
vi.mock('wagmi', () => ({ usePublicClient: () => mocks.publicClient }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ isConnected: true, address: ALICE, isCenterWallet: false, openSignIn: vi.fn() }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
}))
vi.mock('@/lib/sticky-project', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-project')>()),
  readStickyProject: async () => stickyInfo(CHAIN, BigInt(PROJECT), { symbol: 'CPN', decimals: 6, stSymbol: 'STICKYCPN', stakedToken: TOKEN }),
}))
vi.mock('@/lib/sticky-holders', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-holders')>()),
  readStickyPosition: async () => ({ staked: 0n, wallet: 100n * CPN, start: 0, current: 0, longest: 0, blockNumber: 1n, timestamp: 1_790_000_000 }),
}))
vi.mock('@/lib/sticky-quotes', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-quotes')>()),
  quoteStick: async () => 9_870_000_000_000_000_000n,
  assertCanStickFor: async () => undefined,
  quoteUnstick: async () => ({ gross: 4n * 10n ** 18n, tax: 1_000n, fee: 0n, net: 4n * 10n ** 18n }),
}))
vi.mock('@/lib/sticky-allowance', () => ({ readBalanceAndAllowance: async () => ({ balance: 100n * CPN, allowance: 0n }) }))
vi.mock('@/lib/sticky-rewards', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-rewards')>()),
  readAt: mocks.readAt,
}))
vi.mock('@/lib/preflight', async importOriginal => ({ ...(await importOriginal<typeof import('@/lib/preflight')>()), preflight: async () => undefined }))
vi.mock('@/hooks/useSettled', () => ({ useSettled: <T,>(value: T) => value }))

import { registerReviewHandler } from '@bananapus/nana-sdk-core/review'
import { StickFlow } from '@/components/project/flows/StickFlow'
import { UnstickFlow } from '@/components/project/flows/UnstickFlow'

let host: HTMLDivElement
let root: Root
let client: QueryClient
let clicks = 0
let unregister = () => {}

beforeEach(() => {
  clicks = 0
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.getAccount.mockImplementation(() => ({ address: ALICE, chainId: CHAIN }))
  mocks.review.mockReset()
  unregister = registerReviewHandler(async prompt => { mocks.review(prompt.model); return prompt.confirmation })
  mocks.sent = {}
  mocks.publicClient.simulateContract.mockImplementation(async (request: object) => ({ request: { ...request } }))
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  mocks.publicClient.getChainId.mockResolvedValue(CHAIN)
  mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
    const transaction = mocks.transactions[hash.toLowerCase()]
    if (!transaction) throw new Error('Transaction not found')
    return transaction
  })
  mocks.publicClient.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
    const receipt = mocks.receipts[hash.toLowerCase()]
    if (!receipt) throw new Error('Receipt not found')
    return receipt
  })
  mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
    while (!mocks.receipts[hash.toLowerCase()]) await new Promise(resolve => setTimeout(resolve, 5))
    return mocks.receipts[hash.toLowerCase()]
  })
  mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => {
    const block = mocks.blocks[String(blockNumber)]
    if (!block) throw new Error('Block not found')
    return block
  })
  mocks.sendTransaction.mockReset()
  mocks.readAt.mockReset().mockResolvedValue([{ status: 'success', result: 10n * 10n ** 18n }, { status: 'success', result: [0n, 0, 0, false] }, { status: 'success', result: false }, { status: 'success', result: 0n }])
  mocks.receipts = {}
  mocks.transactions = {}
  mocks.blocks = {}
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
})

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function until(check: () => unknown, what: string) {
  for (let waited = 0; waited < 3_000; waited += 10) {
    if (check()) return
    await act(async () => void (await sleep(10)))
  }
  throw new Error(`timed out waiting for ${what}`)
}
const confirmButton = () => [...document.querySelectorAll<HTMLButtonElement>('dialog footer button.btn-primary')].at(-1) ?? null
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label && !item.closest('dialog'))!
const title = () => [...document.querySelectorAll('dialog h2')].map(item => item.textContent).at(-1)
const anyButton = (label: string) => [...document.querySelectorAll('button')].find(item => item.textContent === label)!
/** Every status line and notice on screen now: the dialog's status line and any role=status or alert text. */
const notices = () => [
  ...[...document.querySelectorAll('p.text-bluebs-700')].map(item => item.textContent),
  ...[...document.querySelectorAll('[role="status"],[role="alert"]')].map(item => item.textContent),
].filter(Boolean)
async function click(target: HTMLElement) {
  clicks += 1
  await act(async () => target.click())
}
async function type(label: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** The wallet answers each send with the next hash, and the chain knows what it was asked to send. */
function answers(...hashes: Hex[]) {
  for (const hash of hashes) mocks.sendTransaction.mockImplementationOnce(async (tx: { to: Hex; data: Hex; value?: bigint }) => {
    mocks.sent[hash.toLowerCase()] = { to: tx.to, data: tx.data, value: tx.value ?? 0n }
    return hash
  })
}
async function mined(hash: Hex, block: bigint, render: () => void) {
  const request = mocks.sent[hash.toLowerCase()]
  const blockHash = toHex(block, { size: 32 })
  mocks.blocks[String(block)] = { hash: blockHash, number: block, timestamp: 1_790_000_000n + block }
  mocks.transactions[hash.toLowerCase()] = {
    hash, chainId: CHAIN, from: ALICE, to: request.to, input: request.data,
    value: request.value, blockHash, blockNumber: block, transactionIndex: 0,
  }
  mocks.receipts[hash.toLowerCase()] = {
    transactionHash: hash, status: 'success', blockNumber: block, blockHash, transactionIndex: 0,
    from: ALICE, to: request.to, contractAddress: null, logs: [], logsBloom: `0x${'0'.repeat(512)}`,
    cumulativeGasUsed: 50_000n, gasUsed: 50_000n, effectiveGasPrice: 1n, type: 'eip1559',
  }
  await act(async () => render())
}

describe('the normal path adds no click, notice or wait', () => {
  it('a stick (pay): approve, then stick, one review of both and only the waiting line and the transaction link', async () => {
    const tree = () => root.render(<QueryClientProvider client={client}><StickFlow chainId={CHAIN} projectId={PROJECT} /></QueryClientProvider>)
    answers(APPROVAL, STICK)
    await act(async () => tree())
    await until(() => host.querySelector('input'), 'the Stick card')
    await type('Amount of underlying tokens to stick', '5')
    await until(() => button('Stick') && !button('Stick').disabled, 'the Stick button')
    // Stick is the only click: its one review shows both steps, and each is sent as the one before confirms.
    await click(button('Stick'))
    await until(() => mocks.sendTransaction.mock.calls.length === 1 && confirmButton()?.textContent === 'Confirming…', 'the approval to be sent')
    const seen: string[][] = [notices()]
    await mined(APPROVAL, 4_001n, tree)
    await until(() => mocks.sendTransaction.mock.calls.length === 2 && confirmButton()?.textContent === 'Confirming…', 'the stick to be sent')
    seen.push(notices())
    await mined(STICK, 4_005n, tree)
    await until(() => title() === 'Stick confirmed', 'the stick to be counted')
    seen.push(notices())

    expect(clicks).toBe(1)
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(seen).toEqual([['Waiting for confirmation…'], ['Waiting for confirmation…'], ['View transaction ↗']])
  })

  it('an unstick (cash-out): one review and only the waiting line and the transaction link', async () => {
    const info = stickyInfo(CHAIN, BigInt(PROJECT), { stSymbol: 'STICKYCPN' })
    const tree = () => root.render(<QueryClientProvider client={client}><UnstickFlow chainId={CHAIN} projectId={PROJECT} info={info} onClose={() => {}} /></QueryClientProvider>)
    answers(UNSTICK)
    await act(async () => tree())
    await type('Amount of Sticky tokens to unstick', '5')
    await until(() => anyButton('Unstick') && !anyButton('Unstick').disabled, 'the Unstick button')
    // Unstick is the only click: its one review opens on its own, and the unstick is sent under it.
    await click(anyButton('Unstick'))
    await until(() => mocks.sendTransaction.mock.calls.length === 1 && confirmButton()?.textContent === 'Confirming…', 'the unstick to be sent')
    const seen: string[][] = [notices()]
    await mined(UNSTICK, 4_010n, tree)
    await until(() => title() === 'Unstick confirmed', 'the unstick to be counted')
    seen.push(notices())

    expect(clicks).toBe(1)
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(mocks.review.mock.calls[0][0].calls).toEqual([expect.objectContaining({ to: TERMINAL, functionName: 'cashOutTokensOf' })])
    expect(seen).toEqual([['Waiting for confirmation…View transaction ↗'], ['View transaction ↗']])
  })
})
