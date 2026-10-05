// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, notifyManager, type QueryKey } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { encodeFunctionData, getAddress, zeroAddress, type Abi, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyHookAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED, WalletAuthContext } from '@/providers/WalletAuthContext'
import { stickyInfo } from '../home-fixtures'
import fixtures from '../lib/calldata-fixtures.json'

// The Trust flow, for trusting a sender and for untrusting one: who is asked, what it reads before it asks the wallet,
// what it sends and what it refreshes afterwards. The engine has tests of its own (test/transactions): its hook is a
// mock here, its dialogs are real. The clock is fake, so the refreshes that follow a send happen only when a test
// moves it.

const mocks = vi.hoisted(() => ({
  wallet: { address: undefined as string | undefined, isConnected: false, isCenterWallet: false },
  openSignIn: vi.fn(),
  requestSignIn: vi.fn(),
  tx: {} as Record<string, unknown>,
  read: vi.fn(),
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
vi.mock('@/lib/ens', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/ens')>()),
  lookupEnsName: mocks.ens,
}))

import { TrustFlow } from '@/components/project/flows/TrustFlow'

const CHAIN = 84532
const PROJECT = 12
const HOOK = stickyDeployment(CHAIN)!.hook
const ALICE = getAddress(`0x${'a1'.repeat(20)}`)
const SENDER = getAddress(`0x${'b2'.repeat(20)}`)
const CAROL = getAddress(`0x${'c4'.repeat(20)}`)
const HASH = `0x${'c3'.repeat(32)}`
/** Project 12 on Base Sepolia, whose Sticky token is STICKYART. */
const INFO = stickyInfo(CHAIN, BigInt(PROJECT), { symbol: 'ART', stSymbol: 'STICKYART' })

const idle = () => ({
  phase: 'idle',
  busy: false,
  hash: null as string | null,
  error: null as string | null,
  receipt: null,
  isSafe: false,
  safeProposalHash: null,
  safeNonceGuidance: null,
  confirmationUncertain: false,
  send: vi.fn().mockResolvedValue(null),
  reset: vi.fn(),
})
const tx = () => mocks.tx as ReturnType<typeof idle>

/** What a read of the hook's record of a trusted sender answers. */
const trusted = (value: boolean) => [{ status: 'success', result: value }]
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
  mocks.read.mockReset().mockResolvedValue(trusted(false))
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

/** `sender` is the one to untrust; without it the flow trusts the one the holder names. `unread` renders it before the
 * page has read the project. */
async function render(sender: Address | null = null, chainId = CHAIN, { unread = false } = {}) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WalletAuthContext.Provider value={{ requestSignIn: mocks.requestSignIn }}>
          <TrustFlow chainId={chainId} projectId={PROJECT} info={unread ? undefined : INFO} sender={sender} onClose={onClose} />
        </WalletAuthContext.Provider>
      </QueryClientProvider>,
    ),
  )
  await settle()
}

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
/** The confirmation's rows, by label. */
const rowsOf = () =>
  Object.fromEntries(
    [...confirm()!.querySelectorAll('.grid > span')].reduce<string[][]>((pairs, cell, at) => {
      if (at % 2 === 0) pairs.push([cell.textContent ?? ''])
      else pairs[pairs.length - 1].push(cell.textContent ?? '')
      return pairs
    }, []),
  )

/** Names the sender and asks for the review. */
async function reviewTrust(sender: string) {
  await type('Sender address', sender)
  await press(modal(), 'Review trust')
}
const hookRead = (holder: Address, sender: Address) => [
  CHAIN,
  [{ address: HOOK, abi: stickyHookAbi, functionName: 'isTrustedSenderOf', args: [BigInt(PROJECT), holder, sender] }],
  undefined,
]

describe('trusting a sender: the form', () => {
  it('asks for an address, in one short line of what it does', async () => {
    await render()
    expect(modal().querySelector('h2')?.textContent).toBe('Trust a sender')
    expect(modal().textContent).toContain('This address will be able to stick tokens for you.')
    expect(field('Sender address')).not.toBeNull()
    expect(buttonIn(modal(), 'Review trust')).toBeDefined()
  })

  it('shows the name a production chain gives the address, and asks for none on a testnet', async () => {
    mocks.ens.mockResolvedValue('sender.eth')
    await render(null, 8453)
    await type('Sender address', SENDER)
    await settle()
    expect(mocks.ens).toHaveBeenCalledWith(SENDER, 8453)
    expect(modal().textContent).toContain('sender.eth')

    await act(async () => root.unmount())
    root = createRoot(host)
    client.clear()
    mocks.ens.mockClear()
    await render()
    await type('Sender address', SENDER)
    await settle()
    expect(mocks.ens).not.toHaveBeenCalled()
  })

  it('asks to sign in instead of reviewing when nobody is signed in', async () => {
    mocks.wallet = { address: undefined, isConnected: false, isCenterWallet: false }
    await render()
    expect(buttonIn(modal(), 'Review trust')).toBeUndefined()
    await press(modal(), 'Sign in to trust')
    expect(mocks.openSignIn).toHaveBeenCalledOnce()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(confirm()).toBeNull()
  })

  it.each([
    ['a word', 'sender'],
    ['a short address', SENDER.slice(0, 40)],
    ['an address with one more digit', `${SENDER}0`],
    ['an address with a wrong checksum', miscased(SENDER)],
    ['the zero address', zeroAddress],
    ['nothing', ''],
  ])('refuses %s before it reads or asks anything', async (_name, sender) => {
    await render()
    await reviewTrust(sender)
    expect(errorText()).toBe('Enter a valid sender address.')
    expect(confirm()).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it('takes an address in one case, or with its checksum, and reviews it as the checksummed address', async () => {
    expect(SENDER).not.toBe(SENDER.toLowerCase())
    await render()
    await reviewTrust(SENDER.toLowerCase())
    expect(confirm()!.textContent).toContain(SENDER)
    expect(mocks.read.mock.calls[0].slice(0, 3)).toEqual(hookRead(ALICE, SENDER))
  })
})

describe('trusting a sender: the review', () => {
  it('asks the hook whether the wallet already trusts the sender, then lists the one transaction', async () => {
    const reading = Promise.withResolvers<ReturnType<typeof trusted>>()
    mocks.read.mockReturnValue(reading.promise)
    await render()
    await reviewTrust(SENDER)
    expect(confirm()!.textContent).toContain('Checking whether this sender is trusted…')
    expect(mocks.read.mock.calls[0].slice(0, 3)).toEqual(hookRead(ALICE, SENDER))

    await act(async () => reading.resolve(trusted(false)))
    await settle()
    const text = confirm()!.textContent!
    expect(text).toContain('Trust this sender')
    expect(text).toContain(SENDER)
    expect(text).toContain('Yes, they can add stakes to your position.')
    expect(text).toContain('Base Sepolia')
    expect(text).toContain('1 transaction left.')
    expect(buttonIn(confirm(), 'Confirm & trust')).toBeDefined()
    expect(modal().contains(confirm())).toBe(true)
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
  })

  it('names the project the trust is for, as the old client did, and its ID alone while the project is unread', async () => {
    await render()
    await reviewTrust(SENDER)
    expect(rowsOf()).toEqual({
      Project: 'STICKYART #12',
      Sender: SENDER,
      Trusted: 'Yes, they can add stakes to your position.',
      On: 'Base Sepolia',
    })

    await act(async () => root.unmount())
    root = createRoot(host)
    mocks.read.mockResolvedValue(trusted(true))
    await render(SENDER, CHAIN, { unread: true })
    await press(modal(), 'Review untrust')
    expect(rowsOf()).toMatchObject({ Project: '#12', Sender: SENDER })
  })

  it('says the sender is trusted already, and sends nothing', async () => {
    mocks.read.mockResolvedValue(trusted(true))
    await render()
    await reviewTrust(SENDER)
    expect(errorText()).toBe('This sender is already trusted.')
    expect(confirm()).toBeNull()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it('fails closed when the hook cannot be read: the holder is told, the console too, and nothing goes on', async () => {
    const failure = new Error('429')
    mocks.read.mockRejectedValue(failure)
    await render()
    await reviewTrust(SENDER)
    expect(errorText()).toBe('Could not read whether this sender is trusted. Try again.')
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('trusted'), { chainId: CHAIN, projectId: PROJECT }, failure)
    expect(confirm()).toBeNull()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it('takes an answer of a revert as no answer, never as "not trusted"', async () => {
    mocks.read.mockResolvedValue([{ status: 'failure', error: new Error('reverted') }])
    await render()
    await reviewTrust(SENDER)
    expect(errorText()).toBe('Could not read whether this sender is trusted. Try again.')
    expect(confirm()).toBeNull()
  })

  it('brings the form back, as it was, when the confirm is cancelled, and not at all when it was cancelled before the read', async () => {
    const reading = Promise.withResolvers<ReturnType<typeof trusted>>()
    mocks.read.mockReturnValue(reading.promise)
    await render()
    await reviewTrust(SENDER)
    await press(confirm(), 'Cancel')
    await act(async () => reading.resolve(trusted(false)))
    await settle()
    expect(confirm()).toBeNull()
    expect(field('Sender address')!.value).toBe(SENDER)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('trusting a sender: the send', () => {
  it('wallet-action:trust-or-untrust-a-sender sends setTrustedSenderFor(project, sender, true) to the project\'s hook, exactly as reviewed', async () => {
    await render()
    await reviewTrust(SENDER)
    await press(confirm(), 'Confirm & trust')

    expect(tx().send).toHaveBeenCalledOnce()
    const [request] = tx().send.mock.calls[0] as [{ chainId: number; address: Address; abi: Abi; functionName: string; args: unknown[] }]
    expect(request).toMatchObject({ chainId: CHAIN, address: HOOK, functionName: 'setTrustedSenderFor', args: [12n, SENDER, true] })
    expect(Object.isFrozen(request)).toBe(true)
    expect(Object.isFrozen(request.args)).toBe(true)
  })

  it('names the account that reviewed the change, which the engine sends it from and no other', async () => {
    await render()
    await reviewTrust(SENDER)
    await press(confirm(), 'Confirm & trust')
    const [, options] = tx().send.mock.calls[0] as [unknown, { reviewedAccount: Address }]
    expect(options.reviewedAccount).toBe(ALICE)
  })

  it('sends what cast encoded for the same values, byte for byte', async () => {
    const sender = getAddress(`0x${'3'.repeat(40)}`)
    await render()
    await reviewTrust(sender)
    await press(confirm(), 'Confirm & trust')
    const [request] = tx().send.mock.calls[0] as [{ abi: Abi; functionName: string; args: unknown[] }]
    expect(encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args })).toBe(fixtures.setTrustedSenderFor)
  })

  it('reads the hook again just before it asks the wallet, and stops if the sender has become trusted', async () => {
    await render()
    await reviewTrust(SENDER)
    await press(confirm(), 'Confirm & trust')
    const [request, options] = tx().send.mock.calls[0] as [unknown, { reverify: (request: unknown) => Promise<unknown> }]

    mocks.read.mockClear().mockResolvedValue(trusted(false))
    await expect(options.reverify(request)).resolves.toBeUndefined()
    expect(mocks.read.mock.calls[0].slice(0, 3)).toEqual(hookRead(ALICE, SENDER))

    mocks.read.mockResolvedValue(trusted(true))
    await expect(options.reverify(request)).rejects.toThrow('This sender is already trusted.')

    mocks.read.mockRejectedValue(new Error('429'))
    await expect(options.reverify(request)).rejects.toThrow('Could not read whether this sender is trusted. Try again.')
  })

  it('shows its one step as the one to confirm before it is sent, and as done once it is', async () => {
    await render()
    await reviewTrust(SENDER)
    expect(stepStates()).toEqual(['active'])
    tx().phase = 'success'
    tx().hash = HASH
    await render()
    expect(stepStates()).toEqual(['complete'])
  })

  it('says what the engine is doing while it sends, from its check to the wallet to the chain, and is busy meanwhile', async () => {
    await render()
    await reviewTrust(SENDER)
    expect(statusLine()).toBeNull()
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
      expect(primary().disabled).toBe(true)
      expect(buttonIn(confirm(), 'Cancel')!.disabled).toBe(true)
      expect(stepStates()).toEqual(['active'])
    }
  })

  it('is busy while the engine is, and shows its error with a way to try again', async () => {
    await render()
    await reviewTrust(SENDER)
    tx().busy = true
    tx().phase = 'signing'
    await render()
    expect(primary().disabled).toBe(true)
    expect(buttonIn(confirm(), 'Cancel')!.disabled).toBe(true)

    tx().busy = false
    tx().phase = 'error'
    tx().error = 'Transaction cancelled.'
    await render()
    expect(confirm()!.textContent).toContain('Transaction cancelled.')
    await press(confirm(), 'Retry')
    expect(tx().send).toHaveBeenCalledOnce()
  })
})

describe('untrusting a sender', () => {
  it('names the sender and asks for nothing to be typed', async () => {
    await render(SENDER)
    expect(modal().querySelector('h2')?.textContent).toBe('Untrust sender')
    expect(modal().textContent).toContain(SENDER)
    expect(modal().textContent).toContain('This address will no longer be able to stick tokens for you.')
    expect(modal().querySelector('input')).toBeNull()
    expect(buttonIn(modal(), 'Review untrust')).toBeDefined()
  })

  it('wallet-action:trust-or-untrust-a-sender sends setTrustedSenderFor(project, sender, false) after asking the hook that the sender is trusted', async () => {
    mocks.read.mockResolvedValue(trusted(true))
    await render(SENDER)
    await press(modal(), 'Review untrust')
    expect(mocks.read.mock.calls[0].slice(0, 3)).toEqual(hookRead(ALICE, SENDER))
    const text = confirm()!.textContent!
    expect(text).toContain('Untrust this sender')
    expect(text).toContain('No, they can no longer add stakes to your position.')

    await press(confirm(), 'Confirm & untrust')
    expect(tx().send).toHaveBeenCalledOnce()
    const [request, options] = tx().send.mock.calls[0] as [
      { chainId: number; address: Address; functionName: string; args: unknown[] },
      { reviewedAccount: Address },
    ]
    expect(request).toMatchObject({ chainId: CHAIN, address: HOOK, functionName: 'setTrustedSenderFor', args: [12n, SENDER, false] })
    expect(Object.isFrozen(request)).toBe(true)
    expect(options.reviewedAccount).toBe(ALICE)
  })

  it('says the sender is not trusted when the hook says so, and sends nothing', async () => {
    mocks.read.mockResolvedValue(trusted(false))
    await render(SENDER)
    await press(modal(), 'Review untrust')
    expect(errorText()).toBe('This sender is not trusted.')
    expect(confirm()).toBeNull()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it('refuses the zero address here too, before it reads or asks anything', async () => {
    await render(zeroAddress)
    await press(modal(), 'Review untrust')
    expect(errorText()).toBe('Enter a valid sender address.')
    expect(confirm()).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it('reviews the sender as the checksummed address, whatever case the list holds it in', async () => {
    mocks.read.mockResolvedValue(trusted(true))
    await render(SENDER.toLowerCase() as Address)
    expect(modal().textContent).toContain(SENDER)
    await press(modal(), 'Review untrust')
    expect(confirm()!.textContent).toContain(SENDER)
    expect(mocks.read.mock.calls[0].slice(0, 3)).toEqual(hookRead(ALICE, SENDER))
  })

  it('reads again, just before it asks the wallet, and stops if the sender is no longer trusted', async () => {
    mocks.read.mockResolvedValue(trusted(true))
    await render(SENDER)
    await press(modal(), 'Review untrust')
    await press(confirm(), 'Confirm & untrust')
    const [request, options] = tx().send.mock.calls[0] as [unknown, { reverify: (request: unknown) => Promise<unknown> }]
    await expect(options.reverify(request)).resolves.toBeUndefined()
    mocks.read.mockResolvedValue(trusted(false))
    await expect(options.reverify(request)).rejects.toThrow('This sender is not trusted.')
  })
})

describe('once it is confirmed', () => {
  async function confirmed(sender: Address | null = null) {
    mocks.read.mockResolvedValue(trusted(sender !== null))
    await render(sender)
    if (sender) await press(modal(), 'Review untrust')
    else await reviewTrust(SENDER)
    tx().phase = 'success'
    tx().hash = HASH
    await render(sender)
  }

  it.each([
    ['trust', null, 'Sender trusted'],
    ['untrust', SENDER, 'Sender untrusted'],
  ])('says so, links the transaction and stays open until Done, which closes the flow: %s', async (_name, sender, title) => {
    await confirmed(sender)
    const dialog = confirm()!
    expect(dialog.textContent).toContain(title)
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

  it('reads again who is trusted, now and as the index catches up, and nothing else of the project', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const keys = (): QueryKey[] => invalidate.mock.calls.map(([filters]) => filters!.queryKey!)
    const changed = [
      ['sticky-project', CHAIN, PROJECT, 'events'],
      ['sticky-trusted', CHAIN, PROJECT],
      ['sticky-autostick', CHAIN, PROJECT],
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
  })

  it('refreshes once for one send, however often the flow renders', async () => {
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await confirmed()
    await render()
    await render()
    expect(invalidate).toHaveBeenCalledTimes(3)
  })
})

describe('a wallet that cannot send', () => {
  it('is refused, for Signa, when the review starts: the wallet is asked nothing, and "Connect a wallet" opens the external wallets', async () => {
    mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: true }
    await render()
    await reviewTrust(SENDER)
    expect(errorText()).toBe(`${EXTERNAL_WALLET_REQUIRED} Connect a wallet`)
    expect(confirm()).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(tx().send).not.toHaveBeenCalled()

    await press(modal(), 'Connect a wallet')
    expect(mocks.requestSignIn).toHaveBeenCalledWith({ walletsOnly: true })
  })

  it('reviews again, as the new account, once an external wallet is connected', async () => {
    mocks.wallet = { address: ALICE, isConnected: true, isCenterWallet: true }
    await render(SENDER)
    await press(modal(), 'Review untrust')
    expect(errorText()).toContain(EXTERNAL_WALLET_REQUIRED)

    mocks.read.mockResolvedValue(trusted(true))
    mocks.wallet = { address: CAROL, isConnected: true, isCenterWallet: false }
    await render(SENDER)
    expect(errorText()).toBeNull()

    await press(modal(), 'Review untrust')
    expect(mocks.read.mock.calls[0].slice(0, 3)).toEqual(hookRead(CAROL, SENDER))
    expect(confirm()).not.toBeNull()
  })

  it('drops a review that was made for another account', async () => {
    mocks.read.mockResolvedValue(trusted(true))
    await render(SENDER)
    await press(modal(), 'Review untrust')
    expect(confirm()).not.toBeNull()
    mocks.wallet = { address: CAROL, isConnected: true, isCenterWallet: false }
    await render(SENDER)
    expect(confirm()).toBeNull()
    expect(buttonIn(modal(), 'Review untrust')).toBeDefined()
    expect(tx().send).not.toHaveBeenCalled()
  })

  it('is refused, in View as, when the review starts', async () => {
    setViewAs(CAROL)
    await render()
    await reviewTrust(SENDER)
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

  it('cannot be closed while a transaction is being sent', async () => {
    tx().busy = true
    tx().phase = 'pending'
    await render()
    expect(closeButton().disabled).toBe(true)
  })
})
