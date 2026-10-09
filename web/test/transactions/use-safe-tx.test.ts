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
import { SAFE_EXEC_ABI } from '@bananapus/nana-sdk-core/safe-service'
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
  publicClient: { simulateContract: vi.fn(), estimateContractGas: vi.fn(), getTransaction: vi.fn(), getChainId: vi.fn(), getBlock: vi.fn(), getTransactionReceipt: vi.fn() },
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
const recoveryRecords = () => Object.keys(localStorage).filter(key => key.startsWith('nana-sdk:reviewed-write:')).map(key => JSON.parse(localStorage.getItem(key)!))
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
  mocks.publicClient.simulateContract.mockResolvedValue({
    request: { address: BOB, functionName: 'transfer', gas: 100n },
  })
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  mocks.writeContract.mockResolvedValue(HASH)
})

describe('useSafeTx', () => {
  it('keeps a broadcast with a lost wallet reply held through reset and remount, including a changed amount', async () => {
    let recipientBalance = 0n
    mocks.writeContract.mockImplementationOnce(async () => {
      recipientBalance += 5n
      throw new Error('The wallet broadcast the transfer but its RPC response was lost.')
    })
    const first = await renderHook()
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    expect(first.ref.current).toMatchObject({ phase: 'submitted', busy: false, hash: null })
    expect(first.ref.current!.notice).toMatch(/may have been submitted/i)
    await act(async () => first.ref.current!.reset())
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    await act(async () => first.renderer.unmount())

    const second = await renderHook()
    await act(async () => { await second.ref.current!.send({ ...request, args: [BOB, 6n] }, reviewedByAlice) })
    expect(second.ref.current).toMatchObject({ phase: 'submitted', hash: null })
    expect(mocks.writeContract).toHaveBeenCalledOnce()
    expect(recipientBalance).toBe(5n)
    await act(async () => second.renderer.unmount())
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
    expect(hook.ref.current!.error).toMatch(/do not submit it again/i)
    await act(async () => {
      await expect(hook.ref.current!.send(request, reviewedByAlice)).resolves.toBeNull()
    })
    expect(mocks.requestReview).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['success', 'success', null],
    ['reverted', 'error', /reverted onchain/i],
  ] as const)(
    'treats a %s receipt as a terminal state',
    async (status, phase, error) => {
      const hook = await renderHook()
      await act(async () => {
        await hook.ref.current!.send(request, reviewedByAlice)
      })

      mocks.receipt = { data: canonicalReceipt(status), isError: false }
      await act(async () => {
        hook.renderer.update(createElement(Harness, { ref: hook.ref }))
      })

      expect(hook.ref.current).toMatchObject({ phase, busy: false })
      if (error) expect(hook.ref.current!.error).toMatch(error)
      else expect(hook.ref.current!.error).toBeNull()
    },
  )

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

  it('refuses a wallet write if the durable marker cannot be retained', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable') })
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(hook.ref.current!.phase).toBe('error')
  })

  it('refuses a wallet write without cross-tab exclusion', async () => {
    vi.stubGlobal('navigator', { locks: undefined })
    const hook = await renderHook()
    await act(async () => { await hook.ref.current!.send(request, reviewedByAlice) })
    expect(mocks.writeContract).not.toHaveBeenCalled()
    expect(hook.ref.current!.error).toMatch(/coordinate wallet writes/i)
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

  it('recovers a prior different amount without attributing its success to the new request', async () => {
    const first = await renderHook()
    await act(async () => { await first.ref.current!.send(request, reviewedByAlice) })
    await act(async () => { first.renderer.unmount() })
    const reopened = await renderHook()
    await act(async () => { await reopened.ref.current!.send({ ...request, args: [BOB, 6n] }, reviewedByAlice) })
    mocks.receipt = { data: canonicalReceipt('success'), isError: false }
    await act(async () => { reopened.renderer.update(createElement(Harness, { ref: reopened.ref })) })
    expect(reopened.ref.current!.phase).toBe('submitted')
    expect(reopened.ref.current!.notice).toMatch(/earlier transaction is confirmed/i)
    expect(recoveryRecords()).toHaveLength(0)
    expect(mocks.writeContract).toHaveBeenCalledOnce()
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

  it('awaits a typed domain hash handoff and does not open a second generic journal', async () => {
    const events: string[] = []
    mocks.writeContract.mockImplementationOnce(async () => {
      events.push('write')
      expect(recoveryRecords()).toHaveLength(0)
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
    expect(recoveryRecords().find(record => record.account === ALICE).hash).toBeUndefined()
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
