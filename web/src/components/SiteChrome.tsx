'use client'

import { usePathname } from 'next/navigation'
import dynamic from 'next/dynamic'
import type { ReactNode } from 'react'
import { SiteFooter } from '@/components/SiteFooter'
import { SiteHeader } from '@/components/SiteHeader'
import { useWallet } from '@/hooks/useWallet'

const StickyLaunchHost = dynamic(() => import('@/components/create/StickyLaunchHost').then(module => module.StickyLaunchHost), { ssr: false })
// The SDK's notice of held writes loads only once a wallet is connected.
const HeldNotice = dynamic(() => import('@/components/HeldNotice').then(module => module.HeldNotice), { ssr: false })

/**
 * The header, the page column and the footer around every page except the
 * Signa sign-in's (`/center/callback`). Sticky frames that page inside its
 * sign-in dialog and sizes the frame to it, so it renders bare, on the
 * dialog's own card color.
 */
export function SiteChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { address } = useWallet()
  if (pathname.startsWith('/center/'))
    return <div className="min-h-screen bg-card">{children}</div>
  return (
    <div className="site-fold">
      <div className="site-page">
        <SiteHeader />
        {address ? <HeldNotice account={address} /> : null}
        <main id="main-content">{children}</main>
      </div>
      <SiteFooter />
      <StickyLaunchHost />
    </div>
  )
}
