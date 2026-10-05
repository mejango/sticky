// @vitest-environment node

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tailOverlap } from '@/lib/sticky-events'

/**
 * The browser suite's fixture is recorded from the live services in one run: each chain's head, and Bendystraw's
 * answers, each with the block of every chain it is indexed through. A tail reads from `tailOverlap` blocks below that
 * block to the head the fixture pins, so an answer recorded once the head had moved on by the overlap or more would
 * start its tails past the head, and the suite would read none. Every answer's block is checked against its chain's
 * head, here, where the overlap's rule is the site's own.
 */

type Status = Record<string, { id: number; block: { number: number } }>
type Fixture = {
  heads: Record<string, string>
  graphql: Record<string, { data?: { _meta?: { status?: Status } } | null }>
}

/** Each chain an answer is indexed through as far as its pinned head plus its overlap, or further. */
function pastTheHeads(fixture: Fixture): { answer: string; chainId: number; ahead: number }[] {
  return Object.entries(fixture.graphql).flatMap(([answer, { data }]) =>
    Object.values(data?._meta?.status ?? {}).flatMap(({ id, block }) => {
      const head = fixture.heads[String(id)]
      if (head === undefined) return []
      const ahead = BigInt(block.number) - BigInt(head)
      return ahead < tailOverlap(id) ? [] : [{ answer, chainId: id, ahead: Number(ahead) }]
    }),
  )
}

const recorded = JSON.parse(readFileSync('test/browser/fixtures/sticky.json', 'utf8')) as Fixture

describe('the browser fixture', () => {
  it('pins every chain\'s head within its overlap of the block each of Bendystraw\'s answers is indexed through', () => {
    const statuses = Object.values(recorded.graphql).filter(({ data }) => data?._meta?.status)
    // A floor, so a check that found no answer would not pass.
    expect(statuses.length).toBeGreaterThanOrEqual(10)
    expect(pastTheHeads(recorded)).toEqual([])
  })

  it('tells an answer within the overlap from one at it, on each chain\'s own overlap', () => {
    const fixture = (chainId: number, ahead: number): Fixture => ({
      heads: { [chainId]: '0x3e8' },
      graphql: { answer: { data: { _meta: { status: { chain: { id: chainId, block: { number: 1_000 + ahead } } } } } } },
    })
    expect(pastTheHeads(fixture(421614, 239))).toEqual([])
    expect(pastTheHeads(fixture(421614, 240))).toEqual([{ answer: 'answer', chainId: 421614, ahead: 240 }])
    expect(pastTheHeads(fixture(84532, 63))).toEqual([])
    expect(pastTheHeads(fixture(84532, 64))).toEqual([{ answer: 'answer', chainId: 84532, ahead: 64 }])
    // A chain the fixture pins no head of is not one the suite reads.
    expect(pastTheHeads({ ...fixture(84532, 64), heads: {} })).toEqual([])
  })
})
