import type { Address } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

// The write sequence itself is tested in @bananapus/nana-sdk-core/review.
const ALICE = '0x1111111111111111111111111111111111111111' as Address
const options = () => ({
  request: { chainId: 10 },
  expectedAccount: ALICE,
  review: vi.fn(async () => {}),
  switchChain: vi.fn(async () => {}),
  currentAccount: () => ALICE,
  simulate: vi.fn(async () => 'simulated'),
  write: vi.fn(async () => '0xhash' as const),
})

describe('Juicebox Money reviewed writes', () => {
  afterEach(() => clearViewAs())

  it('refuses before review while viewing as another account', async () => {
    setViewAs(ALICE)
    const write = options()
    await expect(submitReviewedContractWrite(write)).rejects.toThrow(VIEW_AS_WRITE_BLOCKED)
    expect(write.review).not.toHaveBeenCalled()
    expect(write.write).not.toHaveBeenCalled()
  })

  it('wallet-action:submit-a-reviewed-direct-write writes once after review otherwise', async () => {
    const write = options()
    await expect(submitReviewedContractWrite(write)).resolves.toBe('0xhash')
    expect(write.write).toHaveBeenCalledOnce()
  })
})
