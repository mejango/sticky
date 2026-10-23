'use client'

import {
  buildTransactionDebugPrompt as buildDebugPrompt,
  buildTransactionReviewPrompt as buildReviewPrompt,
  type ReviewModel,
  type TransactionReviewRequest,
} from '@bananapus/nana-sdk-core/review'
import { displayChainName, explorerOrigin } from '@/lib/chainDisplay'

export {
  fundingChainLabel,
  registerFundingChainSelectionHandler,
  requireFundingChainSelection,
  TransactionReviewCancelledError,
  transactionReviewJson,
  type FundingChainOption,
} from '@bananapus/nana-sdk-core/review'

/** One line of an action's summary (what moves where), shown above its decoded calls. TxConfirmRow's shape, as text. */
export type TransactionReviewRow = { label: string; value: string; mono?: boolean; strong?: boolean }

const display = { chainName: displayChainName, explorerOrigin }

export function buildTransactionDebugPrompt(
  calls: { chainId: number; txHash: string }[],
): string {
  return buildDebugPrompt(calls, display)
}

export function buildTransactionReviewPrompt(
  request: TransactionReviewRequest | ReviewModel,
): string {
  return buildReviewPrompt(request, display)
}
