'use client'

import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import dripCorner from '../../public/assets/drip-corner.png'
import dripRound from '../../public/assets/drip-round.png'
import { HomeLink } from '@/components/HomeLink'
import { WalletButton } from '@/components/WalletButton'

/** Pixels of blank page above the header. Equals `--top-fold-height` in globals.css. */
const TOP_FOLD_HEIGHT = 50

/**
 * Scrolls a page past its top fold once it has loaded, and reports whether the
 * fold is still in view. Nothing else ever moves the scroll position: a page
 * that is already scrolled past the fold is left where it is.
 */
function useTopFold() {
  const pathname = usePathname()
  const [inView, setInView] = useState(true)

  useEffect(() => {
    const sync = () => setInView(window.scrollY < TOP_FOLD_HEIGHT)
    const fold = () => {
      if (window.scrollY < TOP_FOLD_HEIGHT) window.scrollTo(0, TOP_FOLD_HEIGHT)
      sync()
    }
    let frame = 0
    const settle = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fold)
    }
    sync()
    settle()
    // Mobile browsers can restore the scroll position, or settle their
    // address bar, after the page has loaded.
    const late = setTimeout(fold, 150)
    window.addEventListener('scroll', sync, { passive: true })
    window.addEventListener('load', settle, { once: true })
    window.addEventListener('pageshow', settle)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(late)
      window.removeEventListener('scroll', sync)
      window.removeEventListener('load', settle)
      window.removeEventListener('pageshow', settle)
    }
    // A new page starts at the top of the document, so it folds again.
  }, [pathname])

  return inView
}

export function SiteHeader() {
  const foldInView = useTopFold()
  return (
    <>
      {/* The reflected half of the drip, in the fold. Pointer only: the logo
          below is the link for everyone else. */}
      <HomeLink className="overscroll-slime" aria-hidden="true" tabIndex={-1}>
        <Image src={dripRound} alt="" width={54} height={52} />
      </HomeLink>
      <header className="site-header">
        <HomeLink className="brand-slime" aria-label="Go to homepage">
          <Image src={dripCorner} alt="" width={54} height={69} preload />
        </HomeLink>
        <div
          className={
            foldInView
              ? 'site-header-wallet top-fold-fixed'
              : 'site-header-wallet'
          }
        >
          <WalletButton />
        </div>
      </header>
    </>
  )
}
