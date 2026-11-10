'use client'

import {
  feeMessage,
  feeReceipt,
} from '@bananapus/nana-sdk-core/v6/fee-buyback'
import type { useFeeBuybackReview } from '@bananapus/nana-sdk-core/review/react'

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
