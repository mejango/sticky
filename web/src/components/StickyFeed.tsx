'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import type { Address } from 'viem'
import { ChainIcon } from '@/components/ChainIcon'
import { AddressLabel } from '@/components/ui/AddressLabel'
import { Skeleton } from '@/components/ui/Skeleton'
import { explorerTxUrl } from '@/lib/chainDisplay'
import type { FeedLine, FeedRow } from '@/lib/sticky-feed'
import { ago, formatAmount, formatDuration } from '@/lib/sticky-format'
import { chainName, projectPath } from '@/lib/urn'

type Who = (address: Address) => ReactNode

/** What a list shows while it is read: pairs of lines where rows will be. */
export function FeedPlaceholder() {
  return (
    <div className="space-y-5 py-3.5" aria-hidden="true">
      {[
        ['w-[62%]', 'w-[38%]'],
        ['w-[70%]', 'w-[30%]'],
        ['w-[54%]', 'w-[42%]'],
      ].map(([first, second]) => (
        <div key={first} className="space-y-2.5">
          <Skeleton className={`h-2.5 rounded ${first}`} />
          <Skeleton className={`h-2 rounded ${second}`} />
        </div>
      ))}
    </div>
  )
}

const streakStarted = (line: { streak?: 'started' }) => (line.streak ? ' and got sticky' : '')

function streakEnded(line: { streak?: { endedAfter: bigint } }): ReactNode {
  return line.streak ? (
    <>
      {' '}
      and came unstuck after <span className="whitespace-nowrap">{formatDuration(line.streak.endedAfter)}</span>
    </>
  ) : null
}

/** Who did what, under a row that moved tokens. */
function sentence(line: FeedLine, who: Who, you: Address | null | undefined): ReactNode {
  switch (line.kind) {
    case 'stuck':
      return <>stuck by {who(line.holder)}{streakStarted(line)}</>
    case 'autoStuck':
      return <>auto-stuck by {who(line.holder)}{streakStarted(line)}</>
    case 'gift': {
      const yours = you !== null && you !== undefined && line.holder.toLowerCase() === you.toLowerCase()
      return (
        <>
          to {who(line.holder)}
          {yours ? ' (you)' : ''} from {who(line.payer)}
          {streakStarted(line)}
        </>
      )
    }
    case 'unstuck':
      return <>unstuck by {who(line.holder)}{streakEnded(line)}</>
    case 'removed':
      return <>removed by {who(line.holder)}{streakEnded(line)}</>
    default:
      return null
  }
}

/** What happened, in the amount's place, on a row where a streak stands alone. */
function lead(line: FeedLine, who: Who): ReactNode {
  if (line.kind === 'gotSticky') return <>{who(line.holder)} got sticky</>
  if (line.kind === 'cameUnstuck') {
    return (
      <>
        {who(line.holder)} came unstuck after <span className="whitespace-nowrap">{formatDuration(line.length)}</span>
      </>
    )
  }
  return null
}

function FeedItem({ row, label, you }: { row: FeedRow; label: string | undefined; you: Address | null | undefined }) {
  const txUrl = explorerTxUrl(row.chainId, row.txHash)
  const when = new Date(row.timestamp * 1_000).toLocaleString()
  const who: Who = address => <AddressLabel address={address} chainId={row.chainId} className="text-ink" />
  return (
    <li className="py-3.5">
      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          {row.amount ? (
            <>
              <span data-amount className="truncate font-semibold text-ink">
                {formatAmount(row.amount.value, row.amount.decimals)} {row.amount.symbol}
              </span>
              {row.direction ? (
                <span
                  data-direction
                  className={`inline-flex h-5 min-w-7 shrink-0 items-center justify-center border px-1.5 text-[10px] font-medium leading-none ${
                    row.direction === 'in' ? 'border-accent text-accent' : 'border-err text-err'
                  }`}
                >
                  {row.direction}
                </span>
              ) : null}
            </>
          ) : (
            <span className="min-w-0">{lead(row.line, who)}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
          {txUrl ? (
            <a href={txUrl} target="_blank" rel="noopener noreferrer" title={when} className="hover:text-ink hover:underline">
              {ago(row.timestamp)}
            </a>
          ) : (
            <span title={when}>{ago(row.timestamp)}</span>
          )}
          <span>on</span>
          {txUrl ? (
            <a
              href={txUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`View transaction on ${chainName(row.chainId)}`}
              className="inline-flex shrink-0 transition-opacity hover:opacity-70"
            >
              <ChainIcon chainId={row.chainId} size={18} />
            </a>
          ) : (
            <ChainIcon chainId={row.chainId} size={18} standalone />
          )}
        </span>
      </div>
      {label ? (
        <div className="mt-1 truncate text-sm font-medium">
          <Link href={projectPath(row.chainId, row.projectId)} className="text-accent no-underline hover:underline">
            {label}
          </Link>
        </div>
      ) : null}
      {row.amount ? <p className="mt-1 text-xs text-muted">{sentence(row.line, who, you)}</p> : null}
    </li>
  )
}

/**
 * Sticky's feed rows, laid out like juicebox.money's ActivityList: the amount and whether it came in or went out on the
 * left, how long ago and on which chain on the right, both linking to the transaction, then the project when the list
 * spans projects, and who did what.
 */
export function StickyFeed({
  rows,
  empty,
  label,
  you,
}: {
  /** Undefined while the list is read: a placeholder shows. */
  rows: readonly FeedRow[] | undefined
  /** What the list says when it has no rows. */
  empty: string
  /** The name of a row's project, for a list that spans projects. */
  label?: (row: FeedRow) => string | undefined
  /** The viewer's account: an airdrop to it reads "(you)". */
  you?: Address | null
}) {
  if (rows === undefined) return <FeedPlaceholder />
  if (!rows.length) return <p className="py-3.5 text-sm text-muted">{empty}</p>
  return (
    <ul className="divide-y divide-line">
      {rows.map(row => (
        <FeedItem key={`${row.chainId}:${row.txHash}:${row.logIndex}`} row={row} label={label?.(row)} you={you} />
      ))}
    </ul>
  )
}
