'use client'

import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import {
  eventsOptions,
  holdersOptions,
  infoOptions,
  latestOptions,
  useStickyEvents,
  useStickyProject,
} from '@/hooks/useStickyProject'
import { untilAborted } from '@/lib/hook-logs'
import { inTurn } from '@/lib/in-turn'
import { PERSIST } from '@/lib/query-persist'
import {
  backingFlows,
  backingSeries,
  orphanExclusions,
  supplyPoints,
  type BackingSeries,
  type Flow,
} from '@/lib/sticky-backing'
import { projectCreationBlock } from '@/lib/sticky-events'
import { launchSiblings, missingChains, siblingRows, type SiblingRow } from '@/lib/sticky-siblings'

/**
 * A Sticky project's Overview tab: the chart's series and the chains of its launch. The keys start with the chain and
 * project, as the rest of the project page's, so a page for another project never shows this one's answers. The chains
 * are public and small, and the browser keeps them. What the chart is drawn from grows with the project's history, so
 * it stays in memory, as the history does (`useStickyProject`).
 *
 * The page runs its scans one after another (`inTurn`), first come first served, and a project's balance history
 * can take many requests to read. So the reads here wait their turn behind what the rest of the page shows first: the
 * history, then the header's holders and Latest, then the balance flows, then the search for the copies on the other
 * chains.
 */

/** How long a read stays fresh: the reads that others build on are shared for this long. */
const FRESH_MS = 30_000

/** The version of what the browser keeps of the chains, in the key. Change it whenever `SiblingRow` or
 * `StickyProjectInfo` changes shape, or a page renders a kept copy in an older shape until it is read again. */
const SIBLINGS_VERSION = 'v1'

const FLOWS_UNREADABLE = "Could not read a Sticky project's balance history; charting its Sticky supply instead."
const CHART_UNDRAWABLE = "Could not draw a Sticky project's chart from its history; it offers to try again."
const SIBLINGS_UNREADABLE = "Could not read a Sticky project's chains; its Chains card offers to try again."
const CHAIN_UNREADABLE = "Could not read one of a Sticky launch's chains; its Chains card says so."

/** `options` with data that is good however old it is: a read that a later one only needs to have happened. */
const whenever = <T extends object>(options: T) => ({ ...options, staleTime: Infinity })

/** Why a chain could not be read, as the text the browser keeps: the card only says that it could not, and an error
 * is not kept as it stands, for it may be too large or not serialize at all. */
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200)

/** What the terminal's balance did over a project's life, or null when it cannot be read, which the chart says. */
const flowsOptions = (client: QueryClient, chainId: number, projectId: number) =>
  queryOptions<Flow[] | null>({
    queryKey: ['sticky-project', chainId, projectId, 'flows'],
    queryFn: async ({ signal }) => {
      // The history is read first: its scan is the page's first, and it finds the project's creation block. Then the
      // header's holders and Latest, which have failures of their own to report: this scan can be long, and they are
      // not to wait for it. None of them is read again for this one.
      await untilAborted(client.fetchQuery(whenever(eventsOptions(client, chainId, projectId))), signal)
      await untilAborted(
        Promise.allSettled([
          client.fetchQuery(whenever(holdersOptions(client, chainId, projectId))),
          client.fetchQuery(whenever(latestOptions(client, chainId, projectId))),
        ]),
        signal,
      )
      return inTurn(client, signal, async () => {
        try {
          const fromBlock = await projectCreationBlock(chainId, BigInt(projectId), { signal })
          return await backingFlows(chainId, BigInt(projectId), fromBlock, { signal })
        } catch (error) {
          if (signal.aborted) throw error
          console.warn(FLOWS_UNREADABLE, { chainId, projectId }, error)
          return null
        }
      })
    },
    staleTime: FRESH_MS,
  })

/** The launch's project on each chain, the page's own first, each with its figures, or why it has none. */
const siblingsOptions = (client: QueryClient, chainId: number, projectId: number) =>
  queryOptions<SiblingRow[]>({
    queryKey: ['sticky-project', chainId, projectId, 'siblings', SIBLINGS_VERSION],
    queryFn: async ({ signal }) => {
      try {
        // The chart's reads come first. A failure of theirs is theirs to report, and the chart says it, so it does not
        // stop this one. The launch's facts are the same however old the project's read is.
        await untilAborted(
          client.fetchQuery(whenever(flowsOptions(client, chainId, projectId))).catch(() => undefined),
          signal,
        )
        const info = await untilAborted(client.fetchQuery(whenever(infoOptions(chainId, projectId))), signal)
        const rows = await inTurn(client, signal, async () =>
          siblingRows(await launchSiblings(info, { signal }), { signal }),
        )
        return rows.map(row => {
          if (!('error' in row)) return row
          console.warn(CHAIN_UNREADABLE, { chainId: row.chainId }, row.error)
          return { ...row, error: reasonOf(row.error) }
        })
      } catch (error) {
        if (!signal.aborted) console.warn(SIBLINGS_UNREADABLE, { chainId, projectId }, error)
        throw error
      }
    },
    staleTime: FRESH_MS,
    meta: PERSIST,
  })

/**
 * The chart's series: Total stuck in the staked token, or when the terminal's history cannot be read the Sticky
 * supply (`backingSeries`), beside the active streaks. It waits for the project's history and its balance flows. The
 * latest point is the project as the chain says it is now, so a kept copy of the project draws the chart as
 * `unconfirmed`. `failed` says the history or the drawing failed, and `unavailable` that the project itself could not
 * be read, so there is nothing to wait for. `retry` reads them again.
 */
export function useBackingSeries(chainId: number, projectId: number) {
  const client = useQueryClient()
  const events = useStickyEvents(chainId, projectId)
  const project = useStickyProject(chainId, projectId)
  const flows = useQuery(flowsOptions(client, chainId, projectId))
  const { info } = project
  const history = events.data?.events

  const drawn = useMemo(() => {
    if (history === undefined || info === undefined || flows.data === undefined) return undefined
    try {
      const supply = supplyPoints(history, Math.floor(Date.now() / 1000))
      return { series: backingSeries(flows.data, { supply, info, orphans: orphanExclusions(history) }) }
    } catch (error) {
      console.warn(CHART_UNDRAWABLE, { chainId, projectId }, error)
      return { error }
    }
  }, [history, info, flows.data, chainId, projectId])

  const series: BackingSeries | undefined = drawn && 'series' in drawn ? drawn.series : undefined
  return {
    series,
    failed:
      (drawn !== undefined && 'error' in drawn) ||
      (history === undefined && events.isError) ||
      (flows.data === undefined && flows.isError),
    unavailable: info === undefined && project.failed,
    unconfirmed: info !== undefined && !project.verified,
    retry: () => {
      void events.refetch()
      void flows.refetch()
    },
  }
}

/**
 * The launch's copies on the other chains and the page's own project, one row each, once this visit has read the
 * project and its history: read after the chart's, for the page's scans run one after another. `wanted` is whether
 * the project has anything to show here: a launch, or a chain its uri planned besides its own. The browser keeps what
 * it read, and an earlier visit's shows until this one's arrives.
 */
export function useProjectSiblings(chainId: number, projectId: number) {
  const client = useQueryClient()
  const { info, failed } = useStickyProject(chainId, projectId)
  const wanted =
    info !== undefined && (info.launchId !== null || missingChains(info, [{ chainId: info.chainId }]).length > 0)
  const siblings = useQuery({ ...siblingsOptions(client, chainId, projectId), enabled: wanted })
  return { info, failed, wanted, siblings }
}
