'use client'

import { useRef, useState, type PointerEvent } from 'react'
import { Revalidating } from '@/components/ui/Revalidating'
import { Skeleton } from '@/components/ui/Skeleton'
import { securedBars, type SecuredSeries } from '@/lib/sticky-home'

/** Millionths of a dollar as dollars and cents, half a cent rounding up: `$1,234.57`. */
function formatUsd(micros: bigint): string {
  const cents = (micros + 5_000n) / 10_000n
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `$${dollars}.${(cents % 100n).toString().padStart(2, '0')}`
}

const day = (timestamp: number) =>
  new Date(timestamp * 1_000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

const ESTIMATE =
  "Current claimable backing at today's token price. History estimates past shares at today's backing per share and price."

/**
 * "Secured by Sticky": today's value, and 28 bars of its history. Pointing at a bar, or touching it, shows its date
 * and value; the plot takes focus, picks today's bar, and ← and → walk the bars. Until it has a series it draws a
 * placeholder.
 */
export function SecuredChart({ series, pending }: { series: SecuredSeries | null; pending: boolean }) {
  const [active, setActive] = useState(-1)
  const plotted = useRef<HTMLDivElement>(null)
  const bars = series ? securedBars(series) : []
  const picked = active >= 0 && active < bars.length ? bars[active] : null
  const value = series ? (series.hasValue ? formatUsd(series.total) : '$—') : null
  const named = series ? `${series.hasValue ? formatUsd(series.total) : 'USD value unavailable'} secured by Sticky` : ''

  const pick = (index: number) => setActive(Math.min(bars.length - 1, Math.max(0, index)))
  const pickAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = plotted.current?.getBoundingClientRect()
    if (box?.width) pick(Math.floor(((event.clientX - box.left) / box.width) * bars.length))
  }

  return (
    <section id="home-secured" aria-labelledby="home-secured-label">
      <div className="flex min-h-16 flex-col items-center gap-1.5 text-center sm:flex-row sm:items-end sm:justify-between sm:gap-5 sm:text-left">
        <div>
          {value === null ? (
            <Skeleton className="mx-auto h-10 w-[180px] max-w-[60%] rounded sm:mx-0" />
          ) : (
            <Revalidating pending={pending} as="div">
              <div
                id="home-secured-value"
                title={series?.missing.length ? `Could not price ${series.missing.join(', ')}` : ESTIMATE}
                className="font-agrandir-wide text-[clamp(28px,3vw,42px)] leading-[1.05] tracking-[-0.02em] tabular-nums"
              >
                {value}
              </div>
            </Revalidating>
          )}
          <div id="home-secured-label" className="text-sm font-semibold text-muted">
            Secured by Sticky
          </div>
        </div>
        <div
          aria-live="polite"
          className={`flex w-full justify-between gap-2.5 whitespace-nowrap pb-[3px] text-xs text-muted sm:w-auto sm:justify-start sm:gap-[22px] ${
            picked ? '' : 'invisible'
          }`}
        >
          <span>
            Date: <b className="font-semibold text-ink">{picked ? day(picked.timestamp) : ''}</b>
          </span>
          <span>
            Value: <b className="font-semibold text-ink">{picked ? `≈ ${formatUsd(picked.value)}` : ''}</b>
          </span>
        </div>
      </div>
      {series ? (
        <div
          role="img"
          tabIndex={0}
          aria-label={picked ? `${day(picked.timestamp)}: ${formatUsd(picked.value)} secured by Sticky` : named}
          className="relative mt-1.5 h-[210px] w-full touch-pan-y focus-visible:outline-amber focus-visible:outline-offset-4 sm:mt-3 sm:h-60"
          onPointerMove={pickAt}
          onPointerDown={pickAt}
          onPointerLeave={event => {
            // A finger lifting off leaves its bar picked, so it can be read.
            if (event.pointerType !== 'touch') setActive(-1)
          }}
          // A tap focuses the plot after picking its bar: focus picks today's bar only when none is picked.
          onFocus={() => setActive(current => (current < 0 ? bars.length - 1 : current))}
          onBlur={() => setActive(-1)}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            pick(active < 0 ? bars.length - 1 : active + (event.key === 'ArrowRight' ? 1 : -1))
          }}
        >
          <div
            ref={plotted}
            data-bars
            aria-hidden="true"
            className="absolute bottom-[31px] left-[42px] right-2 top-7 flex items-end gap-[clamp(2px,0.35vw,5px)] border-b border-line sm:left-[54px]"
          >
            {bars.map((bar, index) => (
              <span
                key={index}
                data-bar
                data-active={index === active ? 'true' : undefined}
                title={`${day(bar.timestamp)}: ${formatUsd(bar.value)} (current backing and price estimate)`}
                className={`min-w-px flex-1 rounded-t-[2px] transition-[background-color,opacity] duration-[90ms] ${
                  index === active ? 'bg-amber' : `bg-[#cfe2e7] ${picked ? 'opacity-[0.68]' : ''}`
                }`}
                style={{ height: `${bar.height.toFixed(2)}%` }}
              />
            ))}
          </div>
          <span className="absolute bottom-[7px] left-[42px] text-[11px] leading-none text-muted sm:left-[54px]">
            {day(bars[0].timestamp)}
          </span>
          <span className="absolute bottom-[7px] right-2 text-[11px] leading-none text-muted">
            {day(bars[bars.length - 1].timestamp)}
          </span>
        </div>
      ) : (
        <Skeleton className="mt-1.5 h-[210px] w-full rounded sm:mt-3 sm:h-60" />
      )}
      {series?.hasValue ? (
        <p className="mt-2 text-[13px] text-muted">
          History estimates past shares at today&apos;s backing per share and token price.
        </p>
      ) : null}
    </section>
  )
}
