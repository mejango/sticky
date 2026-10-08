'use client'

import { usePathname } from 'next/navigation'
import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { SiteFooter } from '@/components/SiteFooter'
import { SiteHeader } from '@/components/SiteHeader'

const StickyLaunchHost = dynamic(() => import('@/components/create/StickyLaunchHost').then(module => module.StickyLaunchHost), { ssr: false })

/**
 * The header, the page column and the footer around every page except the
 * Signa sign-in's (`/center/callback`). Sticky frames that page inside its
 * sign-in dialog and sizes the frame to it, so it renders bare, on the
 * dialog's own card color.
 */
export function SiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  if (pathname.startsWith('/center/'))
    return <div className="min-h-screen bg-card">{children}</div>
  return (
    <div className="site-fold">
      <div className="site-page">
        <SiteHeader />
        <main id="main-content">{children}</main>
      </div>
      <SiteFooter />
      <StickyLaunchHost />
    </div>
  )
}
