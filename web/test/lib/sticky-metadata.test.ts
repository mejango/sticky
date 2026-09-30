import { getAddress, type Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stickyDeployment } from '@/lib/sticky-addresses'
import {
  IPFS_GATEWAY,
  assetUrl,
  ipfsGatewayUrl,
  metadataOfUri,
  parseStickyUri,
} from '@/lib/sticky-metadata'

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))

const CHAIN = 84532
const deployment = stickyDeployment(CHAIN)!
const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`)
const TOKENS = address('7')
const STAKED = address('2')
const LAUNCH = '11111111-2222-4333-8444-555555555555'

const inline = (metadata: unknown) =>
  `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(metadata))}`
const launchUri = (extra: Record<string, unknown> = {}) =>
  inline({ protocol: 'Sticky', version: 1, launchId: LAUNCH, environment: 'testnet', chains: [84532, 11155420], ...extra })

afterEach(() => vi.useRealTimers())

describe('assetUrl', () => {
  // The old client's runtime.test.cjs, "metadata image URLs cannot inject markup or execute scripts", less
  // the local file names its demo mode allowed.
  it.each([
    ['javascript:alert(1)', null],
    ['data:image/svg+xml,<svg onload="alert(1)">', null],
    ['data:image/png;base64,AAAA', null],
    ['https://user:secret@example.com/logo', null],
    ['https://user@example.com/logo', null],
    ['http://example.com/logo.png', null],
    ['ftp://example.com/logo.png', null],
    ['artizen.jpg', null],
    ['../private.png', null],
    ['//evil.example/a.png', null],
    ['', null],
    ['ipfs://ipfs/bafy/logo.png', 'https://juicebox.center/ipfs/bafy/logo.png'],
    ['ipfs://bafy/logo.png', 'https://juicebox.center/ipfs/bafy/logo.png'],
    ['https://example.com/logo.png', 'https://example.com/logo.png'],
    ['HTTPS://EXAMPLE.COM/Logo.png', 'https://example.com/Logo.png'],
    ['https://example.com/" onerror="alert(1)', 'https://example.com/%22%20onerror=%22alert(1)'],
  ])('reads %j as %j', (value, expected) => {
    expect(assetUrl(value)).toBe(expected)
  })

  it('reads anything that is not a string, or is longer than 8,192 characters, as no URL', () => {
    expect(assetUrl(undefined)).toBeNull()
    expect(assetUrl(null)).toBeNull()
    expect(assetUrl(42 as never)).toBeNull()
    expect(assetUrl({ href: 'https://example.com/a.png' } as never)).toBeNull()
    expect(assetUrl(`https://example.com/${'a'.repeat(8_172)}`)).not.toBeNull()
    expect(assetUrl(`https://example.com/${'a'.repeat(8_173)}`)).toBeNull()
  })
})

describe('ipfsGatewayUrl', () => {
  it('maps an ipfs:// uri to Center\'s gateway, dropping the legacy leading ipfs/ segment', () => {
    expect(IPFS_GATEWAY).toBe('https://juicebox.center/ipfs/')
    expect(ipfsGatewayUrl('ipfs://bafybeigdyrzt')).toBe('https://juicebox.center/ipfs/bafybeigdyrzt')
    expect(ipfsGatewayUrl('ipfs://ipfs/bafybeigdyrzt/logo.png')).toBe('https://juicebox.center/ipfs/bafybeigdyrzt/logo.png')
    expect(ipfsGatewayUrl('IPFS://bafybeigdyrzt')).toBe('https://juicebox.center/ipfs/bafybeigdyrzt')
    expect(ipfsGatewayUrl('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a_b-c.d~e')).toBe(
      'https://juicebox.center/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/a_b-c.d~e',
    )
  })

  it.each([
    ['not an ipfs uri', 'https://juicebox.center/ipfs/bafy'],
    ['a bare CID', 'bafybeigdyrzt'],
    ['a data uri', 'data:application/json,%7B%7D'],
    ['nothing after the scheme', 'ipfs://'],
    ['only the legacy segment', 'ipfs://ipfs/'],
    ['an empty segment', 'ipfs://bafy//logo.png'],
    ['a trailing slash', 'ipfs://bafy/'],
    ['a dot segment', 'ipfs://bafy/./logo.png'],
    ['a parent segment that would leave the gateway path', 'ipfs://../../api/x'],
    ['a parent segment after the CID', 'ipfs://bafy/../x'],
    ['a percent escape', 'ipfs://bafy/%2e%2e/x'],
    ['a query', 'ipfs://bafy/logo.png?download=1'],
    ['a fragment', 'ipfs://bafy/logo.png#top'],
    ['a space', 'ipfs://bafy/my logo.png'],
    ['a backslash', 'ipfs://bafy\\..\\x'],
    ['an authority', 'ipfs://user:pass@evil.example/x'],
    ['a segment of 129 characters', `ipfs://${'a'.repeat(129)}`],
    ['nine segments', 'ipfs://a/b/c/d/e/f/g/h/i'],
  ])('refuses %s', (_what, uri) => {
    expect(ipfsGatewayUrl(uri)).toBeNull()
  })

  it('takes a segment of 128 characters and eight segments', () => {
    expect(ipfsGatewayUrl(`ipfs://${'a'.repeat(128)}`)).toBe(`https://juicebox.center/ipfs/${'a'.repeat(128)}`)
    expect(ipfsGatewayUrl('ipfs://a/b/c/d/e/f/g/h')).toBe('https://juicebox.center/ipfs/a/b/c/d/e/f/g/h')
  })
})

describe('parseStickyUri', () => {
  it('reads the launch a Sticky project\'s data uri carries', () => {
    expect(parseStickyUri(launchUri())).toEqual({ protocol: 'Sticky', launchId: LAUNCH, chains: [84532, 11155420] })
  })

  it('reads a base64 data uri as well as a percent-encoded one', () => {
    const base64 = `data:application/json;base64,${Buffer.from(JSON.stringify({ protocol: 'Sticky', launchId: LAUNCH, chains: [8453] })).toString('base64')}`
    expect(parseStickyUri(base64)).toEqual({ protocol: 'Sticky', launchId: LAUNCH, chains: [8453] })
  })

  it.each([
    ['another protocol', inline({ protocol: 'Other', launchId: LAUNCH, chains: [8453] })],
    ['no protocol', inline({ launchId: LAUNCH })],
    ['json that is not an object', 'data:application/json,%5B1%5D'],
    ['json that is null', 'data:application/json,null'],
    ['a data uri that is not json', 'data:application/json,not-json'],
    ['a malformed percent escape', 'data:application/json,%E0%A4%A'],
    ['no payload', 'data:application/json'],
    ['a uri that is not a data uri', 'ipfs://bafybeigdyrzt'],
    ['a data uri of another type', 'data:text/plain,hello'],
  ])('reads %s as no Sticky launch', (_what, uri) => {
    expect(parseStickyUri(uri)).toBeNull()
  })

  it('keeps a launch id only when it is a non-empty string, and chains only when they are whole chain ids', () => {
    expect(parseStickyUri(launchUri({ launchId: 12 }))).toMatchObject({ launchId: null })
    expect(parseStickyUri(launchUri({ launchId: '' }))).toMatchObject({ launchId: null })
    expect(parseStickyUri(inline({ protocol: 'Sticky' }))).toEqual({ protocol: 'Sticky', launchId: null, chains: null })
    expect(parseStickyUri(launchUri({ chains: [8453, '10', 8453, 0, -1, 1.5, 'x', null, 2 ** 60] }))).toMatchObject({
      chains: [8453, 10],
    })
    expect(parseStickyUri(launchUri({ chains: [] }))).toMatchObject({ chains: null })
    expect(parseStickyUri(launchUri({ chains: 'all' }))).toMatchObject({ chains: null })
  })

  it('keeps a launch id of 128 characters and leaves out one of 129, with the chains it comes with', () => {
    expect(parseStickyUri(launchUri({ launchId: 'a'.repeat(128) }))).toEqual({
      protocol: 'Sticky',
      launchId: 'a'.repeat(128),
      chains: [84532, 11155420],
    })
    expect(parseStickyUri(launchUri({ launchId: 'a'.repeat(129) }))).toEqual({
      protocol: 'Sticky',
      launchId: null,
      chains: [84532, 11155420],
    })
    expect(parseStickyUri(launchUri({ launchId: 'a'.repeat(999_000) }))?.launchId).toBeNull()
  })

  it('lists at most 32 chains', () => {
    const many = Array.from({ length: 100 }, (_, index) => index + 1)
    expect(parseStickyUri(launchUri({ chains: many }))?.chains).toEqual(many.slice(0, 32))
  })
})

/** What a fetch of an IPFS document answers with, and what it was asked. */
function gateway(reply: () => Response | Promise<Response>) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    return reply()
  })
  return { fetcher: fetcher as unknown as typeof fetch, calls: fetcher.mock.calls }
}
const json = (value: unknown, status = 200) => () => new Response(JSON.stringify(value), { status })

const CID = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const CID_URL = `https://juicebox.center/ipfs/${CID.slice('ipfs://'.length)}`

describe('metadataOfUri', () => {
  it('fetches an ipfs document through the gateway, with no credentials and no referrer', async () => {
    const { fetcher, calls } = gateway(json({ name: 'Artizen', logoUri: 'ipfs://bafylogo/logo.png' }))

    await metadataOfUri(CID, { fetch: fetcher })

    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe(CID_URL)
    expect(calls[0][1]).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
  })

  it('keeps a document\'s name and its logo\'s gateway URL, and nothing else of it', async () => {
    const { fetcher } = gateway(
      json({
        name: 'Artizen',
        logoUri: 'ipfs://bafylogo/logo.png',
        description: 'x'.repeat(50_000),
        infoUri: 'https://artizen.example',
        payDisclosure: '<script>alert(1)</script>',
      }),
    )
    expect(await metadataOfUri(CID, { fetch: fetcher })).toEqual({
      name: 'Artizen',
      logoUri: 'https://juicebox.center/ipfs/bafylogo/logo.png',
    })
  })

  it('reads no launch from a fetched document, whatever it says: only a data uri is a launch\'s', async () => {
    const { fetcher } = gateway(
      json({ protocol: 'Sticky', launchId: LAUNCH, chains: [8453], name: 'Sticky', logoUri: 'ipfs://bafylogo' }),
    )
    expect(await metadataOfUri(CID, { fetch: fetcher })).toEqual({
      name: 'Sticky',
      logoUri: 'https://juicebox.center/ipfs/bafylogo',
    })
    const { fetcher: large } = gateway(json({ protocol: 'Sticky', launchId: 'x'.repeat(500_000), chains: [8453] }))
    expect(await metadataOfUri(CID, { fetch: large })).toEqual({})
  })

  it.each([
    ['an https logo', 'https://example.com/logo.png', 'https://example.com/logo.png'],
    ['an ipfs logo', 'ipfs://bafylogo', 'https://juicebox.center/ipfs/bafylogo'],
    ['a logo with credentials', 'https://user:secret@example.com/logo.png', undefined],
    ['a script logo', 'javascript:alert(1)', undefined],
    ['a data logo', 'data:image/svg+xml,<svg onload="alert(1)">', undefined],
    ['an http logo', 'http://example.com/logo.png', undefined],
    ['a logo that is not a string', 42, undefined],
  ])('reads %s', async (_what, logoUri, expected) => {
    const { fetcher } = gateway(json({ name: 'X', logoUri }))
    const metadata = await metadataOfUri(CID, { fetch: fetcher })
    expect(metadata.logoUri).toBe(expected)
    expect('logoUri' in metadata).toBe(expected !== undefined)
  })

  it.each([
    ['a name that is not a string', 5, undefined],
    ['an empty name', '', undefined],
    ['a blank name', '   ', undefined],
    ['a name of 256 characters', 'n'.repeat(256), 'n'.repeat(256)],
    ['a name of 257 characters', 'n'.repeat(257), undefined],
    ['markup, which is text here', '<img src=x onerror=alert(1)>', '<img src=x onerror=alert(1)>'],
  ])('reads %s', async (_what, name, expected) => {
    const { fetcher } = gateway(json({ name }))
    const metadata = await metadataOfUri(CID, { fetch: fetcher })
    expect(metadata.name).toBe(expected)
    expect('name' in metadata).toBe(expected !== undefined)
  })

  it.each([
    ['an array', []],
    ['a string', 'Artizen'],
    ['a number', 7],
    ['null', null],
    ['an empty object', {}],
  ])('reads %s as a document with nothing to show', async (_what, document) => {
    const { fetcher } = gateway(json(document))
    expect(await metadataOfUri(CID, { fetch: fetcher })).toEqual({})
  })

  describe('a document\'s size', () => {
    const MEGABYTE = 1_000_000
    const encoder = new TextEncoder()
    /** A document of `bytes` bytes that names itself Big. */
    const sized = (bytes: number) => {
      const wrap = (padding: number) => JSON.stringify({ name: 'Big', pad: 'a'.repeat(padding) })
      return wrap(bytes - wrap(0).length)
    }
    /** A response whose body is read from `chunks` only as far as it is asked for. */
    function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
      const state = { pulled: 0, cancelled: false }
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[state.pulled]
          state.pulled += 1
          if (chunk) controller.enqueue(chunk)
          else controller.close()
        },
        cancel() {
          state.cancelled = true
        },
      })
      return { state, reply: () => new Response(body, { status: 200, headers }) }
    }

    it('is read to a megabyte', async () => {
      expect(sized(MEGABYTE)).toHaveLength(MEGABYTE)
      const { fetcher } = gateway(() => new Response(sized(MEGABYTE), { status: 200 }))
      expect(await metadataOfUri(CID, { fetch: fetcher })).toEqual({ name: 'Big' })
    })

    it('is not read past a megabyte, and a document of more than that has nothing to show', async () => {
      const { fetcher } = gateway(() => new Response(sized(MEGABYTE + 1), { status: 200 }))
      expect(await metadataOfUri(CID, { fetch: fetcher })).toEqual({})
    })

    it('stops the download at a megabyte when the gateway does not say how large the body is', async () => {
      const chunk = encoder.encode('a'.repeat(100_000))
      const { state, reply } = streamed(Array.from({ length: 1_000 }, () => chunk))
      expect(await metadataOfUri(CID, { fetch: gateway(reply).fetcher })).toEqual({})
      // Eleven chunks are past the limit, and the stream is asked for one more at most, so the rest of the
      // hundred megabytes is never asked for.
      expect(state.pulled).toBeLessThanOrEqual(13)
      expect(state.cancelled).toBe(true)
    })

    it('is not read at all when the gateway says it is more than a megabyte', async () => {
      const { state, reply } = streamed([encoder.encode('{"name":"Big"}')], { 'content-length': String(MEGABYTE + 1) })
      expect(await metadataOfUri(CID, { fetch: gateway(reply).fetcher })).toEqual({})
      expect(state.pulled).toBeLessThanOrEqual(1)
      expect(state.cancelled).toBe(true)
    })

    it('keeps a character that a chunk boundary falls in the middle of', async () => {
      const bytes = encoder.encode('{"name":"Café"}')
      const cut = bytes.indexOf(0xc3) + 1
      const { reply } = streamed([bytes.slice(0, cut), bytes.slice(cut)])
      expect(await metadataOfUri(CID, { fetch: gateway(reply).fetcher })).toEqual({ name: 'Café' })
    })

    it('rejects a body with nothing in it, like any other body that is not JSON', async () => {
      await expect(metadataOfUri(CID, { fetch: gateway(() => new Response('', { status: 200 })).fetcher })).rejects.toThrow()
      await expect(metadataOfUri(CID, { fetch: gateway(() => new Response(null, { status: 200 })).fetcher })).rejects.toThrow()
    })
  })

  it('reads a data uri in place, without asking the network', async () => {
    const { fetcher, calls } = gateway(json({ name: 'never fetched' }))
    expect(await metadataOfUri(inline({ name: 'Inline', logoUri: 'ipfs://bafylogo' }), { fetch: fetcher })).toEqual({
      name: 'Inline',
      logoUri: 'https://juicebox.center/ipfs/bafylogo',
    })
    expect(await metadataOfUri(launchUri(), { fetch: fetcher })).toEqual({
      sticky: { protocol: 'Sticky', launchId: LAUNCH, chains: [84532, 11155420] },
    })
    expect(calls).toHaveLength(0)
  })

  it('reads an inline launch, and drops a launch id of more than 128 characters from it', async () => {
    const { fetcher } = gateway(json({}))
    expect(await metadataOfUri(launchUri({ launchId: 'a'.repeat(128) }), { fetch: fetcher })).toEqual({
      sticky: { protocol: 'Sticky', launchId: 'a'.repeat(128), chains: [84532, 11155420] },
    })
    expect(await metadataOfUri(launchUri({ launchId: 'a'.repeat(129) }), { fetch: fetcher })).toEqual({
      sticky: { protocol: 'Sticky', launchId: null, chains: [84532, 11155420] },
    })
  })

  it.each([
    ['a data uri that is not json', 'data:application/json,not-json'],
    ['a data uri of an image', 'data:image/png;base64,AAAA'],
    ['an https uri', 'https://example.com/metadata.json'],
    ['the gateway\'s own URL', CID_URL],
    ['an internal address', 'https://169.254.169.254/latest/meta-data'],
    ['a bare CID', 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'],
    ['an ipfs uri that is not a gateway path', 'ipfs://bafy/../../api/x'],
    ['nothing', ''],
  ])('reads %s as no metadata, and asks the network for nothing', async (_what, uri) => {
    const { fetcher, calls } = gateway(json({ name: 'never fetched' }))
    expect(await metadataOfUri(uri, { fetch: fetcher })).toEqual({})
    expect(calls).toHaveLength(0)
  })

  it('rejects, so that nothing is remembered, when the gateway does not answer with a document', async () => {
    await expect(metadataOfUri(CID, { fetch: gateway(() => new Response('gone', { status: 404 })).fetcher })).rejects.toThrow(
      'project metadata request failed (404)',
    )
    await expect(metadataOfUri(CID, { fetch: gateway(() => new Response('busy', { status: 504 })).fetcher })).rejects.toThrow(
      'project metadata request failed (504)',
    )
    await expect(metadataOfUri(CID, { fetch: gateway(() => new Response('<html>', { status: 200 })).fetcher })).rejects.toThrow()
    await expect(metadataOfUri(CID, { fetch: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as never })).rejects.toThrow(
      'Failed to fetch',
    )
  })

  it('gives up on a gateway that takes longer than ten seconds', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      }),
    ) as unknown as typeof fetch
    const outcome = metadataOfUri(CID, { fetch: fetcher }).then(
      () => 'answered',
      (error: { name: string }) => error.name,
    )
    await vi.advanceTimersByTimeAsync(9_999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('TimeoutError')
  })

  it('stops when the caller does', async () => {
    const caller = new AbortController()
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      }),
    ) as unknown as typeof fetch
    const outcome = metadataOfUri(CID, { fetch: fetcher, signal: caller.signal })
    caller.abort(new Error('left the page'))
    await expect(outcome).rejects.toThrow('left the page')
  })
})

// A fake chain, keyed by "<contract>.<function>". A read nobody stocked is a bug in the read, so it fails.
type World = Record<string, unknown>
const at = (contract: Address, functionName: string) => `${contract.toLowerCase()}.${functionName}`

type Read = { address: Address; abi: unknown; functionName: string; args?: readonly unknown[] }

function fakeCenter(chain: World) {
  const readContract = vi.fn(async ({ address: contract, functionName, args }: Read) => {
    const key = args?.length ? `${at(contract, functionName)}:${String(args[0]).toLowerCase()}` : at(contract, functionName)
    const reply = chain[key]
    if (reply === undefined) throw new Error(`the fake chain has no ${key}`)
    if (reply instanceof Error) throw reply
    return reply
  })
  center.client.mockReturnValue({ readContract })
  return readContract
}

const world = (overrides: World = {}): World => ({
  [at(deployment.deployer, 'TOKENS')]: TOKENS,
  [`${at(TOKENS, 'projectIdOf')}:${STAKED.toLowerCase()}`]: 7n,
  [`${at(deployment.controller, 'uriOf')}:7`]: CID,
  ...overrides,
})

describe('reading a project through Center', () => {
  // A module of its own for each test, so that what one read of a chain's JBTokens remembered is not there for the next.
  let fresh: typeof import('@/lib/sticky-metadata')
  beforeEach(async () => {
    center.client.mockReset()
    vi.resetModules()
    fresh = await import('@/lib/sticky-metadata')
  })

  describe('projectUriOf', () => {
    it('reads the project a token is the ERC-20 of from the JBTokens the deployer names, then that project\'s uri', async () => {
      const readContract = fakeCenter(world())

      expect(await fresh.projectUriOf(CHAIN, STAKED)).toBe(CID)

      expect(center.client).toHaveBeenCalledWith(CHAIN)
      expect(readContract.mock.calls.map(([read]) => [read.address, read.functionName, read.args])).toEqual([
        [deployment.deployer, 'TOKENS', undefined],
        [TOKENS, 'projectIdOf', [STAKED]],
        [deployment.controller, 'uriOf', [7n]],
      ])
    })

    it('has no uri for a token that is no project\'s, and does not read one', async () => {
      const readContract = fakeCenter(world({ [`${at(TOKENS, 'projectIdOf')}:${STAKED.toLowerCase()}`]: 0n }))
      expect(await fresh.projectUriOf(CHAIN, STAKED)).toBeNull()
      expect(readContract.mock.calls.some(([read]) => read.functionName === 'uriOf')).toBe(false)
    })

    it('has no uri for a project that has none', async () => {
      fakeCenter(world({ [`${at(deployment.controller, 'uriOf')}:7`]: '' }))
      expect(await fresh.projectUriOf(CHAIN, STAKED)).toBeNull()
    })

    it('reads the deployer\'s JBTokens once for a chain', async () => {
      const readContract = fakeCenter(world())
      await fresh.projectUriOf(CHAIN, STAKED)
      await fresh.projectUriOf(CHAIN, STAKED)
      expect(readContract.mock.calls.filter(([read]) => read.functionName === 'TOKENS')).toHaveLength(1)
    })

    it('fails, so that nothing is remembered, when a read does not answer', async () => {
      fakeCenter(world({ [at(deployment.deployer, 'TOKENS')]: new Error('Request exceeds defined limit.') }))
      await expect(fresh.projectUriOf(CHAIN, STAKED)).rejects.toThrow('Request exceeds defined limit.')
      fakeCenter(world({ [`${at(TOKENS, 'projectIdOf')}:${STAKED.toLowerCase()}`]: new Error('timed out') }))
      await expect(fresh.projectUriOf(CHAIN, STAKED)).rejects.toThrow('timed out')
      fakeCenter(world({ [`${at(deployment.controller, 'uriOf')}:7`]: new Error('429') }))
      await expect(fresh.projectUriOf(CHAIN, STAKED)).rejects.toThrow('429')
    })

    it('does not remember a failed read of the deployer\'s JBTokens', async () => {
      fakeCenter(world({ [at(deployment.deployer, 'TOKENS')]: new Error('429') }))
      await expect(fresh.projectUriOf(CHAIN, STAKED)).rejects.toThrow('429')
      fakeCenter(world())
      expect(await fresh.projectUriOf(CHAIN, STAKED)).toBe(CID)
    })

    it('fails for a chain Sticky is not on, without reading it', async () => {
      const readContract = fakeCenter(world())
      await expect(fresh.projectUriOf(137, STAKED)).rejects.toThrow('Sticky is not deployed on chain 137.')
      expect(readContract).not.toHaveBeenCalled()
    })

    it('stops when the caller does', async () => {
      const caller = new AbortController()
      center.client.mockReturnValue({ readContract: () => new Promise(() => {}) })
      const outcome = fresh.projectUriOf(CHAIN, STAKED, { signal: caller.signal })
      caller.abort(new Error('left the page'))
      await expect(outcome).rejects.toThrow('left the page')
    })
  })

  describe('projectMetadata', () => {
    it('reads a token\'s project uri and the document it names', async () => {
      fakeCenter(world())
      const { fetcher, calls } = gateway(json({ name: 'Artizen', logoUri: 'ipfs://bafylogo' }))

      expect(await fresh.projectMetadata(CHAIN, STAKED, { fetch: fetcher })).toEqual({
        name: 'Artizen',
        logoUri: 'https://juicebox.center/ipfs/bafylogo',
      })
      expect(calls[0][0]).toBe(CID_URL)
    })

    it('reads a data uri without a fetch, and a Sticky launch\'s as its launch', async () => {
      fakeCenter(world({ [`${at(deployment.controller, 'uriOf')}:7`]: launchUri() }))
      const { fetcher, calls } = gateway(json({}))
      expect(await fresh.projectMetadata(CHAIN, STAKED, { fetch: fetcher })).toEqual({
        sticky: { protocol: 'Sticky', launchId: LAUNCH, chains: [84532, 11155420] },
      })
      expect(calls).toHaveLength(0)
    })

    it('has no metadata for a token that is no project\'s, or a project without a uri, and fetches nothing', async () => {
      const { fetcher, calls } = gateway(json({ name: 'never fetched' }))
      fakeCenter(world({ [`${at(TOKENS, 'projectIdOf')}:${STAKED.toLowerCase()}`]: 0n }))
      expect(await fresh.projectMetadata(CHAIN, STAKED, { fetch: fetcher })).toEqual({})
      fakeCenter(world({ [`${at(deployment.controller, 'uriOf')}:7`]: '' }))
      expect(await fresh.projectMetadata(CHAIN, STAKED, { fetch: fetcher })).toEqual({})
      expect(calls).toHaveLength(0)
    })

    it('rejects when the chain or the gateway cannot be read, rather than reporting a project with no metadata', async () => {
      fakeCenter(world({ [at(deployment.deployer, 'TOKENS')]: new Error('429') }))
      await expect(fresh.projectMetadata(CHAIN, STAKED, { fetch: gateway(json({})).fetcher })).rejects.toThrow('429')
      fakeCenter(world())
      await expect(
        fresh.projectMetadata(CHAIN, STAKED, { fetch: gateway(() => new Response('busy', { status: 503 })).fetcher }),
      ).rejects.toThrow('project metadata request failed (503)')
    })
  })
})
