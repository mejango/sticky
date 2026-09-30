import { afterEach, describe, expect, it, vi } from 'vitest'
import { withTimeout } from '@/lib/with-timeout'

afterEach(() => vi.useRealTimers())

/** Work that never finishes on its own: it fails with the signal's reason when the signal aborts. */
const stuck = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })

describe('withTimeout', () => {
  it('gives back what the work gives, and leaves no timer running', async () => {
    vi.useFakeTimers()
    await expect(withTimeout(5_000, undefined, async () => 'done')).resolves.toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives back the work\'s failure, and leaves no timer running', async () => {
    vi.useFakeTimers()
    await expect(
      withTimeout(5_000, undefined, async () => {
        throw new Error('no route')
      }),
    ).rejects.toThrow('no route')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts the work\'s signal with a TimeoutError once the time has passed', async () => {
    vi.useFakeTimers()
    const outcome = withTimeout(5_000, undefined, stuck).catch((error: DOMException) => error)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    const error = await outcome
    expect(error).toBeInstanceOf(DOMException)
    expect(error).toMatchObject({ name: 'TimeoutError', message: 'No answer within 5000 ms.' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts the work with the caller\'s reason when the caller\'s signal aborts', async () => {
    const caller = new AbortController()
    const outcome = withTimeout(5_000, caller.signal, stuck)
    caller.abort(new Error('left the page'))
    await expect(outcome).rejects.toThrow('left the page')
  })

  it('does not start work for a caller that has already given up', async () => {
    const caller = new AbortController()
    caller.abort(new Error('left the page'))
    const work = vi.fn()
    await expect(withTimeout(5_000, caller.signal, work)).rejects.toThrow('left the page')
    expect(work).not.toHaveBeenCalled()
  })

  it('stops listening to the caller once the work has finished', async () => {
    const caller = new AbortController()
    const seen: AbortSignal[] = []
    await withTimeout(5_000, caller.signal, async signal => {
      seen.push(signal)
    })
    caller.abort(new Error('too late'))
    expect(seen[0].aborted).toBe(false)
  })
})
