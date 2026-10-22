import { stickyDeployerAbi } from '@bananapus/nana-sdk-core'
import { JBCenterRequestError } from '@bananapus/nana-sdk-core/jbcenter'
import {
  RELAYR_NATIVE_TOKEN, RELAYR_PAYMENT_ADDRESS, RELAYR_PAYMENT_GAS,
  relayrBundleRequest, type RelayrQuote,
} from '@bananapus/nana-sdk-core/review/relayr'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchPlan } from '@/lib/sticky-launch-plan'
import type { StickyLaunchPorts, StickyLaunchSession } from '@/lib/sticky-launch-session'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { memoryStorage } from '../memory-storage'

const fake = vi.hoisted(() => ({
  account: { address: '' as Address, chainId: 8453, connector: { id: 'injected', uid: 'reviewed-wallet' } }, safe: false,
  ports: undefined as unknown as StickyLaunchPorts,
  revalidate: vi.fn(), review: vi.fn(), choose: vi.fn(), guard: vi.fn(),
  write: vi.fn(), send: vi.fn(), sign: vi.fn(), connected: vi.fn(), simulate: vi.fn(), estimate: vi.fn(),
  getCode: vi.fn(), receipt: vi.fn(), transaction: vi.fn(), head: vi.fn(), safeRunsCalls: vi.fn(),
  runtime: vi.fn(), simulatePayment: vi.fn(), verifyPayment: vi.fn(), safeProof: vi.fn(), resolveSafe: vi.fn(),
  verifyDeployment: vi.fn(), intent: vi.fn(), publish: vi.fn(), sponsor: vi.fn(), record: vi.fn(),
  failure: vi.fn(), callFailure: vi.fn(), retryPayment: vi.fn(),
}))

vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@wagmi/core', () => ({ getAccount: () => fake.account }))
vi.mock('@/lib/viewAs', () => ({ assertNoViewAs: fake.guard }))
vi.mock('@/lib/transaction-review', () => ({
  requireTransactionReview: fake.review, requireFundingChainSelection: fake.choose,
  fundingChainLabel: (chain: string, amount: bigint) => `${chain} ${amount}`,
}))
vi.mock('@/lib/wallet-core', async original => ({
  ...(await original<typeof import('@/lib/wallet-core')>()),
  publicClient: () => ({ simulateContract: fake.simulate, estimateContractGas: fake.estimate,
    getCode: fake.getCode, getTransactionReceipt: fake.receipt, waitForTransactionReceipt: fake.receipt, getTransaction: fake.transaction,
    getBlockNumber: fake.head, getTransactionCount: async () => 7, getChainId: async () => 8453,
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({ hash: `0x${'ed'.repeat(32)}`, number: blockNumber ?? 11n, timestamp: 1_900_000_000n }) }),
  connectedWallet: fake.connected,
}))
vi.mock('@/lib/safe-connector', () => ({
  isSafeConnection: () => fake.safe, readSafeAppExecution: fake.safeProof, waitForSafeExecutionHash: fake.resolveSafe,
}))
vi.mock('@bananapus/nana-sdk-core/safe-service', async original => ({
  ...(await original<typeof import('@bananapus/nana-sdk-core/safe-service')>()), safeExecutionRunsCalls: fake.safeRunsCalls,
}))
vi.mock('@/lib/sticky-launch-plan', async original => ({
  ...(await original<typeof import('@/lib/sticky-launch-plan')>()), revalidateStickyLaunch: fake.revalidate,
}))
vi.mock('@/lib/jbcenter-public-client', () => ({ jbCenterPublicClient: vi.fn() }))
vi.mock('@/lib/sticky-launch-proof', async original => ({
  ...(await original<typeof import('@/lib/sticky-launch-proof')>()), verifyStickyLaunchDeployment: fake.verifyDeployment,
  verifyFinalizedStickyLaunchFailure: fake.failure, verifyFinalizedStickyCallFailure: fake.callFailure,
}))
vi.mock('@/lib/sticky-launch-session', async original => {
  const actual = await original<typeof import('@/lib/sticky-launch-session')>()
  return { ...actual, createStickyLaunchController: (ports: StickyLaunchPorts) => {
    fake.ports = ports
    return actual.createStickyLaunchController(ports)
  } }
})
vi.mock('@/lib/sticky-listing', async original => ({
  ...(await original<typeof import('@/lib/sticky-listing')>()), publishStickyListing: fake.publish,
  createStickyCenterClient: () => ({ getIntent: fake.intent, requestDeploy: fake.sponsor, recordDeployment: fake.record }),
}))
vi.mock('@bananapus/nana-sdk-core/review/relayr', async original => ({
  ...(await original<typeof import('@bananapus/nana-sdk-core/review/relayr')>()),
  requireRelayrPaymentRuntime: fake.runtime, simulateRelayrPayment: fake.simulatePayment, verifyRelayrPayment: fake.verifyPayment,
  requireRelayrPaymentRetry: fake.retryPayment,
}))

import { createBrowserStickyLaunchController } from '@/lib/sticky-launch-adapter'
import { attempts } from '@/lib/write-holds'
import { createSavedAttemptRecovery, createWriteHold } from '@bananapus/nana-sdk-core/review'
import { browserWriteRecoveryModel } from '../support/write-recovery'
import { buildStickyEnvelope } from '@/lib/sticky-listing'

const OWNER = '0x1111111111111111111111111111111111111111' as Address
const TOKEN = '0x2222222222222222222222222222222222222222' as Address
const DEPLOYER = '0x3333333333333333333333333333333333333333' as Address
const ADAPTER = '0x4444444444444444444444444444444444444444' as Address
const HASH = `0x${'ab'.repeat(32)}` as Hex
const PROPOSAL = `0x${'cd'.repeat(32)}` as Hex
const BUNDLE = '01234567-89ab-cdef-0123-456789abcdef'
const IDS = ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002']
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

function plan(chainIds = [8453]): LaunchPlan {
  const projectUri = 'data:application/json;charset=utf-8,launch-test'
  return { id: 'launch-test', owner: OWNER, name: 'Sticky Test', symbol: 'STICKYTEST', token: TOKEN,
    tokenName: 'Test', tokenSymbol: 'TEST', tokenDecimals: 18, cashOutTaxRate: '500', soulbound: false,
    projectUri, environment: 'production', targets: chainIds.map(chainId => ({
      chainId, deployer: DEPLOYER, controller: DEPLOYER, projects: DEPLOYER,
      call: { chain: chainId, target: DEPLOYER, value: '2', data: encodeFunctionData({ abi: stickyDeployerAbi,
        functionName: 'deployStickyFor', args: [TOKEN, 'Sticky Test', 'STICKYTEST', projectUri, 500n, [ADAPTER], false] }) },
    })) }
}

function quoted(plan: LaunchPlan): RelayrQuote {
  const deadline = Math.floor(Date.now() / 1000) + 3_600
  const transactions = relayrBundleRequest(plan.targets.map(target => target.call)).transactions
  return { bundle_uuid: BUNDLE, payment_info: [{ chain: 8453, target: RELAYR_PAYMENT_ADDRESS,
    token: RELAYR_NATIVE_TOKEN, amount: '100', payment_deadline: deadline,
    calldata: encodeFunctionData({ abi: parseAbi(['function prepayment(bytes16 bundle, uint40 deadline) payable']),
      functionName: 'prepayment', args: [`0x${BUNDLE.replaceAll('-', '')}`, deadline] }) }],
    transactions: transactions.map((request, index) => ({ tx_uuid: IDS[index], request, status: { state: 'Pending' } })),
    expectedTransactions: transactions.map((entry, index) => ({ chain: entry.chain, entry, txUuid: IDS[index] })),
  }
}

function session(chains = [8453]): StickyLaunchSession {
  const prepared = plan(chains)
  return { version: 1, plan: prepared, mode: chains.length > 1 ? 'relayr' : 'direct', published: false,
    candidates: Object.fromEntries(chains.map(chain => [chain, []])), results: {},
    listing: { state: 'unavailable', recorded: {} } }
}

function paymentSession(chains = [8453]): StickyLaunchSession & { quote: RelayrQuote; payment: NonNullable<StickyLaunchSession['payment']> } {
  const saved = { ...session(chains), mode: 'relayr' as const }
  const quote = quoted(saved.plan)
  return { ...saved, quote, bundleUuid: BUNDLE, published: true, payment: { option: quote.payment_info[0], started: false } }
}

const callbacks = () => ({ beforeWrite: vi.fn(), rejected: vi.fn(), submitted: vi.fn() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const walletResult = () => ({ account: fake.account.address,
  wallet: { writeContract: fake.write, sendTransaction: fake.send, signMessage: fake.sign } })

let launch: ReturnType<typeof createBrowserStickyLaunchController>

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('localStorage', memoryStorage())
  fake.account = { address: OWNER, chainId: 8453, connector: { id: 'injected', uid: 'reviewed-wallet' } }
  fake.safe = false
  fake.revalidate.mockResolvedValue(undefined)
  fake.review.mockResolvedValue(undefined)
  fake.choose.mockResolvedValue(8453)
  fake.simulate.mockImplementation(async request => ({ request }))
  fake.estimate.mockResolvedValue(100_000n)
  fake.write.mockResolvedValue(HASH)
  fake.send.mockResolvedValue(HASH)
  fake.sign.mockResolvedValue('0x1234')
  fake.connected.mockImplementation(async (chainId: number) => { fake.account.chainId = chainId; return walletResult() })
  fake.receipt.mockResolvedValue({ transactionHash: HASH, blockNumber: 10n, status: 'success' })
  fake.transaction.mockResolvedValue({ hash: HASH })
  fake.safeRunsCalls.mockReturnValue(true)
  fake.head.mockResolvedValue(11n)
  fake.runtime.mockResolvedValue(undefined)
  fake.simulatePayment.mockResolvedValue(undefined)
  fake.verifyPayment.mockResolvedValue(undefined)
  fake.verifyDeployment.mockResolvedValue({ hash: HASH, projectId: '1', token: TOKEN })
  fake.failure.mockResolvedValue(true)
  fake.callFailure.mockResolvedValue(true)
  fake.retryPayment.mockResolvedValue(undefined)
  fake.safeProof.mockResolvedValue({ status: 'success' })
  fake.resolveSafe.mockResolvedValue(HASH)
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, run) => run({ name: 'sticky-launch-write' })) } })
  vi.mocked(fetch).mockImplementation(async () => json({ bundle_uuid: BUNDLE, payment_received: false, transactions: [
    { status: { state: 'Pending' } }, { status: { state: 'Pending' } },
  ] }))
  launch = createBrowserStickyLaunchController()
})

describe('Sticky launch browser boundaries', () => {
  it('enforces one home chain at every publication boundary', async () => {
    const multi = session([8453, 10])
    await expect(fake.ports.quote(multi.plan, vi.fn(), vi.fn())).rejects.toThrow('one home chain')
    await expect(fake.ports.publishListing(multi.plan)).rejects.toThrow('one home chain')
    await expect(fake.ports.sponsor(multi, vi.fn())).rejects.toThrow('one home chain')
    expect(fetch).not.toHaveBeenCalled()
    expect(fake.publish).not.toHaveBeenCalled()
    expect(fake.sponsor).not.toHaveBeenCalled()
  })

  it.each(['direct', 'payment'] as const)('enforces one home chain after awaited %s journaling and before the final wallet call', async kind => {
    const multi = session([8453, 10])
    const saved = kind === 'direct' ? session() : paymentSession()
    const noted = callbacks()
    noted.beforeWrite.mockImplementation(async () => { saved.plan.targets.push(multi.plan.targets[1]) })
    await expect(kind === 'direct' ? fake.ports.sendDirect(saved, noted) : fake.ports.sendPayment(saved, noted)).rejects.toThrow('one home chain')
    expect(fake.write).not.toHaveBeenCalled()
    expect(fake.send).not.toHaveBeenCalled()
    expect(noted.rejected).toHaveBeenCalledOnce()
  })

  it('checks one home chain after acquiring the listing signer', async () => {
    const prepared = plan()
    fake.publish.mockImplementation(async (_plan, sign) => { await sign('Exact SDK listing message'); return { id: 'listing' } })
    fake.connected.mockImplementation(async () => {
      prepared.targets.push(plan([10]).targets[0])
      return walletResult()
    })
    await expect(fake.ports.publishListing(prepared)).rejects.toThrow('one home chain')
    expect(fake.sign).not.toHaveBeenCalled()
  })

  it('refuses cross-tab contention and missing Web Locks before creating a recovery record', async () => {
    const controller = createBrowserStickyLaunchController()
    vi.stubGlobal('navigator', {})
    await expect(controller.prepare(plan(), 'unavailable')).rejects.toThrow('Web Locks')
    expect(controller.load()).toBeNull()
    vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, run) => run(null)) } })
    await expect(controller.prepare(plan(), 'unavailable')).rejects.toThrow('Another tab')
    expect(controller.load()).toBeNull()
  })

  it('wallet-action:create-a-sticky-token simulates the exact reviewed direct call and durably saves its hash before waiting for a receipt', async () => {
    const saved = session()
    const noted = callbacks()
    fake.receipt.mockImplementation(async () => {
      expect(noted.submitted).toHaveBeenCalledWith(HASH, undefined)
      return { transactionHash: HASH, blockNumber: 10n, status: 'success' }
    })
    await fake.ports.sendDirect(saved, noted)
    expect(fake.review).toHaveBeenCalledWith(expect.objectContaining({ calls: [expect.objectContaining({
      data: saved.plan.targets[0].call.data, from: OWNER, to: DEPLOYER, value: 2n,
    })] }))
    expect(fake.write).toHaveBeenCalledWith(expect.objectContaining({ account: OWNER, functionName: 'deployStickyFor', value: 2n }))
    expect(fake.write.mock.calls[0][0].args).toEqual(fake.simulate.mock.calls.at(-1)![0].args)
    expect(noted.beforeWrite).toHaveBeenCalledOnce()
    expect(noted.rejected).not.toHaveBeenCalled()
  })

  it.each(['account', 'view-as', 'external-wallet'] as const)('rechecks %s after asynchronous simulation before the wallet opens', async kind => {
    const noted = callbacks()
    fake.simulate.mockImplementation(async request => {
      if (!request.stateOverride) {
        if (kind === 'account') fake.account.address = TOKEN
        if (kind === 'view-as') fake.guard.mockImplementation(() => { throw new Error('Exit View as') })
        if (kind === 'external-wallet') fake.account.connector.id = 'juicebox-center'
      }
      return { request }
    })
    await expect(fake.ports.sendDirect(session(), noted)).rejects.toThrow()
    expect(fake.write).not.toHaveBeenCalled()
    expect(noted.beforeWrite).not.toHaveBeenCalled()
  })

  it.each(['direct', 'payment'] as const)('refuses a changed chain after the %s journal saves and clears only that unsent reservation', async kind => {
    const noted = callbacks()
    noted.beforeWrite.mockImplementation(async () => { fake.account.chainId = 10 })
    await expect(kind === 'direct' ? fake.ports.sendDirect(session(), noted) : fake.ports.sendPayment(paymentSession(), noted)).rejects.toThrow('connection changed')
    expect(noted.beforeWrite).toHaveBeenCalledOnce()
    expect(noted.rejected).toHaveBeenCalledOnce()
    expect(fake.write).not.toHaveBeenCalled()
    expect(fake.send).not.toHaveBeenCalled()
  })

  it.each(['direct', 'payment'] as const)('explicitly binds the %s wallet request to the reviewed supported chain', async kind => {
    const noted = callbacks()
    await (kind === 'direct' ? fake.ports.sendDirect(session(), noted) : fake.ports.sendPayment(paymentSession(), noted))
    const writer = kind === 'direct' ? fake.write : fake.send
    expect(writer).toHaveBeenCalledOnce()
    expect(writer.mock.calls[0][0].chain).toBe(SUPPORTED_CHAINS.find(chain => chain.id === 8453))
  })

  it.each(['expiry', 'quote', 'option'] as const)('rechecks funding %s after the last awaited journal callback before opening the wallet', async changed => {
    const saved = paymentSession()
    const noted = callbacks()
    const waiting = deferred(), release = deferred()
    noted.beforeWrite.mockImplementation(async () => { waiting.resolve(); await release.promise })
    const pending = fake.ports.sendPayment(saved, noted)
    await waiting.promise
    if (changed === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(Number(saved.payment.option.payment_deadline) * 1000)
    if (changed === 'quote') saved.quote.expectedTransactions[0].entry.value = '3'
    if (changed === 'option') saved.payment.option.amount = '101'
    const refused = expect(pending).rejects.toThrow()
    release.resolve()
    await refused
    expect(noted.beforeWrite).toHaveBeenCalledOnce()
    expect(noted.rejected).toHaveBeenCalledOnce()
    expect(noted.submitted).not.toHaveBeenCalled()
    expect(fake.send).not.toHaveBeenCalled()
  })

  it.each([
    ['direct', false], ['payment', false], ['direct', true], ['payment', true],
  ] as const)('refuses same-account/chain/type connector replacement during the final %s journal await (Safe=%s)', async (kind, viaSafe) => {
    fake.safe = viaSafe
    fake.account.connector.id = viaSafe ? 'safe' : 'injected'
    const noted = callbacks()
    const waiting = deferred(), release = deferred()
    noted.beforeWrite.mockImplementation(async () => { waiting.resolve(); await release.promise })
    const pending = kind === 'direct' ? fake.ports.sendDirect(session(), noted) : fake.ports.sendPayment(paymentSession(), noted)
    await waiting.promise
    fake.account.connector = { ...fake.account.connector, uid: 'replacement-wallet' }
    const refused = expect(pending).rejects.toThrow('connection changed')
    release.resolve()
    await refused
    expect(noted.beforeWrite).toHaveBeenCalledOnce()
    expect(noted.rejected).toHaveBeenCalledOnce()
    expect(noted.submitted).not.toHaveBeenCalled()
    expect(fake.write).not.toHaveBeenCalled()
    expect(fake.send).not.toHaveBeenCalled()
  })

  it.each(['Safe', 'view-as', 'external-wallet'] as const)('rechecks %s immediately after the journal awaits', async kind => {
    const noted = callbacks()
    noted.beforeWrite.mockImplementation(async () => {
      if (kind === 'Safe') fake.safe = true
      if (kind === 'view-as') fake.guard.mockImplementation(() => { throw new Error('Exit View as') })
      if (kind === 'external-wallet') fake.account.connector.id = 'juicebox-center'
    })
    await expect(fake.ports.sendDirect(session(), noted)).rejects.toThrow()
    expect(noted.beforeWrite).toHaveBeenCalledOnce()
    expect(noted.rejected).toHaveBeenCalledOnce()
    expect(fake.write).not.toHaveBeenCalled()
  })

  it('clears an explicit wallet rejection but retains an unknown no-hash submission', async () => {
    const rejected = callbacks()
    fake.write.mockRejectedValueOnce({ code: 4001 })
    await expect(fake.ports.sendDirect(session(), rejected)).rejects.toMatchObject({ code: 4001 })
    expect(rejected.rejected).toHaveBeenCalledOnce()
    const unknown = callbacks()
    fake.write.mockRejectedValueOnce(new Error('wallet transport timeout'))
    await expect(fake.ports.sendDirect(session(), unknown)).rejects.toThrow('timeout')
    expect(unknown.beforeWrite).toHaveBeenCalledOnce()
    expect(unknown.rejected).not.toHaveBeenCalled()
  })

  describe.each(['direct', 'payment'] as const)('the SDK recovery of a %s launch write', kind => {
    const send = (noted: ReturnType<typeof callbacks>) => kind === 'direct' ? fake.ports.sendDirect(session(), noted) : fake.ports.sendPayment(paymentSession(), noted)
    const saved = (fields: Partial<NonNullable<StickyLaunchSession['direct']>> = {}) => {
      const base = kind === 'direct' ? session() : paymentSession()
      return { ...base, [kind]: { ...base[kind], started: true, ...fields } } as StickyLaunchSession
    }
    const wallet = () => kind === 'direct' ? fake.write : fake.send
    const recover = (journal: StickyLaunchSession) => {
      const found = launch.attempt(journal)!
      return attempts.recover(found.attempt, found.client)
    }

    it('refuses a second send while a lost-reply submission stands, and sends exactly once more after its exit', async () => {
      wallet().mockRejectedValueOnce(new Error('wallet transport timeout'))
      await expect(send(callbacks())).rejects.toThrow('timeout')
      const again = callbacks()
      await expect(send(again)).rejects.toMatchObject({ name: 'WriteHeldError' })
      expect(wallet()).toHaveBeenCalledOnce()
      // The SDK reserves before the journal records anything: a refused send records nothing.
      expect(again.beforeWrite).not.toHaveBeenCalled()

      const outcome = await recover(saved())
      if (outcome.status !== 'held') throw new Error(`expected held, got ${outcome.status}`)
      expect(outcome.state.exit).toBe(true)
      const found = launch.attempt(saved())!
      await expect(outcome.handle.exit(outcome.state, { checkedWallet: true }, found.client)).resolves.toMatchObject({ released: true })
      await expect(attempts.retire(found.attempt, { by: 'exit' })).resolves.toMatchObject({ retired: true })
      await send(callbacks())
      expect(wallet()).toHaveBeenCalledTimes(2)
    })

    it('brings a started submission with no SDK record (saved by the last deploy) to the one explicit check', async () => {
      await expect(recover(saved())).resolves.toMatchObject({ status: 'check' })
    })

    it('reports the settlement of a confirmed launch write as done, authenticated by the launch', async () => {
      const call = kind === 'direct' ? { to: DEPLOYER, data: session().plan.targets[0].call.data, value: 2n }
        : { to: paymentSession().payment.option.target as Address, data: paymentSession().payment.option.calldata as Hex, value: BigInt(paymentSession().payment.option.amount) }
      const placed = { blockHash: `0x${'ed'.repeat(32)}` as Hex, blockNumber: 10n, transactionIndex: 0 }
      fake.receipt.mockResolvedValue({ status: 'success', transactionHash: HASH, from: OWNER, to: call.to, logs: [], ...placed })
      fake.transaction.mockResolvedValue({ hash: HASH, from: OWNER, to: call.to, input: call.data, value: call.value, nonce: 7, ...placed })
      await send(callbacks())
      await expect(recover(saved({ hash: HASH }))).resolves.toMatchObject({ status: 'done', result: 'success', authenticated: true, hash: HASH })
    })

    it('lets a launch that confirmed while it ran be finished: the hold settles from the chain before it is discarded', async () => {
      const call = kind === 'direct' ? { to: DEPLOYER, data: session().plan.targets[0].call.data, value: 2n }
        : { to: paymentSession().payment.option.target as Address, data: paymentSession().payment.option.calldata as Hex, value: BigInt(paymentSession().payment.option.amount) }
      const placed = { blockHash: `0x${'ed'.repeat(32)}` as Hex, blockNumber: 10n, transactionIndex: 0 }
      fake.receipt.mockResolvedValue({ status: 'success', transactionHash: HASH, from: OWNER, to: call.to, logs: [], ...placed })
      fake.transaction.mockResolvedValue({ hash: HASH, from: OWNER, to: call.to, input: call.data, value: call.value, nonce: 7, ...placed })
      await send(callbacks())
      const done = { ...saved({ hash: HASH }), results: { 8453: { hash: HASH, projectId: '1', token: TOKEN } } } as StickyLaunchSession
      await expect(fake.ports.canDiscard(done)).resolves.toBe(true)
    })

    it('needs no mined-failure proof for an attempt the user exited', async () => {
      const base = kind === 'direct' ? session() : paymentSession()
      const attempt = { started: true, hash: HASH, exited: true }
      const exited = { ...base, [kind === 'direct' ? 'directAttempts' : 'paymentAttempts']: [kind === 'direct' ? attempt : { ...attempt, option: (base as ReturnType<typeof paymentSession>).payment.option }] } as StickyLaunchSession
      fake.failure.mockResolvedValue(false)
      fake.callFailure.mockResolvedValue(false)
      await expect(fake.ports.requireRetry(exited, kind, 'retry')).resolves.toBeUndefined()
      expect(fake.failure).not.toHaveBeenCalled()
      expect(fake.callFailure).not.toHaveBeenCalled()
    })

    it('is the explicit check, never absent, when the saved transaction does not match the call (adoption refused)', async () => {
      fake.transaction.mockResolvedValue({ hash: HASH, from: OWNER, to: OWNER, input: '0xdeadbeef', value: 0n, nonce: 7, blockHash: `0x${'ed'.repeat(32)}`, blockNumber: 10n, transactionIndex: 0 })
      fake.verifyDeployment.mockResolvedValue(null)
      fake.verifyPayment.mockRejectedValue(new Error('not this payment'))
      const outcome = await recover(saved({ hash: HASH }))
      expect(outcome).toMatchObject({ status: 'check' })
      if (outcome.status !== 'check') return
      // The user's explicit check retires it for every tab and reload.
      await expect(attempts.retire(launch.attempt(saved({ hash: HASH }))!.attempt, { by: 'check', outcome })).resolves.toMatchObject({ retired: true })
      await expect(recover(saved({ hash: HASH }))).resolves.toMatchObject({ status: 'none', retired: 'check' })
    })

    it('retires an attempt the wallet explicitly rejected, and sends again', async () => {
      wallet().mockRejectedValueOnce({ code: 4001 })
      await expect(send(callbacks())).rejects.toMatchObject({ code: 4001 })
      await expect(recover(saved())).resolves.toMatchObject({ status: 'none', retired: 'rejected' })
      await send(callbacks())
      expect(wallet()).toHaveBeenCalledTimes(2)
    })
  })

  describe('two tabs on one saved launch', () => {
    /** Another tab: its own SDK controller and recovery, over the same storage and the same cross-tab locks. */
    function otherTab() {
      const hold = createWriteHold()
      return { hold, recovery: createSavedAttemptRecovery({ hold }) }
    }
    const started = (fields: Partial<NonNullable<StickyLaunchSession['direct']>> = {}) => ({ ...session(), direct: { started: true, ...fields } }) as StickyLaunchSession

    beforeEach(() => { vi.stubGlobal('navigator', { locks: browserWriteRecoveryModel().locks }) })

    it('closes the launch-send race: while one tab is in the wallet, the other recovers it as held and can send nothing', async () => {
      const wallet = Promise.withResolvers<Hex>()
      fake.write.mockReturnValueOnce(wallet.promise)
      const first = send(callbacks())
      await vi.waitFor(() => expect(fake.write).toHaveBeenCalledOnce())

      const tab = otherTab()
      const found = launch.attempt(started())!
      const outcome = await tab.recovery.recover(found.attempt, found.client)
      expect(outcome.status).toBe('held')
      // Its own send of the same launch is refused before any wallet opens.
      const again = tab.hold.open({ chainId: found.attempt.chainId, account: found.attempt.account, safe: false, namespace: found.attempt.namespaces[0], call: found.attempt.call! })
      await expect(again.send(found.client, async () => { await fake.write(); return HASH })).rejects.toMatchObject({ name: expect.stringMatching(/^WriteHold(Busy)?Error$|^WriteHeldError$/) })

      wallet.resolve(HASH)
      await first
      await expect(tab.recovery.recover(found.attempt, found.client)).resolves.toMatchObject({ status: 'held' })
      expect(fake.write).toHaveBeenCalledOnce()
    })

    it('reserves before the journal records the start: a tab that reads the started journal finds it held, and its check can never be offered', async () => {
      // The journal write is where the other tab looks; while it runs, the SDK already holds the launch.
      const journaled = Promise.withResolvers<void>()
      const recording = Promise.withResolvers<void>()
      const noted = callbacks()
      noted.beforeWrite.mockImplementation(async () => { recording.resolve(); await journaled.promise })
      const first = send(noted)
      await recording.promise

      const tab = otherTab()
      const found = launch.attempt(started())!
      await expect(tab.recovery.recover(found.attempt, found.client)).resolves.toMatchObject({ status: 'held' })
      journaled.resolve()
      await first
      expect(fake.write).toHaveBeenCalledOnce()
    })

    it('refuses a check another tab showed before this tab reserved: the stale check retires nothing', async () => {
      const tab = otherTab()
      const found = launch.attempt(started())!
      // A journal from the last deploy: started, nothing held. The other tab shows its explicit check.
      const shown = await tab.recovery.recover(found.attempt, found.client)
      if (shown.status !== 'check') throw new Error(`expected check, got ${shown.status}`)

      const wallet = Promise.withResolvers<Hex>()
      fake.write.mockReturnValueOnce(wallet.promise)
      const first = send(callbacks())
      await vi.waitFor(() => expect(fake.write).toHaveBeenCalledOnce())
      await expect(tab.recovery.retire(found.attempt, { by: 'check', outcome: shown })).resolves.toMatchObject({ retired: false })
      wallet.resolve(HASH)
      await first
      await expect(tab.recovery.recover(found.attempt, found.client)).resolves.toMatchObject({ status: 'held' })
      expect(fake.write).toHaveBeenCalledOnce()
    })

    const send = (noted: ReturnType<typeof callbacks>) => fake.ports.sendDirect(session(), noted)
  })

  it('saves a Safe proposal separately and abort-bounds resolution before checking its execution receipt', async () => {
    fake.safe = true
    fake.write.mockResolvedValue(PROPOSAL)
    const noted = callbacks()
    await fake.ports.sendDirect(session(), noted)
    expect(noted.submitted.mock.calls).toEqual([[PROPOSAL, PROPOSAL], [HASH, PROPOSAL]])
    expect(fake.resolveSafe).toHaveBeenCalledWith(8453, PROPOSAL, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(fake.receipt).toHaveBeenCalledWith(expect.objectContaining({ hash: HASH }))
    // The SDK hold may probe the proposal hash as an at-once execution; the app never waits on it as a receipt.
    expect(fake.receipt).not.toHaveBeenCalledWith(expect.objectContaining({ hash: PROPOSAL, timeout: expect.anything() }))
    expect(fake.write.mock.calls[0][0].gas).toBe(0n)
  })

  it.each(['self-paid', 'sponsored'] as const)('one %s launch press opens one decoded review: listing and creation follow it without another', async capability => {
    const controller = createBrowserStickyLaunchController()
    fake.publish.mockImplementation(async (_plan, sign) => { await sign('Exact SDK listing message'); return { id: 'listing' } })
    fake.intent.mockResolvedValue({ id: 'listing', publisher: OWNER, envelope: buildStickyEnvelope(plan()), deployments: [], deploys: [] })
    fake.receipt.mockResolvedValue({ transactionHash: HASH, blockNumber: 10n, status: 'success' })
    await controller.prepare(plan(), capability)
    await controller.run()
    expect(fake.review).toHaveBeenCalledOnce()
    expect(fake.review.mock.calls[0][0]).toMatchObject({ title: 'Review Sticky launch' })
    expect(fake.sign).toHaveBeenCalledOnce()
    if (capability === 'self-paid') expect(fake.write).toHaveBeenCalledOnce()
    else expect(fake.sponsor).toHaveBeenCalledOnce()
  })

  it('a listing signs the plan its approval was taken from, whatever the caller\'s copy becomes', async () => {
    const shown = plan()
    const approval = await fake.ports.review(shown, false)
    fake.review.mockClear()
    let published: LaunchPlan | undefined
    fake.publish.mockImplementation(async (listed: LaunchPlan, sign) => {
      published = listed
      shown.cashOutTaxRate = '900'
      await sign('Exact SDK listing message')
      return { id: 'listing' }
    })
    await fake.ports.publishListing(shown, approval)
    expect(fake.review).not.toHaveBeenCalled()
    expect(published).not.toBe(shown)
    expect(published?.cashOutTaxRate).toBe('500')
  })

  it('the one review of a Safe launch shows the Safe execution gas the wallet will run', async () => {
    fake.safe = true
    const controller = createBrowserStickyLaunchController()
    await controller.prepare(plan(), 'unavailable')
    await controller.run().catch(() => {})
    expect(fake.review).toHaveBeenCalledOnce()
    expect(fake.review.mock.calls[0][0].calls).toEqual([expect.objectContaining({ safeTxGas: 0n })])
  })

  it.each(['plan', 'wallet'] as const)('a launch whose %s changes during its review is refused before listing or creation', async change => {
    const controller = createBrowserStickyLaunchController()
    const shown = plan()
    fake.review.mockImplementationOnce(async () => {
      if (change === 'plan') shown.cashOutTaxRate = '900'
      else fake.account.connector = { ...fake.account.connector, uid: 'replacement-wallet' }
    })
    await expect(fake.ports.review(shown, false)).rejects.toThrow(change === 'plan' ? /saved launch call differs|changed during its review/ : 'changed during its review')
    expect(controller.load()).toBeNull()
  })

  it('a listing or creation without the reviewed launch\'s calls is reviewed on its own', async () => {
    fake.publish.mockImplementation(async (_plan, sign) => { await sign('Exact SDK listing message'); return { id: 'listing' } })
    fake.receipt.mockResolvedValue({ transactionHash: HASH, blockNumber: 10n, status: 'success' })
    await fake.ports.publishListing(plan(), 'another launch')
    await fake.ports.sendDirect(session(), callbacks(), 'another launch')
    expect(fake.review.mock.calls.map(([request]) => request.title)).toEqual(['Publish Sticky listing', 'Review Sticky creation'])
  })

  it('remembers a published bundle UUID even when its exact quote binding fails', async () => {
    const remember = vi.fn()
    vi.mocked(fetch).mockResolvedValueOnce(json({ bundle_uuid: BUNDLE, tx_uuids: [], payment_info: [] }))
    await expect(fake.ports.quote(plan(), remember, () => {})).rejects.toThrow('bind')
    expect(remember).toHaveBeenCalledWith(BUNDLE)
    const sent = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(sent.virtual_nonce_mode).toBe('ChainIndependent')
    expect(sent.transactions.map((entry: { virtual_nonce: number }) => entry.virtual_nonce)).toEqual([0])
  })

  it('keeps a raw launch published when quote transport fails, and never posts it again on resume', async () => {
    const controller = createBrowserStickyLaunchController()
    const saved = await controller.prepare(plan(), 'unavailable')
    fake.ports.store.save({ ...saved, mode: 'relayr' })
    vi.mocked(fetch).mockRejectedValueOnce(new Error('POST timed out'))
    await expect(controller.run()).rejects.toThrow('timed out')
    expect(controller.load()?.published).toBe(true)
    await expect(controller.run()).rejects.toThrow('already be published')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps an unpublished draft retryable when preflight fails before publication, and refuses POST if saving fails', async () => {
    const controller = createBrowserStickyLaunchController()
    const saved = await controller.prepare(plan(), 'unavailable')
    fake.ports.store.save({ ...saved, mode: 'relayr' })
    fake.revalidate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('runtime unavailable'))
    await expect(controller.run()).rejects.toThrow('runtime unavailable')
    expect(controller.load()?.published).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
    await expect(fake.ports.quote(plan(), vi.fn(), () => { throw new Error('storage full') })).rejects.toThrow('storage full')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains a confirmed destination candidate while another exact bound record remains pending', async () => {
    const saved = paymentSession([8453, 10])
    saved.quote.transactions[0].status = { state: 'Completed', data: { hash: HASH } }
    vi.mocked(fetch).mockImplementation(async () => json({ bundle_uuid: BUNDLE, transactions: saved.quote.transactions }))
    await expect(fake.ports.status(saved)).resolves.toEqual({ 8453: [HASH], 10: [] })
    saved.quote.transactions[0].request = { ...saved.quote.transactions[0].request!, data: '0x1234' }
    vi.mocked(fetch).mockImplementation(async () => json({ bundle_uuid: BUNDLE, transactions: saved.quote.transactions }))
    await expect(fake.ports.status(saved)).rejects.toThrow('does not match')
  })

  it('offers the exact available funding choices and rejects a saved quote rebound to another call', async () => {
    const saved = paymentSession()
    await expect(fake.ports.choosePayment(saved)).resolves.toEqual(saved.quote.payment_info[0])
    expect(fake.choose).toHaveBeenCalledWith([{ chainId: 8453, label: 'Base 100' }])
    saved.quote.expectedTransactions[0].entry.value = '3'
    await expect(fake.ports.choosePayment(saved)).rejects.toThrow('differs')
  })

  it('does not accept one destination hash for multiple launch calls', async () => {
    const saved = paymentSession([8453, 10])
    saved.quote.transactions.forEach(record => { record.status = { state: 'Completed', data: { hash: HASH } } })
    vi.mocked(fetch).mockImplementation(async () => json({ bundle_uuid: BUNDLE, transactions: saved.quote.transactions }))
    await expect(fake.ports.status(saved)).rejects.toThrow()
  })

  it('refuses an expired payment option before review or wallet submission', async () => {
    const saved = paymentSession()
    saved.payment.option = { ...saved.payment.option, payment_deadline: 1,
      calldata: encodeFunctionData({ abi: parseAbi(['function prepayment(bytes16 bundle, uint40 deadline) payable']),
        functionName: 'prepayment', args: [`0x${BUNDLE.replaceAll('-', '')}`, 1] }) }
    await expect(fake.ports.sendPayment(saved, callbacks())).rejects.toThrow()
    expect(fake.review).not.toHaveBeenCalled()
    expect(fake.send).not.toHaveBeenCalled()
  })

  it('wallet-action:pay-for-a-multichain-sticky-launch checks unpaid status, contract runtime and exact simulation, then proves payment with getCode available', async () => {
    const noted = callbacks()
    await fake.ports.sendPayment(paymentSession(), noted)
    expect(fake.runtime).toHaveBeenCalledWith(expect.objectContaining({ getCode: fake.getCode }))
    expect(fake.simulatePayment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ from: OWNER,
      payment: expect.objectContaining({ target: RELAYR_PAYMENT_ADDRESS, amount: 100n }) }))
    expect(fake.send).toHaveBeenCalledWith(expect.objectContaining({ account: OWNER, to: RELAYR_PAYMENT_ADDRESS, value: 100n, gas: RELAYR_PAYMENT_GAS }))
    expect(fake.verifyPayment).toHaveBeenCalledWith(expect.objectContaining({ getCode: fake.getCode }), expect.objectContaining({ hash: HASH, from: OWNER }))
    expect(noted.submitted).toHaveBeenCalledWith(HASH, undefined)
  })

  it.each(['funded', 'runtime', 'journal'] as const)('does not send a payment after the %s boundary refuses it', async kind => {
    const noted = callbacks()
    if (kind === 'funded') vi.mocked(fetch).mockResolvedValue(json({ bundle_uuid: BUNDLE, payment_received: true, transactions: [] }))
    if (kind === 'runtime') fake.runtime.mockRejectedValue(new Error('wrong runtime'))
    if (kind === 'journal') noted.beforeWrite.mockImplementation(async () => { throw new Error('storage unavailable') })
    await expect(fake.ports.sendPayment(paymentSession(), noted)).rejects.toThrow()
    expect(fake.send).not.toHaveBeenCalled()
    if (kind === 'journal') expect(noted.beforeWrite).toHaveBeenCalledOnce()
  })

  it('wallet-action:authorize-sticky-listing checks the signing account before and after the exact SDK message', async () => {
    fake.publish.mockImplementation(async (_plan, sign) => { await sign('Exact SDK listing message'); return { id: 'listing' } })
    await expect(fake.ports.publishListing(plan())).resolves.toBe('listing')
    expect(fake.review).toHaveBeenCalledWith(expect.objectContaining({ kind: 'authorization', title: 'Publish Sticky listing',
      calls: [expect.objectContaining({ from: OWNER, to: DEPLOYER, data: plan().targets[0].call.data })] }))
    expect(fake.sign).toHaveBeenCalledWith({ account: OWNER, message: 'Exact SDK listing message' })
    expect(fake.revalidate).not.toHaveBeenCalled()
    fake.sign.mockImplementation(async () => { fake.account.address = TOKEN; return '0x1234' })
    await expect(fake.ports.publishListing(plan())).rejects.toThrow('connection changed')
    fake.sign.mockClear()
    await expect(fake.ports.publishListing(plan())).rejects.toThrow('wallet that prepared')
    expect(fake.sign).not.toHaveBeenCalled()
  })

  it.each(['review', 'wallet', 'signature'] as const)('keeps listing authorization bound to its connector across the deferred %s step', async stage => {
    const waiting = deferred(), release = deferred()
    const published = vi.fn()
    fake.publish.mockImplementation(async (_plan, sign) => { await sign('Exact SDK listing message'); published(); return { id: 'listing' } })
    if (stage === 'review') fake.review.mockImplementation(async () => { waiting.resolve(); await release.promise })
    if (stage === 'wallet') fake.connected.mockImplementation(async () => { waiting.resolve(); await release.promise; return walletResult() })
    if (stage === 'signature') fake.sign.mockImplementation(async () => { waiting.resolve(); await release.promise; return '0x1234' })
    const pending = fake.ports.publishListing(plan())
    await waiting.promise
    fake.account.connector = { ...fake.account.connector, uid: 'replacement-wallet' }
    const refused = expect(pending).rejects.toThrow('connection changed')
    release.resolve()
    await refused
    if (stage === 'signature') expect(fake.sign).toHaveBeenCalledOnce()
    else expect(fake.sign).not.toHaveBeenCalled()
    expect(published).not.toHaveBeenCalled()
  })

  it('reserves a sponsor request only after exact listing and launch checks, and before it reaches Center', async () => {
    const saved = session()
    saved.listing = { state: 'published', intentId: 'listing', recorded: {} }
    fake.intent.mockResolvedValue({ id: 'listing', publisher: OWNER, envelope: buildStickyEnvelope(saved.plan), deployments: [], deploys: [] })
    const reserve = vi.fn()
    fake.sponsor.mockImplementation(async () => { expect(reserve).toHaveBeenCalledOnce() })
    await fake.ports.sponsor(saved, reserve)
    expect(fake.sponsor).toHaveBeenCalledWith('listing', { chainIds: [8453] })
    fake.sponsor.mockClear()
    reserve.mockClear()
    fake.intent.mockResolvedValue({ id: 'listing', publisher: TOKEN, envelope: buildStickyEnvelope(saved.plan), deployments: [], deploys: [] })
    await expect(fake.ports.sponsor(saved, reserve)).rejects.toThrow('differs')
    expect(reserve).not.toHaveBeenCalled()
    expect(fake.sponsor).not.toHaveBeenCalled()
  })

  it('requires exact Safe execution proof before confirming a wrapped payment', async () => {
    const saved = paymentSession()
    saved.payment = { ...saved.payment, started: true, hash: PROPOSAL, proposalHash: PROPOSAL }
    fake.safeProof.mockResolvedValue({ status: 'unproven' })
    await expect(fake.ports.verifyPayment(saved)).resolves.toBe(false)
    expect(fake.verifyPayment).not.toHaveBeenCalled()
    fake.safeProof.mockResolvedValue({ status: 'success' })
    await expect(fake.ports.verifyPayment(saved)).resolves.toBe(true)
    expect(fake.safeProof).toHaveBeenCalledWith(expect.objectContaining({ safe: OWNER, proposalHash: PROPOSAL,
      calls: [{ to: RELAYR_PAYMENT_ADDRESS, data: saved.payment.option.calldata, value: '100' }] }))
    expect(fake.verifyPayment).toHaveBeenCalledWith(expect.objectContaining({ getCode: fake.getCode }), expect.objectContaining({ hash: HASH }))
    expect(fake.safeRunsCalls).toHaveBeenCalledWith({ hash: HASH }, OWNER,
      [{ to: RELAYR_PAYMENT_ADDRESS, data: saved.payment.option.calldata, value: '100' }])
    fake.verifyPayment.mockClear()
    fake.safeProof.mockClear()
    fake.safeRunsCalls.mockReturnValueOnce(false)
    await expect(fake.ports.verifyPayment(saved)).resolves.toBe(false)
    expect(fake.safeProof).not.toHaveBeenCalled()
    expect(fake.verifyPayment).not.toHaveBeenCalled()
  })

  it('records only independently proven deployments with two confirmations, and treats only 422 as pending', async () => {
    const saved = session()
    saved.listing = { state: 'published', intentId: 'listing', recorded: {} }
    const result = { hash: HASH, projectId: '1', token: TOKEN }
    fake.head.mockResolvedValueOnce(10n)
    await expect(fake.ports.record(saved, 8453, result)).resolves.toBe(false)
    expect(fake.record).not.toHaveBeenCalled()
    fake.record.mockRejectedValueOnce(new JBCenterRequestError('confirmations', 422))
    await expect(fake.ports.record(saved, 8453, result)).resolves.toBe(false)
    fake.record.mockRejectedValueOnce(new JBCenterRequestError('unavailable', 503))
    await expect(fake.ports.record(saved, 8453, result)).rejects.toThrow('unavailable')
    fake.record.mockResolvedValue({ chainId: 8453, projectId: '1', transactionHash: HASH })
    await expect(fake.ports.record(saved, 8453, result)).resolves.toBe(true)
    fake.record.mockClear()
    fake.verifyDeployment.mockResolvedValue({ ...result, projectId: '2' })
    await expect(fake.ports.record(saved, 8453, result)).resolves.toBe(false)
    expect(fake.record).not.toHaveBeenCalled()
  })

  it('refuses a retry without a recorded submission and retains a no-hash attempt despite unrelated candidates', async () => {
    const saved = session()
    await expect(fake.ports.requireRetry(saved, 'direct', 'retry')).rejects.toThrow('previous submission')
    saved.direct = { started: true }
    saved.candidates[8453] = [HASH]
    await expect(fake.ports.requireRetry(saved, 'direct', 'retry')).rejects.toThrow('previous submission')
    expect(fake.failure).not.toHaveBeenCalled()
    expect(fake.resolveSafe).not.toHaveBeenCalled()
  })

  it('reproves every archived and current direct failure without changing their recovery identities', async () => {
    const saved = session()
    saved.directAttempts = [{ started: true, hash: HASH }]
    saved.direct = { started: true, hash: PROPOSAL }
    const original = JSON.stringify(saved)
    await fake.ports.requireRetry(saved, 'direct', 'retry')
    expect(fake.failure.mock.calls.map(call => call[2])).toEqual([...saved.directAttempts, saved.direct])
    expect(JSON.stringify(saved)).toBe(original)
    fake.failure.mockClear()
    fake.failure.mockResolvedValueOnce(false)
    await expect(fake.ports.requireRetry(saved, 'direct', 'retire')).rejects.toThrow('finalized')
    expect(fake.failure).toHaveBeenCalledOnce()
    expect(JSON.stringify(saved)).toBe(original)
  })

  it('resolves only the recorded Safe proposal before proving its finalized failed execution', async () => {
    const saved = session()
    saved.direct = { started: true, hash: PROPOSAL, proposalHash: PROPOSAL }
    await fake.ports.requireRetry(saved, 'direct', 'retry')
    expect(fake.resolveSafe).toHaveBeenCalledWith(8453, PROPOSAL, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(fake.failure).toHaveBeenCalledWith(saved, saved.plan.targets[0], { started: true, hash: HASH, proposalHash: PROPOSAL }, expect.anything())
    expect(saved.direct.hash).toBe(PROPOSAL)
    fake.resolveSafe.mockRejectedValueOnce(new Error('proposal pending'))
    await expect(fake.ports.requireRetry(saved, 'direct', 'retry')).rejects.toThrow('proposal pending')
    expect(saved.direct.hash).toBe(PROPOSAL)
  })

  it('groups all EOA payment attempts by their original funding option after proving each finalized failure', async () => {
    const saved = paymentSession()
    const earlier = `0x${'ef'.repeat(32)}` as Hex
    saved.payment.started = true
    saved.payment.hash = HASH
    const otherOption = { ...saved.payment.option, chain: 10 }
    saved.quote.payment_info.push(otherOption)
    saved.paymentAttempts = [
      { started: true, hash: earlier, option: saved.payment.option },
      { started: true, hash: PROPOSAL, option: otherOption },
    ]
    await fake.ports.requireRetry(saved, 'payment', 'retry')
    expect(fake.callFailure.mock.calls.map(call => call[0].submission.hash)).toEqual([earlier, PROPOSAL, HASH])
    expect(fake.retryPayment).toHaveBeenCalledTimes(2)
    expect(fake.retryPayment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ hashes: [earlier, HASH], from: OWNER,
      payment: expect.objectContaining({ chainId: 8453, amount: 100n, bundleUuid: BUNDLE }) }))
    expect(fake.retryPayment).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ hashes: [PROPOSAL],
      payment: expect.objectContaining({ chainId: 10 }) }))
    fake.retryPayment.mockRejectedValueOnce(new Error('bundle already paid'))
    await expect(fake.ports.requireRetry(saved, 'payment', 'retry')).rejects.toThrow('already paid')
    expect(saved.payment.hash).toBe(HASH)
  })

  it('does not release a payment while any earlier attempt lacks finalized failure proof', async () => {
    const saved = paymentSession()
    saved.payment = { ...saved.payment, started: true, hash: HASH }
    saved.paymentAttempts = [{ started: true, hash: PROPOSAL, option: saved.payment.option }]
    fake.callFailure.mockResolvedValueOnce(false)
    await expect(fake.ports.requireRetry(saved, 'payment', 'retry')).rejects.toThrow('finalized')
    expect(fake.callFailure).toHaveBeenCalledOnce()
    expect(fake.retryPayment).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('releases a Safe payment only after exact consumed failure proof and a fresh unpaid bundle check', async () => {
    const saved = paymentSession()
    saved.payment = { ...saved.payment, started: true, hash: PROPOSAL, proposalHash: PROPOSAL }
    await fake.ports.requireRetry(saved, 'payment', 'retry')
    expect(fake.callFailure).toHaveBeenCalledWith(expect.objectContaining({ chainId: 8453, owner: OWNER,
      call: { to: RELAYR_PAYMENT_ADDRESS, data: saved.payment.option.calldata, value: 100n },
      submission: expect.objectContaining({ hash: HASH, proposalHash: PROPOSAL }) }), expect.anything())
    expect(fake.retryPayment).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
    vi.mocked(fetch).mockImplementation(async () => json({ bundle_uuid: BUNDLE, payment_received: true, transactions: [] }))
    await expect(fake.ports.requireRetry(saved, 'payment', 'retry')).rejects.toThrow('payment')
    expect(saved.payment.hash).toBe(PROPOSAL)
    fake.callFailure.mockResolvedValueOnce(false)
    vi.mocked(fetch).mockClear()
    await expect(fake.ports.requireRetry(saved, 'payment', 'retry')).rejects.toThrow('finalized')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('allows retirement proof of an expired historical payment without reopening or requiring an unpaid bundle', async () => {
    const saved: StickyLaunchSession = paymentSession()
    const option = { ...saved.payment!.option, payment_deadline: 100,
      calldata: encodeFunctionData({ abi: parseAbi(['function prepayment(bytes16 bundle, uint40 deadline) payable']),
        functionName: 'prepayment', args: [`0x${BUNDLE.replaceAll('-', '')}`, 100] }) }
    saved.paymentAttempts = [{ started: true, hash: HASH, option }]
    saved.payment = undefined
    await fake.ports.requireRetry(saved, 'payment', 'retire')
    expect(fake.callFailure).toHaveBeenCalledOnce()
    expect(fake.retryPayment).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    await expect(fake.ports.requireRetry(saved, 'payment', 'retry')).rejects.toThrow()
    expect(fake.callFailure).toHaveBeenCalledOnce()
  })
})
