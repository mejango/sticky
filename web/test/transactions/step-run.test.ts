import { createElement, createRef, forwardRef, useImperativeHandle } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { Hex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import type { useSafeTx } from '@/hooks/useSafeTx'
import { useStepRun } from '@/hooks/useStepRun'

type Tx = ReturnType<typeof useSafeTx>
type Run = ReturnType<typeof useStepRun<string>>
type Props = {
  tx: Tx
  send: (step: string, confirmedAt: bigint | undefined) => Promise<Hex | null>
  onFinish: (hash: Hex) => void
}

const H1 = `0x${'01'.repeat(32)}` as Hex
const H2 = `0x${'02'.repeat(32)}` as Hex
const H3 = `0x${'03'.repeat(32)}` as Hex

const Harness = forwardRef<Run, Props>(function Harness(props, ref) {
  const run = useStepRun<string>(props)
  useImperativeHandle(ref, () => run, [run])
  return null
})

/** The engine's state as useSafeTx reports it, and a send whose answer each test gives. */
async function renderRun() {
  const ref = createRef<Run>()
  const reset = vi.fn()
  let tx = { phase: 'idle', hash: null, receipt: null, reset } as unknown as Tx
  const answers: ((hash: Hex | null) => void)[] = []
  const send = vi.fn(
    (_step: string, _confirmedAt: bigint | undefined) =>
      new Promise<Hex | null>(resolve => answers.push(resolve)),
  )
  const onFinish = vi.fn()
  let renderer!: TestRenderer.ReactTestRenderer
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { ref, tx, send, onFinish }))
  })
  const engine = async (next: Partial<Tx>) => {
    tx = { ...tx, ...next } as Tx
    await act(async () => {
      renderer.update(createElement(Harness, { ref, tx, send, onFinish }))
    })
  }
  /**
   * The engine answers the latest send: a hash it took, or null for one it did
   * not. useSafeTx shows a taken hash as pending before `send` resolves;
   * `showFirst: false` answers while it still shows its previous state.
   */
  const answer = async (
    hash: Hex | null,
    { showFirst = true, send = answers.length - 1 } = {},
  ) => {
    if (hash && showFirst) await engine({ phase: 'pending', hash })
    await act(async () => {
      answers[send](hash)
    })
    if (hash && !showFirst) await engine({ phase: 'pending', hash })
  }
  const confirm = (hash: Hex, blockNumber: bigint) =>
    engine({ phase: 'success', hash, receipt: { blockNumber } as Tx['receipt'] })
  return { ref, send, reset, onFinish, engine, answer, confirm }
}

describe('useStepRun', () => {
  it('sends each step once the one before it confirms, at the block it confirmed in', async () => {
    const run = await renderRun()
    const plan = ['approve', 'permit', 'mint']
    await act(async () => run.ref.current!.start(plan))
    expect(run.send).toHaveBeenLastCalledWith('approve', undefined)
    expect(run.ref.current).toMatchObject({ running: true, index: 0 })
    expect(run.ref.current!.isRunning()).toBe(true)

    await run.answer(H1)
    await run.confirm(H1, 10n)
    expect(run.send).toHaveBeenLastCalledWith('permit', 10n)
    expect(run.ref.current!.index).toBe(1)

    await run.answer(H2)
    await run.confirm(H2, 12n)
    expect(run.send).toHaveBeenLastCalledWith('mint', 12n)

    await run.answer(H3)
    await run.confirm(H3, 14n)
    expect(run.onFinish).toHaveBeenCalledExactlyOnceWith(H3)
    expect(run.send).toHaveBeenCalledTimes(3)
    // One reset before each send clears the engine's lock and last result.
    expect(run.reset).toHaveBeenCalledTimes(3)
    expect(run.ref.current).toMatchObject({ running: false, index: 3 })
    expect(run.ref.current!.stoppedOn(plan)).toBe(false)
    expect(run.ref.current!.isRunning()).toBe(false)
  })

  it('counts a confirmation only for a step whose send the engine took', async () => {
    const run = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => run.ref.current!.start(plan))
    await run.answer(H1)
    await run.confirm(H1, 10n)
    expect(run.send).toHaveBeenLastCalledWith('mint', 10n)

    // The engine did not take the mint (its review closed). A success still on
    // screen, or seen again, is the approval's and never the mint's.
    await run.answer(null)
    await run.engine({ phase: 'success', hash: H1 })
    await run.engine({ phase: 'success', hash: H2 })
    expect(run.onFinish).not.toHaveBeenCalled()
    expect(run.send).toHaveBeenCalledTimes(2)
    expect(run.ref.current).toMatchObject({ running: false, index: 1 })
    expect(run.ref.current!.stoppedOn(plan)).toBe(true)
  })

  it("never counts the last step's confirmation for the next step", async () => {
    const run = await renderRun()
    await act(async () => run.ref.current!.start(['approve', 'mint']))
    await run.answer(H1)
    await run.confirm(H1, 10n)
    // The engine takes the mint while it still shows the approval's success.
    await run.answer(H2, { showFirst: false })
    expect(run.onFinish).not.toHaveBeenCalled()
    await run.confirm(H2, 11n)
    expect(run.onFinish).toHaveBeenCalledExactlyOnceWith(H2)
  })

  it('waits for the engine to take a send before counting any confirmation', async () => {
    const run = await renderRun()
    await act(async () => run.ref.current!.start(['approve', 'mint']))
    await run.answer(H1)
    await run.confirm(H1, 10n)
    // The mint is in review: nothing the engine shows counts for it yet.
    await run.engine({ phase: 'success', hash: H2 })
    expect(run.onFinish).not.toHaveBeenCalled()
    expect(run.send).toHaveBeenCalledTimes(2)
    expect(run.ref.current).toMatchObject({ running: true, index: 1 })

    await run.answer(H3)
    await run.confirm(H3, 11n)
    expect(run.onFinish).toHaveBeenCalledExactlyOnceWith(H3)
  })

  it('stops at a step the engine did not take, so the flow is not left busy, and resumes from it', async () => {
    const run = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => run.ref.current!.start(plan))
    await run.answer(H1)
    await run.confirm(H1, 10n)
    await run.answer(null)
    await run.engine({ phase: 'idle', hash: null })
    expect(run.ref.current).toMatchObject({ running: false, index: 1 })
    expect(run.ref.current!.stoppedOn(plan)).toBe(true)

    await act(async () => {
      expect(run.ref.current!.resume(plan)).toBe(true)
    })
    expect(run.send).toHaveBeenLastCalledWith('mint', 10n)
    expect(run.ref.current).toMatchObject({ running: true, index: 1 })
    expect(run.ref.current!.stoppedOn(plan)).toBe(false)
    await run.answer(H2)
    await run.confirm(H2, 11n)
    expect(run.onFinish).toHaveBeenCalledExactlyOnceWith(H2)
  })

  it('starts over when the first step was not taken', async () => {
    const run = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => run.ref.current!.start(plan))
    await run.answer(null)
    expect(run.ref.current).toMatchObject({ running: false, index: 0 })
    expect(run.ref.current!.stoppedOn(plan)).toBe(false)
    await act(async () => run.ref.current!.start(plan))
    expect(run.send).toHaveBeenLastCalledWith('approve', undefined)
    expect(run.send).toHaveBeenCalledTimes(2)
  })

  it('stops on a failed step and sends that step again on resume', async () => {
    const run = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => run.ref.current!.start(plan))
    await run.answer(H1)
    await run.engine({ phase: 'error' })
    expect(run.ref.current).toMatchObject({ running: false, index: 0 })
    expect(run.ref.current!.stoppedOn(plan)).toBe(true)

    await act(async () => {
      run.ref.current!.resume(plan)
    })
    expect(run.send).toHaveBeenLastCalledWith('approve', undefined)
    expect(run.send).toHaveBeenCalledTimes(2)
  })

  it('belongs to the steps it started with: another plan is never stopped and never resumed', async () => {
    const run = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => run.ref.current!.start(plan))
    await run.answer(H1)
    await run.confirm(H1, 10n)
    await run.answer(null)
    expect(run.ref.current!.stoppedOn(plan)).toBe(true)

    // A plan reviewed since, even one with the same steps, cannot continue this run.
    const reviewedSince = ['approve', 'mint']
    expect(run.ref.current!.stoppedOn(reviewedSince)).toBe(false)
    expect(run.ref.current!.stoppedOn(undefined)).toBe(false)
    await act(async () => {
      expect(run.ref.current!.resume(reviewedSince)).toBe(false)
    })
    expect(run.send).toHaveBeenCalledTimes(2)
    expect(run.ref.current!.isRunning()).toBe(false)
  })

  it('forgets a stopped run and resets the engine when the plan is dropped', async () => {
    const run = await renderRun()
    const plan = ['approve', 'mint']
    await act(async () => run.ref.current!.start(plan))
    await run.answer(H1)
    await run.engine({ phase: 'error' })
    expect(run.ref.current!.stoppedOn(plan)).toBe(true)
    const resets = run.reset.mock.calls.length

    await act(async () => run.ref.current!.clear())
    expect(run.reset).toHaveBeenCalledTimes(resets + 1)
    await run.engine({ phase: 'idle', hash: null })
    expect(run.ref.current).toMatchObject({ running: false, index: 0 })
    expect(run.ref.current!.stoppedOn(plan)).toBe(false)
    await act(async () => {
      expect(run.ref.current!.resume(plan)).toBe(false)
    })
    expect(run.send).toHaveBeenCalledOnce()
  })

  it('ignores a send answered after its run was cleared, even once a new run started', async () => {
    const run = await renderRun()
    await act(async () => run.ref.current!.start(['approve', 'mint']))
    await act(async () => run.ref.current!.clear())
    await act(async () => run.ref.current!.start(['approve', 'mint']))
    // The first run's approval answers now; the new run's is still in review.
    await run.answer(H1, { send: 0 })
    await run.confirm(H1, 10n)
    expect(run.send).toHaveBeenCalledTimes(2)
    expect(run.ref.current).toMatchObject({ running: true, index: 0 })
  })

  it('holds the run busy for other work until it ends, whatever the engine last reported', async () => {
    const run = await renderRun()
    await run.engine({ phase: 'error' })
    let finish!: () => void
    let held!: Promise<void>
    await act(async () => {
      held = run.ref.current!.hold(() => new Promise<void>(resolve => (finish = resolve)))
    })
    await run.engine({ phase: 'error' })
    expect(run.ref.current).toMatchObject({ running: true })
    expect(run.ref.current!.stoppedOn(['approve'])).toBe(false)
    // A second start while held does nothing.
    await act(async () => run.ref.current!.start(['approve']))
    expect(run.send).not.toHaveBeenCalled()

    await act(async () => {
      finish()
      await held
    })
    expect(run.ref.current).toMatchObject({ running: false })
  })
})
