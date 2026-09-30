import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ProjectRouteProvider,
  ProjectRouteSync,
  useResolvedProjectRoute,
  type ResolvedProjectRoute,
} from '@/providers/ProjectRouteContext'

const DESIGN: ResolvedProjectRoute = { chainId: 10, projectId: 3, handle: 'design' }
const BASE_23: ResolvedProjectRoute = { chainId: 8453, projectId: 23, handle: null }

function Reader() {
  const route = useResolvedProjectRoute()
  return <span>{route ? `${route.chainId}:${route.projectId}:${route.handle}` : 'none'}</span>
}

let host: HTMLDivElement
let root: Root
const reload = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
})

const show = (tree: React.ReactNode) => act(async () => root.render(tree))

describe('the resolved project route', () => {
  it('is empty until a project page names it', async () => {
    await show(<Reader />)
    expect(host.textContent).toBe('none')
    await show(<ProjectRouteProvider><Reader /></ProjectRouteProvider>)
    expect(host.textContent).toBe('none')
  })

  it('is what the open project page synced, and goes when the page does', async () => {
    const page = (route: ResolvedProjectRoute | null) => (
      <ProjectRouteProvider>
        <Reader />
        {route ? <ProjectRouteSync route={route} /> : null}
      </ProjectRouteProvider>
    )
    await show(page(DESIGN))
    expect(host.textContent).toBe('10:3:design')
    await show(page(BASE_23))
    expect(host.textContent).toBe('8453:23:null')
    await show(page(null))
    expect(host.textContent).toBe('none')
  })
})

describe('history restoration into a handle route', () => {
  const restore = (event: 'popstate' | 'pageshow', persisted = false) =>
    act(async () => {
      window.dispatchEvent(
        event === 'popstate' ? new Event('popstate') : Object.assign(new Event('pageshow'), { persisted }),
      )
    })
  const at = (pathname: string) => vi.stubGlobal('location', { pathname, reload })

  beforeEach(async () => {
    reload.mockClear()
    await show(<ProjectRouteProvider><Reader /></ProjectRouteProvider>)
  })

  it('resolves the handle again after Back or Forward', async () => {
    at('/@design')
    await restore('popstate')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('resolves the handle again after a whole page comes back from the back-forward cache', async () => {
    at('/@design')
    await restore('pageshow', true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('leaves an ordinary pageshow alone', async () => {
    at('/@design')
    await restore('pageshow', false)
    expect(reload).not.toHaveBeenCalled()
  })

  it.each(['/base:23', '/', '/account/0x1111111111111111111111111111111111111111', '/%2540design'])(
    'leaves %s alone',
    async pathname => {
      at(pathname)
      await restore('popstate')
      await restore('pageshow', true)
      expect(reload).not.toHaveBeenCalled()
    },
  )

  it('stops listening when the provider goes away', async () => {
    at('/@design')
    await show(<Reader />)
    await restore('popstate')
    expect(reload).not.toHaveBeenCalled()
  })
})
