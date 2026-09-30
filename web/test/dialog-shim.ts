/**
 * TEST-ONLY polyfill for the native `<dialog>` modal API.
 *
 * jsdom 29.1.1 ships `HTMLDialogElement` with exactly one member — the `open`
 * attribute reflection. `showModal()`, `close()`, `returnValue`, the
 * `cancel`/`close` events, the `:modal` pseudo-class and the top layer are all
 * absent, so any unit test of the modal shell would throw
 * "showModal is not a function". This file implements just enough of the spec
 * for the shell's contract to be assertable:
 *
 *   - `showModal()` throws `InvalidStateError` when the dialog is already open
 *     (the exact behaviour the shell guards against) or is not connected.
 *   - `showModal()`/`close()` maintain a top-layer stand-in whose order is
 *     observable through {@link topLayerDialogs}, so stacking can be asserted.
 *   - `showModal()` moves focus into the dialog and `close()` restores it,
 *     mirroring the UA's focus-fixup steps.
 *   - Escape on the topmost modal fires a cancelable `cancel` event and closes
 *     the dialog unless that event is default-prevented.
 *   - `close()` fires a non-bubbling `close` event and sets `returnValue`.
 *
 * What it deliberately does NOT emulate is inertness: jsdom has no layout, no
 * hit testing and no top layer, so "the page behind an open modal cannot be
 * reached" is unprovable here. That is what `test/browser/modal.spec.ts`
 * exists for; treat the browser suite as the real accessibility proof and this
 * shim as scaffolding for the state machine around it.
 */

import { afterEach } from 'vitest'

type ShimmedDialog = HTMLDialogElement

const topLayer: ShimmedDialog[] = []
const focusBeforeOpen = new WeakMap<ShimmedDialog, Element | null>()
const returnValues = new WeakMap<ShimmedDialog, string>()

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'

/** Top layer, bottom-most first. The last entry is the topmost modal. */
export function topLayerDialogs(): readonly ShimmedDialog[] {
  return topLayer
}

function popFromTopLayer(dialog: ShimmedDialog) {
  const index = topLayer.indexOf(dialog)
  if (index !== -1) topLayer.splice(index, 1)
}

function focusInto(dialog: ShimmedDialog) {
  const target =
    dialog.querySelector<HTMLElement>('[autofocus]') ??
    dialog.querySelector<HTMLElement>(FOCUSABLE) ??
    dialog
  target.focus?.()
}

function install(scope: typeof globalThis & { HTMLDialogElement?: unknown }) {
  const Dialog = scope.HTMLDialogElement as
    | (typeof HTMLDialogElement & { prototype: Record<string, unknown> })
    | undefined
  if (!Dialog) return
  const proto = Dialog.prototype
  if (typeof proto.showModal === 'function') return

  proto.showModal = function showModal(this: ShimmedDialog) {
    if (this.hasAttribute('open')) {
      throw new DOMException(
        'showModal() called on an already open dialog',
        'InvalidStateError',
      )
    }
    if (!this.isConnected) {
      throw new DOMException(
        'showModal() called on a disconnected dialog',
        'InvalidStateError',
      )
    }
    focusBeforeOpen.set(this, this.ownerDocument.activeElement)
    this.setAttribute('open', '')
    topLayer.push(this)
    focusInto(this)
  }

  proto.close = function close(this: ShimmedDialog, returnValue?: string) {
    if (!this.hasAttribute('open')) return
    if (typeof returnValue === 'string') returnValues.set(this, returnValue)
    this.removeAttribute('open')
    popFromTopLayer(this)
    const restore = focusBeforeOpen.get(this)
    focusBeforeOpen.delete(this)
    if (restore instanceof scope.HTMLElement) restore.focus()
    this.dispatchEvent(new Event('close', { bubbles: false, cancelable: false }))
  }

  Object.defineProperty(proto, 'returnValue', {
    configurable: true,
    get(this: ShimmedDialog) {
      return returnValues.get(this) ?? ''
    },
    set(this: ShimmedDialog, value: string) {
      returnValues.set(this, String(value))
    },
  })

  // The UA, not the document, routes Escape to the topmost modal dialog.
  scope.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    const dialog = topLayer[topLayer.length - 1]
    if (!dialog) return
    const cancelled = !dialog.dispatchEvent(
      new Event('cancel', { bubbles: false, cancelable: true }),
    )
    if (!cancelled) dialog.close()
  })
}

if (typeof window !== 'undefined') {
  install(window as unknown as typeof globalThis)

  // A test that unmounts a dialog without closing it would otherwise leave a
  // stale entry behind and corrupt the next test's stacking assertions.
  afterEach(() => {
    topLayer.length = 0
  })
}
