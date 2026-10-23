// @vitest-environment jsdom

import { act, useImperativeHandle, createRef, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Address } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewedRun } from '@/hooks/useReviewedAction'
import { useStepPresses } from '@/hooks/useStepPresses'

// When a flow's one reviewed run opens: once its action is chosen, once per press, never for an action closed or
// replaced since, and never again once the action was sent. The engine is a stand-in `run` the test answers.

type Presses = ReturnType<typeof useStepPresses>
type Result = Awaited<ReturnType<Parameters<typeof useStepPresses>[0]['run']>>

const ACTION: ReviewedRun = { account: `0x${'a1'.repeat(20)}` as Address, calls: [{ chainId: 1, to: `0x${'b2'.repeat(20)}`, data: '0x' }] }
const DONE = { status: 'done', hashes: [], receipts: [], signatures: [] } as unknown as Result

let host: HTMLDivElement
let root: Root
let run: ReturnType<typeof vi.fn<(action: ReviewedRun) => Promise<Result>>>
const handle = createRef<Presses>()

function Harness({ handle, onCancel }: { handle: Ref<Presses>; onCancel?: () => void }) {
  const presses = useStepPresses({ run }, onCancel)
  useImperativeHandle(handle, () => presses, [presses])
  return <p data-due={presses.due} />
}

beforeEach(async () => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  run = vi.fn(async () => DONE)
  await act(async () => root.render(<Harness handle={handle} />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const due = () => host.querySelector('p')!.dataset.due === 'true'
const press = () => act(async () => handle.current!.press(ACTION))
/** Renders the flow again with `onCancel` as its close. */
const closesWith = (onCancel: () => void) => act(async () => root.render(<Harness handle={handle} onCancel={onCancel} />))

describe('useStepPresses', () => {
  it('sends nothing until the action is chosen, then is due once, and runs it once per press', async () => {
    await press()
    expect(run).not.toHaveBeenCalled()

    await act(async () => handle.current!.arm())
    expect(due()).toBe(true)
    await press()
    expect(due()).toBe(false)
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ calls: ACTION.calls }))
  })

  it('sends nothing for a press while its run is out, or once the action was sent', async () => {
    const out = Promise.withResolvers<Result>()
    run.mockReturnValueOnce(out.promise)
    await act(async () => handle.current!.arm())
    const first = handle.current!.press(ACTION)
    await press()
    expect(run).toHaveBeenCalledOnce()
    await act(async () => {
      out.resolve(DONE)
      await first
    })
    // A press from a render behind, after the action's one run sent it.
    await press()
    expect(run).toHaveBeenCalledOnce()
  })

  it('runs again on the next press after a run that failed with nothing finished, as Retry does', async () => {
    run.mockResolvedValueOnce(null)
    await act(async () => handle.current!.arm())
    await press()
    await press()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('closes the action when the run was cancelled, unless the flow restarted meanwhile', async () => {
    const onCancel = vi.fn()
    run.mockImplementation(async action => {
      action.onCancelled?.()
      return null
    })
    await closesWith(onCancel)
    await act(async () => handle.current!.arm())
    await press()
    expect(onCancel).toHaveBeenCalledOnce()

    const out = Promise.withResolvers<void>()
    run.mockImplementationOnce(async action => {
      await out.promise
      action.onCancelled?.()
      return null
    })
    const pressed = handle.current!.press(ACTION)
    await act(async () => handle.current!.restart())
    await act(async () => {
      out.resolve()
      await pressed
    })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('closes with the close of the latest render, not the one of the render that pressed', async () => {
    const out = Promise.withResolvers<void>()
    run.mockImplementationOnce(async action => {
      await out.promise
      action.onCancelled?.()
      return null
    })
    const pressedWith = vi.fn()
    const latest = vi.fn()
    await closesWith(pressedWith)
    await act(async () => handle.current!.arm())
    const pressed = handle.current!.press(ACTION)
    // The run reported a step, and the flow rendered again with a close that says so.
    await closesWith(latest)
    await act(async () => {
      out.resolve()
      await pressed
    })
    expect(latest).toHaveBeenCalledOnce()
    expect(pressedWith).not.toHaveBeenCalled()
  })

  it('sends nothing after a restart until the action is chosen again', async () => {
    await act(async () => handle.current!.arm())
    await act(async () => handle.current!.restart())
    expect(due()).toBe(false)
    await press()
    expect(run).not.toHaveBeenCalled()
    await act(async () => handle.current!.arm())
    await press()
    expect(run).toHaveBeenCalledOnce()
  })
})
