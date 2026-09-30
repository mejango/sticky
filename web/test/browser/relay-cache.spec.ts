import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { deterministicEnv, fixtureOrigin } from '../../scripts/browser-env.mjs'
import registry from '../../src/lib/bendystraw-operation-registry.json'

// The Bendystraw relay asks the indexer with `cache: 'no-store'` (ruling R49),
// and a route handler's POST is not deduplicated either: each of N identical
// requests reaches the indexer, and Next keeps none of the answers.

const REQUESTS = 5
// An owner no Sticky page asks about, so only this spec's requests count.
const OWNER = '0x000000000000000000000000000000000000dead'
const [operation] = Object.entries(registry).find(([, document]) =>
  document.startsWith('query StickyIndex('),
)!
// The standalone server's own copy of the dist directory, where Next keeps its
// fetch cache at run time.
const dist = deterministicEnv.NEXT_DIST_DIR
const served = join(dist, 'standalone', dist)
const fetchCache = join(served, 'cache', 'fetch-cache')

async function indexerAnswers(): Promise<number> {
  const response = await fetch(`${fixtureOrigin}/__fixture/status`)
  const status = (await response.json()) as { graphqlRequests: Record<string, number> }
  return Object.entries(status.graphqlRequests)
    .filter(([key]) => key.startsWith('testnet StickyIndex ') && key.includes(OWNER))
    .reduce((sum, [, count]) => sum + count, 0)
}

test('identical relay requests each reach the indexer, and none is cached', async ({ request }) => {
  expect(existsSync(join(served, 'BUILD_ID')), 'the suite serves this build').toBe(true)
  const before = await indexerAnswers()

  const answers = await Promise.all(
    Array.from({ length: REQUESTS }, () =>
      request.post('/api/bendystraw/testnet/query', {
        data: { operation, variables: { owners: [OWNER] } },
      }),
    ),
  )
  for (const answer of answers) {
    expect(answer.status()).toBe(200)
    expect(answer.headers()['cache-control']).toBe('no-store')
    const { data } = await answer.json()
    expect(data.projects.items).toEqual([])
  }

  expect(await indexerAnswers(), 'every request reached the indexer').toBe(before + REQUESTS)
  expect(existsSync(fetchCache) ? readdirSync(fetchCache) : [], 'Next kept no answer').toEqual([])
})
