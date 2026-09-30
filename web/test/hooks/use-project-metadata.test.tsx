import { QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getAddress } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deserializeState, installQueryPersistence } from '@/lib/query-persist'
import { METADATA_VERSION } from '@/lib/sticky-metadata'
import { memoryStorage } from '../memory-storage'

const mocks = vi.hoisted(() => ({ projectUriOf: vi.fn(), metadataOfUri: vi.fn() }))
vi.mock('@/lib/sticky-metadata', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/sticky-metadata')>()),
  projectUriOf: mocks.projectUriOf,
  metadataOfUri: mocks.metadataOfUri,
}))

import { useProjectMetadata } from '@/hooks/useProjectMetadata'

const CHAIN = 8453
const STAKED = getAddress(`0x${'2'.repeat(40)}`)
const OTHER = getAddress(`0x${'3'.repeat(40)}`)
const CID = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const CID_TWO = 'ipfs://bafybeib6e45pjc5ipjwjpvw7fxfqpdy4dhqzjy7ru2zllfnrvcb5tiw2y4'
const ARTIZEN = { name: 'Artizen', logoUri: 'https://juicebox.center/ipfs/bafylogo' }
const STORE_KEY = 'sticky:query-cache:v1'

type Seen = ReturnType<typeof useProjectMetadata>
let host: HTMLDivElement
let root: Root
let client: QueryClient
let seen: Seen | undefined

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

function Probe({ token, report }: { token: typeof STAKED; report: (value: Seen) => void }) {
  report(useProjectMetadata(CHAIN, token))
  return null
}

const render = (token = STAKED, using = client) =>
  act(async () =>
    root.render(
      <QueryClientProvider client={using}>
        <Probe
          token={token}
          report={value => {
            seen = value
          }}
        />
      </QueryClientProvider>,
    ),
  )

/** Long enough for the persister's one-second write to have happened. */
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(1_500)))

beforeEach(() => {
  // The query cache tells its observers in a microtask, so the fake clock leaves them be, and the persister's
  // debounce is the one timer a test moves.
  notifyManager.setScheduler(callback => queueMicrotask(callback))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mocks.projectUriOf.mockReset().mockResolvedValue(CID)
  mocks.metadataOfUri.mockReset().mockResolvedValue(ARTIZEN)
  client = newClient()
  seen = undefined
  host = document.createElement('div')
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
})

describe('useProjectMetadata', () => {
  it('reads a token\'s project uri, then the document it names', async () => {
    await render()

    expect(seen?.data).toEqual(ARTIZEN)
    expect(mocks.projectUriOf).toHaveBeenCalledWith(CHAIN, STAKED, { signal: expect.any(AbortSignal) })
    expect(mocks.metadataOfUri).toHaveBeenCalledWith(CID, { signal: expect.any(AbortSignal) })
  })

  it('has nothing to show, and reads no document, for a token that is no project\'s', async () => {
    mocks.projectUriOf.mockResolvedValue(null)
    await render()

    expect(seen?.data).toBeUndefined()
    expect(mocks.metadataOfUri).not.toHaveBeenCalled()
  })

  it('keys a document by its uri, so that two tokens whose projects share it share one fetch', async () => {
    await render(STAKED)
    await render(OTHER)

    expect(seen?.data).toEqual(ARTIZEN)
    expect(mocks.projectUriOf).toHaveBeenCalledTimes(2)
    expect(mocks.metadataOfUri).toHaveBeenCalledTimes(1)
    expect(client.getQueryCache().find({ queryKey: ['project-metadata', 'v1', CID] })).toBeDefined()
  })

  it('reads the new document when a project\'s uri changes, and leaves the old one as it was', async () => {
    await render()
    mocks.metadataOfUri.mockResolvedValue({ name: 'Artizen 2' })
    await act(async () => client.setQueryData(['project-uri', CHAIN, STAKED], CID_TWO))

    expect(seen?.data).toEqual({ name: 'Artizen 2' })
    expect(mocks.metadataOfUri).toHaveBeenLastCalledWith(CID_TWO, { signal: expect.any(AbortSignal) })
    expect(client.getQueryData(['project-metadata', 'v1', CID])).toEqual(ARTIZEN)
  })

  describe('what it says of the reads', () => {
    const status = () => ({ data: seen?.data, isPending: seen?.isPending, isError: seen?.isError, error: seen?.error })

    it('is pending, with no error, while the project\'s uri is read', async () => {
      const uri = Promise.withResolvers<string | null>()
      mocks.projectUriOf.mockReturnValue(uri.promise)
      await render()

      expect(status()).toEqual({ data: undefined, isPending: true, isError: false, error: null })
      expect(mocks.metadataOfUri).not.toHaveBeenCalled()
    })

    it('is pending while the document is read, and done with it once it is', async () => {
      const document = Promise.withResolvers<typeof ARTIZEN>()
      mocks.metadataOfUri.mockReturnValue(document.promise)
      await render()
      expect(status()).toEqual({ data: undefined, isPending: true, isError: false, error: null })

      await act(async () => document.resolve(ARTIZEN))
      expect(status()).toEqual({ data: ARTIZEN, isPending: false, isError: false, error: null })
    })

    it('is done, with nothing to show, for a token that is no project\'s', async () => {
      mocks.projectUriOf.mockResolvedValue(null)
      await render()

      expect(status()).toEqual({ data: undefined, isPending: false, isError: false, error: null })
    })

    it('says that reading the project\'s uri failed, and is no longer pending on a document it will not read', async () => {
      const failure = new Error('Request exceeds defined limit.')
      mocks.projectUriOf.mockRejectedValue(failure)
      await render()

      expect(status()).toEqual({ data: undefined, isPending: false, isError: true, error: failure })
      expect(mocks.metadataOfUri).not.toHaveBeenCalled()
    })

    it('says that reading the document failed', async () => {
      const failure = new Error('project metadata request failed (504)')
      mocks.metadataOfUri.mockRejectedValue(failure)
      await render()

      expect(status()).toEqual({ data: undefined, isPending: false, isError: true, error: failure })
    })

    it('stays pending while a failed read is tried again, and does not say it failed', async () => {
      const retrying = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 10 } } })
      mocks.projectUriOf.mockRejectedValueOnce(new Error('429')).mockResolvedValue(CID)
      await render(STAKED, retrying)
      expect(status()).toEqual({ data: undefined, isPending: true, isError: false, error: null })

      await act(async () => void (await vi.advanceTimersByTimeAsync(10)))
      expect(status()).toEqual({ data: ARTIZEN, isPending: false, isError: false, error: null })
      retrying.clear()
    })
  })

  describe('what goes to disk', () => {
    const stored = (storage: Storage) =>
      storage.getItem(STORE_KEY) === null
        ? []
        : deserializeState(storage.getItem(STORE_KEY)!).queries.map(query => query.queryKey)

    it('is the document, keyed by its ipfs uri, tagged so that it is never read again', async () => {
      const storage = memoryStorage()
      installQueryPersistence(client, storage)
      await render()
      await settle()

      const query = client.getQueryCache().find({ queryKey: ['project-metadata', 'v1', CID] })!
      expect(query.meta).toEqual({ persist: 'immutable' })
      expect(query.observers[0].options.staleTime).toBe(Number.POSITIVE_INFINITY)
      expect(stored(storage)).toEqual([['project-metadata', 'v1', CID]])
    })

    it('has its kept form in the key, so that a browser does not read a document as an older version kept it', async () => {
      const storage = memoryStorage()
      installQueryPersistence(client, storage)
      await render()
      await settle()

      // Whoever changes what is kept of a document, or where it is fetched from, changes this segment with it.
      expect(stored(storage)[0].slice(0, 2)).toEqual(['project-metadata', 'v1'])
      expect(METADATA_VERSION).toBe('v1')

      const other = newClient()
      other.setQueryData(['project-metadata', 'v0', CID], { name: 'Kept by an older version' })
      await act(async () => root.unmount())
      root = createRoot(host)
      await render(STAKED, other)
      expect(seen?.data).toEqual(ARTIZEN)
      other.clear()
    })

    it('is not the uri, which the chain can change, and is not a query keyed by the token', async () => {
      const storage = memoryStorage()
      installQueryPersistence(client, storage)
      await render()
      await settle()

      expect(stored(storage).flat()).not.toContain('project-uri')
      expect(stored(storage).flat()).not.toContain(STAKED)
    })

    it('lets a return visit show the document at once, without fetching it again', async () => {
      const storage = memoryStorage()
      installQueryPersistence(client, storage)
      await render()
      await settle()
      await act(async () => root.unmount())
      root = createRoot(host)
      mocks.metadataOfUri.mockClear()
      mocks.projectUriOf.mockClear()

      const returned = newClient()
      installQueryPersistence(returned, storage)
      // The document is there before anything is read; only the project's uri is asked of the chain.
      expect(returned.getQueryData(['project-metadata', 'v1', CID])).toEqual(ARTIZEN)
      await render(STAKED, returned)

      expect(seen?.data).toEqual(ARTIZEN)
      expect(mocks.projectUriOf).toHaveBeenCalledTimes(1)
      expect(mocks.metadataOfUri).not.toHaveBeenCalled()
      returned.clear()
    })

    it('is never a failure, so a gateway that failed once is asked again on the next visit', async () => {
      const storage = memoryStorage()
      installQueryPersistence(client, storage)
      mocks.metadataOfUri.mockRejectedValue(new Error('project metadata request failed (504)'))
      await render()
      await settle()

      expect(seen?.data).toBeUndefined()
      expect(client.getQueryCache().find({ queryKey: ['project-metadata', 'v1', CID] })?.state.status).toBe('error')
      expect(stored(storage)).toEqual([])

      await act(async () => root.unmount())
      root = createRoot(host)
      mocks.metadataOfUri.mockResolvedValue(ARTIZEN)
      const returned = newClient()
      installQueryPersistence(returned, storage)
      await render(STAKED, returned)
      expect(seen?.data).toEqual(ARTIZEN)
      returned.clear()
    })

    it.each([
      ['a data uri, which is its own content and can be any size', `data:application/json,${'x'.repeat(50_000)}`],
      ['an https uri, whose document can change', 'https://example.com/metadata.json'],
      ['an ipfs uri that is not a gateway path, whatever its length', `ipfs://${'a'.repeat(50_000)}`],
    ])('is not %s', async (_what, uri) => {
      const storage = memoryStorage()
      installQueryPersistence(client, storage)
      mocks.projectUriOf.mockResolvedValue(uri)
      await render()
      await settle()

      const query = client.getQueryCache().find({ queryKey: ['project-metadata', 'v1', uri] })!
      expect(query.state.data).toEqual(ARTIZEN)
      expect(query.meta).toBeUndefined()
      expect(stored(storage)).toEqual([])
    })
  })
})
