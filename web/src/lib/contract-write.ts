import { submitReviewedContractWrite as submitReviewed } from '@bananapus/nana-sdk-core/review'
import type { Address } from 'viem'
import { assertNoViewAs } from '@/lib/viewAs'

export const REVIEWED_ACCOUNT_CHANGED = 'The connected account changed. Review again.'

/**
 * A request is built for the account that reviewed it (its beneficiary,
 * holder or recipient), so no other connected account may send it.
 */
export function assertReviewedAccountConnected(
  reviewed: Address,
  connected: Address | undefined,
  message = REVIEWED_ACCOUNT_CHANGED,
): void {
  if (connected?.toLowerCase() !== reviewed.toLowerCase()) throw new Error(message)
}

/**
 * The SDK's reviewed write, refused while the site is viewing as another
 * account, and before its review opens when the connected account is not
 * `expectedAccount`, the account the request was reviewed for. The SDK itself
 * checks that account only after the review.
 */
export const submitReviewedContractWrite: typeof submitReviewed = options => {
  const accountChangedError = options.accountChangedError ?? REVIEWED_ACCOUNT_CHANGED
  return submitReviewed({
    ...options,
    accountChangedError,
    guard: () => {
      assertNoViewAs()
      if (options.expectedAccount) {
        assertReviewedAccountConnected(options.expectedAccount, options.currentAccount(), accountChangedError)
      }
    },
  })
}
