import type { ChainEnvironment } from '@/lib/chains'

export const STICKY_LAUNCH_EVENT = 'sticky:open-launch'
let pending: ChainEnvironment | null = null

export function openStickyLaunch(environment: ChainEnvironment = 'production') {
  pending = environment
  window.dispatchEvent(new CustomEvent(STICKY_LAUNCH_EVENT, { detail: environment }))
}

/** A click can precede the lazy dialog host; keep it until that host has mounted. */
export function takeStickyLaunchRequest(): ChainEnvironment | null {
  const request = pending
  pending = null
  return request
}
