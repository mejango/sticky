'use client'

import type { ReactNode } from 'react'
import { ChainIcon } from '@/components/ChainIcon'
import { ProjectLogo } from '@/components/ProjectLogo'
import { Revalidating } from '@/components/ui/Revalidating'
import { Skeleton } from '@/components/ui/Skeleton'
import { useProjectMetadata } from '@/hooks/useProjectMetadata'
import { useProjectSticks, useStickyProject, type ProjectSticks } from '@/hooks/useStickyProject'
import { formatAmount, formatDuration, stickyLabel } from '@/lib/sticky-format'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { chainName } from '@/lib/urn'

const LOGO_SIZE = 104

/** The logo of the Juicebox project behind the staked token, or a tile with its first letter. */
function HeaderLogo({ info }: { info: StickyProjectInfo }) {
  const metadata = useProjectMetadata(info.chainId, info.stakedToken)
  return <ProjectLogo name={info.symbol} logoUri={metadata.data?.logoUri ?? null} size={LOGO_SIZE} eager />
}

/** A label and its value. `value` is null while the value is read, and a placeholder shows. */
function Pair({ label, value, pending = false }: { label: string; value: ReactNode; pending?: boolean }) {
  return (
    <span className="meta-pair">
      <span className="text-muted">{label}:</span>{' '}
      <b className="font-medium text-ink">
        {value === null ? (
          <Skeleton as="span" className="inline-block h-[1.1em] w-[3.5em] rounded align-[-0.2em]" />
        ) : (
          <Revalidating pending={pending}>{value}</Revalidating>
        )}
      </b>
    </span>
  )
}

/**
 * A Sticky project's header: the logo of the project behind the staked token, the Sticky token's symbol and name, and a
 * row of what it holds: Stuck (the backing its shares claim, in the staked token), Sticks (how many hold shares),
 * Home chain, and the average and longest active stick. Stuck and the home chain come with the
 * project's own read, before its holders are counted. What the browser kept from an earlier visit shows at once, and
 * reads as unconfirmed until this visit reads it again.
 */
export function ProjectHeader({ chainId, projectId }: { chainId: number; projectId: number }) {
  const { info, verified, failed, retry } = useStickyProject(chainId, projectId)
  const sticks = useProjectSticks(chainId, projectId)
  const unconfirmed = info !== undefined && !verified
  const recounting = sticks.data !== undefined && sticks.isFetching
  // A figure is a placeholder (null) while it is read, and – when its read failed. The holders are counted only for a
  // project that could be read.
  const stuck = info ? `${formatAmount(info.backing, info.decimals)} ${info.symbol}` : failed ? '–' : null
  const counted = (read: (data: ProjectSticks) => string) =>
    sticks.data ? read(sticks.data) : sticks.isError || failed ? '–' : null

  return (
    <header
      aria-busy={info === undefined && !failed}
      className="flex items-center gap-4 max-[400px]:flex-col max-[400px]:items-start"
    >
      {info ? (
        <HeaderLogo info={info} />
      ) : (
        <Skeleton className={`size-[104px] shrink-0 rounded-lg ${failed ? '[animation:none]' : ''}`} />
      )}
      <div className="min-w-0 max-w-full">
        {info ? (
          <h1 className="break-words font-agrandir-wide text-[19px] leading-tight">
            {stickyLabel(info)} <span className="font-beatrice font-normal text-muted">{info.stName}</span>
          </h1>
        ) : failed ? null : (
          <Skeleton className="h-4 w-[min(220px,50vw)] rounded" />
        )}
        {failed ? (
          <p role="alert" className="text-err">
            Could not read this Sticky token.{' '}
            <button type="button" className="btn-link font-semibold" onClick={retry}>
              Try again
            </button>
          </p>
        ) : null}
        <div className="meta-row my-[3px] text-base">
          <div className="meta-line">
            <Pair label="Stuck" value={stuck} pending={unconfirmed} />
            <Pair label="Sticks" value={counted(data => String(data.sticks))} pending={recounting} />
            {info ? (
              <span className="meta-pair" title="Shares, backing and rewards are accounted for on this chain.">
                <span className="text-muted">Home chain:</span>{' '}
                <Revalidating pending={unconfirmed} className="inline-flex gap-[3px] align-[-3px]">
                  <span title={chainName(info.chainId)} className="inline-flex">
                    <ChainIcon chainId={info.chainId} size={18} standalone />
                  </span>
                </Revalidating>
              </span>
            ) : null}
            <Pair
              label="Average active stick"
              value={counted(data => formatDuration(data.average))}
              pending={recounting}
            />
            <Pair
              label="Longest active stick"
              value={counted(data => formatDuration(data.longest))}
              pending={recounting}
            />
          </div>
        </div>
      </div>
    </header>
  )
}
