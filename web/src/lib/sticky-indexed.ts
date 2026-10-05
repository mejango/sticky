/**
 * Sticky's reads from Bendystraw, the Juicebox indexer: which projects exist, what was stuck and unstuck, the fees
 * and additions that changed a project's balance, who holds what and the hook's settings. A reader answers or
 * rejects. A timeout, an error, or a schema Bendystraw does not have yet is never an empty list, so the caller can
 * read the chain instead. What a page shows as backing, supply, a quote or a minimum comes from the chain, never from
 * here.
 *
 * Addresses come back in lowercase, as Bendystraw stores them.
 */

import { BendystrawTimeoutError, type BendystrawNetwork } from '@bananapus/nana-sdk-core'
import { isAddress, type Address, type Hex } from 'viem'
import { bendystraw } from '@/lib/bendystraw'
import { stickyChainIds, stickyDeployment } from '@/lib/sticky-addresses'

// An operation's ID is the SHA-256 of its exact text, so every document below keeps its whitespace as written.
// `npm run bendystraw:registry` registers each one.
const INDEX_QUERY = `query StickyIndex($owners: [String!], $after: String) {
    _meta { status }
    projects(where: { owner_in: $owners }, limit: 1000, after: $after) {
      items { chainId projectId version owner metadataUri createdAt }
      pageInfo { hasNextPage endCursor }
    }
  }`
const PAY_QUERY = `query StickyPays($where: payEventFilter, $after: String) {
    _meta { status }
    payEvents(where: $where, orderBy: "timestamp", orderDirection: "asc", limit: 1000, after: $after) {
      items { chainId projectId version txHash logIndex timestamp caller beneficiary amount newlyIssuedTokenCount }
      pageInfo { hasNextPage endCursor }
    }
  }`
const CASH_OUT_QUERY = `query StickyCashOuts($where: cashOutTokensEventFilter, $after: String) {
    _meta { status }
    cashOutTokensEvents(where: $where, orderBy: "timestamp", orderDirection: "asc", limit: 1000, after: $after) {
      items { chainId projectId version txHash logIndex timestamp caller holder beneficiary cashOutCount reclaimAmount }
      pageInfo { hasNextPage endCursor }
    }
  }`
// The fees a terminal processed for a project (processFeeEvents, which peripheralist/bendystraw#38 adds) and the
// additions to its balance: the rest of what a chart's balance history is made of. An addition's memo and metadata,
// which anyone who adds to a balance may write as long as they like, are not selected.
const FEE_QUERY = `query StickyFees($where: processFeeEventFilter, $after: String) {
    _meta { status }
    processFeeEvents(where: $where, orderBy: "timestamp", orderDirection: "asc", limit: 1000, after: $after) {
      items { chainId projectId version txHash logIndex timestamp amount wasHeld }
      pageInfo { hasNextPage endCursor }
    }
  }`
const ADDITION_QUERY = `query StickyAdditions($where: addToBalanceEventFilter, $after: String) {
    _meta { status }
    addToBalanceEvents(where: $where, orderBy: "timestamp", orderDirection: "asc", limit: 1000, after: $after) {
      items { chainId projectId version txHash logIndex timestamp amount returnedFees }
      pageInfo { hasNextPage endCursor }
    }
  }`
const CREATE_QUERY = `query StickyCreate($where: projectCreateEventFilter) {
    projectCreateEvents(where: $where, limit: 5) { items { txHash timestamp } }
  }`

// The three tables below are the ones peripheralist/bendystraw#36 adds. An indexer without them answers
// "Cannot query field", the reader rejects, and the caller scans the hook's logs instead. Each document also
// selects the indexing status, so its rows come with the block they are as of.
const EVENTS_QUERY = `query StickyEvents($where: stickyEventFilter, $orderDirection: String, $limit: Int = 1000, $after: String) {
  _meta { status }
  stickyEvents(where: $where, orderBy: "timestamp", orderDirection: $orderDirection, limit: $limit, after: $after) {
    items { chainId projectId version txHash logIndex timestamp holder type count stakedBalance payer duration }
    pageInfo { hasNextPage endCursor }
  }
}`
const POSITIONS_QUERY = `query StickyPositions($where: stickyPositionFilter, $after: String) {
  _meta { status }
  stickyPositions(where: $where, orderBy: "createdAt", orderDirection: "asc", limit: 1000, after: $after) {
    items { chainId projectId version holder stakedBalance streakStartedAt longestCompletedStreak }
    pageInfo { hasNextPage endCursor }
  }
}`
const SETTINGS_QUERY = `query StickySettings($where: stickySettingEventFilter, $after: String) {
  _meta { status }
  stickySettingEvents(where: $where, orderBy: "timestamp", orderDirection: "asc", limit: 1000, after: $after) {
    items { chainId projectId version txHash logIndex timestamp type account holder trusted amount caller }
    pageInfo { hasNextPage endCursor }
  }
}`

/** StickyHook and the deployer exist only on V6. */
const VERSION = 6
/** Ponder's page limit. */
const PAGE_SIZE = 1_000
/** A list of more pages than this is an error, never a truncated list. */
const MAX_PAGES = 20
/** How long a read waits for Bendystraw, all of its pages together, which is the old relay's upstream timeout.
 * The transport tries three times at 15 s each, so a hung indexer would otherwise hold a read for most of a
 * minute before its caller could read the chain instead. */
const READ_TIMEOUT_MS = 8_000

/** Where a hook event or a payment happened. */
type Placed = { chainId: number; projectId: bigint; txHash: Hex; logIndex: number; timestamp: number }

/** A stick (a pay) or an unstick (a cash out). `amount` is what the terminal took in or paid out in the
 * underlying token and `tokens` the Sticky shares issued or cashed out. A stick's `holder` is the pay's
 * beneficiary and its `payer` the pay's caller. */
export type IndexedMove = Placed & { holder: Address; amount: bigint; tokens: bigint } & (
    | { kind: 'stick'; payer: Address }
    | { kind: 'unstick' }
  )

/** A change to a project's balance that is neither a pay nor a cash out, in the token the terminal holds for it. A
 * `fee` the terminal processed for the project took `amount` from the balance, unless `wasHeld`: a held fee left the
 * balance when it was held. An `addition` added `amount` and the held fees it returned (`returnedFees`). */
export type IndexedFee = Placed &
  ({ kind: 'fee'; amount: bigint; wasHeld: boolean } | { kind: 'addition'; amount: bigint; returnedFees: bigint })

/** One row of the hook's history. `count` is the shares that moved, `stakedBalance` the holder's balance
 * after, and `duration` the length of the streak that ended, in seconds. Transfers between holders are an
 * `unstaked` for the sender and a `staked` for the receiver, whose `payer` is the sender. */
export type IndexedStickyEvent = Placed & { holder: Address } & (
    | { type: 'staked'; payer: Address; count: bigint; stakedBalance: bigint }
    | { type: 'unstaked'; count: bigint; stakedBalance: bigint }
    | { type: 'streakStarted' }
    | { type: 'streakEnded'; duration: number }
  )

/** The rows of a list read, with the block each asked-about chain is indexed through, from the same answer as
 * the rows: the first page's, which is the earliest any row is as of. A chain the index has no status for is
 * absent from `blocks`, and its rows are left out with it, since nothing says what they are as of. */
export type IndexedRows<T> = { rows: T[]; blocks: Map<number, bigint> }

/** A holder's position in a project, as of Bendystraw's indexed block. */
export type IndexedPosition = {
  chainId: number
  projectId: bigint
  holder: Address
  stakedBalance: bigint
  /** In Unix seconds. Null while the holder has no active streak. */
  streakStartedAt: number | null
  /** The longest streak that has ended, in seconds. */
  longestCompletedStreak: number
}

/** One change to a project's hook settings. */
export type IndexedSetting = Placed & (
    | { type: 'granterSet'; granter: Address; caller: Address }
    | { type: 'trustedSenderSet'; holder: Address; sender: Address; trusted: boolean }
    | { type: 'orphanedBalanceExcluded'; amount: bigint; caller: Address }
  )

type Row = Record<string, unknown>
type Options = { chainId?: number; network?: BendystrawNetwork }

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A non-negative integer that came as a JSON number. */
const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null

/** A non-negative integer of any size, which Bendystraw writes as a decimal string. */
function big(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? BigInt(value) : null
}

const account = (value: unknown): Address | null =>
  typeof value === 'string' && isAddress(value, { strict: false }) ? (value.toLowerCase() as Address) : null

const HASH = /^0x[0-9a-fA-F]{64}$/
const hash = (value: unknown): Hex | null => (typeof value === 'string' && HASH.test(value) ? (value as Hex) : null)

function projectNumber(projectId: bigint): number {
  if (projectId < 1n || projectId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${projectId} is not a project ID.`)
  }
  return Number(projectId)
}

function placed(row: Row): Placed | null {
  const chainId = whole(row.chainId)
  const projectId = whole(row.projectId)
  const logIndex = whole(row.logIndex)
  const timestamp = whole(row.timestamp)
  const txHash = hash(row.txHash)
  return chainId === null || projectId === null || logIndex === null || timestamp === null || txHash === null
    ? null
    : { chainId, projectId: BigInt(projectId), txHash, logIndex, timestamp }
}

function payOf(row: Row): IndexedMove | null {
  const at = placed(row)
  const payer = account(row.caller)
  const holder = account(row.beneficiary)
  const amount = big(row.amount)
  const tokens = big(row.newlyIssuedTokenCount)
  return at === null || payer === null || holder === null || amount === null || tokens === null
    ? null
    : { ...at, kind: 'stick', payer, holder, amount, tokens }
}

function cashOutOf(row: Row): IndexedMove | null {
  const at = placed(row)
  const holder = account(row.holder)
  const tokens = big(row.cashOutCount)
  const amount = big(row.reclaimAmount)
  return at === null || holder === null || tokens === null || amount === null
    ? null
    : { ...at, kind: 'unstick', holder, amount, tokens }
}

function feeOf(row: Row): IndexedFee | null {
  const at = placed(row)
  const amount = big(row.amount)
  return at === null || amount === null || typeof row.wasHeld !== 'boolean'
    ? null
    : { ...at, kind: 'fee', amount, wasHeld: row.wasHeld }
}

function additionOf(row: Row): IndexedFee | null {
  const at = placed(row)
  const amount = big(row.amount)
  const returnedFees = big(row.returnedFees)
  return at === null || amount === null || returnedFees === null
    ? null
    : { ...at, kind: 'addition', amount, returnedFees }
}

function eventOf(row: Row): IndexedStickyEvent | null {
  const at = placed(row)
  const holder = account(row.holder)
  if (at === null || holder === null) return null
  const base = { ...at, holder }
  switch (row.type) {
    case 'staked': {
      const payer = account(row.payer)
      const count = big(row.count)
      const stakedBalance = big(row.stakedBalance)
      return payer === null || count === null || stakedBalance === null
        ? null
        : { ...base, type: 'staked', payer, count, stakedBalance }
    }
    case 'unstaked': {
      const count = big(row.count)
      const stakedBalance = big(row.stakedBalance)
      return count === null || stakedBalance === null ? null : { ...base, type: 'unstaked', count, stakedBalance }
    }
    case 'streakStarted':
      return { ...base, type: 'streakStarted' }
    case 'streakEnded': {
      const duration = whole(row.duration)
      return duration === null ? null : { ...base, type: 'streakEnded', duration }
    }
    default:
      return null
  }
}

function positionOf(row: Row): IndexedPosition | null {
  const chainId = whole(row.chainId)
  const projectId = whole(row.projectId)
  const holder = account(row.holder)
  const stakedBalance = big(row.stakedBalance)
  const longestCompletedStreak = whole(row.longestCompletedStreak)
  const streakStartedAt = row.streakStartedAt === null ? null : whole(row.streakStartedAt)
  const streakUnreadable = streakStartedAt === null && row.streakStartedAt !== null
  return chainId === null ||
    projectId === null ||
    holder === null ||
    stakedBalance === null ||
    longestCompletedStreak === null ||
    streakUnreadable
    ? null
    : { chainId, projectId: BigInt(projectId), holder, stakedBalance, streakStartedAt, longestCompletedStreak }
}

// The settings table keeps a granter and a trusted sender in the same `account` column.
function settingOf(row: Row): IndexedSetting | null {
  const at = placed(row)
  if (at === null) return null
  switch (row.type) {
    case 'granterSet': {
      const granter = account(row.account)
      const caller = account(row.caller)
      return granter === null || caller === null ? null : { ...at, type: 'granterSet', granter, caller }
    }
    case 'trustedSenderSet': {
      const holder = account(row.holder)
      const sender = account(row.account)
      return holder === null || sender === null || typeof row.trusted !== 'boolean'
        ? null
        : { ...at, type: 'trustedSenderSet', holder, sender, trusted: row.trusted }
    }
    case 'orphanedBalanceExcluded': {
      const amount = big(row.amount)
      const caller = account(row.caller)
      return amount === null || caller === null ? null : { ...at, type: 'orphanedBalanceExcluded', amount, caller }
    }
    default:
      return null
  }
}

/** What a question asked for. */
type Scope = { chains: ReadonlySet<number>; projects?: ReadonlySet<number>; holder?: Address }

/** The rows of `items` that answer `scope`, parsed. An indexer that ignored a filter would send others, so
 * they are dropped here. A row that is not a record, or that answers the question and is incomplete, rejects
 * the whole read: a list is never quietly shorter than what Bendystraw holds. */
function accept<T>(items: unknown[], scope: Scope, parse: (row: Row) => T | null, what: string): T[] {
  const asked = (row: unknown) =>
    !isRow(row) ||
    (scope.chains.has(Number(row.chainId)) &&
      Number(row.version) === VERSION &&
      (scope.projects === undefined || scope.projects.has(Number(row.projectId))) &&
      (scope.holder === undefined || (typeof row.holder === 'string' && row.holder.toLowerCase() === scope.holder)))
  return items.filter(asked).map(row => {
    const parsed = isRow(row) ? parse(row) : null
    if (parsed === null) throw new Error(`Bendystraw returned an incomplete ${what}.`)
    return parsed
  })
}

const byTime = (a: Placed, b: Placed) => a.timestamp - b.timestamp || a.logIndex - b.logIndex

/** One read's clock. Its signal aborts with the caller's reason when the caller's signal aborts, when
 * READ_TIMEOUT_MS have passed, and when the read ends, so nothing the read started goes on. The transport
 * cancels the request under way when the signal aborts, and retries a BendystrawTimeoutError as a timeout of
 * its own, so time running out aborts with a TimeoutError instead, and `read` turns that into the transport's
 * error for its caller. */
function clock(external: AbortSignal | undefined) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException(`Bendystraw did not answer within ${READ_TIMEOUT_MS} ms.`, 'TimeoutError'))
  }, READ_TIMEOUT_MS)
  const relay = () => controller.abort(external?.reason)
  external?.addEventListener('abort', relay, { once: true })
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    end() {
      clearTimeout(timer)
      external?.removeEventListener('abort', relay)
      controller.abort()
    },
  }
}

async function read<T>(external: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (external?.aborted) throw external.reason
  const { signal, timedOut, end } = clock(external)
  try {
    return await work(signal)
  } catch (error) {
    throw timedOut() ? new BendystrawTimeoutError(READ_TIMEOUT_MS) : error
  } finally {
    end()
  }
}

async function ask(query: string, variables: Row, options: Options, signal: AbortSignal): Promise<Row> {
  const answer = await bendystraw<Row>(query, variables, { ...options, policy: 'live', signal })
  // A transport that answers as it is cancelled must not hand back what the read has given up on.
  if (signal.aborted) throw signal.reason
  return answer
}

type Page = { items: unknown[]; hasNextPage: boolean; endCursor: unknown }

function pageOf(data: Row, field: string): Page {
  const list = data[field]
  if (
    !isRow(list) ||
    !Array.isArray(list.items) ||
    !isRow(list.pageInfo) ||
    typeof list.pageInfo.hasNextPage !== 'boolean'
  ) {
    throw new Error(`Bendystraw returned no ${field}.`)
  }
  return { items: list.items, hasNextPage: list.pageInfo.hasNextPage, endCursor: list.pageInfo.endCursor }
}

/** Every item of one list field, following its cursor, with the first page's whole answer. A list of more than
 * MAX_PAGES pages is an error. */
async function allPages(
  field: string,
  query: string,
  variables: Row,
  options: Options,
  signal: AbortSignal,
): Promise<{ items: unknown[]; first: Row }> {
  const items: unknown[] = []
  let first: Row | undefined
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await ask(query, { ...variables, after }, options, signal)
    first ??= data
    const list = pageOf(data, field)
    items.push(...list.items)
    if (!list.hasNextPage) return { items, first }
    if (typeof list.endCursor !== 'string' || list.endCursor === '') {
      throw new Error(`Bendystraw returned no cursor for more ${field}.`)
    }
    after = list.endCursor
  }
  throw new Error(`Bendystraw has more ${field} than one page load reads.`)
}

/** The first page of a list field, with the whole answer. */
async function firstPage(
  field: string,
  query: string,
  variables: Row,
  options: Options,
  signal: AbortSignal,
): Promise<{ items: unknown[]; first: Row }> {
  const first = await ask(query, { ...variables, after: null }, options, signal)
  return { items: pageOf(first, field).items, first }
}

/** The block each of `wanted` is indexed through, from an answer's `_meta { status }`. A chain the status does
 * not list, or lists without a usable block, is left out. */
function blocksOf(answer: Row, wanted: ReadonlySet<number>): Map<number, bigint> {
  const status = isRow(answer._meta) ? answer._meta.status : undefined
  if (!isRow(status)) throw new Error('Bendystraw returned no indexing status.')
  const blocks = new Map<number, bigint>()
  for (const entry of Object.values(status)) {
    const chainId = isRow(entry) ? whole(entry.id) : null
    const block = isRow(entry) && isRow(entry.block) ? whole(entry.block.number) : null
    if (chainId !== null && block !== null && wanted.has(chainId)) blocks.set(chainId, BigInt(block))
  }
  return blocks
}

/** A list read's rows with the blocks of its answer. Rows of a chain without a block are left out. */
function withBlocks<T>(
  items: unknown[],
  answer: Row,
  scope: Scope,
  parse: (row: Row) => T | null,
  what: string,
  order?: (a: T, b: T) => number,
): IndexedRows<T> {
  const blocks = blocksOf(answer, scope.chains)
  const rows = accept(items, { ...scope, chains: new Set(blocks.keys()) }, parse, what)
  return { rows: order ? rows.sort(order) : rows, blocks }
}

/** The rows of two lists that answer one question, oldest first, with the block each chain is indexed through: the
 * older of the two lists' blocks, since each list comes in an answer of its own. A chain either answer has no status
 * for is absent from `blocks`, and its rows are left out with it. */
function bothAsOf<T extends Placed>(one: IndexedRows<T>, other: IndexedRows<T>): IndexedRows<T> {
  const blocks = new Map<number, bigint>()
  for (const [chain, block] of one.blocks) {
    const theirs = other.blocks.get(chain)
    if (theirs !== undefined) blocks.set(chain, block < theirs ? block : theirs)
  }
  return { rows: [...one.rows, ...other.rows].filter(row => blocks.has(row.chainId)).sort(byTime), blocks }
}

/** The chains of a network that Sticky is deployed on, with each one's deployer. */
function deployersOn(network: BendystrawNetwork): Map<number, string> {
  const deployers = new Map<number, string>()
  for (const chainId of stickyChainIds(network === 'testnet' ? 'testnet' : 'production')) {
    const deployment = stickyDeployment(chainId)
    if (deployment) deployers.set(chainId, deployment.deployer.toLowerCase())
  }
  return deployers
}

/** The Sticky projects of the chains an index covers, and the block each of those chains is indexed through. A
 * chain absent from `blocks` is not covered, and lists no projects. */
export type IndexedProjects = { blocks: Map<number, bigint>; projects: { chainId: number; projectId: bigint }[] }

async function readIndex(network: BendystrawNetwork, external: AbortSignal | undefined): Promise<IndexedProjects> {
  const deployers = deployersOn(network)
  if (!deployers.size) return { blocks: new Map(), projects: [] }
  return read(external, async signal => {
    const owners = [...new Set(deployers.values())]
    const { items, first } = await allPages('projects', INDEX_QUERY, { owners }, { network }, signal)

    // A chain the status does not list is left out of `blocks`, so a caller can tell it from a chain with no projects.
    const blocks = blocksOf(first, new Set(deployers.keys()))
    const projects: IndexedProjects['projects'] = []
    for (const row of items) {
      if (!isRow(row)) throw new Error('Bendystraw returned an incomplete Sticky project.')
      const chainId = Number(row.chainId)
      const mine =
        blocks.has(chainId) &&
        Number(row.version) === VERSION &&
        String(row.owner).toLowerCase() === deployers.get(chainId)
      if (!mine) continue
      const projectId = whole(row.projectId)
      if (projectId === null || projectId === 0) throw new Error('Bendystraw returned an incomplete Sticky project.')
      projects.push({ chainId, projectId: BigInt(projectId) })
    }
    projects.sort((a, b) => a.chainId - b.chainId || Number(a.projectId - b.projectId))
    return { blocks, projects }
  })
}

/**
 * The Sticky projects of a network, with the block each covered chain is indexed through. A chain the index has
 * no status for is absent from `blocks` and lists no projects here: the caller reads it from its deployment
 * block. With no covered chain at all this rejects, since there is nothing indexed to list.
 */
export async function indexedStickyProjects(network: BendystrawNetwork, signal?: AbortSignal): Promise<IndexedProjects> {
  const index = await readIndex(network, signal)
  if (!index.blocks.size) throw new Error("Bendystraw has no status for any of Sticky's chains.")
  return index
}

/** The block each of Sticky's chains is indexed through. A chain the index has no usable status for is left
 * out. It is a read of its own: a caller that also lists projects takes `blocks` from `indexedStickyProjects`. */
export async function indexedBlocks(network: BendystrawNetwork, signal?: AbortSignal): Promise<Map<number, bigint>> {
  return (await readIndex(network, signal)).blocks
}

/** A time in Unix seconds, as `timestamp_gte` takes it. */
function unixTime(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new RangeError(`${seconds} is not a time in Unix seconds.`)
  return seconds
}

/**
 * The sticks (pays) and unsticks (cash outs) of some of a chain's projects, oldest first, with the block the chain is
 * indexed through: the older of the two lists' blocks, since each list comes in an answer of its own. A chain either
 * answer has no status for is absent from `blocks`, and its moves are left out with it. `since`, in Unix seconds, asks
 * only for those at or after it, so a feed that shows a project's newest events does not read every older one. It goes
 * in the filter each document takes as a variable: the documents themselves do not change. A move from before it that
 * an indexer sends anyway is dropped, like a row of another project.
 */
export async function indexedStickyMoves(
  chainId: number,
  projectIds: readonly bigint[],
  signal?: AbortSignal,
  since?: number,
): Promise<IndexedRows<IndexedMove>> {
  const from = since === undefined ? 0 : unixTime(since)
  const time = since === undefined ? {} : { timestamp_gte: from }
  const ids = [...new Set(projectIds.map(projectNumber))]
  if (!ids.length) return { rows: [], blocks: new Map() }
  const scope = { chains: new Set([chainId]), projects: new Set(ids) }
  // One chain per filter: an independent projectId_in with chainId_in would match every chain's project of that ID.
  const variables = { where: { chainId, version: VERSION, projectId_in: ids, ...time } }
  return read(signal, async within => {
    const [pays, cashOuts] = await Promise.all([
      allPages('payEvents', PAY_QUERY, variables, { chainId }, within),
      allPages('cashOutTokensEvents', CASH_OUT_QUERY, variables, { chainId }, within),
    ])
    const { rows, blocks } = bothAsOf(
      withBlocks(pays.items, pays.first, scope, payOf, 'Sticky event'),
      withBlocks(cashOuts.items, cashOuts.first, scope, cashOutOf, 'Sticky event'),
    )
    return { rows: rows.filter(move => move.timestamp >= from), blocks }
  })
}

/**
 * A project's processed fees and additions to its balance on one chain, oldest first, with the block the chain is
 * indexed through: the older of the two lists' blocks, since each list comes in an answer of its own. A chain either
 * answer has no status for is absent from `blocks`, and its rows are left out with it.
 */
export async function indexedStickyFees(
  chainId: number,
  projectId: bigint,
  signal?: AbortSignal,
): Promise<IndexedRows<IndexedFee>> {
  const id = projectNumber(projectId)
  const scope = { chains: new Set([chainId]), projects: new Set([id]) }
  const variables = { where: { chainId, projectId: id, version: VERSION } }
  return read(signal, async within => {
    const [fees, additions] = await Promise.all([
      allPages('processFeeEvents', FEE_QUERY, variables, { chainId }, within),
      allPages('addToBalanceEvents', ADDITION_QUERY, variables, { chainId }, within),
    ])
    return bothAsOf(
      withBlocks(fees.items, fees.first, scope, feeOf, 'fee'),
      withBlocks(additions.items, additions.first, scope, additionOf, 'addition to a balance'),
    )
  })
}

/** The transaction that created a project, or null when Bendystraw has none or more than one. The creation
 * block is the block of that transaction's receipt. */
export async function indexedStickyCreateTx(
  chainId: number,
  projectId: bigint,
  signal?: AbortSignal,
): Promise<Hex | null> {
  const where = { chainId, projectId: projectNumber(projectId), version: VERSION }
  return read(signal, async within => {
    const list = (await ask(CREATE_QUERY, { where }, { chainId }, within)).projectCreateEvents
    if (!isRow(list) || !Array.isArray(list.items)) throw new Error('Bendystraw returned no project creation.')
    const [only] = list.items
    return list.items.length === 1 && isRow(only) ? hash(only.txHash) : null
  })
}

/** What a list of events or positions is about: one chain or several, and optionally one project on one chain
 * and one holder. */
type Question = { chainId?: number; chainIds?: readonly number[]; projectId?: bigint; holder?: Address }

function asking(q: Question) {
  if ((q.chainId === undefined) === (q.chainIds === undefined)) {
    throw new TypeError('Ask about one chain (chainId) or several (chainIds).')
  }
  if (q.projectId !== undefined && q.chainId === undefined) {
    throw new TypeError('A project belongs to one chain: give its chainId, not chainIds.')
  }
  const holder = q.holder === undefined ? undefined : account(q.holder)
  if (holder === null) throw new TypeError(`${q.holder} is not an address.`)
  const projectId = q.projectId === undefined ? undefined : projectNumber(q.projectId)
  const chains = new Set(q.chainId === undefined ? q.chainIds : [q.chainId])
  const where = {
    version: VERSION,
    ...(q.chainId === undefined ? { chainId_in: [...chains] } : { chainId: q.chainId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(holder === undefined ? {} : { holder }),
  }
  const scope: Scope = {
    chains,
    ...(projectId === undefined ? {} : { projects: new Set([projectId]) }),
    ...(holder === undefined ? {} : { holder }),
  }
  const options: Options = q.chainId === undefined ? {} : { chainId: q.chainId }
  return { where, scope, options }
}

/**
 * The hook's events for a question, oldest first, with the blocks of the chains asked about. `newest` asks for
 * only that many of the newest, in one request, for a feed. Rows carry no block number of their own: the table
 * has no such column.
 */
export async function indexedStickyEvents(
  q: Question & { newest?: number },
  signal?: AbortSignal,
): Promise<IndexedRows<IndexedStickyEvent>> {
  const { newest } = q
  if (newest !== undefined && !(Number.isInteger(newest) && newest >= 1 && newest <= PAGE_SIZE)) {
    throw new RangeError(`Ask for between 1 and ${PAGE_SIZE} events, not ${newest}.`)
  }
  const { where, scope, options } = asking(q)
  if (!scope.chains.size) return { rows: [], blocks: new Map() }
  return read(signal, async within => {
    const variables = { where, orderDirection: newest === undefined ? 'asc' : 'desc', limit: newest ?? PAGE_SIZE }
    const { items, first } =
      newest === undefined
        ? await allPages('stickyEvents', EVENTS_QUERY, variables, options, within)
        : await firstPage('stickyEvents', EVENTS_QUERY, variables, options, within)
    return withBlocks(items, first, scope, eventOf, 'Sticky event', byTime)
  })
}

/** The positions a question names, in the order Bendystraw created them, with the blocks of the chains asked about. */
export async function indexedStickyPositions(
  q: Question,
  signal?: AbortSignal,
): Promise<IndexedRows<IndexedPosition>> {
  const { where, scope, options } = asking(q)
  if (!scope.chains.size) return { rows: [], blocks: new Map() }
  return read(signal, async within => {
    const { items, first } = await allPages('stickyPositions', POSITIONS_QUERY, { where }, options, within)
    return withBlocks(items, first, scope, positionOf, 'Sticky position')
  })
}

/** A project's granters, trusted senders and orphaned-balance exclusions, oldest first, with the block of its chain. */
export async function indexedStickySettings(
  chainId: number,
  projectId: bigint,
  signal?: AbortSignal,
): Promise<IndexedRows<IndexedSetting>> {
  const id = projectNumber(projectId)
  const scope = { chains: new Set([chainId]), projects: new Set([id]) }
  return read(signal, async within => {
    const where = { chainId, projectId: id, version: VERSION }
    const { items, first } = await allPages('stickySettingEvents', SETTINGS_QUERY, { where }, { chainId }, within)
    return withBlocks(items, first, scope, settingOf, 'Sticky setting', byTime)
  })
}
