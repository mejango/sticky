import type { ReviewedAction, ReviewedSendDeps } from '@bananapus/nana-sdk-core/review'

/** Core stays lazy; its cleanup completes before the hook receives a readable local refusal. */
export const loadReviewEngine = async () => {
  const [engine, wallet] = await Promise.all([
    import('@bananapus/nana-sdk-core/review'),
    import('@/lib/wallet-core'),
  ])
  const readable = async <T,>(send: () => Promise<T>): Promise<T> => {
    try { return await send() } catch (error) { return wallet.readableWalletFailure(error) }
  }
  const guarded = (action: Pick<ReviewedAction, 'guard' | 'assertWriteState'>, deps: ReviewedSendDeps): ReviewedSendDeps =>
    deps.adapter === wallet.walletAdapter ? { ...deps, adapter: wallet.createWalletAdapter(() => {
      action.guard?.()
      action.assertWriteState?.()
    }) } : deps
  return {
    sendReviewed: (action: Parameters<typeof engine.sendReviewed>[0], deps: ReviewedSendDeps) =>
      readable(() => engine.sendReviewed(action, guarded(action, deps))),
    resumeReviewed: (record: Parameters<typeof engine.resumeReviewed>[0], action: Parameters<typeof engine.resumeReviewed>[1], deps: ReviewedSendDeps) =>
      readable(() => engine.resumeReviewed(record, action, guarded(action, deps))),
  }
}
