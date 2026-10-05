/**
 * A project's holders: what each has staked and how long they have stayed, for the Tokens tab's leaderboard and pie
 * and the header's Sticks, Average active stick and Longest active stick; and one holder's own stick. Bendystraw's
 * positions answer first, as of the block it is indexed through, and a scan of the hook's position events from just
 * below that block brings them to the head. When Bendystraw cannot answer, the rows are rebuilt from the project's
 * events. Either way the rows are for finding holders and ordering them: the balances a page shows are read again from
 * the hook (`verifyHolderPage`).
 *
 * Every Staked and Unstaked carries the holder's balance after it, StreakStarted marks when a streak began and
 * StreakEnded how long it lasted. So events are applied, never added up: an event applied again changes nothing, and a
 * scan that reads again what Bendystraw's positions already count leaves them as they are.
 *
 * Addresses are lowercase.
 */

import { erc20Abi, pad, toHex, type Address } from 'viem'
import { inChainOrder, untilAborted } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { stickyHookAbi } from '@/lib/sticky-abis'
import { deploymentOn } from '@/lib/sticky-addresses'
import {
  decodeHookLog,
  orNull,
  POSITION_TOPICS,
  scanFrom,
  scanToHead,
  stickyEvents,
  tailOrNull,
  type StickyEvent,
  type StickyEventKind,
  type StickyEventsResult,
  type StickyReadDeps,
} from '@/lib/sticky-events'
import { indexedStickyPositions, type IndexedPosition } from '@/lib/sticky-indexed'
import type { StickyProjectInfo } from '@/lib/sticky-project'

/** One holder of a project, at `now`. The streaks follow StickyHook's `currentStreakOf` and `longestStreakOf`. */
export type HolderRow = {
  holder: Address
  /** The Sticky shares they have staked, with 18 decimals. */
  staked: bigint
  /** When their active streak started, in Unix seconds, or 0 when they have none, as `streakStartOf` says. */
  start: number
  /** How long their active streak has lasted, in seconds, or 0 when they have none. */
  current: number
  /** Their longest streak, the active one included, in seconds. */
  longest: number
}

export type StickyHoldersResult = {
  /** The holders with shares staked, most shares first. */
  rows: HolderRow[]
  /** Where the rows came from: Bendystraw's positions, or the project's events (as `stickyEvents` describes them). */
  source: 'indexed' | 'scanned'
  degraded: null | 'not-indexed' | 'indexer-error'
}

type Cancel = { signal?: AbortSignal }

/** Every read `stickyHolders` makes, so a test can stand in for Bendystraw and Center. */
export type HolderReadDeps = {
  indexedPositions: typeof indexedStickyPositions
  /** Logs through the head, each with its block's time. */
  scan: StickyReadDeps['scan']
  /** A project's events, read when Bendystraw's positions cannot answer. A page that has them already can hand them
   * over, so its one read of a project's history serves both its feed and its holders. */
  events: (chainId: number, projectId: bigint, opts: Cancel) => Promise<StickyEventsResult>
}

/** A caller's signal and clock, and the reads to use instead of the default ones: a page can pass the events it has
 * read, and a test all three. */
export type HolderReadOptions = Cancel & {
  /** The time streaks are measured at, in Unix seconds: the page's pinned block's, so every age on it agrees. The
   * clock's by default. */
  now?: number
} & Partial<HolderReadDeps>

/** A holder's position as StickyHook keeps it, without the time: what `stakedBalanceOf`, `streakStartOf` and the
 * longest completed streak say. */
type Position = { holder: Address; staked: bigint; start: number; longestCompleted: number }

const POSITION_KINDS: ReadonlySet<StickyEventKind> = new Set(['stick', 'unstick', 'streakStart', 'streakEnd'])
const POSITIONS_UNAVAILABLE = 'Bendystraw could not list the holders; building them from the project\'s events.'

const unixNow = () => Math.floor(Date.now() / 1000)
const lower = <T extends string>(value: T) => value.toLowerCase() as T

/** The position after `event`. A stick or unstick sets the balance to the one it carries, a streak's start sets the
 * start, and its end clears it and keeps the longer of the record and its length. Other kinds change nothing. */
function applied(position: Position, event: StickyEvent): Position {
  switch (event.kind) {
    case 'stick':
    case 'unstick': {
      if (event.balance === undefined) {
        const what = event.kind === 'stick' ? 'A stick' : 'An unstick'
        throw new TypeError(`${what} in ${event.txHash} lacks the balance it left.`)
      }
      return { ...position, staked: event.balance }
    }
    case 'streakStart':
      return { ...position, start: event.timestamp }
    case 'streakEnd': {
      if (event.length === undefined) throw new TypeError(`A streak end in ${event.txHash} lacks its length.`)
      return { ...position, start: 0, longestCompleted: Math.max(position.longestCompleted, Number(event.length)) }
    }
    default:
      return position
  }
}

/** The positions after `events`, in the order given: the last event of a kind is the one that stands. */
function applyAll(positions: Position[], events: readonly StickyEvent[]): Position[] {
  const byHolder = new Map(positions.map(position => [lower(position.holder), position]))
  for (const event of events) {
    if (!POSITION_KINDS.has(event.kind)) continue
    const holder = lower(event.holder)
    byHolder.set(holder, applied(byHolder.get(holder) ?? { holder, staked: 0n, start: 0, longestCompleted: 0 }, event))
  }
  return [...byHolder.values()]
}

function rowAt({ holder, staked, start, longestCompleted }: Position, now: number): HolderRow {
  const current = start ? Math.max(0, now - start) : 0
  return { holder, staked, start, current, longest: Math.max(longestCompleted, current) }
}

/**
 * Each holder's row from one project's hook events, oldest first as `stickyEvents` gives them, at `now`: the balance
 * the holder's last stick or unstick left, the streak their last StreakStarted began unless a StreakEnded came after
 * it, and the longest of the streaks that ended and the active one. A holder who has left keeps a row with no shares.
 * Settings events make no rows. No per-holder reads: the list costs one read of the history however many hold.
 */
export function holderRows(events: readonly StickyEvent[], now: number = unixNow()): HolderRow[] {
  return applyAll([], events).map(position => rowAt(position, now))
}

/**
 * Each holder's row from Bendystraw's positions, brought up to date by `tail`, the hook's events from a scan that
 * starts just below the block the positions are as of, in the chain's order. The scan reads again some events the
 * positions already count, and applying those again changes nothing.
 */
export function positionRows(
  positions: readonly IndexedPosition[],
  tail: readonly StickyEvent[],
  now: number = unixNow(),
): HolderRow[] {
  const known = positions.map(position => ({
    holder: lower(position.holder),
    staked: position.stakedBalance,
    start: position.streakStartedAt ?? 0,
    longestCompleted: position.longestCompletedStreak,
  }))
  return applyAll(known, tail).map(position => rowAt(position, now))
}

/** The rows with shares staked, most shares first, then by address. */
function active(rows: HolderRow[]): HolderRow[] {
  return rows
    .filter(row => row.staked > 0n)
    .sort((a, b) => (a.staked === b.staked ? (a.holder < b.holder ? -1 : 1) : a.staked > b.staked ? -1 : 1))
}

const live: HolderReadDeps = {
  indexedPositions: indexedStickyPositions,
  scan: scanToHead,
  events: (chainId, projectId, { signal }) => stickyEvents(chainId, projectId, { signal }),
}

/**
 * The holders of a project with shares staked, most shares first, and where the list came from. Bendystraw's positions
 * answer, as of the block its answer says it is indexed through, and one scan of the hook's position events from just
 * below that block to the head corrects them. When the positions read fails, has no status for the chain, or is so far
 * behind the head that the blocks since are more than a scan may read (`tailOrNull`), the rows are built from the
 * project's events instead, and `source` and `degraded` are those of the events. A read that can get neither rejects:
 * a list of holders is never quietly shorter.
 */
export async function stickyHolders(
  chainId: number,
  projectId: bigint,
  options: HolderReadOptions = {},
): Promise<StickyHoldersResult> {
  const { signal, now = unixNow(), ...given } = options
  const deps: HolderReadDeps = { ...live, ...given }
  const deployment = deploymentOn(chainId)
  const ours = (event: StickyEvent) => event.chainId === chainId && event.projectId === projectId

  const about = { chainId, projectId }
  const read = () => deps.indexedPositions({ chainId, projectId }, signal)
  const positions = await orNull(read, signal, POSITIONS_UNAVAILABLE, about)
  const asOf = positions?.blocks.get(chainId)
  if (positions && asOf !== undefined) {
    const topics = [POSITION_TOPICS, pad(toHex(projectId))]
    const filter = { address: deployment.hook, topics, fromBlock: scanFrom(asOf, deployment) }
    const logs = await tailOrNull(() => deps.scan(chainId, filter, { signal }), POSITIONS_UNAVAILABLE, about)
    if (logs !== null) {
      const tail = logs.flatMap(log => decodeHookLog(log, chainId) ?? []).filter(ours).sort(inChainOrder)
      const indexed = positions.rows.filter(row => row.chainId === chainId && row.projectId === projectId)
      return { rows: active(positionRows(indexed, tail, now)), source: 'indexed', degraded: null }
    }
  }

  const { events, source, degraded } = await deps.events(chainId, projectId, { signal })
  return { rows: active(holderRows(events.filter(ours), now)), source, degraded }
}

/**
 * The page of holders a page shows, with each balance read again from the hook at `block` through Multicall3, in one
 * request: a balance an index or a scan got wrong is not what the page shows. A row whose balance holds is the same row.
 */
export async function verifyHolderPage(
  chainId: number,
  projectId: bigint,
  rows: readonly HolderRow[],
  block: bigint,
  { signal }: Cancel = {},
): Promise<HolderRow[]> {
  if (!rows.length) return []
  const { hook } = deploymentOn(chainId)
  const balances = await untilAborted(
    jbCenterPublicClient(chainId).multicall({
      contracts: rows.map(
        ({ holder }) =>
          ({ address: hook, abi: stickyHookAbi, functionName: 'stakedBalanceOf', args: [projectId, holder] }) as const,
      ),
      allowFailure: false,
      batchSize: 0,
      blockNumber: block,
    }),
    signal,
  )
  return rows.map((row, at) => (balances[at] === row.staked ? row : { ...row, staked: balances[at] }))
}

/** The block a page reads its figures at, and that block's time, in Unix seconds, which every age on the page is
 * measured at: the header's and the holder's own agree. */
export async function pinnedBlock(
  chainId: number,
  { signal }: Cancel = {},
): Promise<{ number: bigint; timestamp: number }> {
  const block = await untilAborted(jbCenterPublicClient(chainId).getBlock(), signal)
  return { number: block.number, timestamp: Number(block.timestamp) }
}

/** The header's Average active stick and Longest active stick at `now`, in seconds: the active streaks of the holders
 * with shares staked, where one without a streak counts as none. Both are 0 when nobody is stuck. */
export function stickAges(rows: readonly HolderRow[], now: number): { average: number; longest: number } {
  const ages = rows.filter(row => row.staked > 0n).map(row => (row.start ? Math.max(0, now - row.start) : 0))
  const total = ages.reduce((sum, age) => sum + age, 0)
  return { average: ages.length ? Math.floor(total / ages.length) : 0, longest: Math.max(0, ...ages) }
}

/** One holder's stick in a project, read at one block. */
export type StickyPosition = {
  /** Their Sticky shares, with 18 decimals. */
  staked: bigint
  /** What they hold of the staked token: what they could stick. */
  wallet: bigint
  /** When their active streak started, in Unix seconds, or 0 when they have none, as `streakStartOf` says. */
  start: number
  /** Their active streak at `timestamp`, and their longest with it, in seconds. */
  current: number
  longest: number
  blockNumber: bigint
  timestamp: number
}

/**
 * A holder's stick, read at one pinned block in one request: their Sticky shares, what they hold of the staked token,
 * and StickyHook's `streakStartOf` and `longestStreakOf`, with the active streak measured at that block's time. The
 * page's stick card and the holder's own figures read it; its tranches are read at the same block.
 */
export async function readStickyPosition(
  chainId: number,
  { projectId, stToken, stakedToken }: Pick<StickyProjectInfo, 'projectId' | 'stToken' | 'stakedToken'>,
  holder: Address,
  { signal }: Cancel = {},
): Promise<StickyPosition> {
  const { hook } = deploymentOn(chainId)
  const pin = await pinnedBlock(chainId, { signal })
  const [staked, start, longest, wallet] = await untilAborted(
    jbCenterPublicClient(chainId).multicall({
      contracts: [
        { address: stToken, abi: erc20Abi, functionName: 'balanceOf', args: [holder] },
        { address: hook, abi: stickyHookAbi, functionName: 'streakStartOf', args: [projectId, holder] },
        { address: hook, abi: stickyHookAbi, functionName: 'longestStreakOf', args: [projectId, holder] },
        { address: stakedToken, abi: erc20Abi, functionName: 'balanceOf', args: [holder] },
      ],
      allowFailure: false,
      blockNumber: pin.number,
    }),
    signal,
  )
  const since = Number(start)
  const current = since ? Math.max(0, pin.timestamp - since) : 0
  return {
    staked,
    wallet,
    start: since,
    current,
    longest: Math.max(Number(longest), current),
    blockNumber: pin.number,
    timestamp: pin.timestamp,
  }
}
