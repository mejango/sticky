// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, notifyManager, type QueryKey } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { encodeFunctionData, erc20Abi, getAddress, zeroAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import records from '@/lib/sticky-deployments.json'
import type { StickyPosition } from '@/lib/sticky-holders'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED, WalletAuthContext } from '@/providers/WalletAuthContext'
import { E18, TOKEN, stickyInfo } from '../home-fixtures'

// The Transfer flow: who can send Sticky tokens, to whom and how much, what it reads before it asks the wallet, and what
// it refreshes afterwards. The engine has tests of its own (test/transactions): its hook is a mock here, its dialogs
// are real. The clock is fake, so the refreshes that follow a transfer happen only when a test moves it.

const mocks = vi.hoisted(() => ({
  wallet: { address: undefined as string | undefined, isConnected: false, isCenterWallet: false },
  openSignIn: vi.fn(),
  requestSignIn: vi.fn(),
  tx: {} as Record<string, unknown>,
  read: vi.fn(),
  position: vi.fn(),
  ens: vi.fn(),
}))

vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ ...mocks.wallet, openSignIn: mocks.openSignIn }) }))
// The engine's hook is a mock; its labels for the phases it reports are its own.
vi.mock('@/hooks/useSafeTx', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hooks/useSafeTx')>()),
  useSafeTx: () => mocks.tx,
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
  lookupEnsName: mocks.ens,
}))

import { TransferFlow } from '@/components/project/flows/TransferFlow'

const CHAIN = 84532
const PROJECT = 12
const ALICE = getAddress(`0x${'a1'.repeat(20)}`)
const BOB = getAddress(`0x${'b2'.repeat(20)}`)
const CAROL = getAddress(`0x${'c4'.repeat(20)}`)
const STICKY = getAddress(`0x${'5'.repeat(40)}`)
const HASH = `0x${'c3'.repeat(32)}`

/** STICKYART on Base Sepolia, which sticks ART of 6 decimals, transferable. */
const artInfo = (extra: Partial<StickyProjectInfo> = {}) =>
  stickyInfo(CHAIN, BigInt(PROJECT), { stToken: STICKY, stSymbol: 'STICKYART', symbol: 'ART', decimals: 6, ...extra })

const position = (staked: bigint): StickyPosition => ({
  staked,
  wallet: 0n,
  start: 0,
  current: 0,
  longest: 0,
  blockNumber: 100n,
  timestamp: 1_800_000_000,
})

const idle = () => ({
  phase: 'idle',
  busy: false,
  hash: null as string | null,
  error: null as string | null,
  receipt: null,
  isSafe: false,
  safeProposalHash: null,
  safeNonceGuidance: null as string | null,
  confirmationUncertain: false,
  send: vi.fn().mockResolvedValue(null),
  reset: vi.fn(),
})
const tx = () => mocks.tx as ReturnType<typeof idle>

/** What a read of the holder's Sticky balance answers. */
const balance = (value: bigint) => [{ status: 'success', result: value }]
const word = (value: bigint | string) => BigInt(value).toString(16).padStart(64, '0')
/** An address with one letter's case changed, which a checksum forbids. */
const miscased = (address: Address) =>
  address.replace(/[a-fA-F]/, letter => (letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase())) as Address

let host: HTMLDivElement
let root: Root
let client: QueryClient
const onClose = vi.fn()

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: false }
  mocks.openSignIn.mockReset().mockResolvedValue(undefined)
  mocks.requestSignIn.mockReset().mockResolvedValue(undefined)
  mocks.tx = idle()
  mocks.read.mockReset().mockResolvedValue(balance(2n * E18))
  mocks.position.mockReset().mockResolvedValue(position(2n * E18))
  mocks.ens.mockReset().mockResolvedValue(null)
  onClose.mockReset()
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
})

const settle = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

async function render(info: StickyProjectInfo = artInfo()) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WalletAuthContext.Provider value={{ requestSignIn: mocks.requestSignIn }}>
          <TransferFlow info={info} onClose={onClose} />
        </WalletAuthContext.Provider>
      </QueryClientProvider>,
    ),
  )
  await settle()
}

/** The flow's dialog: a modal with the form, and, once a transfer is planned, its confirm in the same card. */
const modal = () => document.querySelector('dialog')!
const confirm = () => document.querySelector<HTMLElement>('section[data-tx-confirm]')
const buttonIn = (within: ParentNode | null, name: string) =>
  [...(within?.querySelectorAll('button') ?? [])].find(each => each.textContent === name) as HTMLButtonElement | undefined
const closeButton = () => modal().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!
const press = async (within: ParentNode | null, name: string) => {
  await act(async () => buttonIn(within, name)!.click())
  await settle()
}
const field = (label: string) => {
  const found = [...modal().querySelectorAll('label')].find(each => each.textContent === label)
  return found ? (document.getElementById(found.htmlFor) as HTMLInputElement) : null
}
async function type(label: string, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setValue.call(field(label), text)
    field(label)!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const errorText = () => modal().querySelector('p.wrap-anywhere')?.textContent ?? null
/** What the confirmation says of its send, under its steps, and the state of each step. */
const statusLine = () => confirm()?.querySelector('p.text-bluebs-700')?.textContent ?? null
const stepStates = () => [...(confirm()?.querySelectorAll('ol li') ?? [])].map(item => item.getAttribute('data-state'))
const primary = () => confirm()!.querySelector<HTMLButtonElement>('footer button.btn-primary')!

/** Fills the form and asks for the review. */
async function review(recipient: string, amount: string) {
  await type('Recipient', recipient)
  await type('Amount', amount)
  await press(modal(), 'Review transfer')
}

describe('the form', () => {
  it('shows what the holder has, reading it once for the tab', async () => {
    await render()
    expect(modal().textContent).toContain('You hold 2 STICKYART.')
    expect(mocks.position).toHaveBeenCalledWith(CHAIN, expect.objectContaining({ stToken: STICKY }), ALICE, expect.anything())
    expect(field('Recipient')).not.toBeNull()
    expect(field('Amount')).not.toBeNull()
    expect(modal().textContent).toContain('Moved tokens start a new stick for the recipient.')
  })

  it('says it is checking while the balance is read, and that it could not when it cannot, and never shows zero', async () => {
    mocks.position.mockReturnValue(new Promise(() => {}))
    await render()
    expect(modal().textContent).toContain('Checking your balance…')
    expect(modal().textContent).not.toContain('You hold 0')

    mocks.position.mockRejectedValue(new Error('429'))
    await act(async () => root.unmount())
    root = createRoot(host)
    client.clear()
    await render()
    expect(modal().textContent).toContain('Could not read your balance.')
    expect(modal().textContent).not.toContain('You hold')
  })

  it('reads nothing of a holder who is signed out, and asks to sign in instead of reviewing', async () => {
    mocks.wallet = { address: undefined, isConnected: false, isCenterWallet: false }
    await render()
    expect(mocks.position).not.toHaveBeenCalled()
    expect(modal().textContent).not.toContain('You hold')
    expect(buttonIn(modal(), 'Review transfer')).toBeUndefined()
    await press(modal(), 'Sign in to transfer')
    expect(mocks.openSignIn).toHaveBeenCalledOnce()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(confirm()).toBeNull()
  })

  it('fills in the whole balance, every digit of it, from max', async () => {
    mocks.position.mockResolvedValue(position(1_500_000_000_000_000_001n))
    await render()
    await press(modal(), 'max')
    expect(field('Amount')!.value).toBe('1.500000000000000001')
  })

  it('offers max only once the balance is known and there is something to move', async () => {
    mocks.position.mockResolvedValue(position(0n))
    await render()
    expect(buttonIn(modal(), 'max')?.disabled).toBe(true)
  })

  it('warns as the amount passes what the holder has', async () => {
    await render()
    await type('Amount', '2')
    expect(modal().textContent).not.toContain('That is more than you hold.')
    await type('Amount', '2.000000000000000001')
    expect(modal().textContent).toContain('That is more than you hold.')
  })
})

describe('the recipient', () => {
  it('shows the name a production chain gives the address, and asks for none on a testnet', async () => {
    mocks.ens.mockResolvedValue('bob.eth')
    await render(artInfo({ chainId: 8453 }))
    await type('Recipient', BOB)
    await settle()
    expect(mocks.ens).toHaveBeenCalledWith(BOB, 8453)
    expect(modal().textContent).toContain('bob.eth')

    await act(async () => root.unmount())
    root = createRoot(host)
    client.clear()
    mocks.ens.mockClear()
    await render()
    await type('Recipient', BOB)
    await settle()
    expect(mocks.ens).not.toHaveBeenCalled()
    expect(modal().textContent).not.toContain('bob.eth')
  })

  it('takes an address in one case, or with its checksum, and reviews it as the checksummed address', async () => {
    expect(BOB).not.toBe(BOB.toLowerCase())
    await render()
    await review(BOB.toLowerCase(), '1')
    expect(confirm()!.textContent).toContain(BOB)
    expect(confirm()!.textContent).not.toContain(BOB.toLowerCase())

    await press(confirm(), 'Cancel')
    await review(BOB, '1')
    expect(confirm()!.textContent).toContain(BOB)
  })

  it.each([
    ['a word', 'bob'],
    ['a short address', BOB.slice(0, 40)],
    ['an address with one more digit', `${BOB}0`],
    ['an address with a wrong checksum', miscased(BOB)],
    ['the zero address', zeroAddress],
    ['nothing', ''],
  ])('refuses %s before it reads or asks anything', async (_name, recipient) => {
    await render()
    await review(recipient, '1')
    expect(errorText()).toBe('Enter a valid recipient address.')
    expect(confirm()).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it('refuses the sender\'s own address, in any case', async () => {
    await render()
    for (const own of [ALICE, ALICE.toLowerCase()]) {
      await review(own, '1')
      expect(errorText()).toBe('Choose a different recipient.')
    }
    expect(confirm()).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(tx().send).not.toHaveBeenCalled()
  })

  /** Every address in the chain's deployment record, by the field that holds it, read from the record itself: a
   * contract the record gains is refused, and tested, with no change here. */
  const recorded = Object.entries(records[String(CHAIN) as keyof typeof records]).filter(
    (entry): entry is [string, Address] => entry[0] !== 'fromBlock',
  )

  it('counts the auto-stick adapter, and every other Sticky contract, among the recorded contracts it refuses', () => {
    expect(recorded).toContainEqual(['autoStick', '0x9B091e21d25c424De67751F4b6Ae8494351218C5'])
    expect(recorded.map(([field]) => field)).toEqual(
      expect.arrayContaining(['deployer', 'hook', 'terminal', 'controller', 'distributor', 'rewardReceiverFactory', 'autoStick']),
    )
  })

  it.each([
    ...recorded.map(([field, address]): [string, Address] => [`the recorded ${field}`, address]),
    ['the Sticky token itself', STICKY],
    ['the token it sticks', TOKEN],
  ])('refuses %s, where the tokens are lost for good, in any case, before it reads or asks anything', async (_name, contract) => {
    await render()
    for (const recipient of [getAddress(contract), contract.toLowerCase()]) {
      await review(recipient, '1')
      expect(errorText()).toBe('Sticky tokens sent to this contract are lost. Choose a different recipient.')
    }
    expect(confirm()).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it("takes another project's Sticky token as a recipient: only this project's own contracts are refused", async () => {
    await render(artInfo({ stToken: CAROL }))
    await review(STICKY, '1')
    expect(errorText()).toBeNull()
    expect(confirm()!.textContent).toContain(STICKY)
  })
})

describe('the amount', () => {
  it.each([
    ['nothing', '', 'Enter an amount greater than zero.'],
    ['zero', '0', 'Enter an amount greater than zero.'],
    ['zeros', '0.000000000000000000', 'Enter an amount greater than zero.'],
    ['a point', '.', 'Enter a valid amount.'],
    ['a minus', '-1', 'Enter a valid amount.'],
    ['a plus', '+1', 'Enter a valid amount.'],
    ['an exponent', '1e3', 'Enter a valid amount.'],
    ['two points', '1.2.3', 'Enter a valid amount.'],
    ['a comma', '1,5', 'Enter a valid amount.'],
    ['a word', 'all', 'Enter a valid amount.'],
    ['a 19th decimal, which would be rounded away', '0.0000000000000000001', 'Enter a valid amount.'],
  ])('refuses %s, and reads nothing', async (_name, amount, message) => {
    await render()
    await review(BOB, amount)
    expect(errorText()).toBe(message)
    expect(confirm()).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it('refuses more than the chain says the holder has, however the page last showed it', async () => {
    mocks.read.mockResolvedValue(balance(E18))
    await render()
    expect(modal().textContent).toContain('You hold 2 STICKYART.')
    await review(BOB, '1.5')
    expect(errorText()).toBe('That is more than you hold.')
    expect(confirm()).toBeNull()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it('keeps Review closed while the amount is more than the page shows, and opens it when it is not', async () => {
    await render()
    await type('Recipient', BOB)
    await type('Amount', '2.5')
    expect(buttonIn(modal(), 'Review transfer')!.disabled).toBe(true)
    await type('Amount', '2')
    expect(buttonIn(modal(), 'Review transfer')!.disabled).toBe(false)
  })

  it('takes the amount with 18 decimals, every digit', async () => {
    await render()
    await review(BOB, '1.000000000000000001')
    expect(confirm()!.textContent).toContain('1.000000000000000001 STICKYART')
  })
})

describe('a token that is locked', () => {
  it('cannot be transferred: the holder is told, and nothing is read or sent', async () => {
    await render(artInfo({ soulbound: true }))
    await review(BOB, '1')
    expect(errorText()).toBe('This Sticky token is locked and cannot be transferred.')
    expect(confirm()).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(tx().send).not.toHaveBeenCalled()
  })
})

describe('the review', () => {
  it('reads the holder\'s balance from the token, then lists the one transaction it will send', async () => {
    const reading = Promise.withResolvers<ReturnType<typeof balance>>()
    mocks.read.mockReturnValue(reading.promise)
    await render()
    await review(BOB, '1.5')
    expect(confirm()!.textContent).toContain('Reading your balance…')
    expect(mocks.read.mock.calls[0].slice(0, 3)).toEqual([
      CHAIN,
      [{ address: STICKY, abi: erc20Abi, functionName: 'balanceOf', args: [ALICE] }],
      undefined,
    ])

    await act(async () => reading.resolve(balance(2n * E18)))
    await settle()
    const text = confirm()!.textContent!
    expect(text).toContain('Transfer')
    expect(text).toContain('1.5 STICKYART')
    expect(text).toContain(BOB)
    expect(text).toContain('Base Sepolia')
    expect(text).toContain('1 transaction left.')
    expect(text).toContain('The moved tokens start a new tranche now for the recipient. Your remaining tranches keep their dates.')
    expect(text).not.toContain('ends your current streak')
    expect(buttonIn(confirm(), 'Confirm & transfer')).toBeDefined()
    // The form waits behind the confirm, in the same card: one dialog, one scrim.
    expect(modal().contains(confirm())).toBe(true)
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
    expect(field('Recipient')!.closest('[hidden]')).not.toBeNull()
  })

  it('says a transfer of the whole balance ends the streak', async () => {
    await render()
    await review(BOB, '2')
    expect(confirm()!.textContent).toContain('Sending your whole balance ends your current streak.')
  })

  it('brings the form back, as it was, when the confirm is cancelled', async () => {
    await render()
    await review(BOB, '1')
    tx().reset.mockClear()
    await press(confirm(), 'Cancel')
    expect(confirm()).toBeNull()
    expect(field('Recipient')!.value).toBe(BOB)
    expect(field('Amount')!.value).toBe('1')
    expect(field('Recipient')!.closest('[hidden]')).toBeNull()
    expect(tx().reset).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not come back when the confirm was cancelled before the balance was read', async () => {
    const reading = Promise.withResolvers<ReturnType<typeof balance>>()
    mocks.read.mockReturnValue(reading.promise)
    await render()
    await review(BOB, '1')
    await press(confirm(), 'Cancel')
    await act(async () => reading.resolve(balance(2n * E18)))
    await settle()
    expect(confirm()).toBeNull()
  })

  it('fails closed when the balance cannot be read: the holder is told, the console too, and nothing goes on', async () => {
    const failure = new Error('429', { cause: 'slow down' })
    mocks.read.mockRejectedValue(failure)
    await render()
    await review(BOB, '1')
    expect(errorText()).toBe('Could not read your Sticky balance. Try again.')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('balance'), { chainId: CHAIN, projectId: PROJECT }, failure)
    expect(confirm()).toBeNull()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it('takes an answer of a revert as no balance, never as zero', async () => {
    mocks.read.mockResolvedValue([{ status: 'failure', error: new Error('reverted') }])
    await render()
    await review(BOB, '1')
    expect(errorText()).toBe('Could not read your Sticky balance. Try again.')
    expect(confirm()).toBeNull()
  })
})

describe('the send', () => {
  it('sends exactly the reviewed transfer of Sticky tokens: the token, the recipient and 18 decimals, in a request that cannot change', async () => {
    await render()
    await review(BOB, '1.000000000000000001')
    await press(confirm(), 'Confirm & transfer')

    expect(tx().send).toHaveBeenCalledOnce()
    const [request] = tx().send.mock.calls[0] as [{ chainId: number; address: Address; functionName: string; args: unknown[] }]
    expect(request).toMatchObject({ chainId: CHAIN, address: STICKY, functionName: 'transfer', args: [BOB, 1_000_000_000_000_000_001n] })
    expect(encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [BOB, 1_000_000_000_000_000_001n] })).toBe(
      `0xa9059cbb${word(BOB)}${word(1_000_000_000_000_000_001n)}`,
    )
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.args)).toBe(true)
  })

  it('reads the balance again just before it asks the wallet, and stops if it has fallen below the amount', async () => {
    await render()
    await review(BOB, '1.5')
    await press(confirm(), 'Confirm & transfer')
    const [request, options] = tx().send.mock.calls[0] as [unknown, { reverify: (request: unknown) => Promise<unknown> }]

    mocks.read.mockClear().mockResolvedValue(balance(2n * E18))
    await expect(options.reverify(request)).resolves.toBeUndefined()
    expect(mocks.read).toHaveBeenCalledOnce()

    mocks.read.mockResolvedValue(balance(E18))
    await expect(options.reverify(request)).rejects.toThrow('Your token balance changed. Review the amount.')

    mocks.read.mockRejectedValue(new Error('429'))
    await expect(options.reverify(request)).rejects.toThrow('Could not read your Sticky balance. Try again.')
  })

  it('asks once, and is busy while the engine is', async () => {
    await render()
    await review(BOB, '1')
    tx().busy = true
    tx().phase = 'signing'
    await render()
    const dialog = confirm()!
    expect(primary().disabled).toBe(true)
    expect(buttonIn(dialog, 'Cancel')!.disabled).toBe(true)
  })

  it('shows its one step as the one to confirm before it is sent, and as done once it is', async () => {
    await render()
    await review(BOB, '1')
    expect(stepStates()).toEqual(['active'])
    tx().phase = 'success'
    tx().hash = HASH
    await render()
    expect(stepStates()).toEqual(['complete'])
  })

  it('says what the engine is doing while it sends, from its check to the wallet to the chain', async () => {
    await render()
    await review(BOB, '1')
    expect(statusLine()).toBeNull()
    expect(primary().textContent).toBe('Confirm & transfer')
    tx().busy = true
    for (const [phase, line, button] of [
      ['simulating', 'Double-checking the transaction…', 'Double-checking the transaction…'],
      ['signing', 'Confirm in your wallet…', 'Confirm in your wallet…'],
      ['pending', 'Waiting for confirmation…', 'Confirming…'],
    ]) {
      tx().phase = phase
      await render()
      expect(statusLine(), phase).toBe(line)
      expect(primary().textContent, phase).toBe(button)
      expect(stepStates()).toEqual(['active'])
    }

    // A Safe's guidance stands in for the wait while its proposal is pending.
    tx().safeNonceGuidance = 'Safe nonce guidance'
    await render()
    expect(statusLine()).toBe('Safe nonce guidance')
  })

  it('shows the engine\'s error in the confirm, and offers to try again', async () => {
    await render()
    await review(BOB, '1')
    tx().phase = 'error'
    tx().error = 'Transaction cancelled.'
    await render()
    expect(confirm()!.textContent).toContain('Transaction cancelled.')
    await press(confirm(), 'Retry')
    expect(tx().send).toHaveBeenCalledOnce()
  })
})

describe('once the transfer is confirmed', () => {
  async function confirmed() {
    await render()
    await review(BOB, '1')
    tx().phase = 'success'
    tx().hash = HASH
    await render()
  }

  it('says so, links the transaction and stays open until Done, which closes the flow', async () => {
    await confirmed()
    const dialog = confirm()!
    expect(dialog.textContent).toContain('Sticky tokens transferred')
    expect(dialog.textContent).toContain('All transactions confirmed.')
    const link = dialog.querySelector('a')!
    expect(link.textContent).toBe('View transaction ↗')
    expect(link.getAttribute('href')).toBe(`https://sepolia.basescan.org/tx/${HASH}`)
    expect([...dialog.querySelectorAll('footer button')].map(each => each.textContent)).toEqual(['Done'])

    await settle(10 * 60_000)
    expect(confirm()).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    await press(confirm(), 'Done')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('reads again what a transfer changes, now and as the index catches up, and nothing else of the project', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const keys = (): QueryKey[] => invalidate.mock.calls.map(([filters]) => filters!.queryKey!)
    const project = (...rest: string[]) => ['sticky-project', CHAIN, PROJECT, ...rest]
    const changed = [
      project('events'),
      project('holders'),
      project('sticks'),
      project('latest'),
      project('page-balances'),
      ['sticky-position', CHAIN, PROJECT],
      ['sticky-tranches', CHAIN, PROJECT],
      ['sticky-rewards', CHAIN, PROJECT],
      ['sticky-account'],
    ]
    await confirmed()
    expect(keys()).toEqual(changed)

    await settle(3_999)
    expect(keys()).toEqual(changed)
    await settle(1)
    expect(keys()).toEqual([...changed, ...changed])
    await settle(8_000)
    expect(keys()).toEqual([...changed, ...changed, ...changed])
    await settle(60_000)
    expect(keys()).toHaveLength(changed.length * 3)
    // The Overview's scans are a project's prefix of their own: they are never requeued by a transfer.
    expect(keys().some(key => key.length <= 3 && key[0] === 'sticky-project')).toBe(false)
    expect(keys().some(key => key[3] === 'funding' || key[3] === 'info')).toBe(false)
  })

  it('refreshes once for one transfer, however often the flow renders', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await confirmed()
    await render()
    await render()
    expect(invalidate).toHaveBeenCalledTimes(9)
  })
})

describe('a wallet that cannot send', () => {
  it('is refused, for Signa, when the review starts: the wallet is asked nothing, and "Connect a wallet" opens the external wallets', async () => {
    mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: true }
    await render()
    await review(BOB, '1')
    expect(errorText()).toBe(`${EXTERNAL_WALLET_REQUIRED} Connect a wallet`)
    expect(confirm()).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(tx().send).not.toHaveBeenCalled()

    await press(modal(), 'Connect a wallet')
    expect(mocks.requestSignIn).toHaveBeenCalledWith({ walletsOnly: true })
  })

  it('reviews again, as the new account, once an external wallet is connected', async () => {
    mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: true }
    await render()
    await review(BOB, '1')
    expect(errorText()).toContain(EXTERNAL_WALLET_REQUIRED)

    mocks.wallet = { address: CAROL, isConnected: true, isCenterWallet: false }
    await render()
    expect(errorText()).toBeNull()
    expect(field('Recipient')!.value).toBe(BOB)

    await press(modal(), 'Review transfer')
    expect(mocks.read.mock.calls[0][1]).toEqual([{ address: STICKY, abi: erc20Abi, functionName: 'balanceOf', args: [CAROL] }])
    expect(confirm()).not.toBeNull()
  })

  it('drops a review that was made for another account: the plan is never sent for one that did not make it', async () => {
    await render()
    await review(BOB, '1')
    expect(confirm()).not.toBeNull()
    mocks.wallet = { address: CAROL, isConnected: true, isCenterWallet: false }
    await render()
    expect(confirm()).toBeNull()
    expect(buttonIn(modal(), 'Review transfer')).toBeDefined()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it('is refused, in View as, when the review starts', async () => {
    setViewAs(BOB)
    await render()
    await review(CAROL, '1')
    expect(errorText()).toBe(VIEW_AS_WRITE_BLOCKED)
    expect(confirm()).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(tx().send).not.toHaveBeenCalled()
  })
})

describe('closing', () => {
  it('closes the flow from its own close button when nothing is being sent', async () => {
    await render()
    await act(async () => closeButton().click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('cannot be closed while a transfer is being sent', async () => {
    tx().busy = true
    tx().phase = 'pending'
    await render()
    expect(closeButton().disabled).toBe(true)
  })
})
