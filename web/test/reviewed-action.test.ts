/**
 * useReviewedAction, Sticky's one reviewed-send hook over core's useReviewedRun,
 * sends exactly the bytes useSafeTx sent (the committed baseline in
 * test/fixtures/use-safe-tx-calldata.json) and keeps each write's intent and
 * legacy hold namespaces.
 */

import { QueryClient } from '@tanstack/react-query'
import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { decodeFunctionData, encodeFunctionData, erc20Abi, numberToHex, type Abi, type Address, type Hex } from 'viem'
import { jbMultiTerminalAbi } from '@bananapus/nana-sdk-core'
import { registerReviewHandler, ReviewLineError, type ReviewedCall } from '@bananapus/nana-sdk-core/review'
import { afterEach, describe, expect, it, vi } from 'vitest'
import baseline from './fixtures/use-safe-tx-calldata.json'

const ALICE = '0x2222222222222222222222222222222222222222' as Address

const displayQueries = new QueryClient()
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => displayQueries,
}))

/** One chain whose sends are mined in the next block; eth_call always succeeds. */
const chain = vi.hoisted(() => {
  const state = { head: 100n, nonce: 7, mined: new Map<string, bigint>(), sent: new Map<string, { to: string; data: string; value: bigint; nonce: number }>() }
  return { state }
})

function receipt(hash: Hex) {
  return {
    transactionHash: hash,
    blockNumber: chain.state.mined.get(hash)!,
    blockHash: numberToHex(chain.state.mined.get(hash)!, { size: 32 }),
    status: 'success',
    transactionIndex: 0,
    from: ALICE,
    to: chain.state.sent.get(hash)?.to,
    logs: [],
  }
}

const client = {
  chain: { id: 84532, name: 'Base Sepolia' },
  request: vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_call') return '0x'
    if (method === 'eth_getBlockByNumber') return { number: numberToHex(chain.state.head), hash: numberToHex(chain.state.head, { size: 32 }) }
    throw new Error(`unexpected ${method}`)
  }),
  estimateGas: vi.fn(async () => 21_000n),
  readContract: vi.fn(async () => { throw new Error('no token reads here') }),
  getChainId: vi.fn(async () => 84532),
  getBlockNumber: vi.fn(async () => chain.state.head),
  getTransactionCount: vi.fn(async () => chain.state.nonce),
  getBlock: vi.fn(async ({ blockNumber }: { blockNumber?: bigint } = {}) => ({ number: blockNumber ?? chain.state.head, hash: numberToHex(blockNumber ?? chain.state.head, { size: 32 }), timestamp: 1_000n, transactions: [] })),
  getTransaction: vi.fn(async ({ hash }: { hash: Hex }) => {
    const tx = chain.state.sent.get(hash)
    if (!tx) throw Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' })
    const block = chain.state.mined.get(hash)!
    return { hash, chainId: 84532, from: ALICE, to: tx.to, input: tx.data, value: tx.value, nonce: tx.nonce, blockNumber: block, blockHash: numberToHex(block, { size: 32 }), transactionIndex: 0 }
  }),
  getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => receipt(hash)),
  waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hex }) => receipt(hash)),
}

/** What the wallet was asked to send, in order. */
const walletSends: { chainId: number; to: Address; data: Hex; value: bigint }[] = []
const walletClient = {
  chain: { id: 84532 },
  sendTransaction: vi.fn(async (tx: { chain: { id: number }; to: Address; data: Hex; value: bigint }) => {
    walletSends.push({ chainId: tx.chain.id, to: tx.to, data: tx.data, value: tx.value })
    const hash = `0x${walletSends.length.toString(16).padStart(64, '0')}` as Hex
    chain.state.sent.set(hash, { ...tx, nonce: chain.state.nonce })
    chain.state.head += 1n
    chain.state.nonce += 1
    chain.state.mined.set(hash, chain.state.head)
    return hash
  }),
}

let currentWallet = walletClient
let connectedAccount: Address = ALICE
let acquireWallet = async () => currentWallet

vi.mock('@wagmi/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@wagmi/core')>()),
  getAccount: () => ({ address: connectedAccount, chainId: 84532, connector: { uid: 'test', id: 'test' } }),
  getWalletClient: async () => (await import('./support/viem-wallet')).viemWallet(await acquireWallet(), () => 84532),
  getPublicClient: () => client,
  switchChain: vi.fn(),
}))
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x2222222222222222222222222222222222222222', chainId: 84532 }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: '0x2222222222222222222222222222222222222222', isCenterWallet: false }),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
}))

import { useReviewedAction } from '@/hooks/useReviewedAction'
import { holdIntent } from '@/lib/sticky-hold-intent'
import { holds } from '@/lib/write-holds'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

type Action = ReturnType<typeof useReviewedAction>
const Harness = forwardRef<Action>(function Harness(_, ref) {
  const value = useReviewedAction()
  useImperativeHandle(ref, () => value, [value])
  return null
})

const unregister: (() => void)[] = []
afterEach(() => {
  while (unregister.length) unregister.pop()!()
  currentWallet = walletClient
  connectedAccount = ALICE
  acquireWallet = async () => currentWallet
  client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => receipt(hash))
  walletSends.length = 0
  walletClient.sendTransaction.mockClear()
  clearViewAs()
})

/** The review UI confirms every prompt. */
function confirmEveryReview() {
  unregister.push(registerReviewHandler(async prompt => prompt.confirmation))
}


async function mount() {
  const ref = createRef<Action>()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { ref }))
  })
  return { ref, unmount: () => act(async () => renderer.unmount()) }
}

async function runOnce(call: Parameters<Action['run']>[0]) {
  const ref = createRef<Action>()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { ref }))
  })
  let result: Awaited<ReturnType<Action['run']>> = null
  await act(async () => {
    result = await ref.current!.run(call)
  })
  await act(async () => renderer.unmount())
  return result as Awaited<ReturnType<Action['run']>>
}

describe('useReviewedAction', () => {
  it('sends the same calldata as useSafeTx for a stick, an unstick, a transfer, a trust, an airdrop and a settle', async () => {
    confirmEveryReview()
    for (const [name, sent] of Object.entries(baseline)) {
      const result = await runOnce({ account: ALICE, calls: [{ chainId: sent.chainId, to: sent.to as Address, data: sent.data as Hex, value: BigInt(sent.value) }] })
      expect(result?.status, name).toBe('done')
      const wallet = walletSends.at(-1)!
      expect({ chainId: wallet.chainId, to: wallet.to.toLowerCase(), data: wallet.data, value: String(wallet.value) }, name).toEqual({
        chainId: sent.chainId,
        to: sent.to.toLowerCase(),
        data: sent.data,
        value: sent.value,
      })
    }
  })

  it('keeps intent and legacy hold namespaces', async () => {
    confirmEveryReview()
    const { stick } = baseline
    const decoded = decodeFunctionData({ abi: jbMultiTerminalAbi as Abi, data: stick.data as Hex })
    const intent = holdIntent({ chainId: stick.chainId, address: stick.to as Address, functionName: decoded.functionName, args: decoded.args ?? [] }, ALICE)!
    const legacy = ['sticky-stick-legacy-key']
    const call = { chainId: stick.chainId, to: stick.to as Address, data: stick.data as Hex, value: 0n, intent, legacy }
    expect((await runOnce({ account: ALICE, calls: [call] }))?.status).toBe('done')
    // The send was held under its intent: the same intent, with another call, sees its settlement.
    const byIntent = holds.open(
      { chainId: stick.chainId, account: ALICE, safe: false, namespace: intent, call: { to: stick.to as Address, data: '0x', value: 0n } },
      { legacy },
    )
    const state = byIntent.peek()
    expect(state.status === 'clear' && state.settled?.result).toBe('success')
  })

  it.each(['review state', 'View as'] as const)('reruns the final %s guard after wallet acquisition and clears only the unsent attempt', async kind => {
    confirmEveryReview()
    const { stick } = baseline
    const entered = Promise.withResolvers<void>()
    const waiting = Promise.withResolvers<typeof walletClient>()
    acquireWallet = () => { entered.resolve(); return waiting.promise }
    let fresh = true
    const onUnsent = vi.fn(async () => {})
    const { ref, unmount } = await mount()
    let running!: ReturnType<Action['run']>
    await act(async () => {
      running = ref.current!.run({ account: ALICE, calls: [{ chainId: stick.chainId, to: stick.to as Address, data: stick.data as Hex }], onUnsent,
        assertWriteState: () => { if (!fresh) throw new ReviewLineError('This review expired. Review again.') },
      })
      await entered.promise
    })
    if (kind === 'View as') setViewAs('0x3333333333333333333333333333333333333333')
    else fresh = false
    await act(async () => { waiting.resolve(walletClient); await running })
    expect(walletSends).toEqual([])
    expect(onUnsent).toHaveBeenCalledOnce()
    expect(ref.current!.held).toBeNull()
    expect(ref.current!.error).toBe(kind === 'View as' ? VIEW_AS_WRITE_BLOCKED : 'This review expired. Review again.')
    await unmount()
  })

  it('clears the SDK hold and journal on a proven acquisition abort, preserving the actual UI reason', async () => {
    confirmEveryReview()
    const { stick } = baseline
    const entered = Promise.withResolvers<void>()
    const waiting = Promise.withResolvers<typeof walletClient>()
    acquireWallet = () => { entered.resolve(); return waiting.promise }
    const onUnsent = vi.fn(async () => {})
    const { ref, unmount } = await mount()
    let running!: ReturnType<Action['run']>
    await act(async () => {
      running = ref.current!.run({ account: ALICE, calls: [{ chainId: stick.chainId, to: stick.to as Address, data: stick.data as Hex }], onUnsent })
      await entered.promise
    })
    connectedAccount = '0x3333333333333333333333333333333333333333'
    await act(async () => { waiting.resolve(walletClient); await running })
    expect(walletSends).toEqual([])
    expect(onUnsent).toHaveBeenCalledOnce()
    expect(ref.current!.held).toBeNull()
    expect(ref.current!.error).toBe('The connected account changed. Review again.')
    await unmount()
  })

  it.each(['direct', 'approval'] as const)('uses the current same-account wallet after awaited %s preparation', async kind => {
    confirmEveryReview()
    const { stick } = baseline
    const prepared = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const replacement = { ...walletClient, sendTransaction: vi.fn(walletClient.sendTransaction) }
    const data = kind === 'approval'
      ? encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [stick.to as Address, 10n] })
      : stick.data as Hex
    const { ref, unmount } = await mount()
    let running!: ReturnType<Action['run']>
    await act(async () => {
      running = ref.current!.run({
        account: ALICE,
        calls: [{ chainId: stick.chainId, to: stick.to as Address, data, value: 0n }],
        beforeWallet: async () => { entered.resolve(); await prepared.promise },
      })
      await entered.promise
    })
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
    currentWallet = replacement
    await act(async () => { prepared.resolve(); await running })
    expect(replacement.sendTransaction).toHaveBeenCalledOnce()
    expect(replacement.sendTransaction.mock.calls[0][0]).toMatchObject({ account: ALICE, chain: { id: stick.chainId }, data })
    expect(ref.current!.phase).toBe('success')
    await unmount()
  })

  it('runs every step under one review: each reverified at the block the one before confirmed in, journaled around its send, and counted', async () => {
    confirmEveryReview()
    const { stick, unstick } = baseline
    const calls = [stick, unstick].map((sent, at) => ({ chainId: sent.chainId, to: sent.to as Address, data: sent.data as Hex, value: BigInt(sent.value), ...(at ? { dependsOnPrior: true } : {}) }))
    const seen: string[] = []
    const reverify = vi.fn(async (_call: ReviewedCall, _index: number, _confirmedAt?: bigint) => {})
    const { ref, unmount } = await mount()
    let result: Awaited<ReturnType<Action['run']>> = null
    await act(async () => {
      result = await ref.current!.run({
        account: ALICE,
        calls,
        reverify,
        beforeWallet: async (_call, step) => void seen.push(`before ${step}`),
        onUnsent: async (_call, step) => void seen.push(`unsent ${step}`),
        onSubmitted: async (_call, step, hash) => void seen.push(`submitted ${step} ${hash}`),
      })
    })
    expect(result!.status).toBe('done')
    const hashes = (result as unknown as { hashes: Hex[] }).hashes
    expect(seen).toEqual([`before 0`, `submitted 0 ${hashes[0]}`, `before 1`, `submitted 1 ${hashes[1]}`])
    expect(reverify.mock.calls.map(([, index, confirmedAt]) => [index, confirmedAt])).toEqual([
      [0, undefined],
      [1, chain.state.mined.get(hashes[0])],
    ])
    expect(ref.current!.landed).toBe(2)
    expect(ref.current!.phase).toBe('success')
    expect(ref.current!.hash).toBe(hashes[1])
    await unmount()
  })

  it('keeps a confirmed step counted when the run resumed after it fails again', async () => {
    confirmEveryReview()
    const { stick, unstick } = baseline
    const calls = [stick, unstick].map((sent, at) => ({ chainId: sent.chainId, to: sent.to as Address, data: sent.data as Hex, value: BigInt(sent.value), ...(at ? { dependsOnPrior: true } : {}) }))
    const reverify = vi.fn(async (_call: ReviewedCall, index: number) => {
      if (index === 1) throw new ReviewLineError('The unstick changed. Review it again.')
    })
    const { ref, unmount } = await mount()
    for (let attempt = 0; attempt < 2; attempt++) {
      await act(async () => {
        expect(await ref.current!.run({ account: ALICE, calls, reverify })).toBeNull()
      })
      expect(ref.current!.error).toBe('The unstick changed. Review it again.')
      expect(ref.current!.landed).toBe(1)
    }
    expect(walletSends).toHaveLength(1)
    await unmount()
  })

  it('continues a sequence whose step the site could not record once its hold settles it, in the same run', async () => {
    confirmEveryReview()
    const { stick, unstick } = baseline
    const calls = [stick, unstick].map((sent, at) => ({ chainId: sent.chainId, to: sent.to as Address, data: sent.data as Hex, value: BigInt(sent.value), ...(at ? { dependsOnPrior: true } : {}) }))
    // Each step's journal fails once it is sent: core holds that step unverified, its follower finds it mined, and the
    // run goes on to the next step without another send of it.
    const onSubmitted = vi.fn(async () => { throw new ReviewLineError('The launch record could not be saved.') })
    const { ref, unmount } = await mount()
    let result: Awaited<ReturnType<Action['run']>> = null
    await act(async () => {
      result = await ref.current!.run({ account: ALICE, calls, onSubmitted })
    })
    expect(result!.status).toBe('done')
    expect(walletSends).toHaveLength(2)
    expect(ref.current!.landed).toBe(2)
    expect(ref.current!.phase).toBe('success')
    await unmount()
  })

  it('keeps a send whose receipt is still confirming pending, and returns done once its hold verifies it', async () => {
    confirmEveryReview()
    client.getTransactionReceipt.mockImplementation(async () => { throw new Error('lagging node') })
    const { ref, unmount } = await mount()
    const { stick } = baseline
    let ended: unknown = 'pending'
    await act(async () => {
      void ref.current!.run({ account: ALICE, calls: [{ chainId: stick.chainId, to: stick.to as Address, data: stick.data as Hex, value: BigInt(stick.value), intent: `lag-${crypto.randomUUID()}` }] })
        .then(value => { ended = value })
    })
    await vi.waitFor(() => expect(ref.current!.phase).toBe('pending'))
    expect(ended).toBe('pending')
    client.getTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hex }) => receipt(hash))
    // The hold's next look, a few seconds on, verifies it.
    await act(async () => { await vi.waitFor(() => expect(ended).not.toBe('pending'), { timeout: 15_000, interval: 100 }) })
    expect(ended).toMatchObject({ status: 'done', hashes: [expect.any(String)] })
    expect(ref.current!.phase).toBe('success')
    await unmount()
  }, 20_000)

  it('sends no later step once the page that ran it has gone, and frees that step', async () => {
    confirmEveryReview()
    const { stick, unstick } = baseline
    const calls = [stick, unstick].map((sent, at) => ({ chainId: sent.chainId, to: sent.to as Address, data: sent.data as Hex, value: BigInt(sent.value), ...(at ? { dependsOnPrior: true } : {}) }))
    const onUnsent = vi.fn(async () => {})
    const { ref, unmount } = await mount()
    // The page closes while the first step confirms.
    const confirming = Promise.withResolvers<void>()
    client.waitForTransactionReceipt.mockImplementationOnce(async ({ hash }: { hash: Hex }) => {
      await confirming.promise
      return receipt(hash)
    })
    let running!: ReturnType<Action['run']>
    await act(async () => {
      running = ref.current!.run({ account: ALICE, calls, onUnsent })
      await vi.waitFor(() => expect(walletSends).toHaveLength(1))
    })
    await unmount()
    confirming.resolve()
    expect(await running).toBeNull()
    expect(walletSends).toHaveLength(1)
    expect(onUnsent).toHaveBeenCalledExactlyOnceWith(expect.anything(), 1)
  })

  it('sends the same steps again once the person released a step the wallet left uncertain', async () => {
    confirmEveryReview()
    const { stick, unstick } = baseline
    const calls = [stick, unstick].map((sent, at) => ({ chainId: sent.chainId, to: sent.to as Address, data: sent.data as Hex, value: BigInt(sent.value), ...(at ? { dependsOnPrior: true } : {}) }))
    const onUnsent = vi.fn(async () => {})
    walletClient.sendTransaction.mockRejectedValueOnce(new Error('Connection lost after sending'))
    const { ref, unmount } = await mount()
    await act(async () => {
      expect(await ref.current!.run({ account: ALICE, calls, onUnsent })).toBeNull()
    })
    expect(ref.current!.held?.exit).toBeTypeOf('function')
    expect(onUnsent).not.toHaveBeenCalled()
    // The person checked their wallet: nothing went out.
    await act(async () => ref.current!.held!.exit!())
    await vi.waitFor(() => expect(ref.current!.held).toBeNull())
    let result: Awaited<ReturnType<Action['run']>> = null
    await act(async () => {
      result = await ref.current!.run({ account: ALICE, calls, onUnsent })
    })
    expect(result!.status).toBe('done')
    expect(walletSends).toHaveLength(2)
    await unmount()
  })

  it('calls onCancelled, and sends nothing, when the review is closed', async () => {
    unregister.push(registerReviewHandler(async () => null))
    const onCancelled = vi.fn()
    const { stick } = baseline
    const { ref, unmount } = await mount()
    await act(async () => {
      expect(await ref.current!.run({ account: ALICE, calls: [{ chainId: stick.chainId, to: stick.to as Address, data: stick.data as Hex }], onCancelled })).toBeNull()
    })
    expect(onCancelled).toHaveBeenCalledOnce()
    expect(walletSends).toEqual([])
    expect(ref.current!.phase).toBe('idle')
    expect(ref.current!.error).toBeNull()
    await unmount()
  })

  it('frees a step the wallet refused (4001) through onUnsent, and reads it as a cancel', async () => {
    confirmEveryReview()
    walletClient.sendTransaction.mockRejectedValueOnce(Object.assign(new Error('User rejected the request.'), { code: 4001 }))
    const onUnsent = vi.fn(async () => {})
    const onCancelled = vi.fn()
    const { stick } = baseline
    const { ref, unmount } = await mount()
    await act(async () => {
      expect(await ref.current!.run({ account: ALICE, calls: [{ chainId: stick.chainId, to: stick.to as Address, data: stick.data as Hex }], onUnsent, onCancelled })).toBeNull()
    })
    expect(onUnsent).toHaveBeenCalledOnce()
    expect(onCancelled).toHaveBeenCalledOnce()
    await unmount()
  })

  it('refuses a write in View as before its review, with the reason and no cancel', async () => {
    const review = vi.fn(async () => null)
    unregister.push(registerReviewHandler(review))
    setViewAs(`0x${'b2'.repeat(20)}`)
    const onCancelled = vi.fn()
    const { stick } = baseline
    const { ref, unmount } = await mount()
    await act(async () => {
      expect(await ref.current!.run({ account: ALICE, calls: [{ chainId: stick.chainId, to: stick.to as Address, data: stick.data as Hex }], onCancelled })).toBeNull()
    })
    expect(review).not.toHaveBeenCalled()
    expect(ref.current!.error).toBe(VIEW_AS_WRITE_BLOCKED)
    expect(onCancelled).not.toHaveBeenCalled()
    await unmount()
  })
})
