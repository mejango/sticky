'use client'

import Link from 'next/link'
import { ChainIcon } from '@/components/ChainIcon'
import { ProjectLogo } from '@/components/ProjectLogo'
import { useProjectMetadata } from '@/hooks/useProjectMetadata'
import { formatAmount, stickyLabel } from '@/lib/sticky-format'
import type { HomeCardGroup } from '@/lib/sticky-home'
import { chainName, projectPath } from '@/lib/urn'

/**
 * A Stickiest card: its rank, the logo of the project behind the staked token and the Sticky token's name, its
 * project ID or, for a launch on several chains, only their icons, then the backing holders can claim, how many hold
 * shares and the stickiness bonus. It opens the first chain's project.
 */
export function StickiestCard({ group, rank }: { group: HomeCardGroup; rank: number }) {
  const [{ info }] = group.cards
  const metadata = useProjectMetadata(info.chainId, info.stakedToken)
  const sameToken = group.cards.every(card => card.info.symbol === info.symbol && card.info.decimals === info.decimals)
  // What holders can claim is in the staked token, never in Sticky shares. Chains backed by different tokens cannot
  // be added up, so each is listed.
  const backing = sameToken
    ? `${formatAmount(group.cards.reduce((sum, card) => sum + card.info.backing, 0n), info.decimals)} ${info.symbol}`
    : group.cards.map(({ info: each }) => `${formatAmount(each.backing, each.decimals)} ${each.symbol}`).join(', ')
  const sticks = group.cards.reduce((sum, card) => sum + card.sticks, 0)
  const chains = group.cards.map(card => card.info.chainId)
  return (
    <Link
      data-card
      href={projectPath(info.chainId, info.projectId)}
      // Not prefetched in view: once more than four links to different project pages are in view, Next 16.3's
      // prefetch scheduler cancels and resends their prefetches without end.
      prefetch={false}
      className="block border-b border-line px-3.5 py-3 text-ink no-underline last:border-b-0 hover:bg-[#e6f0f3]"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 w-3.5 shrink-0 text-muted">{rank}</span>
        <ProjectLogo name={info.symbol} logoUri={metadata.data?.logoUri ?? null} size={26} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="font-bold">
            {stickyLabel(info)}
            {group.cards.length === 1 ? <span className="font-normal text-muted"> #{info.projectId.toString()}</span> : null}{' '}
            <span role="img" aria-label={chains.map(chainName).join(', ')} className="inline-flex gap-[3px] align-[-2px]">
              {chains.map(chainId => (
                <ChainIcon key={chainId} chainId={chainId} size={14} />
              ))}
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
    </Link>
  )
}
