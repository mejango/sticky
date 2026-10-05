'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import type { useSafeTx } from '@/hooks/useSafeTx'

/**
 * A plan's steps sent through one useSafeTx, one step for each press: a press sends the first step that has not
 * confirmed, and the press after it the next. Sticky asks for a press per step, named on the button that sends it,
 * where JBM's `useStepRun` sends the next step as soon as one confirms (COPIED.md says why Sticky does not use it).
 *
 * A confirmation counts only for a step whose send the engine took, and only once. The engine answers null, and changes
 * nothing, for a send it does not take (while it holds its lock for the step that has just confirmed, or after a
 * cancelled review or a failure): that press sent nothing, and the next one sends the same step. `send` is handed the
 * block the last confirmed step is in, so a step that spends an approval is simulated where the approval is.
 */
export function useStepPresses(tx: Pick<ReturnType<typeof useSafeTx>, 'phase' | 'receipt'>) {
  // How many steps have confirmed: the dialog is on the one after them. A press reads the count from the ref, which
  // changes at once when a step is counted; the state is what the dialog shows after the next render. `accepted` is the
  // step the engine took and whose confirmation has not been counted, and `confirmedAt` the block of the last one that
  // has.
  const [landed, setLanded] = useState(0)
  const progress = useRef<{ landed: number; accepted: number | null; confirmedAt: bigint | undefined }>({
    landed: 0,
    accepted: null,
    confirmedAt: undefined,
  })

  // The confirmation of the step the engine took is counted once it arrives. A confirmation seen while no step is
  // waiting for one is the last step's, and counts for nothing.
  useEffect(() => {
    const { accepted, confirmedAt } = progress.current
    if (accepted === null || tx.phase !== 'success') return
    progress.current = { landed: accepted + 1, accepted: null, confirmedAt: tx.receipt?.blockNumber ?? confirmedAt }
    setLanded(accepted + 1)
  }, [tx.phase, tx.receipt])

  /** Starts over at the first step, for a plan made afresh. */
  const restart = useCallback(() => {
    progress.current = { landed: 0, accepted: null, confirmedAt: undefined }
    setLanded(0)
  }, [])

  /** Sends the first of `steps` that has not confirmed through `send`, which hands it to the engine; nothing once every
   * step has. */
  const press = useCallback(
    async <Step>(steps: readonly Step[], send: (step: Step, confirmedAt: bigint | undefined) => Promise<Hex | null>) => {
      const at = progress.current.landed
      if (at >= steps.length) return
      const hash = await send(steps[at], progress.current.confirmedAt)
      if (hash !== null) progress.current.accepted = at
    },
    [],
  )

  return { landed, restart, press }
}
