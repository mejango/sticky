import type { functionFromCall } from '@bananapus/nana-sdk-core/review/decode'

type Decode = typeof functionFromCall

type CallLike = {
  data: string
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[]
  label?: unknown
}

function isCallLike(value: object): value is CallLike {
  const call = value as Partial<CallLike>
  return (
    typeof call.data === 'string' &&
    Array.isArray(call.abi) &&
    typeof call.functionName === 'string'
  )
}

/** A call the review dialog would show as raw bytes, described for a failure message. */
function undecodedCall(call: unknown, decode: Decode): string | null {
  if (!call || typeof call !== 'object' || !isCallLike(call)) return null
  let decoded = null
  try {
    decoded = decode(call as unknown as Parameters<Decode>[0])
  } catch {
    // A call that cannot even be read is reported below.
  }
  if (decoded) return null
  return `${String(call.label ?? call.functionName)}: ${call.functionName} with ${
    call.args ? `${call.args.length} args` : 'no args'
  } does not decode ${call.data.slice(0, 10)}…`
}

/** How deep the search goes: a mock's arguments, a request, its steps or calls, a step. */
const MAX_DEPTH = 6

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Every call in `value` that carries an ABI but does not decode with the SDK's
 * `functionFromCall`: its `args` are missing, or are not what its calldata
 * carries, so the review dialog shows it as raw bytes. Arrays and every own
 * value of a plain object are searched, to a bounded depth, so a review
 * request, a batch and its steps, a relayed call and its review context are
 * all covered. Class instances (DOM nodes, events, React fibers) and ABIs are
 * not searched.
 */
export function undecodedCalls(
  value: unknown,
  decode: Decode,
  seen = new WeakSet<object>(),
  depth = 0,
): string[] {
  if (depth > MAX_DEPTH || !value || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  const next = (item: unknown) => undecodedCalls(item, decode, seen, depth + 1)
  if (Array.isArray(value)) return value.flatMap(next)
  if (!isPlainObject(value)) return []
  const found = undecodedCall(value, decode)
  const nested = Object.entries(value).flatMap(([key, item]) => (key === 'abi' ? [] : next(item)))
  return [...(found ? [found] : []), ...nested]
}
