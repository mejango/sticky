import { stickyDeployerAbi } from '@bananapus/nana-sdk-core'
import type { RelayrQuote } from '@bananapus/nana-sdk-core/review/relayr'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import type { LaunchPlan } from '@/lib/sticky-launch-plan'
import { STICKY_LAUNCH_KEY, createStickyLaunchController, createStickyLaunchStore, launchCanClear, launchComplete, validateStickyLaunch,
  type StickyLaunchPorts } from '@/lib/sticky-launch-session'
import { memoryStorage } from '../memory-storage'

vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: vi.fn() }))
const address = (digit: string) => `0x${digit.repeat(40)}` as Address
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hex
const OWNER = address('1'), TOKEN = address('2'), DEPLOYER = address('3'), CONTROLLER = address('4'), PROJECTS = address('5')
const H1 = hash('a'), H2 = hash('b')

function plan(chainIds = [84532]): LaunchPlan {
  const value: LaunchPlan = { id: 'launch-identity', owner: OWNER, token: TOKEN, tokenName: 'Backing', tokenSymbol: 'BACK', tokenDecimals: 18,
    name: 'Sticky Backing', symbol: 'STICKYBACK', cashOutTaxRate: '1000', soulbound: false, projectUri: 'data:,launch-identity', environment: 'testnet', targets: [] }
  value.targets = chainIds.map(chainId => ({ chainId, deployer: DEPLOYER, controller: CONTROLLER, projects: PROJECTS,
    call: { chain: chainId, target: DEPLOYER, value: '0', data: encodeFunctionData({ abi: stickyDeployerAbi, functionName: 'deployStickyFor',
      args: [TOKEN, value.name, value.symbol, value.projectUri, 1000n, [address('6')], false] }) } }))
  return value
}
const payment = { chain: 84532, amount: '12', address: address('7') }
const quote = { bundle_uuid: '11111111-1111-4111-8111-111111111111', payment_info: [payment], expectedTransactions: [] } as unknown as RelayrQuote

function fixture(chainIds = [84532], capability: 'sponsored' | 'self-paid' | 'unavailable' = 'self-paid') {
  const storage = memoryStorage()
  const store = createStickyLaunchStore(storage)
  const ports: StickyLaunchPorts = {
    store, guard: vi.fn(), review: vi.fn(async () => {}), quote: vi.fn(async (_plan, _remember, beforePublish) => { await beforePublish(); return quote }), status: vi.fn(async () => ({})),
    choosePayment: vi.fn(async () => quote.payment_info[0]),
    sendDirect: vi.fn(async (_session, callbacks) => { await callbacks.beforeWrite(); callbacks.submitted(H1) }),
    sendPayment: vi.fn(async (_session, callbacks) => { await callbacks.beforeWrite(); callbacks.submitted(H2) }),
    verifyPayment: vi.fn(async () => true), verifyDeployment: vi.fn(async () => null),
    requireRetry: vi.fn(async () => {}),
    publishListing: vi.fn(async () => 'listing-identity'), sponsor: vi.fn(async (_session, beforeRequest) => { await beforeRequest() }),
    record: vi.fn(async () => true), changed: vi.fn(),
  }
  const controller = createStickyLaunchController(ports)
  const prepared = controller.prepare(plan(chainIds), capability)
  return { storage, store, ports, controller, prepared }
}

describe('durable Sticky launch controller', () => {
  it('wallet-action:create-a-sticky-token retains the submitted direct hash and never sends it twice after reload', async () => {
    const f = fixture()
    await f.controller.run()
    expect(f.store.load()?.direct).toEqual({ started: true, hash: H1 })
    expect(f.store.load()?.candidates[84532]).toEqual([H1])
    await createStickyLaunchController(f.ports).run()
    expect(f.ports.sendDirect).toHaveBeenCalledTimes(1)
    expect(f.ports.review).toHaveBeenCalledTimes(1)
    await expect(f.controller.clear()).rejects.toThrow('Recover')
  })

  it('durably marks raw publication before POST and cannot republish a timed-out quote', async () => {
    const f = fixture([84532, 11155420])
    vi.mocked(f.ports.quote).mockImplementation(async (_plan, _remember, beforePublish) => {
      await beforePublish()
      expect(f.store.load()?.published).toBe(true)
      throw new Error('POST timed out')
    })
    await expect(f.controller.run()).rejects.toThrow('POST timed out')
    await expect(createStickyLaunchController(f.ports).run()).rejects.toThrow('may already be published')
    expect(f.ports.quote).toHaveBeenCalledTimes(1)
    expect(f.ports.sendPayment).not.toHaveBeenCalled()
    expect(launchCanClear(f.store.load()!)).toBe(false)
  })

  it('keeps a returned bundle identity even when later quote binding fails', async () => {
    const f = fixture([84532, 11155420])
    vi.mocked(f.ports.quote).mockImplementation(async (_plan, remember, beforePublish) => { await beforePublish(); remember(quote.bundle_uuid); throw new Error('binding failed') })
    await expect(f.controller.run()).rejects.toThrow('binding failed')
    expect(f.store.load()).toMatchObject({ published: true, bundleUuid: quote.bundle_uuid })
    await expect(f.controller.run()).rejects.toThrow('may already be published')
    expect(f.ports.quote).toHaveBeenCalledTimes(1)
  })

  it('can retry a failed preflight before quote publication, while a published quote stays locked', async () => {
    const f = fixture([84532, 11155420])
    vi.mocked(f.ports.quote).mockRejectedValueOnce(new Error('RPC unavailable before publication'))
    await expect(f.controller.run()).rejects.toThrow('before publication')
    expect(f.store.load()?.published).toBe(false)
    expect(launchCanClear(f.store.load()!)).toBe(true)
    await f.controller.run()
    expect(f.ports.quote).toHaveBeenCalledTimes(2)
    expect(f.ports.sendPayment).toHaveBeenCalledTimes(1)
    expect(f.store.load()?.published).toBe(true)
  })

  it('wallet-action:pay-for-a-multichain-sticky-launch saves the exact option and funding hash once', async () => {
    const f = fixture([84532, 11155420])
    await f.controller.run()
    expect(f.store.load()?.payment).toMatchObject({ option: payment, started: true, hash: H2, confirmed: true })
    await f.controller.run()
    expect(f.ports.sendPayment).toHaveBeenCalledTimes(1)
    expect(f.ports.quote).toHaveBeenCalledTimes(1)
    expect(f.ports.sendDirect).not.toHaveBeenCalled()
  })

  it('refuses a payment chooser response outside the saved quote', async () => {
    const f = fixture([84532, 11155420])
    vi.mocked(f.ports.choosePayment).mockResolvedValue({ ...quote.payment_info[0], amount: '999' })
    await expect(f.controller.run()).rejects.toThrow('actual payment options')
    expect(f.ports.sendPayment).not.toHaveBeenCalled()
  })

  it('unknown wallet errors keep the write intent; only a proven rejection releases it', async () => {
    const unknown = fixture()
    vi.mocked(unknown.ports.sendDirect).mockImplementation(async (_session, callbacks) => { await callbacks.beforeWrite(); throw new Error('provider disconnected') })
    await expect(unknown.controller.run()).rejects.toThrow('disconnected')
    expect(unknown.store.load()?.direct).toEqual({ started: true })
    await unknown.controller.run()
    expect(unknown.ports.sendDirect).toHaveBeenCalledTimes(1)
    const rejected = fixture()
    vi.mocked(rejected.ports.sendDirect).mockImplementation(async (_session, callbacks) => { await callbacks.beforeWrite(); callbacks.rejected(); throw new Error('User rejected') })
    await expect(rejected.controller.run()).rejects.toThrow('User rejected')
    expect(rejected.store.load()?.direct).toBeUndefined()
    expect(launchCanClear(rejected.store.load()!)).toBe(true)
  })

  it('saves a Safe proposal before a wait fails, and binds its mined receipt later without resending', async () => {
    const f = fixture()
    vi.mocked(f.ports.sendDirect).mockImplementation(async (_session, callbacks) => {
      await callbacks.beforeWrite(); callbacks.submitted(H1, H1); throw new Error('Waiting for multisig')
    })
    await expect(f.controller.run()).rejects.toThrow('multisig')
    vi.mocked(f.ports.status).mockResolvedValue({ 84532: [H2] })
    vi.mocked(f.ports.verifyDeployment).mockImplementation(async (_session, _target, candidate) => candidate === H2 ? { hash: H2, token: address('8'), projectId: '12' } : null)
    const recovered = await createStickyLaunchController(f.ports).refresh()
    expect(recovered.direct).toEqual({ started: true, hash: H1, proposalHash: H1 })
    expect(launchComplete(recovered)).toBe(true)
    expect(f.ports.sendDirect).toHaveBeenCalledTimes(1)
  })

  it('wallet-action:authorize-sticky-listing keeps listing failure retryable while direct launch remains usable', async () => {
    const f = fixture()
    vi.mocked(f.ports.publishListing).mockRejectedValueOnce(new Error('Center offline'))
    await f.controller.run()
    expect(f.store.load()?.listing).toMatchObject({ state: 'unlisted', error: 'Center offline' })
    expect(f.ports.sendDirect).toHaveBeenCalledTimes(1)
    await f.controller.list()
    expect(f.store.load()?.listing).toMatchObject({ state: 'published', intentId: 'listing-identity' })
    expect(f.ports.sendDirect).toHaveBeenCalledTimes(1)
  })

  it('persists sponsor publication before request and never falls back after an unknown sponsor reply', async () => {
    const f = fixture([84532], 'sponsored')
    vi.mocked(f.ports.sponsor).mockImplementation(async (_session, beforeRequest) => {
      await beforeRequest()
      expect(f.store.load()?.listing.requested).toBe(true)
      throw new Error('Sponsor timeout')
    })
    await expect(f.controller.run()).rejects.toThrow('Sponsor timeout')
    await f.controller.run()
    await expect(f.controller.selfPay()).rejects.toThrow('may already be running')
    expect(f.ports.sponsor).toHaveBeenCalledTimes(1)
    expect(f.ports.sendDirect).not.toHaveBeenCalled()
    expect(launchCanClear(f.store.load()!)).toBe(false)
  })

  it('offers self-payment before sponsoring, without posting a sponsor request', async () => {
    const f = fixture([84532], 'sponsored')
    await f.controller.selfPay()
    await f.controller.run()
    expect(f.ports.sponsor).not.toHaveBeenCalled()
    expect(f.ports.sendDirect).toHaveBeenCalledTimes(1)
    expect(f.store.load()?.listing).toMatchObject({ selfPaid: true })
  })

  it('keeps a sponsor preflight failure unrequested and offers self-payment before any request escaped', async () => {
    const f = fixture([84532], 'sponsored')
    vi.mocked(f.ports.sponsor).mockRejectedValueOnce(new Error('Sponsor preflight unavailable'))
    await expect(f.controller.run()).rejects.toThrow('preflight unavailable')
    expect(f.store.load()?.listing.requested).toBeUndefined()
    await f.controller.selfPay()
    await f.controller.run()
    expect(f.ports.sponsor).toHaveBeenCalledTimes(1)
    expect(f.ports.sendDirect).toHaveBeenCalledTimes(1)
  })

  it('reverifies every chain before complete/clear and downgrades stale or reorged receipts', async () => {
    const f = fixture([84532, 11155420])
    f.store.save({ ...f.prepared, published: true, candidates: { 84532: [H1], 11155420: [H2] }, results: {
      84532: { hash: H1, token: address('8'), projectId: '10' }, 11155420: { hash: H2, token: address('8'), projectId: '11' },
    } })
    vi.mocked(f.ports.verifyDeployment).mockImplementation(async (_session, target, candidate) => target.chainId === 84532 ? { hash: candidate, token: address('8'), projectId: '10' } : null)
    const recovered = await f.controller.refresh()
    expect(Object.keys(recovered.results)).toEqual(['84532'])
    expect(launchComplete(recovered)).toBe(false)
    await expect(f.controller.clear()).rejects.toThrow('Recover')
    expect(f.store.load()).not.toBeNull()
  })

  it('stores added hashes as hints and clears only after fresh proof of all deployments', async () => {
    const f = fixture()
    await f.controller.run()
    vi.mocked(f.ports.verifyDeployment).mockImplementation(async (_session, _target, candidate) => candidate === H2 ? { hash: H2, token: address('8'), projectId: '10' } : null)
    const recovered = await f.controller.addHash(84532, H2)
    expect(recovered.candidates[84532]).toEqual([H1, H2])
    expect(launchComplete(recovered)).toBe(true)
    await f.controller.clear()
    expect(f.store.load()).toBeNull()
  })

  it('fails before external calls if saved intent cannot be durably written or the account changes', async () => {
    const f = fixture()
    const original = f.storage.setItem
    f.storage.setItem = () => { throw new Error('Storage blocked') }
    await expect(f.controller.run()).rejects.toThrow('Storage blocked')
    expect(f.ports.sendDirect).not.toHaveBeenCalled()
    f.storage.setItem = original
    vi.mocked(f.ports.guard).mockImplementation(() => { throw new Error('Wallet changed') })
    await expect(f.controller.run()).rejects.toThrow('Wallet changed')
    expect(f.ports.sendDirect).not.toHaveBeenCalled()
  })

  it('rejects corrupt calls, primitive fields and JSON without deleting their recovery evidence', () => {
    const f = fixture()
    for (const edit of [{ environment: 'unknown' }, { cashOutTaxRate: '1e3' }, { tokenDecimals: -1 }, { soulbound: 'false' }, { symbol: '' }]) {
      expect(() => validateStickyLaunch({ ...f.prepared, plan: { ...f.prepared.plan, ...edit } })).toThrow()
    }
    const corrupted = structuredClone(f.prepared)
    corrupted.plan.targets[0].call.data = `${corrupted.plan.targets[0].call.data}00`
    expect(() => validateStickyLaunch(corrupted)).toThrow()
    f.storage.setItem(STICKY_LAUNCH_KEY, '{bad JSON')
    expect(() => f.store.load()).toThrow()
    expect(f.storage.getItem(STICKY_LAUNCH_KEY)).toBe('{bad JSON')
  })

  it('refuses overlapping actions while the first wallet step is in flight', async () => {
    const f = fixture()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    vi.mocked(f.ports.review).mockImplementation(async () => pending)
    const running = f.controller.run()
    await expect(f.controller.run()).rejects.toThrow('already being processed')
    release()
    await running
    expect(f.ports.sendDirect).toHaveBeenCalledTimes(1)
  })

  it('retries only the known submission after failure proof and retains every attempt across reloads', async () => {
    const f = fixture()
    await f.controller.run()
    await f.controller.retry()
    expect(f.store.load()?.direct).toBeUndefined()
    expect(f.store.load()?.directAttempts).toEqual([{ started: true, hash: H1 }])
    expect(f.ports.requireRetry).toHaveBeenCalledWith(expect.objectContaining({ direct: { started: true, hash: H1 } }), 'direct', 'retry')
    vi.mocked(f.ports.sendDirect).mockImplementationOnce(async (_session, callbacks) => { await callbacks.beforeWrite(); callbacks.submitted(H2) })
    await createStickyLaunchController(f.ports).run()
    expect(f.ports.requireRetry).toHaveBeenCalledWith(expect.objectContaining({ directAttempts: [{ started: true, hash: H1 }] }), 'direct', 'retry')
    expect(f.store.load()).toMatchObject({ direct: { started: true, hash: H2 }, directAttempts: [{ started: true, hash: H1 }] })
    await f.controller.retry()
    expect(f.store.load()?.directAttempts).toEqual([{ started: true, hash: H1 }, { started: true, hash: H2 }])
  })

  it('never lets a manually added old same-call hash release an unknown wallet submission', async () => {
    const f = fixture()
    vi.mocked(f.ports.sendDirect).mockImplementationOnce(async (_session, callbacks) => { await callbacks.beforeWrite(); throw new Error('Unknown submission') })
    await expect(f.controller.run()).rejects.toThrow('Unknown submission')
    await f.controller.addHash(84532, H1)
    await expect(f.controller.retry()).rejects.toThrow('no recorded transaction hash')
    expect(f.ports.requireRetry).not.toHaveBeenCalled()
    expect(f.store.load()?.direct).toEqual({ started: true })
    expect(f.store.load()?.directAttempts).toBeUndefined()
  })

  it('keeps the original hash locked when finalized failure proof is unavailable or reorged', async () => {
    const f = fixture()
    await f.controller.run()
    vi.mocked(f.ports.requireRetry).mockRejectedValue(new Error('Finality unavailable'))
    await expect(f.controller.retry()).rejects.toThrow('Finality unavailable')
    expect(f.store.load()?.direct).toEqual({ started: true, hash: H1 })
    expect(f.store.load()?.directAttempts).toBeUndefined()
  })

  it('reproves historical attempts before the next wallet write and keeps them when that proof fails', async () => {
    const f = fixture()
    await f.controller.run()
    await f.controller.retry()
    const write = vi.fn()
    vi.mocked(f.ports.sendDirect).mockImplementationOnce(async (_session, callbacks) => { await callbacks.beforeWrite(); write(); callbacks.submitted(H2) })
    vi.mocked(f.ports.requireRetry).mockRejectedValueOnce(new Error('Earlier failure reorged'))
    await expect(f.controller.run()).rejects.toThrow('Earlier failure reorged')
    expect(write).not.toHaveBeenCalled()
    expect(f.store.load()?.direct).toBeUndefined()
    expect(f.store.load()?.directAttempts).toEqual([{ started: true, hash: H1 }])
  })

  it('keeps original quote and every old funding option when a finalized failed payment is retried', async () => {
    const f = fixture([84532, 11155420])
    const other = { ...quote.payment_info[0], chain: 11155420, amount: '99' }
    const multi = { ...quote, payment_info: [...quote.payment_info, other] }
    vi.mocked(f.ports.quote).mockImplementationOnce(async (_plan, _remember, beforePublish) => { beforePublish(); return multi })
    await f.controller.run()
    await f.controller.retry()
    vi.mocked(f.ports.choosePayment).mockResolvedValueOnce(other)
    vi.mocked(f.ports.sendPayment).mockImplementationOnce(async (_session, callbacks) => { await callbacks.beforeWrite(); callbacks.submitted(H1) })
    await createStickyLaunchController(f.ports).run()
    expect(f.store.load()?.paymentAttempts).toEqual([{ option: payment, started: true, hash: H2, confirmed: true }])
    expect(f.store.load()?.payment).toMatchObject({ option: other, started: true, hash: H1 })
    expect(f.ports.requireRetry).toHaveBeenLastCalledWith(expect.objectContaining({
      paymentAttempts: [{ option: payment, started: true, hash: H2, confirmed: true }], payment: { option: other, started: false },
    }), 'payment', 'retry')
    expect(f.ports.quote).toHaveBeenCalledTimes(1)
  })

  it('reproves archived failures before clearing, excluding a successful latest submission from retirement proof', async () => {
    const f = fixture()
    await f.controller.run()
    await f.controller.retry()
    vi.mocked(f.ports.requireRetry).mockRejectedValueOnce(new Error('History proof unavailable'))
    await expect(f.controller.clear()).rejects.toThrow('History proof unavailable')
    expect(f.store.load()?.directAttempts).toHaveLength(1)
    vi.mocked(f.ports.sendDirect).mockImplementationOnce(async (_session, callbacks) => { await callbacks.beforeWrite(); callbacks.submitted(H2) })
    await f.controller.run()
    vi.mocked(f.ports.verifyDeployment).mockImplementation(async (_session, _target, candidate) => candidate === H2 ? { hash: H2, token: address('8'), projectId: '10' } : null)
    await f.controller.clear()
    expect(f.ports.requireRetry).toHaveBeenLastCalledWith(expect.objectContaining({ direct: undefined, payment: undefined,
      directAttempts: [{ started: true, hash: H1 }] }), 'direct', 'retire')
    expect(f.store.load()).toBeNull()
  })

  it('refuses malformed retained histories rather than treating them as unsubmitted', () => {
    const f = fixture()
    for (const history of [[{ started: true }], [{ started: false, hash: H1 }], [{ started: true, hash: 'bad' }], {}]) {
      expect(() => validateStickyLaunch({ ...f.prepared, directAttempts: history })).toThrow()
    }
  })
})
