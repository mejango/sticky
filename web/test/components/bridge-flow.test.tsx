// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { buildBridgeClaimTx, buildBridgePrepareTx, buildToRemoteTx, suckerLeafProof } from '@bananapus/nana-sdk-core/v6'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { erc20Abi, pad, zeroHash, type Address, type Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'
import { bridgeCalldata, type BridgeMovement, type BridgeRoute } from '@/lib/sticky-bridge'
import { bridgeStorageKey, createPendingBridgeWrite, readBridgeRecords, readPendingBridgeWrite, saveBridgeRecords, savePendingBridgeWrite, saveWatchedBridgeRoute, storeBridgeWrite } from '@/lib/sticky-bridge-journal'
import { WalletAuthContext } from '@/providers/WalletAuthContext'
import { stickyInfo } from '../home-fixtures'

const A = (n: number) => `0x${BigInt(n).toString(16).padStart(40, '0')}` as Address
const H = (n: number) => `0x${BigInt(n).toString(16).padStart(64, '0')}` as Hex
const OWNER = A(40), RECEIVER = A(41), HASH = H(90)
const INFO = stickyInfo(10, 22n)
const ROUTE: BridgeRoute = { source: { chainId: 1 }, destination: { chainId: 10 }, sourceSucker: A(1), destinationSucker: A(2), sourceProjectId: '11', destinationProjectId: '12', sourceToken: A(3), rewardToken: A(4), backingToken: A(5), remoteBackingToken: A(6), terminal: A(7), sourceMeta: { symbol: 'SRC', decimals: 18 }, rewardMeta: { symbol: 'DST', decimals: 18 }, backingMeta: { symbol: 'ETH', decimals: 18 }, canPrepare: true }
const KEY = bridgeStorageKey(10, INFO.stToken, 0n, OWNER)
const mocks = vi.hoisted(() => ({ wallet: {} as { address: Address; isConnected: boolean; isCenterWallet: boolean; openSignIn: ReturnType<typeof vi.fn> }, tx: {} as Record<string, unknown>, discover: vi.fn(), prepare: vi.fn(), movements: vi.fn(), flush: vi.fn(), claim: vi.fn(), verifyWrite: vi.fn(), verifySource: vi.fn(), receiver: vi.fn(), walletWrite: vi.fn(), refresh: vi.fn(), settle: vi.fn() }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/hooks/useSafeTx', async original => ({ ...(await original<typeof import('@/hooks/useSafeTx')>()), useSafeTx: () => mocks.tx }))
vi.mock('@/lib/sticky-bridge', async original => ({ ...(await original<typeof import('@/lib/sticky-bridge')>()), createStickyBridge: () => mocks }))
vi.mock('@/lib/jbcenter-rpc', async original => ({ ...(await original<typeof import('@/lib/jbcenter-rpc')>()), jbCenterPublicClient: vi.fn() }))
vi.mock('@/lib/sticky-receivers', () => ({ readReceiver: mocks.receiver }))
vi.mock('@/lib/sticky-refresh', () => ({ refreshAfterFund: mocks.refresh }))
vi.mock('@/components/project/flows/ReceiverFlow', () => ({ ReceiverFlow: (props: unknown) => { mocks.settle(props); return <span>Settle received rewards</span> } }))
import { BridgeFlow } from '@/components/project/flows/BridgeFlow'

let root: Root, host: HTMLDivElement, client: QueryClient, approved: boolean
const onClose = vi.fn(), onFunded = vi.fn()
const queuedRequest = (metadata = H(99)) => ({ ...buildBridgePrepareTx({ chainId: 1, sucker: ROUTE.sourceSucker, projectTokenCount: 10n ** 18n, beneficiary: RECEIVER, minTokensReclaimed: 965n, token: ROUTE.backingToken, metadata }), label: 'Queue cross-chain rewards' })
const movement = (status: BridgeMovement['status']): BridgeMovement => ({ leaf: { index: 0n, beneficiary: pad(RECEIVER), projectTokenCount: 10n ** 18n, terminalTokenAmount: 965n, metadata: H(99) }, leafHash: H(98), sourceHash: HASH, blockNumber: 100n, caller: OWNER, status, proof: Array<Hex>(32).fill(zeroHash) } as unknown as BridgeMovement)
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: object) => unknown) => work({}) } })
  approved = false
  mocks.wallet = { address: OWNER, isConnected: true, isCenterWallet: false, openSignIn: vi.fn() }
  mocks.tx = { phase: 'idle', busy: false, error: null, notice: null, hash: null, isSafe: false, safeNonceGuidance: null, safeProposalHash: null,
    reset: vi.fn(() => Object.assign(mocks.tx, { phase: 'idle', hash: null, busy: false, error: null })), dismiss: vi.fn(() => Object.assign(mocks.tx, { phase: 'idle', hash: null, busy: false })),
    send: vi.fn(async (request: TxRequest, options: TxSendOptions) => {
      try { await options.reverify?.(request); await options.durableRecovery?.reserve(); await mocks.walletWrite(request); await options.durableRecovery?.submitted(HASH, !!mocks.tx.isSafe); return HASH } catch (reason) { mocks.tx.error = (reason as Error).message; return null }
    }),
  }
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
afterEach(async () => { await act(async () => root.unmount()); host.remove(); client.clear() })
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
async function review() { await find(); await type('Amount', '1'); await press('Review transfer') }
async function confirmed() { Object.assign(mocks.tx, { phase: 'success', hash: HASH, busy: false }); await render() }
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
  mocks.tx.send = vi.fn(async (request: TxRequest, options: TxSendOptions) => {
    await options.reverify?.(request); await options.durableRecovery?.reserve(); await mocks.walletWrite(request)
    Object.assign(mocks.tx, { submissionHash: HASH, submissionIsSafe: false })
    replied = true
    try { await options.durableRecovery?.submitted(HASH, false) } catch (reason) { mocks.tx.error = (reason as Error).message }
    return HASH
  })
  return Object.assign(spy, { failures: () => failures })
}

describe('reviewed durable bridge workflow', () => {
  it('repairs the actual returned approval hash after its durable save failed', async () => {
    await review()
    const save = failReturnedHashSave()
    await press('Confirm & approve')
    const original = storedPending()
    expect(original.id).toBeTruthy(); expect(original.hash).toBeUndefined()
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    save.mockRestore()
    approved = true
    await confirmed()
    expect(mocks.walletWrite).toHaveBeenCalledOnce()
    expect(mocks.verifyWrite).toHaveBeenCalledWith({ chainId: 1 }, OWNER, HASH, expect.anything(), { hash: HASH, safeProposal: false })
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(readBridgeRecords(KEY)[0].steps).toHaveLength(1)
  })
  it.each([false, true])('never repairs or clears a newer identical approval using an older result (replacement hash %s)', async hasHash => {
    await review()
    const save = failReturnedHashSave()
    await press('Confirm & approve')
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
    await press('Confirm & approve')
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
    expect(text()).toContain('Minimum backing')
    expect(text()).toContain(ROUTE.sourceSucker)
    expect(text()).toContain(ROUTE.sourceToken)
    expect(text()).toContain('Allowance after approval1 SRC')
    mocks.walletWrite.mockImplementation(async (request: TxRequest) => {
      expect(readPendingBridgeWrite(OWNER)?.request.data).toBe(bridgeCalldata(request))
      expect(request).toMatchObject({ functionName: 'approve', address: ROUTE.sourceToken, args: [ROUTE.sourceSucker, 10n ** 18n] })
    })
    await press('Confirm & approve')
    expect(mocks.walletWrite).toHaveBeenCalledTimes(1)
    expect(readPendingBridgeWrite(OWNER)?.hash).toBe(HASH)
    expect(onFunded).not.toHaveBeenCalled()
  })
  it('wallet-action:queue-cross-chain-rewards Queue cross-chain rewards: continues only after approval proof and preserves the reviewed receiver and metadata', async () => {
    await review(); const metadata = readBridgeRecords(KEY)[0].metadata
    await press('Confirm & approve'); approved = true; await confirmed()
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    await press('Confirm & queue')
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
    mocks.movements.mockResolvedValue([movement('queued')]); await find(); await press('Refresh bridge status'); await press('Send across chains'); expect(text()).toContain('Bridge transport budget0.0000000000000001 ETH'); await press('Confirm & send')
    expect(mocks.walletWrite).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'toRemote', value: 100n, chainId: 1 }))
    expect(readPendingBridgeWrite(OWNER)?.request.value).toBe('100')
  })
  it('wallet-action:claim-arriving-rewards Claim arriving rewards: sends the fresh destination proof and hands claimed rewards to the existing settlement flow', async () => {
    mocks.movements.mockResolvedValue([movement('claimable')]); await find(); await press('Refresh bridge status'); await press('Claim arrival'); await press('Confirm & claim')
    expect(mocks.walletWrite).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'claim', chainId: 10, address: ROUTE.destinationSucker }))
    mocks.movements.mockResolvedValue([movement('claimed')]); await confirmed(); await press('Check unsettled rewards')
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ initialToken: ROUTE.rewardToken, initialGroupId: 0n, initiallyOpen: true, onSettled: onFunded }))
    expect(onFunded).not.toHaveBeenCalled()
  })
  it('retains a submitted Safe approval without advancing steps or reporting success', async () => {
    await review(); mocks.tx.isSafe = true; await press('Confirm & approve'); Object.assign(mocks.tx, { phase: 'submitted', notice: 'Awaiting Safe confirmations' }); await render()
    await press('Done')
    expect(readPendingBridgeWrite(OWNER)).toMatchObject({ hash: HASH, safeProposal: true })
    expect(readBridgeRecords(KEY)[0].steps).toHaveLength(2)
    expect(text()).toContain('finish its approvals')
    expect(onFunded).not.toHaveBeenCalled()
  })
  it('keeps an unknown wallet reply locked across dismissal and reload', async () => {
    mocks.tx.send = vi.fn(async (_request: TxRequest, options: TxSendOptions) => { await options.durableRecovery?.reserve(); return null })
    await review(); await press('Confirm & approve'); await press('Cancel')
    await act(async () => root.unmount()); root = createRoot(host); await render()
    expect(readPendingBridgeWrite(OWNER)?.hash).toBeUndefined()
    expect(button('Review transfer').disabled).toBe(true)
    expect(text()).toContain('may still execute')
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
    await press('Confirm & approve')
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
    await press('Confirm & approve')
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(readBridgeRecords(KEY)[0].submission).toBeUndefined()
    expect(text()).toContain('could not be saved')
  })
  it.each(['spender', 'value', 'chain', 'selector'] as const)('refuses a tampered saved next step (%s) under the unchanged parent review', async field => {
    await review(); await press('Confirm & approve')
    const record = readBridgeRecords(KEY)[0], step = record.steps[1]
    if (field === 'spender') step.data = bridgeCalldata({ ...queuedRequest(record.metadata), args: [10n ** 18n, pad(A(999)), 965n, ROUTE.backingToken, record.metadata] })
    if (field === 'value') step.value = '1'
    if (field === 'chain') step.chainId = 10
    if (field === 'selector') step.data = bridgeCalldata({ chainId: 1, address: ROUTE.sourceToken, abi: erc20Abi, functionName: 'approve', args: [A(999), 10n ** 18n] })
    saveBridgeRecords(KEY, [record]); approved = true; await confirmed()
    await press(field === 'selector' ? 'Confirm & approve' : 'Confirm & queue')
    expect(mocks.walletWrite).toHaveBeenCalledTimes(1)
    expect(text()).toContain('saved bridge step or quote changed')
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
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
    await press('Confirm & claim')
    expect(mocks.walletWrite).toHaveBeenCalledWith(expect.objectContaining({ chainId: 10, address: ROUTE.destinationSucker, functionName: 'claim' }))
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
