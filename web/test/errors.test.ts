import { UnknownRpcError, InvalidInputRpcError, UserRejectedRequestError } from 'viem'
import { describe, expect, it } from 'vitest'

import { friendlyError, shortError } from '@/lib/errors'
import { TransactionReviewCancelledError } from '@/lib/transaction-review'

describe('rpc error text', () => {
  it('prefers the transport detail over viem generic labels', () => {
    const unknown = new UnknownRpcError(new Error('JB Center request failed (429)'))
    expect(shortError(unknown)).toBe('JB Center request failed (429)')
    expect(friendlyError(unknown)).toBe('JB Center request failed (429)')
    const invalid = new InvalidInputRpcError(new Error('intrinsic gas too high'))
    expect(shortError(invalid)).toBe('intrinsic gas too high')
  })

  it('keeps specific viem labels and the cancel mapping', () => {
    const rejected = new UserRejectedRequestError(new Error('User rejected the request.'))
    expect(shortError(rejected)).toBe('Transaction cancelled.')
    expect(friendlyError(rejected)).toBe('You cancelled in your wallet.')
    expect(shortError(new Error('plain\nsecond line'))).toBe('plain')
  })

  it('reports a closed review or fee picker as itself, not as a wallet cancel', () => {
    const review = new TransactionReviewCancelledError()
    const picker = new TransactionReviewCancelledError('Funding chain selection cancelled. Nothing was sent.')
    expect(friendlyError(review)).toBe('Review closed. Nothing was sent.')
    expect(shortError(review)).toBe('Review closed. Nothing was sent.')
    expect(friendlyError(picker)).toBe('Funding chain selection cancelled. Nothing was sent.')
    expect(shortError(picker)).toBe('Funding chain selection cancelled. Nothing was sent.')
  })
})
