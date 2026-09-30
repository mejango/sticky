'use client'

import { useState, type ReactNode } from 'react'
import type { Address } from 'viem'
import { BonusSplit } from '@/components/project/BonusSplit'
import { Leaderboard } from '@/components/project/Leaderboard'
import { UnstickFlow } from '@/components/project/flows/UnstickFlow'
import { TrancheTable } from '@/components/project/TrancheTable'
import { Revalidating } from '@/components/ui/Revalidating'
import { Skeleton } from '@/components/ui/Skeleton'
import { ShowingPanel } from '@/hooks/useShowing'
import { useStickyPosition, useStickyProject } from '@/hooks/useStickyProject'
import { useWallet } from '@/hooks/useWallet'
import { formatAmount, formatDuration } from '@/lib/sticky-format'
import type { StickyPosition } from '@/lib/sticky-holders'
import { backingOfShares, type StickyProjectInfo } from '@/lib/sticky-project'
import { useViewAs } from '@/lib/viewAs'

/** One figure and what it is. `value` is null while it is read, and a placeholder shows. */
function Stat({
  label,
  value,
  title,
  pending = false,
  large = false,
}: {
  label: string
  value: ReactNode
  title?: string
  pending?: boolean
  large?: boolean
}) {
  return (
    <div className={`max-w-full ${large ? 'min-w-[150px]' : ''}`}>
      <b
        title={title}
        className={
          large
            ? 'block truncate font-agrandir-wide text-2xl leading-tight text-ink'
            : 'block truncate text-base font-bold text-accent'
        }
      >
        {value === null ? (
          <Skeleton as="span" className={`inline-block h-[1.1em] rounded align-[-0.2em] ${large ? 'w-28' : 'w-14'}`} />
        ) : (
          <Revalidating pending={pending}>{value}</Revalidating>
        )}
      </b>
      <span className="mt-[3px] block text-xs font-semibold tracking-[1px] text-muted">{label}</span>
    </div>
  )
}

/**
 * The viewer's stick: what it has stuck (the backing its shares claim, in the staked token, with the Sticky shares in
 * its title), its oldest active stick and its record, then its tranches. With no account these are zero, in each
 * figure's unit. A stick that cannot be read shows – and offers to read it again, never zero. Unstick opens its flow
 * once this visit has read the project, since nothing is unstuck on the word of a copy the browser kept. Transfer, for
 * a token that is not soulbound, is closed: the page only reads.
 */
function YouCard({
  chainId,
  projectId,
  holder,
  info,
  unconfirmed,
}: {
  chainId: number
  projectId: number
  holder: Address | null
  info: StickyProjectInfo | undefined
  unconfirmed: boolean
}) {
  const position = useStickyPosition(chainId, projectId, holder, info)
  const stick = position.data
  const failed = holder !== null && position.isError && stick === undefined
  const [unsticking, setUnsticking] = useState(false)

  /** A figure of the stick: `signedOut` with no account, null while it is read, and – when it cannot be. */
  const figure = (from: (stick: StickyPosition) => string, signedOut: string) =>
    holder === null ? signedOut : stick ? from(stick) : failed ? '–' : null

  return (
    <section aria-labelledby="tokens-you-title" className="card p-5">
      <h2 id="tokens-you-title" className="mb-3.5 font-agrandir-wide text-base leading-tight">
        You
      </h2>
      <div className="mb-5 mt-1 flex flex-wrap items-end gap-x-[34px] gap-y-3">
        <Stat
          large
          label="Stuck"
          pending={unconfirmed}
          title={info && stick ? `${formatAmount(stick.staked, 18)} ${info.stSymbol}` : undefined}
          value={
            info
              ? figure(
                  found => `${formatAmount(backingOfShares(found.staked, info), info.decimals)} ${info.symbol}`,
                  `0 ${info.symbol}`,
                )
              : null
          }
        />
        <Stat label="Active oldest" value={figure(found => formatDuration(found.current), formatDuration(0))} />
        <Stat label="Record" value={figure(found => formatDuration(found.longest), formatDuration(0))} />
      </div>
      {failed ? (
        <p role="alert" className="mb-3 text-sm text-err">
          Could not read your stick.{' '}
          <button type="button" className="btn-link font-semibold" onClick={() => void position.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      <TrancheTable key={holder ?? 'signed-out'} chainId={chainId} projectId={projectId} holder={holder} info={info} />
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!info || unconfirmed}
          onClick={() => setUnsticking(true)}
          className="btn-primary max-w-full px-4 py-[9px]"
        >
          <span className="truncate">{info ? `Unstick ${info.symbol}` : 'Unstick'}</span>
        </button>
        {info && !info.soulbound ? (
          <button type="button" disabled className="btn-secondary px-4 py-[9px]">
            Transfer
          </button>
        ) : null}
      </div>
      {unsticking && info ? (
        <UnstickFlow chainId={chainId} projectId={projectId} info={info} onClose={() => setUnsticking(false)} />
      ) : null}
    </section>
  )
}

/**
 * A Sticky project's Tokens tab: the viewer's own stick and tranches (the viewed account's in View as), everyone's
 * holdings as a pie and a leaderboard, and, for a project with a bonus, where an unstick's value goes. What the browser
 * kept of the project shows at once and reads as unconfirmed until this visit has read it. The tranches are read only
 * while its panel is showing.
 */
export function TokensTab({ chainId, projectId }: { chainId: number; projectId: number }) {
  const { info, verified, failed, retry } = useStickyProject(chainId, projectId)
  const { viewAs } = useViewAs()
  const { address } = useWallet()
  const holder = viewAs ?? address ?? null

  if (info === undefined && failed) {
    return (
      <p role="alert" className="text-err">
        Could not read this Sticky token.{' '}
        <button type="button" className="btn-link font-semibold" onClick={retry}>
          Try again
        </button>
      </p>
    )
  }

  return (
    <ShowingPanel className="space-y-5">
      <YouCard chainId={chainId} projectId={projectId} holder={holder} info={info} unconfirmed={info !== undefined && !verified} />
      <Leaderboard chainId={chainId} projectId={projectId} info={info} you={holder} />
      {info ? <BonusSplit info={info} pending={!verified} /> : null}
    </ShowingPanel>
  )
}
