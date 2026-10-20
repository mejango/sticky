import { decodePayFailure } from '@bananapus/nana-sdk-core/v6'
import { decodeErrorResult, formatUnits } from 'viem'
import { stickyAutoStickAbi } from '@/lib/sticky-abis'

/** Why a stick failed, in one line, and whether a fresh quote is the fix. */
export type StickFailure = { message: string; requote: boolean }

const SHORTFALL_ERROR = 'StickyAutoStick_InsufficientStickyTokens'

/** Sticky's own shortfall revert, found anywhere in a viem or wallet error, decoded or as revert data. */
function stickyShortfall(error: unknown): { received: bigint; minimum: bigint } | null {
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): { received: bigint; minimum: bigint } | null => {
    if (depth > 8 || value === null || value === undefined || seen.has(value)) return null
    if (typeof value === 'string') {
      if (!/^0x[0-9a-f]{8}/i.test(value)) return null
      try {
        const decoded = decodeErrorResult({ abi: stickyAutoStickAbi, data: value as `0x${string}` })
        return decoded.errorName === SHORTFALL_ERROR ? { received: decoded.args[0], minimum: decoded.args[1] } : null
      } catch {
        return null
      }
    }
    if (typeof value !== 'object') return null
    seen.add(value)
    const record = value as { errorName?: unknown; args?: unknown; raw?: unknown; data?: unknown; cause?: unknown }
    if (record.errorName === SHORTFALL_ERROR && Array.isArray(record.args)) {
      return { received: record.args[0] as bigint, minimum: record.args[1] as bigint }
    }
    for (const next of [record.raw, record.data, record.cause]) {
      const found = visit(next, depth + 1)
      if (found) return found
    }
    return null
  }
  return visit(error, 0)
}

/**
 * Why a stick reverted, from a simulation or transaction error. A stick that would mint less than its quote (the
 * terminal's minimum, or Sticky's own check after it) says by how much and is quoted again; other known payment
 * reverts give the SDK's line. Unknown reverts return null.
 */
export function stickFailure(error: unknown, stSymbol: string): StickFailure | null {
  const pay = decodePayFailure(error)
  const shortfall =
    pay?.reason === 'TERMINAL_UNDER_MIN' && pay.received !== undefined && pay.minimum !== undefined
      ? { received: pay.received, minimum: pay.minimum }
      : stickyShortfall(error)
  if (shortfall) {
    return {
      message: `This stick would return ${formatUnits(shortfall.received, 18)} ${stSymbol}, under its ${formatUnits(shortfall.minimum, 18)} ${stSymbol} minimum. Review again for a fresh quote.`,
      requote: true,
    }
  }
  // A stick's minimum is its exact quote: a looser one is never offered, a fresh quote is.
  if (pay?.reason === 'TERMINAL_UNDER_MIN') {
    return { message: 'This stick would return less than its minimum. Review again for a fresh quote.', requote: true }
  }
  return pay ? { message: pay.message, requote: false } : null
}
