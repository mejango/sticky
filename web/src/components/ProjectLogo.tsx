'use client'

import Image from 'next/image'
import { useState } from 'react'
import { assetUrl } from '@/lib/sticky-metadata'

// Placeholder tiles in Sticky's colors, with checked contrast:
// ink on teal = 8.5, amber = 5.7, line = 11.3.
const TILES = ['bg-teal text-ink', 'bg-amber text-ink', 'bg-line text-ink']

/** Project logo image, or a colored initial tile when there's no usable logo. */
export type ProjectLogoProps = {
  name: string | null
  logoUri: string | null
  size: number
  className?: string
  onError?: () => void
  eager?: boolean
}

export function ProjectLogo({
  name,
  logoUri,
  size,
  className = '',
  onError,
  eager = false,
}: ProjectLogoProps) {
  const src = assetUrl(logoUri)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const label = name?.trim() || '?'
  const visibleSrc = src && failedSrc !== src ? src : null

  // Deterministic color from the name so placeholders are stable.
  let hash = 0
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0
  const tile = TILES[Math.abs(hash) % TILES.length]

  return (
    <span
      aria-hidden
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line font-agrandir-wide ${tile} ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {label[0].toUpperCase()}
      {visibleSrc ? (
        <Image
          src={visibleSrc}
          alt=""
          width={size}
          height={size}
          className="absolute inset-0 size-full object-cover"
          // A Sticky logo can be on any https host, and the image optimizer
          // knows only Center's gateway, which JBM leaves unoptimized too.
          unoptimized
          loading={eager ? 'eager' : 'lazy'}
          fetchPriority={eager ? 'high' : 'auto'}
          decoding={eager ? 'sync' : 'async'}
          onError={() => {
            setFailedSrc(visibleSrc)
            onError?.()
          }}
        />
      ) : null}
    </span>
  )
}
