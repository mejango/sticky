/**
 * The home page's reads: every Sticky project of a network, ranked by its Sticky shares, the newest sticks, unsticks
 * and airdrops across its chains, and what they secure in US dollars.
 *
 * `homeIndex` and `homeLatest` are Bendystraw's two answers for the whole network, and `homeChain` one chain's part.
 * A chain's projects come from Bendystraw's list and a scan of the deployer's launches past it, and each project's
 * figures from the chain. Its Sticks, its airdrops and the history of its Sticky shares come from Bendystraw's pays and
 * cash outs, and so does Latest, unless Bendystraw's hook events and a scan past their block have the newest events.
 * When Bendystraw cannot list a chain's projects, or their pays and cash outs, the chain's hook is scanned instead,
 * from its first launch. A chain none of whose projects can be read is an error of its own.
 *
 * Every read that gives up on one source for another tells the console, under a label that stays the same.
 */

import type { BendystrawNetwork } from '@bananapus/nana-sdk-core'
import type { Address } from 'viem'
import { displayChainName } from '@/lib/chainDisplay'
import type { ScannedLog } from '@/lib/hook-logs'
import { deploymentOn, stickyChainIds, type StickyDeployment } from '@/lib/sticky-addresses'
import {
  POSITION_TOPICS,
  PROJECTS_UNAVAILABLE,
  decodeHookLog,
  fromIndexedEvent,
  merged,
  orNull,
  projectCreationBlock,
  scanFrom,
  scanToHead,
  stickyProjectsOn,
  tailOrNull,
  type StickyEvent,
  type StickyProjectsResult,
  type StickyReadDeps,
} from '@/lib/sticky-events'
import {
  FEED_WINDOW,
  airdropEvents,
  airdropRows,
  feedRows,
  moveAmounts,
  moveEvents,
  terminalMoves,
  type FeedOptions,
  type FeedRow,
} from '@/lib/sticky-feed'
import { holderRows } from '@/lib/sticky-holders'
import {
  indexedStickyEvents,
  indexedStickyMoves,
  indexedStickyProjects,
  type IndexedMove,
  type IndexedProjects,
  type IndexedRows,
  type IndexedStickyEvent,
} from '@/lib/sticky-indexed'
import { usdPrices } from '@/lib/sticky-prices'
import { readStickyProjects, type StickyProjectInfo } from '@/lib/sticky-project'
import { launchKey } from '@/lib/sticky-siblings'

/** A Sticky project on the home, as the chain reads it now, and how many holders have shares stuck in it. */
export type HomeCard = { info: StickyProjectInfo; sticks: number }

/** A Stickiest card: one launch's projects, at most one per chain, or a project of its own. Cards rank by
 * `totalStaked`, their Sticky shares. */
export type HomeCardGroup = { cards: HomeCard[]; totalStaked: bigint }

/** A change to a project's Sticky shares, at a time in Unix seconds: what the secured chart's history is made of. */
export type SupplyMove = { projectId: bigint; timestamp: number; delta: bigint }

/** The version of what the browser keeps of a chain's part: `useStickyHome` puts it in the chain's query key. Change it
 * whenever `HomeChain`, `StickyProjectInfo` or `FeedRow` changes shape, or a browser renders a part kept in an older
 * shape until its chain is read again. */
export const HOME_VERSION = 'v1'

/** One chain's part of the home. What the browser keeps of it holds only plain values. */
export type HomeChain = {
  chainId: number
  cards: HomeCard[]
  /** The chain's newest FEED_WINDOW rows of Latest, and of Airdrops, newest first. */
  activity: FeedRow[]
  airdrops: FeedRow[]
  supply: SupplyMove[]
}

type Cancel = { signal?: AbortSignal }

/** Every read `homeChain` makes, so a test can stand in for Bendystraw and Center. */
export type HomeReadDeps = {
  projectsOn: (chainId: number, index: IndexedProjects | null, opts: Cancel) => Promise<StickyProjectsResult>
  /** The figures of the chain's projects that can be read, read together at one block. */
  readProjects: (chainId: number, projectIds: readonly bigint[], opts: Cancel) => Promise<StickyProjectInfo[]>
  indexedMoves: typeof indexedStickyMoves
  /** A contract's logs through the head, each with its block's time. */
  scan: StickyReadDeps['scan']
  terminalMoves: (events: readonly StickyEvent[], opts: Cancel) => Promise<Map<string, bigint>>
  creationBlock: (chainId: number, projectId: bigint, opts: Cancel) => Promise<bigint | null>
}

export type HomeReadOptions = Cancel & {
  /** Bendystraw's project list for the chain's network, or null when it could not answer. */
  index: IndexedProjects | null
  /** Bendystraw's newest hook events for the network, or null when it could not answer. */
  latest: IndexedRows<IndexedStickyEvent> | null
} & Partial<HomeReadDeps>

const LATEST_UNAVAILABLE = 'Bendystraw could not list the newest Sticky events; Latest shows its pays and cash outs.'
const MOVES_UNAVAILABLE = "Bendystraw could not list a chain's sticks and unsticks; scanning the chain instead."
const TAIL_UNAVAILABLE = "Could not read a chain's newest blocks; Latest shows Bendystraw's pays and cash outs."
const PRICES_UNAVAILABLE = 'Could not price the tokens stuck on a chain; the secured chart leaves them out.'

/** The most project IDs one request may list: the relay refuses a longer list (the SDK's `compileBendystrawOperation`). */
const MAX_LISTED_IDS = 1_000

const byTime = (a: IndexedMove, b: IndexedMove) => a.timestamp - b.timestamp || a.logIndex - b.logIndex

/** The Sticky projects of a network as Bendystraw lists them, or null when it cannot answer. */
export function homeIndex(
  network: BendystrawNetwork,
  { signal, indexedProjects = indexedStickyProjects }: Cancel & { indexedProjects?: typeof indexedStickyProjects } = {},
): Promise<IndexedProjects | null> {
  return orNull(() => indexedProjects(network, signal), signal, PROJECTS_UNAVAILABLE, { network })
}

/** Bendystraw's newest FEED_WINDOW hook events of a network's Sticky chains, or null when it cannot answer. */
export function homeLatest(
  network: BendystrawNetwork,
  { signal, indexedEvents = indexedStickyEvents }: Cancel & { indexedEvents?: typeof indexedStickyEvents } = {},
): Promise<IndexedRows<IndexedStickyEvent> | null> {
  const chainIds = stickyChainIds(network === 'testnet' ? 'testnet' : 'production')
  return orNull(() => indexedEvents({ chainIds, newest: FEED_WINDOW }, signal), signal, LATEST_UNAVAILABLE, { network })
}

/** What each of `tokens` on a chain is worth in US dollars, or null when DexScreener cannot answer. */
export function homePrices(
  chainId: number,
  tokens: readonly Address[],
  { signal, usdPrices: read = usdPrices }: Cancel & { usdPrices?: typeof usdPrices } = {},
): Promise<Map<Address, number> | null> {
  return orNull(() => read(chainId, tokens, { signal }), signal, PRICES_UNAVAILABLE, { chainId })
}

const decoded = (chainId: number, logs: readonly ScannedLog[]) =>
  logs.flatMap(log => decodeHookLog(log, chainId) ?? [])

/** The figures of the chain's projects that can be read. `readStickyProjects` leaves out, and tells the console of,
 * one that cannot be; a chain none of whose projects can be read is an error. */
async function readProjects(
  chainId: number,
  ids: readonly bigint[],
  deps: HomeReadDeps,
  signal: AbortSignal | undefined,
): Promise<StickyProjectInfo[]> {
  const infos = await deps.readProjects(chainId, ids, { signal })
  if (signal?.aborted) throw signal.reason
  if (!infos.length) throw new Error(`Could not read any Sticky token on ${displayChainName(chainId)}.`)
  return infos
}

/** Bendystraw's pays and cash outs of the chain's projects, oldest first, asked for MAX_LISTED_IDS projects at a
 * time, one request after another. Null when an answer has no status for the chain. */
async function movesOf(
  chainId: number,
  ids: readonly bigint[],
  deps: HomeReadDeps,
  signal: AbortSignal | undefined,
): Promise<IndexedMove[] | null> {
  const rows: IndexedMove[] = []
  for (let at = 0; at < ids.length; at += MAX_LISTED_IDS) {
    const answer = await deps.indexedMoves(chainId, ids.slice(at, at + MAX_LISTED_IDS), signal)
    if (!answer.blocks.has(chainId)) return null
    rows.push(...answer.rows)
  }
  return rows.sort(byTime)
}

/** The holders a project's pays and cash outs leave with shares. Transfers are not among them, so for a token that can
 * be transferred this is a count to show, not a balance. */
function holdersIn(moves: readonly IndexedMove[], projectId: bigint): number {
  const balances = new Map<string, bigint>()
  for (const move of moves) {
    if (move.projectId !== projectId) continue
    const holder = move.holder.toLowerCase()
    balances.set(holder, (balances.get(holder) ?? 0n) + (move.kind === 'stick' ? move.tokens : -move.tokens))
  }
  return [...balances.values()].filter(balance => balance > 0n).length
}

/** The chain's events Bendystraw has among the network's newest, and the scan past the block they are as of, in order.
 * Null when Bendystraw has none for the chain, is so far behind the head that the blocks since are more than a scan may
 * read (`tailOrNull`), or the scan fails. */
async function latestEvents(
  chainId: number,
  deployment: StickyDeployment,
  latest: IndexedRows<IndexedStickyEvent> | null,
  ours: ReadonlySet<bigint>,
  deps: HomeReadDeps,
  signal: AbortSignal | undefined,
): Promise<StickyEvent[] | null> {
  const asOf = latest?.blocks.get(chainId)
  if (!latest || asOf === undefined) return null
  const filter = { address: deployment.hook, topics: [POSITION_TOPICS], fromBlock: scanFrom(asOf, deployment) }
  const tail = () => tailOrNull(() => deps.scan(chainId, filter, { signal }), LATEST_UNAVAILABLE, { chainId })
  const logs = await orNull(tail, signal, TAIL_UNAVAILABLE, { chainId })
  if (logs === null) return null
  const indexed = latest.rows.filter(row => row.chainId === chainId).map(fromIndexedEvent)
  return merged(indexed, decoded(chainId, logs), asOf).filter(event => ours.has(event.projectId))
}

type ChainFacts = {
  chainId: number
  deployment: StickyDeployment
  infos: StickyProjectInfo[]
  ours: ReadonlySet<bigint>
  options: FeedOptions
}

/** The chain's part from Bendystraw's pays and cash outs, and Latest from its newest events when it has them. */
async function fromMoves(
  { chainId, deployment, infos, ours, options }: ChainFacts,
  moves: IndexedMove[],
  latest: IndexedRows<IndexedStickyEvent> | null,
  deps: HomeReadDeps,
  signal: AbortSignal | undefined,
): Promise<HomeChain> {
  const amounts = moveAmounts(moves)
  const events = moveEvents(moves)
  const newest = await latestEvents(chainId, deployment, latest, ours, deps, signal)
  const window = (newest ?? events).slice(-FEED_WINDOW)
  // Bendystraw's events have their amounts in its pays and cash outs; only those a scan found are read again.
  const scanned = window.filter(event => event.blockNumber !== null)
  const read = scanned.length ? await deps.terminalMoves(scanned, { signal }) : new Map<string, bigint>()
  const gifts = airdropEvents(events, options).slice(-FEED_WINDOW)
  return {
    chainId,
    cards: infos.map(info => ({ info, sticks: holdersIn(moves, info.projectId) })),
    activity: feedRows(window, new Map([...amounts, ...read]), options),
    airdrops: airdropRows(gifts, amounts, options),
    supply: moves.map(({ projectId, timestamp, kind, tokens }) => ({
      projectId,
      timestamp,
      delta: kind === 'stick' ? tokens : -tokens,
    })),
  }
}

/** The chain's part from its hook's position events, scanned from the block of its first launch (the lowest project
 * ID), or from the deployer's block when that cannot be found. */
async function fromScan(
  { chainId, deployment, infos, ours, options }: ChainFacts,
  deps: HomeReadDeps,
  signal: AbortSignal | undefined,
): Promise<HomeChain> {
  const first = [...ours].reduce((low, id) => (id < low ? id : low))
  const fromBlock = (await deps.creationBlock(chainId, first, { signal })) ?? deployment.fromBlock
  const logs = await deps.scan(chainId, { address: deployment.hook, topics: [POSITION_TOPICS], fromBlock }, { signal })
  const events = decoded(chainId, logs).filter(event => ours.has(event.projectId))
  const window = events.slice(-FEED_WINDOW)
  const gifts = airdropEvents(events, options).slice(-FEED_WINDOW)
  // One read of the terminal for both lists.
  const amounts = await deps.terminalMoves([...window, ...gifts], { signal })
  const stuck = (projectId: bigint) =>
    holderRows(events.filter(event => event.projectId === projectId)).filter(row => row.staked > 0n).length
  return {
    chainId,
    cards: infos.map(info => ({ info, sticks: stuck(info.projectId) })),
    activity: feedRows(window, amounts, options),
    airdrops: airdropRows(gifts, amounts, options),
    supply: events.flatMap(({ kind, projectId, timestamp, count }) =>
      (kind === 'stick' || kind === 'unstick') && count !== undefined
        ? [{ projectId, timestamp, delta: kind === 'stick' ? count : -count }]
        : [],
    ),
  }
}

/**
 * One chain's part of the home: its Sticky projects as the chain reads them now, each with its Sticks, the chain's
 * newest rows of Latest and Airdrops, and the history of its Sticky shares. The projects are read together, at one
 * block. A project that cannot be read is left out; a chain none of whose projects can be read rejects.
 */
export async function homeChain(chainId: number, options: HomeReadOptions): Promise<HomeChain> {
  const { signal, index, latest, ...given } = options
  const deps: HomeReadDeps = { ...live, ...given }
  const deployment = deploymentOn(chainId)

  const { projects } = await deps.projectsOn(chainId, index, { signal })
  const ids = projects.map(project => project.projectId)
  if (!ids.length) return { chainId, cards: [], activity: [], airdrops: [], supply: [] }

  const infos = await readProjects(chainId, ids, deps, signal)
  const byId = new Map(infos.map(info => [info.projectId, info]))
  const facts: ChainFacts = {
    chainId,
    deployment,
    infos,
    ours: new Set(ids),
    options: {
      adapter: deployment.autoStick,
      tokens: (eventChainId, projectId) => (eventChainId === chainId ? byId.get(projectId) : undefined),
    },
  }

  const moves = index?.blocks.has(chainId)
    ? await orNull(() => movesOf(chainId, ids, deps, signal), signal, MOVES_UNAVAILABLE, { chainId })
    : null
  return moves ? fromMoves(facts, moves, latest, deps, signal) : fromScan(facts, deps, signal)
}

const live: HomeReadDeps = {
  projectsOn: (chainId, index, { signal }) => stickyProjectsOn(chainId, index, { signal }),
  readProjects: (chainId, projectIds, { signal }) => readStickyProjects(chainId, projectIds, { signal }),
  indexedMoves: indexedStickyMoves,
  scan: scanToHead,
  terminalMoves: (events, { signal }) => terminalMoves(events, { signal }),
  creationBlock: (chainId, projectId, { signal }) => projectCreationBlock(chainId, projectId, { signal }),
}

/** A card's launch key and planned chains when its chain is one of them, or its uri names no chains; otherwise none.
 * A launch writes one uri on every chain, so a project on another chain whose uri copies a launch's cannot join it, or
 * head it, and neither can one whose copy adds its own chain to the plan. */
function plannedKey({ info }: HomeCard): string | null {
  const key = launchKey(info)
  const onPlan = info.plannedChains === null || info.plannedChains.includes(info.chainId)
  return key !== null && onPlan ? `${key}|${info.plannedChains ?? ''}` : null
}

/**
 * The Stickiest cards: a launch's projects share its launch id, stickiness bonus, transfer mode and planned chains,
 * and each chain of its plan gives the first of its projects that does, so a copied uri cannot join a launch. Most
 * Sticky shares first; cards that tie keep the order they came in.
 */
export function groupHomeCards(cards: readonly HomeCard[]): HomeCardGroup[] {
  const groups: HomeCardGroup[] = []
  const byLaunch = new Map<string, HomeCardGroup>()
  for (const card of cards) {
    const key = plannedKey(card)
    const launch = key === null ? undefined : byLaunch.get(key)
    if (launch && !launch.cards.some(other => other.info.chainId === card.info.chainId)) {
      launch.cards.push(card)
      launch.totalStaked += card.info.totalSupply
      continue
    }
    const fresh = { cards: [card], totalStaked: card.info.totalSupply }
    if (key !== null && !launch) byLaunch.set(key, fresh)
    groups.push(fresh)
  }
  return groups.sort((a, b) => (b.totalStaked > a.totalStaked ? 1 : b.totalStaked < a.totalStaked ? -1 : 0))
}

/** A point of the secured chart: US dollars in millionths. */
type SecuredPoint = { timestamp: number; value: bigint }

export type SecuredSeries = {
  points: SecuredPoint[]
  /** Today's claimable backing at today's prices, in millionths of a dollar. */
  total: bigint
  /** The symbols of the stuck tokens that have no price, each once. */
  missing: string[]
  /** Whether any stuck token has a price. */
  hasValue: boolean
}

/** A bar of the chart, `height` a percentage of the tallest. */
export type SecuredBar = SecuredPoint & { height: number }

const USD_DECIMALS = 6
/** How far back a project with no moves is drawn, flat. */
const FLAT_HISTORY = 30 * 86_400
const BARS = 28

/** A price in millionths of a dollar, or null for none. */
function micros(price: number | undefined): bigint | null {
  return price !== undefined && Number.isFinite(price) && price > 0 ? BigInt(Math.round(price * 10 ** USD_DECIMALS)) : null
}

/** A project's Sticky shares over time: the running sum of its moves, never below zero, shifted so that it ends at
 * today's supply, then today's supply now. A move the reads missed only shifts older points. */
function stakedHistory(ownMoves: readonly SupplyMove[], info: StickyProjectInfo, now: number): SecuredPoint[] {
  const moves = [...ownMoves].sort((a, b) => a.timestamp - b.timestamp)
  const today = { timestamp: now, value: info.totalSupply }
  if (!moves.length) return [{ timestamp: now - FLAT_HISTORY, value: info.totalSupply }, today]
  let running = 0n
  const points = [{ timestamp: moves[0].timestamp, value: 0n }]
  for (const move of moves) {
    running = running + move.delta < 0n ? 0n : running + move.delta
    points.push({ timestamp: move.timestamp, value: running })
  }
  const correction = info.totalSupply - running
  return [
    ...points.map(({ timestamp, value }) => ({ timestamp, value: value + correction < 0n ? 0n : value + correction })),
    today,
  ]
}

/**
 * What Sticky secures, in US dollars: today's claimable backing of every priced token at today's price, and before
 * today the shares staked then at today's backing per share and price. It estimates; it does not rebuild past
 * donations, fees or prices. `priceOf` is a token's price on a chain, in dollars, or undefined. `settled` says whether
 * a chain's prices have answered: until they have, a token with no price is not named as one that could not be priced.
 */
export function homeSecuredSeries(
  chains: readonly HomeChain[],
  priceOf: (chainId: number, token: Address) => number | undefined,
  now: number,
  settled: (chainId: number) => boolean = () => true,
): SecuredSeries {
  const valued = chains.flatMap(chain => {
    const byProject = new Map<bigint, SupplyMove[]>()
    for (const move of chain.supply) {
      const own = byProject.get(move.projectId)
      if (own) own.push(move)
      else byProject.set(move.projectId, [move])
    }
    return chain.cards.flatMap(({ info }) => {
      const price = micros(priceOf(chain.chainId, info.stakedToken))
      return price === null ? [] : [{ info, price, history: stakedHistory(byProject.get(info.projectId) ?? [], info, now) }]
    })
  })
  const times = [...new Set(valued.flatMap(({ history }) => history.map(point => point.timestamp)))].sort((a, b) => a - b)
  if (!times.length) times.push(now - FLAT_HISTORY, now)
  // The times only grow, so each history is walked once: `seen[at]` is how many of its points are at or before the
  // time being valued.
  const seen = valued.map(() => 0)
  const points = times.map(timestamp => {
    let value = 0n
    valued.forEach(({ info, price, history }, at) => {
      while (seen[at] < history.length && history[seen[at]].timestamp <= timestamp) seen[at] += 1
      const shares = seen[at] ? history[seen[at] - 1].value : 0n
      if (info.totalSupply > 0n) value += (shares * info.backing * price) / info.totalSupply / 10n ** BigInt(info.decimals)
    })
    return { timestamp, value }
  })
  const total = valued.reduce((sum, { info, price }) => sum + (info.backing * price) / 10n ** BigInt(info.decimals), 0n)
  points[points.length - 1] = { timestamp: now, value: total }
  const missing = chains.flatMap(chain =>
    chain.cards.flatMap(({ info }) =>
      info.totalSupply > 0n && settled(chain.chainId) && micros(priceOf(chain.chainId, info.stakedToken)) === null
        ? [info.symbol]
        : [],
    ),
  )
  return { points, total, missing: [...new Set(missing)], hasValue: valued.length > 0 }
}

/** The chart's bars: `count` samples, evenly spaced from the first point to the last, each the value of the last
 * point at or before it, and the last one today's total. A bar that is not zero is at least 1% tall. */
export function securedBars({ points, total }: SecuredSeries, count = BARS): SecuredBar[] {
  const start = points[0].timestamp
  const end = points[points.length - 1].timestamp
  const span = Math.max(end - start, 1)
  const samples: SecuredPoint[] = []
  let at = 0
  for (let bar = 0; bar < count; bar += 1) {
    const timestamp = start + (span * bar) / Math.max(count - 1, 1)
    while (at + 1 < points.length && points[at + 1].timestamp <= timestamp) at += 1
    samples.push({ timestamp, value: points[at].value })
  }
  samples[samples.length - 1] = { timestamp: end, value: total }
  const tallest = samples.reduce((high, { value }) => (value > high ? value : high), 1n)
  return samples.map(sample => ({
    ...sample,
    height: sample.value <= 0n ? 0 : Math.max(1, Number((sample.value * 10_000n) / tallest) / 100),
  }))
}
