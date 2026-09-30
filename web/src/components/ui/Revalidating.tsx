'use client'

import type { ReactNode } from 'react'

/**
 * Wraps a value restored from the last session while it is being confirmed
 * against the chain. The number stays readable — it fades and sweeps rather
 * than collapsing to a skeleton — so a return visit shows data immediately
 * instead of a spinner.
 *
 * Pass `pending` only when there is already something to show; a first-ever
 * load has no cached value and should still use a skeleton.
 */
export function Revalidating({
  pending,
  children,
  className = '',
  as: Component = 'span',
}: {
  pending: boolean
  children: ReactNode
  className?: string
  /** Use 'div' to mark a whole block, e.g. a table that is refreshing. */
  as?: 'span' | 'div'
}) {
  if (!pending) return <Component className={className}>{children}</Component>
  return (
    <Component
      className={`revalidating ${className}`.trim()}
      aria-busy="true"
      title="Confirming against the chain…"
    >
      {children}
    </Component>
  )
}
