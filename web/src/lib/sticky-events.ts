/**
 * Sticky's history, from the hook: sticks and unsticks, streaks that start and end, and a project's settings
 * (its granters, holders' trusted senders, and backing excluded from holders' claims). Bendystraw answers first,
 * and the chain's own logs complete its answer from just below the block it is indexed through to the head. When
 * Bendystraw fails, does not index a chain, or is so far behind the head that the blocks since are more than a scan
 * may read (`tailOrNull`), the chain's logs are the whole answer and the result says so in `degraded`. A history is
 * never shorter for either: a read that can get neither rejects.
 *
 * Also here, because a scan depends on them: the block a project was created in, where a scan of its history
 * starts, and the Sticky projects a chain has past what Bendystraw lists.
 *
 * Addresses and transaction hashes are lowercase, whichever source an event came from.
 */

import {
  decodeEventLog,
  getAbiItem,
  isAddress,
  pad,
  toEventSelector,
  toHex,
  zeroAddress,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type Log,
} from 'viem'
import {
  freshHead,
  HistoryTooLongError,
  keptLogs,
  projectHookLogs,
  scanLogs,
  untilAborted,
  type ScannedLog,
} from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { controllerAbi, projectsAbi, stickyDeployerAbi, stickyHookAbi } from '@/lib/sticky-abis'
import { stickyDeployment, type StickyDeployment } from '@/lib/sticky-addresses'
import {
  indexedStickyCreateTx,
  indexedStickyEvents,
  indexedStickySettings,
  type IndexedProjects,
  type IndexedSetting,
  type IndexedStickyEvent,
} from '@/lib/sticky-indexed'

export type StickyEventKind = 'stick' | 'unstick' | 'streakStart' | 'streakEnd' | 'trust' | 'granter' | 'excludeOrphan'

/**
 * One of the hook's events. The order of a list of them is right for a feed but says nothing about balances: on
 * Arbitrum two blocks can share a timestamp. Balances come from positions.
 */
export type StickyEvent = {
  kind: StickyEventKind
  chainId: number
  projectId: bigint
  /** Whose position or consent the event is about. A granter event's is the granter, and an exclusion, which is
   * nobody's, has the zero address. */
  holder: Address
  txHash: Hex
  logIndex: number
  /** Null on indexed events: stickyEvent has no block column. */
  blockNumber: bigint | null
  /** In Unix seconds. */
  timestamp: number
  /** stick: who paid, or for a transfer, who sent the shares. */
  payer?: Address
  /** stick / unstick: the shares that moved. */
  count?: bigint
  /** stick / unstick: the holder's balance after. */
  balance?: bigint
  /** streakEnd: how long the streak lasted, in seconds. */
  length?: bigint
  /** trust: the sender the holder trusts, or no longer trusts. Anyone can say this of themselves for any project,
   * so a caller checks `isTrustedSenderOf` on the chain before it relies on one. */
  sender?: Address
  /** trust: whether the sender is trusted now. granter: always true, since a launch's granters are for good. */
  trusted?: boolean
  /** excludeOrphan: the backing no holder can claim, as the hook now records it, in the staked token's units. */
  amount?: bigint
}

export type StickyEventsResult = {
  events: StickyEvent[]
  source: 'indexed' | 'scanned'
  degraded: null | 'not-indexed' | 'indexer-error'
}

/** The Sticky projects of one chain, and where the list came from, as with events. */
export type StickyProjectsResult = {
  projects: { chainId: number; projectId: bigint }[]
  source: 'indexed' | 'scanned'
  degraded: null | 'not-indexed' | 'indexer-error'
}

type Cancel = { signal?: AbortSignal }

/** One contract's logs that match `topics`, from `fromBlock` through the head. */
type LogFilter = { address: Address; topics: (Hex | Hex[] | null)[]; fromBlock: bigint }

/** What a creation check reads of a receipt's logs. */
type ReceiptLog = { address: Address; topics: readonly Hex[]; data: Hex; removed?: boolean }

/** Every read this module makes, so a test can stand in for Bendystraw and Center. */
export type StickyReadDeps = {
  indexedEvents: typeof indexedStickyEvents
  indexedSettings: typeof indexedStickySettings
  indexedCreateTx: typeof indexedStickyCreateTx
  /** Logs through the head, each with its block's time. */
  scan: (chainId: number, filter: LogFilter, opts: Cancel) => Promise<ScannedLog[]>
  /** One project's hook logs through the head, resuming the history this browser keeps of it. A null start is a
   * project whose creation block is not known: the kept history is used whatever block it began at. */
  projectLogs: (chainId: number, projectId: bigint, fromBlock: bigint | null, opts: Cancel) => Promise<ScannedLog[]>
  head: (chainId: number, opts: Cancel) => Promise<bigint>
  receipt: (chainId: number, hash: Hex, opts: Cancel) => Promise<{ blockNumber: bigint; logs: readonly ReceiptLog[] }>
  /** JBProjects.count() at a block. */
  projectCount: (chainId: number, blockNumber: bigint, opts: Cancel) => Promise<bigint>
  creationBlock: (chainId: number, projectId: bigint, opts: StickyReadOptions) => Promise<bigint | null>
}

/** A caller's signal, which every read gets, and in tests the reads to use instead of the real ones. */
export type StickyReadOptions = Cancel & Partial<StickyReadDeps>

const selector = (abi: Abi, name: string) => toEventSelector(getAbiItem({ abi, name }) as AbiEvent)
/** The hook's events that change a position, in the old client's order (webclient/app.js:1079 and 1112). */
export const POSITION_TOPICS = ['Staked', 'Unstaked', 'StreakStarted', 'StreakEnded'].map(name =>
  selector(stickyHookAbi, name),
)
const PROJECT_TOPICS = [
  ...POSITION_TOPICS,
  ...['SetGranter', 'SetTrustedSender', 'ExcludeOrphanedBalance'].map(name => selector(stickyHookAbi, name)),
]
const DEPLOY_STICKY = selector(stickyDeployerAbi, 'DeploySticky')
const SETTING_KINDS: ReadonlySet<StickyEventKind> = new Set(['granter', 'trust', 'excludeOrphan'])
/** How many of the blocks Bendystraw says it is indexed through a scan reads again. Ponder's status can run ahead
 * of the rows of the answer it comes with; what both have is counted once. */
const OVERLAP = 64n

// What the console says when a read gives up on one source and uses another, the same each time.
const INDEX_UNAVAILABLE = 'Bendystraw could not answer; reading the chain instead.'
/** What the console hears when Bendystraw cannot list the Sticky projects, and each chain's deployer is scanned. */
export const PROJECTS_UNAVAILABLE = 'Bendystraw could not list the Sticky projects; scanning each chain instead.'
const CREATION_NOT_INDEXED = "Could not find a Sticky project's creation from Bendystraw."
const CREATION_NOT_ON_CHAIN = "Could not find a Sticky project's creation block on the chain."

const lower = <T extends string>(value: T) => value.toLowerCase() as T
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

function deploymentOn(chainId: number): StickyDeployment {
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  return deployment
}

function checkProjectId(projectId: bigint): void {
  if (projectId < 1n || projectId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${projectId} is not a project ID.`)
  }
}

/**
 * The event a hook log records, or null when the log is not one of the seven the hook's history is made of
 * (another contract's, another of the hook's events, or removed). A hook event that cannot be read throws rather
 * than go missing: one not yet in a block, one without its block's time (Center sends it with every log), or one
 * whose fields do not decode.
 */
export function decodeHookLog(log: Log, chainId: number): StickyEvent | null {
  const hook = stickyDeployment(chainId)?.hook
  const [signature] = log.topics
  if (!hook || log.removed || !same(log.address, hook) || !signature || !PROJECT_TOPICS.includes(lower(signature))) {
    return null
  }
  const { blockNumber, logIndex, transactionHash, blockTimestamp } = log
  if (blockNumber === null || logIndex === null || transactionHash === null) {
    throw new Error(`A Sticky hook log on chain ${chainId} is not in a block.`)
  }
  if (blockTimestamp === null || blockTimestamp === undefined) {
    throw new Error(`A Sticky hook log on chain ${chainId} came without its block's time.`)
  }
  const at = { chainId, txHash: lower(transactionHash), logIndex, blockNumber, timestamp: Number(blockTimestamp) }
  const { eventName, args } = decodeEventLog({ abi: stickyHookAbi, topics: log.topics, data: log.data })
  switch (eventName) {
    case 'Staked':
      return {
        ...at,
        kind: 'stick',
        projectId: args.projectId,
        holder: lower(args.holder),
        payer: lower(args.payer),
        count: args.count,
        balance: args.stakedBalance,
      }
    case 'Unstaked':
      return {
        ...at,
        kind: 'unstick',
        projectId: args.projectId,
        holder: lower(args.holder),
        count: args.count,
        balance: args.stakedBalance,
      }
    case 'StreakStarted':
      return { ...at, kind: 'streakStart', projectId: args.projectId, holder: lower(args.holder) }
    case 'StreakEnded':
      return { ...at, kind: 'streakEnd', projectId: args.projectId, holder: lower(args.holder), length: args.duration }
    case 'SetGranter':
      return { ...at, kind: 'granter', projectId: args.projectId, holder: lower(args.granter), trusted: true }
    case 'SetTrustedSender':
      return {
        ...at,
        kind: 'trust',
        projectId: args.projectId,
        holder: lower(args.holder),
        sender: lower(args.sender),
        trusted: args.trusted,
      }
    case 'ExcludeOrphanedBalance':
      return { ...at, kind: 'excludeOrphan', projectId: args.projectId, holder: zeroAddress, amount: args.amount }
    default:
      return null
  }
}

/** The hook event a row of Bendystraw's stickyEvents records. It has no block number: the table has no such column. */
export function fromIndexedEvent(row: IndexedStickyEvent): StickyEvent {
  const at = {
    chainId: row.chainId,
    projectId: row.projectId,
    holder: lower(row.holder),
    txHash: lower(row.txHash),
    logIndex: row.logIndex,
    blockNumber: null,
    timestamp: row.timestamp,
  }
  switch (row.type) {
    case 'staked':
      return { ...at, kind: 'stick', payer: lower(row.payer), count: row.count, balance: row.stakedBalance }
    case 'unstaked':
      return { ...at, kind: 'unstick', count: row.count, balance: row.stakedBalance }
    case 'streakStarted':
      return { ...at, kind: 'streakStart' }
    case 'streakEnded':
      return { ...at, kind: 'streakEnd', length: BigInt(row.duration) }
  }
}

function fromIndexedSetting(row: IndexedSetting): StickyEvent {
  const at = {
    chainId: row.chainId,
    projectId: row.projectId,
    txHash: lower(row.txHash),
    logIndex: row.logIndex,
    blockNumber: null,
    timestamp: row.timestamp,
  }
  switch (row.type) {
    case 'granterSet':
      return { ...at, kind: 'granter', holder: lower(row.granter), trusted: true }
    case 'trustedSenderSet':
      return { ...at, kind: 'trust', holder: lower(row.holder), sender: lower(row.sender), trusted: row.trusted }
    case 'orphanedBalanceExcluded':
      return { ...at, kind: 'excludeOrphan', holder: zeroAddress, amount: row.amount }
  }
}

const decodeAll = (chainId: number, logs: ScannedLog[]) => logs.flatMap(log => decodeHookLog(log, chainId) ?? [])
const byTime = (a: StickyEvent, b: StickyEvent) => a.timestamp - b.timestamp || a.logIndex - b.logIndex

/** Where a scan past a block Bendystraw is indexed through starts: `OVERLAP` blocks below the block after it, and
 * never before the deployer's block (webclient/app.js:616), nor before `created`, the block a project was created in
 * when the scan is of one project's history and that block is known: an indexer that stalled before the launch costs
 * no scan of the stall. */
export function scanFrom(asOf: bigint, { fromBlock }: StickyDeployment, created: bigint | null = null): bigint {
  const start = asOf + 1n - OVERLAP
  const floor = created !== null && created > fromBlock ? created : fromBlock
  return start > floor ? start : floor
}

/** One event's identity, whichever source it came from: its chain, its transaction, and its place in the transaction's
 * receipt. Bendystraw writes a hash in lowercase, and a node may not. */
export const eventKey = (chainId: number, txHash: string, logIndex: number) =>
  `${chainId}:${txHash.toLowerCase()}:${logIndex}`

/** The logs of a chain's `tail` that none of Bendystraw's `rows` records. A tail reads again the blocks just below the
 * one Bendystraw is indexed through, so an event both have is Bendystraw's row, counted once. */
export function notIndexed<Log extends { transactionHash: string; logIndex: number }>(
  chainId: number,
  rows: readonly { txHash: string; logIndex: number }[],
  tail: readonly Log[],
): Log[] {
  const known = new Set(rows.map(row => eventKey(chainId, row.txHash, row.logIndex)))
  return tail.filter(log => !known.has(eventKey(chainId, log.transactionHash, log.logIndex)))
}

/** A tail past the block Bendystraw is indexed through, as `read` scans it, or null when it is longer than a scan may
 * read. An indexer that answers but is far behind the head, as one replaying its history is, cannot answer for the
 * blocks since, so the caller reads what this browser kept instead, and the console hears why under `label`, as when
 * Bendystraw cannot answer at all. Any other failure is the caller's. */
export async function tailOrNull(
  read: () => Promise<ScannedLog[]>,
  label: string,
  about: Record<string, unknown>,
): Promise<ScannedLog[] | null> {
  try {
    return await read()
  } catch (error) {
    if (!(error instanceof HistoryTooLongError)) throw error
    console.warn(label, about, error)
    return null
  }
}

/** Where a scan of a holder's events starts when Bendystraw cannot say where its index ends: the block the oldest of
 * their `projects` was created in (project IDs rise with creation), and never below the deployer's block. With no
 * project, or none whose creation block can be found, it is the deployer's block. */
async function holderStart(
  deps: StickyReadDeps,
  chainId: number,
  { fromBlock }: StickyDeployment,
  projects: readonly bigint[],
  options: StickyReadOptions,
): Promise<bigint> {
  if (!projects.length) return fromBlock
  const oldest = projects.reduce((low, projectId) => (projectId < low ? projectId : low))
  const created = await deps.creationBlock(chainId, oldest, options)
  return created !== null && created > fromBlock ? created : fromBlock
}

/** The first of each event: one both sources reported is counted once. */
function once(events: StickyEvent[]): StickyEvent[] {
  const seen = new Set<string>()
  return events.filter(({ chainId, txHash, logIndex }) => {
    const key = eventKey(chainId, txHash, logIndex)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Bendystraw's events and a scan's, each once, keeping Bendystraw's copy of what both have. Everything through
 * `asOf`, the block Bendystraw is indexed through, is in order of time and log index, so what the scan found that
 * Bendystraw's rows had not reached is in its place. What came after goes last, as the scan found it. */
export function merged(indexed: StickyEvent[], scanned: StickyEvent[], asOf: bigint): StickyEvent[] {
  const all = once([...indexed, ...scanned])
  const later = (event: StickyEvent) => event.blockNumber !== null && event.blockNumber > asOf
  return [...all.filter(event => !later(event)).sort(byTime), ...all.filter(later)]
}

/** What `read` gives, or null when it fails, which the console hears about under `label`. When the caller has
 * cancelled it rejects with the caller's reason instead: a read the caller gave up on is no reason to read
 * something else. */
export async function orNull<T>(
  read: () => Promise<T>,
  signal: AbortSignal | undefined,
  label: string,
  about: Record<string, unknown>,
): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    console.warn(label, about, error)
    return null
  }
}

/**
 * Every event of a project's hook history, through the chain's head: its sticks, unsticks and streaks from
 * Bendystraw's stickyEvents, and its granters, trusted senders and exclusions from its stickySettingEvents. One
 * scan of the hook, from just below the older of the two answers' blocks, adds what either answer did not have.
 * When either read fails, has no status for the chain, or is too far behind for that scan, the hook's whole history
 * is scanned from the project's creation block instead, or through the history this browser kept when that block
 * cannot be found.
 */
export async function stickyEvents(
  chainId: number,
  projectId: bigint,
  options: StickyReadOptions = {},
): Promise<StickyEventsResult> {
  const { signal, ...given } = options
  const deps: StickyReadDeps = { ...live, ...given }
  const deployment = deploymentOn(chainId)
  checkProjectId(projectId)
  const ours = (event: StickyEvent) => event.projectId === projectId
  const about = { chainId, projectId }

  const [events, settings] = await Promise.all([
    orNull(() => deps.indexedEvents({ chainId, projectId }, signal), signal, INDEX_UNAVAILABLE, about),
    orNull(() => deps.indexedSettings(chainId, projectId, signal), signal, INDEX_UNAVAILABLE, about),
  ])
  const eventsBlock = events?.blocks.get(chainId)
  const settingsBlock = settings?.blocks.get(chainId)
  if (events && settings && eventsBlock !== undefined && settingsBlock !== undefined) {
    const [older, newer] = eventsBlock < settingsBlock ? [eventsBlock, settingsBlock] : [settingsBlock, eventsBlock]
    const topics = [PROJECT_TOPICS, pad(toHex(projectId))]
    const fromBlock = scanFrom(older, deployment)
    const read = () => deps.scan(chainId, { address: deployment.hook, topics, fromBlock }, { signal })
    const logs = await tailOrNull(read, INDEX_UNAVAILABLE, about)
    if (logs !== null) {
      const indexed = [...events.rows.map(fromIndexedEvent), ...settings.rows.map(fromIndexedSetting)].filter(ours)
      return { events: merged(indexed, decodeAll(chainId, logs).filter(ours), newer), source: 'indexed', degraded: null }
    }
  }

  const degraded = events && settings ? 'not-indexed' : 'indexer-error'
  const fromBlock = await deps.creationBlock(chainId, projectId, { ...given, signal })
  const logs = await deps.projectLogs(chainId, projectId, fromBlock, { signal })
  return { events: once(decodeAll(chainId, logs).filter(ours)), source: 'scanned', degraded }
}

/**
 * One holder's sticks, unsticks and streaks in every Sticky project of a chain, through the chain's head. Bendystraw
 * answers and a scan of the hook, from just below its block, adds what it did not have. When it fails, has no status
 * for the chain, or is too far behind for that scan, the hook is scanned from the block the oldest of `projects` was
 * created in, or with none from the deployer's block: no Sticky project is older. `projects` are the ones Bendystraw lists positions of the holder
 * in: an event in a project it does not list is newer than the listing.
 */
export async function stickyHolderEvents(
  chainId: number,
  holder: Address,
  options: StickyReadOptions & { projects?: readonly bigint[] } = {},
): Promise<StickyEventsResult> {
  const { signal, projects = [], ...given } = options
  const deps: StickyReadDeps = { ...live, ...given }
  const deployment = deploymentOn(chainId)
  if (!isAddress(holder, { strict: false })) throw new TypeError(`${holder} is not an address.`)
  const who = lower(holder)
  const theirs = (event: StickyEvent) => event.holder === who && !SETTING_KINDS.has(event.kind)

  const read = () => deps.indexedEvents({ chainId, holder: who }, signal)
  const index = await orNull(read, signal, INDEX_UNAVAILABLE, { chainId })
  const block = index?.blocks.get(chainId)
  const topics = [POSITION_TOPICS, null, pad(who)]
  const scan = (fromBlock: bigint) => deps.scan(chainId, { address: deployment.hook, topics, fromBlock }, { signal })
  if (index && block !== undefined) {
    const logs = await tailOrNull(() => scan(scanFrom(block, deployment)), INDEX_UNAVAILABLE, { chainId })
    if (logs !== null) {
      const indexed = index.rows.map(fromIndexedEvent).filter(theirs)
      return { events: merged(indexed, decodeAll(chainId, logs).filter(theirs), block), source: 'indexed', degraded: null }
    }
  }
  const logs = await scan(await holderStart(deps, chainId, deployment, projects, { ...given, signal }))
  const degraded = index ? 'not-indexed' : 'indexer-error'
  return { events: once(decodeAll(chainId, logs).filter(theirs)), source: 'scanned', degraded }
}

/** Each project's creation block this session has found, by `${chainId}:${projectId}`. */
const creationBlocks = new Map<string, bigint>()

/** The project a log launched, when it is this deployer's DeploySticky, and otherwise null. */
function launchedIn(log: ReceiptLog, deployer: Address): bigint | null {
  const [signature] = log.topics
  if (log.removed || !same(log.address, deployer) || !signature || lower(signature) !== DEPLOY_STICKY) return null
  const topics = log.topics as [Hex, ...Hex[]]
  return decodeEventLog({ abi: stickyDeployerAbi, eventName: 'DeploySticky', topics, data: log.data }).args.projectId
}

/** The block of the transaction Bendystraw says created the project, once its receipt shows this deployer's
 * DeploySticky for the project. It throws when Bendystraw names none, or the receipt shows no such launch. */
async function createdByIndex(
  deps: StickyReadDeps,
  { chainId, deployer }: StickyDeployment,
  projectId: bigint,
  signal: AbortSignal | undefined,
): Promise<bigint> {
  const hash = await deps.indexedCreateTx(chainId, projectId, signal)
  if (hash === null) throw new Error('Bendystraw names no transaction that created the project.')
  const receipt = await deps.receipt(chainId, hash, { signal })
  if (!receipt.logs.some(log => launchedIn(log, deployer) === projectId)) {
    throw new Error(`Transaction ${hash} did not launch the project.`)
  }
  return receipt.blockNumber
}

/** The first block where JBProjects counts the project, by a binary search between the deployer's block and the
 * head (webclient/app.js:683-699). */
async function createdByCount(
  deps: StickyReadDeps,
  { chainId, fromBlock }: StickyDeployment,
  projectId: bigint,
  signal: AbortSignal | undefined,
): Promise<bigint> {
  const countAt = (block: bigint) => deps.projectCount(chainId, block, { signal })
  let low = fromBlock
  let high = await deps.head(chainId, { signal })
  if ((await countAt(high)) < projectId) throw new Error(`Project ${projectId} does not exist on chain ${chainId} yet.`)
  if ((await countAt(low)) >= projectId) return low
  while (high - low > 1n) {
    const middle = (low + high) / 2n
    if ((await countAt(middle)) >= projectId) high = middle
    else low = middle
  }
  return high
}

/**
 * The block a project was created in, where a scan of its history starts: the tightest start keeps a scan within
 * its request budget. Bendystraw names the creating transaction, and its receipt must show this chain's deployer
 * launching this project. Otherwise JBProjects.count() is searched at past blocks. The block is kept for the
 * session. When neither answers it is null, and not kept, so the next call tries again.
 */
export async function projectCreationBlock(
  chainId: number,
  projectId: bigint,
  options: StickyReadOptions = {},
): Promise<bigint | null> {
  const { signal, ...given } = options
  const deps: StickyReadDeps = { ...live, ...given }
  const deployment = deploymentOn(chainId)
  checkProjectId(projectId)
  const key = `${chainId}:${projectId}`
  const known = creationBlocks.get(key)
  if (known !== undefined) return known

  const about = { chainId, projectId }
  const found =
    (await orNull(() => createdByIndex(deps, deployment, projectId, signal), signal, CREATION_NOT_INDEXED, about)) ??
    (await orNull(() => createdByCount(deps, deployment, projectId, signal), signal, CREATION_NOT_ON_CHAIN, about))
  if (found !== null) creationBlocks.set(key, found)
  return found
}

/**
 * Every Sticky project of a chain: the ones `index` lists, and the ones the deployer's DeploySticky logs show from
 * just below the block it is indexed through. `index` is what `indexedStickyProjects` gave for the chain's network,
 * or null when it failed; with no index for the chain, or one too far behind for that scan, the deployer's whole
 * history is scanned. A launch the scan finds is kept as its project's creation block.
 */
export async function stickyProjectsOn(
  chainId: number,
  index: IndexedProjects | null,
  options: StickyReadOptions = {},
): Promise<StickyProjectsResult> {
  const { signal, ...given } = options
  const deps: StickyReadDeps = { ...live, ...given }
  const deployment = deploymentOn(chainId)
  const { deployer } = deployment
  const scan = (fromBlock: bigint) => deps.scan(chainId, { address: deployer, topics: [DEPLOY_STICKY], fromBlock }, { signal })
  const block = index?.blocks.get(chainId)
  const tail =
    block === undefined ? null : await tailOrNull(() => scan(scanFrom(block, deployment)), PROJECTS_UNAVAILABLE, { chainId })
  const logs = tail ?? (await scan(deployment.fromBlock))

  const listed = (index?.projects ?? []).filter(project => project.chainId === chainId)
  const ids = new Set(listed.map(project => project.projectId))
  for (const log of logs) {
    const projectId = launchedIn(log, deployer)
    if (projectId === null) continue
    creationBlocks.set(`${chainId}:${projectId}`, log.blockNumber)
    ids.add(projectId)
  }
  return {
    projects: [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(projectId => ({ chainId, projectId })),
    source: tail === null ? 'scanned' : 'indexed',
    degraded: tail !== null ? null : index ? 'not-indexed' : 'indexer-error',
  }
}

/** Block times this session has read, by `${chainId}:${blockNumber}`. */
const blockTimes = new Map<string, bigint>()

/** The logs, each with its block's time. Center sends the time with every log. A log the old client kept in this
 * browser can lack it, and then its block is read, one block at a time and once a session. */
async function timed(chainId: number, logs: ScannedLog[], signal: AbortSignal | undefined): Promise<ScannedLog[]> {
  const out: ScannedLog[] = []
  for (const log of logs) {
    if (log.blockTimestamp !== undefined) {
      out.push(log)
      continue
    }
    const key = `${chainId}:${log.blockNumber}`
    let time = blockTimes.get(key)
    if (time === undefined) {
      const block = await untilAborted(jbCenterPublicClient(chainId).getBlock({ blockNumber: log.blockNumber }), signal)
      time = block.timestamp
      blockTimes.set(key, time)
    }
    out.push({ ...log, blockTimestamp: time })
  }
  return out
}

/** JBProjects on each chain, as the recorded controller names it. */
const projectsContracts = new Map<number, Address>()

export async function projectsContract(chainId: number, signal: AbortSignal | undefined): Promise<Address> {
  const known = projectsContracts.get(chainId)
  if (known) return known
  const read = jbCenterPublicClient(chainId).readContract({
    address: deploymentOn(chainId).controller,
    abi: controllerAbi,
    functionName: 'PROJECTS',
  })
  const projects = await untilAborted(read, signal)
  projectsContracts.set(chainId, projects)
  return projects
}

/** A contract's logs that match `filter` through Center, from its block through the head, each with its block's
 * time: the `scan` every read of this module makes, and the one others make of the hook or the terminal. */
export async function scanToHead(chainId: number, filter: LogFilter, { signal }: Cancel): Promise<ScannedLog[]> {
  const client = jbCenterPublicClient(chainId)
  const toBlock = await freshHead(client, signal)
  return timed(chainId, await scanLogs(client, { ...filter, toBlock }, { signal }), signal)
}

/** Like `scanToHead`, with the part of the history a reorg can no longer replace kept in this browser under `key`, so
 * the next read scans only the blocks after it (`keptLogs`, which `keep` tells what to keep of a log). A null
 * `fromBlock` is a start that could not be found: a kept history is used whatever block it began at. */
export async function keptScanToHead(
  chainId: number,
  key: string,
  filter: Omit<LogFilter, 'fromBlock'> & { fromBlock: bigint | null },
  { signal, keep }: Cancel & { keep?: (log: ScannedLog) => ScannedLog },
): Promise<ScannedLog[]> {
  return timed(chainId, await keptLogs(chainId, key, filter, { signal, keep }), signal)
}

const live: StickyReadDeps = {
  indexedEvents: indexedStickyEvents,
  indexedSettings: indexedStickySettings,
  indexedCreateTx: indexedStickyCreateTx,
  scan: scanToHead,
  async projectLogs(chainId, projectId, fromBlock, { signal }) {
    return timed(chainId, await projectHookLogs(chainId, projectId, fromBlock, { signal }), signal)
  },
  head: (chainId, { signal }) => freshHead(jbCenterPublicClient(chainId), signal),
  receipt: (chainId, hash, { signal }) =>
    untilAborted(jbCenterPublicClient(chainId).getTransactionReceipt({ hash }), signal),
  async projectCount(chainId, blockNumber, { signal }) {
    const address = await projectsContract(chainId, signal)
    const read = jbCenterPublicClient(chainId).readContract({ address, abi: projectsAbi, functionName: 'count', blockNumber })
    return untilAborted(read, signal)
  },
  creationBlock: projectCreationBlock,
}
