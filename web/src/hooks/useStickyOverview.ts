'use client'

import { queryOptions, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { useKeptQuery } from '@/hooks/useKeptQuery'
import { useProjectLatest, useStickyEvents, useStickyHolders, useStickyProject } from '@/hooks/useStickyProject'
import { inTurn } from '@/lib/in-turn'
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

/** The selected pool's chart reads share its chain/project identity and wait for the header's reads. */

const FLOWS_UNREADABLE = "Could not read a Sticky project's balance history; charting its Sticky supply instead."
const CHART_UNDRAWABLE = "Could not draw a Sticky project's chart from its history; it offers to try again."

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

/** Whether a read has come to an answer or a failure, and is not under way. */
const settled = (read: { isPending: boolean; isFetching: boolean }) => !read.isPending && !read.isFetching

/** The project's balance flows wait until its history, holders and Latest have finished. They share the page's
 * bounded scan queue and cancellation signal, and do not read any other pool. */
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
  return { project, events, flows }
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
