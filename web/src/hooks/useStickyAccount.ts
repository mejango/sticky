'use client'

import type { BendystrawNetwork } from '@bananapus/nana-sdk-core'
import { useQueries, useQueryClient, type QueryClient, type QueryObserverResult } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { Address } from 'viem'
import { untilAborted } from '@/lib/hook-logs'
import { inTurn } from '@/lib/in-turn'
import {
  accountActivity,
  accountChains,
  accountIndex,
  accountPositions,
  deployedProjects,
  listedPositions,
  type AccountActivityChain,
  type AccountChain,
  type AccountIndex,
  type AccountPosition,
} from '@/lib/sticky-account'
import { FEED_WINDOW, type FeedRow } from '@/lib/sticky-feed'
import { accountKey, deployedKey } from '@/lib/sticky-keys'

// None of these queries is kept in the browser: each is about one account's positions or activity.

/** How often a position is read again while the page is in view. */
const POSITIONS_REFRESH_MS = 15_000
/** How long what Bendystraw says of the account stays fresh: one read of it serves every chain's, and a refresh of the
 * positions reads it again, so that the scan past its block stays short. */
const INDEX_FRESH_MS = 10_000
/** How long the projects of a chain that Bendystraw cannot list positions on stay fresh. Finding them scans the chain,
 * and a refresh reads balances only. */
const DEPLOYED_FRESH_MS = 5 * 60_000
const POSITIONS_UNREADABLE = "Could not read an account's Sticky positions on a chain; the page counts the chain."
const ACTIVITY_UNREADABLE = "Could not read an account's Sticky activity on a chain; the page counts the chain."

/** What Bendystraw says of the account, read once for every chain. */
function indexOf(client: QueryClient, network: BendystrawNetwork, holder: Address, signal: AbortSignal) {
  return untilAborted(
    client.fetchQuery({
      queryKey: accountKey(network, holder, 'index'),
      queryFn: ({ signal: own }) => accountIndex(network, holder, { signal: own }),
      staleTime: INDEX_FRESH_MS,
    }),
    signal,
  )
}

/** Every Sticky project of a chain, for a chain Bendystraw cannot list the account's positions on. */
function deployedOf(client: QueryClient, network: BendystrawNetwork, chainId: number, index: AccountIndex, signal: AbortSignal) {
  return untilAborted(
    client.fetchQuery({
      queryKey: deployedKey(network, chainId),
      queryFn: ({ signal: own }) => deployedProjects(chainId, index, { signal: own }),
      staleTime: DEPLOYED_FRESH_MS,
    }),
    signal,
  )
}

/** What a page takes of its chains' reads: each part in the order of the chains, and whether any chain has neither
 * answered nor failed. A chain whose last read failed shows nothing of what it had before. */
function chainsRead<T>(results: QueryObserverResult<T>[]) {
  return {
    shown: results.map(read => (read.isError ? undefined : read.data)),
    failed: results.map(read => read.isError),
    pending: results.some(read => read.status === 'pending'),
  }
}
const positionsRead = (results: QueryObserverResult<AccountChain>[]) => chainsRead(results)
const activityRead = (results: QueryObserverResult<AccountActivityChain>[]) => chainsRead(results)

const loadedOf = <T>(shown: readonly (T | undefined)[]) => shown.filter((chain): chain is T => chain !== undefined)

export type AccountPositionsRead = {
  /** The positions of the chains read so far, in the order of the chains, then by project ID. */
  positions: AccountPosition[]
  /** The projects that could not be read on the chains that could, and are not in `positions`. */
  skipped: number
  /** The chains whose last read failed. */
  failedChains: number[]
  /** Whether a chain has neither answered nor failed yet. */
  pending: boolean
  /** Reads the account's positions again, on every chain. */
  retry: () => void
}

/**
 * The positions an account holds on the chains of a network, read two chains at a time and drawn as each arrives.
 * Bendystraw lists them, once for the network, and each chain reads them again from StickyHook, adding the projects
 * the account's position events show past the block the listing is indexed through; when Bendystraw cannot list a
 * chain's, or those events are more than a scan may read, every Sticky project of the chain is asked. Every 15 s,
 * until the tab is hidden, they are read again. A chain whose read fails is named in `failedChains`, and the console
 * hears why; the others still show.
 */
export function useAccountPositions(network: BendystrawNetwork, address: Address): AccountPositionsRead {
  const client = useQueryClient()
  const holder = address.toLowerCase() as Address
  const chains = useMemo(() => accountChains(network), [network])

  const reads = useQueries({
    queries: chains.map(chainId => ({
      queryKey: [...accountKey(network, holder, 'positions'), chainId],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        inTurn(client, signal, async () => {
          try {
            const index = await indexOf(client, network, holder, signal)
            const listed = listedPositions(index, chainId)
            const everyProject = () => deployedOf(client, network, chainId, index, signal)
            if (listed) {
              const listing = { through: listed.through, everyProject }
              return await accountPositions(chainId, holder, listed.projects, { signal, listing })
            }
            return await accountPositions(chainId, holder, await everyProject(), { signal })
          } catch (error) {
            if (!signal.aborted) console.warn(POSITIONS_UNREADABLE, { network, chainId }, error)
            throw error
          }
        }),
      // Each request of a chain's read is retried already; a second go would only repeat its reads.
      retry: false,
      refetchInterval: POSITIONS_REFRESH_MS,
      refetchIntervalInBackground: false,
    })),
    combine: positionsRead,
  })

  const loaded = loadedOf(reads.shown)
  return {
    positions: loaded.flatMap(chain => chain.positions),
    skipped: loaded.reduce((sum, chain) => sum + chain.skipped, 0),
    failedChains: chains.filter((_, at) => reads.failed[at]),
    pending: reads.pending,
    retry: () => void client.refetchQueries({ queryKey: accountKey(network, holder, 'positions') }),
  }
}

export type AccountActivityRead = {
  /** The newest FEED_WINDOW rows across the chains read so far, newest first. */
  rows: FeedRow[]
  /** What each row's project is called, by `${chainId}:${projectId}`. */
  labels: Map<string, string>
  failedChains: number[]
  pending: boolean
  /** Reads the account's activity again, on every chain. */
  retry: () => void
}

/**
 * The newest activity of an account on the chains of a network, drawn as each chain arrives. The chains are read in
 * turn with the page's other reads, two at a time, after the positions. A chain whose read fails is named in
 * `failedChains`, and the console hears why; the others still show. It is read when the page opens and not again while
 * the page is open: the positions are the part of the page that changes under the reader.
 */
export function useAccountActivity(network: BendystrawNetwork, address: Address): AccountActivityRead {
  const client = useQueryClient()
  const holder = address.toLowerCase() as Address
  const chains = useMemo(() => accountChains(network), [network])

  const reads = useQueries({
    queries: chains.map(chainId => ({
      queryKey: [...accountKey(network, holder, 'activity'), chainId],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        inTurn(client, signal, async () => {
          try {
            const index = await indexOf(client, network, holder, signal)
            const listed = listedPositions(index, chainId)
            // With no positions listed, the account's events can be in any Sticky project of the chain. A chain with
            // none has no activity, and its hook's history is not worth a scan.
            if (listed === null && (await deployedOf(client, network, chainId, index, signal)).length === 0) {
              return { chainId, rows: [], labels: {} }
            }
            return await accountActivity(chainId, holder, { signal, projects: listed?.projects })
          } catch (error) {
            if (!signal.aborted) console.warn(ACTIVITY_UNREADABLE, { network, chainId }, error)
            throw error
          }
        }),
      retry: false,
    })),
    combine: activityRead,
  })

  const loaded = loadedOf(reads.shown)
  return {
    rows: loaded
      .flatMap(chain => chain.rows)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, FEED_WINDOW),
    labels: new Map(
      loaded.flatMap(chain =>
        Object.entries(chain.labels).map(([projectId, label]): [string, string] => [`${chain.chainId}:${projectId}`, label]),
      ),
    ),
    failedChains: chains.filter((_, at) => reads.failed[at]),
    pending: reads.pending,
    retry: () => void client.refetchQueries({ queryKey: accountKey(network, holder, 'activity') }),
  }
}
