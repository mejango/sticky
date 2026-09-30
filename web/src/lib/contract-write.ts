import { submitReviewedContractWrite as submitReviewed } from '@bananapus/nana-sdk-core/review'
import { assertNoViewAs } from '@/lib/viewAs'

/** The SDK's reviewed write, refused while the site is viewing as another account. */
export const submitReviewedContractWrite: typeof submitReviewed = options =>
  submitReviewed({ ...options, guard: assertNoViewAs })
