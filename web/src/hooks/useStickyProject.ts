'use client'

import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { Address } from 'viem'
import { untilAborted } from '@/lib/hook-logs'
import { PERSIST } from '@/lib/query-persist'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { stickyEvents, type StickyEventKind, type StickyEventsResult } from '@/lib/sticky-events'
import { FEED_WINDOW, feedRows, terminalMoves, type FeedRow } from '@/lib/sticky-feed'
import {
  pinnedBlock,
  readStickyPosition,
  stickAges,
  stickyHolders,
  type StickyHoldersResult,
  type StickyPosition,
} from '@/lib/sticky-holders'
import { readStickyProject, type StickyProjectInfo } from '@/lib/sticky-project'

/**
 * A Sticky project's page: its figures, its history, its holders, its Latest list, and the viewer's stick. The keys
 * start with the chain and project, so a page for another project never shows this one's answers. What the browser
 * keeps is public: the figures, the header's holder figures and Latest. The history and the holders can grow without
 * bound and stay in memory, and the viewer's stick is an account's and is never kept.
 */

/** The version of what the browser keeps of a project's page, in each kept key. Change it whenever
 * `StickyProjectInfo`, `FeedRow` or `ProjectSticks` changes shape, or a page renders a kept copy in an older shape
 * until it is read again. */
const PROJECT_VERSION = 'v1'
/** How long a read stays fresh: the reads that others build on are shared for this long. */
const FRESH_MS = 30_000
/** How often the viewer's stick is read again while the page is in view. */
const POSITION_REFRESH_MS = 15_000

const PROJECT_UNREADABLE = 'Could not read a Sticky project; its page offers to try again.'
const HISTORY_UNREADABLE = "Could not read a Sticky project's history; Latest and its holder figures cannot show."
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

/** What `read` gives, or its failure, which the console hears about under `label` unless the read was cancelled. */
async function warned<T>(label: string, about: object, signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (!signal.aborted) console.warn(label, about, error)
    throw error
  }
}

/** The project page's scans under way with each query client. */
const scanning = new WeakMap<QueryClient, Promise<unknown>>()

/** `scan`, once the page's earlier scans with this client have ended, however they ended: a page runs its scans one
 * after another. A scan cancelled while it waits does not start. A scan never waits on another query, or it could wait
 * on itself. */
export function scanInTurn<T>(client: QueryClient, signal: AbortSignal, scan: () => Promise<T>): Promise<T> {
  const turn = (scanning.get(client) ?? Promise.resolve()).then(() => {
    if (signal.aborted) throw signal.reason
    return scan()
  })
  // The next scan waits for this one to settle. This one's failure goes to its own caller, through `turn`.
  scanning.set(client, turn.catch(() => undefined))
  return turn
}

/** The projects a read of this visit gave. A copy the browser kept from an earlier visit is never among them. */
const readThisVisit = new WeakSet<StickyProjectInfo>()

const infoOptions = (chainId: number, projectId: number) =>
  queryOptions({
    queryKey: ['sticky-project', chainId, projectId, 'info', PROJECT_VERSION],
    queryFn: ({ signal }) =>
      warned(PROJECT_UNREADABLE, { chainId, projectId }, signal, async () => {
        const info = await readStickyProject(chainId, BigInt(projectId))
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
    queryKey: ['sticky-project', chainId, projectId, 'events'],
    queryFn: ({ signal }) =>
      warned(HISTORY_UNREADABLE, { chainId, projectId }, signal, () =>
        scanInTurn(client, signal, () => stickyEvents(chainId, BigInt(projectId), { signal })),
      ),
    staleTime: FRESH_MS,
  })

const holdersOptions = (client: QueryClient, chainId: number, projectId: number) =>
  queryOptions<ProjectHolders>({
    queryKey: ['sticky-project', chainId, projectId, 'holders'],
    queryFn: ({ signal }) =>
      warned(HOLDERS_UNREADABLE, { chainId, projectId }, signal, async () => {
        // The history is read first: the holders fall back on it when Bendystraw's positions cannot answer, and its
        // scan comes before theirs.
        const history = await untilAborted(client.fetchQuery(eventsOptions(client, chainId, projectId)), signal)
        const pin = await pinnedBlock(chainId, { signal })
        const found = await scanInTurn(client, signal, () =>
          stickyHolders(chainId, BigInt(projectId), { signal, now: pin.timestamp, events: async () => history }),
        )
        return { ...found, now: pin.timestamp }
      }),
    staleTime: FRESH_MS,
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
    meta: PERSIST,
  })

const latestOptions = (client: QueryClient, chainId: number, projectId: number) =>
  queryOptions<FeedRow[]>({
    queryKey: ['sticky-project', chainId, projectId, 'latest', PROJECT_VERSION],
    queryFn: ({ signal }) =>
      warned(LATEST_UNREADABLE, { chainId, projectId }, signal, async () => {
        const [{ events }, info] = await untilAborted(
          Promise.all([
            client.fetchQuery(eventsOptions(client, chainId, projectId)),
            client.fetchQuery(infoOptions(chainId, projectId)),
          ]),
          signal,
        )
        // The newest FEED_WINDOW sticks, unsticks and streaks, and what the terminal took in or paid out for them.
        const window = events.filter(event => FEED_KINDS.has(event.kind)).slice(-FEED_WINDOW)
        const moves = await scanInTurn(client, signal, () => terminalMoves(window, { signal }))
        return feedRows(window, moves, {
          adapter: stickyDeployment(chainId)?.autoStick ?? null,
          tokens: (eventChainId, eventProjectId) =>
            eventChainId === chainId && eventProjectId === info.projectId ? info : undefined,
        })
      }),
    staleTime: FRESH_MS,
    meta: PERSIST,
  })

/**
 * A project's figures: this visit's read, or until it lands, the copy the browser kept from an earlier visit.
 * `verified` is true only once this visit has read the project, never for a kept copy: nothing is stuck on a kept
 * copy's word. `failed` says the read failed with nothing verified to show, and `retry` reads it again.
 */
export function useStickyProject(chainId: number, projectId: number) {
  const read = useQuery(infoOptions(chainId, projectId))
  const verified = read.data !== undefined && readThisVisit.has(read.data)
  return {
    info: read.data,
    verified,
    failed: read.isError && !verified,
    retry: () => void read.refetch(),
  }
}

/** Every event of a project's hook history, through the head (`stickyEvents`), read once for the whole page. */
export function useStickyEvents(chainId: number, projectId: number) {
  return useQuery(eventsOptions(useQueryClient(), chainId, projectId))
}

/** The holders of a project with shares staked, most shares first, and the block time their streaks are measured at. */
export function useStickyHolders(chainId: number, projectId: number) {
  return useQuery(holdersOptions(useQueryClient(), chainId, projectId))
}

/** The header's holder figures, which the browser keeps. */
export function useProjectSticks(chainId: number, projectId: number) {
  return useQuery(sticksOptions(useQueryClient(), chainId, projectId))
}

/** A project's Latest list, newest first, which the browser keeps. */
export function useProjectLatest(chainId: number, projectId: number) {
  return useQuery(latestOptions(useQueryClient(), chainId, projectId))
}

/**
 * The stick of `holder` (the viewed account, or the connected one) in a project, once the project is known. It is read
 * again every 15 seconds while the tab is in view, and the browser never keeps it: it is an account's.
 */
export function useStickyPosition(
  chainId: number,
  projectId: number,
  holder: Address | null,
  info: StickyProjectInfo | undefined,
) {
  return useQuery<StickyPosition>({
    queryKey: ['sticky-position', chainId, projectId, holder],
    queryFn: ({ signal }) =>
      warned(POSITION_UNREADABLE, { chainId, projectId }, signal, () =>
        readStickyPosition(chainId, info!, holder!, { signal }),
      ),
    enabled: holder !== null && info !== undefined,
    refetchInterval: POSITION_REFRESH_MS,
    refetchIntervalInBackground: false,
  })
}
