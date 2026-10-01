import { encodeFunctionData, parseAbi, type Address } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { takeUndecodedReviewCalls } from './review-calls-setup'
import { undecodedCalls } from './support/review-calls'

const TARGET = '0x1111111111111111111111111111111111111111' as Address
const RECIPIENT = '0x2222222222222222222222222222222222222222' as Address
const abi = parseAbi(['function transfer(address recipient, uint256 amount)'])
const data = encodeFunctionData({ abi, functionName: 'transfer', args: [RECIPIENT, 5n] })
const good = { chainId: 1, to: TARGET, data, abi, functionName: 'transfer', args: [RECIPIENT, 5n], label: 'Send' }
const missingArgs = { ...good, args: undefined, label: 'Missing args' }
const wrongArgs = { ...good, args: [RECIPIENT, 6n], label: 'Wrong args' }

const actual = await vi.importActual<typeof import('@bananapus/nana-sdk-core/review/decode')>(
  '@bananapus/nana-sdk-core/review/decode',
)

describe('review call decoding check', () => {
  it('finds every call with an ABI that does not decode, wherever it sits', () => {
    expect(undecodedCalls({ calls: [good] }, actual.functionFromCall)).toEqual([])
    expect(
      undecodedCalls(
        [
          { calls: [good, missingArgs] },
          // A relayed call and its review context.
          { target: TARGET, data, abi, functionName: 'transfer', args: [RECIPIENT, 6n], label: 'Relayed' },
          { description: 'context', calls: [{ ...good, calls: [wrongArgs] }] },
          // A batch's steps, under any key.
          { chainId: 1, steps: [{ id: 'step', ...good, args: [RECIPIENT, 7n], label: 'Step' }] },
          // A raw call without an ABI is not checked.
          { chainId: 1, to: TARGET, data: '0xdeadbeef' },
        ],
        actual.functionFromCall,
      ),
    ).toEqual([
      expect.stringContaining('Missing args: transfer with no args'),
      expect.stringContaining('Relayed: transfer with 2 args'),
      expect.stringContaining('Wrong args: transfer with 2 args'),
      expect.stringContaining('Step: transfer with 2 args'),
    ])
  })

  it('reports a call a test hands to a mock, even after the mock is cleared', () => {
    const review = vi.fn().mockName('review')
    review({ calls: [good] })
    review({ calls: [missingArgs] })
    review.mockClear()
    expect(takeUndecodedReviewCalls()).toEqual([
      expect.stringContaining('review was given Missing args'),
    ])
    expect(takeUndecodedReviewCalls()).toEqual([])
  })

  it('reports a call the review dialog renders as raw bytes', async () => {
    const decode = await import('@bananapus/nana-sdk-core/review/decode')
    expect(decode.functionFromCall(good)?.name).toBe('transfer')
    expect(decode.functionFromCall(wrongArgs)).toBeNull()
    expect(takeUndecodedReviewCalls()).toEqual([
      'the review dialog rendered Wrong args as raw bytes',
    ])
  })
})
