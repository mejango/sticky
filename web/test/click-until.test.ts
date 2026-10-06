// @vitest-environment node

import type { Locator } from '@playwright/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickUntil } from './browser/click-until'

/**
 * The browser suite follows a link in a frame that has just opened on another origin, and a click that reaches such a frame
 * before it takes input is dropped without a navigation (a fresh Linux Chromium does it to the first one now and then).
 * `clickUntil` clicks again until what the click starts has started, or the link is gone because the frame has left, and
 * answers within a bound whatever the page does. The pages here are a link and a clock that moves only when a test moves it.
 */

/** A link that is clicked as `clicked` says, and is there as `present` says. */
function link({ clicked, present = () => true }: { clicked: (clicks: number) => void; present?: (clicks: number) => boolean }) {
  let clicks = 0
  const click = vi.fn(async (_options?: { timeout?: number }) => {
    clicks += 1
    clicked(clicks)
  })
  const count = vi.fn(async () => (present(clicks) ? 1 : 0))
  return { locator: { click, count } as unknown as Locator, click, clicks: () => clicks }
}

/** What the click starts: a promise, and the call that settles it. */
function started() {
  let start!: () => void
  const promise = new Promise<void>(resolve => {
    start = resolve
  })
  return { promise, start }
}

/** Every wait the helper makes: a click's 2 s to start what it starts, four times over, and 15 s after the last. */
const BOUND = 4 * 2_000 + 15_000

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('clickUntil', () => {
  it('clicks once when the first click starts what it starts', async () => {
    const exchange = started()
    const page = link({ clicked: exchange.start })

    await expect(clickUntil(page.locator, exchange.promise)).resolves.toBe(true)
    expect(page.clicks()).toBe(1)
  })

  it('clicks again after a click that was dropped, and stops once one lands', async () => {
    const exchange = started()
    const page = link({ clicked: clicks => clicks === 3 && exchange.start() })

    const result = clickUntil(page.locator, exchange.promise)
    await vi.advanceTimersByTimeAsync(2 * 2_000)

    await expect(result).resolves.toBe(true)
    expect(page.clicks()).toBe(3)
  })

  it('clicks four times at most, and answers false a bound after the first', async () => {
    const exchange = started()
    const page = link({ clicked: () => {} })

    let answer: boolean | undefined
    void clickUntil(page.locator, exchange.promise).then(result => {
      answer = result
    })
    await vi.advanceTimersByTimeAsync(BOUND - 1)
    expect(answer, 'the answer is not given early').toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toBe(false)
    expect(page.clicks()).toBe(4)
  })

  it('stops clicking once the link is gone, and waits on for what the frame it left for starts', async () => {
    const exchange = started()
    const page = link({ clicked: () => {}, present: clicks => clicks === 0 })
    setTimeout(exchange.start, 9_000)

    const result = clickUntil(page.locator, exchange.promise)
    await vi.advanceTimersByTimeAsync(9_000)

    await expect(result).resolves.toBe(true)
    expect(page.clicks()).toBe(1)
  })

  it('gives each click a bound of its own, and fails on one that cannot be made', async () => {
    const page = link({ clicked: () => {} })
    page.click.mockRejectedValueOnce(new Error('locator.click: Timeout 5000ms exceeded.'))

    await expect(clickUntil(page.locator, started().promise)).rejects.toThrow('Timeout 5000ms exceeded')

    const next = link({ clicked: () => {} })
    const result = clickUntil(next.locator, started().promise)
    await vi.advanceTimersByTimeAsync(BOUND)
    await result
    expect(next.click).toHaveBeenCalledTimes(4)
    expect(next.click).toHaveBeenCalledWith({ timeout: 5_000 })
  })
})
