// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

async function reviewAll(
  calls: Partial<TransactionReviewCall>[],
  kind?: 'transaction' | 'authorization',
) {
  act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
  await act(async () => {
    requireTransactionReview({
      kind,
      calls: calls.map(fields => ({
        chainId: 1,
        to: '0x1111111111111111111111111111111111111111',
        data: '0x',
        ...fields,
      })),
    }).catch(() => {})
  })
  await act(async () => { await vi.dynamicImportSettled() })
}

const review = (fields: Partial<TransactionReviewCall>) => reviewAll([fields])

const SENT = 'This is the exact destination, native value, and calldata the app will ask your wallet to send.'

function row(label: string): string[] | null {
  const term = [...document.querySelectorAll('dialog dt')].find(node => node.textContent === label)
  return term ? [...term.parentElement!.querySelectorAll('dd')].map(node => node.textContent ?? '') : null
}

function description(): string | null | undefined {
  const dialog = document.querySelector('dialog')!
  return document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent
}

describe('transaction review gas', () => {
  it('shows a fixed gas limit and leaves the wallet only the nonce and fees', async () => {
    await review({ gas: 240_000n })
    expect(row('Gas limit')).toEqual(['240,000'])
    expect(row('Safe gas')).toBeNull()
    expect(description()).toBe(`${SENT} Your wallet adds the nonce and network fees.`)
  })

  it('says the wallet shows the gas limit when none is fixed', async () => {
    await review({})
    expect(row('Gas limit')).toBeNull()
    expect(row('Safe gas')).toBeNull()
    expect(description()).toBe(
      `${SENT} Your wallet shows the gas limit and network fees before you send.`,
    )
  })

  it('treats a fixed Safe gas as fixed gas', async () => {
    await review({ safeTxGas: 0n })
    expect(description()).toBe(`${SENT} Your wallet adds the nonce and network fees.`)
  })

  it('leaves the gas limit to the wallet unless every call fixes one', async () => {
    await reviewAll([{ gas: 240_000n }, {}])
    expect(description()).toBe(
      `${SENT} Your wallet shows the gas limit and network fees before you send.`,
    )
    act(() => root.unmount())
    root = createRoot(container)
    await reviewAll([{ gas: 240_000n }, { safeTxGas: 0n }])
    expect(description()).toBe(`${SENT} Your wallet adds the nonce and network fees.`)
  })

  it('keeps the authorization description', async () => {
    await reviewAll([{ gas: 240_000n }], 'authorization')
    expect(description()).toBe(
      'This authorization commits to the exact destination, native value, and calldata below. A Safe or relayer can submit that call onchain after you continue.',
    )
  })

  it('shows a zero Safe gas without a warning', async () => {
    await review({ safeTxGas: 0n })
    expect(row('Safe gas')).toEqual(['0'])
  })

  it('warns that a nonzero Safe gas lets a failed call use the nonce', async () => {
    await review({ safeTxGas: 150_000n })
    expect(row('Safe gas')).toEqual([
      '150,000',
      'If this call fails, the Safe still executes and uses this nonce.',
    ])
    expect(row('Gas limit')).toBeNull()
  })
})
