'use client'

import { createContext, type ButtonHTMLAttributes, type ReactNode, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'

/**
 * Body scroll lock, reference counted.
 *
 * The browser gives us everything else about a modal for free once the dialog
 * is opened with `showModal()`, but not this. Counting matters because modals
 * stack: a per-instance capture/restore lets the inner dialog hand scrolling
 * back to the page while the outer one is still open. Only the first lock
 * captures the previous value, only the last release restores it.
 */
let scrollLocks = 0
let overflowBeforeFirstLock = ''

function lockBodyScroll(): () => void {
  if (scrollLocks === 0) {
    overflowBeforeFirstLock = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  scrollLocks += 1

  let released = false
  return () => {
    if (released) return
    released = true
    scrollLocks -= 1
    if (scrollLocks === 0) {
      document.body.style.overflow = overflowBeforeFirstLock
    }
  }
}

/**
 * Dialogs replace rather than stack: the dialog below a newly opened one stays
 * open in the top layer but paints nothing (see `[data-covered]` in
 * globals.css) until the newer one closes. Returns the uncover.
 */
function coverDialogsBelow(dialog: HTMLDialogElement) {
  const covered = Array.from(
    document.querySelectorAll<HTMLDialogElement>('dialog[open]:not([data-covered])'),
  ).filter(other => other !== dialog)
  covered.forEach(other => other.setAttribute('data-covered', ''))
  return () => covered.forEach(other => other.removeAttribute('data-covered'))
}

/**
 * The bare native modal: a `<dialog>` opened with `showModal()`, so the top
 * layer owns the backdrop, focus containment, and — the reason this exists —
 * the inertness of everything behind it. A screen reader cannot reach the page
 * under an open `showModal()` dialog, which no amount of `aria-modal` and
 * z-index could achieve.
 *
 * `role="dialog"` and `aria-modal` are implicit here and must not be repeated;
 * the labelling relationships are not, so pass `labelledBy`/`describedBy`.
 *
 * Use this directly only for modals whose chrome differs from {@link
 * ModalShell}'s titled card. Content must live in a single wrapper child:
 * clicks that land on the dialog element itself are backdrop clicks.
 */
export function ModalDialog({
  onClose,
  dismissible = true,
  labelledBy,
  describedBy,
  className = '',
  children,
}: {
  onClose: () => void
  /** When false, Escape and backdrop clicks are ignored (e.g. mid-send). */
  dismissible?: boolean
  labelledBy?: string
  describedBy?: string
  /** Layout utilities for the full-viewport dialog surface. */
  className?: string
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    // showModal() throws InvalidStateError on an already open dialog.
    if (!dialog.open) dialog.showModal()
    // showModal() hands focus to the first focusable descendant, which is the close button in every
    // shell here, so its focus ring lit up on every open. Start on the dialog itself instead.
    dialog.focus({ preventScroll: true })
    const uncover = coverDialogsBelow(dialog)
    const releaseScroll = lockBodyScroll()
    return () => {
      uncover()
      releaseScroll()
      if (dialog.open) dialog.close()
    }
  }, [])

  const dismiss = () => {
    if (dismissible) onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={`modal-dialog focus:outline-none ${className}`}
      tabIndex={-1}
      onCancel={event => {
        // React owns the open state: unmounting the element is what closes the
        // dialog. Always stop the UA from closing it itself, so an owner that
        // refuses to close (busy, discard confirm) keeps a live dialog rather
        // than a hidden one React still believes is open.
        event.preventDefault()
        dismiss()
      }}
      onMouseDown={event => {
        // Backdrop clicks target the dialog element; content is in a child.
        if (event.target === event.currentTarget) dismiss()
      }}
    >
      {children}
    </dialog>
  )
}

/** One close control for every dialog: full-size target, full-size mark. */
export function ModalCloseButton({
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`icon-button shrink-0 ${className}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
      </svg>
    </button>
  )
}

/**
 * The shared modal chrome: a native modal dialog with a bordered header
 * carrying the title and a × button. `busy` blocks every close path (backdrop,
 * Escape, ×) while transactions are in flight; `onClose` may layer its own
 * guards (e.g. a discard-confirm) on top.
 */
const ModalCardContext = createContext<HTMLDivElement | null>(null)

/**
 * The card of the ModalShell this component is rendered inside, or null when
 * it is not inside one. A confirm view uses it to replace the card's content
 * in place rather than open a second dialog over the first.
 */
export function useEnclosingModalCard(): HTMLDivElement | null {
  return useContext(ModalCardContext)
}

export function ModalShell({
  title,
  subtitle,
  footer,
  onClose,
  busy = false,
  maxWidth = 'max-w-2xl',
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  /** Fixed action row outside the scrolling body. */
  footer?: ReactNode
  onClose: () => void
  busy?: boolean
  maxWidth?: string
  children: ReactNode
}) {
  const titleId = useId()
  const [card, setCard] = useState<HTMLDivElement | null>(null)

  const close = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])

  return (
    <ModalDialog
      onClose={close}
      dismissible={!busy}
      labelledBy={titleId}
      className="items-start justify-center px-3 py-5 sm:px-6 sm:py-10"
    >
      <div
        ref={setCard}
        data-modal-card
        className={`card w-full ${maxWidth} overflow-hidden shadow-[0_24px_72px_rgba(19,17,25,0.28)] ${
          footer
            ? 'flex max-h-[calc(100dvh-2.5rem)] flex-col sm:max-h-[calc(100dvh-5rem)]'
            : ''
        }`}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-smoke-200 px-5 py-4 sm:px-6">
          <div className="min-w-0 flex-1 text-left">
            <h2 id={titleId} className="font-agrandir text-left text-xl font-medium text-ink">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-1 text-xs leading-relaxed text-smoke-700">
                {subtitle}
              </p>
            ) : null}
          </div>
          <ModalCloseButton
            onClick={close}
            disabled={busy}
            aria-label="Close"
            className="-mr-2 -mt-2 text-smoke-700 hover:bg-smoke-75 hover:text-ink disabled:opacity-50"
          />
        </div>

        <div
          data-modal-body
          className={`overflow-y-auto px-5 py-5 sm:px-6 ${
            footer ? 'min-h-0 flex-1' : 'max-h-[calc(100vh-10rem)]'
          }`}
        >
          <ModalCardContext.Provider value={card}>{children}</ModalCardContext.Provider>
        </div>
        {footer ? (
          <div
            data-modal-footer
            className="shrink-0 border-t border-smoke-200 bg-white px-5 py-4 sm:px-6"
          >
            {footer}
          </div>
        ) : null}
      </div>
    </ModalDialog>
  )
}
