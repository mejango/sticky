// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { TOKEN, stickyInfo } from '../home-fixtures'

// The stick flow on the real transaction engine: `useSafeTx` runs as it does in the app, and only wagmi, the wallet, the
// reads and the engine's own review are mocks. stick-flow.test.tsx mocks the engine, so it cannot see what the flow does
// with the engine's real phases and its lock: a double click, a step that fails or is cancelled, and a click made after
// React has committed a confirmation and before the effects that let the engine go of it have run.

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
  publicClient: { simulateContract: vi.fn(), estimateContractGas: vi.fn() },
  getAccount: vi.fn(),
  requestReview: vi.fn(),
  switchChain: vi.fn(),
  writeContract: vi.fn(),
  /** The receipts the chain has, by lowercase hash. */
  receipts: {} as Record<string, unknown>,
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
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({
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
  mocks.requestReview.mockResolvedValue(true)
  mocks.switchChain.mockResolvedValue(undefined)
  mocks.publicClient.simulateContract.mockImplementation(async (request: { address: string; functionName: string }) => ({
    request: { address: request.address, functionName: request.functionName },
  }))
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  mocks.writeContract.mockReset()
  mocks.receipts = {}
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

const typeInto = (label: string, value: string) => {
  const field = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  return inAct(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** An amount typed, the review opened, and its plan listed. With `gift`, the recipient is FRIEND. */
async function openReview() {
  if (acting) await act(async () => root.render(tree()))
  else root.render(tree())
  await until(() => host.querySelector('input'), 'the Stick card')
  if (gift) await typeInto('Recipient address', FRIEND)
  await typeInto('Amount of underlying tokens to stick', '5')
  const label = gift ? 'Review stick' : 'Stick'
  await until(() => flowButton(label) && !flowButton(label).disabled, 'the Stick button to open')
  await inAct(() => flowButton(label).click())
  await until(() => confirmButton() && !confirmButton()!.disabled, 'the review to list its steps')
}
/** The chain has mined `hash` in `block`, and the flow renders again. */
async function mined(hash: Hex, block: bigint) {
  mocks.receipts[hash.toLowerCase()] = { transactionHash: hash, status: 'success', blockNumber: block }
  if (acting) await act(async () => root.render(tree()))
  else root.render(tree())
}

describe('the stick flow on the real engine', () => {
  it('wallet-action:approve-the-staked-token-for-a-stick wallet-action:stick sends one wallet call for a double click, and never sends a step again once it has landed', async () => {
    mocks.writeContract.mockResolvedValueOnce(APPROVAL).mockResolvedValueOnce(STICK)
    await openReview()
    expect(confirmButton()!.textContent).toBe('Confirm & approve')

    // Two clicks in one task: the second meets the engine's lock.
    await act(async () => {
      confirmButton()!.click()
      confirmButton()!.click()
    })
    await until(() => confirmButton()?.disabled, 'the approval to be sent')
    expect(mocks.writeContract).toHaveBeenCalledTimes(1)
    expect(mocks.requestReview).toHaveBeenCalledTimes(1)

    await mined(APPROVAL, 4_001n)
    await until(() => confirmButton()?.textContent === 'Confirm & stick', 'the approval to be counted')
    expect(stepStates()).toEqual(['complete', 'active'])
    expect(confirmButton()!.disabled).toBe(false)

    await act(async () => {
      confirmButton()!.click()
      confirmButton()!.click()
    })
    await until(() => mocks.writeContract.mock.calls.length === 2, 'the stick to be sent')
    expect(writes()).toEqual(['approve', 'pay'])
    // The stick is simulated at the block of the approval, not at a head that may not have it.
    const [, stickSimulation] = mocks.publicClient.simulateContract.mock.calls
    expect(stickSimulation[0]).toMatchObject({ address: TERMINAL, functionName: 'pay', blockNumber: 4_001n })

    await mined(STICK, 4_005n)
    await until(() => title() === 'Stick confirmed', 'the stick to be counted')
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it('retries a stick whose simulation failed on its own, never with the approval that landed', async () => {
    mocks.writeContract.mockResolvedValueOnce(APPROVAL).mockResolvedValueOnce(STICK)
    await openReview()
    await act(async () => confirmButton()!.click())
    await until(() => confirmButton()?.disabled, 'the approval to be sent')
    await mined(APPROVAL, 4_001n)
    await until(() => confirmButton()?.textContent === 'Confirm & stick', 'the approval to be counted')

    mocks.publicClient.simulateContract.mockImplementationOnce(async () => {
      throw new Error('execution reverted: price moved')
    })
    await act(async () => confirmButton()!.click())
    await until(() => confirmButton()?.textContent === 'Retry', 'the stick to fail')
    expect(dialog()!.textContent).toContain('price moved')
    expect(stepStates()).toEqual(['complete', 'active'])
    expect(mocks.writeContract).toHaveBeenCalledTimes(1)

    await act(async () => confirmButton()!.click())
    await until(() => mocks.writeContract.mock.calls.length === 2, 'the stick to be sent')
    expect(writes()).toEqual(['approve', 'pay'])
  })

  it('keeps an approval counted when the exact review of the stick is cancelled, and sends the stick on the next click', async () => {
    mocks.writeContract.mockResolvedValueOnce(APPROVAL).mockResolvedValueOnce(STICK)
    await openReview()
    await act(async () => confirmButton()!.click())
    await until(() => confirmButton()?.disabled, 'the approval to be sent')
    await mined(APPROVAL, 4_001n)
    await until(() => confirmButton()?.textContent === 'Confirm & stick', 'the approval to be counted')

    mocks.requestReview.mockResolvedValueOnce(false)
    await act(async () => confirmButton()!.click())
    await until(() => mocks.requestReview.mock.calls.length === 2 && confirmButton() && !confirmButton()!.disabled, 'the review to be cancelled')
    expect(stepStates()).toEqual(['complete', 'active'])
    expect(confirmButton()!.textContent).toBe('Confirm & stick')
    expect(mocks.writeContract).toHaveBeenCalledTimes(1)

    await act(async () => confirmButton()!.click())
    await until(() => mocks.writeContract.mock.calls.length === 2, 'the stick to be sent')
    expect(writes()).toEqual(['approve', 'pay'])
  })

  it("says so while the wallet's prompt is open, on the button and under the step, then waits for the chain", async () => {
    const prompt = Promise.withResolvers<Hex>()
    mocks.writeContract.mockReturnValueOnce(prompt.promise)
    await openReview()
    const statusLine = () => dialog()?.querySelector('p.text-bluebs-700')?.textContent ?? null
    expect(statusLine()).toBeNull()

    await act(async () => confirmButton()!.click())
    await until(() => mocks.writeContract.mock.calls.length === 1, 'the wallet to be asked')
    expect(statusLine()).toBe('Confirm in your wallet…')
    expect(confirmButton()!.textContent).toBe('Confirm in your wallet…')
    expect(confirmButton()!.disabled).toBe(true)

    await act(async () => prompt.resolve(APPROVAL))
    await until(() => statusLine() === 'Waiting for confirmation…', 'the wait for the chain')
    expect(confirmButton()!.textContent).toBe('Confirming…')
  })

  it('sends the approval again, and only the approval, when the wallet refused it', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('User rejected the request.')).mockResolvedValueOnce(APPROVAL)
    await openReview()
    await act(async () => confirmButton()!.click())
    await until(() => confirmButton()?.textContent === 'Retry', 'the approval to be refused')
    expect(stepStates()).toEqual(['active', 'pending'])

    await act(async () => confirmButton()!.click())
    await until(() => mocks.writeContract.mock.calls.length === 2, 'the approval to be sent again')
    expect(writes()).toEqual(['approve', 'approve'])
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

    await act(async () => confirmButton()!.click())
    await until(() => mocks.writeContract.mock.calls.length === 1, 'the stick to be sent')
    const pay = { address: TERMINAL, functionName: 'pay', args: [BigInt(PROJECT), TOKEN, 5n * CPN, FRIEND, MINTED, '', '0x'] }
    expect(mocks.requestReview).toHaveBeenCalledOnce()
    expect(mocks.requestReview.mock.calls[0][0]).toMatchObject({ ...pay, account: ALICE })
    expect(mocks.publicClient.simulateContract.mock.calls[0][0]).toMatchObject({ ...pay, account: ALICE })
    expect(writes()).toEqual(['pay'])
  })

  // The plan is the reviewing account's: its trust check and its quote were for that sender. The engine checks the
  // account it is handed, so the flow is what stops another account from sending the plan.
  it('sends nothing when the wallet switches accounts between the review and the confirm', async () => {
    gift = true
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    await openReview()

    mocks.wallet = { ...mocks.wallet, address: BOB }
    mocks.getAccount.mockImplementation(() => ({ address: BOB, chainId: CHAIN }))
    await act(async () => root.render(tree()))
    await act(async () => confirmButton()!.click())
    await pump()

    expect(dialog()).toBeNull()
    expect(host.textContent).toContain('Your connected account changed. Review again.')
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })
})

// React commits a confirmation, which enables the button again, and runs the effects of that commit a task later. The
// engine lets go of its lock in one of those effects, so a click between the two reaches an engine that still holds it
// and is answered with nothing. Nothing is what the dialog must show of it: not the next step, and not a stick that was
// never sent.
describe('a click between the commit of a confirmation and the effects that follow it', () => {
  beforeEach(() => {
    acting = false
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false)
  })

  /** Sends the approval, has the chain mine it, and lets `clickAfter` click the button when its next commit opens it. */
  async function confirmApproval(clickAfter: (click: () => void) => void) {
    mocks.writeContract.mockResolvedValueOnce(APPROVAL)
    await openReview()
    confirmButton()!.click()
    await until(() => mocks.writeContract.mock.calls.length === 1 && confirmButton()?.disabled, 'the approval to be sent')

    let clicks = 0
    const observer = new MutationObserver(() => {
      const button = confirmButton()
      if (button && !button.disabled && clicks === 0) {
        clicks += 1
        clickAfter(() => button.click())
      }
    })
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    await mined(APPROVAL, 4_001n)
    await until(() => clicks === 1, 'the button to open')
    observer.disconnect()
    // Time for the effects of that commit, and for whatever the click started.
    await sleep(100)
  }

  it('is not taken for the stick that was never sent, and skips nothing', async () => {
    // The click comes in the microtask after the commit, which is before React runs that commit's effects.
    await confirmApproval(click => click())

    expect(title()).toBe('Confirm stick')
    expect(stepStates()).toEqual(['complete', 'active'])
    expect(confirmButton()!.textContent).toBe('Confirm & stick')
    expect(writes()).toEqual(['approve'])

    // The next click sends the stick, once.
    mocks.writeContract.mockResolvedValueOnce(STICK)
    confirmButton()!.click()
    await until(() => mocks.writeContract.mock.calls.length === 2, 'the stick to be sent')
    expect(writes()).toEqual(['approve', 'pay'])
    expect(title()).toBe('Confirm stick')
  })

  it('control: a click a task later, when the engine has let go, sends the stick', async () => {
    await confirmApproval(click =>
      setTimeout(() => {
        mocks.writeContract.mockResolvedValueOnce(STICK)
        click()
      }, 10),
    )
    await until(() => mocks.writeContract.mock.calls.length === 2, 'the stick to be sent')
    expect(writes()).toEqual(['approve', 'pay'])
    expect(title()).toBe('Confirm stick')
  })
})
