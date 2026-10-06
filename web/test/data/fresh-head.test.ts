import { numberToHex } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The head is read through the real Center reader with only `fetch` faked. The heads under way and Center's slots are
// the modules', so each test loads its own copy.

const CHAIN = 8453

/** Center, whose head the test moves: the signal of every request it is sent, and the answers it holds while told to. */
function center(start: bigint) {
  let head = start
  const sent: AbortSignal[] = []
  const held: (() => void)[] = []
  const node = { sent, held, holding: false, land: () => (head += 1n) }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string, init: RequestInit) => {
      const { id, method } = JSON.parse(String(init.body)) as { id: number; method: string }
      if (method !== 'eth_blockNumber') throw new Error(`Unexpected ${method}`)
      sent.push(init.signal!)
      if (node.holding) {
        await new Promise<void>((resolve, reject) => {
          held.push(resolve)
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
        })
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: numberToHex(head) }), {
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return node
}

const load = async () => {
  const [{ freshHead }, { jbCenterPublicClient }] = await Promise.all([import('@/lib/hook-logs'), import('@/lib/jbcenter-rpc')])
  return { freshHead, jbCenterPublicClient }
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('freshHead', () => {
  it('asks the chain again where viem would hand back the head it read a moment ago', async () => {
    const node = center(100n)
    const { freshHead, jbCenterPublicClient } = await load()
    await expect(jbCenterPublicClient(CHAIN).getBlockNumber()).resolves.toBe(100n)

    // A write lands in the next block. viem keeps the head it read for a few seconds.
    node.land()
    await expect(jbCenterPublicClient(CHAIN).getBlockNumber()).resolves.toBe(100n)
    expect(node.sent).toHaveLength(1)

    // A read made after the write pins a head the write is in.
    await expect(freshHead(CHAIN, undefined)).resolves.toBe(101n)
    expect(node.sent).toHaveLength(2)
  })

  it('shares a head request already under way with every read that asks for the chain\'s head meanwhile', async () => {
    const node = center(7n)
    const { freshHead } = await load()
    const pages = [new AbortController(), new AbortController()]
    await expect(Promise.all(pages.map(page => freshHead(CHAIN, page.signal)))).resolves.toEqual([7n, 7n])
    expect(node.sent).toHaveLength(1)
  })

  it('stops waiting when the read is cancelled, and asks nothing', async () => {
    const node = center(7n)
    const { freshHead } = await load()
    const cancel = new AbortController()
    cancel.abort(new Error('navigated away'))
    await expect(freshHead(CHAIN, cancel.signal)).rejects.toThrow('navigated away')
    expect(node.sent).toEqual([])
  })

  it('stops the request once every read waiting on it has left, not while one still waits, and asks anew after', async () => {
    const node = center(7n)
    node.holding = true
    const { freshHead } = await load()
    const [first, second] = [new AbortController(), new AbortController()]
    const reads = [freshHead(CHAIN, first.signal), freshHead(CHAIN, second.signal)].map(read =>
      read.catch((error: unknown) => error),
    )
    await vi.waitFor(() => expect(node.sent).toHaveLength(1))

    first.abort(new Error('left the page'))
    await Promise.resolve()
    expect(node.sent[0].aborted).toBe(false)
    second.abort(new Error('left the next page too'))
    expect(node.sent[0].aborted).toBe(true)
    expect(await Promise.all(reads)).toEqual([first.signal.reason, second.signal.reason])

    // A read that asks once the head it would have shared has stopped asks for its own.
    node.holding = false
    await expect(freshHead(CHAIN, new AbortController().signal)).resolves.toBe(7n)
    expect(node.sent).toHaveLength(2)
  })
})
