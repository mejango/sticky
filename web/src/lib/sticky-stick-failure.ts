import { decodePayFailure } from '@bananapus/nana-sdk-core/v6'
import { decodeErrorResult, encodeErrorResult, formatUnits, getAbiItem, maxUint256 } from 'viem'
import { stickyAutoStickAbi } from '@/lib/sticky-abis'

/** Why a stick failed, in one line, and whether a fresh quote is the fix. */
export type StickFailure = { message: string; requote: boolean }

const SHORTFALL_ERROR = 'StickyAutoStick_InsufficientStickyTokens'
const SHORTFALL_ITEM = getAbiItem({ abi: stickyAutoStickAbi, name: SHORTFALL_ERROR })
const SHORTFALL_SELECTOR = encodeErrorResult({ abi: [SHORTFALL_ITEM], errorName: SHORTFALL_ERROR, args: [0n, 0n] }).slice(0, 10).toLowerCase()
/** Its revert data: the selector and exactly two uint256 words. */
const SHORTFALL_DATA = /^0x[0-9a-f]{8}[0-9a-f]{128}$/i

type Shortfall = { received: bigint; minimum: bigint }

/** A real shortfall, as the SDK reads one: 0 <= received < minimum <= max uint256. */
const amounts = (args: unknown): Shortfall | null =>
  Array.isArray(args) && args.length === 2 && typeof args[0] === 'bigint' && typeof args[1] === 'bigint'
    && args[0] >= 0n && args[0] < args[1] && args[1] <= maxUint256
    ? { received: args[0], minimum: args[1] }
    : null

const sameInputs = (item: unknown): boolean => {
  const inputs = (item as { type?: unknown; name?: unknown; inputs?: { type?: unknown }[] } | null)
  return !!inputs && inputs.type === 'error' && inputs.name === SHORTFALL_ERROR && Array.isArray(inputs.inputs)
    && inputs.inputs.length === 2 && inputs.inputs.every(input => input.type === 'uint256')
}

/**
 * Sticky's own shortfall revert, found anywhere in a viem or wallet error, by the SDK's evidence rules: revert data
 * carrying its selector decides on its own and must be exactly canonical; without such data, a decoded error counts
 * only when typed against this error's ABI item.
 */
function stickyShortfall(error: unknown): Shortfall | null {
  const raws: string[] = []
  const decoded: unknown[] = []
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || value === undefined || seen.has(value)) return
    if (typeof value === 'string') {
      if (value.toLowerCase().startsWith(SHORTFALL_SELECTOR)) raws.push(value)
      return
    }
    if (typeof value !== 'object') return
    seen.add(value)
    const record = value as { errorName?: unknown; abiItem?: unknown; args?: unknown; raw?: unknown; data?: unknown; cause?: unknown; error?: unknown }
    if (record.errorName === SHORTFALL_ERROR && sameInputs(record.abiItem)) decoded.push(record.args)
    for (const next of [record.raw, record.data, record.cause, record.error]) visit(next, depth + 1)
  }
  visit(error, 0)
  if (raws.length) {
    for (const raw of raws) {
      if (!SHORTFALL_DATA.test(raw)) return null
      try {
        const found = amounts(decodeErrorResult({ abi: [SHORTFALL_ITEM], data: raw as `0x${string}` }).args)
        if (found) return found
      } catch { /* not this error */ }
    }
    return null
  }
  for (const args of decoded) {
    const found = amounts(args)
    if (found) return found
  }
  return null
}

/**
 * Why a stick reverted, from a simulation or transaction error. A stick that would mint less than its quote (the
 * terminal's minimum, or Sticky's own check after it) says by how much and is quoted again, never sent with a looser
 * minimum; other known payment reverts give the SDK's line. Unknown reverts return null.
 */
export function stickFailure(error: unknown, stSymbol: string): StickFailure | null {
  const pay = decodePayFailure(error)
  const shortfall = (pay?.reason === 'TERMINAL_UNDER_MIN' ? amounts([pay.received, pay.minimum]) : null) ?? stickyShortfall(error)
  if (shortfall?.received === 0n) {
    return { message: `This stick would return no ${stSymbol}. Review again for a fresh quote.`, requote: true }
  }
  if (shortfall) {
    return {
      message: `This stick would return ${formatUnits(shortfall.received, 18)} ${stSymbol}, under its ${formatUnits(shortfall.minimum, 18)} ${stSymbol} minimum. Review again for a fresh quote.`,
      requote: true,
    }
  }
  return pay ? { message: pay.message, requote: false } : null
}
