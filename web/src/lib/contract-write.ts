import { submitReviewedContractWrite as submitReviewed } from '@bananapus/nana-sdk-core/review'
import { assertNoViewAs } from '@/lib/viewAs'

export const REVIEWED_ACCOUNT_CHANGED = 'The connected account changed. Review again.'

/**
 * The SDK's reviewed write, refused while the site is viewing as another
 * account. A request is built for the account that reviewed it (its
 * beneficiary, holder or recipient), so the SDK refuses any other connected
 * account than `expectedAccount`, before the review opens and again after it,
 * in these words unless a flow names its own.
 */
export const submitReviewedContractWrite: typeof submitReviewed = options =>
  submitReviewed({
    ...options,
    accountChangedError: options.accountChangedError ?? REVIEWED_ACCOUNT_CHANGED,
    guard: assertNoViewAs,
  })
