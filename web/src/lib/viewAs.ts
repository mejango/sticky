'use client'

import { useSyncExternalStore } from 'react'
import { getAddress, isAddress, type Address } from 'viem'

/**
 * Site-wide "View as" (impersonation) mode: a localStorage-persisted address
 * the whole site renders account-scoped READS for. Writes stay bound to the
 * genuinely connected wallet and are refused at the write seams while the
 * mode is active (see VIEW_AS_WRITE_BLOCKED / assertNoViewAs).
 */

const STORAGE_KEY = 'jb-view-as-v1'

const listeners = new Set<() => void>()
/** undefined = not yet read from storage; null = explicitly inactive. */
let cached: Address | null | undefined

function readStorage(): Address | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw && isAddress(raw) ? getAddress(raw) : null
  } catch {
    return null
  }
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** The active view-as address, or null. Safe to call anywhere (SSR: null). */
export function getViewAs(): Address | null {
  if (cached === undefined) cached = readStorage()
  return cached
}

export function setViewAs(address: Address): void {
  const normalized = getAddress(address)
  cached = normalized
  try {
    window.localStorage.setItem(STORAGE_KEY, normalized)
  } catch {
    // Storage can be unavailable (private mode); the in-memory mode still works.
  }
  notify()
}

export function clearViewAs(): void {
  cached = null
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Ignore storage failures; the in-memory mode is already cleared.
  }
  notify()
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) return
  cached = readStorage()
  notify()
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage)
    }
  }
}

const getServerSnapshot = () => null

/** React view of the store. SSR-safe: null on the server render. */
export function useViewAs(): {
  viewAs: Address | null
  isViewAs: boolean
  setViewAs: (address: Address) => void
  clearViewAs: () => void
} {
  const viewAs = useSyncExternalStore(subscribe, getViewAs, getServerSnapshot)
  return { viewAs, isViewAs: viewAs !== null, setViewAs, clearViewAs }
}

export const VIEW_AS_WRITE_BLOCKED =
  "You're viewing the site as another account — exit View as to transact."

/** Write-seam guard: throws while view-as mode is active. */
export function assertNoViewAs(): void {
  if (getViewAs()) throw new Error(VIEW_AS_WRITE_BLOCKED)
}
