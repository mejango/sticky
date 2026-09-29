'use client'

import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type Query,
  type QueryClient,
} from '@tanstack/react-query'

/**
 * Cross-session query persistence, opt-in per query.
 *
 * Two tiers, both restored from disk before the first paint:
 *
 * - `immutable` — the answer provably cannot change (a ruleset row, a revnet's
 *   stage schedule, a settled swap). Restored and trusted: never refetched.
 * - `revalidate` — the answer can change. Restored so the value paints
 *   instantly, then refetched; the UI marks it as unconfirmed meanwhile (see
 *   `Revalidating`).
 *
 * Opt-in, not opt-out: a query is only persisted when someone proved which
 * tier it belongs to. Wallet-scoped balances, allowances and anything gating a
 * transaction are simply never tagged, so they never reach disk.
 *
 * ponytail: localStorage with a byte budget and whole-store eviction. It is
 * synchronous and capped ~5MB; move to IndexedDB if the budget starts evicting
 * during normal use.
 */

const STORE_KEY = 'sticky:query-cache:v1'
const MAX_BYTES = 2_500_000
const WRITE_DEBOUNCE_MS = 1_000

type PersistTier = 'immutable' | 'revalidate'

export type PersistMeta = { persist?: PersistTier }

/**
 * Drop-in `meta` for a read whose value is worth showing from the last session
 * while it revalidates. Pair it with `Revalidating` so the stale value reads as
 * unconfirmed rather than current.
 */
export const PERSIST: PersistMeta = { persist: 'revalidate' }

function tierOf(query: Query): PersistTier | undefined {
  return (query.meta as PersistMeta | undefined)?.persist
}

// viem returns bigints throughout; JSON.stringify throws on them.
const BIGINT_TAG = '$bigint'

function replacer(_key: string, value: unknown) {
  return typeof value === 'bigint'
    ? { [BIGINT_TAG]: value.toString() }
    : value
}

function reviver(_key: string, value: unknown) {
  if (value && typeof value === 'object' && BIGINT_TAG in value) {
    const raw = (value as Record<string, unknown>)[BIGINT_TAG]
    if (typeof raw === 'string') return BigInt(raw)
  }
  return value
}

export function serializeState(state: DehydratedState): string {
  return JSON.stringify(state, replacer)
}

export function deserializeState(raw: string): DehydratedState {
  return JSON.parse(raw, reviver) as DehydratedState
}

/**
 * Restore the persisted cache, then keep writing it back as queries settle.
 * Returns a teardown function. Safe to call before render — hydration is
 * synchronous so the first paint already sees the restored data.
 */
export function installQueryPersistence(
  client: QueryClient,
  storage: Storage | undefined = typeof window === 'undefined'
    ? undefined
    : window.localStorage,
): () => void {
  if (!storage) return () => {}

  try {
    const raw = storage.getItem(STORE_KEY)
    if (raw) hydrate(client, deserializeState(raw))
  } catch {
    // A corrupt or version-skewed store must never break boot.
    try {
      storage.removeItem(STORE_KEY)
    } catch {}
  }

  let timer: ReturnType<typeof setTimeout> | undefined

  const write = () => {
    timer = undefined
    try {
      const state = dehydrate(client, {
        shouldDehydrateQuery: query =>
          !!tierOf(query) && query.state.status === 'success',
      })
      const payload = serializeState(state)
      // Over budget: drop the store rather than half-write it. The next
      // settled queries repopulate it.
      if (payload.length > MAX_BYTES) storage.removeItem(STORE_KEY)
      else storage.setItem(STORE_KEY, payload)
    } catch {
      // Quota or serialization failure: persistence is an optimization, so
      // give up quietly rather than surface an error to the user.
      try {
        storage.removeItem(STORE_KEY)
      } catch {}
    }
  }

  const unsubscribe = client.getQueryCache().subscribe(event => {
    if (event.type !== 'updated') return
    if (event.query.state.status !== 'success') return
    if (!tierOf(event.query)) return
    if (timer) return
    timer = setTimeout(write, WRITE_DEBOUNCE_MS)
  })

  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
  }
}

/**
 * Tag a query whose answer provably cannot change. Never refetched, kept
 * across sessions. Only use where the write path has been checked — see
 * `tasks/webclient-caching-plan.md`.
 */
export function immutableQuery<T extends object>(options: T): T & {
  staleTime: number
  gcTime: number
  meta: PersistMeta
} {
  return {
    ...options,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    meta: {
      ...(options as { meta?: Record<string, unknown> }).meta,
      persist: 'immutable',
    },
  }
}

/**
 * Tag a query whose answer can change but is worth showing immediately from
 * the last session while it revalidates.
 */
export function cachedQuery<T extends object>(options: T): T & {
  meta: PersistMeta
} {
  return {
    ...options,
    meta: {
      ...(options as { meta?: Record<string, unknown> }).meta,
      persist: 'revalidate',
    },
  }
}
