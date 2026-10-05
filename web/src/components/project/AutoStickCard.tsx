'use client'

import { useEffect } from 'react'
import { AutoStickFlow } from '@/components/project/flows/AutoStickFlow'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAutoStick, useRewardPots, useViewer } from '@/hooks/useStickyAirdrops'
import { useStickyProject } from '@/hooks/useStickyProject'
import { AS_STATUS, asStatusLine, hasLeftovers } from '@/lib/sticky-autostick'
import { ago, formatAmount, formatDuration, stickyLabel } from '@/lib/sticky-format'

const INVALID_PROJECT = 'Auto-stick is misconfigured for this Sticky project; the Airdrops tab leaves its card out.'

/**
 * The viewer's auto-stick: whether unlocked staked-token rewards are stuck again for them as they unlock, what holds it
 * back, and what they can do about it, which its actions do (`AutoStickFlow`). It fails closed: with no viewer, or a
 * project the adapter cannot resolve, there is no card.
 */
export function AutoStickCard({ chainId, projectId }: { chainId: number; projectId: number }) {
  const { info } = useStickyProject(chainId, projectId)
  const holder = useViewer()
  const read = useAutoStick(chainId, projectId, holder)
  const { groups } = useRewardPots(chainId, projectId)
  const state = read.data
  const invalid = state?.status === AS_STATUS.INVALID_PROJECT

  useEffect(() => {
    if (invalid) console.warn(INVALID_PROJECT, { chainId, projectId })
  }, [invalid, chainId, projectId])

  if (holder === null || !info || invalid) return null

  if (!state) {
    return read.isError ? (
      <section aria-labelledby="autostick-title" className="card p-5">
        <h2 id="autostick-title" className="mb-2 font-agrandir-wide text-base leading-tight">
          Auto-stick
        </h2>
        <p role="alert" className="text-err">
          Could not read auto-stick.{' '}
          <button type="button" className="btn-link font-semibold" onClick={() => void read.refetch()}>
            Try again
          </button>
        </p>
      </section>
    ) : (
      <section aria-busy="true" className="card space-y-2.5 p-5">
        <Skeleton className="h-4 w-[45%] rounded" />
        <Skeleton className="h-3 w-[75%] rounded" />
        <Skeleton className="h-3 w-[55%] rounded" />
      </section>
    )
  }

  const line = state.enabled ? asStatusLine(state, info) : ''

  return (
    <section aria-labelledby="autostick-title" className="card break-words p-5">
      <h2 id="autostick-title" className="mb-2 font-agrandir-wide text-base leading-tight">
        Auto-stick {info.symbol} rewards
      </h2>
      <p className="mb-2.5 text-muted">
        Stick your {info.symbol} rewards into {stickyLabel(info)} as they unlock.
      </p>
      <div data-autostick-state className="mb-3 space-y-0.5">
        <strong className="block font-medium">{state.enabled ? 'On' : 'Off'}</strong>
        <span className="block text-[13px] text-muted">
          {state.enabled
            ? `Unlocked ${info.symbol} rewards auto-stick when at least ${formatAmount(state.minimum, info.decimals)} ${info.symbol} is ready, at most once every ${formatDuration(state.cooldown)}.`
            : `Unlocked ${info.symbol} rewards stay claimable until you collect them.`}
        </span>
        {state.enabled && state.lastCompoundedAt ? (
          <span className="block text-[13px] text-muted">Last auto-stick: {ago(state.lastCompoundedAt)}</span>
        ) : null}
        {hasLeftovers(state) ? <div className="text-[13px]">The auto-stick contract still has your permission.</div> : null}
        {line ? <div className="text-[13px]">{line}</div> : null}
      </div>
      <AutoStickFlow chainId={chainId} projectId={projectId} info={info} state={state} groups={groups} />
    </section>
  )
}
