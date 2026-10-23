'use client'

import {
  buildTransactionDebugPrompt as buildDebugPrompt,
  buildTransactionReviewPrompt as buildReviewPrompt,
  type TransactionReviewRequest as SdkTransactionReviewRequest,
} from '@bananapus/nana-sdk-core/review'
import { displayChainName, explorerOrigin } from '@/lib/chainDisplay'

export {
  fundingChainLabel,
  registerFundingChainSelectionHandler,
  registerTransactionReviewHandler,
  requestContractTransactionReview,
  requireContractTransactionReview,
  requireFundingChainSelection,
  requireTransactionReview,
  TransactionReviewCancelledError,
  transactionReviewJson,
  type ContractTransactionReviewCall,
  type FundingChainOption,
  type TransactionReviewCall,
  type TransactionReviewOptions,
} from '@bananapus/nana-sdk-core/review'

/** One line of an action's summary (what moves where), shown above its decoded calls. TxConfirmRow's shape, as text. */
export type TransactionReviewRow = { label: string; value: string; mono?: boolean; strong?: boolean }

/** The SDK's review request, with the action's summary rows. */
export type TransactionReviewRequest = SdkTransactionReviewRequest & { rows?: readonly TransactionReviewRow[] }

const display = { chainName: displayChainName, explorerOrigin }

export function buildTransactionDebugPrompt(
  calls: { chainId: number; txHash: string }[],
): string {
  return buildDebugPrompt(calls, display)
}

export function buildTransactionReviewPrompt(
  request: TransactionReviewRequest,
): string {
  return buildReviewPrompt(request, display)
}
