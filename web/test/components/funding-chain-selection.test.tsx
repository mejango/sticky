// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chainId: 1 }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'asset' }),
}))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import {
  requireFundingChainSelection,
  requireTransactionReview,
  TransactionReviewCancelledError,
} from '@/lib/transaction-review'

const OPTIONS = [
  { chainId: 1, label: 'Ethereum · 0.002 ETH' },
  { chainId: 8453, label: 'Base · 0.001 ETH' },
]
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function button(label: string) {
  const found = Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button'))
    .find(candidate => candidate.textContent === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

function choose(chainId: number) {
  const select = document.querySelector<HTMLSelectElement>('dialog select')!
  act(() => {
    select.value = String(chainId)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('funding chain selection modal', () => {
  it('starts unselected among several quotes without a preferred chain, and returns only the explicit choice', async () => {
    let selection!: Promise<number>
    await act(async () => { selection = requireFundingChainSelection(OPTIONS) })
    await act(async () => { await vi.dynamicImportSettled() })
    const select = document.querySelector<HTMLSelectElement>('dialog select')!
    const dialog = document.querySelector('dialog')!
    expect(select.value).toBe('')
    expect(select.options[select.selectedIndex].textContent).toBe('Choose a chain')
    expect([...select.classList]).toEqual(expect.arrayContaining(['select-caret', 'pr-9']))
    expect(button('Continue to payment review').disabled).toBe(true)
    expect(document.querySelector(`label[for="${select.id}"]`)?.textContent).toBe('Pay on')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Choose where to pay')
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toBe(
      "One payment covers every chain. You’ll review it before your wallet sends it.",
    )
    expect(select.textContent).toContain(OPTIONS[0].label)
    expect(select.textContent).toContain(OPTIONS[1].label)

    choose(8453)
    expect(button('Continue to payment review').disabled).toBe(false)
    await act(async () => { button('Continue to payment review').click() })
    await expect(selection).resolves.toBe(8453)
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('preselects the preferred chain when it is quoted', async () => {
    let selection!: Promise<number>
    await act(async () => { selection = requireFundingChainSelection(OPTIONS, 8453) })
    await act(async () => { await vi.dynamicImportSettled() })
    expect(document.querySelector<HTMLSelectElement>('dialog select')!.value).toBe('8453')
    expect(button('Continue to payment review').disabled).toBe(false)
    await act(async () => { button('Continue to payment review').click() })
    await expect(selection).resolves.toBe(8453)
  })

  it('preselects a sole option and cancels on Escape', async () => {
    let selection!: Promise<unknown>
    await act(async () => {
      selection = requireFundingChainSelection([OPTIONS[0]]).catch(error => error)
    })
    await act(async () => { await vi.dynamicImportSettled() })
    expect(document.querySelector<HTMLSelectElement>('dialog select')!.value).toBe('1')
    expect(button('Continue to payment review').disabled).toBe(false)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(await selection).toBeInstanceOf(TransactionReviewCancelledError)
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('returns no chain when cancelled, even with a preselected choice', async () => {
    let selection!: Promise<unknown>
    await act(async () => {
      selection = requireFundingChainSelection(OPTIONS, 1).catch(error => error)
    })
    await act(async () => { await vi.dynamicImportSettled() })
    await act(async () => { button('Cancel').click() })
    expect(await selection).toBeInstanceOf(TransactionReviewCancelledError)
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('queues funding choices with transaction reviews and resets each choice', async () => {
    let first!: Promise<number>
    let review!: Promise<unknown>
    let second!: Promise<number>
    await act(async () => {
      first = requireFundingChainSelection(OPTIONS)
      review = requireTransactionReview({
        calls: [{ chainId: 1, to: '0x1111111111111111111111111111111111111111', data: '0x' }],
      }).catch(error => error)
      second = requireFundingChainSelection(OPTIONS)
    })
    await act(async () => { await vi.dynamicImportSettled() })
    expect(document.querySelectorAll('dialog')).toHaveLength(1)
    choose(8453)
    await act(async () => { button('Continue to payment review').click() })
    await expect(first).resolves.toBe(8453)
    expect(document.querySelector('dialog')?.textContent).toContain('Review transaction')
    expect(document.querySelector('dialog select')).toBeNull()
    await act(async () => { button('Cancel').click() })
    expect(await review).toEqual(expect.objectContaining({ message: 'Review closed. Nothing was sent.' }))
    expect(document.querySelector<HTMLSelectElement>('dialog select')!.value).toBe('')
    expect(button('Continue to payment review').disabled).toBe(true)
    choose(1)
    await act(async () => { button('Continue to payment review').click() })
    await expect(second).resolves.toBe(1)
  })

  it('cancels active and queued requests when the provider unmounts', async () => {
    let requests!: Promise<unknown>[]
    await act(async () => {
      requests = [
        requireFundingChainSelection(OPTIONS),
        requireTransactionReview({ calls: [{ chainId: 1, to: '0x1111111111111111111111111111111111111111', data: '0x' }] }),
        requireFundingChainSelection(OPTIONS),
      ].map(request => request.catch(error => error))
    })
    await act(async () => { root.render(null) })
    expect(await Promise.all(requests)).toEqual([
      expect.objectContaining({ message: expect.stringMatching(/selection cancelled/i) }),
      expect.objectContaining({ message: 'Review closed. Nothing was sent.' }),
      expect.objectContaining({ message: expect.stringMatching(/selection cancelled/i) }),
    ])
    await expect(requireFundingChainSelection(OPTIONS)).rejects.toThrow(/selection is unavailable/i)
  })
})
