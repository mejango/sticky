/**
 * The exact bytes useSafeTx hands the wallet for a stick, an unstick, a
 * transfer, a trust, an airdrop and a settle, saved to
 * test/fixtures/use-safe-tx-calldata.json. The reviewed-send path that
 * replaces useSafeTx must send these same bytes, so the baseline outlives
 * useSafeTx.
 */

import { QueryClient } from '@tanstack/react-query'
import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'

const displayQueries = new QueryClient()
vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => displayQueries,
}))

const mocks = vi.hoisted(() => ({
  chainId: 84532,
  publicClient: {
    simulateContract: vi.fn(async (request: Record<string, unknown>) => ({ request })),
    estimateContractGas: vi.fn(async () => 100_000n),
    getTransaction: vi.fn(),
    getChainId: vi.fn(async () => 84532),
    getBlockNumber: vi.fn(async () => 100n),
    getTransactionCount: vi.fn(async () => 3),
  },
  writeContract: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({
  getAccount: () => ({ address: '0x2222222222222222222222222222222222222222', chainId: mocks.chainId, connector: { uid: 'wallet', id: 'injected' } }),
}))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isError: false }),
  useWriteContract: () => ({ writeContractAsync: mocks.writeContract }),
}))
vi.mock('@/hooks/useWallet', () => ({
  useWallet: () => ({ isConnected: true, address: '0x2222222222222222222222222222222222222222', isCenterWallet: false }),
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: vi.fn(async () => true),
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/safe-connector')>()),
  isSafeConnection: () => false,
  useSafeConnection: () => false,
  findPendingSafeAppProposal: vi.fn(),
}))

import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { fundTxs, settleTx, stickTx, transferTx, trustTx, unstickTxs } from '@/lib/sticky-builders'

type SafeTxValue = ReturnType<typeof useSafeTx>
const Harness = forwardRef<SafeTxValue>(function Harness(_, ref) {
  const value = useSafeTx(84532)
  useImperativeHandle(ref, () => value, [value])
  return null
})

const CHAIN = 84532
const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`)
const A = address('1')
const B = address('2')
const C = address('3')
/** Project 12, sticking a token of 6 decimals (test/lib/sticky-builders.test.ts). */
const info = { chainId: CHAIN, projectId: 12n, stakedToken: A, symbol: 'ART', decimals: 6, stToken: C, stSymbol: 'STICKYART', soulbound: false }

/** One request per kind of call the flows send, as their builders make them. */
const REQUESTS: Record<string, TxRequest> = {
  stick: stickTx(info, B, 10_000_000n, 9_990_000_000_000_000_000n),
  unstick: unstickTxs(info, B, 10n ** 18n, 975_000n).at(-1)!,
  transfer: transferTx(info, A, 5n * 10n ** 18n),
  trust: trustTx(CHAIN, 12n, C, true),
  airdrop: fundTxs(CHAIN, { stToken: C, token: A, amount: 100_000_000n, groupId: 4008n, allowance: 100_000_000n, symbol: 'ART', decimals: 6 }).at(-1)!,
  settle: settleTx(CHAIN, { stToken: C, groupId: 4008n, token: A }),
}

describe('useSafeTx calldata baseline', () => {
  it('records the exact bytes it sends for a stick, an unstick, a transfer, a trust, an airdrop and a settle', async () => {
    const sent: Record<string, { chainId: number; to: Address; data: Hex; value: string }> = {}
    for (const [name, request] of Object.entries(REQUESTS)) {
      mocks.writeContract.mockReset()
      mocks.writeContract.mockResolvedValue(`0x${'ab'.repeat(32)}`)
      const ref = createRef<SafeTxValue>()
      let renderer!: TestRenderer.ReactTestRenderer
      await act(async () => {
        renderer = TestRenderer.create(createElement(Harness, { ref }))
      })
      await act(async () => {
        await ref.current!.send(request, { reviewedAccount: B })
      })
      expect(mocks.writeContract).toHaveBeenCalledTimes(1)
      const written = mocks.writeContract.mock.calls[0][0] as TxRequest
      sent[name] = {
        chainId: request.chainId,
        to: written.address,
        data: encodeFunctionData({ abi: written.abi, functionName: written.functionName, args: written.args } as never),
        value: String(written.value ?? 0n),
      }
      await act(async () => renderer.unmount())
    }
    await expect(`${JSON.stringify(sent, null, 2)}\n`).toMatchFileSnapshot('fixtures/use-safe-tx-calldata.json')
  })
})
