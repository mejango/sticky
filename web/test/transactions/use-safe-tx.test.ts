import { QueryClient } from '@tanstack/react-query'
import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import {
  encodeFunctionData,
  parseAbi,
  UserRejectedRequestError,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem'
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
import { payIntent } from '@bananapus/nana-sdk-core/review'
import { buildBridgeClaimTx, buildBridgePrepareTx, buildCashOutTx, buildPayTx, buildToRemoteTx, stickySourceCollectorAbi } from '@bananapus/nana-sdk-core/v6'
import { createBrowserWriteRecovery, createWriteHold, WRITE_HOLD_STALE_REVIEW_LINE, WRITE_HOLD_IN_TAB_LINE, WRITE_EXIT_LABEL, writeExitMessage, writeHeldMessage } from '@bananapus/nana-sdk-core/review'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'


const displayQueries = new QueryClient()
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => displayQueries,
}))

const mocks = vi.hoisted(() => ({
  account: undefined as Address | undefined,
  centerWallet: false,
  chainId: 1,
  connectorUid: 'wallet-one',
  connected: true,
  publicClient: { simulateContract: vi.fn(), estimateContractGas: vi.fn(), getTransaction: vi.fn(), getChainId: vi.fn(), getBlock: vi.fn(), getTransactionReceipt: vi.fn(), getBlockNumber: vi.fn(), getTransactionCount: vi.fn() },
  receipt: { data: undefined, isError: false } as {
    data?: {
      status: 'success' | 'reverted'
      blockNumber?: bigint
      transactionHash: string
      logs?: { address: string; topics: readonly `0x${string}`[]; data: `0x${string}` }[]
    }
    isError: boolean
  },
  getAccount: vi.fn(),
  requestReview: vi.fn(),
  safeConnection: false,
  switchChain: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
  writeContract: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({
  getAccount: mocks.getAccount,
  getPublicClient: () => mocks.publicClient,
}))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: mocks.switchChain }),
  useWaitForTransactionReceipt: () => mocks.receipt,
  useWriteContract: () => ({ writeContractAsync: mocks.writeContract }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({
    isConnected: mocks.connected,
    address: mocks.account,
    isCenterWallet: mocks.centerWallet,
  }),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: mocks.requestReview,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => mocks.safeConnection,
  SAFE_NONCE_GUIDANCE: 'Safe nonce guidance',
  useSafeConnection: () => mocks.safeConnection,
  waitForSafeExecutionHash: mocks.waitForSafeExecutionHash,
  // The Safe proposal suite covers the queue lookup; nothing is queued here.
  findPendingSafeAppProposal: async () => null,
}))

import { useSafeTx } from '@/hooks/useSafeTx'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

const TRANSACTION_WENT_THROUGH = 'Your earlier transaction went through.'
const STILL_PENDING_LINE = 'Still pending in your wallet. Speed it up or cancel it there.'
type TxRequestOf = object
const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
/** Every request below was built for, and reviewed by, Alice. */
const reviewedByAlice = { reviewedAccount: ALICE }
const HASH = `0x${'ab'.repeat(32)}` as const
const EXECUTION_HASH = `0x${'cd'.repeat(32)}` as const
const BLOCK_HASH = `0x${'ef'.repeat(32)}` as const
const canonicalReceipt = (status: 'success' | 'reverted', transactionHash: Hex = HASH) => ({
  status, transactionHash, blockNumber: 77n, blockHash: BLOCK_HASH, transactionIndex: 0,
  from: ALICE, to: BOB, logs: [],
})
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
const ABI = parseAbi(['function transfer(address to, uint256 amount)'])
const request = {
  chainId: 10,
  address: BOB,
  abi: ABI,
  functionName: 'transfer',
  args: [BOB, 5n] as const,
  value: 7n,
  label: 'Transfer',
}

/** Alice's Safe running `data` as the call to Bob that `request` reviews, as an owner sends it. */
const execTransaction = (data: Hex = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })) =>
  encodeFunctionData({
    abi: SAFE_EXEC_ABI,
    functionName: 'execTransaction',
    args: [BOB, 7n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'],
  })

type SafeTxValue = ReturnType<typeof useSafeTx>

const Harness = forwardRef<SafeTxValue>(function Harness(_, ref) {
  const value = useSafeTx(10)
  useImperativeHandle(ref, () => value, [value])
  return null
})

async function renderHook() {
  const ref = createRef<SafeTxValue>()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { ref }))
  })
  renderers.push(renderer)
  return { ref, renderer }
}

const renderers: TestRenderer.ReactTestRenderer[] = []
afterEach(async () => {
  await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount() })
})

beforeEach(() => {
  displayQueries.clear()
  mocks.account = ALICE
  mocks.centerWallet = false
  mocks.connected = true
  mocks.chainId = 1
  mocks.connectorUid = 'wallet-one'
  mocks.receipt = { data: undefined, isError: false }
  mocks.getAccount.mockImplementation(() => ({ address: mocks.account, chainId: mocks.chainId, connector: { uid: mocks.connectorUid } }))
  mocks.requestReview.mockResolvedValue(true)
  mocks.safeConnection = false
  mocks.switchChain.mockImplementation(async ({ chainId }: { chainId: number }) => { mocks.chainId = chainId })
  mocks.waitForSafeExecutionHash.mockResolvedValue(EXECUTION_HASH)
  mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
    hash,
    from: mocks.safeConnection ? BOB : ALICE,
    to: mocks.safeConnection ? ALICE : BOB,
    input: mocks.safeConnection ? execTransaction() : encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }),
    blockHash: BLOCK_HASH, blockNumber: 77n, transactionIndex: 0,
  }))
  mocks.publicClient.getChainId.mockResolvedValue(10)
  mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
    number: blockNumber ?? 100n, hash: BLOCK_HASH, timestamp: 1_000n,
  }))
  mocks.publicClient.getTransactionReceipt.mockImplementation(async () => mocks.receipt.data)
  mocks.publicClient.getBlockNumber.mockResolvedValue(100n)
  mocks.publicClient.getTransactionCount.mockResolvedValue(7)
  mocks.publicClient.simulateContract.mockResolvedValue({
    request: { address: BOB, functionName: 'transfer', gas: 100n },
  })
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  mocks.writeContract.mockResolvedValue(HASH)
})

describe('useSafeTx', () => {
  it('keeps a broadcast with a lost wallet reply held through reset and remount, for that call only', async () => {
    let recipientBalance = 0n
    mocks.writeContract.mockImplementationOnce(async () => {
      recipientBalance += 5n
      throw new Error('The wallet broadcast the transfer but its RPC response was lost.')
    })
    const first = await renderHook()
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    expect(first.ref.current).toMatchObject({ phase: 'submitted', busy: false, hash: null })
    expect(first.ref.current!.notice).toBe(writeHeldMessage())
    expect(first.ref.current!.held).toMatchObject({ line: writeHeldMessage(), warning: writeExitMessage({ value: 7n }) })
    await act(async () => first.ref.current!.reset())
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    await act(async () => first.renderer.unmount())

    const second = await renderHook()
    await act(async () => { await second.ref.current!.send(request, reviewedByAlice) })
    expect(second.ref.current).toMatchObject({ phase: 'submitted', hash: null })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(recipientBalance).toBe(5n)

    // A different amount is a different call, which the hold does not cover.
    await act(async () => { await second.ref.current!.send({ ...request, args: [BOB, 6n] }, reviewedByAlice) })
    expect(second.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    await act(async () => second.renderer.unmount())
  })

  it('lets the user end a hold by saying they checked their wallet, and sends again only after that', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('The wallet broadcast the transfer but its RPC response was lost.'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(WRITE_EXIT_LABEL).toBe('I checked my wallet. Send again')

    await act(async () => hook.ref.current!.held!.exit!())
    expect(hook.ref.current).toMatchObject({ phase: 'idle', held: null, notice: null })
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
  })

  it('keeps a newer write held when a stale exit is pressed after another tab replaced the record', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('The wallet broadcast the transfer but its RPC response was lost.'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    const staleExit = hook.ref.current!.held!.exit!
    // Another tab released attempt A and sent attempt B under the same call.
    const key = Object.keys(localStorage).find(each => each.startsWith('nana-sdk:reviewed-write:'))!
    const newer = { ...JSON.parse(localStorage.getItem(key)!), id: 'attempt-b', nonce: '8' }
    localStorage.setItem(key, JSON.stringify(newer))
    await act(async () => staleExit())
    expect(JSON.parse(localStorage.getItem(key)!).id).toBe('attempt-b')
    expect(Object.keys(localStorage).filter(each => each.includes('released'))).toHaveLength(0)
    expect(hook.ref.current!.held).not.toBeNull()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('follows a hash whose lookup was pending to its confirmation, clearing the record with one wallet write', async () => {
    const first = await renderHook()
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    await act(async () => first.renderer.unmount())
    mocks.publicClient.getTransaction.mockImplementationOnce(async ({ hash }: { hash: Hex }) => ({
      hash, from: ALICE, to: BOB, nonce: 7, input: '0x', blockHash: null, blockNumber: null, transactionIndex: null,
    }))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
    // The pending look saved the nonce the hash was sent at.
    expect(recoveryRecords()[0]).toMatchObject({ hash: HASH, sentNonce: '7' })
    mocks.receipt = { data: canonicalReceipt('success'), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(recoveryRecords()).toHaveLength(0)
    expect(hook.ref.current!.phase).toBe('success')
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('keeps a hashless write held when the chain shows another transaction at its nonce, until the user says they checked their wallet', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('The wallet broadcast the transfer but its RPC response was lost.'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current!.held).not.toBeNull()
    // The record carries the nonce and block the wallet opened at.
    expect(recoveryRecords()[0]).toMatchObject({ nonce: '7', fromBlock: '100' })
    mocks.publicClient.getTransactionCount.mockImplementation(async (args: { blockNumber?: bigint; blockTag?: string }) =>
      args.blockTag === 'pending' ? 8 : (args.blockNumber ?? 0n) >= 150n ? 8 : 7)
    mocks.publicClient.getBlock.mockImplementation(async (args: { blockTag?: string; blockNumber?: bigint; includeTransactions?: boolean }) =>
      args.blockTag === 'finalized'
        ? { number: 200n, hash: BLOCK_HASH, timestamp: 1_000n }
        : args.includeTransactions
          ? { number: args.blockNumber, hash: BLOCK_HASH, transactions: args.blockNumber === 150n
              ? [{ hash: EXECUTION_HASH, from: ALICE, to: ALICE, nonce: 7, value: 0n, input: '0x' }] : [] }
          : { number: args.blockNumber, hash: BLOCK_HASH })
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(hook.ref.current).toMatchObject({ phase: 'submitted' })
    expect(hook.ref.current!.held).toMatchObject({ label: WRITE_EXIT_LABEL })
  })

  it('keeps a newer write held when a stale exit is pressed after another tab replaced the record', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('The wallet broadcast the transfer but its RPC response was lost.'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    const staleExit = hook.ref.current!.held!.exit!
    // Another tab released attempt A and sent attempt B under the same call.
    const key = Object.keys(localStorage).find(each => each.startsWith('nana-sdk:reviewed-write:'))!
    const newer = { ...JSON.parse(localStorage.getItem(key)!), id: 'attempt-b', nonce: '8' }
    localStorage.setItem(key, JSON.stringify(newer))
    await act(async () => staleExit())
    expect(JSON.parse(localStorage.getItem(key)!).id).toBe('attempt-b')
    expect(Object.keys(localStorage).filter(each => each.includes('released'))).toHaveLength(0)
    expect(hook.ref.current!.held).not.toBeNull()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('follows a hash whose lookup was pending to its confirmation, clearing the record with one wallet write', async () => {
    const first = await renderHook()
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    await act(async () => first.renderer.unmount())
    mocks.publicClient.getTransaction.mockImplementationOnce(async ({ hash }: { hash: Hex }) => ({
      hash, from: ALICE, to: BOB, nonce: 7, input: '0x', blockHash: null, blockNumber: null, transactionIndex: null,
    }))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
    // The pending look saved the nonce the hash was sent at.
    expect(recoveryRecords()[0]).toMatchObject({ hash: HASH, sentNonce: '7' })
    mocks.receipt = { data: canonicalReceipt('success'), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(recoveryRecords()).toHaveLength(0)
    expect(hook.ref.current!.phase).toBe('success')
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('refuses to send while view-as is active', async () => {
    setViewAs(BOB)
    try {
      const hook = await renderHook()
      let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never

      await act(async () => {
        result = await hook.ref.current!.send(request, reviewedByAlice)
      })

      expect(result).toBeNull()
      expect(hook.ref.current).toMatchObject({
        phase: 'error',
        error: VIEW_AS_WRITE_BLOCKED,
      })
      expect(mocks.requestReview).not.toHaveBeenCalled()
      expect(mocks.writeContract).not.toHaveBeenCalled()
    } finally {
      clearViewAs()
    }
  })

  it('requests the transaction without a redundant switch when already on its chain', async () => {
    mocks.getAccount.mockImplementation(() => ({ address: ALICE, chainId: 10 }))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.switchChain).not.toHaveBeenCalled()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await act(async () => hook.renderer.unmount())
  })

  it('wallet-action:submit-a-reviewed-direct-write runs exact review, chain/account checks, simulation, and the simulated write', async () => {
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = null

    await act(async () => {
      result = await hook.ref.current!.send(request, reviewedByAlice)
    })

    expect(result).toBe(HASH)
    expect(mocks.requestReview).toHaveBeenCalledWith(
      { ...request, account: ALICE },
      { label: 'Transfer' },
    )
    expect(mocks.switchChain).toHaveBeenCalledWith({ chainId: 10 })
    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith({
      address: BOB,
      abi: ABI,
      functionName: 'transfer',
      args: [BOB, 5n],
      value: 7n,
      account: ALICE,
    })
    expect(mocks.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 100_000n, chainId: 10 }),
    )
    expect(hook.ref.current).toMatchObject({
      phase: 'pending',
      busy: true,
      hash: HASH,
    })
  })

  it('anchors a dependent simulation to its confirmed prerequisite block', async () => {
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, simulationBlockNumber: 12_345n })
    })

    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: 12_345n }),
    )
  })

  it('skips only the duplicate app review when the parent already showed the exact call', async () => {
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, reviewedInParent: true })
    })

    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.switchChain).toHaveBeenCalledWith({ chainId: 10 })
    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: BOB, account: ALICE }),
    )
    expect(mocks.writeContract).toHaveBeenCalled()
  })

  it('cancels without switching, simulating, or signing', async () => {
    mocks.requestReview.mockResolvedValueOnce(false)
    const hook = await renderHook()

    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })

    expect(hook.ref.current!.phase).toBe('idle')
    expect(mocks.switchChain).not.toHaveBeenCalled()
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('blocks a duplicate while review is open', async () => {
    let finishReview!: (approved: boolean) => void
    mocks.requestReview.mockImplementationOnce(
      () => new Promise<boolean>(resolve => (finishReview = resolve)),
    )
    const hook = await renderHook()

    await act(async () => {
      const first = hook.ref.current!.send(request, reviewedByAlice)
      await Promise.resolve()
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
      finishReview(false)
      await first
    })

    expect(mocks.requestReview).toHaveBeenCalledTimes(1)
    expect(hook.ref.current!.phase).toBe('idle')
  })

  it.each([
    ['its own review', {}],
    ['a review its parent showed', { reviewedInParent: true }],
  ])(
    'refuses, before %s opens, a request reviewed for another account',
    async (_, options) => {
      mocks.account = BOB
      const beforeWrite = vi.fn()
      const hook = await renderHook()

      await act(async () => {
        await expect(
          hook.ref.current!.send(request, { ...options, reviewedAccount: ALICE, beforeWrite }),
        ).resolves.toBeNull()
      })

      expect(hook.ref.current).toMatchObject({
        phase: 'error',
        busy: false,
        error: 'The connected account changed. Review again.',
      })
      expect(mocks.requestReview).not.toHaveBeenCalled()
      expect(mocks.switchChain).not.toHaveBeenCalled()
      expect(beforeWrite).not.toHaveBeenCalled()
      expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
      expect(mocks.writeContract).not.toHaveBeenCalled()
    },
  )

  it('refuses a request whose reviewed account was switched away while its review was open', async () => {
    mocks.requestReview.mockImplementationOnce(async () => {
      mocks.account = BOB
      return true
    })
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { reviewedAccount: ALICE })
    })

    expect(hook.ref.current!.error).toBe('The connected account changed. Review again.')
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('reviews, simulates and sends as the account the request was reviewed for', async () => {
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, { reviewedAccount: ALICE })
    })

    expect(mocks.requestReview).toHaveBeenCalledWith({ ...request, account: ALICE }, { label: 'Transfer' })
    expect(mocks.publicClient.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ account: ALICE }))
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('fails before simulation when switching changes the account', async () => {
    mocks.switchChain.mockImplementationOnce(async () => {
      mocks.account = BOB
    })
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })

    expect(hook.ref.current).toMatchObject({ phase: 'error', busy: false })
    expect(hook.ref.current!.error).toMatch(/account changed/i)
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('fails before signing when the account changes during simulation', async () => {
    mocks.publicClient.simulateContract.mockImplementationOnce(async () => {
      mocks.account = BOB
      return { request: { gas: 100n } }
    })
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })

    expect(hook.ref.current!.error).toMatch(/account changed/i)
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it.each([
    ['chain', 'simulation'],
    ['chain', 'persisting the intent'],
    ['view-as', 'simulation'],
    ['view-as', 'persisting the intent'],
    ['connector', 'simulation'],
    ['connector', 'persisting the intent'],
  ])('refuses a change of %s while %s finishes, before the wallet write', async (changed, during) => {
    const change = () => {
      if (changed === 'chain') mocks.chainId = 8453
      else if (changed === 'connector') mocks.connectorUid = 'wallet-two'
      else setViewAs(BOB)
    }
    const onBeforeWriteAborted = vi.fn()
    const beforeWrite = during === 'persisting the intent' ? vi.fn(change) : undefined
    if (!beforeWrite) mocks.publicClient.simulateContract.mockImplementationOnce(async () => {
      change()
      return { request: { gas: 100n } }
    })
    const hook = await renderHook()
    try {
      await act(async () => {
        await expect(hook.ref.current!.send(request, {
          ...reviewedByAlice,
          beforeWrite,
          onBeforeWriteAborted,
        })).resolves.toBeNull()
      })
      expect(hook.ref.current!.phase).toBe('error')
      expect(hook.ref.current!.error).toBe(changed === 'view-as'
        ? VIEW_AS_WRITE_BLOCKED
        : 'Wallet connection changed. Review the transaction again.')
      expect(mocks.writeContract).not.toHaveBeenCalled()
      expect(onBeforeWriteAborted).toHaveBeenCalledOnce()
    } finally {
      clearViewAs()
      await act(async () => hook.renderer.unmount())
    }
  })

  it('keeps a receipt RPC error pending and prevents a duplicate send', async () => {
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })

    mocks.receipt = { data: undefined, isError: true }
    await act(async () => {
      hook.renderer.update(createElement(Harness, { ref: hook.ref }))
    })

    expect(hook.ref.current).toMatchObject({
      phase: 'pending',
      busy: true,
      confirmationUncertain: true,
    })
    expect(hook.ref.current!.error).toMatch(/confirmation is temporarily unavailable/i)
    // The chain still knows the hash: it is tracked by that hash and offers no exit.
    expect(hook.ref.current!.held).toMatchObject({ line: STILL_PENDING_LINE, exit: null })
    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(mocks.requestReview).toHaveBeenCalledTimes(1)
  })

  /** The chain, as a test sets it: the hash is known pending, gone, or replaced at its nonce. */
  const chain = {
    pending: (hash: Hex) => mocks.publicClient.getTransaction.mockImplementation(async () => ({ hash, from: ALICE, to: BOB, nonce: 7, input: '0x', blockHash: null, blockNumber: null, transactionIndex: null })),
    gone: () => mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => { throw new TransactionNotFoundError({ hash }) }),
    moved: (history: boolean, usedBy: { hash: Hex; to: Address; input: Hex }) => {
      mocks.publicClient.getTransactionCount.mockImplementation(async (args: { blockTag?: string; blockNumber?: bigint }) =>
        args.blockTag === 'pending' ? 8 : (args.blockNumber ?? 0n) >= 150n ? 8 : 7)
      mocks.publicClient.getBlock.mockImplementation(async (args: { blockTag?: string; blockNumber?: bigint; includeTransactions?: boolean }) => {
        if (args.blockTag === 'finalized') return { number: 200n, hash: BLOCK_HASH, timestamp: 1_000n }
        if (!args.includeTransactions) return { number: args.blockNumber, hash: BLOCK_HASH }
        if (!history) throw new Error('This node has no history for that block.')
        return { number: args.blockNumber, hash: BLOCK_HASH, transactions: args.blockNumber === 150n
          ? [{ hash: usedBy.hash, from: ALICE, to: usedBy.to, nonce: 7, value: 0n, input: usedBy.input }] : [] }
      })
    },
  }
  const look = () => act(async () => { await vi.advanceTimersByTimeAsync(16_000) })

  it('offers the exit for a hash only once a finalized block shows another transaction at its nonce, and checks again as it is accepted', async () => {
    vi.useFakeTimers()
    try {
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      mocks.receipt = { data: undefined, isError: true }
      // The node knows it pending: the hash is tracked, with no exit.
      chain.pending(HASH)
      await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
      await look()
      expect(hook.ref.current!.held).toMatchObject({ line: STILL_PENDING_LINE, exit: null })

      // A lagging node says not found while it is still pending, and the nonce has not moved.
      chain.gone()
      await look()
      expect(hook.ref.current!.held).toMatchObject({ line: STILL_PENDING_LINE, exit: null })

      // The nonce moved, but the node cannot show what used it: not proof.
      chain.moved(false, { hash: EXECUTION_HASH, to: ALICE, input: '0x' })
      await look()
      expect(hook.ref.current!.held).toMatchObject({ line: STILL_PENDING_LINE, exit: null })

      // Another transaction (a cancel) is shown at that nonce at a finalized block.
      chain.moved(true, { hash: EXECUTION_HASH, to: ALICE, input: '0x' })
      await look()
      expect(hook.ref.current!.held).toMatchObject({ label: WRITE_EXIT_LABEL })
      expect(hook.ref.current!.held!.exit).toBeTypeOf('function')

      // A proven drop (another transaction used its nonce at a finalized block) can't run, whatever a node still shows:
      // the exit is accepted even if the node shows the old hash pending again.
      chain.pending(HASH)
      chain.gone()
      chain.moved(true, { hash: EXECUTION_HASH, to: ALICE, input: '0x' })
      await look()
      await act(async () => hook.ref.current!.held!.exit!())
      expect(hook.ref.current).toMatchObject({ phase: 'idle', held: null })
    } finally { vi.useRealTimers() }
  })

  /** An exit is on screen for a dropped hash; then the chain shows that same hash mined and successful. */
  async function exitOpenThenConfirmed() {
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    mocks.receipt = { data: undefined, isError: true }
    chain.pending(HASH)
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    await look()
    chain.gone()
    chain.moved(true, { hash: EXECUTION_HASH, to: ALICE, input: '0x' })
    await look()
    expect(hook.ref.current!.held!.exit).toBeTypeOf('function')
    // It was confirmed all along: the node now shows it mined, with its receipt.
    mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => ({
      hash, from: ALICE, to: BOB, nonce: 7, input: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }),
      value: 7n, blockHash: BLOCK_HASH, blockNumber: 77n, transactionIndex: 0,
    }))
    mocks.publicClient.getTransactionReceipt.mockImplementation(async () => canonicalReceipt('success'))
    return hook
  }

  it('ends the attempt without sending when a confirmation lands while the exit is open', async () => {
    vi.useFakeTimers()
    try {
      const hook = await exitOpenThenConfirmed()
      await act(async () => hook.ref.current!.held!.exit!())
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      expect(hook.ref.current!.notice).toBe(TRANSACTION_WENT_THROUGH)
      expect(hook.ref.current!.held).toBeNull()
      await look()
      expect(mocks.writeContract).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('keeps the settlement a poll returned while the exit was open, and sends nothing', async () => {
    vi.useFakeTimers()
    try {
      const hook = await exitOpenThenConfirmed()
      await look()
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      expect(hook.ref.current!.held).toBeNull()
      expect(hook.ref.current!.notice).toBe(TRANSACTION_WENT_THROUGH)
    } finally { vi.useRealTimers() }
  })

  it('offers the exit for a hash the node showed pending and then lost for 30 minutes', async () => {
    vi.useFakeTimers()
    try {
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      mocks.receipt = { data: undefined, isError: true }
      chain.pending(HASH)
      await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
      await look()
      expect(hook.ref.current!.held).toMatchObject({ line: STILL_PENDING_LINE, exit: null })

      // The node no longer knows it, and the nonce never moved: pending for now.
      chain.gone()
      await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60_000) })
      expect(hook.ref.current!.held).toMatchObject({ exit: null })

      // Missing for 30 minutes: the exit is offered, with the SDK's line.
      await act(async () => { await vi.advanceTimersByTimeAsync(11 * 60_000) })
      expect(hook.ref.current!.held).toMatchObject({ label: WRITE_EXIT_LABEL })
      expect(hook.ref.current!.held!.exit).toBeTypeOf('function')
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      await act(async () => hook.ref.current!.held!.exit!())
      expect(hook.ref.current).toMatchObject({ phase: 'idle', held: null })
    } finally { vi.useRealTimers() }
  })

  it('follows the original when the chain shows it ran at its nonce under a speed-up, and never offers the exit', async () => {
    vi.useFakeTimers()
    try {
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      mocks.receipt = { data: undefined, isError: true }
      chain.pending(HASH)
      await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
      await look()
      const SPED_UP = `0x${'5e'.repeat(32)}` as Hex
      chain.gone()
      chain.moved(true, { hash: SPED_UP, to: BOB, input: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }) })
      mocks.publicClient.getBlock.mockImplementation(async (args: { blockTag?: string; blockNumber?: bigint; includeTransactions?: boolean }) =>
        args.blockTag === 'finalized' ? { number: 200n, hash: BLOCK_HASH, timestamp: 1_000n }
          : args.includeTransactions
            ? { number: args.blockNumber, hash: BLOCK_HASH, transactions: args.blockNumber === 150n
                ? [{ hash: SPED_UP, from: ALICE, to: BOB, nonce: 7, value: 7n, input: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }) }] : [] }
            : { number: args.blockNumber, hash: BLOCK_HASH })
      await look()
      expect(hook.ref.current!.held?.exit ?? null).toBeNull()
      expect(hook.ref.current!.hash).toBe(SPED_UP)
      expect(mocks.writeContract).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('does not confirm a new action using the previous successful receipt', async () => {
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    mocks.receipt = { data: canonicalReceipt('success'), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current!.phase).toBe('success')

    mocks.writeContract.mockResolvedValueOnce(EXECUTION_HASH)
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current).toMatchObject({
      phase: 'pending', busy: true, hash: EXECUTION_HASH, receipt: null,
    })

    mocks.receipt = { data: canonicalReceipt('success', EXECUTION_HASH), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current!.phase).toBe('success')
  })

  it('confirms from a direct receipt lookup when the block watcher stalls', async () => {
    vi.useFakeTimers()
    try {
      const getTransactionReceipt = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(canonicalReceipt('success'))
      mocks.publicClient = {
        ...mocks.publicClient,
        getTransactionReceipt,
      } as typeof mocks.publicClient
      const hook = await renderHook()
      await act(async () => {
        await hook.ref.current!.send(request, reviewedByAlice)
      })
      expect(hook.ref.current).toMatchObject({ phase: 'pending', busy: true })

      // The watcher never answers; the interval lookup does.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100)
      })
      expect(getTransactionReceipt).toHaveBeenCalledTimes(1)
      expect(hook.ref.current).toMatchObject({ phase: 'pending' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100)
      })
      expect(getTransactionReceipt).toHaveBeenCalledTimes(3)
      expect(hook.ref.current).toMatchObject({ phase: 'success', busy: false, error: null })
      expect(hook.ref.current!.receipt).toMatchObject({ blockNumber: 77n })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a disconnected wallet and reset clears terminal state', async () => {
    mocks.connected = false
    const hook = await renderHook()

    await act(async () => {
      await hook.ref.current!.send(request, reviewedByAlice)
    })
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'Connect a wallet first.',
    })

    await act(async () => hook.ref.current!.reset())
    expect(hook.ref.current).toMatchObject({
      phase: 'idle',
      error: null,
      hash: null,
    })
  })

  it('reports a request it cannot encode as an error, and takes the next one', async () => {
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
    await act(async () => {
      result = await hook.ref.current!.send({ ...request, functionName: 'missing' }, reviewedByAlice)
    })
    expect(result).toBeNull()
    expect(hook.ref.current).toMatchObject({ phase: 'error', busy: false })
    expect(mocks.requestReview).not.toHaveBeenCalled()

    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('refuses a Center wallet before review, like view-as', async () => {
    mocks.centerWallet = true
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
    await act(async () => { result = await hook.ref.current!.send(request, reviewedByAlice) })
    expect(result).toBeNull()
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'This action needs an external wallet.',
    })
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('names the chain the wallet could not switch to', async () => {
    mocks.switchChain.mockRejectedValueOnce(new Error('User rejected the switch'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'Switch your wallet to Optimism to continue.',
    })
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it.each([
    ['becomes a Safe after review', false],
    ['stops being a Safe after review', true],
  ] as const)(
    'stops before the wallet when the connection %s',
    async (_, safeAtReview) => {
      mocks.safeConnection = safeAtReview
      mocks.requestReview.mockImplementationOnce(async () => {
        // A WalletConnect peer read lands mid-flow.
        mocks.safeConnection = !safeAtReview
        return true
      })
      const hook = await renderHook()
      const onBeforeWriteAborted = vi.fn()
      let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
      await act(async () => { result = await hook.ref.current!.send(request, { ...reviewedByAlice, onBeforeWriteAborted }) })
      expect(result).toBeNull()
      expect(hook.ref.current).toMatchObject({
        phase: 'error',
        error: 'Wallet connection changed. Review the transaction again.',
      })
      // The gas followed the reviewed connection, and nothing reached the wallet.
      expect(mocks.writeContract).not.toHaveBeenCalled()
      // The final wallet gate releases the generic reservation.
      expect(onBeforeWriteAborted).toHaveBeenCalledOnce()
    },
  )

  it('withdraws the marker written before the write when the connection changes there', async () => {
    const events: string[] = []
    const hook = await renderHook()
    let result: Awaited<ReturnType<SafeTxValue['send']>> = 'unset' as never
    await act(async () => {
      result = await hook.ref.current!.send(request, {
        ...reviewedByAlice,
        beforeWrite: () => {
          events.push('marked')
          // A WalletConnect peer read lands between the marker and the write.
          mocks.safeConnection = true
        },
        onBeforeWriteAborted: () => { events.push('withdrawn') },
        onWriteRejected: () => { events.push('rejected') },
      })
    })
    expect(result).toBeNull()
    expect(events).toEqual(['marked', 'withdrawn'])
    expect(hook.ref.current).toMatchObject({
      phase: 'error',
      error: 'Wallet connection changed. Review the transaction again.',
    })
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('sends the gas of the reviewed connection when a peer read flickers mid-flow', async () => {
    let simulated = false
    mocks.publicClient.simulateContract.mockImplementationOnce(async () => {
      mocks.safeConnection = true
      simulated = true
      return { request: { address: BOB, functionName: 'transfer', gas: 100n } }
    })
    // The account gate after simulation reads the peer again before the write.
    mocks.getAccount.mockImplementation(() => {
      if (simulated) mocks.safeConnection = false
      return { address: mocks.account, chainId: mocks.chainId }
    })
    // And once more after the wallet answered: the sent call is still an ordinary one.
    mocks.writeContract.mockImplementationOnce(async () => {
      mocks.safeConnection = true
      return HASH
    })
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledWith(expect.objectContaining({ gas: 100_000n }))
    expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: HASH, safeProposalHash: null })
    expect(mocks.waitForSafeExecutionHash).not.toHaveBeenCalled()
  })

  it('passes the write-intent callbacks to the reviewed write boundary', async () => {
    const order: string[] = []
    mocks.writeContract.mockImplementationOnce(async () => {
      order.push('write')
      throw new UserRejectedRequestError(new Error('User rejected'))
    })
    const beforeWrite = vi.fn(() => { order.push('beforeWrite') })
    const onWriteRejected = vi.fn(() => { order.push('rejected') })
    const onBeforeWriteAborted = vi.fn()
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, beforeWrite, onWriteRejected, onBeforeWriteAborted })
    })
    expect(order).toEqual(['beforeWrite', 'write', 'rejected'])
    expect(onBeforeWriteAborted).not.toHaveBeenCalled()

    // An account change after the intent was persisted aborts it before the wallet.
    beforeWrite.mockImplementationOnce(() => { mocks.account = BOB })
    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, beforeWrite, onWriteRejected, onBeforeWriteAborted })
    })
    expect(onBeforeWriteAborted).toHaveBeenCalledOnce()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })
  it('does not treat a rejection-looking transport message as a definite wallet rejection', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('User rejected: transport connection lost'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current!.phase).toBe('submitted')
    expect(recoveryRecords()).toHaveLength(1)
  })

  it('holds in the tab\'s memory when the browser refuses storage, and says so in the review', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    mocks.writeContract.mockRejectedValueOnce(new Error('The wallet broadcast the transfer but its RPC response was lost.'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.requestReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ description: expect.stringContaining(WRITE_HOLD_IN_TAB_LINE) }),
    )
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(hook.ref.current).toMatchObject({ phase: 'submitted', held: { line: writeHeldMessage() } })
    // The wallet is never opened with no hold at all, across a reset and a remount.
    await act(async () => hook.ref.current!.reset())
    await act(async () => hook.renderer.unmount())
    const again = await renderHook()
    await act(async () => { await again.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(again.ref.current!.held).not.toBeNull()
  })

  it('keeps the wallet prompt open past the poll without showing a resend exit', async () => {
    vi.useFakeTimers()
    try {
      let answer!: (hash: Hex) => void
      mocks.writeContract.mockImplementationOnce(() => new Promise<Hex>(resolve => { answer = resolve }))
      const hook = await renderHook()
      let sent!: Promise<Hex | null>
      await act(async () => { sent = hook.ref.current!.send(request, reviewedByAlice); await vi.advanceTimersByTimeAsync(10) })
      expect(hook.ref.current!.phase).toBe('signing')
      await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
      expect(hook.ref.current).toMatchObject({ phase: 'signing', held: null })
      await act(async () => { answer(HASH); await sent })
      expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('holds a write a domain journal reserves after a hashless failure, and its exit releases the reservation for exactly one more send', async () => {
    vi.useFakeTimers()
    try {
      const journal = { reserve: vi.fn(), releaseUnsubmitted: vi.fn(), submitted: vi.fn(), released: vi.fn() }
      mocks.writeContract.mockRejectedValueOnce(new Error('The wallet broadcast the transfer but its RPC response was lost.'))
      const hook = await renderHook()
      const send = () => act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, durableRecovery: journal }) })
      await send()
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      expect(hook.ref.current).toMatchObject({ phase: 'submitted', held: { label: WRITE_EXIT_LABEL } })

      // Before the exit is accepted, nothing sends and nothing is reserved again.
      await send()
      await act(async () => { await vi.advanceTimersByTimeAsync(31 * 60_000) })
      await send()
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      expect(journal.reserve).toHaveBeenCalledOnce()
      expect(journal.released).not.toHaveBeenCalled()

      await act(async () => hook.ref.current!.held!.exit!())
      expect(journal.released).toHaveBeenCalledOnce()
      expect(hook.ref.current).toMatchObject({ phase: 'idle', held: null })
      await send()
      expect(mocks.writeContract).toHaveBeenCalledTimes(2)
      expect(journal.reserve).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('releases a domain reservation when both nonce reads fail, so nothing is left locked and the next send works', async () => {
    const journal = { reserve: vi.fn(), releaseUnsubmitted: vi.fn(), submitted: vi.fn(), released: vi.fn() }
    mocks.publicClient.getBlockNumber.mockRejectedValue(new Error('RPC unavailable'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, durableRecovery: journal }) })
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(journal.reserve).toHaveBeenCalledOnce()
    expect(journal.releaseUnsubmitted).toHaveBeenCalledOnce()
    expect(hook.ref.current).toMatchObject({ phase: 'error', held: null })

    mocks.publicClient.getBlockNumber.mockResolvedValue(100n)
    await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, durableRecovery: journal }) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(journal.reserve).toHaveBeenCalledTimes(2)
  })

  it('reads a settlement another tab reached, after a reload, and hands it to the app without resending', async () => {
    const journal = { reserve: vi.fn(), releaseUnsubmitted: vi.fn(), submitted: vi.fn(), released: vi.fn() }
    // Tab A sends and is closed with the hash saved.
    const tabA = await renderHook()
    await act(async () => { await tabA.ref.current!.send(request, { ...reviewedByAlice, durableRecovery: journal }) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    await act(async () => tabA.renderer.unmount())

    // Tab B, a second controller on the same storage, verifies the receipt and settles the hold.
    mocks.receipt = { data: canonicalReceipt('success'), isError: false }
    const tabB = createWriteHold().open({ chainId: 10, account: ALICE, safe: false, call: { to: BOB, data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }), value: 7n } })
    const settled = await tabB.onReceipt(canonicalReceipt('success') as never, mocks.publicClient as never)
    expect(settled).toMatchObject({ status: 'clear', settled: { result: 'success', hash: HASH } })

    // Tab A reloads: its stored look reads the settlement, and its exit never counts as an abandon.
    const reloaded = await renderHook()
    const write = { chainId: 10, owner: ALICE, to: BOB, data: encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] }), value: 7n }
    await expect(reloaded.ref.current!.storedHold(write)).resolves.toEqual({ settled: { result: 'success', hash: HASH } })
    await expect(reloaded.ref.current!.exitStored(write)).resolves.toEqual({ outcome: 'settled', hash: HASH, result: 'success' })
    expect(journal.released).not.toHaveBeenCalled()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  describe('a retry whose calldata regenerates', () => {
    const X = '0x3333333333333333333333333333333333333333' as Address
    const word = `0x${'00'.repeat(32)}` as Hex
    const leaf = (proof: Hex) => ({ index: 4n, beneficiary: word, projectTokenCount: 1n, terminalTokenAmount: 1n, metadata: word, proof })
    // Each pair is the same user intent with only its volatile field changed (a quote, a fee, a proof, an amount to cover).
    const pairs: [string, TxRequestOf, TxRequestOf][] = [
      ['a stick, whose minimum is a quote', buildPayTx({ chainId: 10, terminal: X, projectId: 12n, token: X, amount: 5n, beneficiary: ALICE, minReturnedTokens: 9n, memo: '', metadata: '0x' }), buildPayTx({ chainId: 10, terminal: X, projectId: 12n, token: X, amount: 5n, beneficiary: ALICE, minReturnedTokens: 8n, memo: '', metadata: '0x' })],
      ['an unstick, whose minimum is a quote', buildCashOutTx({ chainId: 10, terminal: X, holder: ALICE, projectId: 12n, cashOutCount: 5n, tokenToReclaim: X, minTokensReclaimed: 9n, beneficiary: ALICE, metadata: '0x' }), buildCashOutTx({ chainId: 10, terminal: X, holder: ALICE, projectId: 12n, cashOutCount: 5n, tokenToReclaim: X, minTokensReclaimed: 8n, beneficiary: ALICE, metadata: '0x' })],
      ['an approval, whose amount covers a moving claim', { chainId: 10, address: X, abi: parseAbi(['function approve(address spender, uint256 amount)']), functionName: 'approve', args: [BOB, 5n] }, { chainId: 10, address: X, abi: parseAbi(['function approve(address spender, uint256 amount)']), functionName: 'approve', args: [BOB, 6n] }],
      ['a bridge queue, whose minimum is a quote', buildBridgePrepareTx({ chainId: 10, sucker: X, projectTokenCount: 5n, beneficiary: word, minTokensReclaimed: 9n, token: X, metadata: word }), buildBridgePrepareTx({ chainId: 10, sucker: X, projectTokenCount: 5n, beneficiary: word, minTokensReclaimed: 8n, token: X, metadata: word })],
      ['a bridge send, whose transport budget is a quote', buildToRemoteTx({ chainId: 10, sucker: X, token: X, value: 3n }), buildToRemoteTx({ chainId: 10, sucker: X, token: X, value: 4n })],
      ['a bridge claim, whose proof moves with the tree', buildBridgeClaimTx({ chainId: 10, sucker: X, claim: { token: X, leaf: leaf(word), proof: Array(32).fill(word) as never } }), buildBridgeClaimTx({ chainId: 10, sucker: X, claim: { token: X, leaf: leaf(`0x${'11'.repeat(32)}`), proof: Array(32).fill(`0x${'11'.repeat(32)}`) as never } })],
      ['a collector delivery, whose bridge fee is a quote', { chainId: 10, address: X, abi: stickySourceCollectorAbi, functionName: 'send', args: [12n, X, 0n, 5n, X, X], value: 77n }, { chainId: 10, address: X, abi: stickySourceCollectorAbi, functionName: 'send', args: [12n, X, 0n, 5n, X, X], value: 88n }],
    ]
    it.each(pairs)('holds %s by its intent, so the retry needs the explicit exit', async (_name, first, retry) => {
      mocks.writeContract.mockRejectedValueOnce(new Error('The wallet broadcast it but its RPC response was lost.'))
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(first as never, reviewedByAlice) })
      expect(hook.ref.current!.held).not.toBeNull()
      await act(async () => hook.ref.current!.reset())
      await act(async () => { await hook.ref.current!.send(retry as never, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      expect(hook.ref.current).toMatchObject({ phase: 'submitted' })
      expect(hook.ref.current!.held).not.toBeNull()
    })
    it('keeps a typed amount as the choice: a different typed amount is a different write', async () => {
      mocks.writeContract.mockRejectedValueOnce(new Error('lost'))
      const abiTransfer = parseAbi(['function transfer(address to, uint256 amount)'])
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send({ chainId: 10, address: X, abi: abiTransfer, functionName: 'transfer', args: [BOB, 5n] } as never, reviewedByAlice) })
      await act(async () => hook.ref.current!.reset())
      await act(async () => { await hook.ref.current!.send({ chainId: 10, address: X, abi: abiTransfer, functionName: 'transfer', args: [BOB, 7n] } as never, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    })

    it('keys an approval by its parent action and step, never by its amount: a revocation and another action\'s approval are their own intents', async () => {
      const abiApprove = parseAbi(['function approve(address spender, uint256 amount)'])
      const parentA = payIntent({ chainId: 10, project: 12n, beneficiary: ALICE })
      const parentB = payIntent({ chainId: 10, project: 13n, beneficiary: ALICE })
      const approve = (amount: bigint, parent: string) => ({ chainId: 10, address: X, abi: abiApprove, functionName: 'approve', args: [BOB, amount], parent })
      mocks.writeContract.mockRejectedValueOnce(new Error('lost'))
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(approve(5n, parentA) as never, reviewedByAlice) })
      await act(async () => hook.ref.current!.reset())
      // The same step of the same action, whatever the amount, is a retry.
      await act(async () => { await hook.ref.current!.send(approve(6n, parentA) as never, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      await act(async () => hook.ref.current!.reset())
      // A revocation is another step; another action's approval is another parent.
      await act(async () => { await hook.ref.current!.send(approve(0n, parentA) as never, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledTimes(2)
      await act(async () => hook.ref.current!.reset())
      await act(async () => { await hook.ref.current!.send(approve(7n, parentB) as never, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledTimes(3)
    })
    it('holds a stick by its project and beneficiary, not its amount, and treats another beneficiary as another write', async () => {
      mocks.writeContract.mockRejectedValueOnce(new Error('lost'))
      const [, first] = pairs[0]
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(first as never, reviewedByAlice) })
      await act(async () => hook.ref.current!.reset())
      const bigger = buildPayTx({ chainId: 10, terminal: X, projectId: 12n, token: X, amount: 6n, beneficiary: ALICE, minReturnedTokens: 9n, memo: '', metadata: '0x' })
      await act(async () => { await hook.ref.current!.send(bigger as never, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
      await act(async () => hook.ref.current!.reset())
      const other = buildPayTx({ chainId: 10, terminal: X, projectId: 12n, token: X, amount: 5n, beneficiary: BOB, minReturnedTokens: 9n, memo: '', metadata: '0x' })
      await act(async () => { await hook.ref.current!.send(other as never, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    })
  })

  describe('SDK 2.35 holds', () => {
    const X = '0x3333333333333333333333333333333333333333' as Address
    const stick = (min: bigint) => buildPayTx({ chainId: 10, terminal: X, projectId: 12n, token: X, amount: 5n, beneficiary: ALICE, minReturnedTokens: min, memo: '', metadata: '0x' })

    it('refuses a retry under the intent key while a main-era exact-calldata hold stands, until the exit', async () => {
      const first = stick(9n)
      // What shipped: a hold on the exact call, with no namespace.
      const mainEra = createBrowserWriteRecovery({ chainId: 10, account: ALICE, safe: false, call: { to: first.address, data: encodeFunctionData({ abi: first.abi, functionName: first.functionName, args: first.args } as never), value: first.value } })
      await mainEra.withLock(async () => { mainEra.reserve(undefined, { nonce: 7, blockNumber: 100n }) })
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(first as never, reviewedByAlice) })
      expect(mocks.writeContract).not.toHaveBeenCalled()
      expect(hook.ref.current).toMatchObject({ phase: 'submitted', held: { label: WRITE_EXIT_LABEL } })

      await act(async () => hook.ref.current!.held!.exit!())
      expect(hook.ref.current).toMatchObject({ phase: 'idle', held: null })
      await act(async () => { await hook.ref.current!.send(first as never, reviewedByAlice) })
      expect(mocks.writeContract).toHaveBeenCalledOnce()
    })

    it('shows the SDK message when a review went stale because another window sent the same intent and it already settled', async () => {
      const call = stick(9n)
      const other = createWriteHold().open({ chainId: 10, account: ALICE, safe: false, call: { to: call.address, data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never), value: call.value } })
      mocks.receipt = { data: canonicalReceipt('success'), isError: false }
      mocks.requestReview.mockImplementationOnce(async () => {
        await other.send(mocks.publicClient as never, async gate => { await gate.beforeSend(); gate.afterSubmit(HASH); return HASH })
        await other.onReceipt(canonicalReceipt('success') as never, mocks.publicClient as never)
        return true
      })
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(call as never, reviewedByAlice) })
      expect(mocks.writeContract).not.toHaveBeenCalled()
      expect(hook.ref.current).toMatchObject({ phase: 'error', error: WRITE_HOLD_STALE_REVIEW_LINE })
    })

    it('shows the in-tab notice the SDK puts on a state', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
      mocks.writeContract.mockRejectedValueOnce(new Error('The wallet broadcast it but its RPC response was lost.'))
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      expect(hook.ref.current!.held).toMatchObject({ notice: WRITE_HOLD_IN_TAB_LINE })
    })

    it('shows the in-tab notice on a normal pending write too, not only on an exit', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      expect(hook.ref.current).toMatchObject({ phase: 'pending', holdNotice: WRITE_HOLD_IN_TAB_LINE })
    })

    it('still opens the review line in a parent review when holds last only in this tab', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, reviewedInParent: true }) })
      expect(mocks.requestReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ description: expect.stringContaining(WRITE_HOLD_IN_TAB_LINE) }))
    })

    it('moves a main-era domain reservation with no SDK record into a hold with a warned, explicit exit, and never releases it itself', async () => {
      vi.useFakeTimers()
      try {
        const data = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })
        const write = { chainId: 10, owner: ALICE, to: BOB, data, value: 7n }
        const hook = await renderHook()
        // Nothing is held for it yet: main's journal never made an SDK record.
        await expect(hook.ref.current!.storedHold(write)).resolves.toBeNull()
        await act(async () => { await hook.ref.current!.adoptStored(write) })
        // Held, with the uncertainty kept; time alone never releases it.
        await act(async () => { await vi.advanceTimersByTimeAsync(60 * 60_000) })
        await expect(hook.ref.current!.storedHold(write)).resolves.toMatchObject({ exit: true })
        // Adopting twice keeps the one hold.
        await act(async () => { await hook.ref.current!.adoptStored(write) })
        expect(recoveryRecords()).toHaveLength(1)
        await expect(hook.ref.current!.exitStored(write)).resolves.toEqual({ outcome: 'released' })
        await expect(hook.ref.current!.storedHold(write)).resolves.toBeNull()
      } finally { vi.useRealTimers() }
    })

    it('adopts a hashed legacy reservation the node never knew, and offers the warned exit after 30 minutes', async () => {
      vi.useFakeTimers()
      try {
        const data = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })
        const write = { chainId: 10, owner: ALICE, to: BOB, data, value: 7n }
        mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => { throw new TransactionNotFoundError({ hash }) })
        const hook = await renderHook()
        await act(async () => { await hook.ref.current!.adoptStored({ ...write, hash: HASH, safeProposal: false }) })
        await expect(hook.ref.current!.storedHold(write)).resolves.toMatchObject({ exit: false })
        await act(async () => { await vi.advanceTimersByTimeAsync(31 * 60_000) })
        await expect(hook.ref.current!.storedHold(write)).resolves.toMatchObject({ exit: true })
        // Never released by time alone.
        expect(recoveryRecords()).toHaveLength(1)
        await expect(hook.ref.current!.exitStored(write)).resolves.toEqual({ outcome: 'released' })
      } finally { vi.useRealTimers() }
    })

    it('counts the 30 minutes from the time the legacy reservation was saved: one saved 40 minutes ago whose transaction is absent gets the warned exit at once', async () => {
      vi.useFakeTimers()
      try {
        const data = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })
        const write = { chainId: 10, owner: ALICE, to: BOB, data, value: 7n }
        mocks.publicClient.getTransaction.mockImplementation(async ({ hash }: { hash: Hex }) => { throw new TransactionNotFoundError({ hash }) })
        const hook = await renderHook()
        await act(async () => { await hook.ref.current!.adoptStored({ ...write, hash: HASH, safeProposal: false, submittedAt: Date.now() - 40 * 60_000 }) })
        await expect(hook.ref.current!.storedHold(write)).resolves.toMatchObject({ exit: true })
      } finally { vi.useRealTimers() }
    })

    it('does not take a call another tab settled between the read and the adoption', async () => {
      const data = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })
      const write = { chainId: 10, owner: ALICE, to: BOB, data, value: 7n }
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      mocks.receipt = { data: canonicalReceipt('success'), isError: false }
      const other = createWriteHold().open({ chainId: 10, account: ALICE, safe: false, call: { to: BOB, data, value: 7n } })
      await other.onReceipt(canonicalReceipt('success') as never, mocks.publicClient as never)
      // A settlement stands: adopting does not hold the call again.
      await act(async () => { await hook.ref.current!.adoptStored({ ...write, hash: HASH }) })
      await expect(hook.ref.current!.storedHold(write)).resolves.toEqual({ settled: { result: 'success', hash: HASH } })
    })

    it('holds a retry under the intent key against a main-era hold with different calldata and the same call target', async () => {
      const first = buildPayTx({ chainId: 10, terminal: X, projectId: 12n, token: X, amount: 5n, beneficiary: ALICE, minReturnedTokens: 9n, memo: '', metadata: '0x' })
      const retry = buildPayTx({ chainId: 10, terminal: X, projectId: 12n, token: X, amount: 5n, beneficiary: ALICE, minReturnedTokens: 8n, memo: '', metadata: '0x' })
      // What shipped on main: an exact-call hold with the first quote's calldata, no namespace.
      const mainEra = createBrowserWriteRecovery({ chainId: 10, account: ALICE, safe: false, call: { to: first.address, data: encodeFunctionData({ abi: first.abi, functionName: first.functionName, args: first.args } as never), value: first.value } })
      await mainEra.withLock(async () => { mainEra.reserve(undefined, { nonce: 7, blockNumber: 100n }) })
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(retry as never, reviewedByAlice) })
      expect(mocks.writeContract).not.toHaveBeenCalled()
      expect(hook.ref.current!.held).not.toBeNull()
    })

    it('ignores a newer reservation it did not start', async () => {
      vi.useFakeTimers()
      try {
        mocks.writeContract.mockRejectedValueOnce(new Error('lost'))
        const hook = await renderHook()
        await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
        const exit = hook.ref.current!.held!.exit!
        // Another window abandons this attempt and reserves a new one.
        const data = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })
        const other = createWriteHold().open({ chainId: 10, account: ALICE, safe: false, call: { to: BOB, data, value: 7n } })
        const seen = await other.state(mocks.publicClient as never)
        await other.exit(seen, { checkedWallet: true }, mocks.publicClient as never)
        await other.send(mocks.publicClient as never, async gate => { await gate.beforeSend(); throw new Error('lost') }).catch(() => undefined)
        await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
        await act(async () => exit())
        // This tab never saw the newer attempt, so its exit cannot release it.
        const stillHeld = Object.keys(localStorage).filter(key => key.startsWith('nana-sdk:reviewed-write:') && !key.endsWith(':settled') && !key.endsWith(':latest')).length
        expect(stillHeld).toBeGreaterThan(0)
        expect(mocks.writeContract).toHaveBeenCalledOnce()
        await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
        expect(mocks.writeContract).toHaveBeenCalledOnce()
      } finally { vi.useRealTimers() }
    })
  })

  describe('an exit and where it comes from', () => {
    it('renders no exit from a cross-tab emission, and renders it once a state(client) read allows one', async () => {
      vi.useFakeTimers()
      try {
        const callData = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })
        // This tab's wallet refuses: nothing is held here.
        mocks.writeContract.mockRejectedValueOnce(new UserRejectedRequestError(new Error('The wallet did not send it.')))
        const hook = await renderHook()
        await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
        expect(hook.ref.current).toMatchObject({ phase: 'error', held: null })

        // Another tab reserves the same call and loses its wallet reply.
        const otherTab = createWriteHold().open({ chainId: 10, account: ALICE, safe: false, call: { to: BOB, data: callData, value: 7n } })
        await otherTab.send(mocks.publicClient as never, async gate => { await gate.beforeSend(); throw new Error('lost') }).catch(() => undefined)

        // The storage notification reaches this tab: a replayed state, never an exit.
        await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'nana-sdk:reviewed-write:v2:probe' })) })
        expect(hook.ref.current!.held).toBeNull()

        // The next state(client) read is the gate, and it allows the exit.
        await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
        expect(hook.ref.current!.held).toMatchObject({ label: WRITE_EXIT_LABEL })
        expect(hook.ref.current!.held!.exit).toBeTypeOf('function')
        expect(mocks.writeContract).toHaveBeenCalledOnce()
      } finally { vi.useRealTimers() }
    })
  })

  describe('a pending write another tab settled', () => {
    const callData = encodeFunctionData({ abi: ABI, functionName: 'transfer', args: [BOB, 5n] })
    /** Tab B verifies the receipt with its own client and settles the hold; tab A's local receipt reads stay unavailable. */
    async function settledElsewhere() {
      mocks.receipt = { data: undefined, isError: true }
      mocks.publicClient.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => { throw new TransactionReceiptNotFoundError({ hash }) })
      const tabB = { ...mocks.publicClient, getTransactionReceipt: async () => canonicalReceipt('success') }
      const handle = createWriteHold().open({ chainId: 10, account: ALICE, safe: false, call: { to: BOB, data: callData, value: 7n } })
      const result = await handle.onReceipt(canonicalReceipt('success') as never, tabB as never)
      expect(result).toMatchObject({ status: 'clear', settled: { result: 'success', hash: HASH } })
    }
    it('finishes an ordinary pending write on the settlement hash, whatever the previous state offered', async () => {
      vi.useFakeTimers()
      try {
        const hook = await renderHook()
        await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
        expect(hook.ref.current).toMatchObject({ phase: 'pending', busy: true })
        await settledElsewhere()
        await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
        expect(hook.ref.current).toMatchObject({ phase: 'success', busy: false, hash: HASH })
        expect(mocks.writeContract).toHaveBeenCalledOnce()
      } finally { vi.useRealTimers() }
    })
    it('hands a domain-journaled write the settlement, once, and does not abandon it', async () => {
      vi.useFakeTimers()
      try {
        const journal = { reserve: vi.fn(), releaseUnsubmitted: vi.fn(), submitted: vi.fn(), released: vi.fn(), settled: vi.fn() }
        const hook = await renderHook()
        await act(async () => { await hook.ref.current!.send(request, { ...reviewedByAlice, durableRecovery: journal }) })
        await settledElsewhere()
        await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
        await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
        expect(journal.settled).toHaveBeenCalledOnce()
        expect(journal.settled).toHaveBeenCalledWith({ hash: HASH, result: 'success' })
        expect(journal.released).not.toHaveBeenCalled()
      } finally { vi.useRealTimers() }
    })
  })

  it('still holds and sends where the browser has no Web Locks', async () => {
    vi.stubGlobal('navigator', { locks: undefined })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: HASH })
  })

  it('repairs a returned hash after storage recovers without submitting twice', async () => {
    vi.useFakeTimers()
    try {
      const original = Storage.prototype.setItem
      let storageBroken = true
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (storageBroken && JSON.parse(value).hash) throw new Error('Storage became unavailable')
        original.call(this, key, value)
      })
      const hook = await renderHook()
      await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
      expect(hook.ref.current!.hash).toBe(HASH)
      expect(recoveryRecords()[0].hash).toBeUndefined()
      storageBroken = false
      mocks.receipt = { data: canonicalReceipt('success'), isError: false }
      await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
      expect(recoveryRecords()).toHaveLength(0)
      expect(hook.ref.current!.phase).toBe('success')
      expect(mocks.writeContract).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('keeps a noncanonical receipt pending and retains its durable record', async () => {
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    mocks.publicClient.getBlock.mockResolvedValue({ number: 77n, hash: EXECUTION_HASH })
    mocks.receipt = { data: canonicalReceipt('success'), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current!.phase).toBe('pending')
    expect(recoveryRecords()).toHaveLength(1)
  })

  it('holds a reverted write until finality proves its failure', async () => {
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    mocks.publicClient.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber?: bigint }) => ({
      number: blockNumber ?? 76n, hash: BLOCK_HASH, timestamp: 1_000n,
    }))
    mocks.receipt = { data: canonicalReceipt('reverted'), isError: false }
    await act(async () => { hook.renderer.update(createElement(Harness, { ref: hook.ref })) })
    expect(hook.ref.current!.phase).toBe('submitted')
    expect(recoveryRecords()).toHaveLength(1)
  })

  it.each(['reset', 'unmount'] as const)('does not write after %s closes an outstanding review', async close => {
    let finish!: (accepted: boolean) => void
    mocks.requestReview.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve }))
    const hook = await renderHook()
    let pending!: Promise<Hex | null>
    await act(async () => { pending = hook.ref.current!.send(request, reviewedByAlice); await Promise.resolve() })
    await act(async () => { if (close === 'reset') hook.ref.current!.reset(); else hook.renderer.unmount() })
    await act(async () => { finish(true); await pending })
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(recoveryRecords()).toHaveLength(0)
  })

  it('awaits a typed domain hash handoff while the SDK hold keeps the same write beside the journal', async () => {
    const events: string[] = []
    mocks.writeContract.mockImplementationOnce(async () => {
      events.push('write')
      expect(recoveryRecords()).toHaveLength(1)
      return HASH
    })
    const hook = await renderHook()
    await act(async () => {
      await hook.ref.current!.send(request, { ...reviewedByAlice, durableRecovery: {
        reserve: () => { events.push('reserve') },
        releaseUnsubmitted: () => { events.push('released') },
        submitted: async (hash, safe) => {
          expect(hash).toBe(HASH)
          expect(safe).toBe(false)
          await Promise.resolve()
          events.push('stored')
        },
      } })
      events.push('returned')
    })
    expect(events).toEqual(['reserve', 'write', 'stored', 'returned'])
  })

  it('returns a known hash after a domain storage failure without invoking rejection cleanup', async () => {
    const releaseUnsubmitted = vi.fn()
    const hook = await renderHook()
    let returned: Hex | null = null
    await act(async () => {
      returned = await hook.ref.current!.send(request, { ...reviewedByAlice, durableRecovery: {
        reserve: vi.fn(), releaseUnsubmitted,
        submitted: () => { throw { code: 4001, message: 'Storage callback failed' } },
      } })
    })
    expect(returned).toBe(HASH)
    expect(hook.ref.current).toMatchObject({ phase: 'pending', submissionHash: HASH })
    expect(releaseUnsubmitted).not.toHaveBeenCalled()
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('persists a wallet reply received after reset without reopening the old review', async () => {
    let reply!: (hash: Hex) => void
    mocks.writeContract.mockImplementationOnce(() => new Promise<Hex>(resolve => { reply = resolve }))
    const hook = await renderHook()
    let pending!: Promise<Hex | null>
    await act(async () => { pending = hook.ref.current!.send(request, reviewedByAlice) })
    await act(async () => { hook.ref.current!.reset() })
    await act(async () => { reply(HASH); await pending })
    expect(hook.ref.current!.phase).toBe('idle')
    expect(recoveryRecords()[0].hash).toBe(HASH)
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(hook.ref.current!.submissionHash).toBe(HASH)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
  })

  it('keeps account scopes independent while retaining the original account’s unknown write', async () => {
    mocks.writeContract.mockRejectedValueOnce(new Error('Lost response after broadcast'))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    mocks.account = BOB
    await act(async () => { await hook.ref.current!.send(request, { reviewedAccount: BOB }) })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    expect(recoveryRecords()).toHaveLength(2)
    expect(recoveryRecords().find(record => record.account === ALICE)?.hash).toBeUndefined()
  })

  it('releases only an explicitly rejected reservation before a new review', async () => {
    mocks.writeContract.mockRejectedValueOnce(new UserRejectedRequestError(new Error('Declined')))
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(recoveryRecords()).toHaveLength(0)
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
    expect(recoveryRecords()[0].hash).toBe(HASH)
  })

  it.each(['reset', 'unmount'] as const)('refuses the final wallet write when %s occurs during readiness verification', async close => {
    let release!: () => void
    const reverify = () => new Promise<void>(resolve => { release = resolve })
    const hook = await renderHook()
    let pending!: Promise<Hex | null>
    await act(async () => { pending = hook.ref.current!.send(request, { ...reviewedByAlice, reverify }) })
    await act(async () => { if (close === 'reset') hook.ref.current!.reset(); else hook.renderer.unmount() })
    await act(async () => { release(); await pending })
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(recoveryRecords()).toHaveLength(0)
  })

  it('saves an older wallet reply without replacing a newer action’s visible hash', async () => {
    let reply!: (hash: Hex) => void
    mocks.writeContract.mockImplementationOnce(() => new Promise<Hex>(resolve => { reply = resolve }))
    const hook = await renderHook()
    let pending!: Promise<Hex | null>
    await act(async () => { pending = hook.ref.current!.send(request, reviewedByAlice) })
    await act(async () => { hook.ref.current!.reset() })
    mocks.writeContract.mockResolvedValueOnce(EXECUTION_HASH)
    await act(async () => {
      await hook.ref.current!.send({ ...request, abi: parseAbi(['function approve(address spender,uint256 amount)']), functionName: 'approve' }, reviewedByAlice)
    })
    await act(async () => { reply(HASH); await pending })
    expect(hook.ref.current).toMatchObject({ phase: 'pending', hash: EXECUTION_HASH })
    expect(recoveryRecords().map(record => record.hash).sort()).toEqual([HASH, EXECUTION_HASH].sort())
    expect(mocks.writeContract).toHaveBeenCalledTimes(2)
  })

})
