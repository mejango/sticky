import type { Address } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertReviewedAccountConnected,
  REVIEWED_ACCOUNT_CHANGED,
  submitReviewedContractWrite,
} from '@/lib/contract-write'
import { clearViewAs, setViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'

// The write sequence itself is tested in @bananapus/nana-sdk-core/review.
const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const CHECKSUMMED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' as Address
const options = () => ({
  request: { chainId: 10 },
  expectedAccount: ALICE as Address | undefined,
  review: vi.fn(async () => {}),
  switchChain: vi.fn(async () => {}),
  currentAccount: vi.fn((): Address | undefined => ALICE),
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

  it.each([
    ['another account', BOB],
    ['no account', undefined],
  ])('refuses before review while %s is connected', async (_, connected) => {
    const write = options()
    write.currentAccount.mockReturnValue(connected)
    await expect(submitReviewedContractWrite(write)).rejects.toThrow(REVIEWED_ACCOUNT_CHANGED)
    expect(write.review).not.toHaveBeenCalled()
    expect(write.switchChain).not.toHaveBeenCalled()
    expect(write.write).not.toHaveBeenCalled()
  })

  it("says a flow's own account-change message before and after its review", async () => {
    const message = 'Connected account changed. Review the launch again.'
    const before = options()
    before.currentAccount.mockReturnValue(BOB)
    await expect(
      submitReviewedContractWrite({ ...before, accountChangedError: message }),
    ).rejects.toThrow(message)

    const after = options()
    after.review.mockImplementation(async () => {
      after.currentAccount.mockReturnValue(BOB)
    })
    await expect(
      submitReviewedContractWrite({ ...after, accountChangedError: message }),
    ).rejects.toThrow(message)
    expect(after.simulate).not.toHaveBeenCalled()
  })

  it('says the plain account-change message once its review has closed', async () => {
    const write = options()
    write.review.mockImplementation(async () => {
      write.currentAccount.mockReturnValue(BOB)
    })
    await expect(submitReviewedContractWrite(write)).rejects.toThrow(REVIEWED_ACCOUNT_CHANGED)
    expect(write.simulate).not.toHaveBeenCalled()
    expect(write.write).not.toHaveBeenCalled()
  })

  it('leaves a missing reviewed account to the wallet check', async () => {
    const write = options()
    write.expectedAccount = undefined
    await expect(submitReviewedContractWrite(write)).rejects.toThrow('Connect a wallet first.')
    expect(write.review).not.toHaveBeenCalled()
  })
})

describe('the reviewed account', () => {
  it('matches the connected account in any letter case', () => {
    expect(() =>
      assertReviewedAccountConnected(CHECKSUMMED, CHECKSUMMED.toLowerCase() as Address),
    ).not.toThrow()
  })

  it('refuses another account, or none, plainly', () => {
    expect(() => assertReviewedAccountConnected(ALICE, BOB)).toThrow(
      'The connected account changed. Review again.',
    )
    expect(() => assertReviewedAccountConnected(ALICE, undefined)).toThrow(REVIEWED_ACCOUNT_CHANGED)
    expect(() => assertReviewedAccountConnected(ALICE, BOB, 'Review the batch again.')).toThrow(
      'Review the batch again.',
    )
  })
})
