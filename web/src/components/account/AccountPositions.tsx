'use client'

import type { BendystrawNetwork } from '@bananapus/nana-sdk-core'
import Link from 'next/link'
import type { Address } from 'viem'
import { AccountNote } from '@/components/account/AccountNote'
import { ChainIcon } from '@/components/ChainIcon'
import { ProjectLogo } from '@/components/ProjectLogo'
import { FeedPlaceholder } from '@/components/StickyFeed'
import { useProjectMetadata } from '@/hooks/useProjectMetadata'
import { useAccountPositions } from '@/hooks/useStickyAccount'
import type { AccountPosition } from '@/lib/sticky-account'
import { formatAmount, formatDuration, stickyLabel } from '@/lib/sticky-format'
import { backingOfShares } from '@/lib/sticky-project'
import { chainName, projectPath } from '@/lib/urn'

/** A position: the project's logo, its Sticky token and ID and chain, what the shares can claim of its backing in the
 * underlying token (never the shares themselves), how long the active streak has lasted and the longest one. It opens
 * the project. */
function PositionCard({ position: { info, staked, start, longest } }: { position: AccountPosition }) {
  const metadata = useProjectMetadata(info.chainId, info.stakedToken)
  const age = start ? Math.max(0, Math.floor(Date.now() / 1_000) - start) : 0
  return (
    <li className="border-b border-line last:border-b-0">
      <Link
        data-position
        href={projectPath(info.chainId, info.projectId)}
        className="block px-3.5 py-3 text-ink no-underline hover:bg-[#e6f0f3]"
      >
        <div className="flex items-start gap-2.5">
          <ProjectLogo name={info.symbol} logoUri={metadata.data?.logoUri ?? null} size={26} className="mt-0.5" />
          <div className="min-w-0 flex-1 break-words">
            <div className="font-bold">
              {stickyLabel(info)} <span className="font-normal text-muted">#{info.projectId.toString()}</span>{' '}
              <span role="img" aria-label={chainName(info.chainId)} className="inline-flex align-[-2px]">
                <ChainIcon chainId={info.chainId} size={14} />
              </span>
            </div>
            <div className="text-[13px]">
              <span className="tracking-[1px] text-muted">Stuck:</span>{' '}
              {formatAmount(backingOfShares(staked, info), info.decimals)} {info.symbol}
            </div>
            <div className="text-[13px]">
              <span className="tracking-[1px] text-muted">Time:</span> {formatDuration(age)}
            </div>
            <div className="text-[13px]">
              <span className="tracking-[1px] text-muted">Longest:</span> {formatDuration(Math.max(longest, age))}
            </div>
          </div>
        </div>
      </Link>
    </li>
  )
}

/**
 * The positions an account holds on the chains of a network, one card each, as the chains answer. It draws a
 * placeholder until a chain has a position or every chain has answered, says when the account has none, and counts
 * what could not be read, with a Retry: a chain or a project that could not be read is never an account that holds
 * nothing.
 */
export function AccountPositions({ address, network }: { address: Address; network: BendystrawNetwork }) {
  const { positions, skipped, failedChains, pending, retry } = useAccountPositions(network, address)
  const loading = pending && positions.length === 0
  // A list that could not be read whole never says it is empty.
  const none = !loading && positions.length === 0 && failedChains.length === 0 && skipped === 0
  return (
    <section aria-labelledby="account-positions" aria-busy={loading} className="min-w-0">
      <h2 id="account-positions" className="mb-2 mt-1 font-agrandir-wide text-xl">
        Positions
      </h2>
      {positions.length > 0 ? (
        <ul>
          {positions.map(position => (
            <PositionCard key={`${position.info.chainId}:${position.info.projectId}`} position={position} />
          ))}
        </ul>
      ) : null}
      {loading ? <FeedPlaceholder /> : null}
      {none ? <p className="py-3.5 text-sm text-muted">No positions yet</p> : null}
      <AccountNote failedChains={failedChains} skipped={skipped} onRetry={retry} />
    </section>
  )
}
