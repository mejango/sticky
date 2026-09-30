import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { inTurn } from '@/lib/in-turn'

const signal = () => new AbortController().signal

describe('inTurn', () => {
  it('starts a read only once the reads asked for before it have ended, and in the order they were asked', async () => {
    const client = new QueryClient()
    const started: string[] = []
    const first = Promise.withResolvers<string>()
    const second = Promise.withResolvers<string>()
    const reads = [
      inTurn(client, signal(), () => (started.push('first'), first.promise)),
      inTurn(client, signal(), () => (started.push('second'), second.promise)),
      inTurn(client, signal(), async () => (started.push('third'), 'done')),
    ]
    await Promise.resolve()
    expect(started).toEqual(['first'])

    first.resolve('a')
    await reads[0]
    await Promise.resolve()
    expect(started).toEqual(['first', 'second'])

    second.resolve('b')
    expect(await Promise.all(reads)).toEqual(['a', 'b', 'done'])
    expect(started).toEqual(['first', 'second', 'third'])
  })

  it('goes on to the next read when one fails, and gives the failure to the read that made it', async () => {
    const client = new QueryClient()
    const failure = new Error('rpc down')
    const failed = inTurn(client, signal(), async () => {
      throw failure
    })
    const next = inTurn(client, signal(), async () => 'read')
    await expect(failed).rejects.toBe(failure)
    expect(await next).toBe('read')
  })

  it('does not start a read that was cancelled while it waited, and rejects it with the reason of the cancel', async () => {
    const client = new QueryClient()
    const first = Promise.withResolvers<void>()
    const controller = new AbortController()
    const reason = new Error('left the page')
    let started = false
    inTurn(client, signal(), () => first.promise)
    const cancelled = inTurn(client, controller.signal, async () => {
      started = true
    })
    controller.abort(reason)
    first.resolve()
    await expect(cancelled).rejects.toBe(reason)
    expect(started).toBe(false)
    // The turns that come after it are not held up.
    expect(await inTurn(client, signal(), async () => 'next')).toBe('next')
  })

  it('makes a client wait for its own reads only', async () => {
    const busy = new QueryClient()
    const other = new QueryClient()
    inTurn(busy, signal(), () => new Promise<void>(() => {}))
    expect(await inTurn(other, signal(), async () => 'other')).toBe('other')
  })
})
