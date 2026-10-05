import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { READ_LANES, inTurn } from '@/lib/in-turn'

const signal = () => new AbortController().signal
const ticks = async (count = 3) => {
  for (let at = 0; at < count; at += 1) await Promise.resolve()
}

describe('inTurn', () => {
  it('runs two reads at once, and starts the next as one ends, in the order they were asked for', async () => {
    const client = new QueryClient()
    const started: string[] = []
    const first = Promise.withResolvers<string>()
    const second = Promise.withResolvers<string>()
    const third = Promise.withResolvers<string>()
    const reads = [
      inTurn(client, signal(), () => (started.push('first'), first.promise)),
      inTurn(client, signal(), () => (started.push('second'), second.promise)),
      inTurn(client, signal(), () => (started.push('third'), third.promise)),
      inTurn(client, signal(), async () => (started.push('fourth'), 'done')),
    ]
    await ticks()
    expect(started).toEqual(['first', 'second'])

    // The second ends first: the third takes its lane, and the fourth still waits for one.
    second.resolve('b')
    await reads[1]
    await ticks()
    expect(started).toEqual(['first', 'second', 'third'])

    first.resolve('a')
    third.resolve('c')
    expect(await Promise.all(reads)).toEqual(['a', 'b', 'c', 'done'])
    expect(started).toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('goes on to the next read when one fails, and gives the failure to the read that made it', async () => {
    const client = new QueryClient()
    const failure = new Error('rpc down')
    const held = Promise.withResolvers<void>()
    void inTurn(client, signal(), () => held.promise)
    const failed = inTurn(client, signal(), async () => {
      throw failure
    })
    const next = inTurn(client, signal(), async () => 'read')
    await expect(failed).rejects.toBe(failure)
    expect(await next).toBe('read')
    held.resolve()
  })

  it('takes a read cancelled while it waits out of line at once, rejecting with the reason, and never starts it', async () => {
    const client = new QueryClient()
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const controller = new AbortController()
    const reason = new Error('left the page')
    let started = false
    void inTurn(client, signal(), () => first.promise)
    void inTurn(client, signal(), () => second.promise)
    const cancelled = inTurn(client, controller.signal, async () => {
      started = true
    })
    controller.abort(reason)
    await expect(cancelled).rejects.toBe(reason)
    first.resolve()
    second.resolve()
    await ticks()
    expect(started).toBe(false)
    // The turns that come after it are not held up.
    expect(await inTurn(client, signal(), async () => 'next')).toBe('next')
  })

  it('makes a client wait for its own reads only', async () => {
    const busy = new QueryClient()
    const other = new QueryClient()
    for (let lane = 0; lane < READ_LANES; lane += 1) void inTurn(busy, signal(), () => new Promise<void>(() => {}))
    let waited = true
    void inTurn(busy, signal(), async () => void (waited = false))
    expect(await inTurn(other, signal(), async () => 'other')).toBe('other')
    expect(waited).toBe(true)
  })
})
