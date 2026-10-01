'use client'

import { queryOptions, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { useKeptQuery } from '@/hooks/useKeptQuery'
import { useProjectLatest, useStickyEvents, useStickyHolders, useStickyProject } from '@/hooks/useStickyProject'
import { inTurn } from '@/lib/in-turn'
import { PERSIST } from '@/lib/query-persist'
import { FRESH_MS } from '@/lib/query-reads'
import {
  backingFlows,
  backingSeries,
  orphanExclusions,
  supplyPoints,
  type BackingSeries,
  type Flow,
} from '@/lib/sticky-backing'
import { projectCreationBlock } from '@/lib/sticky-events'
import { projectKey } from '@/lib/sticky-keys'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { launchSiblings, missingChains, siblingRows, type SiblingRow } from '@/lib/sticky-siblings'

/**
 * A Sticky project's Overview tab: the chart's series and the chains of its launch. The keys start with the chain and
 * project, as the rest of the project page's, so a page for another project never shows this one's answers. The chains
 * are public and small, and the browser keeps them. What the chart is drawn from grows with the project's history, so
 * it stays in memory, as the history does (`useStickyProject`).
 *
 * These reads keep the page's rules (`useStickyProject`): none of a project's history is read before the project has
 * been, a read that scans is not tried again on its own (the page offers a retry), and the scans take their turn
 * (`inTurn`). Turns are first come first served, and a project's balance history can take many requests, so each read
 * here waits until what the rest of the page shows first is through, whether it succeeded or failed: the history, then
 * the header's holders and Latest, then the balance flows, then the search for the copies on the other chains. All of
 * them are observed here, so a page that closes cancels them.
 */

/** The version of what the browser keeps of the chains, in the key. Change it whenever `SiblingRow` or
 * `StickyProjectInfo` changes shape, or a page renders a kept copy in an older shape until it is read again. */
const SIBLINGS_VERSION = 'v1'

const FLOWS_UNREADABLE = "Could not read a Sticky project's balance history; charting its Sticky supply instead."
const CHART_UNDRAWABLE = "Could not draw a Sticky project's chart from its history; it offers to try again."
const SIBLINGS_UNREADABLE = "Could not read a Sticky project's chains; its Chains card offers to try again."
const CHAIN_UNREADABLE = "Could not read one of a Sticky launch's chains; its Chains card says so."

/** Why a chain could not be read, as the text the browser keeps: the card only says that it could not, and an error
 * is not kept as it stands, for it may be too large or not serialize at all. */
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200)

/** What the terminal's balance did over a project's life, or null when it cannot be read, which the chart says. */
const flowsOptions = (client: QueryClient, chainId: number, projectId: number) =>
  queryOptions<Flow[] | null>({
    queryKey: projectKey(chainId, projectId, 'flows'),
    queryFn: ({ signal }) =>
      inTurn(client, signal, async () => {
        try {
          const fromBlock = await projectCreationBlock(chainId, BigInt(projectId), { signal })
          return await backingFlows(chainId, BigInt(projectId), fromBlock, { signal })
        } catch (error) {
          if (signal.aborted) throw error
          console.warn(FLOWS_UNREADABLE, { chainId, projectId }, error)
          return null
        }
      }),
    staleTime: FRESH_MS,
    retry: false,
  })

/** The launch's project on each chain, the page's own first, each with its figures, or why it has none. `info` is the
 * page's project, which the read is enabled for. */
const siblingsOptions = (
  client: QueryClient,
  chainId: number,
  projectId: number,
  info: StickyProjectInfo | undefined,
) =>
  queryOptions<SiblingRow[]>({
    queryKey: ['sticky-project', chainId, projectId, 'siblings', SIBLINGS_VERSION],
    queryFn: async ({ signal }) => {
      try {
        const rows = await inTurn(client, signal, async () =>
          siblingRows(await launchSiblings(info!, { signal }), { signal }),
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
    retry: false,
    meta: PERSIST,
  })

/** Whether a read has come to an answer or a failure, and is not under way. */
const settled = (read: { isPending: boolean; isFetching: boolean }) => !read.isPending && !read.isFetching

/**
 * The reads the Overview's cards share: the project, its history, the header's holders and Latest, and the balance
 * flows. The flows are enabled once the project is known, its history is read, and the header's holders and Latest are
 * through (`turn`); the search for the chains, once the header's are. The flows are observed first, so they are in line
 * before the chains' read is. When the header's reads start again (a retry of Latest), the later ones wait for them
 * again, and are read again if they have gone stale.
 */
function useOverviewReads(chainId: number, projectId: number) {
  const client = useQueryClient()
  const project = useStickyProject(chainId, projectId)
  const events = useStickyEvents(chainId, projectId)
  const holders = useStickyHolders(chainId, projectId)
  const latest = useProjectLatest(chainId, projectId)
  const turn = settled(holders) && settled(latest)
  const flows = useKeptQuery({
    ...flowsOptions(client, chainId, projectId),
    enabled: project.info !== undefined && events.isSuccess && turn,
  })
  return { project, events, flows, turn }
}

/**
 * The chart's series: Total stuck in the staked token, or when the terminal's history cannot be read the Sticky
 * supply (`backingSeries`), beside the active streaks. It waits for the project's history and its balance flows. The
 * latest point is the project as the chain says it is now, so a kept copy of the project draws the chart as
 * `unconfirmed`. `failed` says the history or the drawing failed, and `unavailable` that the project itself could not
 * be read, so there is nothing to wait for. `retry` reads them again.
 */
export function useBackingSeries(chainId: number, projectId: number) {
  const { project, events, flows } = useOverviewReads(chainId, projectId)
  const { info } = project
  const history = events.data?.events

  const drawn = useMemo(() => {
    if (history === undefined || info === undefined || flows.data === undefined) return undefined
    try {
      const supply = supplyPoints(history, Math.floor(Date.now() / 1000))
      return { series: backingSeries(flows.data, { supply, info, orphans: orphanExclusions(history) }) }
    } catch (error) {
      return { error }
    }
  }, [history, info, flows.data])
  // Said from an effect: a render can run twice, or be thrown away, and a drawing that failed is said once.
  useEffect(() => {
    if (drawn && 'error' in drawn) console.warn(CHART_UNDRAWABLE, { chainId, projectId }, drawn.error)
  }, [drawn, chainId, projectId])

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
      if (flows.isError) void flows.refetch()
    },
  }
}

/**
 * The launch's copies on the other chains and the page's own project, one row each. The search waits until the project
 * is known and the header's holders and Latest are through, and takes its place in line after the balance flows.
 * `wanted` is whether the project has anything to show here: a launch, or a chain its uri planned besides its own.
 * `waiting` says the search has not had its turn, so what the browser kept of an earlier visit is not yet confirmed.
 */
export function useProjectSiblings(chainId: number, projectId: number) {
  const client = useQueryClient()
  const { project, turn } = useOverviewReads(chainId, projectId)
  const { info, failed } = project
  const wanted =
    info !== undefined && (info.launchId !== null || missingChains(info, [{ chainId: info.chainId }]).length > 0)
  const siblings = useKeptQuery({ ...siblingsOptions(client, chainId, projectId, info), enabled: wanted && turn })
  return { info, failed, wanted, waiting: !turn, siblings }
}
