'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReviewedActionState } from '@/hooks/useReviewedAction'
import { useStepPresses } from '@/hooks/useStepPresses'

/** A flow's review: nothing chosen, its plan being read from the chain, or planned with its one review due. */
export type PlanState<Plan> = { status: 'idle' } | { status: 'planning' } | { status: 'planned'; plan: Plan }

/**
 * The plan a flow reviews and sends, made afresh on each `start`. A newer `start`, a `close` or unmounting stops the
 * plan being read, and what it would have planned or refused is dropped. A plan opens its one review (`due`, `press`,
 * as `useStepPresses`); `onCancel` runs when the person closes that review or refuses its wallet prompt.
 */
export function usePlannedReview<Plan>(tx: Pick<ReviewedActionState, 'run' | 'reset'>, onCancel?: () => void) {
  const presses = useStepPresses(tx, onCancel)
  const [state, setState] = useState<PlanState<Plan>>({ status: 'idle' })
  const reading = useRef<AbortController | null>(null)
  const latest = useRef({ tx, presses })
  useLayoutEffect(() => {
    latest.current = { tx, presses }
  })
  useEffect(() => () => reading.current?.abort(), [])

  /** Plans from what the chain says now. A null plan leaves the flow idle; a refusal goes to `failed`. */
  const start = useCallback(async (make: (signal: AbortSignal) => Promise<Plan | null>, failed: (reason: unknown) => void) => {
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    latest.current.tx.reset()
    latest.current.presses.restart()
    setState({ status: 'planning' })
    try {
      const plan = await make(controller.signal)
      if (controller.signal.aborted) return
      setState(plan === null ? { status: 'idle' } : { status: 'planned', plan })
      if (plan !== null) latest.current.presses.arm()
    } catch (reason) {
      if (controller.signal.aborted) return
      setState({ status: 'idle' })
      failed(reason)
    }
  }, [])

  /** Stops reading the plan, and keeps what the flow shows. */
  const abort = useCallback(() => reading.current?.abort(), [])

  /** Closes the review at once: a step already due for it is not sent. */
  const close = useCallback(() => {
    reading.current?.abort()
    latest.current.presses.restart()
    setState({ status: 'idle' })
  }, [])

  return {
    state,
    plan: state.status === 'planned' ? state.plan : null,
    preparing: state.status === 'planning',
    due: presses.due,
    press: presses.press,
    start,
    abort,
    close,
  }
}
