import { describe, expect, it } from 'vitest'
import { line } from '@/lib/line'

/** A task the test settles when it likes, and whether it has started. */
function task<T = string>() {
  const settle = Promise.withResolvers<T>()
  const made = { started: false, settle, run: () => ((made.started = true), settle.promise) }
  return made
}

const ticks = async (count = 5) => {
  for (let at = 0; at < count; at += 1) await Promise.resolve()
}

describe('a line', () => {
  it('runs as many tasks at once as it has room for, and starts the others in the order they joined as one ends', async () => {
    const two = line(2)
    const tasks = Array.from({ length: 5 }, () => task())
    const answers = tasks.map(each => two.join(each.run))
    await ticks()
    expect(tasks.map(each => each.started)).toEqual([true, true, false, false, false])

    tasks[1].settle.resolve('b')
    await ticks()
    expect(tasks.map(each => each.started)).toEqual([true, true, true, false, false])

    // A failure frees its place as an answer does, and goes to its own caller.
    tasks[0].settle.reject(new Error('rpc down'))
    await expect(answers[0]).rejects.toThrow('rpc down')
    await ticks()
    expect(tasks.map(each => each.started)).toEqual([true, true, true, true, false])

    tasks[2].settle.resolve('c')
    await ticks()
    expect(tasks[4].started).toBe(true)
    tasks[3].settle.resolve('d')
    tasks[4].settle.resolve('e')
    expect(await Promise.all(answers.slice(1))).toEqual(['b', 'c', 'd', 'e'])
  })

  it('gives a task that throws before it returns a promise the failure, and goes on', async () => {
    const one = line(1)
    const failure = new Error('bad arguments')
    const thrown = one.join(() => {
      throw failure
    })
    await expect(thrown).rejects.toBe(failure)
    expect(await one.join(async () => 'next')).toBe('next')
  })

  it('takes a task whose signal aborts while it waits out at once, rejecting with the reason, and never starts it', async () => {
    const one = line(1)
    const busy = task()
    void one.join(busy.run)
    const cancel = new AbortController()
    const reason = new Error('left the page')
    const left = task()
    const leaving = one.join(left.run, { signal: cancel.signal })
    const next = task()
    const after = one.join(next.run)

    cancel.abort(reason)
    await expect(leaving).rejects.toBe(reason)
    busy.settle.resolve('a')
    await ticks()
    expect(left.started).toBe(false)
    expect(next.started).toBe(true)
    next.settle.resolve('next')
    expect(await after).toBe('next')
  })

  it('never starts a task whose signal has already aborted', async () => {
    const one = line(1)
    const cancel = new AbortController()
    cancel.abort(new Error('gone'))
    const gone = task()
    await expect(one.join(gone.run, { signal: cancel.signal })).rejects.toThrow('gone')
    await ticks()
    expect(gone.started).toBe(false)
  })

  it('does not stop a task under way when its signal aborts: the task answers to its own signal', async () => {
    const one = line(1)
    const cancel = new AbortController()
    const running = task()
    const answer = one.join(running.run, { signal: cancel.signal })
    await ticks()
    cancel.abort(new Error('left the page'))
    running.settle.resolve('finished')
    expect(await answer).toBe('finished')
  })

  it('starts nothing while it is held, and what waits once it is resumed', async () => {
    let held = true
    const two = line(2, () => held)
    const tasks = [task(), task()]
    const answers = tasks.map(each => two.join(each.run))
    await ticks()
    expect(tasks.map(each => each.started)).toEqual([false, false])

    held = false
    two.resume()
    await ticks()
    expect(tasks.map(each => each.started)).toEqual([true, true])
    for (const each of tasks) each.settle.resolve('ok')
    expect(await Promise.all(answers)).toEqual(['ok', 'ok'])
  })
})
