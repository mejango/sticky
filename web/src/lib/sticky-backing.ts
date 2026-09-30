/**
 * The Overview chart's history: Total stuck, in the staked token, beside the number of active streaks, from the
 * project's first stick to now. The terminal's balance at each point is rebuilt backward from today's, which the page
 * reads from the chain: every pay, cash out, fee and addition to the balance after the point is undone, and the backing
 * the hook excluded as orphaned then is left out. The latest point is the header's Stuck exactly, and a flow the logs
 * miss only shifts older points. When the terminal's history cannot be read, or is longer than a scan may read, the
 * chart shows the Sticky share supply instead, and says so.
 *
 * Bendystraw has no fee a project paid, so the terminal's logs are the one source of the history.
 */

import { decodeEventLog, getAbiItem, pad, toEventSelector, toHex, type AbiEvent } from 'viem'
import type { ScannedLog } from '@/lib/hook-logs'
import { terminalEventsAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { scanToHead, type StickyEvent, type StickyReadDeps } from '@/lib/sticky-events'
import type { StickyProjectInfo } from '@/lib/sticky-project'

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

/** A caller's signal, and in tests the scan to use instead of Center. */
export type FlowReadOptions = { signal?: AbortSignal; scan?: StickyReadDeps['scan'] }

/** Sticky shares always have 18 decimals. */
const SHARE_DECIMALS = 18

const selector = (name: 'Pay' | 'CashOutTokens' | 'ProcessFee' | 'AddToBalance') =>
  toEventSelector(getAbiItem({ abi: terminalEventsAbi, name }) as AbiEvent)
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

/** What a terminal log did to the project's balance, or null for one that did nothing to it or is another project's.
 * A pay adds its amount, an addition its amount and the held fees it returned, a cash out takes away what the holder
 * got, and a fee processed with it takes away the fee (CashOutTokens reports the amount after the fee). A held fee
 * left the balance when it was held, so processing it later moves nothing. A fee that fails to process is credited
 * back and emits no ProcessFee, so it nets out. */
function flowOf(chainId: number, projectId: bigint, log: ScannedLog): Flow | null {
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
  return delta === 0n ? null : { timestamp: Number(log.blockTimestamp), delta }
}

/** By block, then log: the chain's order. */
const inChainOrder = (a: ScannedLog, b: ScannedLog) =>
  a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1

/**
 * Every change to a project's balance on its terminal since `fromBlock` (its creation block), in the staked token's
 * units, in the chain's order. Two scans of the terminal through Center, one after the other: its pays and cash outs,
 * which index the project third, and its fees and additions, which index it first. A scan that fails, or a history
 * longer than a scan may read, rejects, and the page charts the share supply instead.
 */
export async function backingFlows(
  chainId: number,
  projectId: bigint,
  fromBlock: bigint,
  { signal, scan = scanToHead }: FlowReadOptions = {},
): Promise<Flow[]> {
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  const address = deployment.terminal
  const project = pad(toHex(projectId))
  const moves = await scan(chainId, { address, topics: [[PAY, CASH_OUT], null, null, project], fromBlock }, { signal })
  if (signal?.aborted) throw signal.reason
  const others = await scan(
    chainId,
    { address, topics: [[PROCESS_FEE, ADD_TO_BALANCE], project], fromBlock },
    { signal },
  )
  return [...moves, ...others].sort(inChainOrder).flatMap(log => flowOf(chainId, projectId, log) ?? [])
}
