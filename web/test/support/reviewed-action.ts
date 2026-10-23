import { vi } from 'vitest'
import type { Hex } from 'viem'
import type { ReviewedCall, ReviewedResult } from '@bananapus/nana-sdk-core/review'
import type { ReviewedRun } from '@/hooks/useReviewedAction'
import { TransactionReviewCancelledError } from '@/lib/transaction-review'

/** The block step `index` of a fake run confirmed in: each step one block after the one before. */
export const confirmedBlock = (index: number) => 100n + BigInt(index)

/**
 * useReviewedAction as a flow sees it, for flow tests that mock the engine: an idle state a test may change before a
 * render, and a `run` that plays core's order for each step. `review` is the run's one review (reject it with
 * TransactionReviewCancelledError to close it); then, step by step, `reverify` (at the block the step before confirmed
 * in), `beforeWallet` (unsent if it throws), `send` (the wallet: only a 4001 rejection is unsent, and a cancel) and
 * `onSubmitted`, then the wait for the step to be `mined`. Anything that throws ends the run with nothing returned, as
 * a failure the state shows. Otherwise the state is the test's to set. `checks: false` leaves `reverify` to the test,
 * for a world whose reads do not move as the steps confirm; `finish: true` shows a finished run as the hook does, a
 * success.
 */
export function reviewedActionFake(hash: Hex = `0x${'c3'.repeat(32)}`, { checks = true, finish = false } = {}) {
  const fake = {
    phase: 'idle' as string,
    busy: false,
    settled: false,
    notice: null as string | null,
    held: null as null | { line: string; warning: string; label: string; notice?: string; exit: (() => void) | null },
    holdNotice: null as string | null,
    isSafe: false,
    error: null as string | null,
    failure: null as unknown,
    reverted: false,
    landed: 0,
    hash: null as string | null,
    safeProposalHash: null as string | null,
    submissionHash: null as string | null,
    submissionIsSafe: false,
    safeNonceGuidance: null as string | null,
    review: vi.fn(async (_action: ReviewedRun): Promise<void> => {}),
    send: vi.fn(async (_call: ReviewedCall, _step: number): Promise<Hex> => hash),
    /** The wait for a sent step's receipt, before the next step: at once, unless a test holds it. */
    mined: vi.fn(async (_call: ReviewedCall, _step: number): Promise<void> => {}),
    run: vi.fn(async (action: ReviewedRun): Promise<ReviewedResult | null> => {
      /** The run failed: the hook shows why, unless the test already set what it shows. */
      const failed = (error: unknown) => {
        if (fake.phase !== 'error') Object.assign(fake, { phase: 'error', busy: false, error: (error as Error).message, failure: error })
        return null
      }
      try {
        await fake.review(action)
      } catch (error) {
        if (error instanceof TransactionReviewCancelledError) {
          action.onCancelled?.()
          return null
        }
        return failed(error)
      }
      const hashes: Hex[] = []
      for (const [step, call] of action.calls.entries()) {
        try {
          if (checks) await action.reverify?.(call, step, step ? confirmedBlock(step - 1) : undefined)
        } catch (error) {
          return failed(error)
        }
        try {
          await action.beforeWallet?.(call, step)
        } catch (error) {
          await action.onUnsent?.(call, step)
          return failed(error)
        }
        try {
          hashes[step] = await fake.send(call, step)
        } catch (error) {
          // Only the wallet's refusal frees the step; any other answer leaves it held, as it may have been sent.
          if ((error as { code?: number }).code !== 4001) return failed(error)
          await action.onUnsent?.(call, step)
          action.onCancelled?.()
          return null
        }
        try {
          await action.onSubmitted?.(call, step, hashes[step], { safe: fake.isSafe, adopted: false })
        } catch (error) {
          // Sent, and its record could not be kept: the run fails with the step held.
          return failed(error)
        }
        try {
          await fake.mined(call, step)
        } catch (error) {
          return failed(error)
        }
      }
      if (finish) Object.assign(fake, { phase: 'success', busy: false, landed: action.calls.length, hash: hashes.at(-1) ?? null })
      return { status: 'done' as const, hashes, receipts: [], signatures: [] }
    }),
    reset: vi.fn(),
    dismiss: vi.fn(),
  }
  return fake
}

export type ReviewedActionFake = ReturnType<typeof reviewedActionFake>
