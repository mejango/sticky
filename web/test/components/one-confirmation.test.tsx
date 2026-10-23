// @vitest-environment jsdom

/**
 * One user action, one confirmation: the bridge transfer and the collector delivery each run through the real
 * reviewed action and core's send (only wagmi, the wallet and the bridge reads are faked). The action's button is the
 * choice, core's one decoded review is the confirmation, and every step of the action then reaches the wallet with no
 * further dialog or click. The launch's one review (deploy, listing signature and payment) is pinned in
 * lib/sticky-launch-adapter.test.ts, which drives the launch through core the same way.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { buildBridgePrepareTx, buildStickyCollectorSendTx } from '@bananapus/nana-sdk-core/v6'
import { registerReviewHandler, type ReviewModel } from '@bananapus/nana-sdk-core/review'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { erc20Abi, toHex, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CollectorSource } from '@/lib/sticky-collector'
import { WalletAuthContext } from '@/providers/WalletAuthContext'
import {
  COLLECTOR_INFO, COLLECTOR_OWNER as OWNER, COLLECTOR_RECEIVER as RECEIVER, COLLECTOR_ROUTE as ROUTE, COLLECTOR_SOURCE as SOURCE,
} from '../collector-fixtures'

type Sent = { to: Address; data: Hex; value?: bigint }
const mocks = vi.hoisted(() => ({
  review: vi.fn(),
  sendTransaction: vi.fn(),
  transactions: {} as Record<string, Record<string, unknown>>,
  receipts: {} as Record<string, Record<string, unknown>>,
  bridge: { discover: vi.fn(), prepare: vi.fn(), movements: vi.fn(), verifyWrite: vi.fn(), verifySource: vi.fn() },
  delivery: { read: vi.fn(), prepare: vi.fn(), reverify: vi.fn() },
}))
const head = () => 100n + BigInt(Object.keys(mocks.transactions).length)
const block = (number: bigint) => ({ hash: toHex(number, { size: 32 }), number, timestamp: 1_790_000_000n + number })
const chain = {
  chain: { id: 1 },
  getChainId: async () => 1,
  getBlockNumber: async () => head(),
  getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => block(blockNumber ?? head()),
  getTransactionCount: async () => 3,
  estimateGas: async () => 50_000n,
  getGasPrice: async () => 1n,
  getTransaction: async ({ hash }: { hash: string }) => {
    const found = mocks.transactions[hash.toLowerCase()]
    if (!found) throw new Error('Transaction not found')
    return found
  },
  getTransactionReceipt: async ({ hash }: { hash: string }) => {
    const found = mocks.receipts[hash.toLowerCase()]
    if (!found) throw new Error('Receipt not found')
    return found
  },
  waitForTransactionReceipt: async ({ hash }: { hash: string }) => mocks.receipts[hash.toLowerCase()],
  // Every simulation (eth_call) succeeds.
  request: async ({ method }: { method: string }) => {
    if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
    return '0x'
  },
}
vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: OWNER, chainId: 1 }),
  getPublicClient: () => chain,
  switchChain: vi.fn(),
  getWalletClient: async () => ({ chain: { id: 1 }, sendTransaction: mocks.sendTransaction }),
}))
vi.mock('wagmi', () => ({ usePublicClient: () => chain }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => ({ address: OWNER, isConnected: true, isCenterWallet: false, openSignIn: vi.fn() }) }))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
  findPendingSafeAppProposal: async () => null,
}))
vi.mock('@/lib/sticky-bridge', async original => ({ ...(await original<typeof import('@/lib/sticky-bridge')>()), createStickyBridge: () => mocks.bridge }))
vi.mock('@/lib/sticky-collector-delivery', async original => ({ ...(await original<typeof import('@/lib/sticky-collector-delivery')>()), createStickyCollectorDelivery: () => mocks.delivery }))
vi.mock('@/lib/sticky-receivers', () => ({ readReceiver: async () => ({ address: RECEIVER }) }))
vi.mock('@/lib/sticky-refresh', () => ({ refreshAfterFund: vi.fn(), refreshAfterConfirmedWrite: vi.fn() }))
vi.mock('@/lib/jbcenter-public-client', async original => ({ ...(await original<typeof import('@/lib/jbcenter-public-client')>()), jbCenterPublicClient: vi.fn() }))
vi.mock('@/components/project/flows/ReceiverFlow', () => ({ ReceiverFlow: () => <span>Settle received rewards</span> }))
import { BridgeFlow } from '@/components/project/flows/BridgeFlow'
import { CollectorFlow } from '@/components/project/flows/CollectorFlow'

const UNIT = 10n ** 18n
let hashes = 0
/** The wallet: each write is mined at once, at the next block. */
async function walletSends(tx: Sent) {
  const hash = toHex(hashes += 1, { size: 32 })
  const number = head()
  const placed = { blockNumber: number, blockHash: block(number).hash, transactionIndex: 0 }
  mocks.transactions[hash] = { hash, chainId: 1, from: OWNER, to: tx.to, input: tx.data, value: tx.value ?? 0n, nonce: 3, type: 'eip1559', ...placed }
  mocks.receipts[hash] = {
    transactionHash: hash, status: 'success', from: OWNER, to: tx.to, logs: [], contractAddress: null, logsBloom: `0x${'0'.repeat(512)}`,
    cumulativeGasUsed: 50_000n, gasUsed: 50_000n, effectiveGasPrice: 1n, type: 'eip1559', ...placed,
  }
  return hash
}

let root: Root, host: HTMLDivElement, client: QueryClient, unregister = () => {}
beforeEach(() => {
  mocks.transactions = {}
  mocks.receipts = {}
  mocks.review.mockReset().mockResolvedValue(true)
  unregister = registerReviewHandler(async prompt => ((await mocks.review(prompt.model)) ? prompt.confirmation : null))
  mocks.sendTransaction.mockReset().mockImplementation(walletSends)
  mocks.bridge.discover.mockReset().mockResolvedValue([ROUTE])
  mocks.bridge.prepare.mockReset().mockImplementation(async ({ metadata }: { metadata: Hex }) => ({ minimum: 965n, net: 975n, steps: [
    { chainId: 1, address: ROUTE.sourceToken, abi: erc20Abi, functionName: 'approve', args: [ROUTE.sourceSucker, UNIT], label: 'Approve bridge transfer' },
    { ...buildBridgePrepareTx({ chainId: 1, sucker: ROUTE.sourceSucker, projectTokenCount: UNIT, beneficiary: RECEIVER, minTokensReclaimed: 965n, token: ROUTE.backingToken, metadata }), label: 'Queue cross-chain rewards' },
  ] }))
  mocks.bridge.movements.mockReset().mockResolvedValue([])
  mocks.bridge.verifyWrite.mockReset().mockImplementation(async () => ({ success: true, receipt: { blockNumber: head() - 1n } }))
  mocks.bridge.verifySource.mockReset().mockResolvedValue({})
  mocks.delivery.read.mockReset().mockResolvedValue({ pending: 10n * UNIT, meta: ROUTE.sourceMeta })
  mocks.delivery.prepare.mockReset().mockImplementation(async (source: CollectorSource, _owner: Address, amount: bigint) => ({
    source, amount, pending: 10n * UNIT, meta: ROUTE.sourceMeta, verified: source.verified,
    request: { ...buildStickyCollectorSendTx({ ...source.allocation, amount, sucker: ROUTE.sourceSucker, backingToken: ROUTE.backingToken, value: 77n }), label: 'Deliver queued rewards' },
  }))
  mocks.delivery.reverify.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: object) => unknown) => work({}) } })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
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

const page = (children: React.ReactNode) => act(async () => root.render(
  <QueryClientProvider client={client}><WalletAuthContext.Provider value={{ requestSignIn: vi.fn() }}>{children}</WalletAuthContext.Provider></QueryClientProvider>,
))
/** Every press the person makes. */
let presses = 0
async function press(name: string) {
  const found = [...document.querySelectorAll('button')].find(node => node.textContent === name)
  expect(found, name).toBeTruthy()
  presses += 1
  await act(async () => found!.click())
}
async function type(label: string, value: string) {
  const node = [...document.querySelectorAll('label')].find(each => each.textContent === label)!
  const input = document.getElementById(node.htmlFor) as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const reviewed = () => mocks.review.mock.calls.map(([model]) => (model as ReviewModel).calls.map(call => call.functionName))
const exact = ({ to, data, value }: Sent) => ({ to: to.toLowerCase(), data, value: value ?? 0n })
/** What the wallet was asked to send, in order, and what the one review showed. */
const sent = () => mocks.sendTransaction.mock.calls.map(([tx]) => exact(tx as Sent))
const shown = () => (mocks.review.mock.calls[0][0] as ReviewModel).calls.map(call => exact(call as Sent))

it('wallet-action:queue-cross-chain-rewards one press and one review send the approval and the queue step', async () => {
  presses = 0
  await page(<BridgeFlow info={COLLECTOR_INFO} sourceChainId={1} onClose={vi.fn()} onFunded={vi.fn()} />)
  await type('Origin project token', ROUTE.sourceToken)
  await press('Find bridge')
  await type('Amount', '1')
  await press('Review transfer')
  await vi.waitFor(() => expect(mocks.sendTransaction).toHaveBeenCalledTimes(2), { timeout: 3_000 })
  // The form's two presses (find, then the transfer) and core's one review: no second dialog between the steps.
  expect(presses).toBe(2)
  expect(reviewed()).toEqual([['approve', 'prepare']])
  expect(sent().map(call => call.to)).toEqual([ROUTE.sourceToken.toLowerCase(), ROUTE.sourceSucker.toLowerCase()])
  expect(sent()).toEqual(shown())
})

it('wallet-action:deliver-queued-rewards one press and one review send the delivery', async () => {
  presses = 0
  await page(<CollectorFlow source={SOURCE} info={COLLECTOR_INFO} onSettled={vi.fn()} />)
  await type('Amount to deliver', '1')
  await press('Review delivery')
  await vi.waitFor(() => expect(mocks.sendTransaction).toHaveBeenCalledOnce(), { timeout: 3_000 })
  expect(presses).toBe(1)
  expect(reviewed()).toEqual([['send']])
  expect(sent()).toEqual([expect.objectContaining({ to: SOURCE.allocation.deployment.address.toLowerCase(), value: 77n })])
  expect(sent()).toEqual(shown())
})
