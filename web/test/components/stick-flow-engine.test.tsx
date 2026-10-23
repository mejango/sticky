// @vitest-environment jsdom

import { jbMultiTerminalAbi } from '@bananapus/nana-sdk-core'
import { HELD_EXIT_LABEL, registerReviewHandler, REVIEWED_ACCOUNT_CHANGED_LINE, writeHeldMessage, type ReviewModel, NETWORK_ERROR_LINE } from '@bananapus/nana-sdk-core/review'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { decodeFunctionData, erc20Abi, getAddress, toHex, UserRejectedRequestError, type Address, type Hex, type TransactionReceipt } from 'viem'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { TOKEN, stickyInfo } from '../home-fixtures'

// The stick flow on the real transaction engine: core's reviewed run goes as it does in the app, and only wagmi, the
// wallet, the chain, the reads and the review dialog are mocks. stick-flow.test.tsx mocks the engine, so it cannot see what the flow does
// with the engine's real phases and its lock: the one review of the whole stick, a step that fails or is refused, an
// account that changes, and the stick sent on its own once the approval confirms, as a browser schedules it.

const CHAIN = 84532
const PROJECT = 23
const TERMINAL = stickyDeployment(CHAIN)!.terminal
const ALICE = getAddress(`0x${'a'.repeat(40)}`)
const FRIEND = getAddress(`0x${'9'.repeat(40)}`)
const BOB = getAddress(`0x${'b'.repeat(40)}`)
const CPN = 10n ** 6n
const MINTED = 9_870_000_000_000_000_000n
const APPROVAL = `0x${'a1'.repeat(32)}` as Hex
const STICK = `0x${'b2'.repeat(32)}` as Hex

const mocks = vi.hoisted(() => ({
  wallet: {} as { isConnected: boolean; address: string | undefined; isCenterWallet: boolean; openSignIn: ReturnType<typeof vi.fn> },
  publicClient: {
    chain: { id: 84532 }, getBlockNumber: vi.fn(async () => 100n), getTransactionCount: vi.fn(async () => 7), getChainId: vi.fn(), getTransaction: vi.fn(),
    getTransactionReceipt: vi.fn(), waitForTransactionReceipt: vi.fn(), getBlock: vi.fn(), estimateGas: vi.fn(async () => 50_000n), getGasPrice: vi.fn(async () => 1n),
    readContract: vi.fn(async () => { throw new Error('no reads here') }),
    /** The chain's simulations (eth_call): each succeeds, unless a test refuses one. */
    request: vi.fn(),
  },
  getAccount: vi.fn(),
  /** The action's one decoded review of every step: the test sees its model, and answers it (confirms by default). */
  review: vi.fn(),
  /** The wallet: what it was asked to send, by the hash it answered. */
  sendTransaction: vi.fn(),
  sent: {} as Record<string, { account: Address; to: Address; data: Hex; value: bigint }>,
  /** The receipts the chain has, by lowercase hash. */
  receipts: {} as Record<string, TransactionReceipt>,
  transactions: {} as Record<string, unknown>,
  blocks: {} as Record<string, { hash: Hex; number: bigint; timestamp: bigint }>,
  project: vi.fn(),
  position: vi.fn(),
  quote: vi.fn(),
  canStick: vi.fn(),
  funds: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({
  getAccount: mocks.getAccount, getPublicClient: () => mocks.publicClient, switchChain: vi.fn(),
  getWalletClient: async () => ({ chain: { id: 84532 }, sendTransaction: mocks.sendTransaction }),
}))
vi.mock('wagmi', () => ({ usePublicClient: () => mocks.publicClient }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  SAFE_NONCE_GUIDANCE: 'Safe nonce guidance',
  useSafeConnection: () => false,
  waitForSafeExecutionHash: vi.fn(),
}))
vi.mock('@/lib/sticky-project', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-project')>()),
  readStickyProject: mocks.project,
}))
vi.mock('@/lib/sticky-holders', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-holders')>()),
  readStickyPosition: mocks.position,
}))
vi.mock('@/lib/sticky-quotes', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-quotes')>()),
  quoteStick: mocks.quote,
  assertCanStickFor: mocks.canStick,
}))
vi.mock('@/lib/sticky-allowance', () => ({ readBalanceAndAllowance: mocks.funds }))

import { StickFlow } from '@/components/project/flows/StickFlow'
// The review loads when Stick is first pressed; the tests' fake clock cannot wait for a module to load.
beforeAll(() => import('@/components/project/flows/StickSend'))

let host: HTMLDivElement
let root: Root
let client: QueryClient
/** Whether React is told it runs under act(), which the tests of a race are not: they run it as a browser does. */
let acting = true
/** Whether the flow sticks for someone else, as the Airdrops tab's form does. */
let gift = false
let unregister = () => {}

beforeEach(() => {
  acting = true
  gift = false
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.wallet = { isConnected: true, address: ALICE, isCenterWallet: false, openSignIn: vi.fn() }
  mocks.getAccount.mockImplementation(() => ({ address: ALICE, chainId: CHAIN }))
  mocks.review.mockReset().mockResolvedValue(true)
  unregister = registerReviewHandler(async prompt => ((await mocks.review(prompt.model)) ? prompt.confirmation : null))
  mocks.publicClient.request.mockReset().mockImplementation(async ({ method }: { method: string }) => {
    if (method === 'eth_call') return '0x'
    throw new Error(`unexpected ${method}`)
  })
  mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => {
    while (!mocks.receipts[hash.toLowerCase()]) await new Promise(resolve => setTimeout(resolve, 5))
    return mocks.receipts[hash.toLowerCase()]
  })
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
  mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => {
    const block = mocks.blocks[String(blockNumber)]
    if (!block) throw new Error('Block not found')
    return block
  })
  mocks.sendTransaction.mockReset()
  mocks.sent = {}
  mocks.receipts = {}
  mocks.transactions = {}
  mocks.blocks = {}
  mocks.project.mockReset().mockImplementation(async () =>
    stickyInfo(CHAIN, BigInt(PROJECT), { symbol: 'CPN', decimals: 6, stSymbol: 'STICKYCPN', stakedToken: TOKEN }),
  )
  mocks.position.mockReset().mockResolvedValue({
    staked: 0n,
    wallet: 100n * CPN,
    start: 0,
    current: 0,
    longest: 0,
    blockNumber: 1n,
    timestamp: 1_790_000_000,
  })
  mocks.quote.mockReset().mockResolvedValue(MINTED)
  mocks.canStick.mockReset().mockResolvedValue(undefined)
  mocks.funds.mockReset().mockResolvedValue({ balance: 100n * CPN, allowance: 0n })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  unregister()
  if (acting) await act(async () => root.unmount())
  else root.unmount()
  host.remove()
  client.clear()
})

const tree = () => (
  <QueryClientProvider client={client}>
    <StickFlow chainId={CHAIN} projectId={PROJECT} forSomeoneElse={gift} />
  </QueryClientProvider>
)
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
/** Lets time pass, in act() or not as the test runs. */
const pump = () => (acting ? act(async () => void (await sleep(10))) : sleep(10))
async function until(check: () => unknown, what: string) {
  for (let waited = 0; waited < 3_000; waited += 10) {
    if (check()) return
    await pump()
  }
  throw new Error(`timed out waiting for ${what}; the dialog shows: ${dialog()?.textContent ?? "nothing"}`)
}
const inAct = (work: () => void) => (acting ? act(async () => work()) : Promise.resolve(work()))

const dialog = () => document.querySelector('dialog')
const confirmButton = () => dialog()?.querySelector<HTMLButtonElement>('footer button.btn-primary') ?? null
const flowButton = (label: string) =>
  [...host.querySelectorAll('button')].find(button => button.textContent === label && !button.closest('dialog'))!
const stepStates = () => [...(dialog()?.querySelectorAll('ol li') ?? [])].map(item => item.getAttribute('data-state'))
const title = () => dialog()?.querySelector('h2')?.textContent
const ABI = [...erc20Abi, ...jbMultiTerminalAbi]
const writes = () => mocks.sendTransaction.mock.calls.map(([tx]) => decodeFunctionData({ abi: ABI, data: tx.data }).functionName)
/** The account each write was sent as, in order. */
const senders = () => mocks.sendTransaction.mock.calls.map(([tx]) => tx.account?.address ?? tx.account)
/** The wallet answers each send with the next hash, and the chain knows what it was asked to send. */
function answers(...hashes: Hex[]) {
  for (const hash of hashes) mocks.sendTransaction.mockImplementationOnce(async (tx: { account: Address; to: Address; data: Hex; value?: bigint }) => {
    mocks.sent[hash.toLowerCase()] = { account: tx.account, to: tx.to, data: tx.data, value: tx.value ?? 0n }
    return hash
  })
}
/** A held review: the test approves it when it is ready. */
function heldReview() {
  const review = Promise.withResolvers<boolean>()
  mocks.review.mockReturnValueOnce(review.promise)
  return { resolve: () => review.resolve(true) }
}
/** The wallet switches to `account`, and the page renders it. */
async function switchTo(account: Address) {
  mocks.wallet = { ...mocks.wallet, address: account }
  mocks.getAccount.mockImplementation(() => ({ address: account, chainId: CHAIN }))
  await act(async () => root.render(tree()))
}

const typeInto = (label: string, value: string) => {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  return inAct(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * An amount typed, Stick pressed, and the plan listed, its one review opened. With `gift`, the recipient is FRIEND.
 * `listed: false` waits for the review alone, for a run that may close before its steps are seen.
 */
async function openReview({ listed = true } = {}) {
  const reviews = mocks.review.mock.calls.length
  if (acting) await act(async () => root.render(tree()))
  else root.render(tree())
  await until(() => host.querySelector('input'), 'the Stick card')
  if (gift) await typeInto('Recipient address', FRIEND)
  await typeInto('Amount of underlying tokens to stick', '5')
  const label = gift ? 'Review stick' : 'Stick'
  await until(() => flowButton(label) && !flowButton(label).disabled, 'the Stick button to open')
  await inAct(() => flowButton(label).click())
  await until(() => (!listed || stepStates().length > 0) && mocks.review.mock.calls.length > reviews, 'the review to list its steps')
}
/** The calls review `at` showed, as the account that reviewed them. */
const shown = (at = 0) => mocks.review.mock.calls[at][0] as ReviewModel
const reviewed = (at = 0) => shown(at).calls.map(call => [call.functionName, call.from])
/** The chain has mined `hash` in `block`, and the flow renders again. */
async function mined(hash: Hex, block: bigint) {
  const request = mocks.sent[hash.toLowerCase()]
  if (!request) throw new Error('Cannot mine a transaction that the wallet was not asked to send')
  const blockHash = toHex(block, { size: 32 })
  mocks.blocks[String(block)] = { hash: blockHash, number: block, timestamp: 1_790_000_000n + block }
  mocks.transactions[hash.toLowerCase()] = {
    hash, chainId: CHAIN, from: request.account, to: request.to,
    input: request.data, value: request.value, nonce: 7, blockHash, blockNumber: block, transactionIndex: 0,
  }
  mocks.receipts[hash.toLowerCase()] = {
    transactionHash: hash, status: 'success', blockNumber: block, blockHash, transactionIndex: 0,
    from: request.account, to: request.to, contractAddress: null, logs: [], logsBloom: `0x${'0'.repeat(512)}`,
    cumulativeGasUsed: 50_000n, gasUsed: 50_000n, effectiveGasPrice: 1n, type: 'eip1559',
  }
  if (acting) await act(async () => root.render(tree()))
  else root.render(tree())
}

describe('the stick flow on the real engine', () => {
  it('wallet-action:approve-the-staked-token-for-a-stick wallet-action:stick shows the whole stick in one review, sends each step once as the one before confirms, and never asks again', async () => {
    answers(APPROVAL, STICK)
    await openReview()
    await until(() => mocks.sendTransaction.mock.calls.length === 1, 'the approval to be sent')
    expect(reviewed()).toEqual([['approve', ALICE], ['pay', ALICE]])
    expect(shown()).toMatchObject({
      title: 'Stick',
      context: expect.arrayContaining([expect.objectContaining({ label: 'Stick', value: '5 CPN' })]),
    })
    // A press while a step is out sends nothing more.
    await act(async () => confirmButton()!.click())
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(1)

    await mined(APPROVAL, 4_001n)
    await until(() => mocks.sendTransaction.mock.calls.length === 2, 'the stick to be sent')
    expect(stepStates()).toEqual(['complete', 'active'])
    expect(writes()).toEqual(['approve', 'pay'])
    // The stick is simulated at the block of the approval, not at a head that may not have it.
    const stickSimulations = mocks.publicClient.request.mock.calls.filter(([{ method, params }]) => method === 'eth_call' && params[0].to?.toLowerCase() === TERMINAL.toLowerCase())
    expect(stickSimulations.at(-1)![0].params[1]).toBe(toHex(4_001n))

    await mined(STICK, 4_005n)
    await until(() => title() === 'Stick confirmed', 'the stick to be counted')
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(2)
    // One confirmation for the whole stick: no step opened a review of its own.
    expect(mocks.review).toHaveBeenCalledOnce()
  })

  it('reviews only the stick again for a Retry after its simulation failed, never the approval that landed', async () => {
    answers(APPROVAL, STICK)
    await openReview()
    await until(() => mocks.sendTransaction.mock.calls.length === 1, 'the approval to be sent')
    // The chain refuses the stick's next simulation.
    const simulate = mocks.publicClient.request.getMockImplementation()!
    let refused = false
    mocks.publicClient.request.mockImplementation(async (request: { method: string; params: [{ to?: string }, string?] }) => {
      if (!refused && request.method === 'eth_call' && request.params[0].to?.toLowerCase() === TERMINAL.toLowerCase() && request.params[1] === toHex(4_001n)) {
        refused = true
        throw new Error('execution reverted: price moved')
      }
      return simulate(request)
    })
    await mined(APPROVAL, 4_001n)
    await until(() => confirmButton()?.textContent === 'Retry', 'the stick to fail')
    expect(dialog()!.textContent).toContain(NETWORK_ERROR_LINE)
    expect(stepStates()).toEqual(['complete', 'active'])
    expect(mocks.sendTransaction).toHaveBeenCalledTimes(1)

    await act(async () => confirmButton()!.click())
    await until(() => mocks.sendTransaction.mock.calls.length === 2, 'the stick to be sent')
    expect(writes()).toEqual(['approve', 'pay'])
    expect(mocks.review).toHaveBeenCalledTimes(2)
    expect(reviewed(1)).toEqual([['pay', ALICE]])
  })

  it('closes with nothing sent when its one review is cancelled', async () => {
    mocks.review.mockResolvedValueOnce(false)
    await act(async () => root.render(tree()))
    await until(() => host.querySelector('input'), 'the Stick card')
    await typeInto('Amount of underlying tokens to stick', '5')
    await until(() => flowButton('Stick') && !flowButton('Stick').disabled, 'the Stick button to open')
    await act(async () => flowButton('Stick').click())
    await until(() => mocks.review.mock.calls.length === 1 && !dialog(), 'the review to be cancelled')
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })

  it("says so while the wallet's prompt is open, on the button and under the step, then waits for the chain", async () => {
    const prompt = Promise.withResolvers<Hex>()
    mocks.sendTransaction.mockImplementationOnce(async (tx: { account: Address; to: Address; data: Hex; value?: bigint }) => {
      mocks.sent[APPROVAL] = { account: tx.account, to: tx.to, data: tx.data, value: tx.value ?? 0n }
      return prompt.promise
    })
    await openReview()
    const statusLine = () => dialog()?.querySelector('p.text-bluebs-700')?.textContent ?? null

    await until(() => mocks.sendTransaction.mock.calls.length === 1, 'the wallet to be asked')
    expect(statusLine()).toBe('Confirm in your wallet…')
    expect(confirmButton()!.textContent).toBe('Confirm in your wallet…')
    expect(confirmButton()!.disabled).toBe(true)

    await act(async () => prompt.resolve(APPROVAL))
    await until(() => statusLine() === 'Waiting for confirmation…', 'the wait for the chain')
    expect(confirmButton()!.textContent).toBe('Confirming…')
  })

  it('closes with nothing held when the wallet refused the approval, and the next Stick reviews both steps again', async () => {
    mocks.sendTransaction.mockRejectedValueOnce(new UserRejectedRequestError(new Error('User rejected the request.')))
    answers(APPROVAL)
    await openReview({ listed: false })
    await until(() => !dialog(), 'the refused review to close')
    expect(writes()).toEqual(['approve'])

    await openReview()
    await until(() => mocks.sendTransaction.mock.calls.length === 2, 'the approval to be sent again')
    expect(writes()).toEqual(['approve', 'approve'])
    expect(reviewed(1)).toEqual([['approve', ALICE], ['pay', ALICE]])
  })

  it('retains an ambiguous approval across dismissal and reopening without offering another wallet submission', async () => {
    mocks.sendTransaction.mockRejectedValueOnce(new Error('Connection lost after sending'))
    await openReview()
    await until(() => confirmButton()?.textContent === 'Done', 'the unresolved approval to be held')
    expect(stepStates()).toEqual(['active', 'pending'])
    expect(dialog()!.textContent).toContain(writeHeldMessage())
    expect(dialog()!.textContent).toContain(HELD_EXIT_LABEL)
    expect(writes()).toEqual(['approve'])
    await act(async () => confirmButton()!.click())
    await until(() => !dialog(), 'the held review to close')
    // Stick again opens no review: the held approval shows in its place.
    const reviews = mocks.review.mock.calls.length
    await inAct(() => flowButton('Stick').click())
    await until(() => confirmButton()?.textContent === 'Done', 'the original unresolved approval to be restored')
    expect(mocks.review.mock.calls.length).toBe(reviews)
    expect(writes()).toEqual(['approve'])
    expect(stepStates()).toEqual(['active', 'pending'])
  })
})

describe('a stick for someone else on the real engine', () => {
  it('wallet-action:stick-for-someone-else reaches the review, the simulation and the wallet as a pay for the recipient, once the sender may stick for them', async () => {
    gift = true
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    answers(STICK)
    await openReview()
    // The review asked the hook again whether the sender may stick for the recipient.
    expect(mocks.canStick).toHaveBeenLastCalledWith(CHAIN, BigInt(PROJECT), ALICE, FRIEND, expect.anything())

    await until(() => mocks.sendTransaction.mock.calls.length === 1, 'the stick to be sent')
    expect(mocks.review).toHaveBeenCalledOnce()
    expect(shown()).toMatchObject({
      title: 'Stick for someone else',
      calls: [expect.objectContaining({ chainId: CHAIN, functionName: 'pay', to: TERMINAL, from: ALICE })],
      context: expect.arrayContaining([expect.objectContaining({ label: 'For', value: FRIEND })]),
    })
    const [tx] = mocks.sendTransaction.mock.calls[0]
    expect(tx.data).toBe(shown().calls[0].data)
    expect(decodeFunctionData({ abi: ABI, data: tx.data }).args).toEqual([BigInt(PROJECT), TOKEN, 5n * CPN, FRIEND, MINTED, '', '0x'])
    expect(writes()).toEqual(['pay'])
  })

  // The plan is the reviewing account's: its trust check and its quote were for that sender. The flow hands the engine
  // that account with every step, and the engine refuses to send it from any other.
  it('wallet-action:stick-for-someone-else sends nothing when the wallet switches accounts while the review is open, and the dialog says why', async () => {
    gift = true
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    const review = heldReview()
    await openReview()

    await switchTo(BOB)
    await act(async () => review.resolve())
    await until(() => confirmButton()?.textContent === 'Retry', 'the refusal')

    expect(dialog()!.textContent).toContain(REVIEWED_ACCOUNT_CHANGED_LINE)
    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })

  it('wallet-action:stick-for-someone-else goes on once the account that reviewed the stick is connected again, as that account', async () => {
    gift = true
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    answers(STICK)
    const review = heldReview()
    await openReview()
    await switchTo(BOB)
    await act(async () => review.resolve())
    await until(() => confirmButton()?.textContent === 'Retry', 'the refusal')
    expect(mocks.sendTransaction).not.toHaveBeenCalled()

    await switchTo(ALICE)
    await act(async () => confirmButton()!.click())
    await until(() => mocks.sendTransaction.mock.calls.length === 1, 'the stick to be sent')
    expect(senders()).toEqual([ALICE])
    expect(writes()).toEqual(['pay'])
    expect(reviewed(1)).toEqual([['pay', ALICE]])
  })
})

describe('a stick whose account changes after its review, on the real engine', () => {
  it('wallet-action:approve-the-staked-token-for-a-stick wallet-action:stick sends the stick from no account but the one that approved, once it has landed', async () => {
    answers(APPROVAL)
    await openReview()
    await until(() => mocks.sendTransaction.mock.calls.length === 1, 'the approval to be sent')

    await switchTo(BOB)
    await mined(APPROVAL, 4_001n)
    await until(() => dialog()!.textContent!.includes(REVIEWED_ACCOUNT_CHANGED_LINE), 'the stick to be refused')

    // Only ALICE's approval reached the wallet.
    // ponytail: the dialog cannot mark the approval complete here, as core reports no step's confirmation on its own
    // (only the next step's start); assert it once core's progress does.
    expect(writes()).toEqual(['approve'])
    expect(senders()).toEqual([ALICE])
  })

  // The wallet's account changes while the review is open, and the page has not rendered it yet: the page still shows
  // the account that reviewed the plan, and the wallet is already another's.
  it.each([
    ['a stick', false],
    ['a stick for someone else', true],
  ])('wallet-action:stick wallet-action:stick-for-someone-else refuses %s once its review closes, while the page still shows the old account', async (_, forSomeoneElse) => {
    gift = forSomeoneElse
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    const review = heldReview()
    await openReview()

    mocks.getAccount.mockImplementation(() => ({ address: BOB, chainId: CHAIN }))
    await act(async () => review.resolve())
    await until(() => dialog()!.textContent!.includes(REVIEWED_ACCOUNT_CHANGED_LINE), 'the refusal')

    expect(mocks.sendTransaction).not.toHaveBeenCalled()
  })
})

// The stick follows its approval's confirmation in the same run, as a browser schedules it: sent once, with no click
// and no second review.
describe('the stick after its approval confirms, as a browser schedules it', () => {
  beforeEach(() => {
    acting = false
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
  })

  it('is sent once, on its own, never the approval again', async () => {
    answers(APPROVAL, STICK)
    await openReview()
    await until(() => mocks.sendTransaction.mock.calls.length === 1, 'the approval to be sent')
    await mined(APPROVAL, 4_001n)
    await until(() => mocks.sendTransaction.mock.calls.length === 2, 'the stick to be sent')
    // Time for anything else the confirmation started.
    await sleep(100)
    expect(writes()).toEqual(['approve', 'pay'])
    expect(title()).toBe('Confirm stick')
    expect(mocks.review).toHaveBeenCalledOnce()
  })

})
