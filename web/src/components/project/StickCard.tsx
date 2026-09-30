'use client'

import { useState } from 'react'
import { formatUnits } from 'viem'
import { Skeleton } from '@/components/ui/Skeleton'
import { useStickyPosition, useStickyProject } from '@/hooks/useStickyProject'
import { useWallet } from '@/hooks/useWallet'
import { formatAmount } from '@/lib/sticky-format'
import { backingOfShares } from '@/lib/sticky-project'
import { useViewAs } from '@/lib/viewAs'

/**
 * The Stick card: an amount of the staked token to stick and, for the viewed or connected account, what it holds in
 * its wallet (a link that fills in all of it) and its own stick, the backing its shares claim. The page only reads, so
 * the button is closed; it reads "Checking…" until this visit has read the project, since nothing is stuck on the word
 * of a copy the browser kept.
 */
export function StickCard({ chainId, projectId }: { chainId: number; projectId: number }) {
  const { info, verified, failed } = useStickyProject(chainId, projectId)
  const { viewAs } = useViewAs()
  const { address } = useWallet()
  const position = useStickyPosition(chainId, projectId, viewAs ?? address ?? null, info)
  const [amount, setAmount] = useState('')
  const stick = position.data

  return (
    <section
      aria-labelledby="stick-title"
      className="rounded-xl border-2 border-accent bg-card p-5 shadow-[0_0_0_4px_rgb(14_123_144/0.1),0_4px_20px_-4px_rgb(14_123_144/0.25)]"
    >
      <h2 id="stick-title" className="mb-3.5 font-agrandir-wide text-base leading-tight">
        {info ? `Stick ${info.symbol}` : <Skeleton as="span" className="block h-5 w-[120px] rounded" />}
      </h2>
      <div className="relative">
        <input
          aria-label="Amount of underlying tokens to stick"
          inputMode="decimal"
          placeholder="10"
          value={amount}
          onChange={event => setAmount(event.target.value)}
          className="w-full rounded-[4px] border border-line bg-[#fdffff] py-1.5 pl-2 pr-16 text-ink focus:border-amber focus:outline-none"
        />
        <span className="absolute right-2.5 top-1/2 max-w-[60%] -translate-y-1/2 truncate text-muted">{info?.symbol}</span>
      </div>
      {info && stick ? (
        <>
          <p className="mt-[3px] truncate text-xs text-muted">
            <button
              type="button"
              title="Use full wallet balance"
              onClick={() => setAmount(formatUnits(stick.wallet, info.decimals))}
              className="btn-link min-h-0 text-xs"
            >
              {formatAmount(stick.wallet, info.decimals)}
            </button>{' '}
            {info.symbol} in wallet
          </p>
          {/* The stick is the backing its shares claim, in the staked token; the Sticky shares are in the title. */}
          <p className="truncate text-xs text-muted" title={`${formatAmount(stick.staked, 18)} ${info.stSymbol}`}>
            {formatAmount(backingOfShares(stick.staked, info), info.decimals)} {info.symbol} stuck
          </p>
        </>
      ) : null}
      <button type="button" disabled className="btn-primary mt-3 w-full px-4 py-[9px]">
        {verified || failed ? 'Stick' : 'Checking…'}
      </button>
    </section>
  )
}
