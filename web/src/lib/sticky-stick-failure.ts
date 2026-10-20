import { decodePayFailure } from '@bananapus/nana-sdk-core/v6'
import { decodeErrorResult, formatUnits } from 'viem'
import { stickyAutoStickAbi } from '@/lib/sticky-abis'

/** Why a stick failed, in one line, and whether a fresh quote is the fix. */
export type StickFailure = { message: string; requote: boolean }

const SHORTFALL_ERROR = 'StickyAutoStick_InsufficientStickyTokens'
/** Its revert data: the selector and exactly two uint256 words. */
const SHORTFALL_DATA = /^0x[0-9a-f]{8}[0-9a-f]{128}$/i

const amounts = (args: unknown): { received: bigint; minimum: bigint } | null =>
  Array.isArray(args) && args.length === 2 && typeof args[0] === 'bigint' && typeof args[1] === 'bigint' && args[0] >= 0n && args[1] >= 0n
    ? { received: args[0], minimum: args[1] }
    : null

/** Sticky's own shortfall revert, found anywhere in a viem or wallet error, decoded or as revert data. */
function stickyShortfall(error: unknown): { received: bigint; minimum: bigint } | null {
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): { received: bigint; minimum: bigint } | null => {
    if (depth > 8 || value === null || value === undefined || seen.has(value)) return null
    if (typeof value === 'string') {
      if (!SHORTFALL_DATA.test(value)) return null
      try {
        const decoded = decodeErrorResult({ abi: stickyAutoStickAbi, data: value as `0x${string}` })
        return decoded.errorName === SHORTFALL_ERROR ? amounts(decoded.args) : null
      } catch {
        return null
      }
    }
    if (typeof value !== 'object') return null
    seen.add(value)
    const record = value as { errorName?: unknown; args?: unknown; raw?: unknown; data?: unknown; cause?: unknown; error?: unknown }
    if (record.errorName === SHORTFALL_ERROR) {
      const found = amounts(record.args)
      if (found) return found
    }
    for (const next of [record.raw, record.data, record.cause, record.error]) {
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
  const shortfall = (pay?.reason === 'TERMINAL_UNDER_MIN' ? amounts([pay.received, pay.minimum]) : null) ?? stickyShortfall(error)
  if (shortfall?.received === 0n) {
    return { message: `This stick would return no ${stSymbol} right now. Review again for a fresh quote.`, requote: true }
  }
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
