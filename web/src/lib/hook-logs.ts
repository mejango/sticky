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
import { failures, isRateLimited, retryAfterOf, type Failure } from '@/lib/center-limit'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { stickyHookAbi } from '@/lib/sticky-abis'
import { deploymentOn } from '@/lib/sticky-addresses'

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

/** What one error says, without viem's own framing (its docs link, version and request). */
const said = ({ details, message }: Failure) => (typeof details === 'string' ? details : String(message ?? ''))

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
  const asked = retryAfterOf(error)
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

/** The chain's head as the node says it now. viem hands a head it read in the last few seconds to the next read, and
 * a read made right after a write lands must not pin a block before it; a head request already under way is shared. */
export function freshHead(client: Pick<PublicClient, 'getBlockNumber'>, signal: AbortSignal | undefined): Promise<bigint> {
  return untilAborted(client.getBlockNumber({ cacheTime: 0 }), signal)
}

/** What `work` gives, or an error that names `what` and keeps the cause. A signal that has aborted stops it before it
 * starts, and its reason, like any it aborts with, is the caller's own and goes through as it is. */
export async function asked<T>(what: string, work: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  try {
    if (signal?.aborted) throw signal.reason
    return await untilAborted(work(), signal)
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new Error(`${what} could not be read.`, { cause })
  }
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

/** Where an event is in the chain. An event Bendystraw's hook history lists has no block, and counts as block 0. */
type InChain = { blockNumber: bigint | null; logIndex: number }

/** The chain's order: by block, then by place in the block. */
export function inChainOrder(a: InChain, b: InChain): number {
  const [x, y] = [a.blockNumber ?? 0n, b.blockNumber ?? 0n]
  return x === y ? a.logIndex - b.logIndex : x < y ? -1 : 1
}

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
    .sort(inChainOrder)
}

/** A history that takes more requests than a scan may send even when none of them fails: trying again cannot help,
 * only a history that starts later. A scan that runs out of requests in the middle, by splitting and retrying, is an
 * ordinary error: it may not the next time. */
export class HistoryTooLongError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HistoryTooLongError'
  }
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
  const tooLong = `This history spans ${blocks} blocks, more than this RPC can scan in ${maxRequests} requests.`
  const overBudget = () => new Error(tooLong)
  // The fewest requests the history can take. Splitting and retrying only add to it.
  if (Number((blocks + WINDOW - 1n) / WINDOW) > maxRequests) throw new HistoryTooLongError(tooLong)

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

/** Whether `error` is the browser saying this site's storage is full, as each browser words it. */
function isQuotaExceeded(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { name, code } = error as { name?: unknown; code?: unknown }
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014
}

/** When a kept history was written, in milliseconds, from its first field, which is read without parsing the rest. One
 * the old client wrote has none, and counts as the oldest. */
function writtenAt(stored: string | null): number {
  const match = /^\{"at":(\d{1,16})[,}]/.exec(stored?.slice(0, 32) ?? '')
  return match ? Number(match[1]) : 0
}

/** Makes room for `needed` characters by removing the kept histories written longest ago, other than `writing`, the one
 * that needs it: each one removed is scanned again when it is next read. Nothing else this site keeps is ever removed:
 * not the persisted query cache, the wallet's connection or View as. */
function evictHistories(needed: number, writing: string): void {
  const histories: { name: string; at: number; size: number }[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const name = localStorage.key(index)
    if (name === null || name === writing || !name.startsWith(HISTORY_KEY)) continue
    const stored = localStorage.getItem(name)
    histories.push({ name, at: writtenAt(stored), size: name.length + (stored?.length ?? 0) })
  }
  histories.sort((a, b) => a.at - b.at)
  let freed = 0
  for (const { name, size } of histories) {
    if (freed >= needed) return
    localStorage.removeItem(name)
    freed += size
  }
}

/** Keeps a history under `key`, every kept history's one way in. When the site's storage is full, the histories written
 * longest ago make room and the write is tried once more; when it still does not fit it is not kept, and the next read
 * scans again. */
function writeHistory(key: string, from: bigint, through: bigint, logs: ScannedLog[]): void {
  const name = HISTORY_KEY + key
  try {
    // The write time comes first, so that making room reads it without parsing a history.
    const at = Date.now()
    const payload = JSON.stringify({ at, from: from.toString(), through: through.toString(), all: logs.map(toRpc) })
    if (payload.length > HISTORY_MAX_CHARS) {
      localStorage.removeItem(name)
      return
    }
    try {
      localStorage.setItem(name, payload)
    } catch (error) {
      if (!isQuotaExceeded(error)) throw error
      evictHistories(name.length + payload.length, name)
      localStorage.setItem(name, payload)
    }
  } catch {
    // Storage is blocked or absent, or still full: the next visit scans again.
  }
}

/** The logs of one contract and topic filter on a chain Sticky is deployed on, from `fromBlock` to the head, read
 * through Center. History below a buried block cannot change, so this browser keeps it under `key` and the next read
 * scans only what came after. Only public events are kept, and nothing that belongs to a wallet.
 * A history that began later than `fromBlock` lacks what came before, so it is not used and the scan
 * starts from `fromBlock`; one the old client kept has no start and counts as beginning at the project's.
 * A null `fromBlock` is a project whose start could not be found: a kept history is used whatever block
 * it began at, and without one the scan starts at the deployer's block, before which no project exists.
 * When `signal` aborts the call rejects with its reason and writes nothing. `key` names one filter's history: a read
 * of another filter must use another key. `keep` is what the history keeps of each log, the whole log unless it says
 * otherwise; a history longer than its size cap is not kept at all. */
export async function keptLogs(
  chainId: number,
  key: string,
  filter: { address: Address; topics: (Hex | Hex[] | null)[]; fromBlock: bigint | null },
  opts: { signal?: AbortSignal; keep?: (log: ScannedLog) => ScannedLog } = {},
): Promise<ScannedLog[]> {
  return keptLogsOf(chainId, [{ key, owns: () => true }], filter, opts)
}

/** One history a scan keeps: the logs it `owns` of what the scan reads, kept under `key`. */
type KeptHistory = { key: string; owns: (log: ScannedLog) => boolean }

/**
 * `keptLogs` for a filter whose logs make several histories, as one scan of the terminal reads the pays of several
 * projects: each history is kept under its own key, as `keptLogs` keeps one, and one scan reads what is new to any of
 * them, from just after the least that one of them kept. A history the scan reads again in part keeps each log once.
 * A history that ends before `fromBlock` holds nothing the read asked for, so the scan does not read the blocks
 * between: it starts at `fromBlock`, and so does the history it keeps from then on. No history ever moves backwards:
 * one is not rewritten through an earlier block than it holds, whether or not this read could use it. With `trim`, a
 * history keeps nothing from before `fromBlock`, so that it holds what its reads ask for and no more. What is returned
 * is every history's logs, kept and new, and the new ones no history owns, which are not kept.
 */
export async function keptLogsOf(
  chainId: number,
  histories: readonly KeptHistory[],
  { address, topics, fromBlock }: { address: Address; topics: (Hex | Hex[] | null)[]; fromBlock: bigint | null },
  opts: { signal?: AbortSignal; keep?: (log: ScannedLog) => ScannedLog; trim?: boolean } = {},
): Promise<ScannedLog[]> {
  const { signal, keep = (log: ScannedLog) => log, trim = false } = opts
  const deployment = deploymentOn(chainId)
  throwIfAborted(signal)
  const client = jbCenterPublicClient(chainId)
  const start = fromBlock ?? deployment.fromBlock
  // What each key holds, and of that what this read can use: a history that began after `fromBlock` lacks what came
  // before it, and is set aside.
  const stored = histories.map(({ key }) => readHistory(key))
  const kept = stored.map(saved =>
    saved && (fromBlock === null || saved.from === undefined || saved.from <= fromBlock) ? saved : null,
  )
  const head = await freshHead(client, signal)
  // The scan starts after what was kept, so a block every history holds is never asked for again. With no block to
  // start at, every kept history goes on from where it ends.
  const goesOn = (saved: Kept) => fromBlock === null || saved.through + 1n >= fromBlock
  const starts = kept.map(saved => (saved && goesOn(saved) ? saved.through + 1n : start))
  const scanFrom = starts.reduce((low, next) => (next < low ? next : low), starts[0] ?? start)
  const fresh = await scanLogs(client, { address, topics, fromBlock: scanFrom, toBlock: head }, { signal })
  const buried = head - REORG_DEPTH
  histories.forEach(({ key, owns }, at) => {
    // Nothing a reorg could still replace is kept.
    if (head <= REORG_DEPTH) return
    // A history goes on from what it kept when the scan began no later than the block after it; otherwise it starts
    // again where the scan did. Either way it holds every log it owns from where it starts, and a trimmed one starts at
    // `fromBlock`.
    const saved = kept[at]
    const continued = saved !== null && saved.through + 1n >= scanFrom
    const begins = continued ? (saved.from ?? start) : scanFrom
    const from = trim && fromBlock !== null && fromBlock > begins ? fromBlock : begins
    // No history moves backwards, the one this read set aside included: it is rewritten only through a later block, or
    // through the same one from an earlier block, which holds more.
    const before = stored[at]
    if (before && (buried < before.through || (buried === before.through && from >= (before.from ?? start)))) return
    const logs = tidy([...(continued ? saved.logs : []), ...fresh.filter(owns)])
    writeHistory(key, from, buried, logs.filter(log => log.blockNumber >= from && log.blockNumber <= buried).map(keep))
  })
  return tidy([...kept.flatMap(saved => saved?.logs ?? []), ...fresh])
}

/** Every hook event of one project on one chain, from `fromBlock` to the head, read through Center and kept in this
 * browser as `keptLogs` keeps a history, under the key the old client kept it under. */
export async function projectHookLogs(
  chainId: number,
  projectId: bigint,
  fromBlock: bigint | null,
  opts: { signal?: AbortSignal } = {},
): Promise<ScannedLog[]> {
  const deployment = deploymentOn(chainId)
  const key = `${chainId}:${deployment.hook.toLowerCase()}:${projectId}`
  const topics = [PROJECT_TOPICS, pad(toHex(projectId), { size: 32 })]
  return keptLogs(chainId, key, { address: deployment.hook, topics, fromBlock }, opts)
}
