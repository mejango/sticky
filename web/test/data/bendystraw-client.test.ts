// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { bendystraw, normalizeBendystrawUrl } from '@/lib/bendystraw'
import { bendystrawOperationId } from '@/lib/bendystraw-operation-id'

const PROJECT = `query ClientProject($chainId: Int!, $projectId: Int!) {
  project(chainId: $chainId, projectId: $projectId, version: 6) { projectId chainId }
}`
const FILTERED = `query ClientFiltered($where: projectFilter!) {
  projects(where: $where) { items { projectId } }
}`
const STATUS = `query ClientStatus {
  _meta { status }
}`

const MAINNET = 'https://bendystraw.up.railway.app/graphql'
const TESTNET = 'https://testnet.bendystraw.xyz/graphql'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function indexer(body: unknown = { data: { project: null } }) {
  const fetcher = vi.fn<typeof fetch>(async () => response(body))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

function sentBody(fetcher: ReturnType<typeof indexer>, call = 0) {
  return JSON.parse(String(fetcher.mock.calls[call][1]?.body)) as {
    query?: string
    variables: Record<string, unknown>
    operation?: string
    operationName?: string
  }
}

describe('the Bendystraw transport on the server', () => {
  it('normalizes an origin or an endpoint to one GraphQL URL', () => {
    expect(normalizeBendystrawUrl('https://index.example')).toBe(
      'https://index.example/graphql',
    )
    expect(
      normalizeBendystrawUrl(' https://index.example/base/graphql/?key=ignored#fragment '),
    ).toBe('https://index.example/base/graphql')
    expect(() => normalizeBendystrawUrl('ftp://index.example')).toThrow(
      'HTTP or HTTPS',
    )
  })

  it('posts the document with its variables and name, and returns only the data', async () => {
    const fetcher = indexer({
      data: { project: { projectId: 11, chainId: 8453 } },
      extensions: { trace: 'internal' },
    })
    const variables = { chainId: 8453, projectId: 11 }

    await expect(bendystraw(PROJECT, variables)).resolves.toEqual({
      project: { projectId: 11, chainId: 8453 },
    })

    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]
    expect(url).toBe(MAINNET)
    expect(init?.method).toBe('POST')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(sentBody(fetcher)).toEqual({
      query: PROJECT,
      variables,
      operationName: 'ClientProject',
    })
  })

  it('gives each cache policy its own revalidate time, stable by default', async () => {
    const fetcher = indexer()
    const variables = { chainId: 8453, projectId: 11 }

    await bendystraw(PROJECT, variables, { policy: 'live' })
    await bendystraw(PROJECT, variables, { policy: 'standard' })
    await bendystraw(PROJECT, variables, { policy: 'stable' })
    await bendystraw(PROJECT, variables)

    expect(
      fetcher.mock.calls.map(([, init]) => (init as { next?: unknown }).next),
    ).toEqual([
      { revalidate: 15 },
      { revalidate: 30 },
      { revalidate: 60 },
      { revalidate: 60 },
    ])
  })

  it('routes to the indexer of the network a chain belongs to', async () => {
    const fetcher = indexer({ data: { project: null, projects: { items: [] } } })

    await bendystraw(PROJECT, { chainId: 84532, projectId: 11 })
    await bendystraw(PROJECT, { chainId: 8453, projectId: 11 })
    await bendystraw(FILTERED, { where: { chainId_in: [84532, 11155111] } })
    await bendystraw(FILTERED, { where: { AND: [{ chainId: 10 }] } })

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      TESTNET,
      MAINNET,
      TESTNET,
      MAINNET,
    ])
  })

  it('routes a query that carries no chain by the options, mainnet by default', async () => {
    const fetcher = indexer({ data: { _meta: { status: {} } } })

    await bendystraw(STATUS, {}, { network: 'testnet' })
    await bendystraw(STATUS, {}, { network: 'mainnet' })
    await bendystraw(STATUS, {}, { chainId: 84532 })
    await bendystraw(STATUS, {})

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      TESTNET,
      MAINNET,
      TESTNET,
      MAINNET,
    ])
  })

  it('fails closed instead of reaching the wrong indexer', async () => {
    const fetcher = indexer()

    await expect(
      bendystraw(FILTERED, { where: { chainId_in: [8453, 84532] } }),
    ).rejects.toThrow('cannot mix mainnet and testnet')
    await expect(
      bendystraw(PROJECT, { chainId: 84532, projectId: 11 }, { network: 'mainnet' }),
    ).rejects.toThrow('conflicts with testnet')
    await expect(
      bendystraw(PROJECT, { chainId: 999_999, projectId: 11 }),
    ).rejects.toThrow('Unsupported Bendystraw chain ID')
    await expect(
      bendystraw(PROJECT, { chainId: 0, projectId: 11 }),
    ).rejects.toThrow('Invalid Bendystraw chainId')

    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects HTTP, GraphQL, missing-data, malformed-shape and variable failures', async () => {
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    const variables = { chainId: 8453, projectId: 11 }

    fetcher.mockImplementation(async () => response({}, 503))
    await expect(bendystraw(PROJECT, variables)).rejects.toThrow(
      'Bendystraw request failed (503)',
    )
    fetcher.mockImplementation(async () =>
      response({ errors: [{ message: 'schema mismatch' }] }),
    )
    await expect(bendystraw(PROJECT, variables)).rejects.toThrow(
      'schema mismatch',
    )
    fetcher.mockImplementation(async () => response({}))
    await expect(bendystraw(PROJECT, variables)).rejects.toThrow('missing data')
    fetcher.mockImplementation(async () => response({ data: null }))
    await expect(bendystraw(PROJECT, variables)).rejects.toThrow(
      'ClientProject returned invalid data',
    )
    fetcher.mockImplementation(async () => response({ data: {} }))
    await expect(bendystraw(PROJECT, variables)).rejects.toThrow(
      'ClientProject returned invalid data',
    )
    fetcher.mockImplementation(async () => response({ data: { project: {} } }))
    await expect(bendystraw(PROJECT, variables)).rejects.toThrow(
      'ClientProject returned invalid data',
    )
    fetcher.mockClear()

    await expect(
      bendystraw(PROJECT, { chainId: 8453, projectId: 'eleven' }),
    ).rejects.toThrow('ClientProject received invalid variables')
    await expect(
      bendystraw(PROJECT, { chainId: 8453, projectId: 11, extra: true }),
    ).rejects.toThrow('ClientProject received invalid variables')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('accepts an empty list and a null project as answers, not as failures', async () => {
    indexer({ data: { project: null, projects: { items: [] } } })

    await expect(
      bendystraw(PROJECT, { chainId: 8453, projectId: 11 }),
    ).resolves.toEqual({ project: null, projects: { items: [] } })
  })
})

describe('the Bendystraw transport in the browser', () => {
  it('posts only the operation ID and variables to this site, on the network of the chain', async () => {
    vi.stubGlobal('window', {})
    const fetcher = indexer({ data: { project: null } })
    const operation = await bendystrawOperationId(PROJECT)

    await bendystraw(PROJECT, { chainId: 8453, projectId: 11 })
    await bendystraw(PROJECT, { chainId: 84532, projectId: 11 })

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/api/bendystraw/mainnet/query',
      '/api/bendystraw/testnet/query',
    ])
    expect(sentBody(fetcher)).toEqual({
      operation,
      variables: { chainId: 8453, projectId: 11 },
    })
    expect(Object.keys(sentBody(fetcher, 1)).sort()).toEqual([
      'operation',
      'variables',
    ])
    expect(operation).toMatch(/^[a-f0-9]{64}$/)
    expect(fetcher.mock.calls[0][1]?.cache).toBe('no-store')
    expect(fetcher.mock.calls[0][1]?.method).toBe('POST')
  })

  it('returns what the relay answers, validated against the document', async () => {
    vi.stubGlobal('window', {})
    const fetcher = indexer({ data: { project: { projectId: 11, chainId: 8453 } } })

    await expect(
      bendystraw(PROJECT, { chainId: 8453, projectId: 11 }),
    ).resolves.toEqual({ project: { projectId: 11, chainId: 8453 } })

    fetcher.mockImplementation(async () => response({ data: { project: {} } }))
    await expect(
      bendystraw(PROJECT, { chainId: 8453, projectId: 11 }),
    ).rejects.toThrow('ClientProject returned invalid data')
    fetcher.mockImplementation(async () => response({ error: 'unknown or invalid operation' }, 400))
    await expect(
      bendystraw(PROJECT, { chainId: 8453, projectId: 11 }),
    ).rejects.toThrow('Bendystraw request failed (400)')
  })

  it('does not call the relay with variables the document does not declare', async () => {
    vi.stubGlobal('window', {})
    const fetcher = indexer()

    await expect(
      bendystraw(PROJECT, { chainId: 8453, projectId: 'eleven' }),
    ).rejects.toThrow('ClientProject received invalid variables')

    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('the indexer origins', () => {
  it('come from the environment, one per network', async () => {
    vi.stubEnv('NEXT_PUBLIC_BENDYSTRAW_URL', 'https://index.example/base')
    vi.stubEnv('NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL', 'https://testnet-index.example')
    vi.resetModules()
    const configured = await import('@/lib/bendystraw')
    const fetcher = indexer()

    await configured.bendystraw(PROJECT, { chainId: 8453, projectId: 11 })
    await configured.bendystraw(PROJECT, { chainId: 84532, projectId: 11 })

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'https://index.example/base/graphql',
      'https://testnet-index.example/graphql',
    ])
  })

  it('fall back to the production indexers when a variable is blank, as `.env.example` leaves it', async () => {
    vi.stubEnv('NEXT_PUBLIC_BENDYSTRAW_URL', '')
    vi.stubEnv('NEXT_PUBLIC_TESTNET_BENDYSTRAW_URL', '')
    vi.resetModules()
    const blank = await import('@/lib/bendystraw')
    const fetcher = indexer()

    await blank.bendystraw(PROJECT, { chainId: 8453, projectId: 11 })
    await blank.bendystraw(PROJECT, { chainId: 84532, projectId: 11 })

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([MAINNET, TESTNET])
  })

  it('both go to the fixture server of a deterministic browser build', async () => {
    vi.stubEnv('BROWSER_BUILD_FIXTURE_ORIGIN', 'http://127.0.0.1:4010')
    vi.stubEnv('NEXT_PUBLIC_DETERMINISTIC_BROWSER', 'true')
    vi.resetModules()
    const fixtures = await import('@/lib/bendystraw')
    const fetcher = indexer()

    await fixtures.bendystraw(PROJECT, { chainId: 8453, projectId: 11 })
    await fixtures.bendystraw(PROJECT, { chainId: 84532, projectId: 11 })

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:4010/graphql',
      'http://127.0.0.1:4010/graphql',
    ])
    expect(
      fetcher.mock.calls.map(([, init]) => (init as { next?: unknown }).next),
    ).toEqual([{ revalidate: 1 }, { revalidate: 1 }])
  })
})
