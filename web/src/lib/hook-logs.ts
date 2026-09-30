import {
  getAbiItem,
  isAddress,
  isHex,
  numberToHex,
  pad,
  toEventSelector,
  toHex,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { stickyHookAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'

/** A log that is in a block, so it has a block, a hash and an index. Center also sends the block's
 * timestamp with it, which viem keeps as `blockTimestamp`. */
export type ScannedLog = Log<bigint, number, false>

/** JB Center refuses an eth_getLogs range of more than 500 blocks with JSON-RPC -32005 and no range in
 * its message, so a scan asks for 500 at a time instead of asking for more and splitting. */
const WINDOW = 500n
/** What a range waits before each retry after a 429 that says nothing about how long. A range is retried at
 * most this many times. */
const BACKOFF_MS = [1_000, 2_000, 4_000] as const
/** Center counts requests in a window of a minute, so it never asks for a longer wait. */
const MAX_WAIT_MS = 60_000
/** Center applies one rate limit to every chain, so a scan keeps at most this many requests in flight. */
const MAX_IN_FLIGHT = 2
const MAX_REQUESTS = 1_024

// Nodes limit the range or the result of a log request in different ways. A refused range is split, and a
// scan never reports a partial history as a complete one.
const RANGE_ERROR = /range|limit|too (?:many|large)|exceed|response size|query returned|block distance/i

/** The largest block span a node names in its error, like "eth_getLogs is limited to a 1,000 range". */
export function statedRange(message: string): bigint {
  const match = /(?:limit(?:ed)?|max(?:imum)?|exceeds?|up to)[^0-9]{0,40}([0-9][0-9,_]*)\s*(?:-?block)?/i.exec(message)
  const span = match ? BigInt(match[1].replace(/[,_]/g, '')) : 0n
  return span >= 10n && span <= 10_000_000n ? span : 0n
}

type Failure = { status?: unknown; code?: unknown; message?: unknown; details?: unknown; retryAfter?: unknown }

/** An error and what it wraps, outermost first. viem wraps whatever its transport throws, so the HTTP
 * status or the JSON-RPC code Center answered with usually sits on a cause. */
function failures(error: unknown): Failure[] {
  const chain: Failure[] = []
  for (
    let next = error;
    typeof next === 'object' && next !== null && chain.length < 8;
    next = (next as { cause?: unknown }).cause
  ) {
    chain.push(next as Failure)
  }
  return chain
}

/** What one error says, without viem's own framing (its docs link, version and request). */
const said = ({ details, message }: Failure) => (typeof details === 'string' ? details : String(message ?? ''))

const isRateLimited = (error: unknown) => failures(error).some(({ status, code }) => status === 429 || code === 429)

const refusesRange = (error: unknown) =>
  failures(error).some(link => link.status === 413 || link.code === -32005 || RANGE_ERROR.test(said(link)))

const statedIn = (error: unknown) =>
  failures(error)
    .map(link => statedRange(said(link)))
    .find(span => span > 0n) ?? 0n

/** How long a range waits before its next try after a 429. Center's window is a fixed minute in which refused
 * requests count too, so a retry sooner than Center says lands in the same window and is refused again. The SDK
 * reads Center's Retry-After header into `retryAfter`, in seconds, on the error it throws: the range waits that
 * long, never less than the schedule and never more than a minute. With none it waits as the schedule says. */
function waitAfter(error: unknown, retry: number): number {
  const asked = failures(error)
    .map(link => link.retryAfter)
    .find((seconds): seconds is number => typeof seconds === 'number' && Number.isFinite(seconds))
  return asked === undefined ? BACKOFF_MS[retry] : Math.min(Math.max(asked * 1_000, BACKOFF_MS[retry]), MAX_WAIT_MS)
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason
}

/** Waits `ms`, or rejects with the signal's reason the moment it aborts, leaving no timer behind. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    function abort() {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** What `work` gives, or the signal's reason the moment it aborts. Neither viem nor the SDK cancels a request
 * that is under way, so `work` is left to finish on its own, its answer or failure unheeded. */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** [from, to] ranges of at most `span` blocks that cover `from` to `to` exactly. */
function windowsOf(from: bigint, to: bigint, span: bigint): [bigint, bigint][] {
  const windows: [bigint, bigint][] = []
  for (let low = from; low <= to; low += span) windows.push([low, low + span - 1n < to ? low + span - 1n : to])
  return windows
}

const HASH = /^0x[0-9a-fA-F]{64}$/
const QUANTITY = /^0x[0-9a-fA-F]+$/
const isHash = (value: unknown): value is Hex => typeof value === 'string' && HASH.test(value)

/** A JSON-RPC quantity as a bigint, or null when it is not one. */
const quantity = (value: unknown) => (typeof value === 'string' && QUANTITY.test(value) ? BigInt(value) : null)

/** One log as a node writes it, or as this browser kept it, checked field by field. */
function readLog(raw: unknown): ScannedLog {
  const item = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const blockNumber = quantity(item.blockNumber)
  const logIndex = quantity(item.logIndex)
  const transactionIndex = quantity(item.transactionIndex)
  const stamp = item.blockTimestamp
  const blockTimestamp = stamp === undefined || stamp === null ? undefined : quantity(stamp)
  const { address, blockHash, transactionHash, data, topics } = item
  if (
    blockNumber === null ||
    logIndex === null ||
    transactionIndex === null ||
    blockTimestamp === null ||
    typeof address !== 'string' ||
    !isAddress(address, { strict: false }) ||
    !isHash(blockHash) ||
    !isHash(transactionHash) ||
    !isHex(data) ||
    !Array.isArray(topics) ||
    !topics.every(isHash)
  ) {
    throw new Error('The RPC returned an incomplete project event.')
  }
  return {
    address,
    blockHash,
    blockNumber,
    ...(blockTimestamp === undefined ? {} : { blockTimestamp }),
    data,
    logIndex: Number(logIndex),
    removed: false,
    topics: topics as ScannedLog['topics'],
    transactionHash,
    transactionIndex: Number(transactionIndex),
  }
}

/** A log as JSON-RPC writes it: how a bigint fits in JSON, and how the old client kept its history. */
const toRpc = (log: ScannedLog) => ({
  address: log.address,
  blockHash: log.blockHash,
  blockNumber: numberToHex(log.blockNumber),
  ...(log.blockTimestamp === undefined ? {} : { blockTimestamp: numberToHex(log.blockTimestamp) }),
  data: log.data,
  logIndex: numberToHex(log.logIndex),
  removed: false,
  topics: log.topics,
  transactionHash: log.transactionHash,
  transactionIndex: numberToHex(log.transactionIndex),
})

const isRemoved = (raw: unknown) => typeof raw === 'object' && raw !== null && (raw as { removed?: unknown }).removed === true

/** In block order, then log order, once each: a node may repeat a log or order a range as it likes. */
function tidy(found: ScannedLog[]): ScannedLog[] {
  const seen = new Set<string>()
  return found
    .filter(({ blockHash, transactionHash, logIndex }) => {
      const key = `${blockHash}:${transactionHash}:${logIndex}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1))
}

/** Every log of an address and topic filter from `fromBlock` to `toBlock`, in order, or an error: never a
 * part of them. Ranges are read 500 blocks at a time with at most `maxInFlight` requests at once. A
 * refused range is split, a 429 waits as long as Center asks and retries, and no more than `maxRequests`
 * are sent in all: a history that would take more is refused before the first one. Once one range has
 * failed, no more are sent. When `signal` aborts, the scan rejects with its reason at once, in the middle
 * of a request or a wait too, and sends nothing more. */
export async function scanLogs(
  client: PublicClient,
  q: { address: Address; topics: (Hex | Hex[] | null)[]; fromBlock: bigint; toBlock: bigint },
  opts: { maxInFlight?: number; maxRequests?: number; signal?: AbortSignal } = {},
): Promise<ScannedLog[]> {
  const { maxInFlight = MAX_IN_FLIGHT, maxRequests = MAX_REQUESTS, signal } = opts
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1) {
    throw new RangeError(`maxInFlight must be a whole number of at least 1, not ${maxInFlight}.`)
  }
  const { address, topics, fromBlock, toBlock } = q
  if (fromBlock > toBlock) return []

  const blocks = toBlock - fromBlock + 1n
  const overBudget = () => new Error(`This history spans ${blocks} blocks, more than this RPC can scan in ${maxRequests} requests.`)
  // The fewest requests the history can take. Splitting and retrying only add to it.
  if (Number((blocks + WINDOW - 1n) / WINDOW) > maxRequests) throw overBudget()

  let sent = 0
  let failed: { error: unknown } | null = null
  let running = 0
  const waiting: (() => void)[] = []
  const acquire = async () => {
    if (running < maxInFlight) running += 1
    else await new Promise<void>(resolve => waiting.push(resolve))
  }
  const release = () => {
    const next = waiting.shift()
    if (next) next()
    else running -= 1
  }

  async function ask(from: bigint, to: bigint): Promise<ScannedLog[]> {
    const answer: unknown = await untilAborted(
      client.request(
        { method: 'eth_getLogs', params: [{ address, topics, fromBlock: numberToHex(from), toBlock: numberToHex(to) }] },
        signal && { signal },
      ),
      signal,
    )
    if (!Array.isArray(answer)) throw new Error('The RPC returned invalid project history.')
    return answer.filter(raw => !isRemoved(raw)).map(readLog)
  }

  // One range, one request. A 429 keeps its place among the requests in flight while it waits, so the scan
  // slows down rather than sending others in the meantime, and its retries are requests like any other.
  async function fetchRange(from: bigint, to: bigint): Promise<ScannedLog[]> {
    await acquire()
    try {
      for (let retry = 0; ; retry += 1) {
        if (failed) throw failed.error
        throwIfAborted(signal)
        if (sent >= maxRequests) throw overBudget()
        sent += 1
        try {
          return await ask(from, to)
        } catch (error) {
          if (retry === BACKOFF_MS.length || sent >= maxRequests || !isRateLimited(error)) throw error
          await sleep(waitAfter(error, retry), signal)
        }
      }
    } finally {
      release()
    }
  }

  async function range(from: bigint, to: bigint): Promise<ScannedLog[]> {
    try {
      return await fetchRange(from, to)
    } catch (error) {
      // A 429 says nothing about the range, however its message reads, so it is never split.
      if (failed || from === to || isRateLimited(error) || !refusesRange(error)) {
        failed ??= { error }
        throw error
      }
      // Straight to the span the node names, otherwise in halves. Both parts are asked at once and the
      // limit on requests in flight keeps the burst bounded. Order is kept.
      const span = statedIn(error)
      if (span > 0n && span < to - from + 1n) {
        const parts = await Promise.all(windowsOf(from, to, span).map(([low, high]) => range(low, high)))
        return parts.flat()
      }
      const middle = (from + to) / 2n
      const [low, high] = await Promise.all([range(from, middle), range(middle + 1n, to)])
      return [...low, ...high]
    }
  }

  const windows = windowsOf(fromBlock, toBlock, WINDOW)
  const found: ScannedLog[][] = []
  let next = 0
  const worker = async () => {
    while (next < windows.length) {
      const at = next++
      found[at] = await range(...windows[at])
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxInFlight, windows.length) }, worker))
  return tidy(found.flat())
}

const HISTORY_KEY = 'sticky.history.v1:'
/** A block this many blocks below the head can no longer be replaced by a reorg. */
const REORG_DEPTH = 64n
const HISTORY_MAX_CHARS = 400_000

/** What a project page reads from the hook, each event indexed by project id as its first topic. */
const PROJECT_EVENTS = [
  'Staked',
  'Unstaked',
  'StreakStarted',
  'StreakEnded',
  'SetGranter',
  'SetTrustedSender',
  'ExcludeOrphanedBalance',
] as const
const PROJECT_TOPICS = PROJECT_EVENTS.map(name => toEventSelector(getAbiItem({ abi: stickyHookAbi, name }) as AbiEvent))

/** A kept history holds every log from block `from` through block `through`. The old client wrote none. */
type Kept = { from: bigint | undefined; through: bigint; logs: ScannedLog[] }

const isBlockNumber = (value: unknown): value is string => typeof value === 'string' && /^[0-9]+$/.test(value)

/** The history this browser kept for a project, or null when there is none or it cannot be trusted:
 * a history with one log in doubt is not used at all. */
function readHistory(key: string): Kept | null {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY + key) ?? 'null')
    if (typeof kept !== 'object' || kept === null) return null
    const { from, through, all } = kept as { from?: unknown; through?: unknown; all?: unknown }
    if (!isBlockNumber(through) || !Array.isArray(all) || (from !== undefined && !isBlockNumber(from))) return null
    const start = from === undefined ? undefined : BigInt(from)
    const bound = BigInt(through)
    const logs = all.map(readLog)
    const inside = (log: ScannedLog) => log.blockNumber <= bound && (start === undefined || log.blockNumber >= start)
    return logs.every(inside) ? { from: start, through: bound, logs } : null
  } catch {
    return null
  }
}

function writeHistory(key: string, from: bigint, through: bigint, logs: ScannedLog[]): void {
  try {
    const payload = JSON.stringify({ from: from.toString(), through: through.toString(), all: logs.map(toRpc) })
    if (payload.length > HISTORY_MAX_CHARS) localStorage.removeItem(HISTORY_KEY + key)
    else localStorage.setItem(HISTORY_KEY + key, payload)
  } catch {
    // Storage is full, blocked or absent: the next visit scans again.
  }
}

/** Every hook event of one project on one chain, from `fromBlock` to the head, read through Center.
 * A project's history below a buried block cannot change, so this browser keeps it and the next visit
 * scans only what came after. Only public events are kept, and nothing that belongs to a wallet.
 * A history that began later than `fromBlock` lacks what came before, so it is not used and the scan
 * starts from `fromBlock`; one the old client kept has no start and counts as beginning at the project's.
 * When `signal` aborts the call rejects with its reason and writes nothing. */
export async function projectHookLogs(
  chainId: number,
  projectId: bigint,
  fromBlock: bigint,
  opts: { signal?: AbortSignal } = {},
): Promise<ScannedLog[]> {
  const { signal } = opts
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  throwIfAborted(signal)
  const client = jbCenterPublicClient(chainId)
  const key = `${chainId}:${deployment.hook.toLowerCase()}:${projectId}`
  const saved = readHistory(key)
  const kept = saved && (saved.from === undefined || saved.from <= fromBlock) ? saved : null
  const head = await untilAborted(client.getBlockNumber(), signal)
  // The scan starts after what was kept, so the two never overlap.
  const fresh = await scanLogs(
    client,
    {
      address: deployment.hook,
      topics: [PROJECT_TOPICS, pad(toHex(projectId), { size: 32 })],
      fromBlock: kept ? kept.through + 1n : fromBlock,
      toBlock: head,
    },
    { signal },
  )
  const all = tidy([...(kept?.logs ?? []), ...fresh])
  if (head > REORG_DEPTH) {
    const buried = head - REORG_DEPTH
    // A kept history never moves backwards, and keeps nothing a reorg could still replace.
    if (!kept || buried > kept.through) {
      writeHistory(key, kept?.from ?? fromBlock, buried, all.filter(log => log.blockNumber <= buried))
    }
  }
  return all
}
