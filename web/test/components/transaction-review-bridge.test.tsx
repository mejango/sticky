// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildBridgeClaimTx, buildBridgePrepareTx, buildStickyCollectorSendTx, buildStickyCollectorSettleTx, buildToRemoteTx, suckerLeafProof } from '@bananapus/nana-sdk-core/v6'
import { encodeFunctionData, pad, zeroHash, type Abi } from 'viem'

vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined, chainId: undefined }) }))
vi.mock('next/image', () => ({ default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'asset' }) }))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { type TransactionReviewRequest } from '@bananapus/nana-sdk-core/review'
import { promptReview } from '../support/review-prompt'
import { COLLECTOR_ROUTE as ROUTE, COLLECTOR_SOURCE as SOURCE, collectorAddress as A, COLLECTOR_RECEIVER as RECEIVER, localCollectorSource } from '../collector-fixtures'

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

const leaf = { index: 0n, beneficiary: pad(RECEIVER), projectTokenCount: 10n ** 18n, terminalTokenAmount: 965n, metadata: zeroHash }
// The requests BridgeFlow and CollectorFlow review through core's reviewed run, as this review shows them.
const steps = [
  ['prepare(uint256, bytes32, uint256, address, bytes32)', '965', buildBridgePrepareTx({ chainId: 1, sucker: ROUTE.sourceSucker, projectTokenCount: 10n ** 18n, beneficiary: RECEIVER, minTokensReclaimed: 965n, token: ROUTE.backingToken, metadata: zeroHash })],
  ['toRemote(address)', '123 wei', buildToRemoteTx({ chainId: 1, sucker: ROUTE.sourceSucker, token: ROUTE.backingToken, value: 123n })],
  ['claim(tuple)', 'Terminal token amount:965', buildBridgeClaimTx({ chainId: 10, sucker: ROUTE.destinationSucker, claim: { token: ROUTE.remoteBackingToken, leaf, proof: suckerLeafProof([zeroHash], 0) } })],
  ['send(uint256, address, uint256, uint256, address, address)', '77 wei', buildStickyCollectorSendTx({ ...SOURCE.allocation, amount: 10n ** 18n, sucker: ROUTE.sourceSucker, backingToken: ROUTE.backingToken, value: 77n })],
  ['settle(uint256, address, uint256, uint256)', '1000000000000000000', buildStickyCollectorSettleTx({ ...localCollectorSource().allocation, amount: 10n ** 18n })],
] as const

it.each(steps)("shows the SDK's decoded review of %s", async (signature, amount, step) => {
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => {
    promptReview({ calls: [{ chainId: step.chainId, to: step.address, data: encodeFunctionData(step as never), value: ('value' in step ? step.value : undefined) ?? 0n, from: A(40), abi: step.abi as Abi, functionName: step.functionName, args: step.args }] }).catch(() => {})
  })
  await act(async () => { await vi.dynamicImportSettled() })
  const text = document.querySelector('dialog')?.textContent ?? ''
  expect(text).toContain(`Contract function${signature}`)
  expect(text).toContain(amount)
  expect(text).toContain(`chain ${step.chainId}`)
  expect(text).toContain(`Destination${step.address}`)
  expect(text).toContain(`Native value`)
})

it("shows the action's summary rows above every decoded call of its one review", async () => {
  const calls = steps.slice(0, 2).map(([, , step]) => ({ chainId: step.chainId, to: step.address, data: encodeFunctionData(step as never), value: ('value' in step ? step.value : undefined) ?? 0n, from: A(40), abi: step.abi as Abi, functionName: step.functionName, args: step.args }))
  const request: TransactionReviewRequest = { title: 'Airdrop across chains', context: [{ label: 'Send', value: '1 SRC on Ethereum', strong: true }, { label: 'Reward address', value: RECEIVER, mono: true }], calls }
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => { promptReview(request).catch(() => {}) })
  await act(async () => { await vi.dynamicImportSettled() })
  const text = document.querySelector('dialog')?.textContent ?? ''
  expect(text).toContain('Airdrop across chains')
  expect(text).toContain('Send1 SRC on Ethereum')
  expect(text).toContain(`Reward address${RECEIVER}`)
  expect(text.indexOf('Send1 SRC on Ethereum')).toBeLessThan(text.indexOf('Contract functionprepare('))
  expect(text).toContain('Contract functiontoRemote(address)')
})
