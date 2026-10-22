// @vitest-environment jsdom

import { act, useImperativeHandle, createRef, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { useSafeTx } from '@/hooks/useSafeTx'
import { useStepPresses } from '@/hooks/useStepPresses'
import { TransactionReviewCancelledError } from '@/lib/transaction-review'

// A plan's steps, sent through one engine: which step a press sends, when a step counts as confirmed, the block the
// next step is simulated at, and the action's one decoded review. The engine is a stand-in that reports a phase and a
// receipt, as useSafeTx does, and reviews as `review` says.

type Engine = Pick<ReturnType<typeof useSafeTx>, 'phase' | 'receipt'> & { review?: ReturnType<typeof vi.fn> }
type Presses = ReturnType<typeof useStepPresses>

const H1 = `0x${'01'.repeat(32)}` as Hex
const H2 = `0x${'02'.repeat(32)}` as Hex

function Harness({ tx, handle }: { tx: Engine; handle: Ref<Presses> }) {
  const presses = useStepPresses(tx as Parameters<typeof useStepPresses>[0])
  useImperativeHandle(handle, () => presses, [presses])
  return <p data-landed={presses.landed} data-due={presses.due} />
}

let host: HTMLDivElement
let root: Root
let tx: Engine
const handle = createRef<Presses>()

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  tx = { phase: 'idle', receipt: null }
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function engine(next: Partial<Engine>) {
  tx = { ...tx, ...next }
  await act(async () => root.render(<Harness tx={tx} handle={handle} />))
}
/** The engine, and an action chosen on it: its presses send from now on. */
async function opened(next: Partial<Engine> = {}) {
  await engine(next)
  await act(async () => handle.current!.arm())
}
const landed = () => Number(host.querySelector('p')!.dataset.landed)
const due = () => host.querySelector('p')!.dataset.due === 'true'
const confirmed = (block: bigint) => engine({ phase: 'success', receipt: { blockNumber: block } as Engine['receipt'] })
/** A press whose send the engine answers with `hash`, or with null for a send it does not take. */
async function press(steps: readonly string[], hash: Hex | null) {
  const send = vi.fn(async (_step: string, _confirmedAt: bigint | undefined) => hash)
  await act(async () => void (await handle.current!.press(steps, (step, confirmedAt) => send(step, confirmedAt))))
  if (hash) await engine({ phase: 'pending', receipt: null })
  return send
}

describe('useStepPresses', () => {
  it('counts no Safe proposal as landed until the engine proves its execution', async () => {
    await opened()
    const steps = ['approve', 'stick']
    await press(steps, H1)
    await engine({ phase: 'submitted', receipt: null })
    expect(landed()).toBe(0)

    await confirmed(10n)
    expect(landed()).toBe(1)
    expect((await press(steps, H2)).mock.calls).toEqual([['stick', 10n]])
  })

  it('sends one step per press, the next once the one before it confirmed, at the block it confirmed in', async () => {
    await opened()
    const steps = ['approve', 'stick']
    expect((await press(steps, H1)).mock.calls).toEqual([['approve', undefined]])
    expect(landed()).toBe(0)

    await confirmed(10n)
    expect(landed()).toBe(1)
    expect((await press(steps, H2)).mock.calls).toEqual([['stick', 10n]])
    await confirmed(12n)
    expect(landed()).toBe(2)
  })

  it('counts a confirmation only for a step whose send the engine took', async () => {
    await opened()
    const steps = ['approve', 'stick']
    await press(steps, H1)
    await confirmed(10n)

    // The engine did not take the stick: the approval's success still on show is never the stick's.
    await press(steps, null)
    await engine({ phase: 'success', receipt: { blockNumber: 11n } as Engine['receipt'] })
    expect(landed()).toBe(1)
    // The next press sends the stick again.
    expect((await press(steps, H2)).mock.calls).toEqual([['stick', 10n]])
  })

  it('counts a step once, however often the engine shows its confirmation', async () => {
    await opened()
    const steps = ['approve', 'stick', 'trust']
    await press(steps, H1)
    await confirmed(10n)
    await confirmed(10n)
    await engine({ phase: 'success', receipt: { blockNumber: 10n } as Engine['receipt'] })
    expect(landed()).toBe(1)
  })

  it('sends nothing once every step has confirmed', async () => {
    await opened()
    await press(['stick'], H1)
    await confirmed(10n)
    const send = await press(['stick'], H2)
    expect(send).not.toHaveBeenCalled()
    expect(landed()).toBe(1)
  })

  it('starts over at the first step, at no block, for a plan made afresh', async () => {
    await opened()
    await press(['approve', 'stick'], H1)
    await confirmed(10n)
    await act(async () => handle.current!.restart())
    expect(landed()).toBe(0)
    // Closed: nothing is sent until the plan made afresh is chosen.
    expect(await press(['stick'], H2)).not.toHaveBeenCalled()
    await act(async () => handle.current!.arm())
    expect((await press(['stick'], H2)).mock.calls).toEqual([['stick', undefined]])
  })
})

describe('the action\'s one decoded review', () => {
  const ACTION = { account: `0x${'a'.repeat(40)}` as const, title: 'Stick' }
  const PROOF = Object.freeze({})
  /** A press with the action's review, whose send the engine answers with `hash`. */
  async function reviewed(steps: readonly string[], hash: Hex | null) {
    const send = vi.fn(async (_step: string, _confirmedAt: bigint | undefined, _reviewed: unknown) => hash)
    let outcome: string | undefined
    await act(async () => void (outcome = await handle.current!.press(steps, send, ACTION)))
    if (hash) await engine({ phase: 'pending', receipt: null })
    return { send, outcome }
  }

  it('shows every step left once, sends each with its proof, and makes the next due once the one before confirms', async () => {
    await opened({ review: vi.fn(async () => PROOF) })
    const steps = ['approve', 'stick']
    const first = await reviewed(steps, H1)
    expect(tx.review).toHaveBeenCalledExactlyOnceWith(steps, ACTION)
    expect(first.send.mock.calls).toEqual([['approve', undefined, PROOF]])
    expect(due()).toBe(false)

    await confirmed(10n)
    expect(due()).toBe(true)
    const second = await reviewed(steps, H2)
    expect(second.send.mock.calls).toEqual([['stick', 10n, PROOF]])
    expect(tx.review).toHaveBeenCalledOnce()
    await confirmed(12n)
    // Nothing is left to send.
    expect(due()).toBe(false)
  })

  it('sends nothing, and says so, when the review is closed', async () => {
    await opened({ review: vi.fn(async () => Promise.reject(new TransactionReviewCancelledError())) })
    const { send, outcome } = await reviewed(['approve', 'stick'], H1)
    expect(outcome).toBe('cancelled')
    expect(send).not.toHaveBeenCalled()
  })

  it('reviews the steps left again after a send the engine did not take', async () => {
    await opened({ review: vi.fn(async () => PROOF) })
    const steps = ['approve', 'stick']
    await reviewed(steps, H1)
    await confirmed(10n)
    expect((await reviewed(steps, null)).outcome).toBe('unsent')
    await engine({ phase: 'error', receipt: null })
    await reviewed(steps, H2)
    expect(tx.review).toHaveBeenCalledTimes(2)
    expect(tx.review).toHaveBeenLastCalledWith(['stick'], ACTION)
  })

  it('sends nothing for a press while a step is out, and keeps the review for the steps after it', async () => {
    await opened({ review: vi.fn(async () => PROOF) })
    const steps = ['approve', 'stick']
    await reviewed(steps, H1)
    const stale = await reviewed(steps, H1)
    expect(stale.outcome).toBe('unsent')
    expect(stale.send).not.toHaveBeenCalled()

    await confirmed(10n)
    expect((await reviewed(steps, H2)).send.mock.calls).toEqual([['stick', 10n, PROOF]])
    expect(tx.review).toHaveBeenCalledOnce()
  })

  it('reviews the step again, and sends it, on a press after it failed on chain', async () => {
    await opened({ review: vi.fn(async () => PROOF) })
    const steps = ['approve', 'stick']
    await reviewed(steps, H1)
    await engine({ phase: 'error', receipt: null })
    expect((await reviewed(steps, H2)).send.mock.calls).toEqual([['approve', undefined, PROOF]])
    expect(tx.review).toHaveBeenCalledTimes(2)
    expect(tx.review).toHaveBeenLastCalledWith(steps, ACTION)
  })

  it('lets a step the engine released without a result be reviewed and sent again', async () => {
    await opened({ review: vi.fn(async () => PROOF) })
    const steps = ['approve', 'stick']
    await reviewed(steps, H1)
    // The hold's checked-wallet exit: the engine is idle, and the approval is neither out nor confirmed.
    await engine({ phase: 'idle', receipt: null })
    expect((await reviewed(steps, H2)).send.mock.calls).toEqual([['approve', undefined, PROOF]])
    expect(tx.review).toHaveBeenCalledTimes(2)
    expect(landed()).toBe(0)
  })

  it('sends nothing for a press scheduled before the action closed, even one whose review was open', async () => {
    let approve = (_proof: object) => {}
    await opened({ review: vi.fn(() => new Promise(resolve => (approve = resolve))) })
    const steps = ['approve', 'stick']
    const send = vi.fn(async () => H1)
    let outcome: Promise<string> | undefined
    await act(async () => void (outcome = handle.current!.press(steps, send, ACTION)))
    await act(async () => handle.current!.restart())
    await act(async () => approve(PROOF))
    expect(await outcome).toBe('unsent')
    expect(send).not.toHaveBeenCalled()
    expect(await press(steps, H1)).not.toHaveBeenCalled()
  })

  it('does not take a late close of a replaced action\'s review for a close of the action open now', async () => {
    let close = () => {}
    await opened({ review: vi.fn(() => new Promise((_, reject) => (close = () => reject(new TransactionReviewCancelledError())))) })
    let outcome: Promise<string> | undefined
    await act(async () => void (outcome = handle.current!.press(['approve', 'stick'], vi.fn(async () => H1), ACTION)))
    await act(async () => handle.current!.restart())
    await act(async () => handle.current!.arm())
    await act(async () => close())
    expect(await outcome).toBe('unsent')
  })

  it('leaves the action chosen after a restart alone when the review of the one before it closes late', async () => {
    const approvals: ((proof: object) => void)[] = []
    await opened({ review: vi.fn(() => new Promise(resolve => approvals.push(resolve))) })
    const sendA = vi.fn(async () => H1)
    let outcomeA: Promise<string> | undefined
    await act(async () => void (outcomeA = handle.current!.press(['approve A', 'stick A'], sendA, ACTION)))
    // Plan B replaces it, and its review opens.
    await act(async () => handle.current!.restart())
    await act(async () => handle.current!.arm())
    const sendB = vi.fn(async (_step: string, _confirmedAt: bigint | undefined, _reviewed: unknown) => H2)
    let outcomeB: Promise<string> | undefined
    await act(async () => void (outcomeB = handle.current!.press(['approve B', 'stick B'], sendB, ACTION)))
    // A's review closes after B's opened: A sends nothing, and B goes on as its own.
    await act(async () => approvals[0](PROOF))
    expect(await outcomeA).toBe('unsent')
    expect(sendA).not.toHaveBeenCalled()
    const B = Object.freeze({})
    await act(async () => approvals[1](B))
    expect(await outcomeB).toBe('sent')
    await engine({ phase: 'pending', receipt: null })
    await confirmed(10n)
    expect(sendB.mock.calls).toEqual([['approve B', undefined, B]])
    expect(due()).toBe(true)
  })
})
