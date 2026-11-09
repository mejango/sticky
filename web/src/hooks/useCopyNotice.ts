'use client'

import { useEffect, useState } from 'react'

/** What became of the last copy, for `ms` after it: each copy restarts the time, so a second copy keeps its notice. */
export function useCopyNotice<Notice extends string>(ms: number): [Notice | null, (notice: Notice) => void] {
  const [shown, setShown] = useState<{ notice: Notice } | null>(null)
  useEffect(() => {
    if (!shown) return
    const timer = setTimeout(() => setShown(null), ms)
    return () => clearTimeout(timer)
  }, [shown, ms])
  return [shown?.notice ?? null, notice => setShown({ notice })]
}
