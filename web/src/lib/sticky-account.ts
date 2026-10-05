/**
 * An account's page: the positions it holds in the Sticky projects of a network, and its newest activity there.
 *
 * Bendystraw's positions say where the account holds shares, and each position listed is read again from StickyHook,
 * where the balance and the streak really are. A listing is as of the block Bendystraw is indexed through, so the
 * account's position events in StickyHook from just below that block to the head add the projects it does not have
 * yet. When Bendystraw cannot list the positions, or has no status for a chain, every Sticky project of that chain is
 * asked instead, and a project the account holds nothing in is left out. A project that cannot be read is left out
 * and counted: it is never an account that holds nothing.
 *
 * A chain is read on its own, so that one that cannot be read fails alone. Its caller reads the chains one after
 * another: Center has one rate limit for all of them.
 *
 * Every read that gives up on one source for another tells the console, under a label that stays the same.
 */

import type { BendystrawNetwork } from '@bananapus/nana-sdk-core'
import { pad, type Address, type ContractFunctionParameters } from 'viem'
import { chainsForEnvironment } from '@/lib/chains'
import { untilAborted } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { stickyHookAbi } from '@/lib/sticky-abis'
import { stickyChainIds, stickyDeployment, type StickyDeployment } from '@/lib/sticky-addresses'
import {
  POSITION_TOPICS,
  PROJECTS_UNAVAILABLE,
  decodeHookLog,
  orNull,
  scanFrom,
  scanToHead,
  stickyHolderEvents,
  stickyProjectsOn,
  type StickyReadDeps,
} from '@/lib/sticky-events'
import { FEED_WINDOW, feedRows, terminalMoves, type FeedRow } from '@/lib/sticky-feed'
import { stickyLabel } from '@/lib/sticky-format'
import {
  indexedStickyPositions,
  indexedStickyProjects,
  type IndexedPosition,
  type IndexedProjects,
  type IndexedRows,
} from '@/lib/sticky-indexed'
import { readStickyProjects, type OrphanedPolicy, type StickyProjectInfo } from '@/lib/sticky-project'

/** An account's position in one Sticky project, as the chain reads it now. */
export type AccountPosition = {
  info: StickyProjectInfo
  /** Their Sticky shares, with 18 decimals. */
  staked: bigint
  /** When their active streak started, in Unix seconds, or 0 when they have none. */
  start: number
  /** Their longest streak, in seconds, as StickyHook says. */
  longest: number
}

/** One chain's positions of the account, and how many of the projects it holds shares in could not be read. */
export type AccountChain = { chainId: number; positions: AccountPosition[]; skipped: number }

/** One chain's newest activity of the account, newest first, and what each row's project is called by its ID. */
export type AccountActivityChain = { chainId: number; rows: FeedRow[]; labels: Record<string, string> }

/** What Bendystraw says of an account across a network: its positions, and the network's projects for a chain whose
 * positions it cannot list. Each is null when Bendystraw cannot say. */
export type AccountIndex = { positions: IndexedRows<IndexedPosition> | null; projects: IndexedProjects | null }

/** What Bendystraw lists of the account on a chain: the projects it holds positions in, and the block the listing is
 * indexed through. */
type ListedPositions = { projects: bigint[]; through: bigint }

type Cancel = { signal?: AbortSignal }

/** An account's shares and streaks in one project, as StickyHook says. */
type Holding = { projectId: bigint; staked: bigint; start: number; longest: number }

/** Every read `accountPositions` makes of a project, so a test can stand in for Center. */
export type PositionReadDeps = {
  /** The figures of the projects that can be read, read together at one block. */
  readProjects: (
    chainId: number,
    projectIds: readonly bigint[],
    opts: Cancel & { orphans?: OrphanedPolicy },
  ) => Promise<StickyProjectInfo[]>
  /** StickyHook's logs through the head, each with its block's time. */
  scan: StickyReadDeps['scan']
}

/** A caller's signal, which every read gets, and in tests the reads to use instead of the real ones. */
export type PositionReadOptions = Cancel & Partial<PositionReadDeps>

/** Every read `accountActivity` makes, so a test can stand in for Bendystraw and Center. */
export type ActivityReadDeps = PositionReadDeps & {
  holderEvents: typeof stickyHolderEvents
  terminalMoves: typeof terminalMoves
}

export type ActivityReadOptions = Cancel &
  Partial<ActivityReadDeps> & {
    /** The projects Bendystraw lists positions of the account in on the chain, for `stickyHolderEvents`. */
    projects?: readonly bigint[]
  }

const POSITIONS_UNAVAILABLE = "Bendystraw could not list the account's Sticky positions; reading every Sticky project instead."

/** How many projects one request asks StickyHook about: three calls each, about as many calls as a request of the
 * project reads carries. */
const HOLDINGS_PER_REQUEST = 80

function deploymentOn(chainId: number): StickyDeployment {
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  return deployment
}

/** The Sticky chains of a network, in the site's order of chains: Ethereum, Optimism, Base and Arbitrum. */
export function accountChains(network: BendystrawNetwork): number[] {
  const environment = network === 'testnet' ? 'testnet' : 'production'
  const deployed = stickyChainIds(environment)
  return chainsForEnvironment(environment)
    .map(chain => chain.id as number)
    .filter(chainId => deployed.includes(chainId))
}

/**
 * What Bendystraw says of the account across the network's Sticky chains: the positions it lists, and, when they do
 * not cover every chain, the network's projects, so that a chain that must be asked about every project is not
 * scanned from its deployer's first block. A read that fails is null, and the console hears why.
 */
export async function accountIndex(
  network: BendystrawNetwork,
  holder: Address,
  {
    signal,
    indexedPositions = indexedStickyPositions,
    indexedProjects = indexedStickyProjects,
  }: Cancel & { indexedPositions?: typeof indexedStickyPositions; indexedProjects?: typeof indexedStickyProjects } = {},
): Promise<AccountIndex> {
  const chainIds = accountChains(network)
  const positions = await orNull(
    () => indexedPositions({ holder, chainIds }, signal),
    signal,
    POSITIONS_UNAVAILABLE,
    { network },
  )
  const covered = positions !== null && chainIds.every(chainId => positions.blocks.has(chainId))
  const projects = covered
    ? null
    : await orNull(() => indexedProjects(network, signal), signal, PROJECTS_UNAVAILABLE, { network })
  return { positions, projects }
}

/** What Bendystraw lists of the account's positions on a chain, or null when it does not cover the chain. */
export function listedPositions({ positions }: AccountIndex, chainId: number): ListedPositions | null {
  const through = positions?.blocks.get(chainId)
  if (!positions || through === undefined) return null
  return { projects: positions.rows.filter(row => row.chainId === chainId).map(row => row.projectId), through }
}

/** Every Sticky project of a chain: the ones Bendystraw lists, and the ones the deployer's launches show past them. */
export async function deployedProjects(
  chainId: number,
  { projects }: AccountIndex,
  { signal, projectsOn = stickyProjectsOn }: Cancel & { projectsOn?: typeof stickyProjectsOn } = {},
): Promise<bigint[]> {
  const found = await projectsOn(chainId, projects, { signal })
  return found.projects.map(project => project.projectId)
}

/** What the account holds in each of `projectIds`, from StickyHook, for the projects it holds shares in or has had a
 * streak in. The hook is Sticky's own contract, so no project can make this read fail. */
async function holdingsIn(
  chainId: number,
  holder: Address,
  projectIds: readonly bigint[],
  signal: AbortSignal | undefined,
): Promise<Holding[]> {
  const { hook } = deploymentOn(chainId)
  const client = jbCenterPublicClient(chainId)
  const held: Holding[] = []
  for (let at = 0; at < projectIds.length; at += HOLDINGS_PER_REQUEST) {
    if (signal?.aborted) throw signal.reason
    const some = projectIds.slice(at, at + HOLDINGS_PER_REQUEST)
    // One request: the projects are already counted out, so viem is told not to split it.
    const answers = (await untilAborted(
      client.multicall({
        contracts: some.flatMap((projectId): ContractFunctionParameters[] =>
          (['stakedBalanceOf', 'streakStartOf', 'longestStreakOf'] as const).map(functionName => ({
            address: hook,
            abi: stickyHookAbi,
            functionName,
            args: [projectId, holder],
          })),
        ),
        allowFailure: false,
        batchSize: 0,
      }),
      signal,
    )) as bigint[]
    some.forEach((projectId, index) => {
      const [staked, start, longest] = answers.slice(index * 3, index * 3 + 3)
      if (staked > 0n || longest > 0n) held.push({ projectId, staked, start: Number(start), longest: Number(longest) })
    })
  }
  return held
}

const live: ActivityReadDeps = {
  readProjects: (chainId, projectIds, { signal, orphans }) => readStickyProjects(chainId, projectIds, { signal, orphans }),
  scan: scanToHead,
  holderEvents: stickyHolderEvents,
  terminalMoves,
}

/** The projects the account's hook events show from just below `through`, the block a listing is indexed through, to the
 * head: what the listing does not have yet. */
async function projectsPast(
  deps: PositionReadDeps,
  chainId: number,
  holder: Address,
  through: bigint,
  signal: AbortSignal | undefined,
): Promise<bigint[]> {
  const deployment = deploymentOn(chainId)
  const who = holder.toLowerCase() as Address
  const filter = { address: deployment.hook, topics: [POSITION_TOPICS, null, pad(who)], fromBlock: scanFrom(through, deployment) }
  const logs = await deps.scan(chainId, filter, { signal })
  return logs
    .flatMap(log => decodeHookLog(log, chainId) ?? [])
    .filter(event => event.holder === who)
    .map(event => event.projectId)
}

const byProjectId = (a: { projectId: bigint }, b: { projectId: bigint }) =>
  a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0

/**
 * The account's positions among `projectIds` on a chain: the balance and streak of each are read from StickyHook, and
 * the figures of the projects held are read together at one block, so that one whose token cannot be read is left out
 * and counted in `skipped` while the others still show. A project the account holds nothing in makes no position.
 *
 * `projectIds` that are Bendystraw's listing come with `through`, the block it is indexed through: the projects the
 * account's position events show from just below that block to the head are asked about too. A scan that fails rejects,
 * since a list without them would be shorter than the chain's.
 */
export async function accountPositions(
  chainId: number,
  holder: Address,
  projectIds: readonly bigint[],
  options: PositionReadOptions & { through?: bigint } = {},
): Promise<AccountChain> {
  const { signal, through, ...given } = options
  const deps: PositionReadDeps = { ...live, ...given }
  const past = through === undefined ? [] : await projectsPast(deps, chainId, holder, through, signal)
  const held = (await holdingsIn(chainId, holder, [...new Set([...projectIds, ...past])], signal)).sort(byProjectId)
  if (!held.length) return { chainId, positions: [], skipped: 0 }

  // Read strictly: a project whose accounting does not hold together is left out and counted, not shown with a wrong
  // figure.
  const infos = await deps.readProjects(
    chainId,
    held.map(({ projectId }) => projectId),
    { signal },
  )
  const byId = new Map(infos.map(info => [info.projectId, info]))
  const positions = held.flatMap(({ projectId, ...holding }) => {
    const info = byId.get(projectId)
    return info ? [{ info, ...holding }] : []
  })
  return { chainId, positions, skipped: held.length - positions.length }
}

/**
 * The account's newest activity on a chain, as the Latest list shows it: the newest FEED_WINDOW of its sticks,
 * unsticks and streaks in every Sticky project of the chain, in rows of one transaction and project each, newest first
 * (`feedRows`). What a row moved is what the terminal took in or paid out, when it can be read. A project that cannot be
 * read has no rows, and the console hears which.
 */
export async function accountActivity(
  chainId: number,
  holder: Address,
  options: ActivityReadOptions = {},
): Promise<AccountActivityChain> {
  const { signal, projects, ...given } = options
  const deps: ActivityReadDeps = { ...live, ...given }
  const deployment = deploymentOn(chainId)
  const { events } = await deps.holderEvents(chainId, holder, { signal, projects })
  const window = events.slice(-FEED_WINDOW)
  if (!window.length) return { chainId, rows: [], labels: {} }

  // Only names, symbols and decimals are needed of these projects, which even a project whose accounting does not
  // hold together has.
  const infos = await deps.readProjects(chainId, [...new Set(window.map(event => event.projectId))], {
    signal,
    orphans: 'clamp',
  })
  const byId = new Map(infos.map(info => [info.projectId, info]))
  const moves = await deps.terminalMoves(window, { signal })
  const rows = feedRows(window, moves, {
    adapter: deployment.autoStick,
    tokens: (eventChainId, projectId) => (eventChainId === chainId ? byId.get(projectId) : undefined),
  })
  return { chainId, rows, labels: Object.fromEntries(infos.map(info => [String(info.projectId), stickyLabel(info)])) }
}
