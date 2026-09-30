'use client'

import type { ReactNode } from 'react'
import { ProjectLink } from '@/components/ProjectLink'
import { Revalidating } from '@/components/ui/Revalidating'
import { Skeleton } from '@/components/ui/Skeleton'
import { useProjectSiblings } from '@/hooks/useStickyOverview'
import { formatAmount } from '@/lib/sticky-format'
import { missingChains, siblingTotals, type SiblingRow } from '@/lib/sticky-siblings'
import { chainName } from '@/lib/urn'

const CELL = 'whitespace-nowrap border-b border-line py-[5px] pr-2'

/** A row's first cell: the chain, and its project as a link to that project's page, or for the page's own project a
 * note that this is it. A chain that could not be searched has no project. */
function Chain({ row }: { row: SiblingRow }) {
  if (!('projectId' in row)) return <>{chainName(row.chainId)}</>
  if (row.self) {
    return (
      <>
        {chainName(row.chainId)} <span className="text-muted">#{row.projectId.toString()} (this page)</span>
      </>
    )
  }
  return (
    <ProjectLink chainId={row.chainId} projectId={row.projectId} className="text-accent underline decoration-amber">
      {chainName(row.chainId)} #{row.projectId.toString()}
    </ProjectLink>
  )
}

/** A row's figures: the backing in the staked token and the supply in Sticky shares, or why there are none. */
function Figures({ row }: { row: SiblingRow }) {
  if (!('info' in row)) {
    return (
      <td colSpan={2} className={`${CELL} text-muted`}>
        Could not read this chain.
      </td>
    )
  }
  const { info } = row
  return (
    <>
      <td className={CELL}>
        {formatAmount(info.backing, info.decimals)} {info.symbol}
      </td>
      <td className={CELL}>
        {formatAmount(info.totalSupply, 18)} {info.stSymbol}
      </td>
    </>
  )
}

/** The Chains card's frame: its title, and what it holds. */
function Card({ children }: { children: ReactNode }) {
  return (
    <section aria-labelledby="chains-title" className="card mb-5 p-5">
      <h2 id="chains-title" className="mb-3.5 font-agrandir-wide text-base leading-tight">
        Chains
      </h2>
      {children}
    </section>
  )
}

/**
 * The Chains card: a launch's project on each chain with its backing and supply, the chains it planned that have none
 * yet ("Planned at launch. Not deployed yet."), and the totals. The backing is only totalled when every chain is
 * backed by the same token; the supply always is. A project with no other chain to show has no card. What the browser
 * kept from an earlier visit shows at once, and reads as unconfirmed until this visit reads the chains again.
 */
export function ChainsCard({ chainId, projectId }: { chainId: number; projectId: number }) {
  const { info, failed, wanted, waiting, siblings } = useProjectSiblings(chainId, projectId)
  if (info === undefined) {
    return failed ? null : (
      <Card>
        <ChainsPlaceholder />
      </Card>
    )
  }
  if (!wanted) return null

  const rows = siblings.data
  if (rows === undefined) {
    return (
      <Card>
        {siblings.isError ? (
          <p role="alert" className="text-err">
            Could not read the chains.{' '}
            <button type="button" className="btn-link font-semibold" onClick={() => void siblings.refetch()}>
              Try again
            </button>
          </p>
        ) : (
          <ChainsPlaceholder />
        )}
      </Card>
    )
  }

  const missing = missingChains(info, rows)
  if (rows.length < 2 && missing.length === 0) return null
  const totals = siblingTotals(rows)
  // With nothing read there is no total to give, and "different tokens" would say what is not known.
  const { decimals } = totals

  return (
    <Card>
      <Revalidating
        as="div"
        pending={siblings.isFetching || waiting}
        className="w-full overflow-x-auto overscroll-x-contain"
      >
        <table className="w-max min-w-full border-collapse">
          <thead>
            <tr className="text-left text-[13px] font-semibold tracking-[1px] text-muted">
              <th className={CELL}>CHAIN</th>
              <th className={CELL}>BACKING</th>
              <th className={CELL}>SUPPLY</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.chainId}>
                <td className={CELL}>
                  <Chain row={row} />
                </td>
                <Figures row={row} />
              </tr>
            ))}
            {missing.map(id => (
              <tr key={id}>
                <td className={CELL}>{chainName(id)}</td>
                <td colSpan={2} className={`${CELL} text-muted`}>
                  Planned at launch. Not deployed yet.
                </td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className={`${CELL} border-t`}>Total</td>
              <td className={`${CELL} border-t`}>
                {decimals === undefined
                  ? '–'
                  : totals.backing === null
                    ? 'Backed by different tokens'
                    : `${formatAmount(totals.backing, decimals)} ${totals.symbol}`}
              </td>
              <td className={`${CELL} border-t`}>
                {decimals === undefined ? '–' : `${formatAmount(totals.supply, 18)} ${info.stSymbol}`}
              </td>
            </tr>
          </tbody>
        </table>
      </Revalidating>
      {totals.complete ? null : (
        <p className="mt-2 text-muted">Some chains could not be read. Totals cover the chains shown.</p>
      )}
    </Card>
  )
}

/** What the card shows while its chains are read: three rows. */
function ChainsPlaceholder() {
  return (
    <div className="space-y-3.5" aria-hidden="true">
      {[0, 1, 2].map(row => (
        <Skeleton key={row} className="h-3.5 w-full rounded" />
      ))}
    </div>
  )
}
