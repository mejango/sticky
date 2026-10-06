'use client'

import { queryOptions, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { Address } from 'viem'
import { useKeptQuery } from '@/hooks/useKeptQuery'
import { untilAborted } from '@/lib/hook-logs'
import { inTurn } from '@/lib/in-turn'
import { PERSIST } from '@/lib/query-persist'
import { FRESH_MS, warned } from '@/lib/query-reads'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { scanToHead, stickyEvents, type StickyEventKind, type StickyEventsResult } from '@/lib/sticky-events'
import { FEED_WINDOW, feedRows, terminalMoves, type FeedRow } from '@/lib/sticky-feed'
import {
  pinnedBlock,
  readStickyPosition,
  stickAges,
  stickyHolders,
  type StickyHoldersResult,
  type StickyPosition,
} from '@/lib/sticky-holders'
import { holderReadKey, projectKey } from '@/lib/sticky-keys'
import { readStickyProject, type StickyProjectInfo } from '@/lib/sticky-project'

/**
 * A Sticky project's page: its figures, its history, its holders, its Latest list, and the viewer's stick. The keys
 * start with the chain and project, so a page for another project never shows this one's answers. What the browser
 * keeps is public: the figures, the header's holder figures and Latest. The history and the holders can grow without
 * bound and stay in memory, and the viewer's stick is an account's and is never kept.
 *
 * Nothing of a project's history is read before the project itself has been, in this visit or an earlier one: a URN or
 * a handle that names no Sticky project costs one read, never a scan. A hook that reads the history or the holders also
 * observes them, so a page that closes cancels their scans, and the scans take their turn with every other page's, two
 * at a time (`inTurn`): Center has one rate limit. A read that scans is not tried again on its own, since a scan is
 * dozens of requests; the page offers a retry.
 */

/** The version of what the browser keeps of a project's page, in each kept key. Change it whenever
 * `StickyProjectInfo`, `FeedRow` or `ProjectSticks` changes shape, or a page renders a kept copy in an older shape
 * until it is read again. A kept key is written out, `projectKey`'s parts and then the version, as the persist-scope
 * test reads it. */
const PROJECT_VERSION = 'v1'
/** How often the viewer's stick is read again while the page is in view. */
const POSITION_REFRESH_MS = 15_000

const PROJECT_UNREADABLE = 'Could not read a Sticky project; its page offers to try again.'
const HISTORY_UNREADABLE =
  "Could not read a Sticky project's history; Latest and the chart cannot show, and the holders show only from Bendystraw's positions."
const HOLDERS_UNREADABLE = "Could not read a Sticky project's holders."
const STICKS_UNREADABLE = "Could not count a Sticky project's holders; the header shows – for their figures."
const LATEST_UNREADABLE = "Could not read a Sticky project's Latest list; it offers to try again."
const POSITION_UNREADABLE = "Could not read the viewer's stick; the Stick card keeps the last one it showed."

/** The events a feed shows. The others are a project's settings. */
const FEED_KINDS: ReadonlySet<StickyEventKind> = new Set(['stick', 'unstick', 'streakStart', 'streakEnd'])

/** The header's holder figures: how many hold shares, and their average and longest active streak, in seconds. */
export type ProjectSticks = { sticks: number; average: number; longest: number }

/** A project's holders, and the pinned block time their streaks are measured at. */
export type ProjectHolders = StickyHoldersResult & { now: number }

/** The projects a read of this visit gave. A copy the browser kept from an earlier visit is never among them. */
const readThisVisit = new WeakSet<StickyProjectInfo>()

const infoOptions = (chainId: number, projectId: number) =>
  queryOptions({
    queryKey: ['sticky-project', chainId, projectId, 'info', PROJECT_VERSION],
    queryFn: ({ signal }) =>
      warned(PROJECT_UNREADABLE, { chainId, projectId }, signal, async () => {
        const info = await readStickyProject(chainId, BigInt(projectId), { signal })
        readThisVisit.add(info)
        return info
      }),
    staleTime: FRESH_MS,
    // The data is the object the read gave, so a kept copy can be told from it; and a kept copy is read again as the
    // page opens, however new it is.
    structuralSharing: false,
    refetchOnMount: query => (query.state.data && readThisVisit.has(query.state.data) ? true : 'always'),
    meta: PERSIST,
  })

const eventsOptions = (client: QueryClient, chainId: number, projectId: number) =>
  queryOptions<StickyEventsResult>({
    queryKey: projectKey(chainId, projectId, 'events'),
    queryFn: ({ signal }) =>
      warned(HISTORY_UNREADABLE, { chainId, projectId }, signal, () =>
        inTurn(client, signal, () => stickyEvents(chainId, BigInt(projectId), { signal })),
      ),
    staleTime: FRESH_MS,
    retry: false,
  })

const holdersOptions = (client: QueryClient, chainId: number, projectId: number) =>
  queryOptions<ProjectHolders>({
    queryKey: projectKey(chainId, projectId, 'holders'),
    queryFn: ({ signal }) =>
      warned(HOLDERS_UNREADABLE, { chainId, projectId }, signal, async () => {
        // Bendystraw's positions and the pinned block are read beside the history, not after it. The history is the
        // holders' only when the positions cannot answer, and then it is the page's one read of it, waited for out of
        // turn; the positions' tail scan takes its turn.
        const now = pinnedBlock(chainId, { signal }).then(({ timestamp }) => timestamp)
        const holders = stickyHolders(chainId, BigInt(projectId), {
          signal,
          now,
          scan: (on, filter, opts) => inTurn(client, signal, () => scanToHead(on, filter, opts)),
          events: () => untilAborted(client.fetchQuery(eventsOptions(client, chainId, projectId)), signal),
        })
        const [timestamp, found] = await Promise.all([now, holders])
        return { ...found, now: timestamp }
      }),
    staleTime: FRESH_MS,
    retry: false,
  })

const sticksOptions = (client: QueryClient, chainId: number, projectId: number) =>
  queryOptions<ProjectSticks>({
    queryKey: ['sticky-project', chainId, projectId, 'sticks', PROJECT_VERSION],
    queryFn: ({ signal }) =>
      warned(STICKS_UNREADABLE, { chainId, projectId }, signal, async () => {
        const { rows, now } = await untilAborted(client.fetchQuery(holdersOptions(client, chainId, projectId)), signal)
        return { sticks: rows.length, ...stickAges(rows, now) }
      }),
    staleTime: FRESH_MS,
    retry: false,
    meta: PERSIST,
  })

const latestOptions = (client: QueryClient, chainId: number, projectId: number) =>
  queryOptions<FeedRow[]>({
    queryKey: ['sticky-project', chainId, projectId, 'latest', PROJECT_VERSION],
    queryFn: ({ signal }) =>
      warned(LATEST_UNREADABLE, { chainId, projectId }, signal, async () => {
        // The project first: its history is read only for a project that is one.
        const info = await untilAborted(client.fetchQuery(infoOptions(chainId, projectId)), signal)
        const { events } = await untilAborted(client.fetchQuery(eventsOptions(client, chainId, projectId)), signal)
        // The newest FEED_WINDOW sticks, unsticks and streaks, and what the terminal took in or paid out for them.
        const shown = events.filter(event => FEED_KINDS.has(event.kind)).slice(-FEED_WINDOW)
        const moves = await inTurn(client, signal, () => terminalMoves(shown, { signal }))
        return feedRows(shown, moves, {
          adapter: stickyDeployment(chainId)?.autoStick ?? null,
          tokens: (eventChainId, eventProjectId) =>
            eventChainId === chainId && eventProjectId === info.projectId ? info : undefined,
        })
      }),
    staleTime: FRESH_MS,
    retry: false,
    meta: PERSIST,
  })

/**
 * A project's figures: this visit's read, or until it lands, the copy the browser kept from an earlier visit.
 * `verified` is true only once this visit has read the project, never for a kept copy: nothing is stuck on a kept
 * copy's word. `failed` says the read failed with nothing verified to show, and `retry` reads it again.
 */
export function useStickyProject(chainId: number, projectId: number) {
  const read = useKeptQuery(infoOptions(chainId, projectId))
  const verified = read.data !== undefined && readThisVisit.has(read.data)
  return {
    info: read.data,
    verified,
    failed: read.isError && !verified,
    retry: () => void read.refetch(),
  }
}

/** Whether the project has been read, in this visit or an earlier one: its history waits for that. */
const useKnown = (chainId: number, projectId: number) => useKeptQuery(infoOptions(chainId, projectId)).data !== undefined

/** Every event of a project's hook history, through the head (`stickyEvents`), read once for the whole page. */
export function useStickyEvents(chainId: number, projectId: number) {
  const known = useKnown(chainId, projectId)
  return useKeptQuery({ ...eventsOptions(useQueryClient(), chainId, projectId), enabled: known })
}

/** The holders of a project with shares staked, most shares first, and the block time their streaks are measured at.
 * Their read runs beside the history's, which it falls back on when Bendystraw's positions cannot answer; the history is
 * observed here too, so that a page that closes cancels both. */
export function useStickyHolders(chainId: number, projectId: number) {
  const known = useKnown(chainId, projectId)
  useStickyEvents(chainId, projectId)
  return useKeptQuery({ ...holdersOptions(useQueryClient(), chainId, projectId), enabled: known })
}

/** The header's holder figures, which the browser keeps. */
export function useProjectSticks(chainId: number, projectId: number) {
  const known = useKnown(chainId, projectId)
  useStickyHolders(chainId, projectId)
  return useKeptQuery({ ...sticksOptions(useQueryClient(), chainId, projectId), enabled: known })
}

/** A project's Latest list, newest first, which the browser keeps. */
export function useProjectLatest(chainId: number, projectId: number) {
  const known = useKnown(chainId, projectId)
  useStickyEvents(chainId, projectId)
  return useKeptQuery({ ...latestOptions(useQueryClient(), chainId, projectId), enabled: known })
}

/**
 * The stick of `holder` (the viewed account, or the connected one) in a project, once the project is known. It is read
 * again every 15 seconds while the tab is in view and as soon as the tab is shown again, and the browser never keeps
 * it: it is an account's.
 */
export function useStickyPosition(
  chainId: number,
  projectId: number,
  holder: Address | null,
  info: StickyProjectInfo | undefined,
) {
  return useKeptQuery<StickyPosition>({
    queryKey: [...holderReadKey('sticky-position', chainId, projectId), holder],
    queryFn: ({ signal }) =>
      warned(POSITION_UNREADABLE, { chainId, projectId }, signal, () =>
        readStickyPosition(chainId, info!, holder!, { signal }),
      ),
    enabled: holder !== null && info !== undefined,
    refetchInterval: POSITION_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
  })
}
