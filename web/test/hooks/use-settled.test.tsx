// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettled } from '@/hooks/useSettled'

// What typing settles to, which the stick and unstick flows quote.

let root: Root
let seen: string
function Probe({ value, report }: { value: string; report: (settled: string) => void }) {
  report(useSettled(value))
  return null
}
const render = (value: string) =>
  act(async () =>
    root.render(
      <Probe
        value={value}
        report={settled => {
          seen = settled
        }}
      />,
    ),
  )
const wait = (ms: number) => act(async () => void vi.advanceTimersByTime(ms))

beforeEach(() => {
  vi.useFakeTimers()
  root = createRoot(document.createElement('div'))
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
})

describe('useSettled', () => {
  it('starts with the first value, and takes a new one once it has stayed for 250 ms', async () => {
    await render('5')
    expect(seen).toBe('5')
    await render('50')
    await wait(249)
    expect(seen).toBe('5')
    await wait(1)
    expect(seen).toBe('50')
  })

  it('waits again from each change, so only what typing stops at is taken', async () => {
    await render('')
    await render('1')
    await wait(200)
    await render('12')
    await wait(200)
    expect(seen).toBe('')
    await wait(50)
    expect(seen).toBe('12')
  })
})
