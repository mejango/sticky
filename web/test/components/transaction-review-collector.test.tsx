// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { encodeFunctionData, parseAbi } from 'viem'

const configured = vi.hoisted(() => ({
  sourceChainId: 1, destinationChainId: 8453,
  address: '0x4444444444444444444444444444444444444444',
  feePayer: '0x5555555555555555555555555555555555555555',
  runtimeCodeHash: `0x${'12'.repeat(32)}`, feePayerRuntimeCodeHash: `0x${'34'.repeat(32)}`,
  registry: '0x6666666666666666666666666666666666666666',
  tokens: '0x7777777777777777777777777777777777777777',
  directory: '0x8888888888888888888888888888888888888888',
  receiverFactory: '0x9999999999999999999999999999999999999999',
}))
vi.mock('@/lib/sticky-source-collectors', () => ({ stickySourceCollectors: [configured] }))
vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined, chainId: undefined }) }))
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'asset' }) }))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { requireTransactionReview } from '@/lib/transaction-review'

const token = '0x3333333333333333333333333333333333333333'
const abi = parseAbi([
  'struct Split { uint32 percent; uint64 projectId; address beneficiary; bool preferAddToBalance; uint48 lockedUntil; address hook; }',
  'struct SplitGroup { uint256 groupId; Split[] splits; }',
  'function setSplitGroupsOf(uint256 projectId, uint256 rulesetId, SplitGroup[] splitGroups)',
])
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

it('uses the generated family record to review a reserved split on its home chain', async () => {
  const args = [3n, 123n, [{ groupId: 1n, splits: [{
    percent: 263157895, projectId: 0n, beneficiary: token,
    preferAddToBalance: false, lockedUntil: 0, hook: configured.address as `0x${string}`,
  }] }]] as const
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => {
    requireTransactionReview({ calls: [{
      chainId: 1, to: '0x1111111111111111111111111111111111111111', abi,
      functionName: 'setSplitGroupsOf', args, data: encodeFunctionData({ abi, functionName: 'setSplitGroupsOf', args }),
    }] }).catch(() => {})
  })
  await act(async () => { await vi.dynamicImportSettled() })
  const text = document.querySelector('dialog')?.textContent ?? ''
  expect(text).toContain('Reserved tokens')
  expect(text).toContain(`Sticky token ${token} on home chain 8453`)
  expect(text).toContain(`via StickySourceCollector ${configured.address}`)
  expect(text).not.toContain('project #0')
})
