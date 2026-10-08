'use client'

import {
  skipToken,
  useQueries,
  useQuery,
  type DefaultError,
  type QueriesOptions,
  type QueriesResults,
  type QueryKey,
  type QueryObserverResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query'
import { useCallback, useSyncExternalStore } from 'react'

/**
 * The reads a page may have kept from an earlier visit (`PERSIST`, `immutableQuery`) go through these hooks, and only
 * these: the persist-scope test fails a module that tags a query and reads with `useQuery` or `useQueries` itself.
 *
 * The browser restores what it kept as soon as it starts, but the server never has it. So until a component has
 * hydrated, each read here answers as it did on the server: pending, with no data, fetching when it is enabled. React
 * then renders the component again with what the browser kept, which paints before the network answers. A component
 * that mounts after the page has loaded sees the kept copy in its first render.
 */

const unchanging = () => () => {}

/** False while the server renders the calling component and while React hydrates it; true from then on, and true
 * from the first render for a component that mounts later. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    unchanging,
    () => true,
    () => false,
  )
}

/** Whether the server's render starts the read: every enabled one does, since the server holds no data. */
const startsOnServer = (options: { enabled?: unknown; queryFn?: unknown }) =>
  options.enabled !== false && options.queryFn !== skipToken

/** A result as the server had it, with nothing in the cache. Only the result's stable `refetch` is taken from it. */
function asOnServer<TResult extends QueryObserverResult<unknown, unknown>>(result: TResult, fetching: boolean): TResult {
  return {
    data: undefined,
    dataUpdatedAt: 0,
    error: null,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
    status: 'pending',
    fetchStatus: fetching ? 'fetching' : 'idle',
    isPending: true,
    isSuccess: false,
    isError: false,
    isLoadingError: false,
    isRefetchError: false,
    isFetching: fetching,
    isLoading: fetching,
    isInitialLoading: fetching,
    isRefetching: false,
    isPaused: false,
    isPlaceholderData: false,
    isFetched: false,
    isFetchedAfterMount: false,
    isStale: true,
    isEnabled: fetching,
    refetch: result.refetch,
  } as unknown as TResult
}

/** `useQuery` for a read the browser may have kept. */
export function useKeptQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>): UseQueryResult<TData, TError> {
  const hydrated = useHydrated()
  const result = useQuery(options)
  return hydrated ? result : asOnServer(result, startsOnServer(options))
}

/** `useQueries` for reads the browser may have kept. `combine` sees each result as `useKeptQuery` would give it. */
export function useKeptQueries<T extends Array<unknown>, TCombined = QueriesResults<T>>({
  queries,
  combine,
}: {
  queries: readonly [...QueriesOptions<T>]
  combine?: (results: QueriesResults<T>) => TCombined
}): TCombined {
  const hydrated = useHydrated()
  // Which reads the server starts, as a string, so the combine below changes only when they do.
  const starts = (queries as readonly { enabled?: unknown; queryFn?: unknown }[]).map(startsOnServer).join()
  const kept = useCallback(
    (results: QueriesResults<T>) => {
      const fetching = starts.split(',')
      const seen = hydrated
        ? results
        : ((results as QueryObserverResult[]).map((result, at) =>
            asOnServer(result, fetching[at] === 'true'),
          ) as QueriesResults<T>)
      return combine ? combine(seen) : (seen as unknown as TCombined)
    },
    [hydrated, starts, combine],
  )
  return useQueries({ queries, combine: kept } as Parameters<typeof useQueries>[0]) as TCombined
}
