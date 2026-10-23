// @vitest-environment jsdom

import { HELD_EXIT_LABEL, writeHeldMessage } from '@bananapus/nana-sdk-core/review'
import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { encodeFunctionData, getAddress, toHex, UserRejectedRequestError, type Address, type Hex, type TransactionReceipt } from 'viem'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVIEWED_ACCOUNT_CHANGED } from '@/lib/contract-write'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { TransactionReviewCancelledError } from '@/lib/transaction-review'
import { TOKEN, stickyInfo } from '../home-fixtures'

// The stick flow on the real transaction engine: `useSafeTx` runs as it does in the app, and only wagmi, the wallet, the
// reads and the engine's own reviews are mocks. stick-flow.test.tsx mocks the engine, so it cannot see what the flow does
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
  publicClient: { getBlockNumber: vi.fn(async () => 100n), getTransactionCount: vi.fn(async () => 7), simulateContract: vi.fn(), estimateContractGas: vi.fn(), getChainId: vi.fn(), getTransaction: vi.fn(), getTransactionReceipt: vi.fn(), getBlock: vi.fn() },
  getAccount: vi.fn(),
  requestReview: vi.fn(),
  /** The action's one decoded review of every step. */
  requireReview: vi.fn(),
  switchChain: vi.fn(),
  writeContract: vi.fn(),
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

vi.mock('@wagmi/core', () => ({ getAccount: mocks.getAccount }))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: mocks.switchChain }),
  useWaitForTransactionReceipt: ({ hash }: { hash?: string }) => ({
    data: hash ? mocks.receipts[hash.toLowerCase()] : undefined,
    isError: false,
  }),
  useWriteContract: () => ({ writeContractAsync: mocks.writeContract }),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: mocks.requestReview,
  requireTransactionReview: mocks.requireReview,
}))
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

beforeEach(() => {
  acting = true
  gift = false
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.wallet = { isConnected: true, address: ALICE, isCenterWallet: false, openSignIn: vi.fn() }
  mocks.getAccount.mockImplementation(() => ({ address: ALICE, chainId: CHAIN }))
  mocks.requestReview.mockReset().mockResolvedValue(true)
  mocks.requireReview.mockReset().mockResolvedValue(undefined)
  mocks.switchChain.mockResolvedValue(undefined)
  mocks.publicClient.simulateContract.mockImplementation(async (request: { address: string; functionName: string; account: string }) => ({
    request: { ...request },
  }))
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
  mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => {
    const block = mocks.blocks[String(blockNumber)]
    if (!block) throw new Error('Block not found')
    return block
  })
  mocks.writeContract.mockReset()
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
  throw new Error(`timed out waiting for ${what}`)
}
const inAct = (work: () => void) => (acting ? act(async () => work()) : Promise.resolve(work()))

const dialog = () => document.querySelector('dialog')
const confirmButton = () => dialog()?.querySelector<HTMLButtonElement>('footer button.btn-primary') ?? null
const flowButton = (label: string) =>
  [...host.querySelectorAll('button')].find(button => button.textContent === label && !button.closest('dialog'))!
const stepStates = () => [...(dialog()?.querySelectorAll('ol li') ?? [])].map(item => item.getAttribute('data-state'))
const title = () => dialog()?.querySelector('h2')?.textContent
const writes = () => mocks.writeContract.mock.calls.map(([request]) => request.functionName)
/** The account each write was simulated and sent as, in order. */
const senders = () => mocks.writeContract.mock.calls.map(([request]) => request.account)
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

/** An amount typed, Stick pressed, and the plan listed, its one review opened. With `gift`, the recipient is FRIEND. */
async function openReview() {
  const reviews = mocks.requireReview.mock.calls.length
  if (acting) await act(async () => root.render(tree()))
  else root.render(tree())
  await until(() => host.querySelector('input'), 'the Stick card')
  if (gift) await typeInto('Recipient address', FRIEND)
  await typeInto('Amount of underlying tokens to stick', '5')
  const label = gift ? 'Review stick' : 'Stick'
  await until(() => flowButton(label) && !flowButton(label).disabled, 'the Stick button to open')
  await inAct(() => flowButton(label).click())
  await until(() => stepStates().length > 0 && mocks.requireReview.mock.calls.length > reviews, 'the review to list its steps')
}
/** The calls review `at` showed, as the account that reviewed them. */
const reviewed = (at = 0) =>
  (mocks.requireReview.mock.calls[at][0] as { calls: { functionName: string; from: Address }[] }).calls.map(call => [call.functionName, call.from])
/** The chain has mined `hash` in `block`, and the flow renders again. */
async function mined(hash: Hex, block: bigint) {
  const request = mocks.writeContract.mock.calls.find(([request]) => request.functionName === (hash === APPROVAL ? 'approve' : 'pay'))?.[0]
  if (!request) throw new Error('Cannot mine a transaction that the wallet was not asked to send')
  const blockHash = toHex(block, { size: 32 })
  mocks.blocks[String(block)] = { hash: blockHash, number: block, timestamp: 1_790_000_000n + block }
  mocks.transactions[hash.toLowerCase()] = {
    hash, chainId: CHAIN, from: request.account, to: request.address,
    input: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args }),
    value: request.value ?? 0n, blockHash, blockNumber: block, transactionIndex: 0,
  }
  mocks.receipts[hash.toLowerCase()] = {
    transactionHash: hash, status: 'success', blockNumber: block, blockHash, transactionIndex: 0,
    from: request.account, to: request.address, contractAddress: null, logs: [], logsBloom: `0x${'0'.repeat(512)}`,
    cumulativeGasUsed: 50_000n, gasUsed: 50_000n, effectiveGasPrice: 1n, type: 'eip1559',
  }
  if (acting) await act(async () => root.render(tree()))
  else root.render(tree())
}

describe('the stick flow on the real engine', () => {
  it('wallet-action:approve-the-staked-token-for-a-stick wallet-action:stick shows the whole stick in one review, sends each step once as the one before confirms, and never asks again', async () => {
    mocks.writeContract.mockResolvedValueOnce(APPROVAL).mockResolvedValueOnce(STICK)
    await openReview()
    await until(() => mocks.writeContract.mock.calls.length === 1, 'the approval to be sent')
    expect(reviewed()).toEqual([['approve', ALICE], ['pay', ALICE]])
    expect(mocks.requireReview.mock.calls[0][0]).toMatchObject({
      title: 'Stick',
      rows: expect.arrayContaining([{ label: 'Stick', value: '5 CPN', strong: true }]),
    })
    // A press while a step is out sends nothing more.
    await act(async () => confirmButton()!.click())
    expect(mocks.writeContract).toHaveBeenCalledTimes(1)

    await mined(APPROVAL, 4_001n)
    await until(() => mocks.writeContract.mock.calls.length === 2, 'the stick to be sent')
    expect(stepStates()).toEqual(['complete', 'active'])
    expect(writes()).toEqual(['approve', 'pay'])
    // The stick is simulated at the block of the approval, not at a head that may not have it.
    const [, stickSimulation] = mocks.publicClient.simulateContract.mock.calls
    expect(stickSimulation[0]).toMatchObject({ address: TERMINAL, functionName: 'pay', blockNumber: 4_001n })

    await mined(STICK, 4_005n)
    await until(() => title() === 'Stick confirmed', 'the stick to be counted')
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    // One confirmation for the whole stick: no step opened a review of its own.
    expect(mocks.requireReview).toHaveBeenCalledOnce()
    expect(mocks.requestReview).not.toHaveBeenCalled()
  })

  it('reviews only the stick again for a Retry after its simulation failed, never the approval that landed', async () => {
    mocks.writeContract.mockResolvedValueOnce(APPROVAL).mockResolvedValueOnce(STICK)
    await openReview()
    await until(() => mocks.writeContract.mock.calls.length === 1, 'the approval to be sent')
    mocks.publicClient.simulateContract.mockImplementationOnce(async () => {
      throw new Error('execution reverted: price moved')
    })
    await mined(APPROVAL, 4_001n)
    await until(() => confirmButton()?.textContent === 'Retry', 'the stick to fail')
    expect(dialog()!.textContent).toContain('price moved')
    expect(stepStates()).toEqual(['complete', 'active'])
    expect(mocks.writeContract).toHaveBeenCalledTimes(1)

    await act(async () => confirmButton()!.click())
    await until(() => mocks.writeContract.mock.calls.length === 2, 'the stick to be sent')
    expect(writes()).toEqual(['approve', 'pay'])
    expect(mocks.requireReview).toHaveBeenCalledTimes(2)
    expect(reviewed(1)).toEqual([['pay', ALICE]])
    expect(mocks.requestReview).not.toHaveBeenCalled()
  })

  it('closes with nothing sent when its one review is cancelled', async () => {
    mocks.requireReview.mockRejectedValueOnce(new TransactionReviewCancelledError())
    await act(async () => root.render(tree()))
    await until(() => host.querySelector('input'), 'the Stick card')
    await typeInto('Amount of underlying tokens to stick', '5')
    await until(() => flowButton('Stick') && !flowButton('Stick').disabled, 'the Stick button to open')
    await act(async () => flowButton('Stick').click())
    await until(() => mocks.requireReview.mock.calls.length === 1 && !dialog(), 'the review to be cancelled')
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it("says so while the wallet's prompt is open, on the button and under the step, then waits for the chain", async () => {
    const prompt = Promise.withResolvers<Hex>()
    mocks.writeContract.mockReturnValueOnce(prompt.promise)
    await openReview()
    const statusLine = () => dialog()?.querySelector('p.text-bluebs-700')?.textContent ?? null

    await until(() => mocks.writeContract.mock.calls.length === 1, 'the wallet to be asked')
    expect(statusLine()).toBe('Confirm in your wallet…')
    expect(confirmButton()!.textContent).toBe('Confirm in your wallet…')
    expect(confirmButton()!.disabled).toBe(true)

    await act(async () => prompt.resolve(APPROVAL))
    await until(() => statusLine() === 'Waiting for confirmation…', 'the wait for the chain')
    expect(confirmButton()!.textContent).toBe('Confirming…')
  })

  it('reviews and sends the approval again, and only the approval, when the wallet refused it', async () => {
    mocks.writeContract.mockRejectedValueOnce(new UserRejectedRequestError(new Error('User rejected the request.'))).mockResolvedValueOnce(APPROVAL)
    await openReview()
    await until(() => confirmButton()?.textContent === 'Retry', 'the approval to be refused')
    expect(stepStates()).toEqual(['active', 'pending'])

    await act(async () => confirmButton()!.click())
    await until(() => mocks.writeContract.mock.calls.length === 2, 'the approval to be sent again')
    expect(writes()).toEqual(['approve', 'approve'])
    expect(reviewed(1)).toEqual([['approve', ALICE], ['pay', ALICE]])
  })

  it('retains an ambiguous approval across dismissal and reopening without offering another wallet submission', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('Connection lost after sending'))
    await openReview()
    await until(() => confirmButton()?.textContent === 'Done', 'the unresolved approval to be held')
    expect(stepStates()).toEqual(['active', 'pending'])
    expect(dialog()!.textContent).toContain(writeHeldMessage())
    expect(dialog()!.textContent).toContain(HELD_EXIT_LABEL)
    expect(writes()).toEqual(['approve'])
    await act(async () => confirmButton()!.click())
    await until(() => !dialog(), 'the held review to close')
    await openReview()
    await until(() => confirmButton()?.textContent === 'Done', 'the original unresolved approval to be restored')
    expect(writes()).toEqual(['approve'])
    expect(stepStates()).toEqual(['active', 'pending'])
  })
})

describe('a stick for someone else on the real engine', () => {
  it('wallet-action:stick-for-someone-else reaches the review, the simulation and the wallet as a pay for the recipient, once the sender may stick for them', async () => {
    gift = true
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    mocks.writeContract.mockResolvedValueOnce(STICK)
    await openReview()
    // The review asked the hook again whether the sender may stick for the recipient.
    expect(mocks.canStick).toHaveBeenLastCalledWith(CHAIN, BigInt(PROJECT), ALICE, FRIEND, expect.anything())

    await until(() => mocks.writeContract.mock.calls.length === 1, 'the stick to be sent')
    const pay = { address: TERMINAL, functionName: 'pay', args: [BigInt(PROJECT), TOKEN, 5n * CPN, FRIEND, MINTED, '', '0x'] }
    expect(mocks.requireReview).toHaveBeenCalledOnce()
    expect(mocks.requireReview.mock.calls[0][0]).toMatchObject({
      title: 'Stick for someone else',
      calls: [expect.objectContaining({ chainId: CHAIN, functionName: 'pay', args: pay.args, from: ALICE })],
      rows: expect.arrayContaining([{ label: 'For', value: FRIEND, mono: true }]),
    })
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.publicClient.simulateContract.mock.calls[0][0]).toMatchObject({ ...pay, account: ALICE })
    expect(writes()).toEqual(['pay'])
  })

  // The plan is the reviewing account's: its trust check and its quote were for that sender. The flow hands the engine
  // that account with every step, and the engine refuses to send it from any other.
  it('wallet-action:stick-for-someone-else sends nothing when the wallet switches accounts while the review is open, and the dialog says why', async () => {
    gift = true
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    const review = Promise.withResolvers<void>()
    mocks.requireReview.mockReturnValueOnce(review.promise)
    await openReview()

    await switchTo(BOB)
    await act(async () => review.resolve())
    await until(() => confirmButton()?.textContent === 'Retry', 'the refusal')

    expect(dialog()!.textContent).toContain(REVIEWED_ACCOUNT_CHANGED)
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('wallet-action:stick-for-someone-else goes on once the account that reviewed the stick is connected again, as that account', async () => {
    gift = true
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    mocks.writeContract.mockResolvedValueOnce(STICK)
    const review = Promise.withResolvers<void>()
    mocks.requireReview.mockReturnValueOnce(review.promise)
    await openReview()
    await switchTo(BOB)
    await act(async () => review.resolve())
    await until(() => confirmButton()?.textContent === 'Retry', 'the refusal')
    expect(mocks.writeContract).not.toHaveBeenCalled()

    await switchTo(ALICE)
    await act(async () => confirmButton()!.click())
    await until(() => mocks.writeContract.mock.calls.length === 1, 'the stick to be sent')
    expect(senders()).toEqual([ALICE])
    expect(writes()).toEqual(['pay'])
    expect(reviewed(1)).toEqual([['pay', ALICE]])
  })
})

describe('a stick whose account changes after its review, on the real engine', () => {
  it('wallet-action:approve-the-staked-token-for-a-stick wallet-action:stick sends the stick from no account but the one that approved, once it has landed', async () => {
    mocks.writeContract.mockResolvedValueOnce(APPROVAL)
    await openReview()
    await until(() => mocks.writeContract.mock.calls.length === 1, 'the approval to be sent')

    await switchTo(BOB)
    await mined(APPROVAL, 4_001n)
    await until(() => dialog()!.textContent!.includes(REVIEWED_ACCOUNT_CHANGED), 'the stick to be refused')

    // Only ALICE's approval reached the wallet, and the dialog is where it was.
    expect(writes()).toEqual(['approve'])
    expect(senders()).toEqual([ALICE])
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(stepStates()).toEqual(['complete', 'active'])
  })

  // The wallet's account changes while the review is open, and the page has not rendered it yet: the page still shows
  // the account that reviewed the plan, and the wallet is already another's.
  it.each([
    ['a stick', false],
    ['a stick for someone else', true],
  ])('wallet-action:stick wallet-action:stick-for-someone-else refuses %s once its review closes, while the page still shows the old account', async (_, forSomeoneElse) => {
    gift = forSomeoneElse
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    const review = Promise.withResolvers<void>()
    mocks.requireReview.mockReturnValueOnce(review.promise)
    await openReview()

    mocks.getAccount.mockImplementation(() => ({ address: BOB, chainId: CHAIN }))
    await act(async () => review.resolve())
    await until(() => dialog()!.textContent!.includes(REVIEWED_ACCOUNT_CHANGED), 'the refusal')

    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })
})

// React commits a confirmation, and runs the effects of that commit a task later; the engine lets go of its lock in one
// of them. The stick is sent from an effect that follows the confirmation, so it must find the engine let go of: sent
// once, as the browser schedules it, with no click and no second review.
describe('the stick after its approval confirms, as a browser schedules it', () => {
  beforeEach(() => {
    acting = false
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
  })

  it('is sent once, on its own, never the approval again', async () => {
    mocks.writeContract.mockResolvedValueOnce(APPROVAL).mockResolvedValueOnce(STICK)
    await openReview()
    await until(() => mocks.writeContract.mock.calls.length === 1, 'the approval to be sent')
    await mined(APPROVAL, 4_001n)
    await until(() => mocks.writeContract.mock.calls.length === 2, 'the stick to be sent')
    // Time for anything else the confirmation started.
    await sleep(100)
    expect(writes()).toEqual(['approve', 'pay'])
    expect(title()).toBe('Confirm stick')
    expect(mocks.requireReview).toHaveBeenCalledOnce()
    expect(mocks.requestReview).not.toHaveBeenCalled()
  })

  it('is not sent when Close is pressed in the commit that shows the approval confirmed', async () => {
    mocks.writeContract.mockResolvedValueOnce(APPROVAL).mockResolvedValueOnce(STICK)
    await openReview()
    await until(() => mocks.writeContract.mock.calls.length === 1, 'the approval to be sent')
    // Close is clicked from the very mutation that marks the approval confirmed, before that commit's effects run.
    let closed = false
    const observer = new MutationObserver(() => {
      const close = [...(dialog()?.querySelectorAll('footer button') ?? [])].find(button => button.textContent === 'Close') as HTMLButtonElement | undefined
      if (!closed && stepStates()[0] === 'complete' && close && !close.disabled) {
        closed = true
        close.click()
      }
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    await mined(APPROVAL, 4_001n)
    await until(() => closed, 'Close to be pressed')
    observer.disconnect()
    await sleep(100)
    expect(writes()).toEqual(['approve'])
    expect(dialog()).toBeNull()
  })
})
