'use client'

import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { SkeletonTable } from '@/components/ui/Skeleton'
import { useHolderTranches } from '@/hooks/useStickyTokens'
import { formatAmount, formatDuration } from '@/lib/sticky-format'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { TRANCHES_PER_PAGE } from '@/lib/sticky-tranches'

const HEADING = 'whitespace-nowrap border-b border-line py-1 pr-2 text-left text-[13px] font-semibold tracking-[1px] text-muted'
const CELL = 'whitespace-nowrap border-b border-line py-[5px] pr-2'
const SINCE: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }

const count = (value: bigint) => value.toLocaleString('en-US')

/**
 * A holder's tranches: each stick's Sticky shares, when it was stuck and how old it is at the block the page was read
 * at, oldest first. Tranches are 50 to a page, the newest page first: Older goes back a page and Newer forward. A
 * holder with no tranches, or nobody, has none to show. A page that cannot be read says so, and offers to read it
 * again: it is never an empty table.
 */
export function TrancheTable({
  chainId,
  projectId,
  holder,
  info,
}: {
  chainId: number
  projectId: number
  holder: Address | null
  info: StickyProjectInfo | undefined
}) {
  const [requested, setRequested] = useState(0)
  const read = useHolderTranches(chainId, projectId, holder, requested)
  const page = read.data

  // A page the read clamped to, which burns can leave the one asked for past the last, is the page asked for from now on.
  useEffect(() => {
    if (page && !read.isPlaceholderData && page.page !== requested) setRequested(page.page)
  }, [page, read.isPlaceholderData, requested])

  const loading = holder !== null && read.isPending
  const failed = holder !== null && read.isError && !page

  return (
    <div aria-busy={loading}>
      <div className="w-full overflow-x-auto overscroll-x-contain">
        <table aria-label="Your tranches" className="w-max min-w-[520px] border-collapse">
          <thead>
            <tr>
              <th className={HEADING}>{info ? `AMOUNT (${info.stSymbol})` : 'AMOUNT'}</th>
              <th className={HEADING}>STUCK SINCE</th>
              <th className={HEADING}>TRANCHE AGE</th>
            </tr>
          </thead>
          <tbody>
            {page?.tranches.map((tranche, at) => (
              <tr key={String(page.start + BigInt(at))}>
                <td className={CELL}>{formatAmount(tranche.amount, 18)}</td>
                <td className={CELL}>{new Date(tranche.timestamp * 1000).toLocaleString(undefined, SINCE)}</td>
                <td className={CELL}>{formatDuration(Math.max(0, page.now - tranche.timestamp))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loading ? <SkeletonTable rows={2} columns={3} className="mt-3" /> : null}
      {failed ? (
        <p role="alert" className="py-2 text-sm text-err">
          Could not read your tranches.{' '}
          <button type="button" className="btn-link font-semibold" onClick={() => void read.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {holder === null || page?.total === 0n ? <p className="py-2 text-sm text-muted">No active tranches</p> : null}
      {page && page.total > BigInt(TRANCHES_PER_PAGE) ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
          <p className="mr-1 text-muted">
            Tranches {count(page.start + 1n)}–{count(page.start + BigInt(page.tranches.length))} of {count(page.total)}
          </p>
          <button
            type="button"
            disabled={page.start === 0n}
            onClick={() => setRequested(page.page + 1)}
            className="btn-secondary px-2.5 py-1"
          >
            Older
          </button>
          <button
            type="button"
            disabled={page.page === 0}
            onClick={() => setRequested(page.page - 1)}
            className="btn-secondary px-2.5 py-1"
          >
            Newer
          </button>
        </div>
      ) : null}
    </div>
  )
}
