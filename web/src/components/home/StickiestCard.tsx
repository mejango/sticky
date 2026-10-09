'use client'

import { ChainIcon } from '@/components/ChainIcon'
import { ProjectLink } from '@/components/ProjectLink'
import { ProjectLogo } from '@/components/ProjectLogo'
import { useProjectMetadata } from '@/hooks/useProjectMetadata'
import { formatAmount, stickyLabel } from '@/lib/sticky-format'
import type { HomeCard } from '@/lib/sticky-home'
import { chainName } from '@/lib/urn'

/** One pool's rank, home chain, project identity and local backing, holders and stickiness bonus. */
export function StickiestCard({ card: { info, sticks }, rank }: { card: HomeCard; rank: number }) {
  const metadata = useProjectMetadata(info.chainId, info.stakedToken)
  const backing = `${formatAmount(info.backing, info.decimals)} ${info.symbol}`
  return (
    <ProjectLink
      data-card
      chainId={info.chainId}
      projectId={info.projectId}
      className="block border-b border-line px-3.5 py-3 text-ink no-underline last:border-b-0 hover:bg-[#e6f0f3]"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 w-3.5 shrink-0 text-muted">{rank}</span>
        <ProjectLogo name={info.symbol} logoUri={metadata.data?.logoUri ?? null} size={26} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-bold">
            {stickyLabel(info)}
            <span className="font-normal text-muted"> #{info.projectId.toString()}</span>{' '}
            <span role="img" aria-label={chainName(info.chainId)} className="inline-flex gap-[3px] align-[-2px]">
              <ChainIcon chainId={info.chainId} size={14} />
            </span>
          </div>
          <div className="text-[13px]">
            <span className="tracking-[1px] text-muted">Backing:</span> {backing}
          </div>
          <div className="text-[13px]">
            <span className="tracking-[1px] text-muted">Sticks:</span> {sticks}
          </div>
          <div className="text-[13px]">
            <span className="tracking-[1px] text-muted">Bonus:</span> {Number(info.cashOutTaxRate) / 100}%
          </div>
        </div>
      </div>
    </ProjectLink>
  )
}
