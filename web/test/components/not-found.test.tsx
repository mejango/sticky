import { act, type AnchorHTMLAttributes } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pathname: '/nowhere', search: '' }))

vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
}))
vi.mock('next/link', () => ({
  default: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))

import NotFound from '@/app/not-found'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  mocks.pathname = '/nowhere'
  mocks.search = ''
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const render = () => act(async () => root.render(<NotFound />))

describe('the not-found page', () => {
  it('says the page was not found, under the one heading of the page', async () => {
    await render()
    const headings = [...host.querySelectorAll('h1, h2, h3')]
    expect(headings.map(heading => [heading.tagName, heading.textContent])).toEqual([['H1', 'Page not found']])
  })

  it('offers the way home', async () => {
    await render()
    const links = [...host.querySelectorAll('a')]
    expect(links.map(link => [link.textContent, link.getAttribute('href')])).toEqual([['Back to home', '/']])
  })

  it('offers the way home on the testnets to a visitor who came from them', async () => {
    mocks.search = 'network=testnet'
    await render()
    expect(host.querySelector('a')!.getAttribute('href')).toBe('/?network=testnet')
  })

  it('keeps to one short line of explanation, without dashes, dots or emoji', async () => {
    await render()
    const lines = [...host.querySelectorAll('p')].map(line => line.textContent ?? '')
    expect(lines).toHaveLength(1)
    expect(lines[0].length).toBeLessThan(80)
    expect(host.textContent).not.toMatch(/—|·|\p{Extended_Pictographic}/u)
  })
})
