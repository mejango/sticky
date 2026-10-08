import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pathname: '/',
  search: '',
  /** Set while the search parameters are not known yet: reading them suspends, as a prerender does. */
  pending: null as Promise<void> | null,
  /** Set to make reading them fail, as the static build's prerender does. */
  failure: null as Error | null,
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => mocks.pathname,
  useSearchParams: () => {
    if (mocks.failure) throw mocks.failure
    if (mocks.pending) throw mocks.pending
    return new URLSearchParams(mocks.search)
  },
}))
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))

import { HomeLink } from '@/components/HomeLink'
import { ProjectRouteProvider, ProjectRouteSync, type ResolvedProjectRoute } from '@/providers/ProjectRouteContext'

const ACCOUNT = '0x1111111111111111111111111111111111111111'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.pathname = '/'
  mocks.search = ''
  mocks.pending = null
  mocks.failure = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const link = () => host.querySelector('a')!
const show = (tree: ReactNode = <HomeLink>home</HomeLink>) => act(async () => root.render(<QueryClientProvider client={new QueryClient()}>{tree}</QueryClientProvider>))
const hrefAt = async (pathname: string, search = '') => {
  mocks.pathname = pathname
  mocks.search = search
  await show()
  return link().getAttribute('href')
}

describe('the link home, on the page of a project', () => {
  it.each([
    ['/basesep:37', 'a Base Sepolia project'],
    ['/opsep:20', 'an Optimism Sepolia project'],
    ['/sep:1', 'a Sepolia project'],
    ['/arbsep:9', 'an Arbitrum Sepolia project'],
  ])('goes to the testnets from %s, %s', async pathname => {
    expect(await hrefAt(pathname)).toBe('/?network=testnet')
  })

  it.each([
    ['/base:23', 'a Base project'],
    ['/eth:5', 'an Ethereum project'],
    ['/op:3', 'an Optimism project'],
    ['/arb:8', 'an Arbitrum project'],
  ])('goes to the production chains from %s, %s', async pathname => {
    expect(await hrefAt(pathname)).toBe('/')
  })

  it('takes the network from the chain of the project, not from the address bar', async () => {
    expect(await hrefAt('/base:23', 'network=testnet')).toBe('/')
    expect(await hrefAt('/basesep:37', 'network=mainnet')).toBe('/?network=testnet')
  })

  it.each([
    [84532, '/?network=testnet'],
    [11155420, '/?network=testnet'],
    [10, '/'],
    [8453, '/'],
  ])('takes the network of a handle from the chain %s the page resolved it to', async (chainId, href) => {
    mocks.pathname = '/@design'
    const route: ResolvedProjectRoute = { chainId: chainId as ResolvedProjectRoute['chainId'], projectId: 3, handle: 'design' }
    await show(
      <ProjectRouteProvider>
        <ProjectRouteSync route={route} />
        <HomeLink>home</HomeLink>
      </ProjectRouteProvider>,
    )
    expect(link().getAttribute('href')).toBe(href)
  })

  it('goes to the production chains from a handle no project has been resolved for', async () => {
    expect(await hrefAt('/@design')).toBe('/')
  })
})

describe('the link home, on any other page', () => {
  it.each([
    ['/', 'the testnet home'],
    [`/account/${ACCOUNT}`, 'a testnet account'],
    ['/nowhere', 'a page that is not found'],
  ])('carries ?network=testnet from the address bar of %s, %s', async pathname => {
    expect(await hrefAt(pathname, 'network=testnet')).toBe('/?network=testnet')
  })

  it.each([
    ['/', ''],
    ['/', 'network=mainnet'],
    ['/', 'network=other'],
    ['/', 'network=testnet2'],
    ['/', 'chain=84532'],
    [`/account/${ACCOUNT}`, ''],
  ])('goes to the production chains from %s with the search "%s"', async (pathname, search) => {
    expect(await hrefAt(pathname, search)).toBe('/')
  })

  it('follows the address bar as the visitor moves between networks', async () => {
    expect(await hrefAt('/', 'network=testnet')).toBe('/?network=testnet')
    expect(await hrefAt('/base:23')).toBe('/')
    expect(await hrefAt('/basesep:37')).toBe('/?network=testnet')
    expect(await hrefAt('/')).toBe('/')
  })
})

describe('the link home, before the address bar is known', () => {
  it('is the plain link while the search parameters are not known, and the network link once they are', async () => {
    mocks.search = 'network=testnet'
    const known = Promise.withResolvers<void>()
    mocks.pending = known.promise
    await show(
      <HomeLink className="brand" aria-label="Go to homepage" tabIndex={-1}>
        home
      </HomeLink>,
    )
    expect(link().getAttribute('href')).toBe('/')

    mocks.pending = null
    await act(async () => known.resolve())
    expect(link().getAttribute('href')).toBe('/?network=testnet')
  })

  it('draws the plain link into a prerendered page, where reading the search parameters bails out', () => {
    mocks.failure = new Error('Bail out to client-side rendering: useSearchParams()')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const html = renderToString(<HomeLink className="brand">home</HomeLink>)
    errors.mockRestore()
    expect(html).toContain('href="/"')
    expect(html).toContain('class="brand"')
    expect(html).not.toContain('network=testnet')
  })
})

describe('the link home, as a link', () => {
  it.each([
    ['known', () => null],
    ['not yet known', () => new Promise<void>(() => undefined)],
  ])('passes what it is given to the link while the address bar is %s', async (_when, pending) => {
    mocks.pending = pending()
    await show(
      <HomeLink className="brand-slime" aria-label="Go to homepage" aria-hidden="true" tabIndex={-1}>
        <span>drip</span>
      </HomeLink>,
    )
    const a = link()
    expect(a.className).toBe('brand-slime')
    expect(a.getAttribute('aria-label')).toBe('Go to homepage')
    expect(a.getAttribute('aria-hidden')).toBe('true')
    expect(a.tabIndex).toBe(-1)
    expect(a.textContent).toBe('drip')
  })
})
