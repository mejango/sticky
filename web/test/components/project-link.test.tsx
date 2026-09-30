import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const links = vi.hoisted(() => [] as Record<string, unknown>[])
vi.mock('next/link', () => ({
  default: (props: { href: string; children?: ReactNode; className?: string }) => {
    links.push(props)
    return (
      <a href={props.href} className={props.className}>
        {props.children}
      </a>
    )
  },
}))

import { ProjectLink } from '@/components/ProjectLink'

const host = document.createElement('div')

afterEach(() => {
  links.length = 0
  host.replaceChildren()
})

/** Every `.tsx` file under `dir`. */
function components(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return components(full)
    return entry.name.endsWith('.tsx') ? [full] : []
  })
}

describe('ProjectLink', () => {
  it('links to the project page and is never prefetched', async () => {
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <ProjectLink chainId={84532} projectId={42n} className="card">
          E2E Sticky
        </ProjectLink>,
      )
    })

    expect(host.innerHTML).toBe('<a href="/basesep:42" class="card">E2E Sticky</a>')
    expect(links[0]).toMatchObject({ href: '/basesep:42', prefetch: false })
    await act(async () => root.unmount())
  })

  it('is how every page links to a project', () => {
    const building = components('src').filter(
      file => !file.endsWith(join('components', 'ProjectLink.tsx')) && readFileSync(file, 'utf8').includes('projectPath('),
    )
    expect(building).toEqual([])
  })
})
