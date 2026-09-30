import { createPublicClient, custom, numberToHex } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { freshHead } from '@/lib/hook-logs'

/** A node whose head the test moves, counting the times it is asked for it. */
function node(start: bigint) {
  let head = start
  const asked = vi.fn(async ({ method }: { method: string }) => {
    if (method !== 'eth_blockNumber') throw new Error(`Unexpected ${method}`)
    return numberToHex(head)
  })
  return { client: createPublicClient({ transport: custom({ request: asked }) }), asked, land: () => (head += 1n) }
}

describe('freshHead', () => {
  it('asks the chain again where viem would hand back the head it read a moment ago', async () => {
    const { client, asked, land } = node(100n)
    await expect(client.getBlockNumber()).resolves.toBe(100n)

    // A write lands in the next block. viem keeps the head it read for a few seconds.
    land()
    await expect(client.getBlockNumber()).resolves.toBe(100n)
    expect(asked).toHaveBeenCalledOnce()

    // A read made after the write pins a head the write is in.
    await expect(freshHead(client, undefined)).resolves.toBe(101n)
    expect(asked).toHaveBeenCalledTimes(2)
  })

  it('shares a head request already under way', async () => {
    const { client, asked } = node(7n)
    await expect(Promise.all([freshHead(client, undefined), freshHead(client, undefined)])).resolves.toEqual([7n, 7n])
    expect(asked).toHaveBeenCalledOnce()
  })

  it('stops waiting when the read is cancelled', async () => {
    const { client } = node(7n)
    const cancel = new AbortController()
    cancel.abort(new Error('navigated away'))
    await expect(freshHead(client, cancel.signal)).rejects.toThrow('navigated away')
  })
})
