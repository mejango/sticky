/**
 * Sticky's feed rows, what the Latest and Airdrops lists show. A row is what happened to one holder in one
 * transaction: a stick, an unstick, or a streak. A streak that starts or ends in the transaction of that holder's
 * stick or unstick reads on that row ("stuck by X and got sticky") instead of one of its own, the way
 * juicebox.money folds one transaction's events into one row.
 *
 * A stick's or unstick's amount is what the terminal took in or paid out in the staked token: the terminal's Pay or
 * CashOutTokens in the same transaction, for the same project, holder and share count. Bendystraw's pays and cash
 * outs give it for the events Bendystraw indexed, and a scan of the terminal's logs for the events the chain gave
 * us. A transfer between holders, which the terminal never sees, and an amount that cannot be read keep the Sticky
 * shares that moved, so a failed read never breaks a feed. Amounts stay values with their decimals and symbol: the
 * page formats them.
 *
 * A page reads a project's events with `stickyEvents`, trims them to the newest `FEED_WINDOW`, gives those to
 * `terminalMoves` for their amounts, and gives both to `feedRows`. For the Airdrops list it slices the gifts
 * `airdropEvents` picks out, and gives those to `terminalMoves` and `airdropRows`.
 *
 * Bendystraw's pays and cash outs alone make a feed too, as they did before it had the hook's events: `moveEvents`
 * makes an event of each, `moveAmounts` reads their amounts, and `feedRows(moveEvents(moves).slice(-FEED_WINDOW),
 * moveAmounts(moves), options)` is the Latest list. A row built from a pay knows nothing of streaks or transfers.
 */

import { decodeEventLog, getAbiItem, pad, toEventSelector, toHex, type AbiEvent, type Address, type Hex } from 'viem'
import { groupSameTx } from '@/lib/activity-groups'
import { keptLogsOf, type ScannedLog } from '@/lib/hook-logs'
import { terminalEventsAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { orNull, type StickyEvent, type StickyEventKind } from '@/lib/sticky-events'
import { indexedStickyMoves, type IndexedMove } from '@/lib/sticky-indexed'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { terminalHistoryKey, withoutMemo } from '@/lib/terminal-history'

/** A quantity of one token, for the page to format. */
export type FeedAmount = { value: bigint; decimals: number; symbol: string }

/**
 * What a row says happened, always to `holder`.
 * - `stuck`: they stuck tokens of their own. `autoStuck`: the auto-stick adapter stuck their rewards. `gift`:
 *   `payer` stuck tokens for them, or, in a transfer, sent them Sticky shares. A streak that started in the
 *   transaction of the stick reads on its row as `streak: 'started'`.
 * - `unstuck`: they cashed shares out for the underlying token. `removed`: shares left their position and paid
 *   nothing out, as in a transfer to someone else or a burn. A streak that ended in the transaction of the unstick,
 *   after `endedAfter` seconds, reads on its row as `streak: { endedAfter }`.
 * - `gotSticky` and `cameUnstuck`: a streak, when no stick or unstick of its kind shares its transaction. It lasted
 *   `length` seconds.
 */
export type FeedLine =
  | { kind: 'stuck'; holder: Address; streak?: 'started' }
  | { kind: 'autoStuck'; holder: Address; streak?: 'started' }
  | { kind: 'gift'; holder: Address; payer: Address; streak?: 'started' }
  | { kind: 'unstuck'; holder: Address; streak?: { endedAfter: bigint } }
  | { kind: 'removed'; holder: Address; streak?: { endedAfter: bigint } }
  | { kind: 'gotSticky'; holder: Address }
  | { kind: 'cameUnstuck'; holder: Address; length: bigint }

export type FeedRow = {
  chainId: number
  projectId: bigint
  /** In Unix seconds. */
  timestamp: number
  txHash: Hex
  /** The log index of the row's event: the stick's or unstick's when a streak reads on its row, and the streak's own
   * when it stands alone. With `chainId` and `txHash` it keys the row: two sticks by one holder in one transaction
   * differ in nothing else. */
  logIndex: number
  /** Whether tokens came in or went out. Null for a streak on its own. */
  direction: 'in' | 'out' | null
  /** What a stick took in or an unstick paid out, in the staked token, or the Sticky shares that moved when the
   * terminal cannot say. Null for a streak on its own. */
  amount: FeedAmount | null
  line: FeedLine
}

/** What a project's amounts are in. */
export type FeedTokens = Pick<StickyProjectInfo, 'symbol' | 'decimals' | 'stSymbol'>

export type FeedOptions = {
  /** The auto-stick adapter of the chain the events are of, or null where it has none. What it sticks is a holder's
   * own rewards compounding: it reads "auto-stuck" and is no airdrop. */
  adapter: Address | null
  /** A project's tokens, or undefined for a project whose tokens are not known, such as one that another deployer
   * launched on the same hook: its events make no rows. */
  tokens: (chainId: number, projectId: bigint) => FeedTokens | undefined
}

/**
 * How many events the Latest list shows, and how many airdrops the Airdrops list does: the old client's
 * `slice(-40)`. A caller trims its events to the newest `FEED_WINDOW` before `terminalMoves`, whose reads reach back
 * to the oldest event it is given, and before `feedRows`. For the Airdrops list it slices after `airdropEvents`, so
 * the window holds airdrops, not events of which some are.
 */
export const FEED_WINDOW = 40

/** Sticky shares always have 18 decimals. */
const SHARE_DECIMALS = 18

/** The events a feed reads. The others are a project's settings. */
const FEED_KINDS: ReadonlySet<StickyEventKind> = new Set(['stick', 'unstick', 'streakStart', 'streakEnd'])

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const lower = <T extends string>(value: T) => value.toLowerCase() as T

/** What ties a stick or unstick to the terminal event of its transaction. */
type MoveId = {
  chainId: number
  txHash: string
  kind: 'stick' | 'unstick'
  projectId: bigint
  holder: string
  count: bigint
}

/** The chain, transaction, project, holder and share count of a stick or unstick, which the terminal's Pay or
 * CashOutTokens of the same transaction shares. A transaction and a holder are the same in any case. */
export function moveKey({ chainId, txHash, kind, projectId, holder, count }: MoveId): string {
  return `${chainId}:${txHash}:${kind}:${projectId}:${holder}:${count}`.toLowerCase()
}

/** A stick or an unstick, with what a row needs of it. StickyEvent leaves those fields optional for its other kinds. */
type Move =
  | (StickyEvent & { kind: 'stick'; count: bigint; payer: Address })
  | (StickyEvent & { kind: 'unstick'; count: bigint })

/** Whether the event is a stick or unstick. One that lacks its share count or payer throws, since the row it would
 * make cannot be told from a row that was never there. */
function isMove(event: StickyEvent): event is Move {
  if (event.kind !== 'stick' && event.kind !== 'unstick') return false
  if (event.count === undefined || (event.kind === 'stick' && event.payer === undefined)) {
    const what = event.kind === 'stick' ? 'A stick' : 'An unstick'
    const lacks = event.count === undefined ? 'share count' : 'payer'
    throw new TypeError(`${what} in ${event.txHash} lacks its ${lacks}.`)
  }
  return true
}

/** How long the streak a streakEnd event ended lasted. */
function lengthOf(event: StickyEvent): bigint {
  if (event.length === undefined) throw new TypeError(`A streak end in ${event.txHash} lacks its length.`)
  return event.length
}

/**
 * The stick or unstick each of Bendystraw's pays and cash outs records, as the event it stands for, for the feed the
 * pays and cash outs make alone: a stick has its payer, which is the pay's caller, and the shares it issued as its
 * count, and neither has a block or a balance. The events come out in the order the moves are given: oldest first, as
 * `indexedStickyMoves` gives its rows.
 */
export function moveEvents(moves: readonly IndexedMove[]): StickyEvent[] {
  return moves.map(move => {
    const at = {
      chainId: move.chainId,
      projectId: move.projectId,
      holder: move.holder,
      txHash: lower(move.txHash),
      logIndex: move.logIndex,
      blockNumber: null,
      timestamp: move.timestamp,
      count: move.tokens,
    }
    return move.kind === 'stick' ? { ...at, kind: 'stick', payer: move.payer } : { ...at, kind: 'unstick' }
  })
}

/** What each of Bendystraw's pays and cash outs took in or paid out, in the staked token, by `moveKey`: the amounts of
 * the events `moveEvents` makes of them. */
export function moveAmounts(moves: readonly IndexedMove[]): Map<string, bigint> {
  return new Map(moves.map(move => [moveKey({ ...move, count: move.tokens }), move.amount]))
}

/** One row per transaction, project and holder, like jbm's same-transaction groups. */
const sameTxKey = ({ chainId, txHash, projectId, holder }: StickyEvent) =>
  `${chainId}:${txHash}:${projectId}:${holder}`.toLowerCase()

const selector = (name: 'Pay' | 'CashOutTokens') =>
  toEventSelector(getAbiItem({ abi: terminalEventsAbi, name }) as AbiEvent)
const PAY = selector('Pay')
const CASH_OUT = selector('CashOutTokens')

/** The pays and cash outs `terminalLogs` reads: some of a chain's projects on its terminal, from a block on. */
type TerminalQuery = { terminal: Address; projectIds: readonly bigint[]; fromBlock: bigint }

/** The reads terminalMoves makes, so a test can stand in for Bendystraw and Center. */
export type MoveReaders = {
  /** Bendystraw's pays and cash outs of some of a chain's projects. */
  indexedMoves: typeof indexedStickyMoves
  /** The terminal's Pay and CashOutTokens logs of `projectIds`, from `fromBlock` through the head. */
  terminalLogs: (chainId: number, query: TerminalQuery, opts: { signal?: AbortSignal }) => Promise<ScannedLog[]>
}

/** A caller's signal, which every read gets, and in tests the reads to use instead of the real ones. */
export type MoveOptions = { signal?: AbortSignal } & Partial<MoveReaders>

const live: MoveReaders = {
  indexedMoves: indexedStickyMoves,
  /** One scan of the terminal for every project asked for, with what is buried of each project's pays and cash outs
   * kept in this browser under a key of its own, as its hook history is (`keptLogsOf`), without their memos: the next
   * read, a refresh after a send or a return visit, scans only the blocks since. */
  terminalLogs(chainId, { terminal, projectIds, fromBlock }, { signal }) {
    const words = projectIds.map(projectId => pad(toHex(projectId), { size: 32 }))
    const histories = projectIds.map((projectId, at) => ({
      key: terminalHistoryKey(chainId, terminal, projectId, 'feed'),
      owns: (log: ScannedLog) => log.topics[3]?.toLowerCase() === words[at],
    }))
    const filter = { address: terminal, topics: [[PAY, CASH_OUT], null, null, words], fromBlock }
    return keptLogsOf(chainId, histories, filter, { signal, keep: withoutMemo })
  },
}

const AMOUNTS_UNAVAILABLE = 'Could not read stick and unstick amounts; showing Sticky token counts.'

/** The stick or unstick a terminal log records, as its key and the amount that moved, or null for a log that does
 * not decode as a Pay or a CashOutTokens. */
function movedBy(chainId: number, log: ScannedLog): [key: string, amount: bigint] | null {
  try {
    const { eventName, args } = decodeEventLog({ abi: terminalEventsAbi, topics: log.topics, data: log.data })
    const at = { chainId, txHash: log.transactionHash, projectId: args.projectId }
    if (eventName === 'Pay') {
      return [moveKey({ ...at, kind: 'stick', holder: args.beneficiary, count: args.newlyIssuedTokenCount }), args.amount]
    }
    if (eventName === 'CashOutTokens') {
      return [moveKey({ ...at, kind: 'unstick', holder: args.holder, count: args.cashOutCount }), args.reclaimAmount]
    }
    return null
  } catch {
    return null
  }
}

const projectsOf = (moves: readonly { projectId: bigint }[]) => [...new Set(moves.map(({ projectId }) => projectId))]

/** The moves by chain, in the order the chains first appear. */
function byChain(moves: Move[]): Map<number, Move[]> {
  const chains = new Map<number, Move[]>()
  for (const move of moves) {
    const chain = chains.get(move.chainId)
    if (chain) chain.push(move)
    else chains.set(move.chainId, [move])
  }
  return chains
}

/**
 * What the terminal took in for each stick in `events` and paid out for each unstick, in the staked token, by
 * `moveKey`. A stick or unstick Bendystraw indexed has no block number, and its amount is Bendystraw's pay or cash
 * out, read for its projects in one request per chain, from the time of the oldest such event. One the chain gave us
 * is found in the terminal's logs, in one scan per chain from the oldest such event's block, which goes on from what
 * this browser kept of each project's earlier scans. A transfer between holders has no terminal event, so it has no
 * entry. A read that fails leaves its events without one, which the console hears about, and their rows show the
 * Sticky shares instead. Chains are read one after another, and a caller's cancel rejects with its reason.
 *
 * Pass the events a feed shows, the newest `FEED_WINDOW` of a project's history: both reads reach back to the oldest.
 */
export async function terminalMoves(
  events: readonly StickyEvent[],
  options: MoveOptions = {},
): Promise<Map<string, bigint>> {
  const { signal, ...given } = options
  const readers: MoveReaders = { ...live, ...given }
  const amounts = new Map<string, bigint>()
  for (const [chainId, moves] of byChain(events.filter(isMove))) {
    if (signal?.aborted) throw signal.reason
    const deployment = stickyDeployment(chainId)
    if (!deployment) continue
    const about = { chainId }

    const indexed = moves.filter(({ blockNumber }) => blockNumber === null)
    if (indexed.length) {
      const since = indexed.reduce((oldest, { timestamp }) => Math.min(oldest, timestamp), Infinity)
      const read = () => readers.indexedMoves(chainId, projectsOf(indexed), signal, since)
      const answer = await orNull(read, signal, AMOUNTS_UNAVAILABLE, about)
      for (const [key, amount] of moveAmounts(answer?.rows ?? [])) amounts.set(key, amount)
    }

    const found = moves.filter((move): move is Move & { blockNumber: bigint } => move.blockNumber !== null)
    if (found.length) {
      const fromBlock = found.map(({ blockNumber }) => blockNumber).reduce((low, block) => (block < low ? block : low))
      const query = { terminal: deployment.terminal, projectIds: projectsOf(found), fromBlock }
      const read = () => readers.terminalLogs(chainId, query, { signal })
      for (const log of (await orNull(read, signal, AMOUNTS_UNAVAILABLE, about)) ?? []) {
        const moved = movedBy(chainId, log)
        if (moved) amounts.set(...moved)
      }
    }
  }
  return amounts
}

/**
 * Which stick or unstick each streak of a transaction goes with, as a map from the move to its streak. A start goes
 * with a stick and an end with an unstick. The hook emits a streak just before the move that causes it, so it goes
 * with the first move of its kind after it, or, where a source lists the two the other way round, the last one
 * before it. A streak with none of its kind is not paired and keeps a row of its own.
 */
function pairStreaks(chronological: StickyEvent[]): Map<StickyEvent, StickyEvent> {
  const paired = new Map<StickyEvent, StickyEvent>()
  chronological.forEach((event, at) => {
    const goesWith = event.kind === 'streakStart' ? 'stick' : event.kind === 'streakEnd' ? 'unstick' : null
    if (goesWith === null) return
    const ofItsKind = (other: StickyEvent) => other.kind === goesWith
    const move = chronological.slice(at + 1).find(ofItsKind) ?? chronological.slice(0, at).findLast(ofItsKind)
    if (move) paired.set(move, event)
  })
  return paired
}

type Content = Pick<FeedRow, 'direction' | 'amount' | 'line'>
type Context = { moves: ReadonlyMap<string, bigint>; adapter: Address | null; tokens: FeedTokens }

function moveContent(move: Move, streak: StickyEvent | undefined, { moves, adapter, tokens }: Context): Content {
  const paid = moves.get(moveKey(move))
  const amount: FeedAmount =
    paid === undefined
      ? { value: move.count, decimals: SHARE_DECIMALS, symbol: tokens.stSymbol }
      : { value: paid, decimals: tokens.decimals, symbol: tokens.symbol }
  const { holder } = move
  if (move.kind === 'unstick') {
    // A streak folds into an unstick only as one it ended, and into a stick only as one it started.
    const ended = streak ? { streak: { endedAfter: lengthOf(streak) } } : {}
    // Burns and outgoing transfers reduce a position too: only a cash out in the same transaction pays out.
    return { direction: 'out', amount, line: { kind: paid === undefined ? 'removed' : 'unstuck', holder, ...ended } }
  }
  const { payer } = move
  const started = streak ? { streak: 'started' as const } : {}
  const line: FeedLine =
    adapter !== null && same(payer, adapter)
      ? { kind: 'autoStuck', holder, ...started }
      : same(payer, holder)
        ? { kind: 'stuck', holder, ...started }
        : { kind: 'gift', holder, payer, ...started }
  return { direction: 'in', amount, line }
}

function streakContent(event: StickyEvent): Content {
  const { holder } = event
  const line: FeedLine =
    event.kind === 'streakStart'
      ? { kind: 'gotSticky', holder }
      : { kind: 'cameUnstuck', holder, length: lengthOf(event) }
  return { direction: null, amount: null, line }
}

/** The rows of one transaction's events for one holder and project, newest first. */
function rowsOf(group: StickyEvent[], context: Context): FeedRow[] {
  const streaks = pairStreaks([...group].reverse())
  const folded = new Set(streaks.values())
  return group.flatMap(event => {
    if (folded.has(event)) return []
    const at = {
      chainId: event.chainId,
      projectId: event.projectId,
      timestamp: event.timestamp,
      txHash: event.txHash,
      logIndex: event.logIndex,
    }
    return [{ ...at, ...(isMove(event) ? moveContent(event, streaks.get(event), context) : streakContent(event)) }]
  })
}

/**
 * The rows for a chain's `events`, oldest first as `stickyEvents` gives them, newest first as a feed shows them.
 * `moves` are their amounts from `terminalMoves`. Events of one transaction, project and holder are a group, which
 * sits where its newest event sat: a stick or unstick with the streak it started or ended is one row. What
 * a project's events are in comes from `tokens`, and a project it has none for has no rows. Settings events make none.
 */
export function feedRows(
  events: readonly StickyEvent[],
  moves: ReadonlyMap<string, bigint>,
  { adapter, tokens }: FeedOptions,
): FeedRow[] {
  const newestFirst = events.filter(({ kind }) => FEED_KINDS.has(kind)).reverse()
  return groupSameTx(newestFirst, sameTxKey).flatMap(group => {
    const [first] = group
    const inTokens = tokens(first.chainId, first.projectId)
    return inTokens ? rowsOf(group, { moves, adapter, tokens: inTokens }) : []
  })
}

/**
 * The sticks someone else paid for, in the order given: the events of the Airdrops list. What the auto-stick adapter
 * sticks is a holder's own rewards compounding, and is left out. A transfer's receiving stake is paid by its sender
 * and counts, with its Sticky shares. Slice the newest `FEED_WINDOW` of them, and give those to `terminalMoves`.
 */
export function airdropEvents(
  events: readonly StickyEvent[],
  { adapter }: Pick<FeedOptions, 'adapter'>,
): StickyEvent[] {
  return events.filter(
    event =>
      isMove(event) &&
      event.kind === 'stick' &&
      !same(event.payer, event.holder) &&
      !(adapter !== null && same(event.payer, adapter)),
  )
}

/** The rows of the Airdrops list, newest first. A streak a gift started is not folded in, but reads on the Latest
 * row. */
export function airdropRows(
  events: readonly StickyEvent[],
  moves: ReadonlyMap<string, bigint>,
  options: FeedOptions,
): FeedRow[] {
  return feedRows(airdropEvents(events, options), moves, options)
}
