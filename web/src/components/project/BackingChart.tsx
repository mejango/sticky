'use client'

import { useMemo, useState, type PointerEvent, type ReactNode } from 'react'
import { Revalidating } from '@/components/ui/Revalidating'
import { Skeleton } from '@/components/ui/Skeleton'
import { useBackingSeries } from '@/hooks/useStickyOverview'
import type { BackingSeries, SeriesPoint } from '@/lib/sticky-backing'
import { formatAmount } from '@/lib/sticky-format'

// The plot's size in viewBox units and where its axes are, as the old client's chart drew them.
const WIDTH = 640
const HEIGHT = 210
const LEFT = 34
const RIGHT = WIDTH - 10
const TOP = 20
const BASE = HEIGHT - 24

const STREAKS = '#2fb3c7'
const STUCK = '#1c2d33'

const sticks = (count: number) => `${count} active stick${count === 1 ? '' : 's'}`

/** A legend entry: the colour of a series and its name. */
function Chip({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span data-legend className="mr-2 inline-block rounded-[3px] border border-line bg-[#fdffff] px-2 py-0.5 text-[13px]">
      <i className="mr-1.5 inline-block size-2 rounded-[1px]" style={{ background: color }} />
      {children}
    </span>
  )
}

/**
 * Two stepped series over time, each scaled to its own peak, so the top line means both peaks and each caption names
 * its peak in its own unit and colour: there is no shared axis to label. Pointing at the plot, or focusing it, shows
 * the date, the active sticks and the amount at that time.
 */
function Plot({ series }: { series: BackingSeries }) {
  const { points, unit, supplyFallback } = series
  const [hoverX, setHoverX] = useState<number | null>(null)

  const plot = useMemo(() => {
    const t0 = points[0].timestamp
    const span = Math.max(points[points.length - 1].timestamp - t0, 1)
    const x = (timestamp: number) => LEFT + ((timestamp - t0) / span) * (RIGHT - LEFT)
    const maxStreaks = points.reduce((most, point) => Math.max(most, point.streaks), 1)
    const maxValue = points.reduce((most, point) => (point.value > most ? point.value : most), 1n)
    const yStreaks = (streaks: number) => BASE - (streaks / maxStreaks) * (BASE - TOP)
    const yValue = (value: bigint) => BASE - (Number((value * 1000n) / maxValue) / 1000) * (BASE - TOP)
    const date = (timestamp: number) =>
      new Date(timestamp * 1_000).toLocaleString(
        undefined,
        span < 2 * 86_400 ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' },
      )
    // A step: across to the next time, then up or down to its value.
    const path = (yOf: (point: SeriesPoint) => number) => {
      let d = ''
      let previous: string | null = null
      for (const point of points) {
        const px = x(point.timestamp).toFixed(1)
        const py = yOf(point).toFixed(1)
        d += d === '' ? `M ${px} ${py}` : ` H ${px}${py !== previous ? ` V ${py}` : ''}`
        previous = py
      }
      return d
    }
    /** What the plot says at `unitX` (held to the plot): the last step at or before that time. */
    const at = (unitX: number) => {
      const cx = Math.min(RIGHT, Math.max(LEFT, unitX))
      const time = t0 + ((cx - LEFT) / (RIGHT - LEFT)) * span
      let step = points[0]
      for (const candidate of points) {
        if (candidate.timestamp > time) break
        step = candidate
      }
      return {
        cx,
        date: date(time),
        streaks: sticks(step.streaks),
        value: `${formatAmount(step.value, unit.decimals, 2)} ${unit.symbol}`,
        streaksY: yStreaks(step.streaks),
        valueY: yValue(step.value),
        cardX: cx > WIDTH - 172 ? cx - 162 : cx + 8,
      }
    }
    return {
      t0,
      span,
      x,
      date,
      at,
      maxStreaks,
      maxValue,
      valuePath: path(point => yValue(point.value)),
      streaksPath: path(point => yStreaks(point.streaks)),
    }
  }, [points, unit])

  const { t0, span, x, date } = plot
  const hover = hoverX === null ? null : plot.at(hoverX)
  const name = `Active sticks and ${supplyFallback ? 'Sticky supply' : 'total stuck'} over time`

  const move = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width) setHoverX(((event.clientX - box.left) / box.width) * WIDTH)
  }

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      tabIndex={0}
      aria-label={hover ? `${hover.date}: ${hover.streaks}; ${hover.value}` : name}
      className="w-full max-w-[640px] cursor-crosshair touch-pan-y"
      onPointerMove={move}
      onPointerLeave={() => setHoverX(null)}
      onFocus={() => setHoverX(RIGHT)}
      onBlur={() => setHoverX(null)}
    >
      {[0.25, 0.5, 0.75].map(fraction => {
        const gx = x(t0 + span * fraction).toFixed(1)
        return (
          <g key={fraction}>
            <line x1={gx} y1={TOP} x2={gx} y2={BASE} stroke="#d8e7eb" strokeDasharray="2 4" />
            <text x={gx} y={HEIGHT - 8} fill="#64808a" fontSize={9} textAnchor="middle">
              {date(t0 + span * fraction)}
            </text>
          </g>
        )
      })}
      <line x1={LEFT} y1={(TOP + BASE) / 2} x2={RIGHT} y2={(TOP + BASE) / 2} stroke="#d8e7eb" strokeDasharray="2 4" />
      <line x1={LEFT} y1={BASE} x2={RIGHT} y2={BASE} stroke="#e2d7bd" />
      <line x1={LEFT} y1={TOP} x2={LEFT} y2={BASE} stroke="#e2d7bd" />
      <path d={plot.valuePath} fill="none" stroke={STUCK} strokeWidth={1.3} opacity={0.75} />
      <path d={plot.streaksPath} fill="none" stroke={STREAKS} strokeWidth={2} />
      <text x={LEFT} y={14} fill="#1a8fa1" fontSize={10} fontWeight={600}>
        {`Peak: ${sticks(plot.maxStreaks)}`}
      </text>
      <text x={RIGHT} y={14} fill={STUCK} fontSize={10} fontWeight={600} textAnchor="end">
        {`Peak: ${formatAmount(plot.maxValue, unit.decimals, 2)} ${unit.symbol} ${supplyFallback ? 'supply' : 'stuck'}`}
      </text>
      <text x={LEFT - 6} y={HEIGHT - 21} fill="#64808a" fontSize={10} textAnchor="end">
        0
      </text>
      <text x={LEFT} y={HEIGHT - 8} fill="#64808a" fontSize={10}>
        {date(t0)}
      </text>
      <text x={RIGHT} y={HEIGHT - 8} fill="#64808a" fontSize={10} textAnchor="end">
        now
      </text>
      {hover ? (
        <g data-hover pointerEvents="none">
          <line x1={hover.cx} y1={TOP} x2={hover.cx} y2={BASE} stroke="#64808a" strokeWidth={1} strokeDasharray="3 3" />
          <circle cx={hover.cx} cy={hover.streaksY} r={4} fill="#fdffff" stroke={STREAKS} strokeWidth={2} />
          <circle cx={hover.cx} cy={hover.valueY} r={4} fill="#fdffff" stroke={STUCK} strokeWidth={2} />
          <g data-card transform={`translate(${hover.cardX} 25)`}>
            <rect width={154} height={57} rx={4} fill="#fdffff" stroke="#d8e7eb" />
            <text x={9} y={15} fill="#64808a" fontSize={9} fontWeight={700}>
              {hover.date}
            </text>
            <rect x={9} y={24} width={7} height={7} rx={1} fill={STREAKS} />
            <text x={22} y={31} fill={STUCK} fontSize={10}>
              {hover.streaks}
            </text>
            <rect x={9} y={41} width={7} height={7} rx={1} fill={STUCK} />
            <text x={22} y={48} fill={STUCK} fontSize={10}>
              {hover.value}
            </text>
          </g>
        </g>
      ) : null}
    </svg>
  )
}

/**
 * The Overview's chart: Total stuck in the underlying token and the active sticks, from the project's first stick to
 * now. When the terminal's balance history cannot be read it plots the Sticky supply instead, and its legend and
 * captions say so. A kept copy of the project draws it as unconfirmed.
 */
export function BackingChart({ chainId, projectId }: { chainId: number; projectId: number }) {
  const { series, failed, unavailable, unconfirmed, retry } = useBackingSeries(chainId, projectId)

  return (
    <section className="card mb-5 p-5">
      <div className="mb-2">
        <Chip color={STUCK}>{series?.supplyFallback ? 'Sticky supply' : 'Total stuck'}</Chip>
        <Chip color={STREAKS}>Active sticks</Chip>
      </div>
      {series ? (
        series.points.length === 0 ? (
          <p className="text-muted">no sticks yet</p>
        ) : (
          <Revalidating as="div" pending={unconfirmed}>
            <Plot series={series} />
          </Revalidating>
        )
      ) : failed ? (
        <p role="alert" className="text-err">
          Could not read the chart.{' '}
          <button type="button" className="btn-link font-semibold" onClick={retry}>
            Try again
          </button>
        </p>
      ) : (
        <Skeleton className={`h-[210px] w-full rounded ${unavailable ? '[animation:none]' : ''}`} />
      )}
    </section>
  )
}
