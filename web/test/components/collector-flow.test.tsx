// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { buildStickyCollectorSendTx, buildStickyCollectorSettleTx } from '@bananapus/nana-sdk-core/v6'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TxRequest } from '@/hooks/useReviewedAction'
import { TransactionReviewCancelledError } from '@/lib/transaction-review'
import { bridgeCalldata } from '@/lib/sticky-bridge'
import { createPendingBridgeWrite, readPendingBridgeWrite, readWatchedBridgeRoutes, savePendingBridgeWrite, storeBridgeWrite } from '@/lib/sticky-bridge-journal'
import type { CollectorSource } from '@/lib/sticky-collector'
import { checkedItLabel, HELD_EXIT_LABEL, WRITE_HOLD_PENDING_LINE, NETWORK_ERROR_LINE } from '@bananapus/nana-sdk-core/review'
import { holds } from '@/lib/write-holds'
import { holdIntent } from '@/lib/sticky-hold-intent'
import { heldChain, heldWrite } from '../support/held-chain'
import { reviewedActionFake, type ReviewedActionFake } from '../support/reviewed-action'
import { WalletAuthContext } from '@/providers/WalletAuthContext'
import {
  COLLECTOR_SOURCE as SOURCE, COLLECTOR_OWNER as OWNER, COLLECTOR_ROUTE as ROUTE, COLLECTOR_HASH as HASH,
  COLLECTOR_INFO as INFO, collectorAddress as A, collectorHash as H, localCollectorSource,
} from '../collector-fixtures'

const mocks = vi.hoisted(() => ({ wallet: {} as Record<string, unknown>, tx: {} as ReviewedActionFake, read: vi.fn(), prepare: vi.fn(), reverify: vi.fn(), verifyWrite: vi.fn(), walletWrite: vi.fn(), refresh: vi.fn(), monitor: vi.fn() }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@wagmi/core', async original => ({ ...(await original<typeof import('@wagmi/core')>()), getPublicClient: (_config: unknown, { chainId }: { chainId: number }) => (chainId === 1 ? chain : home).client }))
vi.mock('@/hooks/useReviewedAction', async original => ({ ...(await original<typeof import('@/hooks/useReviewedAction')>()), useReviewedAction: () => mocks.tx }))
vi.mock('@/lib/sticky-collector-delivery', async original => ({ ...(await original<typeof import('@/lib/sticky-collector-delivery')>()), createStickyCollectorDelivery: () => mocks }))
vi.mock('@/lib/sticky-bridge', async original => ({ ...(await original<typeof import('@/lib/sticky-bridge')>()), createStickyBridge: () => mocks }))
vi.mock('@/lib/jbcenter-public-client', async original => ({ ...(await original<typeof import('@/lib/jbcenter-public-client')>()), jbCenterPublicClient: vi.fn() }))
vi.mock('@/lib/sticky-refresh', () => ({ refreshAfterFund: mocks.refresh }))
vi.mock('@/components/project/flows/BridgeFlow', () => ({ BridgeFlow: (props: unknown) => { mocks.monitor(props); return <span>Existing bridge monitor</span> } }))
import { CollectorFlow } from '@/components/project/flows/CollectorFlow'

const UNIT = 10n ** 18n
const requestOf = (source = SOURCE, amount = UNIT): TxRequest => source.bridgeRoute
  ? { ...buildStickyCollectorSendTx({ ...source.allocation, amount, sucker: source.bridgeRoute.sourceSucker, backingToken: source.bridgeRoute.backingToken, value: 77n }), label: 'Deliver queued rewards' }
  : { ...buildStickyCollectorSettleTx({ ...source.allocation, amount }), label: 'Settle queued rewards' }
let root: Root, host: HTMLDivElement, client: QueryClient
let chain = heldChain(1), home = heldChain(10)
const onSettled = vi.fn()
beforeEach(() => {
  localStorage.clear(); onSettled.mockReset()
  chain = heldChain(1)
  home = heldChain(10)
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: object) => unknown) => work({}) } })
  mocks.wallet = { address: OWNER, isConnected: true, isCenterWallet: false, openSignIn: vi.fn() }
  mocks.tx = reviewedActionFake(HASH)
  // The wallet: what it is asked to send, and the hash it answers.
  mocks.tx.send.mockImplementation(async call => { await mocks.walletWrite(call); return HASH })
  mocks.tx.reset.mockImplementation(() => Object.assign(mocks.tx, { phase: 'idle', hash: null, busy: false, error: null }))
  mocks.tx.dismiss.mockImplementation(() => Object.assign(mocks.tx, { phase: 'idle', hash: null, busy: false }))
  mocks.read.mockReset().mockResolvedValue({ pending: 10n * UNIT, meta: ROUTE.sourceMeta })
  mocks.prepare.mockReset().mockImplementation(async (source: CollectorSource, _owner: unknown, amount: bigint) => ({ source, amount, pending: 10n * UNIT, meta: ROUTE.sourceMeta, verified: source.verified, request: requestOf(source, amount) }))
  mocks.reverify.mockReset().mockResolvedValue(undefined)
  mocks.verifyWrite.mockReset().mockResolvedValue({ success: true, receipt: { blockNumber: 100n } })
  mocks.walletWrite.mockReset().mockResolvedValue(undefined)
  mocks.monitor.mockReset(); mocks.refresh.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(async () => {
  try {
    // Every wallet call is a step of a run its one review confirmed: no send skips it.
    expect(mocks.tx.review).toHaveBeenCalledTimes(mocks.tx.run.mock.calls.length)
  } finally { await act(async () => root.unmount()); host.remove(); client.clear() }
})
async function render(source = SOURCE, info = INFO) {
  await act(async () => root.render(<QueryClientProvider client={client}><WalletAuthContext.Provider value={{ requestSignIn: vi.fn() }}><CollectorFlow source={source} info={info} onSettled={onSettled} /></WalletAuthContext.Provider></QueryClientProvider>))
}
const text = () => document.body.textContent ?? ''
const button = (name: string) => [...document.querySelectorAll('button')].find(node => node.textContent === name)!
async function press(name: string) { const found = button(name); expect(found, name).toBeTruthy(); await act(async () => found.click()) }
async function type(label: string, value: string) {
  const node = [...document.querySelectorAll('label')].find(node => node.textContent === label)!
  const input = document.getElementById(node.htmlFor) as HTMLInputElement
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
/** The delivery form, filled. 'Review delivery' is then its one confirmation. */
async function review(source = SOURCE) { await render(source); await type('Amount to deliver', '1') }
async function confirmed(source = SOURCE) { Object.assign(mocks.tx, { phase: 'success', hash: HASH, busy: false }); await render(source) }
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

describe('permissionless collector delivery', () => {
  it('repairs the actual returned delivery hash after its durable save failed', async () => {
    await review()
    const save = failReturnedHashSave()
    await press('Review delivery')
    const original = storedPending()
    expect(original.id).toBeTruthy(); expect(original.hash).toBeUndefined()
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    save.mockRestore()
    await confirmed()
    expect(mocks.walletWrite).toHaveBeenCalledOnce()
    expect(mocks.verifyWrite).toHaveBeenCalledWith({ chainId: 1 }, OWNER, HASH, expect.anything(), { hash: HASH, safeProposal: false })
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(text()).toContain('Bridge delivery, claim and settlement are still pending')
  })
  it.each([false, true])('never repairs or clears a newer identical delivery using an older result (replacement hash %s)', async hasHash => {
    await review()
    const save = failReturnedHashSave()
    await press('Review delivery')
    const original = storedPending()
    save.mockRestore()
    const replacement = { ...original, id: crypto.randomUUID(), ...(hasHash ? { hash: H(91), safeProposal: false } : {}) }
    savePendingBridgeWrite(OWNER, replacement)
    await confirmed()
    expect(readPendingBridgeWrite(OWNER)).toEqual(replacement)
    expect(mocks.verifyWrite).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
    expect(text()).toContain('pending bridge transaction changed')
  })
  it.each(['write', 'read'] as const)('recovers the retained delivery after two hash saves fail, the review unmounts and storage returns (%s)', async failure => {
    await review()
    const save = failReturnedHashSave(failure)
    await press('Review delivery')
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
    expect(text()).not.toContain('The wallet returned no submission reference')
    await press('Check transaction')
    expect(mocks.verifyWrite).toHaveBeenCalledWith({ chainId: 1 }, OWNER, HASH, expect.anything(), { hash: HASH, safeProposal: false })
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(text()).toContain('Bridge delivery, claim and settlement are still pending')
    expect(mocks.walletWrite).toHaveBeenCalledOnce()
  })
  it('rechecks the saved reservation after an asynchronous canonical proof before clearing', async () => {
    const original = { ...createPendingBridgeWrite({ owner: OWNER, request: storeBridgeWrite(requestOf()) }), hash: HASH }
    savePendingBridgeWrite(OWNER, original)
    const proof = Promise.withResolvers<{ success: boolean; receipt: { blockNumber: bigint } }>()
    mocks.verifyWrite.mockReturnValueOnce(proof.promise)
    await render(); await press('Check transaction')
    const replacement = { ...original, id: crypto.randomUUID(), hash: H(91) }
    savePendingBridgeWrite(OWNER, replacement)
    await act(async () => proof.resolve({ success: true, receipt: { blockNumber: 100n } }))
    expect(readPendingBridgeWrite(OWNER)).toEqual(replacement)
    expect(onSettled).not.toHaveBeenCalled()
    expect(text()).toContain('pending bridge transaction changed')
  })
  it('wallet-action:deliver-queued-rewards reviews one partial allocation and persists its exact call and route before the wallet', async () => {
    await review()
    expect(text()).toContain('Queued on Ethereum: 10 SRC')
    mocks.walletWrite.mockImplementation(async (call: { data: string }) => {
      expect(readPendingBridgeWrite(OWNER)?.request.data).toBe(call.data)
      expect(readWatchedBridgeRoutes(10, INFO.stToken, 4000n)).toEqual([expect.objectContaining({ sourceSucker: ROUTE.sourceSucker, canPrepare: false })])
      expect(call).toMatchObject({ chainId: 1, to: SOURCE.allocation.deployment.address, functionName: 'send', args: [3n, INFO.stToken, 4000n, UNIT, ROUTE.sourceSucker, ROUTE.backingToken], value: 77n })
    })
    await press('Review delivery')
    expect(mocks.walletWrite).toHaveBeenCalledTimes(1)
    // One user action, one decoded review, with the delivery's summary above the call.
    expect(mocks.tx.review).toHaveBeenCalledOnce()
    expect(mocks.tx.run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ calls: [expect.objectContaining({ functionName: 'send' })], account: OWNER, context: expect.arrayContaining([{ label: 'Home chain', value: 'Optimism' }, expect.objectContaining({ label: 'Reward address' })]) }))
    expect(mocks.reverify).toHaveBeenCalledWith(expect.objectContaining({ amount: UNIT }), OWNER)
    expect(readPendingBridgeWrite(OWNER)).toMatchObject({ hash: HASH, safeProposal: false })
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('closes the delivery and sends nothing when its one review is closed', async () => {
    mocks.tx.review.mockRejectedValueOnce(new TransactionReviewCancelledError())
    await review(); await press('Review delivery')
    expect(mocks.tx.send).not.toHaveBeenCalled()
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(text()).not.toContain('Review again')
    expect(text()).not.toContain('Review closed')
  })

  it('reports verified remote submission separately from settlement and opens the existing fixed-group bridge monitor', async () => {
    await review(); await press('Review delivery')
    mocks.read.mockResolvedValue({ pending: 9n * UNIT, meta: ROUTE.sourceMeta })
    await confirmed()
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(text()).toContain('Queued on Ethereum: 9 SRC')
    expect(text()).toContain('Bridge delivery, claim and settlement are still pending')
    expect(onSettled).not.toHaveBeenCalled()
    await press('Track deliveries')
    expect(mocks.monitor).toHaveBeenCalledWith(expect.objectContaining({ sourceChainId: 1, info: INFO, delivery: { route: ROUTE, groupId: 4000n }, onFunded: onSettled }))
  })

  it('wallet-action:settle-queued-rewards reports local settlement only after exact canonical execution proof', async () => {
    const source = localCollectorSource()
    await review(source); await press('Review delivery')
    expect(onSettled).not.toHaveBeenCalled()
    await confirmed(source)
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(source.verified.rewardToken)
    expect(text()).toContain('Settled into this pool’s airdrops')
    expect(mocks.verifyWrite).toHaveBeenCalledWith({ chainId: 10 }, OWNER, HASH, expect.objectContaining({ data: bridgeCalldata(requestOf(source)), value: 0n }), { hash: HASH, safeProposal: false })
  })

  it('keeps a hashless unknown attempt locked through dismissal, reload and a matching historical hash', async () => {
    // The wallet's reply never comes back: the send may have gone out.
    mocks.tx.send.mockRejectedValue(new Error('The request took too long to respond.'))
    await review(); await press('Review delivery'); await press('Cancel')
    await act(async () => root.unmount()); root = createRoot(host); await render()
    expect(button('Review delivery').disabled).toBe(true)
    const held = readPendingBridgeWrite(OWNER)
    expect(held?.hash).toBeUndefined()
    const actual = await vi.importActual<typeof import('@/lib/sticky-bridge')>('@/lib/sticky-bridge')
    mocks.verifyWrite.mockImplementation(actual.createStickyBridge(() => { throw new Error('No RPC should run without a submission reference') }).verifyWrite)
    await type('Executed transaction hash', H(89)); await press('Check transaction')
    expect(readPendingBridgeWrite(OWNER)).toEqual(held)
    expect(text()).toContain('unknown wallet attempt cannot be identified')
    expect(mocks.walletWrite).not.toHaveBeenCalled()
  })

  it('keeps a Safe proposal pending until its executed hash verifies the saved proposal', async () => {
    await review(); mocks.tx.isSafe = true; await press('Review delivery')
    Object.assign(mocks.tx, { phase: 'submitted', notice: 'Awaiting Safe confirmations' }); await render()
    await press('Done')
    expect(onSettled).not.toHaveBeenCalled()
    expect(readPendingBridgeWrite(OWNER)).toMatchObject({ hash: HASH, safeProposal: true })
    await type('Executed transaction hash', H(91)); await press('Check transaction')
    expect(mocks.verifyWrite).toHaveBeenCalledWith({ chainId: 1 }, OWNER, H(91), expect.anything(), { hash: HASH, safeProposal: true })
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
  })

  it('retains pending intent while proof is unavailable, then permits a new review only after a proven revert', async () => {
    const held = { owner: OWNER, request: storeBridgeWrite(requestOf()), hash: HASH }
    savePendingBridgeWrite(OWNER, held)
    mocks.verifyWrite.mockRejectedValueOnce(new Error('Failure is not finalized'))
    await render(); await press('Check transaction')
    // A legacy snapshot keeps every field and gains only a durable attempt id.
    expect(readPendingBridgeWrite(OWNER)).toEqual({ ...held, id: expect.any(String) })
    expect(button('Review delivery').disabled).toBe(true)
    mocks.verifyWrite.mockResolvedValue({ success: false, receipt: { blockNumber: 100n } })
    await press('Check transaction')
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(button('Review delivery').disabled).toBe(false)
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('does not clear another tab’s newer attempt, even when the calldata is identical', async () => {
    const old = { owner: OWNER, request: storeBridgeWrite(requestOf()), hash: HASH }
    savePendingBridgeWrite(OWNER, old); await render()
    const next = { ...old, hash: H(91) }; savePendingBridgeWrite(OWNER, next)
    await press('Check transaction')
    expect(readPendingBridgeWrite(OWNER)).toEqual(next)
    expect(mocks.verifyWrite).not.toHaveBeenCalled()
  })

  it('leaves record-linked bridge actions to their original recovery owner', async () => {
    const held = { owner: OWNER, request: storeBridgeWrite(requestOf()), hash: HASH, metadata: H(3), recordKey: 'original' }
    savePendingBridgeWrite(OWNER, held); await render()
    expect(button('Check transaction')).toBeUndefined()
    expect(text()).toContain('original bridge or allocation panel')
    expect(readPendingBridgeWrite(OWNER)).toEqual({ ...held, id: expect.any(String) })
  })

  it('brings a hashless delivery reservation the SDK never held to the one explicit check after reload, which clears it, keeps the watched route, and allows exactly one more send', async () => {
    mocks.tx.send.mockRejectedValueOnce(new Error('The request took too long to respond.'))
    await review(); await press('Review delivery')
    const route = readWatchedBridgeRoutes(10, INFO.stToken, 4000n)
    expect(route).toHaveLength(1)
    await act(async () => root.unmount()); root = createRoot(host)
    await render()
    expect(readPendingBridgeWrite(OWNER)?.hash).toBeUndefined()
    expect(button('Review delivery').disabled).toBe(true)

    // Nothing can send while the reservation stands; the explicit check is the way out.
    await vi.waitFor(() => expect(button(checkedItLabel())).toBeDefined())
    await press(checkedItLabel())
    await vi.waitFor(() => expect(readPendingBridgeWrite(OWNER)).toBeNull())
    expect(readWatchedBridgeRoutes(10, INFO.stToken, 4000n)).toEqual(route)

    mocks.tx.send.mockClear()
    await review()
    await press('Review delivery')
    expect(mocks.tx.send).toHaveBeenCalledOnce()
  })
  /** A delivery the wallet answered with HASH, whose transaction the chain then never shows. */
  async function hashedThenDropped() {
    await review(); await press('Review delivery')
    const action = mocks.tx.run.mock.calls[0][0]
    return { released: () => action.onReleased!() }
  }
  /** The delivery the review sends, as the chain sees it. */
  const deliveryCall = () => {
    const request = requestOf()
    return { to: request.address, data: bridgeCalldata(request), value: request.value ?? 0n }
  }
  /** Time passes: the SDK's own clock reads it. */
  const later = (ms: number) => { const now = Date.now() + ms; vi.spyOn(Date, 'now').mockReturnValue(now) }
  it('clears the reservation of a delivery whose hash was saved when the SDK exit releases it, and allows exactly one more send', async () => {
    const { released } = await hashedThenDropped()
    const route = readWatchedBridgeRoutes(10, INFO.stToken, 4000n)
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    await act(async () => { await released() })
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(readWatchedBridgeRoutes(10, INFO.stToken, 4000n)).toEqual(route)
    mocks.tx.send.mockClear()
    await press('Cancel'); await review(); await press('Review delivery')
    expect(mocks.tx.send).toHaveBeenCalledOnce()
  })
  it('after a reload, shows the SDK\'s exit for a saved delivery hash the chain has not shown for 30 minutes, and clears it keeping the route', async () => {
    await hashedThenDropped(); await press('Cancel')
    const route = readWatchedBridgeRoutes(10, INFO.stToken, 4000n)
    await act(async () => root.unmount()); root = createRoot(host)
    later(31 * 60_000)
    await render()
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    await vi.waitFor(() => expect(button(HELD_EXIT_LABEL)).toBeDefined())
    await press(HELD_EXIT_LABEL)
    await vi.waitFor(() => expect(readPendingBridgeWrite(OWNER)).toBeNull())
    expect(readWatchedBridgeRoutes(10, INFO.stToken, 4000n)).toEqual(route)
  })
  it('after a reload, shows no exit for a hash the chain still knows', async () => {
    await hashedThenDropped(); await press('Cancel')
    chain.pending(HASH, deliveryCall(), OWNER)
    await act(async () => root.unmount()); root = createRoot(host)
    later(5 * 60_000)
    await render()
    await vi.waitFor(() => expect(text()).toContain(WRITE_HOLD_PENDING_LINE))
    expect([...document.querySelectorAll('button')].some(node => node.textContent === HELD_EXIT_LABEL)).toBe(false)
    expect(readPendingBridgeWrite(OWNER)).not.toBeNull()
  })
  it('records a settlement the SDK reports after a failed hash save and a reload, and sends nothing again', async () => {
    await review()
    const save = failReturnedHashSave()
    await press('Review delivery')
    save.mockRestore()
    const sent = mocks.tx.send.mock.calls.length
    await act(async () => root.unmount()); root = createRoot(host)
    // The SDK held the hash the wallet returned, and the chain shows it mined.
    await heldWrite({ chainId: 1, account: OWNER, namespace: readPendingBridgeWrite(OWNER)!.intent!, call: deliveryCall(), client: chain.client, hash: HASH })
    chain.mined(HASH, deliveryCall(), OWNER)
    await render()
    await vi.waitFor(() => expect(readPendingBridgeWrite(OWNER)).toBeNull())
    expect(mocks.verifyWrite).toHaveBeenCalledWith({ chainId: 1 }, OWNER, HASH, expect.anything(), { hash: HASH, safeProposal: false })
    expect(mocks.tx.send.mock.calls.length).toBe(sent)
  })
  it('records the delivery the SDK settled in place of the saved hash (a speed-up), and sends nothing again', async () => {
    const SPED_UP = H(91)
    // The SDK already holds the delivery by the transaction it followed (the wallet's speed-up), before the panel looks.
    await heldWrite({ chainId: 1, account: OWNER, namespace: holdIntent(requestOf(), OWNER)!, call: deliveryCall(), client: chain.client, hash: SPED_UP })
    chain.mined(SPED_UP, deliveryCall(), OWNER)
    await hashedThenDropped(); await press('Cancel')
    await vi.waitFor(() => expect(readPendingBridgeWrite(OWNER)).toBeNull())
    expect(mocks.verifyWrite).toHaveBeenCalledWith({ chainId: 1 }, OWNER, SPED_UP, expect.anything(), { hash: SPED_UP, safeProposal: false })
    expect(mocks.tx.send).toHaveBeenCalledOnce()
  })
  // Switch on with SDK 2.36's hold.adopt, as in the bridge flow: a hashed legacy delivery with no SDK record gets the warned exit.
  it('has the SDK adopt a hashed legacy delivery reservation with its hash', async () => {
    const hashed = { ...createPendingBridgeWrite({ owner: OWNER, request: storeBridgeWrite(requestOf()), intent: 'intent:collector-delivery:abc' }), hash: HASH, safeProposal: false }
    savePendingBridgeWrite(OWNER, hashed)
    await render()
    const handle = holds.open({ chainId: 1, account: OWNER, safe: false, namespace: 'intent:collector-delivery:abc', call: { ...deliveryCall(), value: BigInt(hashed.request.value) } })
    await vi.waitFor(() => expect(handle.peek()).toMatchObject({ record: { hash: HASH } }))
    expect(readPendingBridgeWrite(OWNER)).toEqual(hashed)
  })
  it('shows recovery even when allocation reads fail', async () => {
    savePendingBridgeWrite(OWNER, { owner: OWNER, request: storeBridgeWrite(requestOf()), hash: HASH })
    mocks.read.mockRejectedValue(new Error('Queue RPC unavailable'))
    await render()
    expect(text()).toContain('Executed transaction hash')
    expect(text()).toContain(NETWORK_ERROR_LINE)
    expect(button('Review delivery').disabled).toBe(true)
  })

  it('never reaches the wallet if recovery storage fails', async () => {
    await review()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    await press('Review delivery')
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('revalidates before sending and keeps the queue untouched when the live route refuses', async () => {
    await review(); mocks.reverify.mockRejectedValue(new Error('Route retired'))
    await press('Review delivery')
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(text()).toContain('Route retired')
  })

  it('drops an asynchronous review when the source group changes', async () => {
    const deferred = Promise.withResolvers<unknown>()
    mocks.prepare.mockReturnValueOnce(deferred.promise)
    await review(); await press('Review delivery')
    const other = { ...SOURCE, allocation: { ...SOURCE.allocation, groupId: 0n } }
    await render(other)
    await act(async () => deferred.resolve({ source: SOURCE, amount: UNIT, pending: 10n * UNIT, meta: ROUTE.sourceMeta, verified: SOURCE.verified, request: requestOf() }))
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(button('Review again')).toBeUndefined()
    expect(text()).toContain('allocation changed')
  })

  it('rejects a source family for another home pool', async () => {
    await render(SOURCE, { ...INFO, stToken: A(99) })
    expect(mocks.read).not.toHaveBeenCalled()
    expect(button('Review delivery').disabled).toBe(true)
    expect(text()).toContain('allocation changed')
  })
  it('invalidates a delayed wallet revalidation when the allocation component unmounts', async () => {
    const deferred = Promise.withResolvers<void>()
    await review()
    mocks.reverify.mockReturnValueOnce(deferred.promise)
    await press('Review delivery')
    await act(async () => root.unmount()); root = createRoot(host)
    await render({ ...SOURCE, allocation: { ...SOURCE.allocation, groupId: 0n } })
    await act(async () => deferred.resolve())
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
  })

  it('persists the route when the engine adopts an already queued Safe proposal without beforeWallet', async () => {
    await review(); mocks.tx.isSafe = true
    mocks.tx.run.mockImplementationOnce(async action => {
      await mocks.tx.review(action)
      expect(readWatchedBridgeRoutes(10, INFO.stToken, 4000n)).toHaveLength(1)
      await action.onSubmitted!(action.calls[0], 0, HASH, { safe: true, adopted: true })
      return { status: 'proposed', step: 0, safeTxHash: HASH, signatures: [] }
    })
    await press('Review delivery')
    expect(readPendingBridgeWrite(OWNER)).toMatchObject({ hash: HASH, safeProposal: true })
    expect(readWatchedBridgeRoutes(10, INFO.stToken, 4000n)).toHaveLength(1)
  })

  it('clears pre-wallet intent after an explicit wallet refusal without reporting success', async () => {
    mocks.tx.send.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { code: 4001 }))
    await review(); await press('Review delivery')
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(onSettled).not.toHaveBeenCalled()
  })

})
