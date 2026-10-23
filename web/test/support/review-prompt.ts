import { promptReviewForTests } from '@bananapus/nana-sdk-core/testing'
import { TransactionReviewCancelledError, type TransactionReviewRequest } from '@bananapus/nana-sdk-core/review'

/**
 * Prompts the page's review dialog with core's model of `request`, through core's own prompt. Resolves once
 * confirmed; a closed review rejects with TransactionReviewCancelledError, as a run's review does.
 */
export async function promptReview(request: TransactionReviewRequest): Promise<void> {
  if ((await promptReviewForTests(request).outcome) === 'cancelled') throw new TransactionReviewCancelledError()
}

/** promptReview as a decision: true once confirmed, false once closed. */
export const reviewDecision = (request: TransactionReviewRequest) =>
  promptReview(request).then(() => true, error => {
    if (error instanceof TransactionReviewCancelledError) return false
    throw error
  })
