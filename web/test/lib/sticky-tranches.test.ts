import type { Address, PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readTranchePage, TRANCHES_PER_PAGE } from '@/lib/sticky-tranches'
import { CHAIN, HOLDER, HOOK } from './sticky-log-fixtures'

// readTranchePage reads Center through the client of the page's chain, which is a fake here that answers the hook's
// trancheCountOf and tranchesOf. OLD/test/actions.test.cjs has the two cases these port: a million dust entries, and a
// stale page.

const center = vi.hoisted(() => ({ client: vi.fn() }))
vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: center.client }))

type Read = { address: Address; functionName: string; args: readonly bigint[]; blockNumber?: bigint }

const PROJECT = 12n
const BLOCK = 0x55n
const dust = { amount: 1n, timestamp: 100 }

/** A hook that says the holder has `count` tranches, and answers a slice with `answer(start, length)`. */
function hookWith(count: bigint, answer: (start: bigint, length: bigint) => { amount: bigint; timestamp: number }[]) {
  const readContract = vi.fn(async ({ functionName, args }: Read) =>
    functionName === 'trancheCountOf' ? count : answer(args[2], args[3]),
  )
  center.client.mockReturnValue({ readContract } as unknown as PublicClient)
  return readContract
}

/** A slice of the right length whose tranche at each index has that index plus one for its amount. */
const numbered = (start: bigint, length: bigint) =>
  Array.from({ length: Number(length) }, (_, at) => ({ amount: start + BigInt(at) + 1n, timestamp: 100 + at }))

beforeEach(() => {
  center.client.mockReset()
})

describe('readTranchePage', () => {
  it('reads a bounded page under a million dust entries, and pins the count and the slice to one block', async () => {
    const readContract = hookWith(1_000_000n, (_start, length) => Array.from({ length: Number(length) }, () => dust))

    const page = await readTranchePage(CHAIN, PROJECT, HOLDER, 0, BLOCK)

    expect(page.tranches).toHaveLength(TRANCHES_PER_PAGE)
    expect(page).toMatchObject({ total: 1_000_000n, page: 0, start: 999_950n })
    // The count, then the newest 50, both at the block given, on the hook of the page's chain.
    expect(center.client).toHaveBeenCalledWith(CHAIN)
    expect(readContract).toHaveBeenCalledTimes(2)
    const [count, slice] = readContract.mock.calls.map(([read]) => read)
    expect([count.address, count.functionName, count.args, count.blockNumber]).toEqual([
      HOOK,
      'trancheCountOf',
      [PROJECT, HOLDER],
      BLOCK,
    ])
    expect([slice.address, slice.functionName, slice.args, slice.blockNumber]).toEqual([
      HOOK,
      'tranchesOf',
      [PROJECT, HOLDER, 999_950n, 50n],
      BLOCK,
    ])
  })

  it('pages from the newest tranches back: page 0 is the last 50, and the oldest page holds what is left', async () => {
    const readContract = hookWith(120n, numbered)
    const starts = async (requested: number) => {
      readContract.mockClear()
      const page = await readTranchePage(CHAIN, PROJECT, HOLDER, requested, BLOCK)
      const [, slice] = readContract.mock.calls.map(([read]) => read.args)
      return { start: page.start, length: page.tranches.length, page: page.page, asked: slice.slice(2) }
    }
    expect(await starts(0)).toEqual({ start: 70n, length: 50, page: 0, asked: [70n, 50n] })
    expect(await starts(1)).toEqual({ start: 20n, length: 50, page: 1, asked: [20n, 50n] })
    expect(await starts(2)).toEqual({ start: 0n, length: 20, page: 2, asked: [0n, 20n] })
  })

  it('gives the tranches oldest first as the hook keeps them, with their amounts and times', async () => {
    hookWith(3n, numbered)
    const { tranches } = await readTranchePage(CHAIN, PROJECT, HOLDER, 0, BLOCK)
    expect(tranches).toEqual([
      { amount: 1n, timestamp: 100 },
      { amount: 2n, timestamp: 101 },
      { amount: 3n, timestamp: 102 },
    ])
  })

  it('clamps a page that burns have made stale to the last one', async () => {
    const readContract = hookWith(1n, () => [{ amount: 2n, timestamp: 100 }])
    const page = await readTranchePage(CHAIN, PROJECT, HOLDER, 1_000_000, BLOCK)
    expect(page).toMatchObject({ page: 0, start: 0n, total: 1n })
    expect(page.tranches[0].amount).toBe(2n)
    expect(readContract.mock.calls[1][0].args).toEqual([PROJECT, HOLDER, 0n, 1n])

    hookWith(120n, numbered)
    expect(await readTranchePage(CHAIN, PROJECT, HOLDER, 9, BLOCK)).toMatchObject({ page: 2, start: 0n })
    // A page before the first is the first.
    expect(await readTranchePage(CHAIN, PROJECT, HOLDER, -3, BLOCK)).toMatchObject({ page: 0, start: 70n })
  })

  it('has no page for a holder with no tranches, and reads no slice', async () => {
    const readContract = hookWith(0n, numbered)
    expect(await readTranchePage(CHAIN, PROJECT, HOLDER, 0, BLOCK)).toEqual({ tranches: [], total: 0n, page: 0, start: 0n })
    expect(readContract).toHaveBeenCalledTimes(1)
  })

  it('rejects a truncated page rather than showing it', async () => {
    hookWith(2n, () => [{ amount: 2n, timestamp: 100 }])
    await expect(readTranchePage(CHAIN, PROJECT, HOLDER, 0, BLOCK)).rejects.toThrow('incomplete tranche page')
  })

  it('rejects when the chain cannot be read, for the caller to say so', async () => {
    const readContract = hookWith(5n, numbered)
    readContract.mockRejectedValue(new Error('429'))
    await expect(readTranchePage(CHAIN, PROJECT, HOLDER, 0, BLOCK)).rejects.toThrow('429')
  })

  it('rejects with the caller\'s reason when it cancels', async () => {
    const readContract = hookWith(5n, numbered)
    readContract.mockReturnValue(new Promise(() => {}))
    const controller = new AbortController()
    const read = readTranchePage(CHAIN, PROJECT, HOLDER, 0, BLOCK, { signal: controller.signal })
    controller.abort(new Error('left the page'))
    await expect(read).rejects.toThrow('left the page')
  })

  it('refuses a chain Sticky is not deployed on', async () => {
    await expect(readTranchePage(999, PROJECT, HOLDER, 0, BLOCK)).rejects.toThrow('Sticky is not deployed on chain 999.')
  })
})
