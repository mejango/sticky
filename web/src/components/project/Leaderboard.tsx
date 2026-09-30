'use client'

import { useMemo, useState, type ReactNode } from 'react'
import type { Address } from 'viem'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { Skeleton, SkeletonTable } from '@/components/ui/Skeleton'
import { useStickyHolders } from '@/hooks/useStickyProject'
import { useCheckedBalances } from '@/hooks/useStickyTokens'
import { formatAmount, formatDuration } from '@/lib/sticky-format'
import type { HolderRow } from '@/lib/sticky-holders'
import { backingOfShares, type StickyProjectInfo } from '@/lib/sticky-project'

type Sort = 'oldest' | 'biggest'

const SORTS: readonly { sort: Sort; label: string }[] = [
  { sort: 'oldest', label: 'Oldest' },
  { sort: 'biggest', label: 'Biggest' },
]
const PAGE_SIZE = 20

const HEADING = 'whitespace-nowrap border-b border-line py-1 pr-2 text-left text-[13px] font-semibold tracking-[1px] text-muted'
const CELL = 'whitespace-nowrap border-b border-line py-[5px] pr-2'

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
const sameAccount = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase()

const byShares = (a: HolderRow, b: HolderRow) => (a.staked === b.staked ? 0 : a.staked > b.staked ? -1 : 1)
const byStreak = (a: HolderRow, b: HolderRow) => b.current - a.current
const byAddress = (a: HolderRow, b: HolderRow) => (a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0)

/** The holders in order. Oldest first is the longest active streak, then the most shares; biggest first is the most
 * shares, then the longest streak. Holders equal in both go by address, so a page keeps its order. */
function ranked(rows: readonly HolderRow[], sort: Sort): HolderRow[] {
  const [first, second] = sort === 'oldest' ? [byStreak, byShares] : [byShares, byStreak]
  return [...rows].sort((a, b) => first(a, b) || second(a, b) || byAddress(a, b))
}

// --------------------------------------------------------------------------------------------------------- the pie

const RADIUS = 56
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
/** How wide a character is, in ems. The middle of the pie is 90 units across, and each of the three lines there has the
 * room of the chord at its height, from the font size it starts at. */
const CHARACTER_EM = 0.56
const MIDDLE_LINES = [
  { y: 60, size: 7.5, room: 72, className: 'fill-ink font-semibold' },
  { y: 77, size: 8, room: 78, className: 'fill-muted' },
  { y: 94, size: 9, room: 66, className: 'fill-accent font-bold' },
] as const

/** A line for the middle of the pie that fits `maxWidth`: its font shrinks from `size` to 6, and then it ends in an
 * ellipsis. The width is estimated from the characters, so the text fits before a font is measured. */
function fitted(text: string, maxWidth: number, size: number): { text: string; size: number } {
  const width = (each: string, at: number) => each.length * at * CHARACTER_EM
  let fontSize = size
  while (width(text, fontSize) > maxWidth && fontSize > 6) fontSize -= 0.5
  let shown = text
  for (let keep = text.length - 1; keep > 1 && width(shown, fontSize) > maxWidth; keep -= 1) {
    shown = `${text.slice(0, keep)}…`
  }
  return { text: shown, size: fontSize }
}

/**
 * The holders as a donut, a slice for each by its shares, and in the middle whichever slice is pointed at or has the
 * focus: the first, the biggest, until one is. Its total is what these holders hold, and its share of all the Sticky
 * shares, from the project's own supply.
 */
function HolderPie({
  rows,
  info,
  you,
  active,
  onActive,
}: {
  rows: readonly HolderRow[]
  info: StickyProjectInfo
  you: Address | null
  active: number | null
  onActive: (index: number | null) => void
}) {
  const total = rows.reduce((sum, row) => sum + row.staked, 0n)
  if (total === 0n) return null
  const { stSymbol: symbol, totalSupply } = info
  const totalPercent = totalSupply > 0n ? Number((total * 1_000_000n) / totalSupply) / 10_000 : 0
  const gap = rows.length > 1 ? 1.5 : 0
  const percentOf = (row: HolderRow) => Number((row.staked * 1_000_000n) / total) / 10_000
  const named = (row: HolderRow, suffix: string) => `${short(row.holder)}${sameAccount(row.holder, you) ? suffix : ''}`

  const slices: { row: HolderRow; start: number; length: number }[] = []
  let offset = 0
  for (const row of rows) {
    const share = Number((row.staked * 10_000n) / total) / 10_000
    slices.push({ row, start: offset, length: Math.max(share * CIRCUMFERENCE - gap, 0.5) })
    offset += share
  }

  const showing = active === null ? undefined : rows[active]
  const middle = showing
    ? [named(showing, ' (you)'), `${formatAmount(showing.staked, 18)} ${symbol}`, `${percentOf(showing).toFixed(2)}%`]
    : ['', '', '']

  return (
    <div className="w-[260px] max-w-full text-center">
      <svg
        width="190"
        height="190"
        viewBox="0 0 140 140"
        aria-label="Owner distribution"
        className="mx-auto block h-auto w-[190px] overflow-visible"
        onPointerLeave={() => onActive(null)}
      >
        <circle r={RADIUS} cx="70" cy="70" fill="none" strokeWidth="22" className="stroke-line" />
        {slices.map(({ row, start, length }, at) => (
          <circle
            key={row.holder}
            role="img"
            tabIndex={0}
            aria-label={`${named(row, ', you')}: ${formatAmount(row.staked, 18)} ${symbol}, ${percentOf(row).toFixed(2)}%`}
            r={RADIUS}
            cx="70"
            cy="70"
            fill="none"
            strokeWidth={at === active ? 25 : 22}
            strokeDasharray={`${length.toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`}
            strokeDashoffset={(-start * CIRCUMFERENCE).toFixed(2)}
            transform="rotate(-90 70 70)"
            opacity={active === null ? 0.88 : at === active ? 1 : 0.42}
            className="cursor-pointer stroke-amber transition-[opacity,stroke-width] duration-100"
            onPointerEnter={() => onActive(at)}
            onFocus={() => onActive(at)}
            onBlur={() => onActive(null)}
            onClick={() => onActive(at)}
          />
        ))}
        <g aria-hidden="true">
          {MIDDLE_LINES.map(({ y, size, room, className }, at) => {
            const line = fitted(middle[at], room, size)
            return (
              <text key={y} x="70" y={y} textAnchor="middle" fontSize={line.size} className={className}>
                {line.text}
              </text>
            )
          })}
        </g>
      </svg>
      <div className="mt-2.5 text-[13px] leading-[1.4] text-muted">
        <div className="truncate">
          <b className="font-semibold text-ink">{formatAmount(total, 18)}</b> {symbol}
        </div>
        <div className="truncate">
          <b className="font-semibold text-ink">{totalPercent.toFixed(2)}%</b> of all {symbol}
        </div>
      </div>
      <span className="sr-only" aria-live="polite">
        {showing
          ? `${named(showing, ' (you)')}, ${formatAmount(showing.staked, 18)} ${symbol}, ${percentOf(showing).toFixed(2)} percent`
          : ''}
      </span>
    </div>
  )
}

// ----------------------------------------------------------------------------------------------------- the board

/**
 * Everyone who has shares staked: the pie, and a leaderboard beside it that ranks them Oldest or Biggest, 20 to a page.
 * The order comes from the index, and the balances on the page shown are read again from the hook, one page at a time:
 * a balance it says otherwise about replaces the index's, and if it cannot be read the index's stay. A list of holders
 * that cannot be read says so; it is never taken for nobody.
 */
export function Leaderboard({
  chainId,
  projectId,
  info,
  you,
}: {
  chainId: number
  projectId: number
  info: StickyProjectInfo | undefined
  you: Address | null
}) {
  const holders = useStickyHolders(chainId, projectId)
  const [sort, setSort] = useState<Sort>('oldest')
  const [requested, setRequested] = useState(0)
  const [active, setActive] = useState<number | null>(0)

  const rows = holders.data?.rows
  const order = useMemo(() => (rows ? ranked(rows, sort) : []), [rows, sort])
  const pages = Math.max(1, Math.ceil(order.length / PAGE_SIZE))
  const page = Math.min(requested, pages - 1)
  const shown = order.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const balances = useCheckedBalances(chainId, projectId, shown).data
  const checked = balances ? shown.map((row, at) => ({ ...row, staked: balances[at] })) : shown

  const choose = (next: Sort) => {
    setSort(next)
    setRequested(0)
  }
  const pieHolder = active === null ? undefined : rows?.[active]?.holder

  let body: ReactNode
  if (holders.isError && !rows) {
    body = (
      <p role="alert" className="py-2 text-sm text-err">
        Could not read the holders.{' '}
        <button type="button" className="btn-link font-semibold" onClick={() => void holders.refetch()}>
          Try again
        </button>
      </p>
    )
  } else if (!rows || !info) {
    body = (
      <div aria-busy="true" className="flex flex-wrap items-start gap-6">
        <Skeleton className="size-[190px] shrink-0 rounded-full" />
        <div className="min-w-[240px] flex-1">
          <SkeletonTable rows={5} columns={5} />
        </div>
      </div>
    )
  } else if (!rows.length) {
    body = <p className="py-2 text-sm text-muted">Nobody is stuck yet.</p>
  } else {
    body = (
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex-none">
          <HolderPie rows={rows} info={info} you={you} active={active} onActive={setActive} />
        </div>
        <div className="min-w-0 flex-[1_1_300px]">
          <div role="group" aria-label="Order of holders" className="mb-3 flex gap-6 border-b border-line">
            {SORTS.map(({ sort: each, label }) => (
              <button
                key={each}
                type="button"
                aria-pressed={sort === each}
                onClick={() => choose(each)}
                className={`min-h-10 whitespace-nowrap border-b-2 px-1 font-agrandir-wide text-sm font-bold ${
                  sort === each ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <div role="region" aria-label="Holders" tabIndex={0} className="w-full overflow-x-auto overscroll-x-contain">
            <table className="w-max min-w-[400px] border-collapse">
              <thead>
                <tr>
                  {['#', 'ACCOUNT', '%', 'STUCK', 'AGE'].map(heading => (
                    <th key={heading} className={HEADING}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {checked.map((row, at) => {
                  const share = info.totalSupply > 0n ? Number((row.staked * 10_000n) / info.totalSupply) / 100 : 0
                  return (
                    <tr
                      key={row.holder}
                      data-active={pieHolder === row.holder}
                      // Accent text is under 4.5:1 on the highlight, so the highlighted row's text is ink.
                      className="group data-[active=true]:bg-[#e6f3f6]"
                    >
                      <td className={CELL}>{page * PAGE_SIZE + at + 1}</td>
                      <td className={`${CELL} text-muted group-data-[active=true]:text-ink`}>
                        <AddressLabel address={row.holder} chainId={chainId} />
                        {sameAccount(row.holder, you) ? ' (you)' : ''}
                      </td>
                      <td className={CELL}>{share.toFixed(1)}%</td>
                      <td className={CELL} title={`${formatAmount(row.staked, 18)} ${info.stSymbol}`}>
                        {formatAmount(backingOfShares(row.staked, info), info.decimals)} {info.symbol}
                      </td>
                      <td className={CELL}>{formatDuration(row.current)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setRequested(page - 1)}
                className="btn-secondary px-2.5 py-1"
              >
                Previous
              </button>
              <span className="text-muted">
                {`${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + shown.length} of ${order.length} holders`}
              </span>
              <button
                type="button"
                disabled={page >= pages - 1}
                onClick={() => setRequested(page + 1)}
                className="btn-secondary px-2.5 py-1"
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <section aria-labelledby="tokens-all-title" className="card p-5">
      <h2 id="tokens-all-title" className="mb-3.5 font-agrandir-wide text-base leading-tight">
        All
      </h2>
      {body}
    </section>
  )
}
