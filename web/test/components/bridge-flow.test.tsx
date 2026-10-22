// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { buildBridgeClaimTx, buildBridgePrepareTx, buildToRemoteTx, suckerLeafProof } from '@bananapus/nana-sdk-core/v6'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { erc20Abi, pad, zeroHash, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TxRequest } from '@/hooks/useReviewedAction'
import { bridgeCalldata, type BridgeMovement, type BridgeRoute } from '@/lib/sticky-bridge'
import { bridgeStorageKey, createPendingBridgeWrite, readBridgeRecords, readPendingBridgeWrite, saveBridgeRecords, savePendingBridgeWrite, saveWatchedBridgeRoute, storeBridgeWrite } from '@/lib/sticky-bridge-journal'
import { checkedItLabel, HELD_EXIT_LABEL, SAVED_ATTEMPT_CHECK_LINE, WRITE_HOLD_PENDING_LINE } from '@bananapus/nana-sdk-core/review'
import { holds } from '@/lib/write-holds'
import { TransactionReviewCancelledError } from '@/lib/transaction-review'
import { holdIntent } from '@/lib/sticky-hold-intent'
import { heldChain, heldWrite } from '../support/held-chain'
import { reviewedActionFake, type ReviewedActionFake } from '../support/reviewed-action'
import { WalletAuthContext } from '@/providers/WalletAuthContext'
import { stickyInfo } from '../home-fixtures'

const A = (n: number) => `0x${BigInt(n).toString(16).padStart(40, '0')}` as Address
const H = (n: number) => `0x${BigInt(n).toString(16).padStart(64, '0')}` as Hex
const OWNER = A(40), RECEIVER = A(41), HASH = H(90)
const INFO = stickyInfo(10, 22n)
const ROUTE: BridgeRoute = { source: { chainId: 1 }, destination: { chainId: 10 }, sourceSucker: A(1), destinationSucker: A(2), sourceProjectId: '11', destinationProjectId: '12', sourceToken: A(3), rewardToken: A(4), backingToken: A(5), remoteBackingToken: A(6), terminal: A(7), sourceMeta: { symbol: 'SRC', decimals: 18 }, rewardMeta: { symbol: 'DST', decimals: 18 }, backingMeta: { symbol: 'ETH', decimals: 18 }, canPrepare: true }
const KEY = bridgeStorageKey(10, INFO.stToken, 0n, OWNER)
const mocks = vi.hoisted(() => ({ wallet: {} as { address: Address; isConnected: boolean; isCenterWallet: boolean; openSignIn: ReturnType<typeof vi.fn> }, tx: {} as ReviewedActionFake, discover: vi.fn(), prepare: vi.fn(), movements: vi.fn(), flush: vi.fn(), claim: vi.fn(), verifyWrite: vi.fn(), verifySource: vi.fn(), receiver: vi.fn(), walletWrite: vi.fn(), refresh: vi.fn(), settle: vi.fn() }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@wagmi/core', async original => ({ ...(await original<typeof import('@wagmi/core')>()), getPublicClient: (_config: unknown, { chainId }: { chainId: number }) => (chainId === 1 ? chain : destination).client }))
vi.mock('@/hooks/useReviewedAction', async original => ({ ...(await original<typeof import('@/hooks/useReviewedAction')>()), useReviewedAction: () => mocks.tx }))
vi.mock('@/lib/sticky-bridge', async original => ({ ...(await original<typeof import('@/lib/sticky-bridge')>()), createStickyBridge: () => mocks }))
vi.mock('@/lib/jbcenter-public-client', async original => ({ ...(await original<typeof import('@/lib/jbcenter-public-client')>()), jbCenterPublicClient: vi.fn() }))
vi.mock('@/lib/sticky-receivers', () => ({ readReceiver: mocks.receiver }))
vi.mock('@/lib/sticky-refresh', () => ({ refreshAfterFund: mocks.refresh }))
vi.mock('@/components/project/flows/ReceiverFlow', () => ({ ReceiverFlow: (props: unknown) => { mocks.settle(props); return <span>Settle received rewards</span> } }))
import { BridgeFlow } from '@/components/project/flows/BridgeFlow'

let root: Root, host: HTMLDivElement, client: QueryClient, approved: boolean
let chain = heldChain(1), destination = heldChain(10)
const onClose = vi.fn(), onFunded = vi.fn()
const queuedRequest = (metadata = H(99)) => ({ ...buildBridgePrepareTx({ chainId: 1, sucker: ROUTE.sourceSucker, projectTokenCount: 10n ** 18n, beneficiary: RECEIVER, minTokensReclaimed: 965n, token: ROUTE.backingToken, metadata }), label: 'Queue cross-chain rewards' })
const movement = (status: BridgeMovement['status']): BridgeMovement => ({ leaf: { index: 0n, beneficiary: pad(RECEIVER), projectTokenCount: 10n ** 18n, terminalTokenAmount: 965n, metadata: H(99) }, leafHash: H(98), sourceHash: HASH, blockNumber: 100n, caller: OWNER, status, proof: Array<Hex>(32).fill(zeroHash) } as unknown as BridgeMovement)
/** The receipts the run waits on, in order: `confirmed` gives the next one. */
let receipts: (() => void)[] = []
beforeEach(() => {
  localStorage.clear()
  receipts = []
  chain = heldChain(1)
  destination = heldChain(10)
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: object) => unknown) => work({}) } })
  approved = false
  mocks.wallet = { address: OWNER, isConnected: true, isCenterWallet: false, openSignIn: vi.fn() }
  mocks.tx = reviewedActionFake(HASH, { finish: true })
  // The wallet: what it is asked to send, and the hash it answers; each step's receipt comes when a test confirms it.
  mocks.tx.send.mockImplementation(async call => { await mocks.walletWrite(call); return HASH })
  mocks.tx.mined.mockImplementation(() => new Promise<void>(done => receipts.push(done)))
  mocks.tx.reset.mockImplementation(() => Object.assign(mocks.tx, { phase: 'idle', hash: null, busy: false, error: null }))
  mocks.tx.dismiss.mockImplementation(() => Object.assign(mocks.tx, { phase: 'idle', hash: null, busy: false }))
  mocks.discover.mockReset().mockResolvedValue([ROUTE])
  mocks.receiver.mockReset().mockResolvedValue({ address: RECEIVER })
  mocks.prepare.mockReset().mockImplementation(async ({ metadata }: { metadata: Hex }) => ({ minimum: 965n, net: 975n, steps: [...(!approved ? [{ chainId: 1, address: ROUTE.sourceToken, abi: erc20Abi, functionName: 'approve', args: [ROUTE.sourceSucker, 10n ** 18n], label: 'Approve bridge transfer' }] : []), queuedRequest(metadata)] }))
  mocks.movements.mockReset().mockResolvedValue([])
  mocks.flush.mockReset().mockResolvedValue({ ...buildToRemoteTx({ chainId: 1, sucker: ROUTE.sourceSucker, token: ROUTE.backingToken, value: 100n }), label: 'Send queued rewards across chains' })
  mocks.claim.mockReset().mockImplementation(async () => ({ ...buildBridgeClaimTx({ chainId: 10, sucker: ROUTE.destinationSucker, claim: { token: ROUTE.remoteBackingToken, leaf: movement('claimable').leaf, proof: suckerLeafProof([zeroHash], 0) } }), label: 'Claim arriving rewards' }))
  mocks.verifyWrite.mockReset().mockResolvedValue({ success: true, receipt: { blockNumber: 100n } })
  mocks.verifySource.mockReset().mockResolvedValue({})
  mocks.walletWrite.mockReset().mockResolvedValue(undefined)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(async () => {
  try {
    // Every wallet call is a step of a run its one review confirmed: no send skips it.
    expect(mocks.tx.review).toHaveBeenCalledTimes(mocks.tx.run.mock.calls.length)
  } finally { await act(async () => root.unmount()); host.remove(); client.clear() }
})
async function render(info = INFO, delivery?: { route?: BridgeRoute; groupId: bigint }) {
  await act(async () => root.render(<QueryClientProvider client={client}><WalletAuthContext.Provider value={{ requestSignIn: vi.fn() }}><BridgeFlow info={info} sourceChainId={1} delivery={delivery} onClose={onClose} onFunded={onFunded} /></WalletAuthContext.Provider></QueryClientProvider>))
}
const text = () => document.body.textContent ?? ''
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent === name)!
async function press(name: string) { const found = button(name); expect(found, name).toBeTruthy(); await act(async () => found.click()) }
async function type(label: string, value: string) {
  const node = [...document.querySelectorAll('label')].find(node => node.textContent === label)!
  const input = document.getElementById(node.htmlFor) as HTMLInputElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function find() { await render(); await type('Origin project token', ROUTE.sourceToken); await press('Find bridge') }
/** The transfer form, filled. 'Review transfer' is then its one confirmation. */
async function review() { await find(); await type('Amount', '1') }
/** The step the run waits on confirms: the run goes on to its next step, or ends with every step confirmed. */
async function confirmed() {
  const receipt = receipts.shift()
  if (receipt) await act(async () => { receipt(); await vi.waitFor(() => undefined) })
  else Object.assign(mocks.tx, { phase: 'success', hash: HASH, busy: false })
  await render()
}
const storedPending = () => JSON.parse(localStorage.getItem(`sticky:bridge:pending:v1:${OWNER.toLowerCase()}`)!)
function failReturnedHashSave(failure: 'write' | 'read' = 'write') {
  let replied = false, failures = 0
  const getItem = Storage.prototype.getItem
  const setItem = Storage.prototype.setItem
  const spy = failure === 'read' ? vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
    if (replied && key.startsWith('sticky:bridge:pending:')) { failures++; throw new Error('Hash storage unavailable') }
    return getItem.call(this, key)
  }) : vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith('sticky:bridge:pending:') && JSON.parse(value)?.hash) { failures++; throw new Error('Hash storage unavailable') }
    setItem.call(this, key, value)
  })
  mocks.tx.send.mockImplementation(async call => {
    await mocks.walletWrite(call)
    Object.assign(mocks.tx, { submissionHash: HASH, submissionIsSafe: false })
    replied = true
    return HASH
  })
  return Object.assign(spy, { failures: () => failures })
}

describe('reviewed durable bridge workflow', () => {
  it('stops the transfer at an approval whose returned hash could not be saved, keeping the hash for its recovery', async () => {
    await review()
    const save = failReturnedHashSave()
    await press('Review transfer')
    const original = storedPending()
    expect(original.id).toBeTruthy(); expect(original.hash).toBeUndefined()
    // The wallet's reply is kept in memory, and the engine holds the approval by it: the queue step is not sent.
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    expect(text()).toContain('Hash storage unavailable')
    save.mockRestore()
    expect(mocks.walletWrite).toHaveBeenCalledOnce()
    expect(receipts).toHaveLength(0)
    expect(mocks.tx.review).toHaveBeenCalledOnce()
  })
  it.each([false, true])('never repairs or clears a newer identical approval using an older result (replacement hash %s)', async hasHash => {
    await review()
    const save = failReturnedHashSave()
    await press('Review transfer')
    const original = storedPending()
    save.mockRestore()
    const replacement = { ...original, id: crypto.randomUUID(), ...(hasHash ? { hash: H(91), safeProposal: false } : {}) }
    savePendingBridgeWrite(OWNER, replacement)
    await confirmed()
    expect(readPendingBridgeWrite(OWNER)).toEqual(replacement)
    expect(mocks.verifyWrite).not.toHaveBeenCalled()
    expect(readBridgeRecords(KEY)[0].steps).toHaveLength(2)
    expect(text()).toContain('pending bridge transaction changed')
  })
  it.each(['write', 'read'] as const)('recovers the retained approval after two hash saves fail, the review unmounts and storage returns (%s)', async failure => {
    await review()
    const save = failReturnedHashSave(failure)
    await press('Review transfer')
    approved = true
    await confirmed()
    expect(save.failures()).toBeGreaterThanOrEqual(2)
    expect(mocks.verifyWrite).not.toHaveBeenCalled()

    await act(async () => root.unmount())
    root = createRoot(host)
    Object.assign(mocks.tx, { phase: 'idle', hash: null, submissionHash: null, error: null })
    save.mockRestore()
    expect(storedPending().hash).toBeUndefined()
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    await render()
    expect(text()).not.toContain('The wallet did not return a submission reference')
    await press('Check transaction')
    expect(mocks.verifyWrite).toHaveBeenCalledWith({ chainId: 1 }, OWNER, HASH, expect.anything(), { hash: HASH, safeProposal: false })
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(readBridgeRecords(KEY)[0].steps).toHaveLength(1)
    expect(mocks.walletWrite).toHaveBeenCalledOnce()
  })
  it('rechecks the saved reservation after an asynchronous canonical proof before clearing', async () => {
    const original = { ...createPendingBridgeWrite({ owner: OWNER, request: storeBridgeWrite(queuedRequest()) }), hash: HASH }
    savePendingBridgeWrite(OWNER, original)
    const proof = Promise.withResolvers<{ success: boolean; receipt: { blockNumber: bigint } }>()
    mocks.verifyWrite.mockReturnValueOnce(proof.promise)
    await render(); await press('Check transaction')
    const replacement = { ...original, id: crypto.randomUUID(), hash: H(91) }
    savePendingBridgeWrite(OWNER, replacement)
    await act(async () => proof.resolve({ success: true, receipt: { blockNumber: 100n } }))
    expect(readPendingBridgeWrite(OWNER)).toEqual(replacement)
    expect(text()).toContain('pending bridge transaction changed')
  })
  it('wallet-action:approve-a-bridge-transfer Approve a bridge transfer: reviews the exact spender and saves intent before the wallet call', async () => {
    await review()
    mocks.walletWrite.mockImplementation(async (call: { data: Hex }) => {
      expect(readPendingBridgeWrite(OWNER)?.request.data).toBe(call.data)
      expect(call).toMatchObject({ functionName: 'approve', to: ROUTE.sourceToken, args: [ROUTE.sourceSucker, 10n ** 18n] })
    })
    await press('Review transfer')
    // The one decoded review shows the summary above both steps.
    const [{ calls, context }] = mocks.tx.review.mock.calls[0]
    expect(calls.map(call => call.functionName)).toEqual(['approve', 'prepare'])
    const rows = context!.map(row => `${row.label}${row.value}`)
    expect(rows).toEqual(expect.arrayContaining([`Bridge contract${ROUTE.sourceSucker}`, `Origin token${ROUTE.sourceToken}`, 'Allowance after approval1 SRC']))
    expect(rows.some(row => row.startsWith('Minimum backing'))).toBe(true)
    expect(mocks.walletWrite).toHaveBeenCalledTimes(1)
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    expect(onFunded).not.toHaveBeenCalled()
  })
  it('wallet-action:queue-cross-chain-rewards Queue cross-chain rewards: continues only after approval proof and preserves the reviewed receiver and metadata', async () => {
    await review()
    await press('Review transfer'); const metadata = readBridgeRecords(KEY)[0].metadata
    approved = true; await confirmed()
    // One user action, one decoded review: the queue step follows the approval without asking again.
    await vi.waitFor(() => expect(mocks.walletWrite).toHaveBeenCalledTimes(2))
    expect(mocks.tx.review).toHaveBeenCalledOnce()
    expect(mocks.tx.run).toHaveBeenCalledOnce()
    const [approval, queue] = mocks.tx.send.mock.calls.map(([call]) => call)
    expect(mocks.tx.run.mock.calls[0][0].calls).toEqual([approval, queue])
    // The queue step is simulated where its approval confirmed.
    expect(queue.dependsOnPrior).toBe(true)
    expect(mocks.walletWrite).toHaveBeenLastCalledWith(expect.objectContaining({ functionName: 'prepare', args: [10n ** 18n, pad(RECEIVER), 965n, ROUTE.backingToken, metadata] }))
    const record = readBridgeRecords(KEY)[0]
    mocks.movements.mockResolvedValue([{ ...movement('queued'), leaf: { ...movement('queued').leaf, metadata } }])
    await confirmed()
    expect(readBridgeRecords(KEY)[0]).toMatchObject({ sourceVerified: true, sourceHash: HASH, steps: [] })
    expect(mocks.verifySource).toHaveBeenCalledWith(ROUTE, expect.anything(), OWNER, record.prepareData, { hash: HASH, safeProposal: false })
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(text()).toContain('Ready to send')
  })
  it('wallet-action:send-queued-rewards-across-chains Send queued rewards across chains: reviews and sends the exact transport budget', async () => {
    mocks.movements.mockResolvedValue([movement('queued')]); await find(); await press('Refresh bridge status'); await press('Send across chains'); expect(text()).toContain('Bridge transport budget0.0000000000000001 ETH')
    expect(mocks.walletWrite).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'toRemote', value: 100n, chainId: 1 }))
    expect(mocks.tx.review).toHaveBeenCalledOnce()
    expect(mocks.tx.run).toHaveBeenCalledWith(expect.objectContaining({ calls: [expect.objectContaining({ functionName: 'toRemote' })], context: expect.arrayContaining([{ label: 'Bridge transport budget', value: '0.0000000000000001 ETH' }]) }))
    expect(readPendingBridgeWrite(OWNER)?.request.value).toBe('100')
  })
  it('wallet-action:claim-arriving-rewards Claim arriving rewards: sends the fresh destination proof and hands claimed rewards to the existing settlement flow', async () => {
    mocks.movements.mockResolvedValue([movement('claimable')]); await find(); await press('Refresh bridge status'); await press('Claim arrival')
    expect(mocks.walletWrite).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'claim', chainId: 10, to: ROUTE.destinationSucker }))
    expect(mocks.tx.review).toHaveBeenCalledOnce()
    mocks.movements.mockResolvedValue([movement('claimed')]); await confirmed(); await press('Check unsettled rewards')
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ initialToken: ROUTE.rewardToken, initialGroupId: 0n, initiallyOpen: true, onSettled: onFunded }))
    expect(onFunded).not.toHaveBeenCalled()
  })
  it('closes the transfer and sends nothing when its one review is closed', async () => {
    mocks.tx.review.mockRejectedValueOnce(new TransactionReviewCancelledError())
    await review(); await press('Review transfer')
    expect(mocks.tx.send).not.toHaveBeenCalled()
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(text()).not.toContain('Review again')
    expect(text()).not.toContain('Review closed')
    expect(button('Continue transfer')).toBeDefined()
  })
  it('sends the queue step once its approval recovery lets go of the bridge lock, however long its refresh takes', async () => {
    await review()
    // Exclusive locks by name, as the browser's: a request that must not wait gets none while another holds it.
    const held = new Set<string>(), waiting = new Map<string, (() => void)[]>()
    vi.stubGlobal('navigator', { locks: { request: async (name: string, options: { ifAvailable?: boolean }, work: (lock: object | null) => unknown) => {
      if (held.has(name) && options.ifAvailable) return work(null)
      while (held.has(name)) await new Promise<void>(done => waiting.set(name, [...(waiting.get(name) ?? []), done]))
      held.add(name)
      try { return await work({}) } finally { held.delete(name); waiting.get(name)?.shift()?.() }
    } } })
    await press('Review transfer'); approved = true
    await vi.waitFor(() => expect(mocks.walletWrite).toHaveBeenCalledOnce())
    const slow = Promise.withResolvers<{ address: Address }>()
    mocks.receiver.mockReturnValueOnce(slow.promise)
    await confirmed()
    await act(async () => slow.resolve({ address: RECEIVER }))
    await vi.waitFor(() => expect(mocks.walletWrite).toHaveBeenCalledTimes(2))
    expect(mocks.walletWrite).toHaveBeenLastCalledWith(expect.objectContaining({ functionName: 'prepare' }))
    expect(mocks.tx.review).toHaveBeenCalledOnce()
    expect(text()).not.toContain('already open in another tab')
  })
  it('sends the queue step only once its approval is recovered, and the transfer cannot be closed between them', async () => {
    await review(); await press('Review transfer'); approved = true
    const proof = Promise.withResolvers<{ success: boolean; receipt: { blockNumber: bigint } }>()
    mocks.verifyWrite.mockReturnValueOnce(proof.promise)
    await confirmed()
    expect(button('Cancel').disabled).toBe(true)
    expect(mocks.walletWrite).toHaveBeenCalledOnce()
    await act(async () => proof.resolve({ success: true, receipt: { blockNumber: 100n } }))
    await vi.waitFor(() => expect(mocks.walletWrite).toHaveBeenCalledTimes(2))
    expect(mocks.walletWrite).toHaveBeenLastCalledWith(expect.objectContaining({ functionName: 'prepare' }))
  })
  it('reviews the steps left again, together, when a transfer is resumed', async () => {
    await review(); await press('Review transfer'); approved = true
    // The approval confirmed while this page was away: the queue step is resumed from the saved transfer.
    await act(async () => root.unmount()); root = createRoot(host)
    Object.assign(mocks.tx, { phase: 'idle', hash: null })
    await render(); await press('Check transaction')
    await press('Continue transfer')
    expect(mocks.tx.review).toHaveBeenCalledTimes(2)
    expect(mocks.tx.review.mock.calls[1][0].calls.map(call => call.functionName)).toEqual(['prepare'])
  })
  it('retains a submitted Safe approval without advancing steps or reporting success', async () => {
    await review(); mocks.tx.isSafe = true; await press('Review transfer'); Object.assign(mocks.tx, { phase: 'submitted', notice: 'Awaiting Safe confirmations' }); await render()
    await press('Done')
    expect(readPendingBridgeWrite(OWNER)).toMatchObject({ hash: HASH, safeProposal: true })
    expect(readBridgeRecords(KEY)[0].steps).toHaveLength(2)
    expect(text()).toContain('finish its approvals')
    expect(onFunded).not.toHaveBeenCalled()
  })
  it('keeps an unknown wallet reply locked across dismissal and reload', async () => {
    // The wallet's reply never comes back: the approval may have gone out.
    mocks.tx.send.mockRejectedValueOnce(new Error('The request took too long to respond.'))
    await review(); await press('Review transfer'); await press('Cancel')
    await act(async () => root.unmount()); root = createRoot(host); await render()
    expect(readPendingBridgeWrite(OWNER)?.hash).toBeUndefined()
    expect(button('Review transfer').disabled).toBe(true)
    expect(text()).toContain('may still execute')
  })
  it('brings a hashless reservation the SDK never held to the one explicit check after reload, which clears it, keeps the transfer, and allows exactly one more send', async () => {
    mocks.tx.send.mockRejectedValueOnce(new Error('The request took too long to respond.'))
    await review(); await press('Review transfer'); await press('Cancel')
    const metadata = readBridgeRecords(KEY)[0].metadata
    await act(async () => root.unmount()); root = createRoot(host); await render()
    expect(readPendingBridgeWrite(OWNER)?.hash).toBeUndefined()
    expect(button('Review transfer').disabled).toBe(true)

    // Nothing can send while the reservation stands; the explicit check is the way out.
    await vi.waitFor(() => expect(button(checkedItLabel())).toBeDefined())
    expect(text()).toContain(SAVED_ATTEMPT_CHECK_LINE)
    await press(checkedItLabel())
    await vi.waitFor(() => expect(readPendingBridgeWrite(OWNER)).toBeNull())
    expect(readBridgeRecords(KEY)).toHaveLength(1)
    expect(readBridgeRecords(KEY)[0].metadata).toBe(metadata)

    mocks.tx.send.mockClear()
    await press('Continue transfer')
    expect(mocks.tx.send).toHaveBeenCalledOnce()
  })
  /** The wallet replied with a hash and the review closed without a result: the attempt is saved with its hash. */
  /** The run ends with the step held by its hash: the chain never showed its receipt. */
  const dropped = () => mocks.tx.mined.mockRejectedValueOnce(new Error('The transaction was not found in time.'))
  async function hashedThenDropped() {
    dropped()
    await review(); await press('Review transfer')
    return { released: () => mocks.tx.run.mock.calls[0][0].onReleased!() }
  }
  /** The approval the review sends, and the key its hold has, as the flow computes them. */
  const approvalRequest = () => ({ chainId: 1, address: ROUTE.sourceToken, abi: erc20Abi, functionName: 'approve', args: [ROUTE.sourceSucker, 10n ** 18n], label: 'Approve bridge transfer' }) as TxRequest
  const approvalCall = () => ({ to: ROUTE.sourceToken, data: bridgeCalldata(approvalRequest()) })
  const approvalNamespace = () => holdIntent(approvalRequest(), OWNER)!
  /** Time passes: the SDK's own clock reads it. */
  const later = (ms: number) => { const now = Date.now() + ms; vi.spyOn(Date, 'now').mockReturnValue(now) }
  /** The approval the review sends, as the chain sees it. */
  const sentCall = () => {
    const step = readBridgeRecords(KEY)[0]?.steps[0] ?? storeBridgeWrite(queuedRequest())
    return { to: step.address, data: step.data, value: BigInt(step.value) }
  }
  /** The SDK held the saved write, and settled it on a mined transaction the chain shows for its call. */
  async function settledAs(mined: Hex) {
    const saved = readPendingBridgeWrite(OWNER)!
    const handle = await heldWrite({ chainId: 1, account: OWNER, namespace: saved.intent!, call: sentCall(), client: chain.client, hash: mined })
    chain.mined(mined, sentCall(), OWNER)
    await handle.state(chain.client as never)
  }
  it('clears the reservation of an attempt whose hash was saved when the SDK exit releases it, and allows exactly one more send', async () => {
    const { released } = await hashedThenDropped()
    const metadata = readBridgeRecords(KEY)[0].metadata
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    await act(async () => { await released() })
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(readBridgeRecords(KEY)[0].metadata).toBe(metadata)
    mocks.tx.send.mockClear()
    await press('Cancel'); await press('Continue transfer')
    expect(mocks.tx.send).toHaveBeenCalledOnce()
  })
  it('after a reload, shows the SDK\'s exit for a saved hash the chain has not shown for 30 minutes, and the exit clears it keeping the transfer', async () => {
    await hashedThenDropped(); await press('Cancel')
    const metadata = readBridgeRecords(KEY)[0].metadata
    await act(async () => root.unmount()); root = createRoot(host)
    later(31 * 60_000)
    await render()
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    await vi.waitFor(() => expect(button(HELD_EXIT_LABEL)).toBeDefined())
    await press(HELD_EXIT_LABEL)
    await vi.waitFor(() => expect(readPendingBridgeWrite(OWNER)).toBeNull())
    expect(readBridgeRecords(KEY)[0].metadata).toBe(metadata)
  })
  it('after a reload, shows no exit for a hash the chain still knows', async () => {
    await hashedThenDropped(); await press('Cancel')
    chain.pending(HASH, sentCall(), OWNER)
    await act(async () => root.unmount()); root = createRoot(host)
    later(5 * 60_000)
    await render()
    await vi.waitFor(() => expect(text()).toContain(WRITE_HOLD_PENDING_LINE))
    expect([...document.querySelectorAll('button')].some(node => node.textContent === HELD_EXIT_LABEL)).toBe(false)
    expect(readPendingBridgeWrite(OWNER)).not.toBeNull()
  })
  it('clears an attempt whose returned hash could not be saved when the SDK exit releases it, and allows exactly one more send', async () => {
    const save = failReturnedHashSave()
    await review(); await press('Review transfer')
    expect(save.failures()).toBeGreaterThan(0)
    // The raw storage still holds the hashless reservation; the retained reply is only in memory.
    expect(storedPending().hash).toBeUndefined()
    save.mockRestore()
    await act(async () => { await mocks.tx.run.mock.calls[0][0].onReleased!() })
    expect(localStorage.getItem(`sticky:bridge:pending:v1:${OWNER.toLowerCase()}`)).toMatch(/^null$/)
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    mocks.tx.send.mockClear()
    await press('Cancel'); await press('Continue transfer')
    expect(mocks.tx.send).toHaveBeenCalledOnce()
  })
  it('clears the submission marker of a dropped prepare when the SDK exit releases it, keeping the transfer to continue or cancel', async () => {
    approved = true
    dropped()
    await review(); await press('Review transfer')
    const before = readBridgeRecords(KEY)[0]
    expect(before.submission?.hash).toBe(HASH)
    await act(async () => { await mocks.tx.run.mock.calls[0][0].onReleased!() })
    await press('Cancel')
    const after = readBridgeRecords(KEY)[0]
    expect(after.submission).toBeUndefined()
    expect(after.metadata).toBe(before.metadata)
    expect(after.steps).toEqual(before.steps)
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(button('Continue transfer')).toBeDefined()

    // The transfer can be cancelled, and a new one reconciles from scratch.
    await press('Cancel unsubmitted transfer')
    expect(readBridgeRecords(KEY)).toHaveLength(0)
    await review(); await press('Review transfer')
    expect(readBridgeRecords(KEY)).toHaveLength(1)
  })
  it('records a settlement the SDK reports after a failed hash save and a reload, marks the step done, and sends nothing again', async () => {
    const save = failReturnedHashSave()
    await review(); await press('Review transfer'); await press('Cancel')
    expect(storedPending().hash).toBeUndefined()
    save.mockRestore()
    const sent = mocks.tx.send.mock.calls.length
    await act(async () => root.unmount()); root = createRoot(host)
    // The SDK held the hash the wallet returned, and the chain shows it mined.
    const saved = readPendingBridgeWrite(OWNER)!
    await heldWrite({ chainId: 1, account: OWNER, namespace: saved.intent!, call: sentCall(), client: chain.client, hash: HASH })
    chain.mined(HASH, sentCall(), OWNER)
    await render()
    await vi.waitFor(() => expect(readPendingBridgeWrite(OWNER)).toBeNull())
    expect(mocks.verifyWrite).toHaveBeenCalledWith({ chainId: 1 }, OWNER, HASH, expect.anything(), { hash: HASH, safeProposal: false })
    expect(readBridgeRecords(KEY)[0].steps).toHaveLength(1)
    expect(mocks.tx.send.mock.calls.length).toBe(sent)
    await vi.waitFor(() => expect(text()).not.toContain('may still execute'))
  })
  it('records the transaction the SDK settled in place of the saved hash (a speed-up), marks the step done, and sends nothing again', async () => {
    const SPED_UP = H(91)
    // The SDK already holds the write by the transaction it followed (the wallet's speed-up), before the panel looks.
    await heldWrite({ chainId: 1, account: OWNER, namespace: approvalNamespace(), call: approvalCall(), client: chain.client, hash: SPED_UP })
    chain.mined(SPED_UP, approvalCall(), OWNER)
    await hashedThenDropped(); await press('Cancel')
    await vi.waitFor(() => expect(readPendingBridgeWrite(OWNER)).toBeNull())
    expect(mocks.verifyWrite).toHaveBeenCalledWith({ chainId: 1 }, OWNER, SPED_UP, expect.anything(), { hash: SPED_UP, safeProposal: false })
    expect(mocks.verifyWrite).not.toHaveBeenCalledWith(expect.anything(), OWNER, HASH, expect.anything(), expect.anything())
    expect(readBridgeRecords(KEY)[0].steps).toHaveLength(1)
    expect(mocks.tx.send).toHaveBeenCalledOnce()
  })
  it('keeps the prepare submission marker on the sped-up hash when the route refresh then fails', async () => {
    approved = true
    const SPED_UP = H(91)
    mocks.tx.send.mockImplementation(async call => {
      // The SDK's speed-up is of the same call the review saved (its metadata is the prepare's).
      chain.mined(SPED_UP, { to: call.to, data: call.data }, OWNER)
      return HASH
    })
    const prepare = queuedRequest()
    await heldWrite({ chainId: 1, account: OWNER, namespace: holdIntent(prepare, OWNER)!, call: { to: prepare.address, data: bridgeCalldata(prepare) }, client: chain.client, hash: SPED_UP })
    mocks.movements.mockRejectedValue(new Error('Route refresh unavailable'))
    dropped()
    await review()
    await press('Review transfer'); await press('Cancel')
    await vi.waitFor(() => expect(readBridgeRecords(KEY)[0].submission?.hash).toBe(SPED_UP))
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(SPED_UP)
    expect(button('Continue transfer')).toBeUndefined()
  })
  it('retries a settlement whose recovery failed or was skipped, and marks it handled only once adopted', async () => {
    await hashedThenDropped(); await press('Cancel')
    await act(async () => root.unmount()); root = createRoot(host)
    await settledAs(HASH)
    mocks.verifyWrite.mockRejectedValueOnce(new Error('Node unavailable')).mockRejectedValueOnce(new Error('Node unavailable'))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await render()
      await vi.waitFor(() => expect(mocks.verifyWrite).toHaveBeenCalled())
      // The first recovery failed: the reservation stands, and the settlement is not marked handled.
      expect(readPendingBridgeWrite(OWNER)).not.toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
      await vi.waitFor(() => expect(readPendingBridgeWrite(OWNER)).toBeNull())
    } finally { vi.useRealTimers() }
  })
  it('settles, never abandons, a prepare that confirms while its exit is shown, even when the route refresh then fails', async () => {
    approved = true
    await review(); await press('Review transfer'); await press('Cancel')
    await act(async () => root.unmount()); root = createRoot(host)
    later(31 * 60_000)
    mocks.movements.mockRejectedValue(new Error('Route refresh unavailable'))
    await render()
    await vi.waitFor(() => expect(button(HELD_EXIT_LABEL)).toBeDefined())
    // The user presses the exit; the chain shows the prepare confirmed meanwhile.
    chain.mined(HASH, sentCall(), OWNER)
    await press(HELD_EXIT_LABEL)
    await vi.waitFor(() => expect(mocks.verifyWrite).toHaveBeenCalled())
    const record = readBridgeRecords(KEY)[0]
    expect(record.submission?.hash).toBe(HASH)
    expect(button('Continue transfer')).toBeUndefined()
    expect(text()).toContain('Keep this saved reference until the origin transaction is verified')
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    expect(mocks.tx.send.mock.calls.length).toBe(1)
  })
  it('brings a main-era hashless reservation with no SDK record to the explicit check, releasing nothing on its own', async () => {
    savePendingBridgeWrite(OWNER, createPendingBridgeWrite({ owner: OWNER, request: storeBridgeWrite(queuedRequest()), intent: 'intent:bridge-queue:abc' }))
    await render()
    await vi.waitFor(() => expect(button(checkedItLabel())).toBeDefined())
    expect(readPendingBridgeWrite(OWNER)).not.toBeNull()
    expect(button('Review transfer').disabled).toBe(true)
  })
  it('gives a legacy reservation with no attempt id a durable one, so its check can end it', async () => {
    const legacy = { owner: OWNER, request: storeBridgeWrite(queuedRequest()) }
    localStorage.setItem(`sticky:bridge:pending:v1:${OWNER.toLowerCase()}`, JSON.stringify(legacy))
    expect(readPendingBridgeWrite(OWNER)?.id).toBeUndefined()
    await render()
    await vi.waitFor(() => expect(readPendingBridgeWrite(OWNER)?.id).toMatch(/^[0-9a-f-]{36}$/))
    // Only the id was added: the exact snapshot is otherwise unchanged.
    expect(readPendingBridgeWrite(OWNER)).toMatchObject(legacy)
    await vi.waitFor(() => expect(button(checkedItLabel())).toBeDefined())
    await press(checkedItLabel())
    await vi.waitFor(() => expect(readPendingBridgeWrite(OWNER)).toBeNull())
  })
  // Switch on with SDK 2.36's hold.adopt: a main-era reservation with a saved hash and no SDK record is adopted under the
  // domain lock, keeping the hash and any Safe identity; if its transaction dropped, the gate offers the warned exit.
  it('has the SDK adopt a hashed legacy reservation with its hash, keeping it held and nothing released', async () => {
    savePendingBridgeWrite(OWNER, createPendingBridgeWrite({ owner: OWNER, request: storeBridgeWrite(queuedRequest()), intent: 'intent:bridge-queue:abc' }))
    const hashed = { ...readPendingBridgeWrite(OWNER)!, hash: HASH, safeProposal: false, at: 1_700_000_000_000 }
    savePendingBridgeWrite(OWNER, hashed)
    await render()
    const handle = holds.open({ chainId: 1, account: OWNER, safe: false, namespace: 'intent:bridge-queue:abc', call: { to: hashed.request.address, data: hashed.request.data, value: 0n } })
    await vi.waitFor(() => expect(handle.peek()).toMatchObject({ record: { hash: HASH } }))
    // Saved long ago and never seen by the chain: the SDK's warned exit.
    await vi.waitFor(() => expect(button(HELD_EXIT_LABEL)).toBeDefined())
    expect(readPendingBridgeWrite(OWNER)).toEqual(hashed)
  })
  it('shows pending recovery even when receiver or route evidence is unavailable', async () => {
    savePendingBridgeWrite(OWNER, { owner: OWNER, request: storeBridgeWrite(queuedRequest()), hash: HASH })
    mocks.receiver.mockRejectedValue(new Error('RPC unavailable')); await render()
    expect(text()).toContain('Executed transaction hash')
    expect(text()).toContain('RPC unavailable')
    expect(button('Review transfer').disabled).toBe(true)
  })
  it('never opens the wallet if durable intent storage fails', async () => {
    await review()
    const setItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) { if (key.startsWith('sticky:bridge:pending:')) throw new Error('Storage full'); setItem.call(this, key, value) })
    await press('Review transfer')
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(readBridgeRecords(KEY)[0].submission).toBeUndefined()
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(text()).toContain('Storage full')
  })
  it('rolls back a partial intent write when persistence verification fails before the wallet', async () => {
    await review()
    const getItem = Storage.prototype.getItem
    let mismatch = true
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key) {
      const stored = getItem.call(this, key)
      if (key.startsWith('sticky:bridge:pending:') && stored && stored !== 'null' && mismatch) { mismatch = false; return null }
      return stored
    })
    await press('Review transfer')
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(readBridgeRecords(KEY)[0].submission).toBeUndefined()
    expect(text()).toContain('could not be saved')
  })
  it.each(['spender', 'value', 'chain', 'selector'] as const)('sends the reviewed next step, never a saved one tampered with (%s) after its review', async field => {
    await review(); await press('Review transfer')
    const record = readBridgeRecords(KEY)[0], step = record.steps[1]
    const reviewed = { ...step }
    if (field === 'spender') step.data = bridgeCalldata({ ...queuedRequest(record.metadata), args: [10n ** 18n, pad(A(999)), 965n, ROUTE.backingToken, record.metadata] })
    if (field === 'value') step.value = '1'
    if (field === 'chain') step.chainId = 10
    if (field === 'selector') step.data = bridgeCalldata({ chainId: 1, address: ROUTE.sourceToken, abi: erc20Abi, functionName: 'approve', args: [A(999), 10n ** 18n] })
    saveBridgeRecords(KEY, [record]); approved = true; await confirmed()
    expect(mocks.walletWrite).toHaveBeenCalledTimes(2)
    expect(mocks.walletWrite).toHaveBeenLastCalledWith(expect.objectContaining({ chainId: reviewed.chainId, data: reviewed.data, value: BigInt(reviewed.value) }))
    expect(mocks.tx.review).toHaveBeenCalledOnce()
  })
  it('drops an asynchronous review when navigation changes the destination project', async () => {
    let resolve!: (value: unknown) => void
    mocks.prepare.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await find(); await type('Amount', '1'); await press('Review transfer')
    await render(stickyInfo(10, 23n))
    await act(async () => resolve({ minimum: 965n, steps: [queuedRequest()] }))
    expect(readBridgeRecords(KEY)).toEqual([])
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(text()).toContain('wallet, project or bridge changed')
  })
  it('preserves the original pending reference on unfinalized or unproven recovery', async () => {
    savePendingBridgeWrite(OWNER, { owner: OWNER, request: storeBridgeWrite(queuedRequest()), hash: HASH })
    mocks.verifyWrite.mockRejectedValue(new Error('The failed transaction is not finalized'))
    await render(); await press('Check transaction')
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    expect(text()).toContain('not finalized')
  })
  it('monitors collector leaves at a fixed reward group without preparing another wallet transfer', async () => {
    mocks.movements.mockResolvedValue([movement('claimed')])
    await render(INFO, { route: ROUTE, groupId: 4000n })
    expect(text()).toContain('Track reward delivery')
    expect(text()).not.toContain('Origin project token')
    expect(button('Review transfer')).toBeUndefined()
    expect(mocks.receiver).toHaveBeenCalledWith(10, INFO.stToken, 4000n)
    await press('Check unsettled rewards')
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ initialGroupId: 4000n, initialToken: ROUTE.rewardToken }))
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('recovers a watched retired route after reload without live send discovery', async () => {
    saveWatchedBridgeRoute(10, INFO.stToken, 4000n, ROUTE)
    mocks.movements.mockResolvedValue([movement('claimable')])
    await render(INFO, { groupId: 4000n })
    expect(mocks.discover).not.toHaveBeenCalled()
    expect(mocks.movements).toHaveBeenCalledWith(expect.objectContaining({ sourceSucker: ROUTE.sourceSucker, canPrepare: false }), RECEIVER)
    expect(text()).toContain('Arrived. Ready to claim')
    await press('Claim arrival')
    expect(mocks.walletWrite).toHaveBeenCalledWith(expect.objectContaining({ chainId: 10, to: ROUTE.destinationSucker, functionName: 'claim' }))
  })

  it('refuses a handoff for another home chain before reading its movements', async () => {
    await render(INFO, { route: { ...ROUTE, destination: { chainId: 8453 } }, groupId: 0n })
    expect(text()).toContain('does not belong to this source and home chain')
    expect(mocks.movements).not.toHaveBeenCalled()
  })

  it('a stale recovery click cannot clear a newer pending transaction with identical calldata', async () => {
    const old = { owner: OWNER, request: storeBridgeWrite(queuedRequest()), hash: HASH }
    savePendingBridgeWrite(OWNER, old)
    await render()
    const next = { ...old, hash: H(91) }
    savePendingBridgeWrite(OWNER, next)
    await press('Check transaction')
    expect(mocks.verifyWrite).not.toHaveBeenCalled()
    expect(readPendingBridgeWrite(OWNER)).toEqual(next)
  })

  it('reads only this source and retains claimable arrivals when another watched lane fails', async () => {
    const otherSource = { ...ROUTE, source: { chainId: 8453 as const }, sourceSucker: A(71) }
    const broken = { ...ROUTE, sourceSucker: A(72), destinationSucker: A(73) }
    for (const route of [otherSource, broken, ROUTE]) saveWatchedBridgeRoute(10, INFO.stToken, 0n, route)
    mocks.movements.mockImplementation(async (route: BridgeRoute) => {
      if (route.sourceSucker === broken.sourceSucker) throw new Error('Old route unavailable')
      return [movement('claimable')]
    })
    await render(INFO, { groupId: 0n })
    expect(mocks.movements.mock.calls.map(([route]) => route.sourceSucker)).toEqual([broken.sourceSucker, ROUTE.sourceSucker])
    expect(text()).toContain('Arrived. Ready to claim')
    expect(text()).toContain('Old route unavailable')
  })

  it('hides the previous pool’s arrivals immediately when a new home-pool read stalls', async () => {
    mocks.movements.mockResolvedValue([movement('claimable')])
    await render(INFO, { route: ROUTE, groupId: 0n })
    expect(text()).toContain('Claim arrival')
    mocks.receiver.mockReturnValue(new Promise(() => {}))
    await render({ ...INFO, projectId: 99n, stToken: A(99) }, { groupId: 0n })
    expect(text()).not.toContain('Claim arrival')
    expect(mocks.walletWrite).not.toHaveBeenCalled()
  })

})
