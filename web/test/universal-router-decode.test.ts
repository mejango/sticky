// The transaction safety check decodes the pay flow's Universal Router
// `execute` plans into readable steps; unrecognized command bytes fall back to
// the raw argument view.
import {
  addPermit2SignatureToDirectPaySwap,
  buildUniswapV4ExactInputSwapTx,
} from '@bananapus/nana-sdk-core/v6'
import { describe, expect, it } from 'vitest'
import { describeUniversalRouterExecute } from '@/components/TransactionReviewDialog'

const RECIPIENT = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x4444444444444444444444444444444444444444'
const KEY = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x2222222222222222222222222222222222222222',
  fee: 10_000,
  tickSpacing: 200,
  hooks: '0x3333333333333333333333333333333333333333',
} as const

describe('Universal Router execute decoding', () => {
  it('renders the single-V4 swap plan as readable steps', () => {
    const tx = buildUniswapV4ExactInputSwapTx({
      chainId: 8453,
      poolKey: KEY,
      zeroForOne: true,
      amountIn: 1_000_000n,
      minimumAmountOut: 5n,
      recipient: RECIPIENT,
      deadline: 1_800_000_000n,
    })
    const steps = describeUniversalRouterExecute(8453, tx.args as readonly unknown[])!
    expect(steps.map(step => step.title)).toEqual([
      "Swap in the project's V4 pool (exact input)",
      'Pay the pool everything owed',
      'Take the swap output',
    ])
    expect(steps[0].rows).toContainEqual(['Minimum out', '5 — reverts below this'])
    expect(steps[0].rows).toContainEqual(['Amount in', '1000000'])
  })

  it('decodes the Permit2-folded variant and refuses unknown commands', () => {
    const tx = buildUniswapV4ExactInputSwapTx({
      chainId: 8453,
      poolKey: { ...KEY, currency0: TOKEN },
      zeroForOne: true,
      amountIn: 7n,
      minimumAmountOut: 5n,
      recipient: RECIPIENT,
      deadline: 1_800_000_000n,
    })
    const folded = addPermit2SignatureToDirectPaySwap(
      tx,
      {
        chainId: 8453,
        token: TOKEN,
        amount: 7n,
        expiration: 1_900_000_000,
        nonce: 0,
        spender: tx.address,
        sigDeadline: 1_800_000_000n,
      },
      `0x${'11'.repeat(65)}`,
    )
    const steps = describeUniversalRouterExecute(8453, folded.args as readonly unknown[])!
    expect(steps).toHaveLength(4)
    expect(steps[0].title).toBe('Apply your signed Permit2 authorization')
    // Unknown commands must fall back to the raw view, never a partial story.
    expect(describeUniversalRouterExecute(8453, ['0xff', ['0x'], 0n])).toBeNull()
  })
})
