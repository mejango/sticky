import { fixtureOrigin } from '../../scripts/browser-env.mjs'

type FixtureStatus = {
  graphql: Record<string, number>
  rpc: Record<string, number>
  multicallBatches: number
  unknown: { kind: string; detail: string }[]
}

function missingReads(
  actual: Record<string, number>,
  required: readonly string[],
) {
  return required.filter(key => !Number.isInteger(actual[key]) || actual[key] < 1)
}

export default async function globalTeardown() {
  const response = await fetch(`${fixtureOrigin}/__fixture/status`, {
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) {
    throw new Error(`Fixture audit endpoint returned HTTP ${response.status}`)
  }

  const status = (await response.json()) as FixtureStatus
  const missingGraphql = missingReads(status.graphql, [
    'StickyIndex',
    'StickyPays',
    'StickyCashOuts',
  ])
  const missingRpc = missingReads(status.rpc, [
    'eth_blockNumber',
    'eth_call',
    'eth_getLogs',
  ])
  const failures = [
    status.unknown.length
      ? `unexpected fixture requests: ${JSON.stringify(status.unknown, null, 2)}`
      : '',
    missingGraphql.length
      ? `required GraphQL reads were not observed: ${missingGraphql.join(', ')}`
      : '',
    missingRpc.length
      ? `required JSON-RPC reads were not observed: ${missingRpc.join(', ')}`
      : '',
    status.multicallBatches < 1
      ? 'required Multicall3 batching was not observed'
      : '',
  ].filter(Boolean)

  if (failures.length) {
    throw new Error(`Deterministic fixture audit failed:\n${failures.join('\n')}`)
  }
}
