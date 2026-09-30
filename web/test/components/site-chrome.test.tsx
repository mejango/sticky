import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pathname: '/' }))

vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }))
vi.mock('@/components/SiteHeader', () => ({ SiteHeader: () => <header>site header</header> }))

import { SiteChrome } from '@/components/SiteChrome'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const render = (pathname: string) => {
  mocks.pathname = pathname
  return act(async () => root.render(<SiteChrome><p>the page</p></SiteChrome>))
}

describe('the site chrome', () => {
  it.each(['/', '/base:23', '/@design', '/account/0x1111111111111111111111111111111111111111', '/center', '/centerfold'])(
    'puts the header, one main and the footer around %s',
    async pathname => {
      await render(pathname)
      expect(host.querySelector('header')?.textContent).toBe('site header')
      const mains = host.querySelectorAll('main')
      expect(mains).toHaveLength(1)
      expect(mains[0].id).toBe('main-content')
      expect(mains[0].textContent).toBe('the page')
      expect(host.querySelector('footer')?.textContent).toContain('Terms of service')
      expect(host.querySelector('.site-fold > .site-page')).not.toBeNull()
    },
  )

  it('links the two code repositories in the footer, opening away from the app', async () => {
    await render('/')
    const links = [...host.querySelectorAll<HTMLAnchorElement>('footer a')]
    expect(links.map(link => [link.textContent, link.href])).toEqual([
      ['contract code', 'https://github.com/mejango/sticky'],
      ['website code', 'https://github.com/mejango/sticky/tree/main/web'],
    ])
    for (const link of links) {
      expect(link.target).toBe('_blank')
      expect(link.rel).toBe('noopener noreferrer')
    }
  })

  it.each(['/center/callback', '/center/anything'])(
    'renders %s bare, on the sign-in dialog’s card color',
    async pathname => {
      await render(pathname)
      expect(host.querySelector('header')).toBeNull()
      expect(host.querySelector('footer')).toBeNull()
      expect(host.querySelector('main')).toBeNull()
      expect(host.querySelector('.site-fold')).toBeNull()
      expect(host.firstElementChild?.className).toContain('bg-card')
      expect(host.textContent).toBe('the page')
    },
  )
})
