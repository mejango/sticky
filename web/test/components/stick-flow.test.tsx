// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress, isAddress, zeroAddress, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyDeployment } from '@/lib/sticky-addresses'
import type { StickyPosition } from '@/lib/sticky-holders'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'
import { TOKEN, stickyInfo } from '../home-fixtures'

// The stick flow: an amount typed into the Stick card or the Airdrops tab's form, what a stick will mint at least, and
// the review that reads the balance, the allowance and the price again, lists the steps, and sends them one at a time
// through the transaction engine. Every read and the engine are mocks: the builders, the quotes' reads and the engine
// have tests of their own (test/lib/sticky-builders.test.ts, sticky-quotes.test.ts, sticky-allowance.test.ts and
// test/transactions). The clock is fake, so the quote's 250 ms wait and the refresh after a stick happen only when a
// test moves it.

const CHAIN = 84532
const PROJECT = 23
const TERMINAL = stickyDeployment(CHAIN)!.terminal
const ALICE = getAddress(`0x${'a'.repeat(40)}`)
const BOB = getAddress(`0x${'b'.repeat(40)}`)
const FRIEND = getAddress(`0x${'9'.repeat(40)}`)
/** An address written with the case of every letter turned over: a typo that a checksum catches. */
const WRONG_CHECKSUM = BOB.replace(/[a-f]/gi, letter => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()))
const APPROVAL_HASH = `0x${'a1'.repeat(32)}` as Hex
const STICK_HASH = `0x${'b2'.repeat(32)}` as Hex
/** What 5 CPN mints at least, in Sticky tokens. */
const MINTED = 9_870_000_000_000_000_000n
const CPN = 10n ** 6n

type Phase = 'idle' | 'review' | 'simulating' | 'signing' | 'pending' | 'success' | 'error'
type EngineState = {
  phase: Phase
  busy: boolean
  error: string | null
  hash: Hex | null
  receipt: { blockNumber: bigint } | null
  isSafe: boolean
  send: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  position: vi.fn(),
  quote: vi.fn(),
  canStick: vi.fn(),
  funds: vi.fn(),
  wallet: {} as {
    isConnected: boolean
    address: string | undefined
    isCenterWallet: boolean
    openSignIn: ReturnType<typeof vi.fn>
  },
  tx: {} as EngineState,
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/hooks/useSafeTx', () => ({ useSafeTx: () => mocks.tx }))
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
import { StickCard } from '@/components/project/StickCard'

/** Project 23 sticks CPN, which has 6 decimals, for STICKYCPN. */
const cpn = (extra = {}) =>
  stickyInfo(CHAIN, BigInt(PROJECT), { symbol: 'CPN', decimals: 6, stSymbol: 'STICKYCPN', stakedToken: TOKEN, ...extra })

const positionOf = (wallet: bigint): StickyPosition => ({
  staked: 0n,
  wallet,
  start: 0,
  current: 0,
  longest: 0,
  blockNumber: 1n,
  timestamp: 1_790_000_000,
})

const engine = (): EngineState => {
  const state: EngineState = {
    phase: 'idle',
    busy: false,
    error: null,
    hash: null,
    receipt: null,
    isSafe: false,
    // A send takes the engine out of whatever it was in, as the real one does.
    send: vi.fn(async () => {
      state.phase = 'pending'
      state.busy = true
      state.error = null
      state.hash = null
      state.receipt = null
      return STICK_HASH
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
let props: { forSomeoneElse?: boolean }

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.wallet = { isConnected: true, address: ALICE, isCenterWallet: false, openSignIn: vi.fn() }
  mocks.tx = engine()
  mocks.project.mockReset().mockImplementation(async () => cpn())
  mocks.position.mockReset().mockResolvedValue(positionOf(100n * CPN))
  mocks.quote.mockReset().mockResolvedValue(MINTED)
  mocks.canStick.mockReset().mockResolvedValue(undefined)
  mocks.funds.mockReset().mockResolvedValue({ balance: 100n * CPN, allowance: 0n })
  props = {}
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

const tree = () => (
  <QueryClientProvider client={client}>
    <StickFlow chainId={CHAIN} projectId={PROJECT} {...props} />
  </QueryClientProvider>
)
async function render(extra: typeof props = {}) {
  props = extra
  await act(async () => root.render(tree()))
  await settled()
}
/** The flow renders again, as it does when the engine or the wallet changes under it. */
async function rerender() {
  await act(async () => root.render(tree()))
  await settled()
}

const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const amountField = () => input('Amount of underlying tokens to stick')
const recipientField = () => input('Recipient address')
async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** An amount, waited on until its quote has been asked for and answered. */
async function typeAmount(value: string) {
  await type(amountField(), value)
  await settle(250)
  await settled()
}

const dialog = () => document.querySelector('dialog')
const buttonIn = (within: ParentNode, label: string) =>
  [...within.querySelectorAll('button')].find(button => button.textContent === label)
/** The flow's own button, under its fields. */
const flowButton = (label: string) => {
  const found = [...host.querySelectorAll('button')].find(button => button.textContent === label && !button.closest('dialog'))
  if (!found) throw new Error(`no ${label} button`)
  return found
}
const confirmButton = () => dialog()?.querySelector<HTMLButtonElement>('footer button.btn-primary') ?? null
const click = (element: Element | null | undefined) => act(async () => void (element as HTMLElement).click())
/** What a click on `button` runs as of the render that is on show, which a click can reach after a newer render has been scheduled. */
const handlerOf = (button: Element) => {
  const key = Object.keys(button).find(name => name.startsWith('__reactProps$'))!
  return (button as unknown as Record<string, { onClick: () => void }>)[key].onClick
}
const hint = () => host.querySelector('[data-stick-hint]')?.textContent || null
/** The steps the review lists, as the titles the person reads. */
const steps = () =>
  [...(dialog()?.querySelectorAll('ol li') ?? [])].map(item => item.textContent!.replace(/^\dStep \d of \d: /, ''))
const stepStates = () => [...(dialog()?.querySelectorAll('ol li') ?? [])].map(item => item.getAttribute('data-state'))
/** The review's rows, as [label, value]. */
const rows = () => {
  const cells = [...(dialog()?.querySelectorAll('div.grid > span') ?? [])].map(cell => cell.textContent)
  return Array.from({ length: cells.length / 2 }, (_, at) => [cells[at * 2], cells[at * 2 + 1]])
}
const alerts = () => [...host.querySelectorAll('p.text-red-700')].map(alert => alert.textContent)

/** The review of a stick of `amount` CPN, opened and read. */
async function review(amount = '5', label = 'Stick') {
  await typeAmount(amount)
  await click(flowButton(label))
  await settled()
}

/** The engine's answer once its transaction is confirmed in block `block`. */
async function confirmed(hash: Hex, block: bigint) {
  mocks.tx.phase = 'success'
  mocks.tx.busy = false
  mocks.tx.hash = hash
  mocks.tx.receipt = { blockNumber: block }
  await rerender()
}

describe('the amount', () => {
  it('waits 250 ms after typing before it quotes, and says what the stick will mint at least', async () => {
    await render()
    await type(amountField(), '5')
    await settle(249)
    expect(mocks.quote).not.toHaveBeenCalled()

    // Another key starts the wait again.
    await type(amountField(), '50')
    await settle(249)
    expect(mocks.quote).not.toHaveBeenCalled()
    await settle(1)
    await settled()

    expect(mocks.quote).toHaveBeenCalledTimes(1)
    expect(mocks.quote).toHaveBeenCalledWith(
      CHAIN,
      BigInt(PROJECT),
      TOKEN,
      50n * CPN,
      ALICE,
      ALICE,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(hint()).toBe('You get at least 9.87 STICKYCPN')
  })

  it('says the price is being checked while the quote is read, and quotes nothing for an empty or zero amount', async () => {
    const pending = Promise.withResolvers<bigint>()
    mocks.quote.mockReturnValue(pending.promise)
    await render()
    await typeAmount('5')
    expect(hint()).toBe('Checking the current backing price…')
    await act(async () => pending.resolve(MINTED))
    await settled()
    expect(hint()).toBe('You get at least 9.87 STICKYCPN')

    mocks.quote.mockClear()
    await typeAmount('0')
    await typeAmount('')
    expect(mocks.quote).not.toHaveBeenCalled()
    expect(hint()).toBeNull()
  })

  it('says a full stickiness bonus leaves nothing to unstick, beside the quote', async () => {
    mocks.project.mockImplementation(async () => cpn({ cashOutTaxRate: 10_000n }))
    await render()
    await typeAmount('5')
    expect(hint()).toBe('You get at least 9.87 STICKYCPN. Unsticking returns nothing at a 100% bonus.')
  })

  it('blocks the button when the quote fails, and says why', async () => {
    mocks.quote.mockRejectedValue(new Error('this amount is too small or cannot be priced precisely enough at the current backing price'))
    await render()
    await typeAmount('0.000001')
    expect(hint()).toBe('Could not quote: this amount is too small or cannot be priced precisely enough at the current backing price')
    expect(flowButton('Stick').disabled).toBe(true)
    // A quote the terminal refuses is an answer, which the console need not be told of.
    expect(console.warn).not.toHaveBeenCalled()

    // The next amount is its own quote: it does not wait on the last one's failure.
    mocks.quote.mockResolvedValue(MINTED)
    await type(amountField(), '5')
    expect(flowButton('Stick').disabled).toBe(false)
    await settle(250)
    await settled()
    expect(hint()).toBe('You get at least 9.87 STICKYCPN')
    expect(flowButton('Stick').disabled).toBe(false)
  })

  it('tells the console why a quote could not be read, and shows only what could not be read', async () => {
    const cause = new Error('429 from Center')
    mocks.quote.mockRejectedValue(new Error('the terminal\'s stick preview could not be read.', { cause }))
    await render()
    await typeAmount('5')

    expect(hint()).toBe('Could not quote: the terminal\'s stick preview could not be read.')
    expect(host.textContent).not.toContain('429')
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('quote'),
      { chainId: CHAIN, projectId: PROJECT },
      expect.objectContaining({ cause }),
    )
  })

  it('a stale asynchronous quote cannot replace a newer amount\'s', async () => {
    const pending: ((count: bigint) => void)[] = []
    mocks.quote.mockImplementation(() => new Promise<bigint>(resolve => pending.push(resolve)))
    await render()
    await typeAmount('1')
    await typeAmount('2')
    expect(pending).toHaveLength(2)

    await act(async () => pending[1](2n * 10n ** 18n))
    await settled()
    await act(async () => pending[0](1n * 10n ** 18n))
    await settled()
    expect(hint()).toBe('You get at least 2 STICKYCPN')
  })

  it('refuses an amount the token cannot hold as it is typed, and quotes and reviews nothing', async () => {
    await render()
    await typeAmount('1.0000001')
    expect(hint()).toBe('This token supports at most 6 decimal places.')
    expect(flowButton('Stick').disabled).toBe(true)
    await typeAmount('abc')
    expect(hint()).toBe('Enter a valid amount.')
    expect(mocks.quote).not.toHaveBeenCalled()
  })

  it('says when the amount is more than the wallet holds, and blocks the button', async () => {
    await render()
    await typeAmount('101')
    expect(hint()).toBe('That is more than you hold.')
    expect(flowButton('Stick').disabled).toBe(true)
    expect(mocks.quote).not.toHaveBeenCalled()
  })

  it('fills in the whole wallet balance from its link', async () => {
    mocks.position.mockResolvedValue(positionOf(1_234_567n))
    await render()
    expect(host.textContent).toContain('1.2346 CPN in wallet')
    await click(buttonIn(host, '1.2346'))
    expect(amountField().value).toBe('1.234567')
  })

  it('names the token in the field, and renders a token\'s own name as text however it is written', async () => {
    const hostile = '<img src=x onerror=alert(1)>'
    mocks.project.mockImplementation(async () => cpn({ symbol: hostile, stSymbol: hostile }))
    await render()
    await typeAmount('5')
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toContain(hostile)
    await click(flowButton('Stick'))
    await settled()
    expect(dialog()!.querySelector('img')).toBeNull()
    expect(dialog()!.textContent).toContain(hostile)
  })
})

describe('the button', () => {
  /** A copy of the project the browser kept from an earlier visit, which the page shows until it has read it again. */
  const kept = () => client.setQueryData(['sticky-project', CHAIN, PROJECT, 'info', 'v1'], cpn())

  it('waits for this visit\'s read of the project, which the kept copy of an earlier visit does not stand in for', async () => {
    const reading = Promise.withResolvers<ReturnType<typeof cpn>>()
    mocks.project.mockReturnValue(reading.promise)
    kept()
    await render()
    await typeAmount('5')

    // The kept copy names the token, and is not enough to stick or to quote on.
    expect(host.textContent).toContain('CPN')
    expect(flowButton('Checking…').disabled).toBe(true)
    await click(flowButton('Checking…'))
    expect(mocks.quote).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()

    await act(async () => reading.resolve(cpn()))
    await settled()
    expect(flowButton('Stick').disabled).toBe(false)
    expect(mocks.quote).toHaveBeenCalledOnce()
  })

  it('stays closed when the project could not be read, whatever an earlier visit kept of it', async () => {
    mocks.project.mockRejectedValue(new Error('Center is down'))
    kept()
    await render()
    await typeAmount('5')

    expect(host.textContent).toContain('CPN')
    expect(flowButton('Stick').disabled).toBe(true)
    await click(flowButton('Stick'))
    expect(dialog()).toBeNull()
    expect(mocks.quote).not.toHaveBeenCalled()
    expect(mocks.funds).not.toHaveBeenCalled()
  })

  it('asks a visitor without a wallet to sign in, after quoting as the zero address, and reads nothing else', async () => {
    mocks.wallet = { ...mocks.wallet, isConnected: false, address: undefined }
    await render()
    await typeAmount('5')
    expect(mocks.quote).toHaveBeenCalledWith(CHAIN, BigInt(PROJECT), TOKEN, 5n * CPN, zeroAddress, zeroAddress, expect.anything())
    expect(hint()).toBe('You get at least 9.87 STICKYCPN')

    await click(flowButton('Sign in to stick'))
    expect(mocks.wallet.openSignIn).toHaveBeenCalledOnce()
    expect(dialog()).toBeNull()
    expect(mocks.funds).not.toHaveBeenCalled()
  })

  it('is closed for an empty amount, and open for one the wallet holds', async () => {
    await render()
    expect(flowButton('Stick').disabled).toBe(true)
    await typeAmount('5')
    expect(flowButton('Stick').disabled).toBe(false)
  })
})

describe('the review', () => {
  it('opens while it reads, then lists an approval reset, the approval and the stick, each to be sent on its own', async () => {
    const reading = Promise.withResolvers<{ balance: bigint; allowance: bigint }>()
    mocks.funds.mockReturnValue(reading.promise)
    await render()
    await typeAmount('5')
    mocks.quote.mockClear()
    await click(flowButton('Stick'))

    // Preparing: nothing to confirm yet, and nothing sent.
    expect(dialog()).not.toBeNull()
    expect(dialog()!.querySelector('[role="status"]')!.textContent).toBe('Reading your balance, allowance and the current price…')
    expect(confirmButton()!.getAttribute('aria-busy')).toBe('true')
    expect(confirmButton()!.disabled).toBe(true)
    expect(mocks.tx.send).not.toHaveBeenCalled()

    await act(async () => reading.resolve({ balance: 100n * CPN, allowance: 3n * CPN }))
    await settled()

    // The allowance and the quote were read again, for the account and the amount of this review.
    expect(mocks.funds).toHaveBeenCalledWith(
      CHAIN,
      { token: TOKEN, owner: ALICE, spender: TERMINAL },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(mocks.quote).toHaveBeenCalledOnce()
    expect(mocks.quote).toHaveBeenCalledWith(CHAIN, BigInt(PROJECT), TOKEN, 5n * CPN, ALICE, ALICE, expect.anything())

    expect(steps()).toEqual(['Reset CPN allowance', 'Approve 5 CPN', 'Stick'])
    expect(dialog()!.textContent).toContain('3 transactions left.')
    expect(rows()).toEqual([
      ['Stick', '5 CPN'],
      ['You get at least', '9.87 STICKYCPN'],
      ['On', 'Base Sepolia'],
    ])
    expect(confirmButton()!.textContent).toBe('Confirm & approve')
    expect(confirmButton()!.disabled).toBe(false)
    expect(mocks.tx.send).not.toHaveBeenCalled()
  })

  it('plans the approval and the stick when nothing is approved yet', async () => {
    await render()
    await review()
    expect(steps()).toEqual(['Approve 5 CPN', 'Stick'])
    expect(dialog()!.textContent).toContain('2 transactions left.')
  })

  it('shows the exact minimum, every digit, in the review', async () => {
    mocks.quote.mockResolvedValue(9_876_543_210_987_654_321n)
    await render()
    await review()
    expect(rows()[1]).toEqual(['You get at least', '9.876543210987654321 STICKYCPN'])
  })

  it('after an approval that landed before a reload, plans the stick alone and makes one wallet call', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    await render()
    await review()

    expect(steps()).toEqual(['Stick'])
    expect(dialog()!.textContent).toContain('1 transaction left.')
    expect(confirmButton()!.textContent).toBe('Confirm & stick')
    await click(confirmButton())

    expect(mocks.tx.send).toHaveBeenCalledTimes(1)
    const [request, options] = mocks.tx.send.mock.calls[0]
    expect(request).toMatchObject({
      chainId: CHAIN,
      address: TERMINAL,
      functionName: 'pay',
      args: [BigInt(PROJECT), TOKEN, 5n * CPN, ALICE, MINTED, '', '0x'],
    })
    expect(options.simulationBlockNumber).toBeUndefined()
  })

  it('does not approve again for an allowance that already covers the amount', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 50n * CPN })
    await render()
    await review()
    expect(steps()).toEqual(['Stick'])
  })

  it('sends the steps in order, one for each confirmation, and simulates each after the block of the one before', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 3n * CPN })
    await render()
    await review()

    await click(confirmButton())
    // The engine has taken the step, as its own state says, and the flow renders again.
    await rerender()
    expect(mocks.tx.send).toHaveBeenCalledTimes(1)
    expect(mocks.tx.send.mock.calls[0][0]).toMatchObject({ address: TOKEN, functionName: 'approve', args: [TERMINAL, 0n] })
    expect(mocks.tx.send.mock.calls[0][1].simulationBlockNumber).toBeUndefined()
    expect(stepStates()).toEqual(['active', 'pending', 'pending'])
    expect(confirmButton()!.disabled).toBe(true)
    expect(dialog()!.textContent).toContain('Waiting for confirmation…')

    await confirmed(APPROVAL_HASH, 4_001n)
    expect(stepStates()).toEqual(['complete', 'active', 'pending'])
    expect(dialog()!.textContent).toContain('2 transactions left.')
    expect(dialog()!.querySelector('a')!.textContent).toBe('View transaction ↗')
    expect(confirmButton()!.textContent).toBe('Confirm & approve')

    await click(confirmButton())
    expect(mocks.tx.send).toHaveBeenCalledTimes(2)
    expect(mocks.tx.send.mock.calls[1][0]).toMatchObject({ address: TOKEN, functionName: 'approve', args: [TERMINAL, 5n * CPN] })
    expect(mocks.tx.send.mock.calls[1][1].simulationBlockNumber).toBe(4_001n)
    await confirmed(APPROVAL_HASH, 4_005n)
    expect(confirmButton()!.textContent).toBe('Confirm & stick')

    await click(confirmButton())
    expect(mocks.tx.send).toHaveBeenCalledTimes(3)
    expect(mocks.tx.send.mock.calls[2][0]).toMatchObject({ address: TERMINAL, functionName: 'pay' })
    expect(mocks.tx.send.mock.calls[2][1].simulationBlockNumber).toBe(4_005n)
  })

  it('counts nothing for a send the engine did not take, and skips no step', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 3n * CPN })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await render()
    await review()
    await click(confirmButton())
    await confirmed(APPROVAL_HASH, 4_001n)
    expect(stepStates()).toEqual(['complete', 'active', 'pending'])

    // The engine answers null and changes nothing for a send it will not take, as it does while it still holds its lock
    // for the step that has just confirmed. The dialog is where it was.
    mocks.tx.send.mockImplementationOnce(async () => null)
    await click(confirmButton())
    await rerender()
    expect(mocks.tx.send).toHaveBeenCalledTimes(2)
    expect(mocks.tx.send.mock.calls[1][0]).toMatchObject({ functionName: 'approve', args: [TERMINAL, 5n * CPN] })
    expect(stepStates()).toEqual(['complete', 'active', 'pending'])
    expect(dialog()!.querySelector('h2')!.textContent).toBe('Confirm stick')
    expect(dialog()!.textContent).toContain('2 transactions left.')
    expect(confirmButton()!.textContent).toBe('Confirm & approve')

    // The engine still says the last step confirmed, and says it again, as when its watcher and its poll both answer.
    // That confirmation is the last step's and is not counted for the next.
    mocks.tx.receipt = { blockNumber: 4_001n }
    await rerender()
    expect(stepStates()).toEqual(['complete', 'active', 'pending'])

    // The next click sends the step that is next, the approval.
    await click(confirmButton())
    expect(mocks.tx.send.mock.calls[2][0]).toMatchObject({ functionName: 'approve', args: [TERMINAL, 5n * CPN] })
    await confirmed(APPROVAL_HASH, 4_005n)
    expect(stepStates()).toEqual(['complete', 'complete', 'active'])

    // And the same for the stick: a refused send neither completes the dialog nor counts a stick that was never sent.
    mocks.tx.send.mockImplementationOnce(async () => null)
    await click(confirmButton())
    await rerender()
    expect(stepStates()).toEqual(['complete', 'complete', 'active'])
    expect(dialog()!.querySelector('h2')!.textContent).toBe('Confirm stick')
    expect(dialog()!.textContent).toContain('1 transaction left.')
    expect([...dialog()!.querySelectorAll('footer button')].map(button => button.textContent)).toEqual(['Cancel', 'Confirm & stick'])
    expect(invalidate).not.toHaveBeenCalled()

    await click(confirmButton())
    expect(mocks.tx.send.mock.calls[4][0]).toMatchObject({ functionName: 'pay' })
    await confirmed(STICK_HASH, 4_010n)
    expect(dialog()!.querySelector('h2')!.textContent).toBe('Stick confirmed')
    expect(invalidate).toHaveBeenCalled()
  })

  it('sends the step after the last one that confirmed for a click that a render behind handles, never one sent already', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 3n * CPN })
    await render()
    await review()
    // What a click runs while the dialog still shows the reset: the confirmation below is counted before it is handled.
    const behind = handlerOf(confirmButton()!)
    await click(confirmButton())
    await confirmed(APPROVAL_HASH, 4_001n)
    expect(stepStates()).toEqual(['complete', 'active', 'pending'])

    await act(async () => behind())
    expect(mocks.tx.send).toHaveBeenCalledTimes(2)
    expect(mocks.tx.send.mock.calls[0][0]).toMatchObject({ functionName: 'approve', args: [TERMINAL, 0n] })
    expect(mocks.tx.send.mock.calls[1][0]).toMatchObject({ functionName: 'approve', args: [TERMINAL, 5n * CPN] })
  })

  it('sends nothing for a click that a render behind handles once every step has been counted', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    await render()
    await review()
    const behind = handlerOf(confirmButton()!)
    await click(confirmButton())
    await confirmed(STICK_HASH, 4_010n)
    expect(dialog()!.querySelector('h2')!.textContent).toBe('Stick confirmed')

    await act(async () => behind())
    expect(mocks.tx.send).toHaveBeenCalledTimes(1)
    expect(dialog()!.querySelector('h2')!.textContent).toBe('Stick confirmed')
    expect(dialog()!.textContent).not.toContain('undefined')
  })

  it('stays open on the confirmed stick with a link to its transaction until Done, and then clears the amount', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    await render()
    await review()
    await click(confirmButton())
    await confirmed(STICK_HASH, 4_010n)

    expect(dialog()!.querySelector('h2')!.textContent).toBe('Stick confirmed')
    expect(stepStates()).toEqual(['complete'])
    expect(dialog()!.textContent).toContain('All transactions confirmed.')
    const link = dialog()!.querySelector('a')!
    expect(link.textContent).toBe('View transaction ↗')
    expect(link.getAttribute('href')).toBe(`https://sepolia.basescan.org/tx/${STICK_HASH}`)
    expect([...dialog()!.querySelectorAll('footer button')].map(button => button.textContent)).toEqual(['Done'])

    await settle(10 * 60_000)
    expect(dialog()).not.toBeNull()
    await click(buttonIn(dialog()!, 'Done'))
    expect(dialog()).toBeNull()
    expect(amountField().value).toBe('')
  })

  it('refreshes what a stick changed, now and twice more, and never the whole project', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await render()
    await review()
    await click(confirmButton())
    expect(invalidate).not.toHaveBeenCalled()

    await confirmed(STICK_HASH, 4_010n)
    const round = invalidate.mock.calls.length
    expect(round).toBeGreaterThan(0)
    await settle(4_000)
    expect(invalidate.mock.calls.length).toBe(round * 2)
    await settle(8_000)
    expect(invalidate.mock.calls.length).toBe(round * 3)
    await settle(60_000)
    expect(invalidate.mock.calls.length).toBe(round * 3)

    const keys = invalidate.mock.calls.slice(0, round).map(([filters]) => filters?.queryKey)
    expect(keys).not.toContainEqual(['sticky-project', CHAIN, PROJECT])
    expect(keys).toContainEqual(['sticky-project', CHAIN, PROJECT, 'info'])
  })

  it('shows what went wrong in the dialog, and sends the same step again on Retry', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    await render()
    await review()
    await click(confirmButton())
    mocks.tx.phase = 'error'
    mocks.tx.busy = false
    mocks.tx.error = 'Transaction cancelled.'
    await rerender()

    expect(dialog()!.textContent).toContain('Transaction cancelled.')
    expect(confirmButton()!.textContent).toBe('Retry')
    await click(confirmButton())
    expect(mocks.tx.send).toHaveBeenCalledTimes(2)
    expect(mocks.tx.send.mock.calls[1][0]).toMatchObject({ functionName: 'pay' })
  })

  it('simulates a retried stick after the block of the approval that came before it', async () => {
    await render()
    await review()
    await click(confirmButton())
    await confirmed(APPROVAL_HASH, 4_001n)
    await click(confirmButton())
    mocks.tx.phase = 'error'
    mocks.tx.busy = false
    mocks.tx.error = 'Transaction cancelled.'
    await rerender()

    await click(confirmButton())
    expect(mocks.tx.send).toHaveBeenCalledTimes(3)
    expect(mocks.tx.send.mock.calls[2][0]).toMatchObject({ functionName: 'pay' })
    expect(mocks.tx.send.mock.calls[2][1].simulationBlockNumber).toBe(4_001n)
  })

  it('reads the balance again just before each send, and stops when it no longer covers the amount', async () => {
    await render()
    await review()
    await click(confirmButton())
    const [request, { reverify }] = mocks.tx.send.mock.calls[0]

    mocks.funds.mockClear()
    await expect(reverify(request)).resolves.toBeUndefined()
    expect(mocks.funds).toHaveBeenCalledWith(CHAIN, { token: TOKEN, owner: ALICE, spender: TERMINAL })

    mocks.funds.mockResolvedValue({ balance: 4n * CPN, allowance: 0n })
    await expect(reverify(request)).rejects.toThrow('Your CPN balance changed. Review the amount.')
  })

  it('tells the console why the balance could not be checked before a send, and keeps the cause', async () => {
    await render()
    await review()
    await click(confirmButton())
    const [request, { reverify }] = mocks.tx.send.mock.calls[0]

    const cause = new Error('429')
    const unreadable = new Error('the balance and the allowance could not be read.', { cause })
    mocks.funds.mockRejectedValue(unreadable)
    await expect(reverify(request)).rejects.toMatchObject({
      message: 'The balance and the allowance could not be read.',
      cause: unreadable,
    })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('balance'), { chainId: CHAIN, projectId: PROJECT }, unreadable)
  })

  it('refuses a balance that no longer covers the amount when the review reads it, and opens nothing', async () => {
    mocks.funds.mockResolvedValue({ balance: 4n * CPN, allowance: 0n })
    await render()
    await review()
    expect(dialog()).toBeNull()
    expect(alerts()).toEqual(['That is more than you hold.'])
    expect(mocks.quote).toHaveBeenCalledTimes(1)
    expect(mocks.tx.send).not.toHaveBeenCalled()
  })

  it('names what could not be read, and warns with its cause, when the review cannot read the chain', async () => {
    const cause = new Error('429')
    mocks.funds.mockRejectedValue(new Error('the balance and the allowance could not be read.', { cause }))
    await render()
    await review()
    expect(dialog()).toBeNull()
    expect(alerts()).toEqual(['The balance and the allowance could not be read.'])
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('stick'), expect.anything(), expect.objectContaining({ cause }))
  })

  it('refuses a quote that fails on the review, and sends nothing', async () => {
    await render()
    await typeAmount('5')
    mocks.quote.mockRejectedValue(new Error('the terminal\'s stick preview could not be read.'))
    await click(flowButton('Stick'))
    await settled()
    expect(dialog()).toBeNull()
    expect(alerts()).toEqual(['The terminal\'s stick preview could not be read.'])
  })

  it('gives up on its reads when it is closed while it reads', async () => {
    const reading = Promise.withResolvers<{ balance: bigint; allowance: bigint }>()
    mocks.funds.mockReturnValue(reading.promise)
    await render()
    await typeAmount('5')
    await click(flowButton('Stick'))
    const { signal } = mocks.funds.mock.calls[0][2] as { signal: AbortSignal }
    expect(signal.aborted).toBe(false)

    await click(buttonIn(dialog()!, 'Cancel'))
    expect(signal.aborted).toBe(true)
    expect(dialog()).toBeNull()

    // What it finds out afterwards opens nothing.
    await act(async () => reading.resolve({ balance: 100n * CPN, allowance: 0n }))
    await settled()
    expect(dialog()).toBeNull()
    expect(alerts()).toEqual([])
  })

  it('drops the plan when the connected account is no longer the one it was made for', async () => {
    await render()
    await review()
    expect(steps()).toEqual(['Approve 5 CPN', 'Stick'])

    mocks.wallet = { ...mocks.wallet, address: BOB }
    await rerender()
    await click(confirmButton())

    expect(mocks.tx.send).not.toHaveBeenCalled()
    expect(dialog()).toBeNull()
    expect(alerts()).toEqual(['Your connected account changed. Review again.'])
  })

  it('plans again from the start after the dialog is closed, reading what the chain says now', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 0n })
    await render()
    await review()
    await click(confirmButton())
    await confirmed(APPROVAL_HASH, 4_001n)
    await click(buttonIn(dialog()!, 'Cancel'))
    expect(dialog()).toBeNull()

    // The approval landed, then the page was closed: the next review finds it and does not ask for another.
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    await click(flowButton('Stick'))
    await settled()
    expect(steps()).toEqual(['Stick'])
    expect(mocks.tx.reset).toHaveBeenCalled()

    // What the approval counted for the last plan counts for nothing in this one: its first step is sent.
    mocks.tx.send.mockClear()
    await click(confirmButton())
    expect(mocks.tx.send).toHaveBeenCalledTimes(1)
    expect(mocks.tx.send.mock.calls[0][0]).toMatchObject({ functionName: 'pay' })
  })
})

describe('a wallet that cannot send', () => {
  it('is refused when the review starts if it is Signa, which offers to connect an external wallet', async () => {
    mocks.wallet = { ...mocks.wallet, isCenterWallet: true }
    await render()
    await typeAmount('5')
    await click(flowButton('Stick'))

    expect(dialog()).toBeNull()
    expect(alerts()).toEqual([`${EXTERNAL_WALLET_REQUIRED} Connect a wallet`])
    expect(buttonIn(host, 'Connect a wallet')).toBeDefined()
    expect(mocks.funds).not.toHaveBeenCalled()
    expect(mocks.tx.send).not.toHaveBeenCalled()
  })

  it('reviews again, for the account that connects, once an external wallet connects', async () => {
    mocks.wallet = { ...mocks.wallet, isCenterWallet: true }
    await render()
    await typeAmount('5')
    await click(flowButton('Stick'))
    expect(dialog()).toBeNull()

    mocks.wallet = { ...mocks.wallet, isCenterWallet: false, address: BOB }
    await rerender()

    expect(alerts()).toEqual([])
    expect(mocks.funds).toHaveBeenCalledOnce()
    expect(mocks.funds).toHaveBeenCalledWith(CHAIN, { token: TOKEN, owner: BOB, spender: TERMINAL }, expect.anything())
    expect(steps()).toEqual(['Approve 5 CPN', 'Stick'])
    expect(mocks.tx.send).not.toHaveBeenCalled()
  })

  it('passes the engine\'s own refusal through, and plans again once an external wallet connects, for its account', async () => {
    await render()
    await review()
    await click(confirmButton())

    // The engine refuses the send: the connected wallet is Signa.
    mocks.wallet = { ...mocks.wallet, isCenterWallet: true }
    mocks.tx.phase = 'error'
    mocks.tx.busy = false
    mocks.tx.error = EXTERNAL_WALLET_REQUIRED
    await rerender()
    expect(dialog()!.textContent).toContain(`${EXTERNAL_WALLET_REQUIRED} Connect a wallet`)
    expect(buttonIn(dialog()!, 'Connect a wallet')).toBeDefined()
    expect(mocks.funds).toHaveBeenCalledTimes(1)

    // An external wallet connects: the refusal is cleared, and the plan made for the account that could not send is
    // made again for this one.
    mocks.wallet = { ...mocks.wallet, isCenterWallet: false, address: BOB }
    await rerender()
    expect(mocks.tx.reset).toHaveBeenCalled()
    expect(dialog()!.textContent).not.toContain(EXTERNAL_WALLET_REQUIRED)
    expect(mocks.funds).toHaveBeenCalledTimes(2)
    expect(mocks.funds).toHaveBeenLastCalledWith(CHAIN, { token: TOKEN, owner: BOB, spender: TERMINAL }, expect.anything())
    expect(steps()).toEqual(['Approve 5 CPN', 'Stick'])
    expect(confirmButton()!.textContent).toBe('Confirm & approve')
  })

  it('does not review on its own for an external wallet that connects when nothing was refused', async () => {
    mocks.wallet = { ...mocks.wallet, isConnected: false, address: undefined }
    await render()
    await typeAmount('5')
    mocks.wallet = { ...mocks.wallet, isConnected: true, address: BOB }
    await rerender()
    expect(dialog()).toBeNull()
    expect(mocks.funds).not.toHaveBeenCalled()
  })

  it('is refused when the site is viewing as another account', async () => {
    await render()
    await typeAmount('5')
    await act(async () => setViewAs(BOB))
    await click(flowButton('Stick'))

    expect(dialog()).toBeNull()
    expect(alerts()).toEqual([VIEW_AS_WRITE_BLOCKED])
    expect(mocks.funds).not.toHaveBeenCalled()

    // The refusal is about View as, so it ends with it.
    await act(async () => clearViewAs())
    expect(alerts()).toEqual([])
  })
})

describe('sticking for someone else', () => {
  const fill = async (recipient: string, amount = '5') => {
    await type(recipientField(), recipient)
    await typeAmount(amount)
  }

  it('quotes what they get, as the sender, for the recipient', async () => {
    await render({ forSomeoneElse: true })
    await fill(FRIEND)
    expect(mocks.quote).toHaveBeenCalledWith(CHAIN, BigInt(PROJECT), TOKEN, 5n * CPN, ALICE, FRIEND, expect.anything())
    expect(hint()).toBe('They get at least 9.87 STICKYCPN')
    expect(flowButton('Review stick').disabled).toBe(false)
  })

  it('asks for a recipient and an amount, each with its label, and no wallet link to fill the amount from', async () => {
    await render({ forSomeoneElse: true })
    expect(host.querySelectorAll('input')).toHaveLength(2)
    expect(host.textContent).not.toContain('in wallet')

    // The labels are seen, and the fields keep the names a screen reader is given.
    const labels = [...host.querySelectorAll('label')]
    expect(labels.map(label => label.textContent)).toEqual(['Recipient', 'Amount'])
    expect(labels.map(label => (label as HTMLLabelElement).control)).toEqual([recipientField(), amountField()])
    expect(recipientField().getAttribute('aria-label')).toBe('Recipient address')
    expect(amountField().getAttribute('aria-label')).toBe('Amount of underlying tokens to stick')
  })

  it('refuses a recipient who has not trusted the sender, in the hint and on the button, before the review', async () => {
    mocks.canStick.mockRejectedValue(new Error('this holder must trust your address before you can stick for them'))
    await render({ forSomeoneElse: true })
    await fill(FRIEND)

    expect(mocks.canStick).toHaveBeenCalledWith(CHAIN, BigInt(PROJECT), ALICE, FRIEND, expect.anything())
    expect(hint()).toBe('This holder must trust your address before you can stick for them.')
    expect(flowButton('Review stick').disabled).toBe(true)
    expect(mocks.quote).not.toHaveBeenCalled()
  })

  it('checks the recipient\'s trust again when the review reads, and opens nothing for a recipient who withdrew it', async () => {
    await render({ forSomeoneElse: true })
    await fill(FRIEND)
    expect(hint()).toBe('They get at least 9.87 STICKYCPN')

    mocks.canStick.mockRejectedValue(new Error('this holder must trust your address before you can stick for them'))
    await click(flowButton('Review stick'))
    await settled()

    expect(dialog()).toBeNull()
    expect(alerts()).toEqual(['This holder must trust your address before you can stick for them.'])
    expect(mocks.funds).not.toHaveBeenCalled()
    expect(mocks.tx.send).not.toHaveBeenCalled()
  })

  it('reviews a stick for a recipient who trusts the sender, with the recipient as the beneficiary', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    await render({ forSomeoneElse: true })
    await fill(FRIEND)
    mocks.quote.mockClear()
    mocks.canStick.mockClear()
    await click(flowButton('Review stick'))
    await settled()

    expect(mocks.canStick).toHaveBeenCalledWith(CHAIN, BigInt(PROJECT), ALICE, FRIEND, expect.anything())
    expect(mocks.quote).toHaveBeenCalledWith(CHAIN, BigInt(PROJECT), TOKEN, 5n * CPN, ALICE, FRIEND, expect.anything())
    expect(dialog()!.querySelector('h2')!.textContent).toBe('Confirm stick for someone else')
    expect(steps()).toEqual(['Stick'])
    expect(rows()).toEqual([
      ['Stick', '5 CPN'],
      ['For', FRIEND],
      ['They get at least', '9.87 STICKYCPN'],
      ['On', 'Base Sepolia'],
    ])

    await click(confirmButton())
    expect(mocks.tx.send.mock.calls[0][0]).toMatchObject({
      functionName: 'pay',
      args: [BigInt(PROJECT), TOKEN, 5n * CPN, FRIEND, MINTED, '', '0x'],
    })
  })

  it('needs no one\'s trust to stick for the sender itself', async () => {
    mocks.funds.mockResolvedValue({ balance: 100n * CPN, allowance: 5n * CPN })
    await render({ forSomeoneElse: true })
    await fill(ALICE.toLowerCase())
    await click(flowButton('Review stick'))
    await settled()
    expect(steps()).toEqual(['Stick'])
    expect(mocks.tx.send).not.toHaveBeenCalled()
    await click(confirmButton())
    expect(mocks.tx.send.mock.calls[0][0].args[3]).toBe(ALICE)
  })

  it('refuses the zero address as a recipient before it quotes or reviews', async () => {
    await render({ forSomeoneElse: true })
    await fill(zeroAddress)

    expect(hint()).toBe('Enter a valid recipient address.')
    expect(flowButton('Review stick').disabled).toBe(true)
    expect(mocks.quote).not.toHaveBeenCalled()
    expect(mocks.canStick).not.toHaveBeenCalled()

    await click(flowButton('Review stick'))
    expect(dialog()).toBeNull()
    expect(mocks.funds).not.toHaveBeenCalled()
  })

  it.each(['0x1234', 'someone.eth', `0x${'g'.repeat(40)}`, WRONG_CHECKSUM])('refuses %j as a recipient', async recipient => {
    expect(isAddress(recipient)).toBe(false)
    await render({ forSomeoneElse: true })
    await fill(recipient)
    expect(hint()).toBe('Enter a valid recipient address.')
    expect(flowButton('Review stick').disabled).toBe(true)
    expect(mocks.quote).not.toHaveBeenCalled()
  })

  it('says nothing of the recipient until one is typed', async () => {
    await render({ forSomeoneElse: true })
    await typeAmount('5')
    expect(hint()).toBeNull()
    expect(mocks.quote).not.toHaveBeenCalled()
    expect(flowButton('Review stick').disabled).toBe(true)
  })

  it('does not quote for a visitor without a wallet, who is asked to sign in', async () => {
    mocks.wallet = { ...mocks.wallet, isConnected: false, address: undefined }
    await render({ forSomeoneElse: true })
    await fill(FRIEND)
    expect(mocks.quote).not.toHaveBeenCalled()
    await click(flowButton('Sign in to stick'))
    expect(mocks.wallet.openSignIn).toHaveBeenCalledOnce()
  })
})

describe('the Stick card', () => {
  it('names the token it sticks, and holds the flow for the signed-in holder', async () => {
    await act(async () => root.render(<QueryClientProvider client={client}><StickCard chainId={CHAIN} projectId={PROJECT} /></QueryClientProvider>))
    await settled()

    expect(host.querySelector('section[aria-labelledby="stick-title"] h2')!.textContent).toBe('Stick CPN')
    expect(host.querySelectorAll('input')).toHaveLength(1)
    expect(host.querySelectorAll('label')).toHaveLength(0)
    expect(flowButton('Stick').disabled).toBe(true)
    await type(amountField(), '5')
    await settle(250)
    await settled()
    expect(flowButton('Stick').disabled).toBe(false)
  })
})
