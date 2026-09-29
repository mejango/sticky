// @vitest-environment jsdom

import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import {
  cachedQuery,
  deserializeState,
  immutableQuery,
  installQueryPersistence,
  serializeState,
} from '@/lib/query-persist'

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: key => map.get(key) ?? null,
    key: index => [...map.keys()][index] ?? null,
    removeItem: key => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  } as Storage
}

const settle = async (client: QueryClient, key: unknown[], data: unknown, meta?: object) =>
  client.fetchQuery({ queryKey: key, queryFn: async () => data, ...meta })

describe('query persistence', () => {
  it('round-trips bigints, which viem returns everywhere', () => {
    const state = {
      mutations: [],
      queries: [
        {
          queryKey: ['supply'],
          queryHash: '["supply"]',
          state: { data: { total: 123n }, status: 'success' },
        },
      ],
    }
    // JSON.stringify throws on a bigint, so a naive persister would drop or
    // break every balance/supply query in the app.
    const restored = deserializeState(serializeState(state as never)) as never as typeof state
    expect(restored.queries[0].state.data).toEqual({ total: 123n })
    expect(typeof (restored.queries[0].state.data as { total: bigint }).total).toBe('bigint')
  })

  it('persists only tagged queries — untagged wallet data never reaches disk', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const client = new QueryClient()
    installQueryPersistence(client, storage)

    await settle(client, ['rulesetRow', 1, 2, 3], { weight: 5n }, immutableQuery({}))
    await settle(client, ['balance'], { amount: 9n }, cachedQuery({}))
    await settle(client, ['cashOutTokenAllowance', '0xabc'], { allowance: 7n })

    await vi.advanceTimersByTimeAsync(1_500)
    const written = deserializeState(storage.getItem('sticky:query-cache:v1')!)
    const keys = written.queries.map(q => (q.queryKey as unknown[])[0])

    expect(keys).toContain('rulesetRow')
    expect(keys).toContain('balance')
    expect(keys).not.toContain('cashOutTokenAllowance')
    vi.useRealTimers()
  })

  it('restores tagged values into a fresh client so the first paint has data', async () => {
    vi.useFakeTimers()
    const storage = memoryStorage()
    const first = new QueryClient()
    installQueryPersistence(first, storage)
    await settle(first, ['stages', 1, 6], { weight: 42n }, immutableQuery({}))
    await vi.advanceTimersByTimeAsync(1_500)

    const second = new QueryClient()
    installQueryPersistence(second, storage)
    expect(second.getQueryData(['stages', 1, 6])).toEqual({ weight: 42n })
    vi.useRealTimers()
  })

  it('survives a corrupt store instead of breaking boot', () => {
    const storage = memoryStorage()
    storage.setItem('sticky:query-cache:v1', '{ not json')
    const client = new QueryClient()
    expect(() => installQueryPersistence(client, storage)).not.toThrow()
    expect(storage.getItem('sticky:query-cache:v1')).toBeNull()
  })

  it('marks immutable queries so they are never refetched', () => {
    const options = immutableQuery({ queryKey: ['x'] })
    expect(options.staleTime).toBe(Number.POSITIVE_INFINITY)
    expect(options.meta.persist).toBe('immutable')
  })
})
