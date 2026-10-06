// @vitest-environment node

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tailOverlap } from '@/lib/sticky-events'

/**
 * The browser suite's fixture is recorded from the live services in one run: each chain's head, and Bendystraw's
 * answers, each with the block of every chain it is indexed through. A tail reads from `tailOverlap` blocks below that
 * block to the head the fixture pins, so an answer recorded once the head had moved on by the overlap or more would
 * start its tails past the head, and the suite would read none. Every answer's block is checked against the head kept
 * under its chain's id, here, where the overlap's rule is the site's own; a chain with none fails.
 */

type Status = Record<string, { id: number; block: { number: number } }>
type Fixture = {
  heads: Record<string, string>
  graphql: Record<string, { data?: { _meta?: { status?: Status } } | null }>
}

/** Every chain of every answer against the head the fixture pins for that chain id: how many were compared, and each
 * that is its chain's overlap or more past the head, or has no head kept by its chain id. */
type Wrong = { answer: string; chainId: number; ahead: number | 'no head' }

function againstTheHeads(fixture: Fixture): { compared: number; wrong: Wrong[] } {
  let compared = 0
  const wrong = Object.entries(fixture.graphql).flatMap(([answer, { data }]) =>
    Object.values(data?._meta?.status ?? {}).flatMap(({ id, block }): Wrong[] => {
      const head = fixture.heads[String(id)]
      if (head === undefined) return [{ answer, chainId: id, ahead: 'no head' }]
      compared += 1
      const ahead = BigInt(block.number) - BigInt(head)
      return ahead < tailOverlap(id) ? [] : [{ answer, chainId: id, ahead: Number(ahead) }]
    }),
  )
  return { compared, wrong }
}

const recorded = JSON.parse(readFileSync('test/browser/fixtures/sticky.json', 'utf8')) as Fixture

describe('the browser fixture', () => {
  it('pins every chain\'s head within its overlap of the block each of Bendystraw\'s answers is indexed through', () => {
    const { compared, wrong } = againstTheHeads(recorded)
    // A floor, so a check that compared nothing would not pass: ten answers' four chains.
    expect(compared).toBeGreaterThanOrEqual(40)
    expect(wrong).toEqual([])
  })

  it('tells an answer within the overlap from one at it, on each chain\'s own overlap, and fails a chain with no head', () => {
    const fixture = (chainId: number, ahead: number): Fixture => ({
      heads: { [chainId]: '0x3e8' },
      graphql: { answer: { data: { _meta: { status: { chain: { id: chainId, block: { number: 1_000 + ahead } } } } } } },
    })
    expect(againstTheHeads(fixture(421614, 239))).toEqual({ compared: 1, wrong: [] })
    expect(againstTheHeads(fixture(421614, 240))).toEqual({ compared: 1, wrong: [{ answer: 'answer', chainId: 421614, ahead: 240 }] })
    expect(againstTheHeads(fixture(84532, 63))).toEqual({ compared: 1, wrong: [] })
    expect(againstTheHeads(fixture(84532, 64))).toEqual({ compared: 1, wrong: [{ answer: 'answer', chainId: 84532, ahead: 64 }] })
    // Heads must be kept by chain id: one kept by another key is no head, and fails rather than going unchecked.
    expect(againstTheHeads({ ...fixture(84532, 0), heads: { baseSepolia: '0x3e8' } })).toEqual({
      compared: 0,
      wrong: [{ answer: 'answer', chainId: 84532, ahead: 'no head' }],
    })
  })
})
