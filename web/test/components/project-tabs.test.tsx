import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectTabIcon } from '@/components/project/ProjectTabIcon'
import { ProjectTabs, replaceProjectTabHash } from '@/components/project/Tabs'

// JBM's test/components/project-tabs.test.ts and test/project-tab-icon.test.tsx, on jsdom's window with the location
// stubbed, plus the phone tab's label, which Sticky passes and JBM defaults.

let host: HTMLDivElement
let root: Root
const reload = vi.fn()

function stubWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width <= Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))
}

beforeEach(() => {
  reload.mockReset()
  stubWidth(1280)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  window.history.replaceState(null, '', '/')
})

/** The page is at `pathname`; `reload` stands in for the browser's. */
const at = (pathname: string, hash = '') => vi.stubGlobal('location', { pathname, hash, reload })

const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
const selected = () => tabs().filter(tab => tab.getAttribute('aria-selected') === 'true').map(tab => tab.textContent)

describe('project tab alias revalidation', () => {
  /** The browser's own replaceState, and one that Next puts on the history instance. */
  function histories() {
    const native = vi.spyOn(History.prototype, 'replaceState')
    const patched = vi.fn()
    Object.defineProperty(window.history, 'replaceState', { value: patched, configurable: true })
    return { native, patched, restore: () => delete (window.history as { replaceState?: unknown }).replaceState }
  }

  it('waits for alias verification before committing a native hash update', () => {
    const { native, patched, restore } = histories()
    at('/%40caf%C3%A9.juicebox')
    let commit: (() => void) | undefined
    const listen = (event: Event) => { commit = (event as CustomEvent<() => void>).detail }
    window.addEventListener('project-route-navigate', listen)
    replaceProjectTabHash('#owner')
    expect(native).not.toHaveBeenCalled()
    expect(commit).toBeTypeOf('function')
    commit!()
    expect(native).toHaveBeenCalledWith(window.history.state, '', '#owner')
    expect(patched).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    window.removeEventListener('project-route-navigate', listen)
    restore()
  })

  it('keeps numeric routes on the native hash-only fast path', () => {
    const { native, patched, restore } = histories()
    at('/base:7')

    replaceProjectTabHash('#tokens')

    expect(native).toHaveBeenCalledWith(window.history.state, '', '#tokens')
    expect(patched).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    restore()
  })

  it('does not reload a double-encoded handle-looking pathname', () => {
    at('/%2540design.juicebox')
    replaceProjectTabHash('#airdrops')
    expect(reload).not.toHaveBeenCalled()
  })

  it('leaves direct hash revalidation to the route provider', async () => {
    at('/@design.juicebox')
    await act(async () =>
      root.render(
        <ProjectTabs
          tabs={[
            { label: 'Overview', content: 'overview' },
            { label: 'Tokens', content: 'tokens' },
          ]}
          sidebar="sidebar"
          activity="activity"
        />,
      ),
    )

    await act(async () => window.dispatchEvent(new Event('hashchange')))

    expect(reload).not.toHaveBeenCalled()
  })
})

describe('the phone tab', () => {
  const render = (activityLabel?: string) =>
    act(async () =>
      root.render(
        <ProjectTabs
          tabs={[
            { label: 'Overview', content: 'overview' },
            { label: 'Tokens', content: 'tokens' },
          ]}
          sidebar="sidebar"
          activity="activity"
          {...(activityLabel ? { activityLabel } : {})}
        />,
      ),
    )

  it('reads Activity, as on juicebox.money, when no label is given, and #activity opens it', async () => {
    stubWidth(390)
    window.history.replaceState(null, '', '/eth:1#activity')
    await render()
    expect(tabs().map(tab => tab.textContent)).toEqual(['Activity', 'Overview', 'Tokens'])
    expect(selected()).toEqual(['Activity'])
  })

  it('reads the label it is given, which also names its hash', async () => {
    stubWidth(390)
    window.history.replaceState(null, '', '/base:23#latest')
    await render('Latest')
    expect(tabs().map(tab => tab.textContent)).toEqual(['Latest', 'Overview', 'Tokens'])
    expect(selected()).toEqual(['Latest'])

    await act(async () => tabs()[2].click())
    expect(window.location.hash).toBe('#tokens')
    await act(async () => tabs()[0].click())
    expect(window.location.hash).toBe('#latest')
  })

  it('is a phone\'s first tab, selected when the address names none, and no tab from 821 px', async () => {
    stubWidth(820)
    await render('Latest')
    expect(selected()).toEqual(['Latest'])

    await act(async () => root.unmount())
    root = createRoot(host)
    stubWidth(821)
    window.history.replaceState(null, '', '/base:23#latest')
    await render('Latest')
    expect(selected()).toEqual(['Overview'])
  })
})

describe('ProjectTabIcon', () => {
  it('uses the supplied newspaper artwork for Activity', async () => {
    await act(async () => root.render(<ProjectTabIcon label="Activity" />))
    expect(host.querySelector('[data-project-tab-icon="activity"]')).not.toBeNull()
  })

  it('uses the banknotes artwork for a non-revnet Funds tab', async () => {
    await act(async () => root.render(<ProjectTabIcon label="Funds" />))
    expect(host.querySelector('[data-project-tab-icon="funds"]')).not.toBeNull()
  })

  it('uses the banknotes for Airdrops and the stack for Tokens, as the old Sticky tabs did', async () => {
    await act(async () =>
      root.render(
        <>
          <ProjectTabIcon label="Airdrops" />
          <ProjectTabIcon label="Tokens" />
        </>,
      ),
    )
    expect([...host.querySelectorAll('[data-project-tab-icon]')].map(icon => icon.getAttribute('data-project-tab-icon'))).toEqual([
      'funds',
      'stack',
    ])
  })
})
