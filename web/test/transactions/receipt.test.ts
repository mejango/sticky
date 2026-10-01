import type { Hex, PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { waitForTrackedReceipt } from '@/lib/receipt'

const HASH = `0x${'ab'.repeat(32)}` as Hex

describe('transaction receipt tracking', () => {
  it('falls back to a direct receipt read after the watcher rejects', async () => {
    const receipt = { status: 'success', blockNumber: 12n, transactionHash: HASH }
    const client = {
      chain: { id: 8453 },
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error('Invalid RPC parameters')),
      getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
    } as unknown as PublicClient

    await expect(waitForTrackedReceipt(client, HASH)).resolves.toBe(receipt)
  })

  it('retains the submitted hash when every receipt source is unavailable', async () => {
    const client = {
      chain: { id: 8453 },
      waitForTransactionReceipt: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error('RPC unavailable')),
    } as unknown as PublicClient

    await expect(
      waitForTrackedReceipt(client, HASH, { attempts: 1, intervalMs: 0 }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'TransactionReceiptUnavailableError',
        hash: HASH,
        chainId: 8453,
      }),
    )
  })
})
