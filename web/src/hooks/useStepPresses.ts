'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Address, Hex } from 'viem'
import type { ReviewedCalls, TxRequest, useSafeTx } from '@/hooks/useSafeTx'
import { TransactionReviewCancelledError, type TransactionReviewRow } from '@/lib/transaction-review'

/** What the action's one decoded review shows above its calls. */
export type StepReview = { account: Address; title: string; rows?: readonly TransactionReviewRow[] }

/** What a press did: sent its step, sent nothing (the engine refused or failed it, or its action was closed or replaced
 * meanwhile), or the person closed the review of the action that is open. */
export type PressOutcome = 'sent' | 'unsent' | 'cancelled'

/**
 * A plan's steps sent through one useSafeTx. One user action is one decoded review: the first press shows every step
 * left in a single SDK review (`review`), and each step it showed is then sent without asking again, the next one as soon
 * as the one before it confirms (`due` turns true and the flow presses from its next render). A step whose calldata
 * changed since that review is reviewed on its own by the engine. A failure or a refused send drops the review, so the
 * next press reviews the steps left again.
 *
 * A confirmation counts only for a step whose send the engine took, and only once. While that step is out, a press sends
 * nothing. The engine answers null, and changes
 * nothing, for a send it does not take: that press sent nothing, and the next one sends the same step. `send` is handed
 * the block the last confirmed step is in, so a step that spends an approval is simulated where the approval is.
 */
export function useStepPresses(tx: Pick<ReturnType<typeof useSafeTx>, 'phase' | 'receipt'> & Partial<Pick<ReturnType<typeof useSafeTx>, 'review'>>) {
  // How many steps have confirmed: the dialog is on the one after them. A press reads the count from the ref, which
  // changes at once when a step is counted; the state is what the dialog shows after the next render. `accepted` is the
  // step the engine took and whose confirmation has not been counted, `confirmedAt` the block of the last one that has,
  // `reviewed` the action's review and `total` how many steps it has.
  const [landed, setLanded] = useState(0)
  /** The flow should press now: its action was just chosen, or the step its review showed next is ready. */
  const [due, setDue] = useState(false)
  const reviewAll = tx.review
  // `live` is whether the action is open: `arm` opens it and `restart` closes it, at once, so a press already scheduled
  // for a closed action sends nothing. `generation` counts restarts: a press still waiting on a review or a send from
  // before one leaves the action after it alone. `failed` is whether the step the engine took has failed since.
  const progress = useRef<{ landed: number; accepted: number | null; failed: boolean; confirmedAt: bigint | undefined; reviewed?: ReviewedCalls; total: number; pressing: boolean; live: boolean; generation: number }>({
    landed: 0,
    accepted: null,
    failed: false,
    confirmedAt: undefined,
    total: 0,
    pressing: false,
    live: false,
    generation: 0,
  })

  // A step that fails after the engine took it drops the review, so its retry is reviewed again; one the engine lets go
  // of without a result (a released hold) is no longer out. This runs before the commit that shows the failure can be
  // clicked, so no Retry is pressed under the old review.
  useLayoutEffect(() => {
    if (progress.current.accepted === null) return
    if (tx.phase === 'error') progress.current = { ...progress.current, reviewed: undefined, failed: true }
    else if (tx.phase === 'idle') progress.current = { ...progress.current, reviewed: undefined, accepted: null }
  }, [tx.phase])

  // The confirmation of the step the engine took is counted once it arrives. A confirmation seen while no step is
  // waiting for one is the last step's, and counts for nothing. The next step the review showed is then due.
  useEffect(() => {
    const { accepted, confirmedAt, reviewed, total } = progress.current
    if (accepted === null || tx.phase !== 'success') return
    progress.current = { ...progress.current, landed: accepted + 1, accepted: null, confirmedAt: tx.receipt?.blockNumber ?? confirmedAt }
    setLanded(accepted + 1)
    if (reviewed && accepted + 1 < total) setDue(true)
  }, [tx.phase, tx.receipt])

  /** Starts over at the first step, for a plan made afresh, or closes the action: nothing is sent until `arm`. */
  const restart = useCallback(() => {
    progress.current = { landed: 0, accepted: null, failed: false, confirmedAt: undefined, total: 0, pressing: false, live: false, generation: progress.current.generation + 1 }
    setLanded(0)
    setDue(false)
  }, [])

  /** The action was chosen: its review opens from the flow's next render. */
  const arm = useCallback(() => {
    progress.current.live = true
    setDue(true)
  }, [])

  /** Sends the first of `steps` that has not confirmed through `send`, which hands it to the engine; nothing once every
   * step has. With `review`, the steps left are first shown in one decoded review, unless this action's already did. */
  const press = useCallback(
    async <Step extends TxRequest | string>(
      steps: readonly Step[],
      send: (step: Step, confirmedAt: bigint | undefined, reviewed: ReviewedCalls | undefined) => Promise<Hex | null>,
      review?: StepReview,
    ): Promise<PressOutcome> => {
      const at = progress.current.landed
      const { generation } = progress.current
      // A step the engine took is out until it confirms or fails: a press from a render behind sends nothing, and keeps
      // the review for the steps after it.
      const out = progress.current.accepted !== null && !progress.current.failed
      if (at >= steps.length || progress.current.pressing || out || !progress.current.live) return 'unsent'
      progress.current.pressing = true
      setDue(false)
      try {
        progress.current.total = steps.length
        if (review && reviewAll && !progress.current.reviewed) {
          try {
            progress.current.reviewed = await reviewAll(steps.slice(at) as readonly TxRequest[], review)
          } catch (reason) {
            // Closing the review closes this action, not one chosen after it.
            if (reason instanceof TransactionReviewCancelledError) return progress.current.generation === generation ? 'cancelled' : 'unsent'
            throw reason
          }
          // The action this review was for was closed or replaced while it was open: nothing is sent for it.
          if (progress.current.generation !== generation) return 'unsent'
        }
        const hash = await send(steps[at], progress.current.confirmedAt, progress.current.reviewed)
        if (progress.current.generation === generation) {
          if (hash !== null) progress.current = { ...progress.current, accepted: at, failed: false }
          else progress.current.reviewed = undefined
        }
        return hash === null ? 'unsent' : 'sent'
      } finally {
        if (progress.current.generation === generation) progress.current.pressing = false
      }
    },
    [reviewAll],
  )

  return { landed, due, arm, restart, press }
}
