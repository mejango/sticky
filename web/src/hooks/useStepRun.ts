'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Hex } from 'viem'
import type { useSafeTx } from '@/hooks/useSafeTx'

/**
 * Sends a plan's steps through one useSafeTx, each once the step before it
 * confirmed. `send` gets the block the last confirmed step landed in, so a
 * step that spends an approval simulates where that approval is visible.
 *
 * A confirmation counts only for a step whose send the engine took, and only
 * once. The engine answers null, and changes nothing, for a send it does not
 * take (a closed review, say): the run then stops at that step, and `resume`
 * sends it again. A failed step stops the run the same way. A stopped run
 * belongs to the steps it started with: `stoppedOn` and `resume` answer only
 * for those, so a plan reviewed since can never continue an older one.
 */
export function useStepRun<Step>({
  tx,
  send,
  onFinish,
}: {
  tx: ReturnType<typeof useSafeTx>
  send: (step: Step, confirmedAt: bigint | undefined) => Promise<Hex | null>
  /** The last step confirmed, in the transaction `hash`. */
  onFinish: (hash: Hex) => void
}) {
  const [running, setRunning] = useState(false)
  const [index, setIndex] = useState(0)
  /** The steps the run started with, while it is remembered. */
  const [runSteps, setRunSteps] = useState<readonly Step[] | null>(null)
  /** The step whose send the engine took and whose confirmation is not counted yet. */
  const [accepted, setAccepted] = useState<number | null>(null)
  // Event handlers and send callbacks read these at once; the state above is
  // what renders.
  const run = useRef({
    steps: [] as readonly Step[],
    index: 0,
    running: false,
    /** Other work holds the run (see `hold`); no step is waiting on the engine. */
    holding: false,
    /** The last confirmation counted: one still showing is never counted again. */
    counted: null as Hex | null,
    confirmedAt: undefined as bigint | undefined,
  })

  const halt = useCallback(() => {
    run.current.running = false
    setRunning(false)
  }, [])

  const sendAt = useCallback(
    (at: number) => {
      const current = run.current
      void send(current.steps[at], current.confirmedAt).then(hash => {
        if (run.current !== current || !current.running || current.index !== at) return
        if (hash === null) halt()
        else setAccepted(at)
      })
    },
    [send, halt],
  )

  useEffect(() => {
    if (!running || run.current.holding) return
    if (tx.phase === 'error') {
      setAccepted(null)
      halt()
      return
    }
    const current = run.current
    if (tx.phase !== 'success' || accepted === null || !tx.hash || tx.hash === current.counted) {
      return
    }
    current.counted = tx.hash
    setAccepted(null)
    const block = tx.receipt?.blockNumber
    if (block !== undefined && (current.confirmedAt === undefined || block > current.confirmedAt)) {
      current.confirmedAt = block
    }
    if (accepted >= current.steps.length - 1) {
      current.index = current.steps.length
      setIndex(current.index)
      halt()
      onFinish(tx.hash)
      return
    }
    current.index = accepted + 1
    setIndex(current.index)
    tx.reset()
    sendAt(current.index)
  }, [running, accepted, tx, sendAt, halt, onFinish])

  /** Start a new run at the first step. */
  const start = useCallback(
    (steps: readonly Step[]) => {
      if (run.current.running || !steps.length) return
      run.current = {
        steps,
        index: 0,
        running: true,
        holding: false,
        counted: null,
        confirmedAt: undefined,
      }
      setIndex(0)
      setRunSteps(steps)
      setAccepted(null)
      setRunning(true)
      tx.reset()
      sendAt(0)
    },
    [tx, sendAt],
  )

  /**
   * Send the step the run stopped at again. It refuses (false) for any steps
   * but the ones the run started with.
   */
  const resume = useCallback(
    (steps: readonly Step[]): boolean => {
      const current = run.current
      if (current.running || steps !== current.steps || current.index >= current.steps.length) {
        return false
      }
      current.running = true
      setAccepted(null)
      setRunning(true)
      tx.reset()
      sendAt(current.index)
      return true
    },
    [tx, sendAt],
  )

  /** Run other work, such as one Safe batch proposal, as the run: the flow is busy until it ends. */
  const hold = useCallback(
    async (work: () => Promise<void>) => {
      const current = run.current
      if (current.running) return
      current.running = true
      current.holding = true
      setRunning(true)
      try {
        await work()
      } finally {
        current.holding = false
        if (run.current === current) halt()
      }
    },
    [halt],
  )

  /**
   * Forget the run and reset the engine, whenever the flow drops or replaces
   * its plan: a stopped step, its error and its confirmed block go with it.
   */
  const clear = useCallback(() => {
    run.current = {
      steps: [],
      index: 0,
      running: false,
      holding: false,
      counted: null,
      confirmedAt: undefined,
    }
    setIndex(0)
    setRunSteps(null)
    setAccepted(null)
    setRunning(false)
    tx.reset()
  }, [tx])

  return {
    running,
    /** The step the run is on, or stopped at. */
    index,
    /** The run through these exact steps stopped before its last step confirmed, so `resume` continues it. */
    stoppedOn: (steps: readonly Step[] | undefined): boolean =>
      !running &&
      !!steps &&
      steps === runSteps &&
      index < steps.length &&
      (index > 0 || tx.phase === 'error'),
    /** `running`, read at once (for a click that lands before the next render). */
    isRunning: () => run.current.running,
    start,
    resume,
    hold,
    clear,
  }
}
