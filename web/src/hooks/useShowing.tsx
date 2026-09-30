'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

/**
 * Whether the tab panel a read is made for is showing. The tabs keep a panel mounted once it has been shown and only
 * hide it, so a read that goes on every 15 seconds would go on for a panel nobody sees. A hidden panel is not laid out,
 * and an element that is not laid out never intersects the viewport, which is how `ShowingPanel` tells: it observes its
 * own element. A panel that is only off the screen counts as showing while it is within `MARGIN` of it, so it has read
 * by the time it is scrolled to. Where there is no IntersectionObserver to ask, every panel is showing.
 */

/** How far outside the viewport, above and below, a panel still counts as showing. */
const MARGIN = '600px 0px'

const Showing = createContext(true)

/** The root of a tab panel's content: whatever reads beneath it is told, by `useShowing`, whether the panel is showing. */
export function ShowingPanel({ className, children }: { className?: string; children: ReactNode }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [showing, setShowing] = useState(true)

  useEffect(() => {
    if (element === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      entries => {
        const latest = entries.at(-1)
        if (latest) setShowing(latest.isIntersecting)
      },
      { rootMargin: MARGIN },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return (
    <Showing.Provider value={showing}>
      <div ref={setElement} className={className}>
        {children}
      </div>
    </Showing.Provider>
  )
}

/** Whether the panel this is called under is showing: true outside any panel. */
export const useShowing = () => useContext(Showing)
