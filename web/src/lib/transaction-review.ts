'use client'

import {
  buildTransactionDebugPrompt as buildDebugPrompt,
  buildTransactionReviewPrompt as buildReviewPrompt,
  type TransactionReviewRequest,
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
  type TransactionReviewRequest,
} from '@bananapus/nana-sdk-core/review'

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
