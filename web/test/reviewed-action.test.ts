/**
 * useReviewedAction, Sticky's one reviewed-send hook over core's useReviewedRun,
 * sends exactly the bytes useSafeTx sent (the committed baseline in
 * test/fixtures/use-safe-tx-calldata.json) and keeps each write's intent and
 * legacy hold namespaces.
 */

import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { decodeFunctionData, numberToHex, type Abi, type Address, type Hex } from 'viem'
import { jbMultiTerminalAbi } from '@bananapus/nana-sdk-core'
import { registerReviewHandler } from '@bananapus/nana-sdk-core/review'
import { afterEach, describe, expect, it, vi } from 'vitest'
import baseline from './fixtures/use-safe-tx-calldata.json'

const ALICE = '0x2222222222222222222222222222222222222222' as Address

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

vi.mock('@wagmi/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@wagmi/core')>()),
  getAccount: () => ({ address: '0x2222222222222222222222222222222222222222', chainId: 84532 }),
  getWalletClient: async () => walletClient,
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

type Action = ReturnType<typeof useReviewedAction>
const Harness = forwardRef<Action>(function Harness(_, ref) {
  const value = useReviewedAction()
  useImperativeHandle(ref, () => value, [value])
  return null
})

const unregister: (() => void)[] = []
afterEach(() => {
  while (unregister.length) unregister.pop()!()
  walletSends.length = 0
})

/** The review UI confirms every prompt. */
function confirmEveryReview() {
  unregister.push(registerReviewHandler(async prompt => prompt.confirmation))
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
      const result = await runOnce({ calls: [{ chainId: sent.chainId, to: sent.to as Address, data: sent.data as Hex, value: BigInt(sent.value) }] })
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
    expect((await runOnce({ calls: [call] }))?.status).toBe('done')
    // The send was held under its intent: the same intent, with another call, sees its settlement.
    const byIntent = holds.open(
      { chainId: stick.chainId, account: ALICE, safe: false, namespace: intent, call: { to: stick.to as Address, data: '0x', value: 0n } },
      { legacy },
    )
    const state = byIntent.peek()
    expect(state.status === 'clear' && state.settled?.result).toBe('success')
  })
})
