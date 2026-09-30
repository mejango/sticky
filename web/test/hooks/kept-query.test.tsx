import { QueryClient, QueryClientProvider, useQuery, type QueryKey } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useKeptQueries, useKeptQuery } from '@/hooks/useKeptQuery'
import { PERSIST } from '@/lib/query-persist'

const KEY: QueryKey = ['kept-read']
const OTHER: QueryKey = ['other-read']
// A read that is under way the whole test, so what shows is what the cache held.
const pending = () => new Promise<string>(() => {})

function KeptView() {
  const read = useKeptQuery({ queryKey: KEY, queryFn: pending, meta: PERSIST })
  return <p data-fetching={read.isFetching}>{read.data ?? 'loading'}</p>
}

function BareView() {
  const read = useQuery({ queryKey: KEY, queryFn: pending, meta: PERSIST })
  return <p data-fetching={read.isFetching}>{read.data ?? 'loading'}</p>
}

function KeptList() {
  const text = useKeptQueries({
    queries: [
      { queryKey: KEY, queryFn: pending, meta: PERSIST },
      { queryKey: OTHER, queryFn: pending, enabled: false },
    ],
    combine: reads => reads.map(read => `${read.data ?? 'loading'}/${read.fetchStatus}`).join(' '),
  })
  return <p>{text}</p>
}

const withClient = (client: QueryClient, tree: ReactNode) => (
  <QueryClientProvider client={client}>{tree}</QueryClientProvider>
)

/** A client that holds what the browser kept of an earlier visit. */
function keptClient() {
  const client = new QueryClient()
  client.setQueryData(KEY, 'kept copy')
  client.setQueryData(OTHER, 'other copy')
  return client
}

let host: HTMLDivElement
let root: Root | undefined

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host.remove()
})

/** Renders `tree` on a server that holds nothing, then hydrates it in a browser that kept `client`'s reads. */
async function hydrateKept(tree: ReactNode, client = keptClient()) {
  host.innerHTML = renderToString(withClient(new QueryClient(), tree))
  const serverHtml = host.innerHTML
  const errors: unknown[] = []
  await act(async () => {
    root = hydrateRoot(host, withClient(client, tree), { onRecoverableError: error => errors.push(error) })
  })
  return { serverHtml, errors }
}

describe('reads the browser kept', () => {
  it('hydrate what the server rendered, then show the kept copy', async () => {
    const { serverHtml, errors } = await hydrateKept(<KeptView />)

    expect(serverHtml).toBe('<p data-fetching="true">loading</p>')
    expect(errors).toEqual([])
    expect(host.textContent).toBe('kept copy')
  })

  it('break hydration when read without the gate', async () => {
    const { errors } = await hydrateKept(<BareView />)

    expect(errors).not.toEqual([])
  })

  it('reach combine as the server had them while hydrating, and as kept after', async () => {
    const { serverHtml, errors } = await hydrateKept(<KeptList />)

    expect(serverHtml).toBe('<p>loading/fetching loading/idle</p>')
    expect(errors).toEqual([])
    expect(host.textContent).toBe('kept copy/fetching other copy/idle')
  })

  it('show the kept copy in the first render of a view that mounts after the page', async () => {
    const seen: string[] = []
    function FirstRender() {
      const read = useKeptQuery({ queryKey: KEY, queryFn: pending, meta: PERSIST })
      seen.push(read.data ?? 'loading')
      return null
    }

    await act(async () => {
      root = createRoot(host)
      root.render(withClient(keptClient(), <FirstRender />))
    })

    expect(seen[0]).toBe('kept copy')
  })
})
