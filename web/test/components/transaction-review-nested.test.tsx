// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, erc20Abi, parseAbi, zeroAddress, type Hex } from 'viem'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chainId: undefined }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) =>
    createElement('img', { ...props, src: 'asset' }),
}))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import {
  requireTransactionReview,
  type TransactionReviewCall,
} from '@/lib/transaction-review'
import '../dialog-shim'

const SAFE = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x2222222222222222222222222222222222222222'
const SPENDER = '0x3333333333333333333333333333333333333333'
const HEADING = 'Calls it makes, in order'
const safeAbi = parseAbi([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function approveHash(bytes32 hashToApprove)',
])
const multiSendAbi = parseAbi(['function multiSend(bytes transactions) payable'])

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function approval(amount: bigint): TransactionReviewCall {
  const args = [SPENDER, amount] as const
  return {
    chainId: 1,
    from: SAFE,
    to: TOKEN,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args }),
    abi: erc20Abi,
    functionName: 'approve',
    args,
  }
}

function execTransaction(calls: readonly TransactionReviewCall[]): TransactionReviewCall {
  const args = [TOKEN, 0n, calls[0]?.data ?? '0x', 0, 0n, 0n, 0n, zeroAddress, zeroAddress, '0x'] as const
  return {
    chainId: 1,
    to: SAFE,
    data: encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args }),
    abi: safeAbi,
    functionName: 'execTransaction',
    args,
    calls,
  }
}

async function review(call: TransactionReviewCall) {
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => {
    requireTransactionReview({ calls: [call] }).catch(() => {})
  })
  await act(async () => { await vi.dynamicImportSettled() })
  return document.querySelector('dialog')!.textContent ?? ''
}

const count = (text: string, part: string) => text.split(part).length - 1

describe('transaction review nested calls', () => {
  it('shows the calls an execTransaction makes, in order', async () => {
    const text = await review(execTransaction([approval(5n), approval(6n)]))
    expect(count(text, HEADING)).toBe(1)
    expect(count(text, 'Call 1 of 2')).toBe(1)
    expect(count(text, 'Call 2 of 2')).toBe(1)
    expect(count(text, 'approve(address, uint256)')).toBe(2)
    expect(text.indexOf(HEADING)).toBeLessThan(text.indexOf('Call 1 of 2'))
  })

  it('shows the call an approved Safe hash authorizes', async () => {
    const args = [`0x${'ab'.repeat(32)}`] as const
    const text = await review({
      chainId: 1,
      to: SAFE,
      data: encodeFunctionData({ abi: safeAbi, functionName: 'approveHash', args }),
      abi: safeAbi,
      functionName: 'approveHash',
      args,
      calls: [approval(7n)],
    })
    expect(count(text, HEADING)).toBe(1)
    expect(text).toContain('approve(address, uint256)')
  })

  it('keeps a MultiSend’s calls inside its transactions argument, once', async () => {
    const transactions = '0x00' as Hex
    const text = await review({
      chainId: 1,
      to: SAFE,
      data: encodeFunctionData({ abi: multiSendAbi, functionName: 'multiSend', args: [transactions] }),
      abi: multiSendAbi,
      functionName: 'multiSend',
      args: [transactions],
      calls: [approval(5n), approval(6n)],
    })
    expect(count(text, HEADING)).toBe(0)
    expect(count(text, 'Call 1 of 2')).toBe(1)
    expect(count(text, 'approve(address, uint256)')).toBe(2)
  })

  it('renders no section for an empty call list', async () => {
    const text = await review(execTransaction([]))
    expect(text).not.toContain(HEADING)
  })
})
