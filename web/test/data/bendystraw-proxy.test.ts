// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { POST } from '@/app/api/bendystraw/[net]/query/route'
import { compileBendystrawOperation } from '@/lib/bendystraw-operation'
import { bendystrawOperationId } from '@/lib/bendystraw-operation-id'
import registry from '@/lib/bendystraw-operation-registry.json'
import { resolvePersistedBendystrawRequest } from '@/lib/bendystraw-proxy'

// Two fixed documents stand in for the registry, so the relay is tested whatever the real registry holds.
const documents = vi.hoisted(() => ({
  project: `query RelayProject($chainId: Int!, $projectId: Int!) {
  project(chainId: $chainId, projectId: $projectId, version: 6) { projectId chainId }
}`,
  filtered: `query RelayFiltered($where: projectFilter!, $owners: [String!], $limit: Int = 10) {
  projects(where: $where, limit: $limit) { items { projectId } }
}`,
}))

vi.mock('@/lib/bendystraw-operation-registry.json', async () => {
  const { createHash } = await import('node:crypto')
  return {
    default: Object.fromEntries(
      Object.values(documents).map(document => [
        createHash('sha256').update(document, 'utf8').digest('hex'),
        document,
      ]),
    ),
  }
})

const MAX_BODY_BYTES = 32 * 1024
const RELAY_URL = 'https://sticky.center/api/bendystraw/mainnet/query'
const projectOperation = await bendystrawOperationId(documents.project)
const filteredOperation = await bendystrawOperationId(documents.filtered)

const network = (net: string) => ({ params: Promise.resolve({ net }) })

function relayRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request(RELAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** An indexer that answers every request with a fresh response from `answer`. */
function indexer(answer: () => Response) {
  const fetcher = vi.fn<typeof fetch>(async () => answer())
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

/** The relay refused: an error status and a message. Which error status is up to the route. */
async function expectRefused(response: Response) {
  expect(response.status).toBeGreaterThanOrEqual(400)
  expect(await response.json()).toEqual({ error: expect.any(String) })
}

/** `{ a: { a: … { a: 1 } } }`, `depth` objects deep. */
function nested(depth: number): unknown {
  let value: unknown = 1
  for (let level = 0; level < depth; level += 1) value = { a: value }
  return value
}

const owners = (count: number) =>
  Array.from({ length: count }, (_, id) => `owner${id}`)

const byteLength = (text: string) => new TextEncoder().encode(text).byteLength

/** A relay body of exactly `size` bytes: padding in a variable, made of single-byte or two-byte characters. */
function bodyOfBytes(size: number, character = 'x'): string {
  const shell = JSON.stringify({
    operation: projectOperation,
    variables: { padding: '' },
  })
  const padding = character.repeat(
    (size - byteLength(shell)) / byteLength(character),
  )
  return JSON.stringify({
    operation: projectOperation,
    variables: { padding },
  })
}

describe('persisted Bendystraw operations', () => {
  it('uses the document SHA-256 as its registered operation ID', () => {
    expect((registry as Record<string, string>)[projectOperation]).toBe(
      documents.project,
    )
    expect(projectOperation).toMatch(/^[a-f0-9]{64}$/)
  })

  it('registers the exact SHA-256 of every document the source uses', async () => {
    const source = await vi.importActual<{ default: Record<string, string> }>(
      '@/lib/bendystraw-operation-registry.json',
    )
    for (const [id, query] of Object.entries(source.default)) {
      expect(await bendystrawOperationId(query)).toBe(id)
      expect(() => compileBendystrawOperation(query)).not.toThrow()
    }
  })

  it('resolves a registered operation with its variables and nothing else', () => {
    const variables = { chainId: 8453, projectId: 11 }
    expect(
      resolvePersistedBendystrawRequest({
        operation: projectOperation,
        variables,
      }),
    ).toEqual({ query: documents.project, variables })

    for (const payload of [
      {
        operation: projectOperation,
        variables: {},
        query: 'query Attacker { projects { totalCount } }',
      },
      { operation: '0'.repeat(64), variables: {} },
      { operation: projectOperation.toUpperCase(), variables: {} },
      { operation: 'constructor', variables: {} },
      { operation: projectOperation },
      { operation: projectOperation, variables: [] },
      { operation: projectOperation, variables: null },
      { variables: {} },
      [],
      null,
      'query { projects { totalCount } }',
    ]) {
      expect(resolvePersistedBendystrawRequest(payload)).toBeNull()
    }
  })
})

describe('same-origin relay route', () => {
  it('rejects unsupported networks, non-JSON requests, unknown operations and unparseable or missing bodies', async () => {
    const status = async (request: Request, net = 'mainnet') =>
      (await POST(request, network(net))).status

    expect(await status(relayRequest({}), 'staging')).toBe(404)
    expect(await status(relayRequest({}), 'Mainnet')).toBe(404)
    expect(
      await status(
        relayRequest({}, { headers: { 'content-type': 'text/plain' } }),
      ),
    ).toBe(415)
    expect(
      await status(relayRequest({ operation: '0'.repeat(64), variables: {} })),
    ).toBe(400)
    expect(
      await status(relayRequest({ query: 'query { projects { totalCount } }' })),
    ).toBe(400)
    expect(await status(relayRequest(null, { body: '{"operation":' }))).toBe(400)
    expect(await status(relayRequest(null, { body: '' }))).toBe(400)
    expect(
      await status(
        new Request(RELAY_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('caps the body at 32 KiB, counted in bytes', async () => {
    const atLimit = bodyOfBytes(MAX_BODY_BYTES)
    const overByOne = bodyOfBytes(MAX_BODY_BYTES + 1)
    const twoByteCharacters = bodyOfBytes(MAX_BODY_BYTES + 1, 'é')
    expect([atLimit, overByOne, twoByteCharacters].map(byteLength)).toEqual([
      MAX_BODY_BYTES,
      MAX_BODY_BYTES + 1,
      MAX_BODY_BYTES + 1,
    ])
    expect(twoByteCharacters.length).toBeLessThan(MAX_BODY_BYTES)

    const send = (body: string) =>
      POST(relayRequest(null, { body }), network('mainnet'))

    // At the cap the body is read and judged on its content: its padding is not a variable the operation declares.
    expect((await send(atLimit)).status).not.toBe(413)
    for (const body of [overByOne, twoByteCharacters]) {
      const refused = await send(body)
      expect(refused.status).toBe(413)
      expect(await refused.json()).toEqual({ error: 'request is too large' })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a declared size over the cap without reading the body', async () => {
    const request = relayRequest(
      { operation: projectOperation, variables: {} },
      {
        headers: {
          'content-type': 'application/json',
          'content-length': String(MAX_BODY_BYTES + 1),
        },
      },
    )
    const readBody = vi.spyOn(request.body!, 'getReader')

    expect((await POST(request, network('mainnet'))).status).toBe(413)
    expect(readBody).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stops reading a stream that grows past the cap', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(16 * 1024))
      },
      cancel() {
        cancelled = true
      },
    })
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    }

    const response = await POST(new Request(RELAY_URL, init), network('mainnet'))

    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['a value of the wrong type', projectOperation, { chainId: 'eleven', projectId: 11 }],
    ['a fractional Int', projectOperation, { chainId: 8453, projectId: 1.5 }],
    ['a missing required variable', projectOperation, { chainId: 8453 }],
    ['a null required variable', projectOperation, { chainId: 8453, projectId: null }],
    ['a variable the operation does not declare', projectOperation, { chainId: 8453, projectId: 11, extra: 1 }],
    ['a list of the wrong element type', filteredOperation, { where: {}, owners: [1] }],
    ['an object nested 12 levels deep', filteredOperation, { where: nested(12) }],
    ['a string over 16,384 characters', filteredOperation, { where: { name: 'x'.repeat(16_385) } }],
    ['a list over 1,000 items', filteredOperation, { where: {}, owners: owners(1_001) }],
    ['an object over 250 fields', filteredOperation, { where: Object.fromEntries(Array.from({ length: 251 }, (_, id) => [`field${id}`, id])) }],
  ])('refuses %s, without asking the indexer', async (_name, operation, variables) => {
    const fetcher = indexer(() => json({ data: { project: null, projects: { items: [] } } }))

    const response = await POST(relayRequest({ operation, variables }), network('mainnet'))

    await expectRefused(response)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('forwards variables that fit their declared types, filters included, up to the bounds', async () => {
    const fetcher = indexer(() => json({ data: { projects: { items: [] } } }))
    const variables = {
      where: { AND: [{ chainId: 8453 }, { name_contains: 'x'.repeat(16_384) }] },
      owners: owners(1_000),
      limit: 5,
    }

    const response = await POST(
      relayRequest({ operation: filteredOperation, variables }),
      network('mainnet'),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { projects: { items: [] } } })
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      query: documents.filtered,
      variables,
      operationName: 'RelayFiltered',
    })

    const deepest = { where: nested(11) }
    const deep = await POST(
      relayRequest({ operation: filteredOperation, variables: deepest }),
      network('mainnet'),
    )
    expect(deep.status).toBe(200)
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).variables).toEqual(
      deepest,
    )
  })

  it('sends a registered operation to the indexer of its own network and answers only the data, with no-store headers', async () => {
    const fetcher = indexer(() =>
      json({ data: { project: null }, extensions: { trace: 'internal' } }),
    )
    const variables = { chainId: 84532, projectId: 11 }

    const testnet = await POST(
      relayRequest({ operation: projectOperation, variables }),
      network('testnet'),
    )

    expect(testnet.status).toBe(200)
    expect(testnet.headers.get('cache-control')).toBe('no-store')
    expect(testnet.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await testnet.json()).toEqual({ data: { project: null } })
    expect(fetcher.mock.calls[0][0]).toBe('https://testnet.bendystraw.xyz/graphql')
    expect(fetcher.mock.calls[0][1]?.method).toBe('POST')
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      query: documents.project,
      variables,
      operationName: 'RelayProject',
    })

    await POST(
      relayRequest({
        operation: projectOperation,
        variables: { chainId: 8453, projectId: 11 },
      }),
      network('mainnet'),
    )
    expect(fetcher.mock.calls[1][0]).toBe('https://bendystraw.up.railway.app/graphql')
  })

  it('does not send a chain of one network to the indexer of the other', async () => {
    const fetcher = indexer(() => json({ data: { project: null } }))

    const response = await POST(
      relayRequest({
        operation: projectOperation,
        variables: { chainId: 84532, projectId: 11 },
      }),
      network('mainnet'),
    )

    await expectRefused(response)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    ['an HTTP error', () => json({ message: 'pg relation "secret_table" at 10.0.0.7:5432' }, 403)],
    ['a GraphQL error', () => json({ errors: [{ message: 'relation "secret_table" does not exist' }] })],
    ['an answer with no data', () => json({})],
    ['null data', () => json({ data: null })],
    ['data without the selected fields', () => json({ data: {} })],
    ['a project without its fields', () => json({ data: { project: {} } })],
    ['a body that is not JSON', () => new Response('<html>secret_table</html>', { headers: { 'content-type': 'application/json' } })],
    ['a body not marked as JSON', () => new Response('{"data":{"project":null}}', { headers: { 'content-type': 'text/html' } })],
  ])('answers 502 and only that when the indexer sends %s', async (_name, answer) => {
    indexer(answer)

    const response = await POST(
      relayRequest({
        operation: projectOperation,
        variables: { chainId: 8453, projectId: 11 },
      }),
      network('mainnet'),
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'Bendystraw unavailable' })
  })

  it('answers 502, not an empty result, when the indexer stays down through the retries', async () => {
    const fetcher = indexer(() => new Response('Offline', { status: 503 }))

    const response = await POST(
      relayRequest({
        operation: projectOperation,
        variables: { chainId: 8453, projectId: 11 },
      }),
      network('mainnet'),
    )

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'Bendystraw unavailable' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})
