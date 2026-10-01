import { BaseError, ContractFunctionRevertedError } from 'viem'
import { TransactionReviewCancelledError } from '@/lib/transaction-review'

/** A validation failure with copy that's already user-ready. */
export class FlowError extends Error {}

/** A revert means the chain answered, so a missing feed (or similar) is a fact about the
 *  protocol rather than about the network. */
export function contractReverted(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    !!error.walk(cause => cause instanceof ContractFunctionRevertedError)
  )
}

/** viem's generic labels for errors it cannot classify; the transport's own text sits in `details`. */
const GENERIC_RPC_LABEL =
  /unknown RPC error|Missing or invalid parameters|RPC Request failed|HTTP request failed/i

/** The one-line message of a viem error, preferring the node's or gateway's text over viem's generic label. */
function viemMessage(error: Error): string {
  const short =
    'shortMessage' in error && typeof error.shortMessage === 'string'
      ? error.shortMessage
      : error.message
  const details =
    'details' in error && typeof error.details === 'string' ? error.details : ''
  return (GENERIC_RPC_LABEL.test(short) && details ? details : short).split('\n')[0]
}

/**
 * Trim a raw simulation/wallet error down to its useful first line, with the
 * denied/rejected cases mapped to friendly copy. `fallback` covers non-Error
 * throws.
 */
export function shortError(
  error: unknown,
  fallback = 'Something went wrong.',
): string {
  if (error instanceof TransactionReviewCancelledError) return error.message
  if (error instanceof Error) {
    const message = viemMessage(error)
    if (/denied|rejected/i.test(message)) return 'Transaction cancelled.'
    return message
  }
  return fallback
}

/** A friendly one-line message out of a viem/wagmi error. */
export function friendlyError(e: unknown): string {
  if (e instanceof TransactionReviewCancelledError) return e.message
  const message =
    e instanceof BaseError
      ? viemMessage(e)
      : e instanceof Error
        ? e.message
        : 'Something went wrong.'
  return /reject|denied|cancel/i.test(message)
    ? 'You cancelled in your wallet.'
    : message
}
