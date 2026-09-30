// @vitest-environment jsdom

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModalDialog, ModalShell } from '@/components/ui/ModalShell'
import { topLayerDialogs } from '../dialog-shim'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  document.body.style.overflow = ''
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.style.overflow = ''
})

function render(node: ReactNode) {
  act(() => root.render(node))
}

function dialogs(): HTMLDialogElement[] {
  return [...document.querySelectorAll('dialog')]
}

function only(): HTMLDialogElement {
  const found = dialogs()
  expect(found).toHaveLength(1)
  return found[0]
}

function pressEscape() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    )
  })
}

function mouseDownOn(target: EventTarget) {
  act(() => {
    target.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
    )
  })
}

describe('ModalShell', () => {
  it('opens a real dialog in the top layer with implicit modal semantics', () => {
    render(
      <ModalShell
        title="Add items"
        subtitle="Stage items"
        footer={<button type="button">Done</button>}
        onClose={vi.fn()}
      >
        <p>Body</p>
      </ModalShell>,
    )

    const dialog = only()
    expect(dialog.open).toBe(true)
    expect(topLayerDialogs()).toEqual([dialog])
    // `showModal()` makes role/aria-modal implicit; duplicating them by hand
    // is the pattern this migration removes.
    expect(dialog.getAttribute('role')).toBeNull()
    expect(dialog.getAttribute('aria-modal')).toBeNull()
    // The label association is NOT implicit and must survive.
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy!)?.textContent).toBe('Add items')
    const card = dialog.querySelector('[data-modal-card]')
    const body = dialog.querySelector('[data-modal-body]')
    const footer = dialog.querySelector('[data-modal-footer]')
    expect(card).not.toBeNull()
    expect(body?.nextElementSibling).toBe(footer)
    expect(footer?.parentElement).toBe(card)
    expect(body?.contains(footer)).toBe(false)
    const close = dialog.querySelector<HTMLButtonElement>(
      'button[aria-label="Close"]',
    )
    expect(close?.className).toContain('icon-button')
    expect(close?.className).toContain('-mr-2')
    expect(close?.querySelector('svg')?.className.baseVal).toContain('h-6')
    // The top layer supersedes z-index; no stacking context juggling remains.
    expect(dialog.className).not.toMatch(/z-\[/)
  })

  it('does not re-open an already open dialog on re-render', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal')
    render(
      <ModalShell title="One" onClose={vi.fn()}>
        <p>a</p>
      </ModalShell>,
    )
    render(
      <ModalShell title="One" onClose={vi.fn()}>
        <p>b</p>
      </ModalShell>,
    )

    expect(showModal).toHaveBeenCalledTimes(1)
    expect(only().open).toBe(true)
  })

  it('routes the native cancel event to onClose without letting the UA close it', () => {
    const onClose = vi.fn()
    render(
      <ModalShell title="One" onClose={onClose}>
        <p>a</p>
      </ModalShell>,
    )

    pressEscape()

    expect(onClose).toHaveBeenCalledTimes(1)
    // React owns `open`: the dialog stays up until the owner unmounts it, so a
    // guarded onClose can refuse.
    expect(only().open).toBe(true)
  })

  it('blocks every close path while busy', () => {
    const onClose = vi.fn()
    render(
      <ModalShell title="One" onClose={onClose} busy>
        <p>a</p>
      </ModalShell>,
    )
    const dialog = only()

    pressEscape()
    mouseDownOn(dialog)
    act(() => {
      dialog.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click()
    })

    expect(onClose).not.toHaveBeenCalled()
    expect(dialog.open).toBe(true)
  })

  it('closes on a backdrop click but not on a click inside the content', () => {
    const onClose = vi.fn()
    render(
      <ModalShell title="One" onClose={onClose}>
        <p id="inside">a</p>
      </ModalShell>,
    )
    const dialog = only()

    mouseDownOn(document.getElementById('inside')!)
    expect(onClose).not.toHaveBeenCalled()

    mouseDownOn(dialog)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes the dialog and leaves the top layer on unmount', () => {
    render(
      <ModalShell title="One" onClose={vi.fn()}>
        <p>a</p>
      </ModalShell>,
    )
    const dialog = only()

    act(() => root.render(null))

    expect(dialog.open).toBe(false)
    expect(topLayerDialogs()).toEqual([])
  })
})

describe('modal body scroll lock', () => {
  function Stack({ inner }: { inner: boolean }) {
    return (
      <ModalShell title="Outer" onClose={vi.fn()}>
        {inner ? (
          <ModalDialog labelledBy="inner-title" onClose={vi.fn()}>
            <div>
              <h2 id="inner-title">Inner</h2>
            </div>
          </ModalDialog>
        ) : null}
      </ModalShell>
    )
  }

  it('is reference counted so a stacked modal cannot unlock the page early', () => {
    document.body.style.overflow = 'scroll'

    render(<Stack inner={false} />)
    expect(document.body.style.overflow).toBe('hidden')

    render(<Stack inner />)
    expect(dialogs()).toHaveLength(2)
    expect(document.body.style.overflow).toBe('hidden')

    // Closing only the inner modal must NOT restore scrolling: the outer one
    // is still open. This is the leak the per-instance capture/restore had.
    render(<Stack inner={false} />)
    expect(document.body.style.overflow).toBe('hidden')

    act(() => root.render(null))
    expect(document.body.style.overflow).toBe('scroll')
  })

  it('stacks the later dialog above the earlier one in the top layer', () => {
    // Order in the top layer follows showModal() call order, which is what
    // production does: a modal is up, and the review dialog opens over it.
    render(<Stack inner={false} />)
    render(<Stack inner />)

    const [outer, inner] = dialogs()
    const layer = topLayerDialogs()
    expect(layer).toHaveLength(2)
    expect(layer[0]).toBe(outer)
    expect(layer[1]).toBe(inner)
    expect(inner.getAttribute('aria-labelledby')).toBe('inner-title')
  })
})

describe('ModalDialog', () => {
  it('keeps aria-describedby and honours dismissible=false', () => {
    const onClose = vi.fn()
    function Host() {
      const [dismissible, setDismissible] = useState(false)
      return (
        <ModalDialog
          labelledBy="t"
          describedBy="d"
          dismissible={dismissible}
          onClose={onClose}
        >
          <div>
            <h2 id="t">Review</h2>
            <p id="d">Description</p>
            <button type="button" onClick={() => setDismissible(true)}>
              allow
            </button>
          </div>
        </ModalDialog>
      )
    }
    render(<Host />)
    const dialog = only()
    expect(dialog.getAttribute('aria-describedby')).toBe('d')

    pressEscape()
    mouseDownOn(dialog)
    expect(onClose).not.toHaveBeenCalled()

    act(() => {
      dialog.querySelector('button')?.click()
    })
    pressEscape()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
