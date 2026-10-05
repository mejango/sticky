'use client'

import { useEffect, useState } from 'react'

/** How long a copy button says what became of the copy. */
const COPY_NOTICE_MS = 1_500

const COPY_REFUSED = 'Could not copy an address to the clipboard.'

/**
 * A copy button for an address: it says "Copied!" for a moment, or "Could not copy" when the browser refuses. The button
 * is named for what it copies, which hides its text from a screen reader, so what became of the copy is also said in a
 * live region beside it, which is always there for the announcement to be made in.
 */
export function CopyAddress({ label, address }: { label: string; address: string }) {
  const [notice, setNotice] = useState<'copied' | 'refused' | null>(null)
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => setNotice(null), COPY_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setNotice('copied')
    } catch (error) {
      console.warn(COPY_REFUSED, error)
      setNotice('refused')
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label={`Copy ${label} address`}
        onClick={() => void copy()}
        className={`btn-link ml-2 min-h-0 align-baseline text-xs font-medium decoration-amber ${notice === 'refused' ? 'text-err' : ''}`}
      >
        {notice === 'copied' ? 'Copied!' : notice === 'refused' ? 'Could not copy' : 'Copy'}
      </button>
      <span role="status" aria-atomic="true" className="sr-only">
        {notice === 'copied' ? 'Address copied.' : notice === 'refused' ? 'Could not copy the address.' : ''}
      </span>
    </>
  )
}
