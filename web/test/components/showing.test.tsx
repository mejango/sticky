import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShowingPanel, useShowing } from '@/hooks/useShowing'
import { FakeObserver } from '../panel-fixtures'

// A tab panel says whether it is showing to the reads beneath it. The browser is the FakeObserver: a hidden panel is one
// it says does not intersect the viewport.

const Probe = () => <output>{String(useShowing())}</output>

let host: HTMLDivElement
let root: Root
const shown = () => host.querySelector('output')?.textContent

const render = (element: React.ReactNode) => act(async () => root.render(element))

beforeEach(() => {
  FakeObserver.all = []
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('a panel', () => {
  it('is showing until the browser says otherwise, and follows what it says', async () => {
    await render(
      <ShowingPanel>
        <Probe />
      </ShowingPanel>,
    )
    expect(shown()).toBe('true')
    await act(async () => FakeObserver.tell(false))
    expect(shown()).toBe('false')
    await act(async () => FakeObserver.tell(true))
    expect(shown()).toBe('true')
  })

  it('goes by the last of what the browser noticed at once', async () => {
    await render(
      <ShowingPanel>
        <Probe />
      </ShowingPanel>,
    )
    await act(async () => FakeObserver.tell(true, false))
    expect(shown()).toBe('false')
    await act(async () => FakeObserver.tell(false, true))
    expect(shown()).toBe('true')
  })

  it('observes its own element, a margin beyond the screen, and stops when it is gone', async () => {
    await render(
      <ShowingPanel className="space-y-5">
        <Probe />
      </ShowingPanel>,
    )
    expect(FakeObserver.all).toHaveLength(1)
    expect(FakeObserver.all[0].element).toBe(host.firstElementChild)
    expect(FakeObserver.all[0].element?.className).toBe('space-y-5')
    expect(FakeObserver.all[0].options).toEqual({ rootMargin: '600px 0px' })
    await act(async () => root.render(null))
    expect(FakeObserver.all).toHaveLength(0)
  })

  it('is showing where there is no way to tell', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    await render(
      <ShowingPanel>
        <Probe />
      </ShowingPanel>,
    )
    expect(shown()).toBe('true')
  })
})

describe('outside a panel', () => {
  it('everything is showing', async () => {
    await render(<Probe />)
    expect(shown()).toBe('true')
    expect(FakeObserver.all).toHaveLength(0)
  })
})
