// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import registry from '@/lib/bendystraw-operation-registry.json'
import type { StickyEvent } from '@/lib/sticky-events'
import { feedRows, terminalMoves, type FeedOptions } from '@/lib/sticky-feed'
import { CHAIN, HOLDER } from './sticky-log-fixtures'

// terminalMoves with the reads it makes when a caller gives it none, against Bendystraw faked at its HTTP edge: the
// real reader, transport, documents and registry, so what is sent is what an indexer would receive.

type Sent = { operation: string; query: string; variables: { where: Record<string, unknown>; after: unknown } }

const tx = (short: string) => `0x${short.padStart(64, '0')}`
const options: FeedOptions = { adapter: null, tokens: () => ({ symbol: 'USDC', stSymbol: 'stUSDC', decimals: 6 }) }
const page = (items: unknown[]) => ({ items, pageInfo: { hasNextPage: false, endCursor: null } })

const pay = (short: string, timestamp: number, amount: string, tokens: string) => ({
  chainId: CHAIN,
  projectId: 42,
  version: 6,
  txHash: tx(short),
  logIndex: 1,
  timestamp,
  caller: HOLDER,
  beneficiary: HOLDER,
  amount,
  newlyIssuedTokenCount: tokens,
})
const cashOut = (short: string, timestamp: number, reclaim: string, tokens: string) => ({
  chainId: CHAIN,
  projectId: 42,
  version: 6,
  txHash: tx(short),
  logIndex: 2,
  timestamp,
  caller: HOLDER,
  holder: HOLDER,
  beneficiary: HOLDER,
  cashOutCount: tokens,
  reclaimAmount: reclaim,
})

/** Answers Bendystraw's pays and cash outs like an indexer that honours `timestamp_gte`, and lists what it was sent. */
function indexer(pays: ReturnType<typeof pay>[], cashOuts: ReturnType<typeof cashOut>[]): Sent[] {
  const sent: Sent[] = []
  const since = (where: Record<string, unknown>) => (typeof where.timestamp_gte === 'number' ? where.timestamp_gte : 0)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query?: string; operation?: string; variables: Sent['variables'] }
      const query = body.query ?? (registry as Record<string, string>)[body.operation ?? '']
      const operation = /query (\w+)/.exec(query)![1]
      sent.push({ operation, query, variables: body.variables })
      const { where } = body.variables
      const answer =
        operation === 'StickyPays'
          ? { payEvents: page(pays.filter(row => row.timestamp >= since(where))) }
          : { cashOutTokensEvents: page(cashOuts.filter(row => row.timestamp >= since(where))) }
      return new Response(JSON.stringify({ data: answer }), { headers: { 'content-type': 'application/json' } })
    }),
  )
  return sent
}

const stickEvent = (short: string, count: bigint, timestamp: number): StickyEvent => ({
  kind: 'stick',
  chainId: CHAIN,
  projectId: 42n,
  holder: HOLDER,
  payer: HOLDER,
  count,
  balance: count,
  txHash: tx(short) as StickyEvent['txHash'],
  logIndex: 1,
  blockNumber: null,
  timestamp,
})

describe('terminalMoves against Bendystraw', () => {
  it('sends the time of the oldest shown event with both documents, and shows the amounts that come back', async () => {
    const sent = indexer(
      [pay('a1', 1_000, '5000000', '50'), pay('a2', 1_100, '7000000', '70'), pay('a0', 900, '1000000', '10')],
      [cashOut('a3', 1_200, '2000000', '20')],
    )
    const events = [stickEvent('a1', 50n, 1_000), stickEvent('a2', 70n, 1_100)]

    const rows = feedRows(events, await terminalMoves(events), options)

    expect(sent.map(({ operation, variables }) => [operation, variables.where]).sort()).toEqual([
      ['StickyCashOuts', { chainId: CHAIN, version: 6, projectId_in: [42], timestamp_gte: 1_000 }],
      ['StickyPays', { chainId: CHAIN, version: 6, projectId_in: [42], timestamp_gte: 1_000 }],
    ])
    expect(rows.map(({ amount }) => amount)).toEqual([
      { value: 7_000_000n, decimals: 6, symbol: 'USDC' },
      { value: 5_000_000n, decimals: 6, symbol: 'USDC' },
    ])
  })

  it('leaves the documents as registered: the time is a variable, not text in the query', async () => {
    const sent = indexer([], [])

    await terminalMoves([stickEvent('a1', 50n, 1_000)])

    expect(sent).toHaveLength(2)
    for (const { query } of sent) {
      expect(query).not.toContain('timestamp_gte')
      expect(Object.values(registry as Record<string, string>)).toContain(query)
    }
  })
})
