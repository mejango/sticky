'use client'

import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ReviewedActionState, ReviewedRun } from '@/hooks/useReviewedAction'

/**
 * When a flow's one reviewed run opens: as soon as the flow chose its action (`arm`), from the flow's next render
 * (`due`), and never for an action the flow closed or replaced since (`restart`). `onCancel` closes the action when the
 * person closed its review or refused its wallet prompt, unless the flow moved on meanwhile: the flow's close as of its
 * latest render, so a run refused partway closes with what went through by then.
 */
export function useStepPresses(tx: Pick<ReviewedActionState, 'run'>, onCancel?: () => void) {
  const cancel = useRef(onCancel)
  // Set before any effect can end a run: the run's own cancel is read in an effect.
  useLayoutEffect(() => {
    cancel.current = onCancel
  })
  /** The flow should press now: its action was just chosen. */
  const [due, setDue] = useState(false)
  // `live` is whether the action is open: `arm` opens it and `restart` closes it, at once, so a press already scheduled
  // for a closed action sends nothing. `generation` counts restarts: a run from before one leaves the action after it alone.
  const progress = useRef({ live: false, pressing: false, generation: 0 })

  /** Closes the action, or starts it over for a plan made afresh: nothing is sent until `arm`. */
  const restart = useCallback(() => {
    progress.current = { live: false, pressing: false, generation: progress.current.generation + 1 }
    setDue(false)
  }, [])

  /** The action was chosen: its review opens from the flow's next render. */
  const arm = useCallback(() => {
    progress.current.live = true
    setDue(true)
  }, [])

  /** Reviews and sends the action's steps in one run, once per press, only while the action is open and not yet sent. */
  const press = useCallback(
    async (action: ReviewedRun): Promise<void> => {
      const { generation } = progress.current
      if (progress.current.pressing || !progress.current.live) return
      progress.current.pressing = true
      setDue(false)
      try {
        const done = await tx.run({
          ...action,
          ...(cancel.current ? { onCancelled: () => { if (progress.current.generation === generation) cancel.current?.() } } : {}),
        })
        // A run that sent its action, or handed it to a Safe, is that action's one run: a press from a render behind sends nothing.
        if (done && progress.current.generation === generation) progress.current.live = false
      } finally {
        if (progress.current.generation === generation) progress.current.pressing = false
      }
    },
    [tx],
  )

  return { due, arm, restart, press }
}
