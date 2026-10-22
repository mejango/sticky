// @vitest-environment jsdom

/**
 * The review dialog's rendered DOM for each SDK fixture request
 * (`REVIEW_REQUESTS` from @bananapus/nana-sdk-core/testing). The dialog renders
 * the SDK's ReviewModel, and this snapshot pins that it shows the same rows it
 * showed before.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REVIEW_REQUESTS } from '@bananapus/nana-sdk-core/testing'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', chainId: 1 }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) => createElement('img', { ...props, src: 'asset' }),
}))
// No fee-buyback reads: the notice stays in its unknown state.
vi.mock('@/lib/fee-buyback-client', () => ({
  feeBuybackContext: () => {
    throw new Error('No fee-buyback reads in this test.')
  },
}))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { requireTransactionReview } from '@/lib/transaction-review'
import './dialog-shim'

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

async function renderedDialog(request: (typeof REVIEW_REQUESTS)[keyof typeof REVIEW_REQUESTS]): Promise<string> {
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => {
    // The modal unmounts after the test, which cancels the review.
    requireTransactionReview(request).catch(() => {})
  })
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  const dialog = document.querySelector('dialog')
  if (!dialog) throw new Error('The review dialog did not render.')
  return dialog.outerHTML
}

describe('transaction review dialog', () => {
  for (const [name, request] of Object.entries(REVIEW_REQUESTS)) {
    it(`renders the ${name} fixture`, async () => {
      expect(await renderedDialog(request)).toMatchSnapshot()
    })
  }
})
