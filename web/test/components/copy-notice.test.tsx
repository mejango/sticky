// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CopyAddress } from '@/components/ui/CopyAddress'

let root: Root, host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => undefined) } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  vi.useRealTimers(); vi.unstubAllGlobals()
})

describe('copy notice', () => {
  it('keeps a second copy\'s notice for its full time', async () => {
    await act(async () => root.render(<CopyAddress label="token" address="0x1" />))
    const button = host.querySelector('button')!
    await act(async () => button.click())
    expect(button.textContent).toBe('Copied!')
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    await act(async () => button.click())
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(button.textContent).toBe('Copied!')
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(button.textContent).toBe('Copy')
  })
})
