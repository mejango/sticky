'use client'

import { useEffect, type RefObject } from 'react'

/**
 * Close a menu/popover on any pointerdown outside `ref`. Pass `enabled` so
 * closed menus don't keep a document listener registered.
 */
export function useOutsideClose(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [enabled, onClose, ref])
}
