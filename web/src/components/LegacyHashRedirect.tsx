'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { legacyRoute } from '@/lib/legacy-routes'

/**
 * Sends a link from the old client (`/?chain=8453#/project/23`) to the page it named (`/base:23`). The home page mounts
 * it, because every old link was written as `/`. The server never sees a hash, so the address is read in the browser,
 * once, as the page loads. The router replaces it, so Back does not return to the old address, and what it leaves is
 * never an old link itself (see `legacyRoute`), so the visitor is not sent round again.
 */
export function LegacyHashRedirect() {
  const router = useRouter()
  useEffect(() => {
    const path = legacyRoute(window.location.search, window.location.hash)
    if (path !== null) router.replace(path)
  }, [router])
  return null
}
