/**
 * A multichain launch's copies, for the Overview's Chains card: the project on each chain of the page's environment
 * that shares the page's launch id, stickiness bonus and transfer mode, on a chain the launch planned, with each one's
 * backing and supply and what they add up to. A launch gets a different project ID on each chain, but every copy's uri
 * carries the same launch id; Bendystraw's project list and a scan of each chain's deployer name the candidates, and
 * the chain decides.
 *
 * Chains are read one after another: Center has one rate limit for all of them.
 */

import type { BendystrawNetwork } from '@bananapus/nana-sdk-core'
import { untilAborted } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { SUPPORTED_CHAINS, environmentForChainIds } from '@/lib/chains'
import { controllerAbi } from '@/lib/sticky-abis'
import { deploymentOn, stickyChainIds } from '@/lib/sticky-addresses'
import { orNull, scanToHead, stickyProjectsOn, type StickyReadDeps } from '@/lib/sticky-events'
import { indexedStickyProjects, type IndexedProjects } from '@/lib/sticky-indexed'
import { launchIdIn, readStickyProject, type StickyProjectInfo } from '@/lib/sticky-project'

/** What makes two chains' projects one launch. */
export type LaunchFacts = Pick<
  StickyProjectInfo,
  'chainId' | 'projectId' | 'launchId' | 'cashOutTaxRate' | 'soulbound' | 'plannedChains'
>

/** One chain's project of the launch: the page's own (`self`), or its copy on another chain. */
export type Sibling = { chainId: number; projectId: bigint; self: boolean }

/** A chain that could not be searched for the launch, or whose copy's figures could not be read. */
export type ChainFailure = { chainId: number; error: unknown }

/** A row of the Chains card: a copy with its figures, one whose figures could not be read, or a chain that could not
 * be searched. */
export type SiblingRow = (Sibling & { info: StickyProjectInfo }) | (Sibling & ChainFailure) | ChainFailure

/** What a row's totals are made of. */
type Figures = Pick<StickyProjectInfo, 'backing' | 'totalSupply' | 'symbol' | 'decimals'>

export type SiblingTotals = {
  /** The Sticky shares of every row that could be read. */
  supply: bigint
  /** Their backing, or null when the rows are backed by different tokens and cannot be added up. */
  backing: bigint | null
  /** The staked token's units of the first row that could be read. */
  decimals: number | undefined
  symbol: string | undefined
  /** False when a row could not be read, so the totals cover only the chains shown with figures. */
  complete: boolean
}

type Cancel = { signal?: AbortSignal }

/** Every read this module makes, so a test can stand in for Bendystraw and Center. */
export type SiblingReadDeps = {
  indexedProjects: typeof indexedStickyProjects
  /** A chain's deployer logs through the head, for its launches past what Bendystraw lists. */
  scan: StickyReadDeps['scan']
  /** The launch id each project's uri carries, or null for one that carries none. */
  launchIds: (chainId: number, projectIds: readonly bigint[], opts: Cancel) => Promise<(string | null)[]>
  /** A project's figures, read at one block. */
  read: (chainId: number, projectId: bigint, opts: Cancel) => Promise<StickyProjectInfo>
}

/** A caller's signal, which every read gets, and in tests the reads to use instead of the real ones. */
export type SiblingReadOptions = Cancel & Partial<SiblingReadDeps>

const INDEX_UNAVAILABLE = 'Bendystraw could not list the Sticky launches; reading the chains instead.'

/** What a launch's copies share, as one key: its launch id, stickiness bonus and transfer mode. A project whose uri
 * carries no launch id has none, and no copies. */
export function launchKey({
  launchId,
  cashOutTaxRate,
  soulbound,
}: Pick<LaunchFacts, 'launchId' | 'cashOutTaxRate' | 'soulbound'>): string | null {
  return launchId === null ? null : `${launchId}:${cashOutTaxRate}:${soulbound}`
}

/** Whether `chainId` is on a plan of chains, which a uri may not list: with none, every chain is. */
const onPlan = (plannedChains: number[] | null, chainId: number) =>
  plannedChains === null || plannedChains.includes(chainId)

/**
 * Whether `candidate`, a project of another chain, is `info`'s launch there: it shares the launch key, its chain is one
 * the page's uri planned, and its own uri plans its own chain (the rule of the home's grouping, `groupHomeCards`). A
 * launch writes one uri on every chain, so a project whose uri copies a launch's onto a chain the launch did not plan
 * cannot join it, and neither can one whose copy adds its own chain to the plan.
 */
function isCopyOf(info: LaunchFacts, candidate: LaunchFacts): boolean {
  return (
    launchKey(candidate) === launchKey(info) &&
    onPlan(info.plannedChains, candidate.chainId) &&
    onPlan(candidate.plannedChains, candidate.chainId)
  )
}

/**
 * The page's project first, then for each other chain among `candidates` the first project (the lowest ID) that is a
 * copy of its launch (`isCopyOf`), in the order the chains first appear. First, so a later copy of the uri cannot
 * displace the real sibling.
 */
export function siblingProjects(info: LaunchFacts, candidates: readonly LaunchFacts[]): Sibling[] {
  const self: Sibling = { chainId: info.chainId, projectId: info.projectId, self: true }
  if (launchKey(info) === null) return [self]
  const first = new Map<number, Sibling>()
  for (const candidate of candidates) {
    if (candidate.chainId === info.chainId || !isCopyOf(info, candidate)) continue
    const known = first.get(candidate.chainId)
    if (!known || candidate.projectId < known.projectId) {
      first.set(candidate.chainId, { chainId: candidate.chainId, projectId: candidate.projectId, self: false })
    }
  }
  return [self, ...first.values()]
}

/** The copies of the launch on one chain, read in the order they launched until one is a copy of the launch
 * (`isCopyOf`). The launch ids of all of the chain's projects are read together, and only the projects that carry this
 * launch's are read in full. */
async function candidatesOn(
  chainId: number,
  info: LaunchFacts,
  index: IndexedProjects | null,
  deps: SiblingReadDeps,
  signal: AbortSignal | undefined,
): Promise<LaunchFacts[]> {
  const { projects } = await stickyProjectsOn(chainId, index, { signal, scan: deps.scan })
  const ids = projects.map(project => project.projectId)
  const launchIds = await deps.launchIds(chainId, ids, { signal })
  const candidates: LaunchFacts[] = []
  for (const [at, projectId] of ids.entries()) {
    if (launchIds[at] !== info.launchId) continue
    const candidate = await deps.read(chainId, projectId, { signal })
    candidates.push(candidate)
    if (isCopyOf(info, candidate)) break
  }
  return candidates
}

/**
 * The page's project and its copies on the other chains of its environment, where Sticky is deployed, each chain
 * searched one after another. Bendystraw lists each chain's launches, and a scan of the chain's deployer from just
 * below its indexed block adds the newer ones; when Bendystraw cannot list them, each chain's deployer is scanned from
 * its first block. A chain that cannot be searched is a failure in its place, and the others are still searched. A
 * project whose uri carries no launch id, or plans chains that do not include its own, has no copies, and nothing is
 * read. When the page's uri lists the chains the launch planned, only those are searched.
 */
export async function launchSiblings(
  info: LaunchFacts,
  options: SiblingReadOptions = {},
): Promise<(Sibling | ChainFailure)[]> {
  const { signal, ...given } = options
  const deps: SiblingReadDeps = { ...live, ...given }
  const self: Sibling = { chainId: info.chainId, projectId: info.projectId, self: true }
  if (launchKey(info) === null || !onPlan(info.plannedChains, info.chainId)) return [self]
  const environment = environmentForChainIds([info.chainId])
  const others = stickyChainIds(environment).filter(
    chainId => chainId !== info.chainId && onPlan(info.plannedChains, chainId),
  )
  if (!others.length) return [self]

  const network: BendystrawNetwork = environment === 'testnet' ? 'testnet' : 'mainnet'
  const index = await orNull(() => deps.indexedProjects(network, signal), signal, INDEX_UNAVAILABLE, { network })
  const candidates: LaunchFacts[] = []
  const failures: ChainFailure[] = []
  for (const chainId of others) {
    if (signal?.aborted) throw signal.reason
    try {
      candidates.push(...(await candidatesOn(chainId, info, index, deps, signal)))
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      failures.push({ chainId, error })
    }
  }
  const [, ...found] = siblingProjects(info, candidates)
  const place = (row: { chainId: number }) => others.indexOf(row.chainId)
  return [self, ...[...found, ...failures].sort((a, b) => place(a) - place(b))]
}

/**
 * The Chains card's rows: each copy with its figures, the page's own included, read one chain after another, and each
 * chain `launchSiblings` could not search, as it was. A copy whose figures cannot be read is a failure in its place.
 */
export async function siblingRows(
  siblings: readonly (Sibling | ChainFailure)[],
  { signal, read = live.read }: Cancel & { read?: SiblingReadDeps['read'] } = {},
): Promise<SiblingRow[]> {
  const rows: SiblingRow[] = []
  for (const sibling of siblings) {
    if (signal?.aborted) throw signal.reason
    if ('error' in sibling) {
      rows.push(sibling)
      continue
    }
    try {
      rows.push({ ...sibling, info: await read(sibling.chainId, sibling.projectId, { signal }) })
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      rows.push({ ...sibling, error })
    }
  }
  return rows
}

/** Every row's Sticky shares added up, and their backing when every row with figures is backed by the same token (the
 * same symbol and decimals; the tokens are on different chains, so their addresses differ). */
export function siblingTotals(rows: readonly ({ info: Figures } | ChainFailure)[]): SiblingTotals {
  const read = rows.flatMap(row => ('info' in row ? [row.info] : []))
  const [first] = read
  const sameToken = (info: Figures) => info.symbol === first.symbol && info.decimals === first.decimals
  const same = first !== undefined && read.every(sameToken)
  return {
    supply: read.reduce((sum, info) => sum + info.totalSupply, 0n),
    backing: same ? read.reduce((sum, info) => sum + info.backing, 0n) : null,
    decimals: first?.decimals,
    symbol: first?.symbol,
    complete: read.length === rows.length,
  }
}

/** The chains the page's launch was planned on (its uri's `chains`), in the page chain's environment, that no row
 * stands for: the card's "Planned at launch. Not deployed yet." rows. A launch whose uri lists none has none. */
export function missingChains(
  { chainId, plannedChains }: Pick<StickyProjectInfo, 'chainId' | 'plannedChains'>,
  rows: readonly { chainId: number }[],
): number[] {
  const environment = environmentForChainIds([chainId])
  const supported = (id: number) => SUPPORTED_CHAINS.some(chain => chain.id === id)
  return (plannedChains ?? []).filter(
    id => supported(id) && environmentForChainIds([id]) === environment && !rows.some(row => row.chainId === id),
  )
}

const live: SiblingReadDeps = {
  indexedProjects: indexedStickyProjects,
  scan: scanToHead,
  async launchIds(chainId, projectIds, { signal }) {
    if (!projectIds.length) return []
    const deployment = deploymentOn(chainId)
    const uris = await untilAborted(
      jbCenterPublicClient(chainId, signal).multicall({
        contracts: projectIds.map(
          projectId =>
            ({ address: deployment.controller, abi: controllerAbi, functionName: 'uriOf', args: [projectId] }) as const,
        ),
        allowFailure: false,
      }),
      signal,
    )
    return uris.map(launchIdIn)
  },
  // A copy's figures clamp an orphaned balance the hook recorded above what the terminal holds to no backing, where
  // the page's own read fails (webclient/app.js chainBacking and poolBacking): one bad copy must not break the page.
  read: (chainId, projectId, { signal }) =>
    untilAborted(readStickyProject(chainId, projectId, { orphans: 'clamp' }), signal),
}
