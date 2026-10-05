// @vitest-environment jsdom

import { act, useImperativeHandle, createRef, type Ref } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { Hex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { useSafeTx } from '@/hooks/useSafeTx'
import { useStepPresses } from '@/hooks/useStepPresses'

// A plan's steps sent one per press: which step a press sends, when a step counts as confirmed, and the block the
// next step is simulated at. The engine is a stand-in that reports a phase and a receipt, as useSafeTx does.

type Engine = Pick<ReturnType<typeof useSafeTx>, 'phase' | 'receipt'>
type Presses = ReturnType<typeof useStepPresses>

const H1 = `0x${'01'.repeat(32)}` as Hex
const H2 = `0x${'02'.repeat(32)}` as Hex

function Harness({ tx, handle }: { tx: Engine; handle: Ref<Presses> }) {
  const presses = useStepPresses(tx)
  useImperativeHandle(handle, () => presses, [presses])
  return <p data-landed={presses.landed} />
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
const landed = () => Number(host.querySelector('p')!.dataset.landed)
const confirmed = (block: bigint) => engine({ phase: 'success', receipt: { blockNumber: block } as Engine['receipt'] })
/** A press whose send the engine answers with `hash`, or with null for a send it does not take. */
async function press(steps: readonly string[], hash: Hex | null) {
  const send = vi.fn(async (_step: string, _confirmedAt: bigint | undefined) => hash)
  await act(async () => handle.current!.press(steps, send))
  if (hash) await engine({ phase: 'pending', receipt: null })
  return send
}

describe('useStepPresses', () => {
  it('sends one step per press, the next once the one before it confirmed, at the block it confirmed in', async () => {
    await engine({})
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
    await engine({})
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
    await engine({})
    const steps = ['approve', 'stick', 'trust']
    await press(steps, H1)
    await confirmed(10n)
    await confirmed(10n)
    await engine({ phase: 'success', receipt: { blockNumber: 10n } as Engine['receipt'] })
    expect(landed()).toBe(1)
  })

  it('sends nothing once every step has confirmed', async () => {
    await engine({})
    await press(['stick'], H1)
    await confirmed(10n)
    const send = await press(['stick'], H2)
    expect(send).not.toHaveBeenCalled()
    expect(landed()).toBe(1)
  })

  it('starts over at the first step, at no block, for a plan made afresh', async () => {
    await engine({})
    await press(['approve', 'stick'], H1)
    await confirmed(10n)
    await act(async () => handle.current!.restart())
    expect(landed()).toBe(0)
    expect((await press(['stick'], H2)).mock.calls).toEqual([['stick', undefined]])
  })
})
