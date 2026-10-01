// @vitest-environment jsdom

/**
 * What Sticky holds useSafeTx to beyond jbm's own cases (`use-safe-tx.test.ts`): the send moves the wallet to the
 * request's chain before it simulates or asks for a signature, and a Signa session is refused before any of it.
 */

import { act, forwardRef, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseAbi, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  wallet: { isConnected: true, address: undefined as Address | undefined, isCenterWallet: false },
  publicClient: { simulateContract: vi.fn(), estimateContractGas: vi.fn() },
  getAccount: vi.fn(),
  requestReview: vi.fn(),
  switchChain: vi.fn(),
  writeContract: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({ getAccount: mocks.getAccount }))
vi.mock('wagmi', () => ({
  usePublicClient: () => mocks.publicClient,
  useSwitchChain: () => ({ switchChainAsync: mocks.switchChain }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isError: false }),
  useWriteContract: () => ({ writeContractAsync: mocks.writeContract }),
}))
vi.mock('@/hooks/useWallet', () => ({ useWallet: () => mocks.wallet }))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: mocks.requestReview,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: {} }))
vi.mock('@/lib/safe-connector', () => ({
  isSafeConnection: () => false,
  SAFE_NONCE_GUIDANCE: 'Safe nonce guidance',
  useSafeConnection: () => false,
  waitForSafeExecutionHash: vi.fn(),
}))

import { useSafeTx } from '@/hooks/useSafeTx'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const HASH = `0x${'ab'.repeat(32)}` as const
const request = {
  chainId: 84532,
  address: HOOK,
  abi: parseAbi(['function setTrustedSenderFor(uint256 projectId, address sender, bool trusted)']),
  functionName: 'setTrustedSenderFor',
  args: [23n, ALICE, true] as const,
  label: 'Trust a sender',
}

type SafeTx = ReturnType<typeof useSafeTx>
const Harness = forwardRef<SafeTx>(function Harness(_, ref) {
  const value = useSafeTx(84532)
  useImperativeHandle(ref, () => value, [value])
  return null
})

let host: HTMLDivElement
let root: Root
let tx: { current: SafeTx | null }

beforeEach(async () => {
  mocks.wallet = { isConnected: true, address: ALICE, isCenterWallet: false }
  // The wallet starts on Ethereum; the request is for Base Sepolia.
  mocks.getAccount.mockImplementation(() => ({ address: ALICE, chainId: 1 }))
  mocks.requestReview.mockResolvedValue(true)
  mocks.switchChain.mockResolvedValue(undefined)
  mocks.publicClient.simulateContract.mockResolvedValue({ request: { address: HOOK, functionName: 'setTrustedSenderFor' } })
  mocks.publicClient.estimateContractGas.mockResolvedValue(50_000n)
  mocks.writeContract.mockResolvedValue(HASH)
  host = document.createElement('div')
  root = createRoot(host)
  tx = { current: null }
  await act(async () => root.render(<Harness ref={tx} />))
})

afterEach(async () => {
  await act(async () => root.unmount())
})

describe('useSafeTx in Sticky', () => {
  it('moves the wallet to the request’s chain before it simulates or asks for a signature', async () => {
    await act(async () => {
      await tx.current!.send(request)
    })

    expect(mocks.switchChain).toHaveBeenCalledWith({ chainId: 84532 })
    const [reviewed] = mocks.requestReview.mock.invocationCallOrder
    const [switched] = mocks.switchChain.mock.invocationCallOrder
    const [simulated] = mocks.publicClient.simulateContract.mock.invocationCallOrder
    const [signed] = mocks.writeContract.mock.invocationCallOrder
    expect(reviewed).toBeLessThan(switched)
    expect(switched).toBeLessThan(simulated)
    expect(simulated).toBeLessThan(signed)
    expect(tx.current).toMatchObject({ phase: 'pending', hash: HASH })
  })

  it('stops when the wallet will not move to the request’s chain', async () => {
    mocks.switchChain.mockRejectedValueOnce(new Error('User rejected the request.'))
    await act(async () => {
      await tx.current!.send(request)
    })
    // The engine names the chain the wallet must move to (jbm's D10).
    expect(tx.current).toMatchObject({ phase: 'error', error: 'Switch your wallet to Base Sepolia to continue.' })
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })

  it('refuses a Signa session before the review, the switch, the simulation or the wallet', async () => {
    mocks.wallet = { isConnected: true, address: ALICE, isCenterWallet: true }
    await act(async () => root.render(<Harness ref={tx} />))

    let result: `0x${string}` | null = HASH
    await act(async () => {
      result = await tx.current!.send(request)
    })

    expect(result).toBeNull()
    expect(tx.current).toMatchObject({ phase: 'error', busy: false, error: EXTERNAL_WALLET_REQUIRED })
    expect(EXTERNAL_WALLET_REQUIRED).toBe('This action needs an external wallet.')
    expect(mocks.requestReview).not.toHaveBeenCalled()
    expect(mocks.switchChain).not.toHaveBeenCalled()
    expect(mocks.publicClient.simulateContract).not.toHaveBeenCalled()
    expect(mocks.writeContract).not.toHaveBeenCalled()
  })
})
