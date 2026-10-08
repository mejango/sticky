import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectReviewScope } from '@/providers/ProjectRouteContext'
import type { TransactionReviewDialogProps } from '@/components/TransactionReviewProvider'

const mocks = vi.hoisted(() => ({
  address: '0x1111111111111111111111111111111111111111',
  scope: null as ProjectReviewScope | null,
  blocked: false,
}))
vi.mock('wagmi', () => ({ useAccount: () => ({ address: mocks.address }) }))
vi.mock('@/providers/ProjectRouteContext', () => ({ useProjectReviewScope: () => mocks.scope }))
vi.mock('@/providers/ProjectRouteBlockedContext', () => ({ useProjectRouteBlocked: () => mocks.blocked }))
vi.mock('@/components/TransactionReviewDialog', () => ({
  TransactionReviewDialog: ({ pending, onFinish, checkingProject }: TransactionReviewDialogProps) => <div data-review={pending.id}>
    <p>{pending.kind === 'review' ? pending.request.title : 'Choose funding'}</p>
    <button data-approve disabled={checkingProject} onClick={() => onFinish(pending.kind === 'review' ? true : 8453)}>Approve</button>
    <button data-cancel onClick={() => onFinish(null)}>Cancel</button>
    {checkingProject && <span>Checking project</span>}
  </div>,
}))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { requireFundingChainSelection, requireTransactionReview } from '@/lib/transaction-review'

let host: HTMLDivElement
let root: Root
const verify = vi.fn<() => Promise<boolean>>()
const render = () => act(async () => root.render(<TransactionReviewProvider>Application</TransactionReviewProvider>))
const review = (title = 'Review') => requireTransactionReview({ title,
  calls: [{ chainId: 8453, to: '0x1111111111111111111111111111111111111111', data: '0x' }],
}).then(() => true, () => false)
const funding = () => requireFundingChainSelection([{ chainId: 8453, label: 'Base' }]).catch(() => null)
const approve = () => act(async () => host.querySelector<HTMLButtonElement>('[data-approve]')!.click())
const cancel = () => act(async () => host.querySelector<HTMLButtonElement>('[data-cancel]')!.click())
async function open() {
  let result!: Promise<boolean>
  await act(async () => { result = review() })
  await act(async () => { await vi.dynamicImportSettled() })
  return { result }
}

beforeEach(async () => {
  verify.mockReset().mockResolvedValue(true)
  mocks.address = '0x1111111111111111111111111111111111111111'
  mocks.scope = { identity: '8453:23', verify }
  mocks.blocked = false
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await render()
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('transaction review identity and pending proofs', () => {
  it('waits for the route proof before approving and declines an unavailable proof', async () => {
    const proof = Promise.withResolvers<boolean>()
    verify.mockReturnValueOnce(proof.promise)
    const { result } = await open()
    const finished = vi.fn()
    void result.then(finished)
    await approve()
    expect(host.textContent).toContain('Checking project')
    expect(finished).not.toHaveBeenCalled()
    await act(async () => proof.resolve(false))
    expect(await result).toBe(false)
    expect(host.querySelector('[data-review]')).toBeNull()
  })

  it('lets cancellation win over a delayed successful proof', async () => {
    const proof = Promise.withResolvers<boolean>()
    verify.mockReturnValueOnce(proof.promise)
    const { result } = await open()
    await approve()
    await cancel()
    expect(await result).toBe(false)
    await act(async () => proof.resolve(true))
    expect(host.querySelector('[data-review]')).toBeNull()
  })

  it('cancels active and queued reviews and funding when their project identity changes', async () => {
    const proof = Promise.withResolvers<boolean>()
    verify.mockReturnValueOnce(proof.promise)
    const { result } = await open()
    let queuedReview!: Promise<boolean>
    let queuedFunding!: Promise<number | null>
    await act(async () => { queuedReview = review('Queued old project'); queuedFunding = funding() })
    await approve()
    mocks.scope = { identity: '8453:24', verify: async () => true }
    await render()
    expect(await Promise.all([result, queuedReview, queuedFunding])).toEqual([false, false, null])
    expect(host.querySelector('[data-review]')).toBeNull()
    const replacement = await open()
    await act(async () => proof.resolve(true))
    expect(host.querySelector('[data-review]')).not.toBeNull()
    await approve()
    expect(await replacement.result).toBe(true)
  })

  it('cancels old account approvals and funding before a delayed route proof finishes', async () => {
    const proof = Promise.withResolvers<boolean>()
    verify.mockReturnValueOnce(proof.promise)
    const { result } = await open()
    let queued!: Promise<number | null>
    await act(async () => { queued = funding() })
    await approve()
    mocks.address = '0x2222222222222222222222222222222222222222'
    await render()
    // The modal must disappear as soon as the account changes, without waiting
    // for an unavailable route endpoint to finish.
    expect(host.querySelector('[data-review]')).toBeNull()
    expect(await result).toBe(false)
    expect(await queued).toBeNull()
    await act(async () => proof.resolve(true))
    expect(host.querySelector('[data-review]')).toBeNull()
  })

  it('rejects preparations that arrive after the route became blocked and lost its scope', async () => {
    mocks.scope = null
    mocks.blocked = true
    await render()
    let requests!: [Promise<boolean>, Promise<number | null>]
    await act(async () => { requests = [review('Late preparation'), funding()] })
    expect(await Promise.all(requests)).toEqual([false, null])
    expect(host.querySelector('[data-review]')).toBeNull()
    expect(verify).not.toHaveBeenCalled()
  })

  it('cancels a review when failed verification removes its project scope', async () => {
    const { result } = await open()
    mocks.scope = null
    mocks.blocked = true
    await render()
    expect(await result).toBe(false)
    expect(host.querySelector('[data-review]')).toBeNull()
  })
})
