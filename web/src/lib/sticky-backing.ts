/**
 * The Overview chart's history: Total stuck, in the staked token, beside the number of active streaks, from the
 * project's first stick to now. The terminal's balance at each point is rebuilt backward from today's, which the page
 * reads from the chain: every pay, cash out, fee and addition to the balance after the point is undone, and the backing
 * the hook excluded as orphaned then is left out. The latest point is the header's Stuck exactly, and a flow the logs
 * miss only shifts older points. When the terminal's history cannot be read, or is longer than a scan may read, the
 * chart shows the Sticky share supply instead, and says so.
 *
 * The pays and cash outs come from Bendystraw, and a scan of the terminal from just below the block it is indexed
 * through adds the newer ones. Bendystraw records no fee a project paid, so the fees, and the additions to the balance
 * that share their layout, come from one scan of the terminal over the project's life, which this browser keeps so that
 * a return visit scans only the blocks since. When Bendystraw cannot answer, the pays and cash outs are scanned too,
 * and kept the same way.
 */

import { decodeEventLog, getAbiItem, pad, toEventSelector, toHex, type AbiEvent, type Hex } from 'viem'
import type { ScannedLog } from '@/lib/hook-logs'
import { terminalEventsAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import {
  eventKey,
  keptScanToHead,
  orNull,
  scanFrom,
  scanToHead,
  type StickyEvent,
  type StickyReadDeps,
} from '@/lib/sticky-events'
import { indexedStickyMoves, type IndexedMove } from '@/lib/sticky-indexed'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { terminalHistoryKey, withoutMemo } from '@/lib/terminal-history'

/** A change to the project's terminal balance, in the staked token's units, at a time in Unix seconds. */
export type Flow = { timestamp: number; delta: bigint }

/** The hook's ExcludeOrphanedBalance: from `timestamp` on, `amount` of the balance was nobody's. */
export type OrphanExclusion = { timestamp: number; amount: bigint }

/** A step of the chart: the number of active streaks and the Sticky shares staked after an event, with 18 decimals. */
export type SupplyPoint = { timestamp: number; streaks: number; staked: bigint }

/** A step with what the chart plots: Total stuck in the staked token's units, or the shares staked when the terminal's
 * history could not be read. */
export type SeriesPoint = SupplyPoint & { value: bigint }

export type BackingSeries = {
  points: SeriesPoint[]
  /** What `value` is in: the staked token, or when `supplyFallback` the Sticky shares. */
  unit: { decimals: number; symbol: string }
  /** True when the terminal's history could not be read, and the chart plots the share supply instead. */
  supplyFallback: boolean
}

/** What values the chart: the share supply's steps, the project as the chain says it is now, and the exclusions. */
export type BackingInputs = {
  /** The steps, oldest first, as `supplyPoints` builds them. */
  supply: readonly SupplyPoint[]
  /** What the terminal holds for the project now and what the hook has recorded as nobody's (`savedOrphaned`, which
   * while no shares exist is not all of the balance), and the tokens' units. */
  info: Pick<StickyProjectInfo, 'rawBacking' | 'savedOrphaned' | 'decimals' | 'symbol' | 'stSymbol'>
  /** The hook's exclusions, as `orphanExclusions` gives them. */
  orphans?: readonly OrphanExclusion[]
}

/** Every read `backingFlows` makes, so a test can stand in for Bendystraw and Center. */
export type FlowReadDeps = {
  /** Bendystraw's pays and cash outs of a project, with the block they are as of. */
  indexedMoves: typeof indexedStickyMoves
  /** The terminal's logs that match a filter, from its block through the head, each with its block's time. */
  scan: StickyReadDeps['scan']
  /** The same, with the history kept in this browser under a key, so a return visit scans only the blocks since. */
  keptScan: typeof keptScanToHead
}

/** A caller's signal, which every read gets, and in tests the reads to use instead of the real ones. */
export type FlowReadOptions = { signal?: AbortSignal } & Partial<FlowReadDeps>

/** Sticky shares always have 18 decimals. */
const SHARE_DECIMALS = 18

const eventNamed = (name: 'Pay' | 'CashOutTokens' | 'ProcessFee' | 'AddToBalance') =>
  getAbiItem({ abi: terminalEventsAbi, name }) as AbiEvent
const selector = (name: Parameters<typeof eventNamed>[0]) => toEventSelector(eventNamed(name))
const PAY = selector('Pay')
const CASH_OUT = selector('CashOutTokens')
const PROCESS_FEE = selector('ProcessFee')
const ADD_TO_BALANCE = selector('AddToBalance')

/** The change a step makes, or null for an event that changes neither streaks nor shares. */
function stepOf(event: StickyEvent): Omit<SupplyPoint, 'timestamp'> | null {
  switch (event.kind) {
    case 'streakStart':
      return { streaks: 1, staked: 0n }
    case 'streakEnd':
      return { streaks: -1, staked: 0n }
    case 'stick':
    case 'unstick': {
      if (event.count === undefined) {
        const what = event.kind === 'stick' ? 'A stick' : 'An unstick'
        throw new TypeError(`${what} in ${event.txHash} lacks its share count.`)
      }
      return { streaks: 0, staked: event.kind === 'stick' ? event.count : -event.count }
    }
    default:
      return null
  }
}

/**
 * The chart's steps from a project's hook events: nothing staked when the first event happened, then the active
 * streaks and the shares staked after each event, in the order of their time, and a last step at `now`, or at the last
 * event when the clock is behind it. Granters, trusted senders and exclusions change neither. With no stick or streak
 * there are no steps, and the chart says there are no sticks yet.
 */
export function supplyPoints(events: readonly StickyEvent[], now: number): SupplyPoint[] {
  const steps = events
    .flatMap(event => {
      const step = stepOf(event)
      return step ? [{ timestamp: event.timestamp, ...step }] : []
    })
    .sort((a, b) => a.timestamp - b.timestamp)
  if (!steps.length) return []
  let streaks = 0
  let staked = 0n
  const points: SupplyPoint[] = [{ timestamp: steps[0].timestamp, streaks, staked }]
  for (const step of steps) {
    streaks += step.streaks
    staked += step.staked
    points.push({ timestamp: step.timestamp, streaks, staked })
  }
  points.push({ timestamp: Math.max(now, points[points.length - 1].timestamp), streaks, staked })
  return points
}

/** The hook's exclusions of orphaned backing among a project's events. */
export function orphanExclusions(events: readonly StickyEvent[]): OrphanExclusion[] {
  return events
    .filter(event => event.kind === 'excludeOrphan')
    .map(({ timestamp, amount, txHash }) => {
      if (amount === undefined) throw new TypeError(`An exclusion in ${txHash} lacks its amount.`)
      return { timestamp, amount }
    })
}

/**
 * The chart's series. With the terminal's `flows`, each step is valued at what was stuck then, in the staked token:
 * today's balance less every flow after the step, less the backing excluded as orphaned then (the hook's saved
 * exclusion until an exclusion after the step says otherwise). It is 0 while no shares are staked, when all of it is
 * orphaned, and never below 0. Without flows (null), each step is valued at its shares, and `supplyFallback` says so.
 */
export function backingSeries(
  flows: readonly Flow[] | null,
  { supply, info, orphans = [] }: BackingInputs,
): BackingSeries {
  if (flows === null) {
    return {
      points: supply.map(point => ({ ...point, value: point.staked })),
      unit: { decimals: SHARE_DECIMALS, symbol: info.stSymbol },
      supplyFallback: true,
    }
  }
  const newestFlows = [...flows].sort((a, b) => b.timestamp - a.timestamp)
  const newestOrphans = [...orphans].sort((a, b) => b.timestamp - a.timestamp)
  const points: SeriesPoint[] = new Array(supply.length)
  let raw = info.rawBacking
  let flow = 0
  let orphan = 0
  for (let k = supply.length - 1; k >= 0; k--) {
    const point = supply[k]
    while (flow < newestFlows.length && newestFlows[flow].timestamp > point.timestamp) raw -= newestFlows[flow++].delta
    while (orphan < newestOrphans.length && newestOrphans[orphan].timestamp > point.timestamp) orphan++
    const excluded = orphan === 0 ? info.savedOrphaned : (newestOrphans[orphan]?.amount ?? 0n)
    const stuck = raw - excluded
    points[k] = { ...point, value: point.staked > 0n && stuck > 0n ? stuck : 0n }
  }
  return { points, unit: { decimals: info.decimals, symbol: info.symbol }, supplyFallback: false }
}

/** A flow with where it happened, so flows in one block keep the chain's order. */
type Placed = Flow & { logIndex: number }

/** What a terminal log did to the project's balance, or null for one that did nothing to it or is another project's.
 * A pay adds its amount, an addition its amount and the held fees it returned, a cash out takes away what the holder
 * got, and a fee processed with it takes away the fee (CashOutTokens reports the amount after the fee). A held fee
 * left the balance when it was held, so processing it later moves nothing. A fee that fails to process is credited
 * back and emits no ProcessFee, so it nets out. */
function flowOf(chainId: number, projectId: bigint, log: ScannedLog): Placed | null {
  const { eventName, args } = decodeEventLog({ abi: terminalEventsAbi, topics: log.topics, data: log.data })
  if (args.projectId !== projectId) return null
  if (log.blockTimestamp === undefined) {
    throw new Error(`A terminal log on chain ${chainId} came without its block's time.`)
  }
  const delta =
    eventName === 'Pay'
      ? args.amount
      : eventName === 'CashOutTokens'
        ? -args.reclaimAmount
        : eventName === 'AddToBalance'
          ? args.amount + args.returnedFees
          : args.wasHeld
            ? 0n
            : -args.amount
  return delta === 0n ? null : { timestamp: Number(log.blockTimestamp), logIndex: log.logIndex, delta }
}

/** What one of Bendystraw's pays or cash outs did to the balance: the amount the terminal took in, or paid out. */
function flowOfMove(move: IndexedMove): Placed | null {
  const delta = move.kind === 'stick' ? move.amount : -move.amount
  return delta === 0n ? null : { timestamp: move.timestamp, logIndex: move.logIndex, delta }
}

/** Where one of Bendystraw's rows happened. */
type IndexedPlace = { chainId: number; projectId: bigint; txHash: Hex; logIndex: number }

/** The flows of Bendystraw's `rows` of the project, and of those of the terminal's `tail` logs (from a scan that reads
 * again the blocks just below the one Bendystraw is indexed through) that Bendystraw does not have. An event both have
 * counts once. */
function withTail<Row extends IndexedPlace>(
  chainId: number,
  projectId: bigint,
  rows: readonly Row[],
  flowOfRow: (row: Row) => Placed | null,
  tail: readonly ScannedLog[],
): Placed[] {
  const ours = rows.filter(row => row.chainId === chainId && row.projectId === projectId)
  const known = new Set(ours.map(row => eventKey(chainId, row.txHash, row.logIndex)))
  const newer = tail.filter(log => !known.has(eventKey(chainId, log.transactionHash, log.logIndex)))
  return [...ours.flatMap(row => flowOfRow(row) ?? []), ...newer.flatMap(log => flowOf(chainId, projectId, log) ?? [])]
}

const live: FlowReadDeps = { indexedMoves: indexedStickyMoves, scan: scanToHead, keptScan: keptScanToHead }

const MOVES_UNAVAILABLE = 'Bendystraw could not list the pays and cash outs; scanning the terminal for them instead.'

/**
 * Every change to a project's balance on its terminal since `fromBlock` (its creation block), in the staked token's
 * units, in the order of their time.
 * - The pays and cash outs are Bendystraw's, with a scan of the terminal's from just below the block it is indexed
 *   through, or from `fromBlock` when that is later, to the head. When Bendystraw cannot answer, or has no status for
 *   the chain, the terminal's are scanned from `fromBlock` instead, and kept in this browser as the fees are.
 * - The fees and additions to the balance come from one scan of the terminal from `fromBlock`, which index the project
 *   first, kept in this browser like a project's hook history, without the additions' memos: a return visit, and a
 *   read again after a send, scans only the blocks since.
 * Scans run one after the other. A null `fromBlock` is a creation block that could not be found: a kept history is
 * used whatever block it began at, and otherwise the scans start at the deployer's block. A scan that fails, or a
 * history longer than a scan may read, rejects, and the page charts the share supply instead.
 */
export async function backingFlows(
  chainId: number,
  projectId: bigint,
  fromBlock: bigint | null,
  options: FlowReadOptions = {},
): Promise<Flow[]> {
  const { signal, ...given } = options
  const deps: FlowReadDeps = { ...live, ...given }
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  const address = deployment.terminal
  const project = pad(toHex(projectId))
  const moveTopics = [[PAY, CASH_OUT], null, null, project]

  const read = () => deps.indexedMoves(chainId, [projectId], signal)
  const indexed = await orNull(read, signal, MOVES_UNAVAILABLE, { chainId, projectId })
  const asOf = indexed?.blocks.get(chainId)
  let moves: Placed[]
  if (indexed && asOf !== undefined) {
    const filter = { address, topics: moveTopics, fromBlock: scanFrom(asOf, deployment, fromBlock) }
    moves = withTail(chainId, projectId, indexed.rows, flowOfMove, await deps.scan(chainId, filter, { signal }))
  } else {
    const key = terminalHistoryKey(chainId, address, projectId, 'moves')
    const logs = await deps.keptScan(chainId, key, { address, topics: moveTopics, fromBlock }, { signal, keep: withoutMemo })
    moves = logs.flatMap(log => flowOf(chainId, projectId, log) ?? [])
  }
  if (signal?.aborted) throw signal.reason

  const key = terminalHistoryKey(chainId, address, projectId, 'fees')
  const filter = { address, topics: [[PROCESS_FEE, ADD_TO_BALANCE], project], fromBlock }
  const others = (await deps.keptScan(chainId, key, filter, { signal, keep: withoutMemo })).flatMap(
    log => flowOf(chainId, projectId, log) ?? [],
  )
  // In the order of their time, and in one block in the order of their logs.
  return [...moves, ...others]
    .sort((a, b) => a.timestamp - b.timestamp || a.logIndex - b.logIndex)
    .map(({ timestamp, delta }) => ({ timestamp, delta }))
}
