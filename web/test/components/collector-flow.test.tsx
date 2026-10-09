// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { buildStickyCollectorSendTx, buildStickyCollectorSettleTx } from '@bananapus/nana-sdk-core/v6'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TxRequest, TxSendOptions } from '@/hooks/useSafeTx'
import { bridgeCalldata } from '@/lib/sticky-bridge'
import { readPendingBridgeWrite, readWatchedBridgeRoutes, savePendingBridgeWrite, storeBridgeWrite } from '@/lib/sticky-bridge-journal'
import type { CollectorSource } from '@/lib/sticky-collector'
import { WalletAuthContext } from '@/providers/WalletAuthContext'
import {
  COLLECTOR_SOURCE as SOURCE, COLLECTOR_OWNER as OWNER, COLLECTOR_ROUTE as ROUTE, COLLECTOR_HASH as HASH,
  COLLECTOR_INFO as INFO, collectorAddress as A, collectorHash as H, localCollectorSource,
} from '../collector-fixtures'

const mocks = vi.hoisted(() => ({ wallet: {} as Record<string, unknown>, tx: {} as Record<string, unknown>, read: vi.fn(), prepare: vi.fn(), reverify: vi.fn(), verifyWrite: vi.fn(), walletWrite: vi.fn(), refresh: vi.fn(), monitor: vi.fn() }))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/hooks/useSafeTx', async original => ({ ...(await original<typeof import('@/hooks/useSafeTx')>()), useSafeTx: () => mocks.tx }))
vi.mock('@/lib/sticky-collector-delivery', async original => ({ ...(await original<typeof import('@/lib/sticky-collector-delivery')>()), createStickyCollectorDelivery: () => mocks }))
vi.mock('@/lib/sticky-bridge', async original => ({ ...(await original<typeof import('@/lib/sticky-bridge')>()), createStickyBridge: () => mocks }))
vi.mock('@/lib/jbcenter-rpc', async original => ({ ...(await original<typeof import('@/lib/jbcenter-rpc')>()), jbCenterPublicClient: vi.fn() }))
vi.mock('@/lib/sticky-refresh', () => ({ refreshAfterFund: mocks.refresh }))
vi.mock('@/components/project/flows/BridgeFlow', () => ({ BridgeFlow: (props: unknown) => { mocks.monitor(props); return <span>Existing bridge monitor</span> } }))
import { CollectorFlow } from '@/components/project/flows/CollectorFlow'

const UNIT = 10n ** 18n
const requestOf = (source = SOURCE, amount = UNIT): TxRequest => source.bridgeRoute
  ? { ...buildStickyCollectorSendTx({ ...source.allocation, amount, sucker: source.bridgeRoute.sourceSucker, backingToken: source.bridgeRoute.backingToken, value: 77n }), label: 'Deliver queued rewards' }
  : { ...buildStickyCollectorSettleTx({ ...source.allocation, amount }), label: 'Settle queued rewards' }
let root: Root, host: HTMLDivElement, client: QueryClient
const onSettled = vi.fn()
beforeEach(() => {
  localStorage.clear(); onSettled.mockReset()
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, work: (lock: object) => unknown) => work({}) } })
  mocks.wallet = { address: OWNER, isConnected: true, isCenterWallet: false, openSignIn: vi.fn() }
  mocks.tx = { phase: 'idle', busy: false, error: null, notice: null, hash: null, isSafe: false,
    reset: vi.fn(() => Object.assign(mocks.tx, { phase: 'idle', hash: null, busy: false, error: null })),
    dismiss: vi.fn(() => Object.assign(mocks.tx, { phase: 'idle', hash: null, busy: false })),
    send: vi.fn(async (request: TxRequest, options: TxSendOptions) => {
      try { await options.reverify?.(request); await options.beforeWrite?.(); await mocks.walletWrite(request); return HASH }
      catch (reason) { mocks.tx.error = (reason as Error).message; return null }
    }),
  }
  mocks.read.mockReset().mockResolvedValue({ pending: 10n * UNIT, meta: ROUTE.sourceMeta })
  mocks.prepare.mockReset().mockImplementation(async (source: CollectorSource, _owner: unknown, amount: bigint) => ({ source, amount, pending: 10n * UNIT, meta: ROUTE.sourceMeta, verified: source.verified, request: requestOf(source, amount) }))
  mocks.reverify.mockReset().mockResolvedValue(undefined)
  mocks.verifyWrite.mockReset().mockResolvedValue({ success: true, receipt: { blockNumber: 100n } })
  mocks.walletWrite.mockReset().mockResolvedValue(undefined)
  mocks.monitor.mockReset(); mocks.refresh.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); client.clear() })
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
async function review(source = SOURCE) { await render(source); await type('Amount to deliver', '1'); await press('Review delivery') }
async function confirmed(source = SOURCE) { Object.assign(mocks.tx, { phase: 'success', hash: HASH, busy: false }); await render(source) }

describe('permissionless collector delivery', () => {
  it('wallet-action:deliver-queued-rewards reviews one partial allocation and persists its exact call and route before the wallet', async () => {
    await review()
    expect(text()).toContain('Queued on Ethereum: 10 SRC')
    expect(text()).toContain('Reward address')
    expect(text()).toContain('Home chainOptimism')
    mocks.walletWrite.mockImplementation(async (request: TxRequest) => {
      expect(readPendingBridgeWrite(OWNER)?.request.data).toBe(bridgeCalldata(request))
      expect(readWatchedBridgeRoutes(10, INFO.stToken, 4000n)).toEqual([expect.objectContaining({ sourceSucker: ROUTE.sourceSucker, canPrepare: false })])
      expect(request).toMatchObject({ chainId: 1, address: SOURCE.allocation.deployment.address, functionName: 'send', args: [3n, INFO.stToken, 4000n, UNIT, ROUTE.sourceSucker, ROUTE.backingToken], value: 77n })
    })
    await press('Confirm & deliver')
    expect(mocks.walletWrite).toHaveBeenCalledTimes(1)
    expect(mocks.reverify).toHaveBeenCalledWith(expect.objectContaining({ amount: UNIT }), OWNER)
    expect(readPendingBridgeWrite(OWNER)).toMatchObject({ hash: HASH, safeProposal: false })
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('reports verified remote submission separately from settlement and opens the existing fixed-group bridge monitor', async () => {
    await review(); await press('Confirm & deliver')
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
    await review(source); await press('Confirm & settle')
    expect(onSettled).not.toHaveBeenCalled()
    await confirmed(source)
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(source.verified.rewardToken)
    expect(text()).toContain('Settled into this pool’s airdrops')
    expect(mocks.verifyWrite).toHaveBeenCalledWith({ chainId: 10 }, OWNER, HASH, expect.objectContaining({ data: bridgeCalldata(requestOf(source)), value: 0n }), { hash: HASH, safeProposal: false })
  })

  it('keeps a hashless unknown attempt locked through dismissal, reload and a matching historical hash', async () => {
    mocks.tx.send = vi.fn(async (_request: TxRequest, options: TxSendOptions) => { await options.beforeWrite?.(); return null })
    await review(); await press('Confirm & deliver'); await press('Cancel')
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
    await review(); mocks.tx.isSafe = true; await press('Confirm & deliver')
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
    expect(readPendingBridgeWrite(OWNER)).toEqual(held)
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
    expect(readPendingBridgeWrite(OWNER)).toEqual(held)
  })

  it('shows recovery even when allocation reads fail', async () => {
    savePendingBridgeWrite(OWNER, { owner: OWNER, request: storeBridgeWrite(requestOf()), hash: HASH })
    mocks.read.mockRejectedValue(new Error('Queue RPC unavailable'))
    await render()
    expect(text()).toContain('Executed transaction hash')
    expect(text()).toContain('Queue RPC unavailable')
    expect(button('Review delivery').disabled).toBe(true)
  })

  it('never reaches the wallet if recovery storage fails', async () => {
    await review()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    await press('Confirm & deliver')
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
  })

  it('revalidates before sending and keeps the queue untouched when the live route refuses', async () => {
    await review(); mocks.reverify.mockRejectedValue(new Error('Route retired'))
    await press('Confirm & deliver')
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(text()).toContain('Route retired')
  })

  it('drops an asynchronous review when the source group changes', async () => {
    const deferred = Promise.withResolvers<unknown>()
    mocks.prepare.mockReturnValueOnce(deferred.promise)
    await review()
    const other = { ...SOURCE, allocation: { ...SOURCE.allocation, groupId: 0n } }
    await render(other)
    await act(async () => deferred.resolve({ source: SOURCE, amount: UNIT, pending: 10n * UNIT, meta: ROUTE.sourceMeta, verified: SOURCE.verified, request: requestOf() }))
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(button('Confirm & deliver')).toBeUndefined()
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
    await press('Confirm & deliver')
    await act(async () => root.unmount()); root = createRoot(host)
    await render({ ...SOURCE, allocation: { ...SOURCE.allocation, groupId: 0n } })
    await act(async () => deferred.resolve())
    expect(mocks.walletWrite).not.toHaveBeenCalled()
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
  })

  it('persists the route when useSafeTx adopts an already queued Safe proposal without beforeWrite', async () => {
    await review(); mocks.tx.isSafe = true
    mocks.tx.send = vi.fn(async () => {
      expect(readWatchedBridgeRoutes(10, INFO.stToken, 4000n)).toHaveLength(1)
      return HASH
    })
    await press('Confirm & deliver')
    expect(readPendingBridgeWrite(OWNER)).toMatchObject({ hash: HASH, safeProposal: true })
    expect(readWatchedBridgeRoutes(10, INFO.stToken, 4000n)).toHaveLength(1)
  })

  it('clears pre-wallet intent after an explicit wallet refusal without reporting success', async () => {
    mocks.tx.send = vi.fn(async (_request: TxRequest, options: TxSendOptions) => {
      await options.beforeWrite?.(); await options.onWriteRejected?.(); return null
    })
    await review(); await press('Confirm & deliver')
    expect(readPendingBridgeWrite(OWNER)).toBeNull()
    expect(onSettled).not.toHaveBeenCalled()
  })

})
