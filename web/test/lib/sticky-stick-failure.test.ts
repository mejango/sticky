import { stickyAutoStickAbi } from '@bananapus/nana-sdk-core'
import { encodeErrorResult, getAbiItem, maxUint256 } from 'viem'
import { describe, expect, it } from 'vitest'
import { stickFailure } from '@/lib/sticky-stick-failure'

const E = 10n ** 18n
const abiItem = getAbiItem({ abi: stickyAutoStickAbi, name: 'StickyAutoStick_InsufficientStickyTokens' })
const decoded = (args: unknown[]) => ({ errorName: 'StickyAutoStick_InsufficientStickyTokens', abiItem, args })
const paused = encodeErrorResult({
  abi: [{ type: 'error', name: 'JBTerminalStore_RulesetPaymentPaused', inputs: [{ type: 'uint256' }, { type: 'uint256' }] }],
  errorName: 'JBTerminalStore_RulesetPaymentPaused',
  args: [1n, 2n],
})
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
    expect(stickFailure({ cause: { data: decoded([E, 2n * E]) } }, 'stX')).toEqual({ message: line, requote: true })
  })
  it("gives the SDK's line for other known reverts, and null for unknown ones", () => {
    expect(stickFailure({ data: paused }, 'stX')).toEqual({ message: 'This project is not accepting payments right now.', requote: false })
    expect(stickFailure(new Error('boom'), 'stX')).toBeNull()
    expect(stickFailure({ data: '0xdeadbeef' }, 'stX')).toBeNull()
  })
  it('ignores malformed or padded Sticky revert data and arguments', () => {
    const raw = encodeErrorResult({ abi: stickyAutoStickAbi, errorName: 'StickyAutoStick_InsufficientStickyTokens', args: [E, 2n * E] })
    expect(stickFailure({ data: raw + 'deadbeef' }, 'stX')).toBeNull()
    expect(stickFailure({ data: raw.slice(0, -2) }, 'stX')).toBeNull()
    expect(stickFailure(decoded([]), 'stX')).toBeNull()
    expect(stickFailure(decoded([null, null]), 'stX')).toBeNull()
    expect(stickFailure(decoded(['1', '2']), 'stX')).toBeNull()
    // A decoded error without this error's ABI item is not evidence.
    expect(stickFailure({ errorName: 'StickyAutoStick_InsufficientStickyTokens', args: [E, 2n * E] }, 'stX')).toBeNull()
    // Raw data decides on its own: padded bytes beside a decoded copy explain nothing (viem's ContractFunctionRevertedError shape).
    expect(stickFailure({ raw: raw + 'deadbeef', data: decoded([E, 2n * E]) }, 'stX')).toBeNull()
  })
  it('lets any revert data outrank a decoded copy, and a known pay revert outrank Sticky\'s check', () => {
    const raw = encodeErrorResult({ abi: stickyAutoStickAbi, errorName: 'StickyAutoStick_InsufficientStickyTokens', args: [E, 2n * E] })
    expect(stickFailure({ raw: paused, data: decoded([E, 2n * E]) }, 'stX')).toEqual({ message: 'This project is not accepting payments right now.', requote: false })
    expect(stickFailure({ raw: '0xdeadbeef', data: decoded([E, 2n * E]) }, 'stX')).toBeNull()
    expect(stickFailure({ raw: '0x12', data: decoded([E, 2n * E]) }, 'stX')).toBeNull()
    expect(stickFailure({ raw: paused, cause: { data: raw } }, 'stX')?.requote).toBe(false)
  })
  it('checks both ABI inputs, and never throws on a malformed one', () => {
    const raw = encodeErrorResult({ abi: stickyAutoStickAbi, errorName: 'StickyAutoStick_InsufficientStickyTokens', args: [E, 2n * E] })
    const holes = { errorName: 'StickyAutoStick_InsufficientStickyTokens', abiItem: { ...abiItem, inputs: new Array(2) }, args: [E, 2n * E] }
    const nulls = { errorName: 'StickyAutoStick_InsufficientStickyTokens', abiItem: { ...abiItem, inputs: [null, null] }, args: [E, 2n * E] }
    expect(stickFailure(holes, 'stX')).toBeNull()
    expect(stickFailure(nulls, 'stX')).toBeNull()
    expect(stickFailure({ raw, data: nulls }, 'stX')?.requote).toBe(true)
  })
  it('reads only a real shortfall: received under its minimum, both within uint256', () => {
    expect(stickFailure(decoded([2n * E, 2n * E]), 'stX')).toBeNull()
    expect(stickFailure(decoded([3n * E, 2n * E]), 'stX')).toBeNull()
    expect(stickFailure(decoded([E, maxUint256 + 1n]), 'stX')).toBeNull()
    const equal = encodeErrorResult({ abi: stickyAutoStickAbi, errorName: 'StickyAutoStick_InsufficientStickyTokens', args: [E, E] })
    expect(stickFailure({ data: equal }, 'stX')).toBeNull()
  })
  it('finds it inside a wallet error wrapper', () => {
    const raw = encodeErrorResult({ abi: stickyAutoStickAbi, errorName: 'StickyAutoStick_InsufficientStickyTokens', args: [E, 2n * E] })
    expect(stickFailure({ cause: { error: { data: raw } } }, 'stX')?.requote).toBe(true)
  })
  it('reads the terminal amounts only as bigints, and names a stick that would return nothing', () => {
    expect(stickFailure({ errorName: 'JBMultiTerminal_UnderMin', args: [null, null] }, 'stX')).toBeNull()
    expect(stickFailure(new Error('JBMultiTerminal_UnderMin'), 'stX')).toBeNull()
    expect(stickFailure({ data: underMin(0n, 3n * E) }, 'stX')).toEqual({
      message: 'This stick would return no stX. Review again for a fresh quote.',
      requote: true,
    })
  })
})
