import { QueryClient } from '@tanstack/react-query'
import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  encodeFunctionData,
  parseAbi,
  toEventSelector,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import {
  canonicalSafeTxHash,
  safeProposalFor,
  SAFE_EXEC_ABI,
} from '@bananapus/nana-sdk-core/safe-service'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildPermit2ApproveTx } from '@bananapus/nana-sdk-core/v6'
import { WRITE_HOLD_SAFE_UNPROVEN_LINE, SAFE_PROPOSAL_EXECUTED_LINE, WRITE_EXIT_LABEL } from '@bananapus/nana-sdk-core/review'

// Safe proposals through useSafeTx. One registry holds every proposal made
// this session, shared by every flow, and follows each to its result: a flow
// that closes, remounts or changes chain never drops one, and never proposes
// the same call twice while one is pending.


const displayQueries = new QueryClient()
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => displayQueries,
}))

const mocks = vi.hoisted(() => ({
  publicClient: { getBlockNumber: vi.fn(async () => 100n), getTransactionCount: vi.fn(async () => 7),
    simulateContract: vi.fn(),
    estimateContractGas: vi.fn(),
    getTransaction: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    getTransactionReceipt: vi.fn(),
    getChainId: vi.fn(),
    getBlock: vi.fn(),
  },
  getAccount: vi.fn(),
  chainId: 10,
  requestReview: vi.fn(),
  switchChain: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
  findPendingSafeAppProposal: vi.fn(),
  reportedSafeExecution: vi.fn(),
  watchSafeProposal: vi.fn(),
  atOnceExecution: vi.fn(),
  writeContract: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: mocks.getAccount }))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: mocks.switchChain }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isError: false }),
  useWriteContract: () => ({ writeContractAsync: mocks.writeContract }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: SAFE, isCenterWallet: false }),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: mocks.requestReview,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => true,
  SAFE_NONCE_GUIDANCE: 'Safe nonce guidance',
  useSafeConnection: () => true,
  waitForSafeExecutionHash: mocks.waitForSafeExecutionHash,
  findPendingSafeAppProposal: mocks.findPendingSafeAppProposal,
  reportedSafeExecution: mocks.reportedSafeExecution,
  watchSafeProposal: mocks.watchSafeProposal,
  atOnceExecution: mocks.atOnceExecution,
}))

/** The connected Safe app's Safe, which reviewed every request below. */
const SAFE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
/** What the Safe app returns: its proposal's safeTxHash. */
const PROPOSAL = `0x${'ab'.repeat(32)}` as Hex
const SECOND_PROPOSAL = `0x${'ac'.repeat(32)}` as Hex
/** The transaction an owner sends to execute it. */
const EXECUTION = `0x${'cd'.repeat(32)}` as Hex
/** A safeTxHash the app never saw, as a Safe{Wallet} that executed at once logs it. */
const UNSEEN = `0x${'ef'.repeat(32)}` as Hex
const SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)')
const FAILURE = toEventSelector('ExecutionFailure(bytes32,uint256)')
const BLOCK_HASH = `0x${'ed'.repeat(32)}` as Hex
// The SDK also keeps a settlement and a latest-attempt marker per call; only the reservation records count here.
const recoveryRecords = () => {
  // A namespaced hold also leaves a mirror under its exact-call key, with the same record id: one reservation.
  const seen = new Map<string, Record<string, unknown>>()
  for (const key of Object.keys(localStorage).filter(each => each.startsWith('nana-sdk:reviewed-write:'))) {
    const value = JSON.parse(localStorage.getItem(key)!)
    if (value && typeof value === 'object' && 'call' in value && !('result' in value) && typeof value.id === 'string' && !seen.has(value.id)) seen.set(value.id, value)
  }
  return [...seen.values()]
}
const WORD = `0x${'00'.repeat(32)}` as Hex
const AWAITING = 'Proposed to your Safe. Its other signers can approve it there.'
const reviewedBySafe = { reviewedAccount: SAFE }
const ABI = parseAbi(['function transfer(address to, uint256 amount)'])
const request = {
  chainId: 10,
  address: BOB,
  abi: ABI,
  functionName: 'transfer',
  args: [BOB, 5n] as readonly [Address, bigint],
  value: 7n,
  label: 'Transfer',
}
const callData = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })

/** The Safe's execTransaction of the call to Bob, or of `data` in its place. */
const execTransaction = (data: Hex = callData) =>
  encodeFunctionData({
    abi: SAFE_EXEC_ABI,
    functionName: 'execTransaction',
    args: [BOB, 7n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
  })

/** The receipt of `transactionHash`, carrying the Safe's `topic` event for `safeTxHash`. */
const receiptOf = (transactionHash: Hex, safeTxHash: Hex, topic = SUCCESS) => ({
  status: 'success' as const,
  transactionHash,
  blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0, from: BOB, to: SAFE,
  logs: [{ address: SAFE, topics: [topic, safeTxHash], data: WORD, transactionHash, blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0, removed: false }],
})

let useSafeTx: typeof import('@/hooks/useSafeTx').useSafeTx
type TxRequest = import('@/hooks/useSafeTx').TxRequest
type Value = ReturnType<typeof useSafeTx>

const Harness = forwardRef<Value, { chainId: number; phases?: string[] }>(function Harness(
  { chainId, phases },
  ref,
) {
  const value = useSafeTx(chainId)
  phases?.push(value.phase)
  useImperativeHandle(ref, () => value, [value])
  return null
})

/** One flow's useSafeTx, mounted on `chainId`. */
async function mount(chainId = 10, phases?: string[]) {
  const ref = createRef<Value>()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { ref, chainId, phases }))
  })
  renderers.push(renderer)
  return {
    get tx() {
      return ref.current!
    },
    send: async (sent: TxRequest = request) => {
      let result: Hex | null = null
      await act(async () => {
        result = await ref.current!.send(sent, reviewedBySafe)
      })
      return result
    },
    changeChain: (next: number) =>
      act(async () => renderer.update(createElement(Harness, { ref, chainId: next, phases }))),
    close: () => act(async () => renderer.unmount()),
  }
}

/** Let the registry's follow run. */
const settle = () =>
  act(async () => {
    for (let tick = 0; tick < 20; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
  })

/** Each proposal's wait, which the test ends when the Safe executes it. */
function signersDecide() {
  const executions = new Map<Hex, (hash: Hex) => void>()
  mocks.waitForSafeExecutionHash.mockImplementation(
    (_chain: number, proposal: Hex) => new Promise<Hex>(resolve => executions.set(proposal, resolve)),
  )
  return (proposal: Hex = PROPOSAL, execution: Hex = EXECUTION) => executions.get(proposal)!(execution)
}

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount() })
})

beforeEach(async () => {
  displayQueries.clear()
  // The registry lives for the page: each test starts a page of its own.
  vi.resetModules()
  ;({ useSafeTx } = await import('@/hooks/useSafeTx'))
  mocks.chainId = 10
  mocks.getAccount.mockImplementation(() => ({ address: SAFE, chainId: mocks.chainId }))
  mocks.requestReview.mockReset().mockResolvedValue(true)
  mocks.switchChain.mockImplementation(async ({ chainId }: { chainId: number }) => { mocks.chainId = chainId })
  mocks.findPendingSafeAppProposal.mockReset().mockResolvedValue(null)
  mocks.reportedSafeExecution.mockReset().mockResolvedValue(null)
  // The watch ends nothing unless a test says so.
  mocks.watchSafeProposal.mockReset().mockImplementation(() => new Promise(() => {}))
  // One look at the chain, where the app's own probe looks a few times.
  mocks.atOnceExecution.mockReset().mockImplementation((client: typeof mocks.publicClient, hash: Hex) =>
    client.getTransaction({ hash }).then(
      (transaction: unknown) => transaction,
      () => null,
    ),
  )
  mocks.waitForSafeExecutionHash.mockReset().mockResolvedValue(EXECUTION)
  mocks.publicClient.simulateContract.mockResolvedValue({
    request: { address: BOB, functionName: 'transfer', gas: 100n },
  })
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  // A proposal's hash is no transaction; the execution is an owner's execTransaction of the call.
  mocks.publicClient.getTransaction.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => {
    if (hash !== EXECUTION) throw new TransactionNotFoundError({ hash })
    return { hash, from: BOB, to: SAFE, input: execTransaction(), blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0 }
  })
  mocks.publicClient.getChainId.mockReset().mockImplementation(async () => mocks.chainId)
  mocks.publicClient.getBlock.mockReset().mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
    hash: BLOCK_HASH, number: blockNumber ?? 10n, timestamp: 1_900_000_000n,
  }))
  // A proposal's safeTxHash is no transaction, so it has no receipt.
  mocks.publicClient.getTransactionReceipt.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => {
    // Only a hash the chain knows as a transaction has a receipt.
    await mocks.publicClient.getTransaction({ hash }).catch(() => { throw new TransactionReceiptNotFoundError({ hash }) })
    return mocks.publicClient.waitForTransactionReceipt({ hash })
  })
  mocks.publicClient.waitForTransactionReceipt
    .mockReset()
    .mockImplementation(async ({ hash }: { hash: Hex }) => receiptOf(hash, PROPOSAL))
  mocks.writeContract.mockReset().mockResolvedValue(PROPOSAL)
})

describe('a Safe proposal', () => {
  it('ends its confirm on Done while the signers decide, and settles once the Safe executes it', async () => {
    const execute = signersDecide()
    const displayKey = ['sticky-project', 10, 1, 'info', 'v1']
    displayQueries.setQueryData(displayKey, { marker: true })
    const flow = await mount()
    await flow.send()
    await settle()

    expect(mocks.requestReview).toHaveBeenCalledWith(
      { ...request, account: SAFE, safeTxGas: 0n },
      { label: 'Transfer', description: 'Safe nonce guidance', confirmLabel: 'Agree & continue to Safe' },
    )
    // A Safe app signs the sent gas as safeTxGas: 0 makes a failed call revert.
    expect(mocks.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 0n }))
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      busy: false,
      settled: true,
      error: null,
      notice: AWAITING,
      safeProposalHash: PROPOSAL,
      safeNonceGuidance: 'Safe nonce guidance',
    })
    expect(mocks.atOnceExecution).toHaveBeenCalledWith(mocks.publicClient, PROPOSAL)
    expect(mocks.waitForSafeExecutionHash).toHaveBeenCalledWith(10, PROPOSAL, {
      client: mocks.publicClient,
      signal: expect.any(AbortSignal),
    })

    expect(displayQueries.getQueryState(displayKey)?.isInvalidated).toBe(false)
    execute()
    await settle()
    // The visible domain flow owns its exact refresh scope and schedule.
    expect(displayQueries.getQueryState(displayKey)?.isInvalidated).toBe(false)
    expect(flow.tx).toMatchObject({
      phase: 'success',
      busy: false,
      hash: EXECUTION,
      notice: null,
      safeProposalHash: null,
    })
    expect(flow.tx.receipt?.blockNumber).toBe(9n)
  })

  it('is followed after its flow closes, and a reopened flow is refused the same call until it settles', async () => {
    const execute = signersDecide()
    const displayKey = ['sticky-project', 10, 1, 'info', 'v1']
    displayQueries.setQueryData(displayKey, { marker: true })
    const first = await mount()
    await first.send()
    await settle()
    // Done while the signers decide does not release the call.
    await act(async () => first.tx.dismiss())
    await first.close()

    const reopened = await mount()
    await expect(reopened.send()).resolves.toBe(PROPOSAL)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(mocks.requestReview).toHaveBeenCalledOnce()
    expect(reopened.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })

    execute()
    await settle()
    expect(displayQueries.getQueryState(displayKey)?.isInvalidated).toBe(true)
    expect(reopened.tx.phase).toBe('success')
    // Settled, the call is the user's again.
    await act(async () => reopened.tx.reset())
    await reopened.send()
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it('survives a remount on another chain and back, as Move remounts: the same move is refused, another is taken', async () => {
    const execute = signersDecide()
    const before = await mount(10)
    await before.send()
    await settle()
    await before.close()
    await (await mount(8453)).close()

    const after = await mount(10)
    await after.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(after.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })
    execute()
    await settle()
    expect(after.tx.phase).toBe('success')

    mocks.writeContract.mockResolvedValueOnce(SECOND_PROPOSAL)
    await act(async () => after.tx.reset())
    await after.send({ ...request, args: [BOB, 6n] })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it('is followed on its own chain when the flow changes chain, as Redeem does', async () => {
    const execute = signersDecide()
    const flow = await mount(10)
    await flow.send()
    await settle()
    await flow.changeChain(8453)
    await act(async () => flow.tx.reset())
    await settle()
    expect(mocks.waitForSafeExecutionHash.mock.calls.map(([chain]) => chain)).toEqual([10])

    await flow.changeChain(10)
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(flow.tx).toMatchObject({ phase: 'submitted', notice: AWAITING })
    execute()
    await settle()
    expect(flow.tx.phase).toBe('success')
  })

  it("is never proposed again when the Safe's queue already holds it, here, after a reload or from another device", async () => {
    const hash = canonicalSafeTxHash(10, SAFE, safeProposalFor({ to: BOB, data: callData, value: 7n }, 5))
    mocks.findPendingSafeAppProposal.mockResolvedValue({
      proposalHash: hash,
      call: { to: BOB, data: callData, value: 7n },
    })
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash: execution }: { hash: Hex }) =>
      receiptOf(execution, hash),
    )
    const flow = await mount()

    await expect(flow.send()).resolves.toBe(hash)
    await settle()
    expect(mocks.findPendingSafeAppProposal).toHaveBeenCalledWith(
      mocks.publicClient,
      10,
      SAFE,
      { to: BOB, data: callData, value: 7n },
    )
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(flow.tx).toMatchObject({ phase: 'success' })
    // A proposal from the queue is no reply: the chain is not probed for it.
    expect(mocks.atOnceExecution).not.toHaveBeenCalled()
    expect(mocks.waitForSafeExecutionHash).toHaveBeenCalledWith(10, hash, {
      client: mocks.publicClient,
      signal: expect.any(AbortSignal),
    })
  })

  it("asks no queue on a chain without Safe's service", async () => {
    const flow = await mount(11155420)
    await flow.send({ ...request, chainId: 11155420 })
    expect(mocks.findPendingSafeAppProposal).not.toHaveBeenCalled()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('never shows an execution Safe{Wallet} returned at once as proposed', async () => {
    // The reply is the execution itself, and the Safe logs a safeTxHash the app never saw.
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      hash,
      from: BOB,
      to: SAFE,
      input: execTransaction(), blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0,
    }))
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, UNSEEN),
    )
    const phases: string[] = []
    const flow = await mount(10, phases)
    await flow.send()
    await settle()

    expect(flow.tx).toMatchObject({ phase: 'success', hash: PROPOSAL })
    expect(phases).not.toContain('submitted')
    expect(mocks.waitForSafeExecutionHash).not.toHaveBeenCalled()
  })

  it.each([
    ['ran the reviewed call', execTransaction(), 'success'],
    ['ran another call', execTransaction('0xdeadbeef'), 'submitted'],
  ] as const)('settles an execution returned at once only when it %s', async (_, input, phase) => {
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      hash,
      from: BOB,
      to: SAFE,
      input, blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0,
    }))
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, UNSEEN),
    )
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx.phase).toBe(phase)
    // Another call ran: nothing proves this one did. The mined transaction can't be read as this call yet, so the SDK's
    // chain-checked state offers no exit until its 30 minutes pass (the next test), and nothing is sent in the meantime.
    if (phase === 'submitted') {
      expect(flow.tx.held).toBeNull()
      expect(mocks.writeContract).toHaveBeenCalledOnce()
    }
  })

  it('offers the exit for an execution returned at once that ran another call, after 65 minutes and a remount', async () => {
    vi.useFakeTimers()
    try {
      mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
      mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
        hash, from: BOB, to: SAFE, input: execTransaction('0xdeadbeef'), blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0,
      }))
      mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => receiptOf(hash, UNSEEN))
      const pass = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
      const flow = await mount()
      await flow.send()
      await pass(0)
      await flow.close()
      await pass(65 * 60_000)

      const reopened = await mount()
      await reopened.send()
      await pass(1_000)
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      expect(reopened.tx.held).toMatchObject({ label: WRITE_EXIT_LABEL })
      expect(recoveryRecords()[0].executed).not.toBe(true)
      await act(async () => { reopened.tx.held!.exit!() })
      await pass(0)
      await expect(reopened.send()).resolves.toBe(SECOND_PROPOSAL)
      expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it.each([
    ['Safe 1.4, hash indexed', EXECUTION, (hash: Hex) => receiptOf(hash, PROPOSAL, FAILURE)],
    [
      'Safe 1.3, hash in data',
      EXECUTION,
      (hash: Hex) => ({
        ...receiptOf(hash, PROPOSAL),
        logs: [{ ...receiptOf(hash, PROPOSAL).logs[0], topics: [FAILURE], data: `${PROPOSAL}${WORD.slice(2)}` as Hex }],
      }),
    ],
    ['executed at once', PROPOSAL, (hash: Hex) => receiptOf(hash, UNSEEN, FAILURE)],
  ] as const)('fails a proposal whose execution logged ExecutionFailure for it (%s)', async (_, execution, receipt) => {
    mocks.waitForSafeExecutionHash.mockResolvedValue(execution)
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (hash !== execution) throw new TransactionNotFoundError({ hash })
      return { hash, from: BOB, to: SAFE, input: execTransaction(), blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0 }
    })
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => receipt(hash))
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({
      phase: 'error',
      busy: false,
      error: `Safe executed the proposal, but the onchain transaction failed (${execution}).`,
    })
  })

  it.each([
    ['logged its failure', FAILURE, 'error'],
    ['logged its success', SUCCESS, 'success'],
  ] as const)(
    "settles a proposal Safe's service reports failed by the receipt its record names, which %s",
    async (_, topic, phase) => {
      const reported = new Error('Safe executed the proposal, but the onchain transaction failed.')
      mocks.waitForSafeExecutionHash.mockRejectedValue(reported)
      mocks.reportedSafeExecution.mockResolvedValue(EXECUTION)
      mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
        receiptOf(hash, PROPOSAL, topic),
      )
      const flow = await mount()
      await flow.send()
      await settle()
      expect(mocks.reportedSafeExecution).toHaveBeenCalledWith(reported, 10, SAFE, PROPOSAL)
      expect(flow.tx).toMatchObject({ phase, hash: EXECUTION })
      if (phase === 'error') {
        expect(flow.tx.error).toBe(`Safe executed the proposal, but the onchain transaction failed (${EXECUTION}).`)
      }
    },
  )

  it("holds a proposal Safe's service reports failed without naming its execution, including after Dismiss", async () => {
    mocks.waitForSafeExecutionHash.mockRejectedValue(
      new Error('Safe executed the proposal, but the onchain transaction failed.'),
    )
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      confirmationUncertain: true,
      notice: WRITE_HOLD_SAFE_UNPROVEN_LINE,
    })
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(recoveryRecords()).toHaveLength(1)
  })

  it("holds a known proposal with unproven execution through reset and Dismiss", async () => {
    // The execution's events all belong to another proposal or another Safe.
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      ...receiptOf(hash, UNSEEN, FAILURE),
      logs: [
        { address: SAFE, topics: [FAILURE, UNSEEN], data: WORD },
        { address: BOB, topics: [FAILURE, PROPOSAL], data: WORD },
      ],
    }))
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      busy: false,
      settled: true,
      confirmationUncertain: true,
      error: null,
      notice: WRITE_HOLD_SAFE_UNPROVEN_LINE,
    })

    // A new review opens on its own state.
    await act(async () => flow.tx.reset())
    expect(flow.tx).toMatchObject({ phase: 'idle', notice: null })
    // The user never saw the line here, so the same call is refused, with it.
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(flow.tx).toMatchObject({ phase: 'submitted', notice: WRITE_HOLD_SAFE_UNPROVEN_LINE })

    await act(async () => flow.tx.dismiss())
    expect(flow.tx).toMatchObject({ phase: 'idle', notice: null })
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('holds a proposal it lost track of after Dismiss, naming why', async () => {
    mocks.waitForSafeExecutionHash.mockRejectedValue(new Error('Safe service unavailable'))
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      confirmationUncertain: true,
      notice: WRITE_HOLD_SAFE_UNPROVEN_LINE,
    })
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(recoveryRecords()).toHaveLength(1)
  })
})

const NO_RECORD = new Error("Safe's transaction service has no record of this proposal.")

describe('a Safe proposal awaiting its signers', () => {
  const EXPIRED = "This Safe proposal's deadline passed. Review it again."

  it.each([
    ['its deadline passed before the Safe ran it', 'expired', EXPIRED],
  ] as const)('retains its action when the watcher claims %s without independent finalized proof', async (_, end, line) => {
    signersDecide()
    let watchEnds!: (end: string) => void
    mocks.watchSafeProposal.mockImplementationOnce(() => new Promise(resolve => (watchEnds = resolve)))
    mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
    const flow = await mount()
    await flow.send()
    await settle()
    expect(mocks.watchSafeProposal).toHaveBeenCalledWith(mocks.publicClient, 10, SAFE, PROPOSAL, expect.any(AbortSignal))
    const [, , , , watching] = mocks.watchSafeProposal.mock.lastCall!
    const [, , { signal: waiting }] = mocks.waitForSafeExecutionHash.mock.lastCall!

    watchEnds(end)
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'submitted', busy: false, error: line })
    expect(flow.tx.notice).toMatch(/canonical result/)
    // The wait for its execution stops with it.
    expect(waiting.aborted).toBe(true)
    expect(watching.aborted).toBe(true)

    await act(async () => flow.tx.reset())
    await expect(flow.send()).resolves.toBe(PROPOSAL)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(recoveryRecords()).toHaveLength(1)
  })

  it('offers the exit when the watcher says another transaction took the nonce but the hold cannot authenticate it, and sends exactly once more after it is accepted', async () => {
    signersDecide()
    let watchEnds!: (end: string) => void
    mocks.watchSafeProposal.mockImplementationOnce(() => new Promise(resolve => (watchEnds = resolve)))
    mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
    const flow = await mount()
    await flow.send()
    await settle()
    expect(recoveryRecords()).toHaveLength(1)

    watchEnds('replaced')
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'submitted', notice: WRITE_HOLD_SAFE_UNPROVEN_LINE })
    expect(flow.tx.held).toMatchObject({ label: WRITE_EXIT_LABEL })
    expect(recoveryRecords()).toHaveLength(1)
    expect(mocks.writeContract).toHaveBeenCalledOnce()

    await act(async () => { flow.tx.held!.exit!() })
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'idle', held: null })
    expect(recoveryRecords().filter(record => !record.released)).toHaveLength(recoveryRecords().length)
    await expect(flow.send()).resolves.toBe(SECOND_PROPOSAL)
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it('offers the exit when the follower ends without proof, and sends exactly once more after it is accepted', async () => {
    mocks.waitForSafeExecutionHash.mockRejectedValue(new Error('Safe service unavailable'))
    mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'submitted', confirmationUncertain: true })
    expect(flow.tx.held).toMatchObject({ label: WRITE_EXIT_LABEL })
    await act(async () => { flow.tx.held!.exit!() })
    await settle()
    await expect(flow.send()).resolves.toBe(SECOND_PROPOSAL)
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it('follows a proposal the Safe shows executed to its result', async () => {
    const execute = signersDecide()
    let watchEnds!: (end: string) => void
    mocks.watchSafeProposal.mockImplementationOnce(() => new Promise(resolve => (watchEnds = resolve)))
    const flow = await mount()
    await flow.send()
    await settle()
    watchEnds('executed')
    await settle()
    // Its execution is still being named: nothing ended it.
    expect(flow.tx.phase).toBe('submitted')
    execute()
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'success', hash: EXECUTION })
    expect(recoveryRecords()).toHaveLength(0)
  })

  it('says the Safe ran a proposal whose execution it cannot name, and holds the same call while the SDK has no proof to settle it', async () => {
    vi.useFakeTimers()
    try {
      signersDecide()
      let watchEnds!: (end: string) => void
      mocks.watchSafeProposal.mockImplementationOnce(() => new Promise(resolve => (watchEnds = resolve)))
      const flow = await mount()
      await flow.send()
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
      watchEnds('executed')
      await act(async () => { await vi.advanceTimersByTimeAsync(130_000) })
      expect(flow.tx).toMatchObject({ phase: 'submitted', confirmationUncertain: true, notice: SAFE_PROPOSAL_EXECUTED_LINE, held: null })
      // Closing keeps the saved hold: the same call is never proposed a second time.
      await act(async () => flow.tx.dismiss())
      await flow.send()
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      expect(recoveryRecords()).toHaveLength(1)

      // Remount and reload: the follower's reply is unreadable and the SDK has nothing authenticated to settle the hold
      // with, so it stays: no remount or reload sends again, and the reservation stands. (What the caller believes is
      // never evidence; the settlement path has its own authenticated tests.)
      mocks.waitForSafeExecutionHash.mockRejectedValue(new Error('unreadable'))
      for (const reload of [false, true]) {
        if (reload) {
          await flow.close()
          vi.resetModules()
          ;({ useSafeTx } = await import('@/hooks/useSafeTx'))
        }
        const reopened = await mount()
        await reopened.send()
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
        await act(async () => reopened.tx.dismiss())
        await reopened.send()
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
        expect(mocks.writeContract).toHaveBeenCalledOnce()
        expect(recoveryRecords()).toHaveLength(1)
        await reopened.close()
      }
    } finally { vi.useRealTimers() }
  })

  it('settles a proposal the background follower proves after Done on its receipt, and keeps that settlement readable across a reload', async () => {
    const execute = signersDecide()
    const flow = await mount()
    await flow.send()
    await settle()
    // Done, with nobody looking at the proposal any more.
    await act(async () => flow.tx.dismiss())
    await flow.close()
    const placement = { transactionHash: EXECUTION, blockHash: BLOCK_HASH, blockNumber: 9n, transactionIndex: 0 }
    const receipt = { ...receiptOf(EXECUTION, PROPOSAL), ...placement, from: BOB, to: SAFE,
      logs: [{ address: SAFE, topics: [SUCCESS, PROPOSAL], data: WORD, ...placement, removed: false }] }
    mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({ hash: BLOCK_HASH, number: blockNumber ?? 10n, timestamp: 1_900_000_000n }))
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (hash !== EXECUTION) throw new TransactionNotFoundError({ hash })
      return { hash, from: BOB, to: SAFE, input: execTransaction(), ...placement }
    })
    mocks.publicClient.getTransactionReceipt.mockResolvedValue(receipt)
    mocks.publicClient.waitForTransactionReceipt.mockResolvedValue(receipt)
    execute()
    await settle()
    // Authenticated by the receipt's own log: the hold is settled, not abandoned.
    expect(recoveryRecords()).toHaveLength(0)
    const settled = Object.keys(localStorage).filter(key => key.endsWith(':settled')).map(key => JSON.parse(localStorage.getItem(key)!))
    expect(settled[0]).toMatchObject({ hash: EXECUTION, result: 'success' })
    expect(mocks.writeContract).toHaveBeenCalledOnce()

    // After a reload the settlement is still there for the app to read.
    vi.resetModules()
    ;({ useSafeTx } = await import('@/hooks/useSafeTx'))
    expect(Object.keys(localStorage).some(key => key.endsWith(':settled'))).toBe(true)
  })

  it('stops being watched once its execution is known', async () => {
    const execute = signersDecide()
    const flow = await mount()
    await flow.send()
    await settle()
    const [, , , , watching] = mocks.watchSafeProposal.mock.lastCall!
    expect(watching.aborted).toBe(false)
    execute()
    await settle()
    expect(flow.tx.phase).toBe('success')
    expect(watching.aborted).toBe(true)
  })

  it("is not watched on a chain without Safe's service", async () => {
    signersDecide()
    const flow = await mount(11155420)
    await flow.send({ ...request, chainId: 11155420 })
    await settle()
    expect(flow.tx.phase).toBe('submitted')
    expect(mocks.watchSafeProposal).not.toHaveBeenCalled()
  })
})

describe('an executed Safe proposal', () => {
  const PENDING_RECEIPT = 'Executed by your Safe. Confirming it onchain.'
  /** Lets `ms` of time pass for the follow. */
  const pass = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  beforeEach(() => {
    vi.useFakeTimers()
    // The node answers no receipt: each tracked wait gives up after its polls.
    mocks.publicClient.waitForTransactionReceipt.mockReset().mockRejectedValue(new Error('timed out'))
    mocks.publicClient.getTransactionReceipt
      .mockReset()
      .mockImplementation(async ({ hash }: { hash: Hex }) => {
        throw new TransactionReceiptNotFoundError({ hash })
      })
  })

  it('holds a known proposal while its receipt is missing, including after the confirmation horizon', async () => {
    const flow = await mount()
    await flow.send()
    await pass(0)
    expect(flow.tx).toMatchObject({ phase: 'pending', hash: EXECUTION })

    // One tracked wait (about three minutes) found no receipt.
    await pass(4 * 60_000)
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      settled: true,
      notice: PENDING_RECEIPT,
      confirmationUncertain: false,
      hash: EXECUTION,
    })
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(flow.tx).toMatchObject({ phase: 'submitted', notice: PENDING_RECEIPT })

    // Past 30 minutes with nothing authenticating the service's word, the hold offers its exit.
    await pass(50 * 60_000)
    expect(flow.tx.held).toMatchObject({ label: WRITE_EXIT_LABEL })
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('does not save an execution hash the service returned as proof, and offers the exit when no receipt ever proves it', async () => {
    mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
    const flow = await mount()
    await flow.send()
    await pass(4 * 60_000)
    // The service named an execution, but nothing authenticated it for this proposal.
    expect(recoveryRecords()[0].executed).not.toBe(true)
    expect(flow.tx.held).toBeNull()

    await pass(70 * 60_000)
    expect(flow.tx.held).toMatchObject({ label: WRITE_EXIT_LABEL })
    expect(recoveryRecords()[0].executed).not.toBe(true)
    await act(async () => { flow.tx.held!.exit!() })
    await pass(0)
    await expect(flow.send()).resolves.toBe(SECOND_PROPOSAL)
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it('settles once its receipt arrives within the hour', async () => {
    const flow = await mount()
    await flow.send()
    await pass(20 * 60_000)
    expect(flow.tx.notice).toBe(PENDING_RECEIPT)
    mocks.publicClient.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, PROPOSAL),
    )
    await pass(5 * 60_000)
    expect(flow.tx).toMatchObject({ phase: 'success', hash: EXECUTION, notice: null })
  })
})

describe("a send that asks Safe's queue first", () => {
  it('shows the flow checking while the queue is read', async () => {
    let answer!: (queued: null) => void
    mocks.findPendingSafeAppProposal.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    const flow = await mount()
    let sent!: Promise<unknown>
    await act(async () => {
      sent = flow.tx.send(request, reviewedBySafe)
    })
    expect(flow.tx).toMatchObject({ phase: 'simulating', busy: true })
    expect(mocks.requestReview).not.toHaveBeenCalled()
    await act(async () => {
      answer(null)
      await sent
    })
    expect(mocks.requestReview).toHaveBeenCalledOnce()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })
})

describe('a Safe proposal another flow dismissed', () => {
  it('closes the display while retaining the durable action', async () => {
    mocks.waitForSafeExecutionHash.mockRejectedValue(new Error('Safe service unavailable'))
    const first = await mount()
    await first.send()
    await settle()
    const second = await mount()
    await second.send()
    expect(second.tx).toMatchObject({ phase: 'submitted', confirmationUncertain: true })

    // The hold is the call's, not a display's: the flow that proposed it still shows it until it closes it.
    await act(async () => second.tx.dismiss())
    expect(first.tx).toMatchObject({ phase: 'submitted', held: { label: WRITE_EXIT_LABEL } })
    await act(async () => first.tx.reset())
    expect(first.tx).toMatchObject({ phase: 'idle', busy: false, settled: false, notice: null, hash: null })
    await first.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(recoveryRecords()).toHaveLength(1)
  })
})

describe("a Safe proposal's last look at the chain", () => {
  /** Lets `ms` of time pass for the follow. */
  const pass = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })

  it('holds an execution returned at once when the independent canonical lookup is unavailable', async () => {
    // Safe{Wallet} executed at once, and the node learned the execution only after the probe.
    mocks.atOnceExecution.mockResolvedValue(null)
    mocks.waitForSafeExecutionHash.mockRejectedValue(NO_RECORD)
    // A replica behind it answers every later read: the execution is bound on the one the look read.
    let reads = 0
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      reads += 1
      if (reads > 1) throw new TransactionNotFoundError({ hash })
      return { hash, from: BOB, to: SAFE, input: execTransaction(), blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0 }
    })
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, UNSEEN),
    )
    const phases: string[] = []
    const flow = await mount(10, phases)
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'pending', hash: PROPOSAL, confirmationUncertain: false })
    expect(flow.tx.notice).toMatch(/canonical result/)
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(recoveryRecords()).toHaveLength(1)
  })

  it("keeps a proposal held through a node that can't answer its last look, and looks again a minute later", async () => {
    vi.useFakeTimers()
    mocks.waitForSafeExecutionHash.mockRejectedValue(NO_RECORD)
    let nodeUp = false
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (!nodeUp) throw new Error('fetch failed')
      throw new TransactionNotFoundError({ hash })
    })
    const flow = await mount()
    await flow.send()
    await pass(0)
    // Never flagged on a node error: still with the Safe, and held.
    expect(flow.tx).toMatchObject({ phase: 'submitted', confirmationUncertain: false, notice: AWAITING })
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()

    nodeUp = true
    await pass(60_000)
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      confirmationUncertain: true,
      notice: WRITE_HOLD_SAFE_UNPROVEN_LINE,
    })
  })

  it("keeps an execution held through a node that can't answer for its receipt after the hour", async () => {
    vi.useFakeTimers()
    mocks.publicClient.waitForTransactionReceipt.mockReset().mockRejectedValue(new Error('timed out'))
    let nodeUp = true
    mocks.publicClient.getTransactionReceipt.mockReset().mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (!nodeUp) throw new Error('fetch failed')
      throw new TransactionReceiptNotFoundError({ hash })
    })
    const flow = await mount()
    await flow.send()
    await pass(20 * 60_000)
    expect(flow.tx.notice).toBe('Executed by your Safe. Confirming it onchain.')
    nodeUp = false
    await pass(40 * 60_000)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    nodeUp = true
    await pass(60_000)
    // Nothing authenticated it: the hold offers its exit, and sends nothing itself.
    expect(flow.tx).toMatchObject({ phase: 'submitted', confirmationUncertain: true })
    expect(flow.tx.held).toMatchObject({ label: WRITE_EXIT_LABEL })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('retains an execution returned at once until an independent canonical read confirms it', async () => {
    mocks.atOnceExecution.mockResolvedValue({ hash: PROPOSAL, from: BOB, to: SAFE, input: execTransaction() })
    // A replica that hasn't imported the receipt's block has no transaction for it.
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      throw new TransactionNotFoundError({ hash })
    })
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, UNSEEN),
    )
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'pending', hash: PROPOSAL })
    expect(recoveryRecords()).toHaveLength(1)
  })

  it('asks a node behind the receipt again, held and able to end on Done, when no transaction is in hand', async () => {
    vi.useFakeTimers()
    // The SDK's wait found the reply on the chain: it was the execution, read by nobody here.
    mocks.atOnceExecution.mockResolvedValue(null)
    mocks.waitForSafeExecutionHash.mockResolvedValue(PROPOSAL)
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, UNSEEN),
    )
    let caughtUp = false
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      // The receipt is in hand, so a not-found says only that this node is behind.
      if (!caughtUp) throw new TransactionNotFoundError({ hash })
      return { hash, from: BOB, to: SAFE, input: execTransaction(), blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0 }
    })
    const flow = await mount()
    await flow.send()
    await pass(0)
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      settled: true,
      confirmationUncertain: false,
      notice: 'Executed by your Safe. Confirming it onchain.',
    })
    await act(async () => flow.tx.dismiss())
    await flow.send()
    expect(mocks.writeContract).toHaveBeenCalledOnce()

    caughtUp = true
    await pass(60_000)
    expect(flow.tx).toMatchObject({ phase: 'success', hash: PROPOSAL })
  })

  it.each([SUCCESS, FAILURE])('retains a reverted proposal across dismiss/remount until an authenticated %s', async topic => {
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      ...receiptOf(hash, PROPOSAL), status: 'reverted' as const,
    }))
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({
      phase: 'submitted', safeProposalHash: PROPOSAL, notice: WRITE_HOLD_SAFE_UNPROVEN_LINE, hash: EXECUTION,
    })
    await act(async () => flow.tx.dismiss())
    await flow.close()

    // A recheck follows the original proposal, without another wallet send.
    const execute = signersDecide()
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) =>
      receiptOf(hash, PROPOSAL, topic),
    )
    const resumed = await mount()
    await resumed.send()
    await settle()
    await resumed.send()
    expect(mocks.waitForSafeExecutionHash).toHaveBeenCalledTimes(2)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(resumed.tx.phase).toBe('submitted')
    execute()
    await settle()
    expect(resumed.tx.phase).toBe(topic === SUCCESS ? 'success' : 'error')
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('keeps a known reverted proposal held when a later look says its nonce was taken, and while the service is unavailable', async () => {
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      ...receiptOf(hash, PROPOSAL), status: 'reverted' as const,
    }))
    const flow = await mount()
    await flow.send()
    await settle()
    mocks.waitForSafeExecutionHash.mockRejectedValue(NO_RECORD)
    await act(async () => flow.tx.dismiss())
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({ phase: 'submitted', safeProposalHash: PROPOSAL })
    expect(flow.tx.notice).toBe(WRITE_HOLD_SAFE_UNPROVEN_LINE)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await act(async () => flow.tx.dismiss())
    await flow.close()
    mocks.waitForSafeExecutionHash.mockImplementation(() => new Promise(() => {}))
    mocks.watchSafeProposal.mockResolvedValue('replaced')
    const resumed = await mount()
    await resumed.send()
    await settle()
    // Another transaction at the nonce may have run the call too: nothing is released on the registry's word.
    expect(resumed.tx).toMatchObject({ phase: 'submitted', notice: WRITE_HOLD_SAFE_UNPROVEN_LINE })
    expect(recoveryRecords()).toHaveLength(1)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('retains a reverted execution returned at once when its exact Safe effect is unavailable', async () => {
    mocks.atOnceExecution.mockResolvedValue(null)
    mocks.waitForSafeExecutionHash.mockResolvedValue(PROPOSAL)
    mocks.publicClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      ...receiptOf(hash, UNSEEN),
      status: 'reverted' as const,
    }))
    mocks.publicClient.getTransaction.mockImplementation(async () => {
      throw new Error('fetch failed')
    })
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      error: `Safe executed the proposal, but the onchain transaction failed (${PROPOSAL}).`,
    })
  })
})

describe("a Safe app's reply", () => {
  it('retains an invalid wallet reply as unknown across reset', async () => {
    mocks.writeContract.mockResolvedValueOnce('0x1234').mockResolvedValueOnce(PROPOSAL)
    const flow = await mount()
    await expect(flow.send()).resolves.toBeNull()
    expect(flow.tx).toMatchObject({
      phase: 'submitted',
      busy: false,
      confirmationUncertain: true,
    })
    expect(mocks.waitForSafeExecutionHash).not.toHaveBeenCalled()
    await act(async () => flow.tx.reset())
    await expect(flow.send()).resolves.toBeNull()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(recoveryRecords()[0].hash).toBeUndefined()
  })
})

describe('generic Safe durable recovery', () => {
  it('holds a lost reply for the same call across a module reload, and takes a changed amount as another action', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('Lost wallet response'))
    const first = await mount()
    await first.send()
    expect(first.tx.phase).toBe('submitted')
    await first.close()
    vi.resetModules()
    ;({ useSafeTx } = await import('@/hooks/useSafeTx'))
    const reopened = await mount()
    await reopened.send()
    expect(reopened.tx).toMatchObject({ phase: 'submitted', held: { label: WRITE_EXIT_LABEL } })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await reopened.send({ ...request, args: [BOB, 6n] })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

  it('saves the adopted proposal’s actual stamped calldata for later proof', async () => {
    signersDecide()
    const original = buildPermit2ApproveTx({ chainId: 10, token: BOB, amount: 5n, expiration: 1_800_000_000 })
    const fresh = buildPermit2ApproveTx({ chainId: 10, token: BOB, amount: 5n, expiration: 1_800_000_600 })
    const call = { to: original.address, data: encodeFunctionData(original), value: 0n }
    mocks.findPendingSafeAppProposal.mockResolvedValueOnce({ proposalHash: PROPOSAL, call })
    const flow = await mount()
    await flow.send(fresh)
    expect(recoveryRecords()[0]).toMatchObject({ hash: PROPOSAL, call: { data: call.data } })
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(flow.tx.phase).toBe('submitted')
  })

  function canonicalExecution() {
    const blockHash = `0x${'ed'.repeat(32)}` as Hex
    const placement = { transactionHash: EXECUTION, blockHash, blockNumber: 9n, transactionIndex: 0 }
    const receipt = { ...receiptOf(EXECUTION, PROPOSAL), ...placement, from: BOB, to: SAFE,
      logs: [{ address: SAFE, topics: [SUCCESS, PROPOSAL], data: WORD, ...placement, removed: false }] }
    mocks.publicClient.getChainId.mockResolvedValue(10)
    mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
      hash: blockHash, number: blockNumber ?? 10n, timestamp: 1_900_000_000n,
    }))
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => {
      if (hash !== EXECUTION) throw new TransactionNotFoundError({ hash })
      return { hash, from: BOB, to: SAFE, input: execTransaction(), ...placement }
    })
    mocks.publicClient.getTransactionReceipt.mockResolvedValue(receipt)
    mocks.publicClient.waitForTransactionReceipt.mockResolvedValue(receipt)
  }

  it('does not present a noncanonical Safe execution as success or clear its record', async () => {
    canonicalExecution()
    mocks.publicClient.getBlock.mockResolvedValue({ hash: PROPOSAL, number: 9n })
    const flow = await mount()
    await flow.send()
    await settle()
    expect(flow.tx.phase).toBe('pending')
    expect(recoveryRecords()).toHaveLength(1)
  })

  it('proposes a changed amount on its own, and an older amount\'s execution never settles it', async () => {
    const execute = signersDecide()
    mocks.writeContract.mockResolvedValueOnce(PROPOSAL).mockResolvedValueOnce(SECOND_PROPOSAL)
    const first = await mount()
    await first.send()
    await settle()
    await first.close()
    const reopened = await mount()
    await reopened.send({ ...request, args: [BOB, 6n] })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    await act(async () => { execute() })
    await settle()
    expect(reopened.tx).toMatchObject({ phase: 'submitted', safeProposalHash: SECOND_PROPOSAL, hash: null })
  })

  it('ignores an older Safe queue lookup after the review closes', async () => {
    let reply!: (proposal: { proposalHash: Hex; call: { to: Address; data: Hex; value: bigint } }) => void
    mocks.findPendingSafeAppProposal.mockImplementationOnce(() => new Promise(resolve => { reply = resolve }))
    const flow = await mount()
    let pending!: Promise<Hex | null>
    await act(async () => { pending = flow.tx.send(request, reviewedBySafe) })
    await act(async () => { flow.tx.reset() })
    await act(async () => { reply({ proposalHash: PROPOSAL, call: { to: BOB, data: callData, value: 7n } }); await pending })
    expect(flow.tx).toMatchObject({ phase: 'idle', hash: null, safeProposalHash: null })
    expect(recoveryRecords()).toHaveLength(0)
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

})
