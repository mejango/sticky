// @vitest-environment jsdom

/**
 * The review modal is the last surface between a click and a signature, and
 * the chain it names is the difference between paying a project and paying a
 * lookalike on a testnet. Chain identity here must be readable at a glance,
 * so the chip carries the chain mark as well as the name.
 */

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData } from 'viem'

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, chainId: undefined }),
}))
vi.mock('next/image', () => ({
  default: (props: Record<string, unknown>) =>
    createElement('img', { ...props, src: 'asset' }),
}))

import { TransactionReviewProvider } from '@/components/TransactionReviewProvider'
import { requireTransactionReview } from '@/lib/transaction-review'
import '../dialog-shim'

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

async function openReviewOn(chainId: number) {
  act(() =>
    root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>),
  )
  await act(async () => {
    // Swallow the cancellation thrown when the modal unmounts after the test.
    requireTransactionReview({
      calls: [
        {
          chainId,
          to: '0x1111111111111111111111111111111111111111',
          data: '0xdeadbeef',
        },
      ],
    }).catch(() => {})
  })
  await act(async () => { await vi.dynamicImportSettled() })
}

describe('transaction review chain identity', () => {
  it('renders the chain mark beside the chain name', async () => {
    await openReviewOn(8453)

    const chip = document.querySelector('dialog .chip')
    expect(chip?.textContent).toContain('Base')

    // The name is visible in the chip, so the mark itself is decorative —
    // naming it too would make the chip announce "Base" twice.
    const logo = document.querySelector<HTMLImageElement>('dialog img')
    expect(logo).not.toBeNull()
    expect(logo?.getAttribute('alt')).toBe('')
    expect(logo?.getAttribute('aria-hidden')).toBe('true')
    expect(logo?.hasAttribute('title')).toBe(false)
  })

  it('distinguishes near-identical testnet names by their mark', async () => {
    await openReviewOn(84532)

    expect(
      document.querySelector<HTMLImageElement>('dialog img[aria-hidden="true"]'),
    ).not.toBeNull()
    // Base Sepolia reuses the Base mark, so the mark alone is not the whole
    // story — the visible name must still be present.
    expect(document.querySelector('dialog .chip')?.textContent).toContain(
      'Base Sepolia',
    )
  })

  it('names Permit2, USDC, and the Uniswap router beside their addresses', async () => {
    const abi = [
      {
        type: 'function',
        name: 'approve',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'token', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint160' },
          { name: 'expiration', type: 'uint48' },
        ],
        outputs: [],
      },
    ] as const
    const args = [
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '0x6fF5693b99212Da76ad316178A184AB56D299b43',
      50_000_000n,
      1_800_000_000,
    ] as const
    act(() => root.render(<TransactionReviewProvider>{null}</TransactionReviewProvider>))
    await act(async () => {
      requireTransactionReview({
        calls: [
          {
            chainId: 8453,
            to: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
            data: encodeFunctionData({ abi, functionName: 'approve', args }),
            abi,
            functionName: 'approve',
            args,
          },
        ],
      }).catch(() => {})
    })
    await act(async () => { await vi.dynamicImportSettled() })

    expect(document.querySelector('dialog')?.textContent).toContain(
      'Destination | Permit2',
    )
    expect(document.querySelector('dialog')?.textContent).toContain('USDC |')
    expect(document.querySelector('dialog')?.textContent).toContain(
      'Uniswap Universal Router |',
    )
  })
})
