// @vitest-environment jsdom

/**
 * The Transfer and Trust flows on the real engine: their confirm, `useSafeTx` and the review, simulation and wallet
 * write behind it, with only the wallet, the chain and the review dialog faked. What reaches the simulation and the
 * wallet is what the confirm showed, and the flow's second read of the chain comes before either.
 */

import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyHookAbi, stickyTokenAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import type { StickyPosition } from '@/lib/sticky-holders'
import { clearViewAs } from '@/lib/viewAs'
import { E18, stickyInfo } from '../home-fixtures'

const mocks = vi.hoisted(() => ({
  publicClient: { simulateContract: vi.fn(), estimateContractGas: vi.fn() },
  receipt: { data: undefined, isError: false } as {
    data?: { status: 'success' | 'reverted'; transactionHash: string }
    isError: boolean
  },
  getAccount: vi.fn(),
  requestReview: vi.fn(),
  switchChain: vi.fn(),
  writeContract: vi.fn(),
  read: vi.fn(),
  position: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: mocks.getAccount }))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: mocks.switchChain }),
  useWaitForTransactionReceipt: () => mocks.receipt,
  useWriteContract: () => ({ writeContractAsync: mocks.writeContract }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: ALICE, isCenterWallet: false, openSignIn: vi.fn() }),
}))
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

beforeEach(() => {
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.receipt = { data: undefined, isError: false }
  mocks.getAccount.mockReset().mockImplementation(() => ({ address: ALICE, chainId: CHAIN }))
  mocks.requestReview.mockReset().mockResolvedValue(true)
  mocks.switchChain.mockReset().mockResolvedValue(undefined)
  mocks.publicClient.simulateContract.mockReset().mockImplementation(async (request: object) => ({ request }))
  mocks.publicClient.estimateContractGas.mockReset().mockResolvedValue(50_000n)
  mocks.writeContract.mockReset().mockResolvedValue(HASH)
  mocks.read.mockReset().mockResolvedValue(answer(2n * E18))
  mocks.position.mockReset().mockResolvedValue(position)
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
/** The confirm's main button, and the line under its step that says what the engine is doing. */
const primary = () => confirm().querySelector<HTMLButtonElement>('footer button.btn-primary')!
const statusLine = () => confirm().querySelector('p.text-bluebs-700')?.textContent ?? null

describe('a transfer', () => {
  async function reviewed(amount = '1.5') {
    await render(transfer())
    await type('Recipient', BOB)
    await type('Amount', amount)
    await press(modal(), 'Review transfer')
  }

  it('reaches the review, the simulation and the wallet as the exact transfer the confirm showed', async () => {
    await reviewed('1.000000000000000001')
    expect(confirm().textContent).toContain('1.000000000000000001 STICKYART')
    expect(mocks.requestReview).not.toHaveBeenCalled()

    await press(confirm(), 'Confirm & transfer')

    const amount = 1_000_000_000_000_000_001n
    expect(mocks.requestReview).toHaveBeenCalledOnce()
    expect(mocks.requestReview.mock.calls[0][0]).toMatchObject({
      chainId: CHAIN,
      address: STICKY,
      functionName: 'transfer',
      args: [BOB, amount],
      account: ALICE,
    })
    expect(mocks.publicClient.simulateContract).toHaveBeenCalledOnce()
    expect(mocks.publicClient.simulateContract.mock.calls[0][0]).toMatchObject({
      address: STICKY,
      abi: stickyTokenAbi,
      functionName: 'transfer',
      args: [BOB, amount],
      account: ALICE,
    })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(mocks.writeContract.mock.calls[0][0]).toMatchObject({ address: STICKY, functionName: 'transfer', args: [BOB, amount] })
    // The balance was read for the review, and again after it and before the simulation.
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(confirm().textContent).toContain('Waiting for confirmation…')

    mocks.receipt = { data: { status: 'success', transactionHash: HASH }, isError: false }
    await render(transfer())
    expect(confirm().textContent).toContain('Sticky tokens transferred')
    expect(confirm().querySelector('a')!.getAttribute('href')).toBe(`https://sepolia.basescan.org/tx/${HASH}`)
  })

  it("says so while the wallet's prompt is open, on the button and under the step, then waits for the chain", async () => {
    const prompt = Promise.withResolvers<string>()
    mocks.writeContract.mockReturnValue(prompt.promise)
    await reviewed('1')
    await press(confirm(), 'Confirm & transfer')

    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(statusLine()).toBe('Confirm in your wallet…')
    expect(primary().textContent).toBe('Confirm in your wallet…')
    expect(primary().disabled).toBe(true)

    await act(async () => prompt.resolve(HASH))
    await settle()
    expect(statusLine()).toBe('Waiting for confirmation…')
    expect(primary().textContent).toBe('Confirming…')
  })

  it('stops before the simulation and the wallet when the balance has fallen since the review', async () => {
    await reviewed('1.5')
    mocks.read.mockResolvedValue(answer(E18))
    await press(confirm(), 'Confirm & transfer')

    expect(mocks.requestReview).toHaveBeenCalledOnce()
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(confirm().textContent).toContain('Your token balance changed. Review the amount.')
    expect([...confirm().querySelectorAll('footer button')].map(each => each.textContent)).toEqual(['Cancel', 'Retry'])
  })

  it('stops at the simulation when the chain refuses the transfer, and the wallet is never asked', async () => {
    await reviewed('1')
    mocks.publicClient.simulateContract.mockRejectedValue(new Error('execution reverted'))
    await press(confirm(), 'Confirm & transfer')
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(confirm().textContent).toContain('execution reverted')
  })
})

describe('a change of trust', () => {
  const trust = (sender: Address | null) => (
    <TrustFlow chainId={CHAIN} projectId={12} info={info} sender={sender} onClose={() => {}} />
  )

  it('reaches the wallet as setTrustedSenderFor(project, sender, true), after the hook was read again', async () => {
    mocks.read.mockResolvedValue(answer(false))
    await render(trust(null))
    await type('Sender address', BOB)
    await press(modal(), 'Review trust')
    await press(confirm(), 'Confirm & trust')

    expect(mocks.requestReview.mock.calls[0][0]).toMatchObject({
      chainId: CHAIN,
      address: HOOK,
      functionName: 'setTrustedSenderFor',
      args: [12n, BOB, true],
      account: ALICE,
    })
    expect(mocks.publicClient.simulateContract.mock.calls[0][0]).toMatchObject({
      address: HOOK,
      abi: stickyHookAbi,
      functionName: 'setTrustedSenderFor',
      args: [12n, BOB, true],
      account: ALICE,
    })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it("says so while the wallet's prompt is open, on the button and under the step", async () => {
    const prompt = Promise.withResolvers<string>()
    mocks.writeContract.mockReturnValue(prompt.promise)
    mocks.read.mockResolvedValue(answer(false))
    await render(trust(null))
    await type('Sender address', BOB)
    await press(modal(), 'Review trust')
    await press(confirm(), 'Confirm & trust')

    expect(statusLine()).toBe('Confirm in your wallet…')
    expect(primary().textContent).toBe('Confirm in your wallet…')
    await act(async () => prompt.resolve(HASH))
    await settle()
    expect(statusLine()).toBe('Waiting for confirmation…')
  })

  it('reaches the wallet as setTrustedSenderFor(project, sender, false) for an untrust', async () => {
    mocks.read.mockResolvedValue(answer(true))
    await render(trust(BOB))
    await press(modal(), 'Review untrust')
    await press(confirm(), 'Confirm & untrust')
    expect(mocks.writeContract.mock.calls[0][0]).toMatchObject({ address: HOOK, functionName: 'setTrustedSenderFor', args: [12n, BOB, false] })
  })

  it('stops before the wallet when someone else has already changed the trust', async () => {
    mocks.read.mockResolvedValue(answer(false))
    await render(trust(null))
    await type('Sender address', BOB)
    await press(modal(), 'Review trust')
    mocks.read.mockResolvedValue(answer(true))
    await press(confirm(), 'Confirm & trust')
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(confirm().textContent).toContain('This sender is already trusted.')
  })
})
