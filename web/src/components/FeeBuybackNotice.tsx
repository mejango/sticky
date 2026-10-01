'use client'

import { useEffect, useRef, useState } from 'react'
import {
  checkFeeBuyback,
  combineFeeResults,
  createFeeWatch,
  feeMessage,
  feeReceipt,
  feeReviewConfirmLabel,
  isFeePayingCall,
  type FeeCall,
  type FeeResult,
} from '@bananapus/nana-sdk-core/v6/fee-buyback'
import { feeBuybackContext } from '@/lib/fee-buyback-client'

type Call = FeeCall & { chainId: number; functionName?: string }
const initial: FeeResult = { status: 'unknown', fees: [] }

export function useFeeBuybackReview(calls: readonly Call[]) {
  const enabled = calls.some(isFeePayingCall)
  const [result, setResult] = useState<FeeResult>(initial)
  const [busy, setBusy] = useState(enabled)
  const [waiting, setWaiting] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(false)
  // Until every fee-paying call's first check reports, nothing is known about
  // the fee return or whether new blocks can be watched.
  const [settled, setSettled] = useState(false)
  const confirming = useRef(false)
  const watches = useRef<ReturnType<typeof createFeeWatch>[]>([])
  const pending = useRef(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const stops: (() => void)[] = []
    // Every fee-paying call is simulated alone on its own chain.
    const checked = calls.filter(isFeePayingCall).map(call => {
      try {
        return {
          call,
          context: call.from ? feeBuybackContext(call.chainId, call.from) : undefined,
        }
      } catch {
        return { call, context: undefined } /* Unsupported chain. */
      }
    })
    const results: FeeResult[] = checked.map(() => initial)
    const publish = () => {
      if (!alive) return
      setAutoRefresh(checked.every(item => item.context))
      setResult(combineFeeResults(results))
    }
    const monitors = checked.map(({ call, context }, index) =>
      createFeeWatch(
        async () =>
          context ? checkFeeBuyback(context.client, call, context.options) : initial,
        next => {
          results[index] = next
          publish()
          if (alive && pending.current > 0 && --pending.current === 0) {
            setBusy(false)
            setSettled(true)
          }
        },
      ),
    )
    watches.current = monitors
    pending.current = monitors.length
    for (const monitor of monitors) void monitor.refresh()
    const chains = new Map<number, number[]>()
    checked.forEach(({ call, context }, index) => {
      if (context) chains.set(call.chainId, [...(chains.get(call.chainId) ?? []), index])
    })
    for (const indexes of chains.values()) {
      const context = checked[indexes[0]].context!
      stops.push(
        context.client.watchBlockNumber({
          pollingInterval: 4000,
          onBlockNumber: () => {
            for (const index of indexes) void monitors[index].refresh()
          },
          onError: () => {
            for (const index of indexes) results[index] = initial
            publish()
          },
        }),
      )
    }
    return () => {
      alive = false
      for (const monitor of monitors) monitor.stop()
      for (const stop of stops) stop()
      watches.current = []
    }
  }, [calls, enabled])
  async function confirm() {
    if (!enabled) return true
    if (!watches.current.length || busy || confirming.current) return false
    confirming.current = true
    setBusy(true)
    try {
      const confirmed = await Promise.all(
        watches.current.map(monitor => monitor.confirm()),
      )
      return confirmed.every(Boolean)
    } finally {
      confirming.current = false
      setBusy(false)
    }
  }
  return {
    enabled,
    result,
    busy,
    settled,
    waiting,
    autoRefresh,
    confirm,
    wait: () => setWaiting(true),
    retry: () => {
      setBusy(true)
      pending.current = watches.current.length
      for (const monitor of watches.current) void monitor.refresh()
    },
    confirmLabel: feeReviewConfirmLabel({ enabled, busy, status: result.status }),
  }
}

export function FeeBuybackNotice({
  review,
}: {
  review: ReturnType<typeof useFeeBuybackReview>
}) {
  if (!review.enabled || review.result.status === 'none') return null
  return (
    <section
      aria-label="Fee token return"
      className="my-3 rounded-lg border p-3 text-sm"
    >
      <p role="status">
        {review.busy ? 'Checking fee return…' : feeMessage(review.result)}
      </p>
      {review.result.fees
        .filter(f => f.route !== 'unknown')
        .map(fee => (
          <p key={fee.key}>{feeReceipt(fee)}</p>
        ))}
      {review.settled ? (
        <p className="mt-1 text-xs">
          {review.waiting && review.result.status !== 'ready' ? 'Waiting. ' : ''}
          {review.autoRefresh
            ? 'Checking new blocks automatically.'
            : 'Automatic checks unavailable. Retry now.'}{' '}
          {review.result.checkedAt
            ? `Last checked ${new Date(review.result.checkedAt).toLocaleTimeString()}.`
            : ''}
        </p>
      ) : null}
      {review.result.status === 'fallback' && !review.waiting ? (
        <button type="button" className="mt-2 underline" onClick={review.wait}>
          Wait for better rate
        </button>
      ) : null}
      {review.settled && review.result.status === 'unknown' ? (
        <button
          type="button"
          className="mt-2 underline"
          disabled={review.busy}
          onClick={review.retry}
        >
          Retry now
        </button>
      ) : null}
    </section>
  )
}
