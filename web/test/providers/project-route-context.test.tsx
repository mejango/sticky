import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProjectRouteBoundary, ProjectRouteProvider, ProjectRouteSync,
  invalidateProjectRoute, requestProjectTabNavigation,
  useProjectReviewScope, useResolvedProjectRoute, type ResolvedProjectRoute,
} from '@/providers/ProjectRouteContext'
import { useProjectRouteBlocked } from '@/providers/ProjectRouteBlockedContext'
import { PROJECT_ROUTE_STALE_MS, type ProjectRouteSnapshot } from '@/lib/project-route'

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

const DESIGN: ResolvedProjectRoute = { chainId: 10, projectId: 3, handle: 'design' }
const BASE_23: ResolvedProjectRoute = { chainId: 8453, projectId: 23, handle: null }
const snapshot = (route = DESIGN): ProjectRouteSnapshot => ({ ...route, checkedAt: Date.now(), serverNow: Date.now() })

function Reader() {
  const route = useResolvedProjectRoute()
  const blocked = useProjectRouteBlocked()
  const scope = useProjectReviewScope()
  return <>
    <output>{route ? `${route.chainId}:${route.projectId}:${route.handle}` : 'none'}</output>
    <button data-write disabled={blocked || !scope} onClick={async () => { if (await scope?.verify()) wrote() }}>Write</button>
  </>
}
function Editor() {
  const [draft, setDraft] = useState('')
  return <input value={draft} onChange={event => setDraft(event.target.value)} />
}

let host: HTMLDivElement
let root: Root
let client: QueryClient
const reload = vi.fn()
const wrote = vi.fn()
const fetchRoute = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  reload.mockClear()
  wrote.mockClear()
  fetchRoute.mockReset().mockImplementation(async () => ({ ok: true, json: async () => snapshot() }))
  vi.stubGlobal('fetch', fetchRoute)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  host = document.createElement('div')
  root = createRoot(host)
  window.history.replaceState(null, '', '/')
})

afterEach(async () => {
  await act(async () => root.unmount())
  client.clear()
})

const show = (tree: React.ReactNode) => act(async () => root.render(<QueryClientProvider client={client}>{tree}</QueryClientProvider>))
const at = (pathname: string) => vi.stubGlobal('location', { pathname, reload })
const visit = (route = DESIGN) => show(<ProjectRouteProvider><Reader /><ProjectRouteBoundary snapshot={snapshot(route)}><Editor /></ProjectRouteBoundary></ProjectRouteProvider>)
const blocked = () => host.querySelector<HTMLButtonElement>('[data-write]')!.disabled
const navigate = (commit = vi.fn()) => act(async () => requestProjectTabNavigation(commit))
const restore = (event: 'popstate' | 'pageshow', persisted = false) => act(async () => {
  window.dispatchEvent(event === 'popstate' ? new Event(event) : Object.assign(new Event(event), { persisted }))
})

describe('the resolved project route', () => {
  it('is empty until a project page names it, and clears when the page leaves', async () => {
    await show(<Reader />)
    expect(host.querySelector('output')?.textContent).toBe('none')
    const page = (route: ResolvedProjectRoute | null) => <ProjectRouteProvider><Reader />{route && <ProjectRouteSync route={route} />}</ProjectRouteProvider>
    await show(page(BASE_23))
    expect(host.querySelector('output')?.textContent).toBe('8453:23:null')
    await show(page(null))
    expect(host.querySelector('output')?.textContent).toBe('none')
  })

  it('remounts the project subtree when its immutable numeric identity changes', async () => {
    await visit(BASE_23)
    const previous = host.querySelector('input')!
    await visit({ ...BASE_23, projectId: 24 })
    expect(host.querySelector('input')).not.toBe(previous)
    expect(reload).not.toHaveBeenCalled()
  })
})

describe('bounded alias verification', () => {
  it('verifies on mount, then keeps same-project tabs and their state without reloading', async () => {
    at('/@design')
    await visit()
    const editor = host.querySelector('input')
    const commit = vi.fn()
    await navigate(commit)
    await navigate(commit)
    expect(commit).toHaveBeenCalledTimes(2)
    expect(fetchRoute).toHaveBeenCalledTimes(1)
    expect(blocked()).toBe(false)
    expect(host.querySelector('input')).toBe(editor)
    expect(reload).not.toHaveBeenCalled()
  })

  it('keeps normalization on the server for encoded and noncanonical aliases', async () => {
    at('/%40DESIGN.eth')
    await visit()
    await navigate()
    expect(fetchRoute).toHaveBeenCalledTimes(1)
    expect(fetchRoute.mock.calls[0][0]).toContain('segment=%40DESIGN.eth')
    expect(blocked()).toBe(false)
  })

  it('withholds stale navigation and writes until a fresh same-project proof arrives', async () => {
    at('/@design')
    await visit()
    vi.advanceTimersByTime(PROJECT_ROUTE_STALE_MS)
    const response = Promise.withResolvers<unknown>()
    fetchRoute.mockReturnValueOnce(response.promise)
    const commit = vi.fn()
    await navigate(commit)
    expect(blocked()).toBe(true)
    expect(commit).not.toHaveBeenCalled()
    await act(async () => response.resolve({ ok: true, json: async () => snapshot() }))
    expect(blocked()).toBe(false)
    expect(commit).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()
  })

  it('blocks writes and retains the page when proof is unavailable, then retries', async () => {
    at('/@design')
    fetchRoute.mockRejectedValueOnce(new Error('offline'))
    await visit()
    expect(blocked()).toBe(true)
    expect(host.textContent).toContain('offline')
    expect(reload).not.toHaveBeenCalled()
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Try again')!.click())
    expect(blocked()).toBe(false)
    expect(fetchRoute.mock.calls[1][0]).toContain('fresh=1')
  })

  it('rejects a write when its lease expires and the recheck is unavailable', async () => {
    at('/@design')
    await visit()
    vi.advanceTimersByTime(PROJECT_ROUTE_STALE_MS)
    fetchRoute.mockRejectedValueOnce(new Error('offline'))
    await act(async () => host.querySelector<HTMLButtonElement>('[data-write]')!.click())
    expect(wrote).not.toHaveBeenCalled()
    expect(blocked()).toBe(true)
  })

  it('discards the document only for a proven rebind, keeping late actions blocked', async () => {
    at('/@design')
    await visit()
    vi.advanceTimersByTime(PROJECT_ROUTE_STALE_MS)
    fetchRoute.mockResolvedValueOnce({ ok: true, json: async () => snapshot({ ...DESIGN, projectId: 4 }) })
    const commit = vi.fn()
    await navigate(commit)
    expect(reload).toHaveBeenCalledOnce()
    expect(blocked()).toBe(true)
    expect(commit).toHaveBeenCalledOnce()
    await navigate(commit)
    expect(commit).toHaveBeenCalledOnce()
  })

  it('does not authorize a changed RSC tree with proof for the old identity', async () => {
    at('/@design')
    await visit()
    await visit({ ...DESIGN, projectId: 4 })
    expect(blocked()).toBe(true)
    expect(host.textContent).toContain('disagree')
    expect(reload).not.toHaveBeenCalled()
  })

  it('forces a new proof on invalidation even inside the lease', async () => {
    at('/@design')
    await visit()
    await act(async () => invalidateProjectRoute())
    expect(fetchRoute).toHaveBeenCalledTimes(2)
    expect(fetchRoute.mock.calls[1][0]).toContain('fresh=1')
  })

  it.each(['popstate', 'pageshow'] as const)('revalidates expired history restorations from %s without reloading unchanged identities', async event => {
    at('/@design')
    await visit()
    vi.advanceTimersByTime(PROJECT_ROUTE_STALE_MS)
    await restore(event, true)
    expect(fetchRoute).toHaveBeenCalledTimes(2)
    expect(reload).not.toHaveBeenCalled()
  })

  it('revalidates direct hash changes through the shared route owner', async () => {
    at('/@design')
    await visit()
    vi.advanceTimersByTime(PROJECT_ROUTE_STALE_MS)
    await act(async () => window.dispatchEvent(new Event('hashchange')))
    expect(fetchRoute).toHaveBeenCalledTimes(2)
    expect(reload).not.toHaveBeenCalled()
  })

  it.each(['/base:23', '/', '/account/0x1111111111111111111111111111111111111111', '/%2540design'])('does not look up an alias for %s', async pathname => {
    at(pathname)
    await visit(BASE_23)
    await restore('popstate')
    await restore('pageshow', true)
    expect(fetchRoute).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })
})
