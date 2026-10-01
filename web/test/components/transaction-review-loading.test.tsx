// @vitest-environment jsdom

import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransactionReviewDialogProps } from '@/components/TransactionReviewProvider'

vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }))

type DialogModule = { TransactionReviewDialog: (props: TransactionReviewDialogProps) => ReturnType<typeof createElement> }
let resolveDownload: (module: DialogModule) => void
let rejectDownload: (error: Error) => void
let download: ReturnType<typeof vi.fn<() => Promise<DialogModule>>>
let root: Root
let container: HTMLDivElement
let api: typeof import('@/lib/transaction-review')
const mounted = vi.fn()
const unmounted = vi.fn()
const finishes = new Map<number, TransactionReviewDialogProps['onFinish']>()

function ControlledDialog({ pending, onFinish }: TransactionReviewDialogProps) {
  useEffect(() => {
    mounted(pending)
    finishes.set(pending.id, onFinish)
    return () => { unmounted(pending.id) }
  }, [pending, onFinish])
  return createElement('div', { 'data-loaded-review': pending.id },
    createElement('p', null, pending.kind === 'review' ? pending.request.title : 'Funding choice'),
    createElement('button', { onClick: () => onFinish(pending.kind === 'review' ? true : 8453) },
      pending.kind === 'review' ? 'Approve review' : 'Choose Base'),
    createElement('button', { onClick: () => onFinish(null) }, 'Cancel loaded review'),
  )
}

beforeEach(async () => {
  vi.resetModules()
  finishes.clear()
  const pendingDownload = new Promise<DialogModule>((resolve, reject) => {
    resolveDownload = resolve
    rejectDownload = reject
  })
  download = vi.fn(() => pendingDownload)
  vi.doMock('@/components/TransactionReviewDialog', download)
  const { TransactionReviewProvider } = await import('@/components/TransactionReviewProvider')
  api = await import('@/lib/transaction-review')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(TransactionReviewProvider, null, 'Application content')))
})

afterEach(async () => {
  await act(async () => root.unmount())
  await act(async () => {
    resolveDownload({ TransactionReviewDialog: ControlledDialog })
    await vi.dynamicImportSettled()
  })
  container.remove()
  vi.doUnmock('@/components/TransactionReviewDialog')
})

function requestReview(title: string) {
  return api.requireTransactionReview({ title,
    calls: [{ chainId: 1, to: '0x1111111111111111111111111111111111111111', data: '0x' }],
  })
}

function requestFunding() {
  return api.requireFundingChainSelection([{ chainId: 8453, label: 'Base · 0.001 ETH' }])
}

function button(label: string) {
  const match = [...container.querySelectorAll('button')].find(button => button.textContent === label)
  if (!match) throw new Error(`Missing button: ${label}`)
  return match
}

async function completeDownload() {
  await act(async () => {
    resolveDownload({ TransactionReviewDialog: ControlledDialog })
    await vi.dynamicImportSettled()
  })
}

describe('lazy transaction review lifecycle', () => {
  it('registers synchronously and offers only cancellation while the decoder is downloading', async () => {
    expect(download).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Application content')
    const approved = vi.fn()
    let review!: Promise<unknown>
    await act(async () => { review = requestReview('First review').then(approved, error => error) })
    expect(download).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading transaction review')
    expect([...container.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Cancel'])
    expect(approved).not.toHaveBeenCalled()
    expect(mounted).not.toHaveBeenCalled()

    await act(async () => button('Cancel').click())
    expect(await review).toMatchObject({ message: 'Review closed. Nothing was sent.' })
    await completeDownload()
    expect(container.querySelector('[data-loaded-review]')).toBeNull()
    expect(container.querySelector('dialog')).toBeNull()
    expect(mounted).not.toHaveBeenCalled()
    expect(approved).not.toHaveBeenCalled()
  })

  it('preserves queued requests when a loading review is canceled and requires each later approval', async () => {
    let first!: Promise<unknown>
    let funding!: Promise<unknown>
    let last!: Promise<unknown>
    const fundingResolved = vi.fn()
    const lastApproved = vi.fn()
    await act(async () => {
      first = requestReview('Canceled review').catch(error => error)
      funding = requestFunding().then(value => { fundingResolved(value); return value }, error => error)
      last = requestReview('Last review').then(lastApproved, error => error)
    })
    await act(async () => {
      button('Cancel').click()
      expect(fundingResolved).not.toHaveBeenCalled()
      expect(lastApproved).not.toHaveBeenCalled()
      // Resolve this download before the next request's import effect runs.
      // Vitest treats overlapping pending mock factories as circular imports.
      resolveDownload({ TransactionReviewDialog: ControlledDialog })
      await vi.dynamicImportSettled()
    })
    expect(await first).toMatchObject({ message: 'Review closed. Nothing was sent.' })
    expect(fundingResolved).not.toHaveBeenCalled()
    expect(lastApproved).not.toHaveBeenCalled()
    await act(async () => { await vi.dynamicImportSettled() })
    expect(container.textContent).toContain('Funding choice')
    expect(mounted.mock.calls.every(([pending]) => pending.kind !== 'review' || pending.request.title !== 'Canceled review')).toBe(true)
    await act(async () => button('Choose Base').click())
    await expect(funding).resolves.toBe(8453)
    expect(container.textContent).toContain('Last review')
    expect(lastApproved).not.toHaveBeenCalled()
    await act(async () => button('Approve review').click())
    await last
    expect(lastApproved).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-loaded-review]')).toBeNull()
  })

  it('declines active and queued requests when the dialog import rejects', async () => {
    let requests!: Promise<unknown>[]
    const approved = vi.fn()
    await act(async () => {
      requests = [requestReview('First'), requestFunding(), requestReview('Last')]
        .map(request => request.then(approved, error => error))
    })
    await act(async () => {
      rejectDownload(new Error('Review chunk download failed.'))
      await vi.dynamicImportSettled()
    })
    // Advancing the queue starts another import effect; its rejected module
    // must cancel that request as well, rather than strand its promise.
    await act(async () => { await vi.dynamicImportSettled() })
    expect(await Promise.all(requests)).toEqual([
      expect.objectContaining({ message: 'Review closed. Nothing was sent.' }),
      expect.objectContaining({ message: expect.stringMatching(/selection cancelled/i) }),
      expect.objectContaining({ message: 'Review closed. Nothing was sent.' }),
    ])
    expect(approved).not.toHaveBeenCalled()
    expect(mounted).not.toHaveBeenCalled()
    expect(container.querySelector('dialog')).toBeNull()
  })

  it('cancels the entire queue on unmount and ignores a subsequently completed download', async () => {
    let requests!: Promise<unknown>[]
    const approved = vi.fn()
    await act(async () => {
      requests = [requestFunding(), requestReview('Queued review'), requestFunding()]
        .map(request => request.then(approved, error => error))
    })
    await act(async () => root.render(null))
    expect(await Promise.all(requests)).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/selection cancelled/i) }),
      expect.objectContaining({ message: 'Review closed. Nothing was sent.' }),
      expect.objectContaining({ message: expect.stringMatching(/selection cancelled/i) }),
    ])
    await expect(requestReview('After unmount')).rejects.toThrow(/review is unavailable/i)
    await expect(requestFunding()).rejects.toThrow(/selection is unavailable/i)
    await completeDownload()
    expect(mounted).not.toHaveBeenCalled()
    expect(approved).not.toHaveBeenCalled()
    expect(container.children).toHaveLength(0)
  })

  it('ignores an old dialog completion callback after the queue advances', async () => {
    let first!: Promise<void>
    let second!: Promise<unknown>
    const secondApproved = vi.fn()
    await act(async () => {
      first = requestReview('First review')
      second = requestReview('Second review').then(secondApproved, error => error)
    })
    await completeDownload()
    const staleFinish = finishes.get(1)!
    await act(async () => button('Approve review').click())
    await first
    expect(container.textContent).toContain('Second review')
    await act(async () => staleFinish(true))
    expect(secondApproved).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Second review')
    await act(async () => button('Cancel loaded review').click())
    expect(await second).toMatchObject({ message: 'Review closed. Nothing was sent.' })
  })
})
