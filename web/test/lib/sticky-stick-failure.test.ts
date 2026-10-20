import { stickyAutoStickAbi } from '@bananapus/nana-sdk-core'
import { encodeErrorResult } from 'viem'
import { describe, expect, it } from 'vitest'
import { stickFailure } from '@/lib/sticky-stick-failure'

const E = 10n ** 18n
const underMin = (received: bigint, minimum: bigint) =>
  encodeErrorResult({
    abi: [{ type: 'error', name: 'JBMultiTerminal_UnderMin', inputs: [{ type: 'uint256' }, { type: 'uint256' }] }],
    errorName: 'JBMultiTerminal_UnderMin',
    args: [received, minimum],
  })

describe('stickFailure', () => {
  it('reads the terminal minimum a stick missed, from revert data however nested', () => {
    expect(stickFailure({ shortMessage: 'reverted', cause: { data: underMin(2n * E, 3n * E) } }, 'stX')).toEqual({
      message: 'This stick would return 2 stX, under its 3 stX minimum. Review again for a fresh quote.',
      requote: true,
    })
  })
  it("reads Sticky's own shortfall, raw or decoded", () => {
    const raw = encodeErrorResult({ abi: stickyAutoStickAbi, errorName: 'StickyAutoStick_InsufficientStickyTokens', args: [E, 2n * E] })
    const line = 'This stick would return 1 stX, under its 2 stX minimum. Review again for a fresh quote.'
    expect(stickFailure({ data: raw }, 'stX')).toEqual({ message: line, requote: true })
    expect(stickFailure({ cause: { data: { errorName: 'StickyAutoStick_InsufficientStickyTokens', args: [E, 2n * E] } } }, 'stX')).toEqual({ message: line, requote: true })
  })
  it('quotes again for a minimum named without amounts, never offers a looser one', () => {
    expect(stickFailure(new Error('JBMultiTerminal_UnderMin'), 'stX')).toEqual({
      message: 'This stick would return less than its minimum. Review again for a fresh quote.',
      requote: true,
    })
  })
  it("gives the SDK's line for other known reverts, and null for unknown ones", () => {
    expect(stickFailure({ data: '0x8dc14446' }, 'stX')).toEqual({ message: 'This project is not accepting payments right now.', requote: false })
    expect(stickFailure(new Error('boom'), 'stX')).toBeNull()
    expect(stickFailure({ data: '0xdeadbeef' }, 'stX')).toBeNull()
  })
})
