import type { ReactNode } from 'react'
import { HELD_CONFIRMING_LINE } from '@bananapus/nana-sdk-core/review'
import { txPhaseLabel, type ReviewedActionState, type TxPhase } from '@/hooks/useReviewedAction'
import { explorerTxUrl } from '@/lib/chainDisplay'

/** A flow's confirm button, from the engine's phase: what the engine is doing while it sends a step (the check before
 * the wallet is asked, the wallet's own prompt, the wait for the chain), and the button's own `idle` label otherwise. */
export function confirmAction(phase: TxPhase, idle: string): string {
  return txPhaseLabel(phase, { idle, pending: 'Confirming…' })
}

/** The line a flow's confirm shows while the engine sends a step, from the engine's phase: the check before the wallet
 * is asked, the wallet's own prompt, then the wait for the chain, or a Safe's guidance while it waits on a proposal.
 * Null while nothing is being sent. */
export function sendingStatus({ phase, safeNonceGuidance, notice, held, holdNotice }: { phase: TxPhase; safeNonceGuidance?: string | null; notice?: string | null; held?: ReviewedActionState['held']; holdNotice?: string | null }): ReactNode {
  const withNotice = (line: ReactNode): ReactNode => (holdNotice && !held?.notice && line ? <>{line}<span className="mt-1 block">{holdNotice}</span></> : line)
  return withNotice(sendingLine({ phase, safeNonceGuidance, notice, held }))
}

function sendingLine({ phase, safeNonceGuidance, notice, held }: { phase: TxPhase; safeNonceGuidance?: string | null; notice?: string | null; held?: ReviewedActionState['held'] }): ReactNode {
  if (held) {
    // A held write ends only on proof or when the person says they checked their wallet.
    return (
      <>
        <span className="block">{held.warning ? `${held.line} ${held.warning}` : held.line}</span>
        {held.notice ? <span className="mt-1 block">{held.notice}</span> : null}
        {held.exit ? <button type="button" className="btn-secondary mt-2 min-h-[44px] px-4 text-sm" onClick={held.exit}>{held.label}</button> : null}
      </>
    )
  }
  if (phase === 'submitted') return notice ?? null
  // The SDK's confirming line, as every client shows it.
  const label = txPhaseLabel(phase, { idle: '', pending: HELD_CONFIRMING_LINE })
  return label ? (safeNonceGuidance ?? label) : null
}

/** Where a flow's confirm stands: its plan being read, ready to send, sending, held by a Safe or the hold, or done. */
export type TxStage = 'preparing' | 'ready' | 'busy' | 'settled' | 'complete'

/** A flow's confirm stage, from what it knows: done once every step confirmed, held when the engine's phase says a Safe
 * or the hold has it, sending while its run (or its own work) is busy, reading while its plan is not ready, and
 * otherwise ready. */
export function txStage({ preparing = false, busy, complete = false, phase }: { preparing?: boolean; busy: boolean; complete?: boolean; phase: TxPhase }): TxStage {
  if (complete) return 'complete'
  if (phase === 'submitted') return 'settled'
  if (busy) return 'busy'
  return preparing ? 'preparing' : 'ready'
}

/** "1 transaction left", "3 transactions left": what a flow has still to send, in Sticky's words. */
export function transactionsLeft(count: number): string {
  return `${count} transaction${count === 1 ? '' : 's'} left`
}

/** A flow's `stepsIntro` for TxConfirmDialog: what is left of `total` once `done` have confirmed. */
export function stepsIntro(total: number, done: number): string {
  return done >= total ? 'All transactions confirmed.' : `${transactionsLeft(total - done)}.`
}

/**
 * A confirmed transaction on its chain's explorer: the `status` of a completed TxConfirmDialog, which stays open with
 * it until the person presses Done. Nothing without a hash or an explorer.
 */
export function ViewTransactionLink({ chainId, hash }: { chainId: number; hash: string | null | undefined }) {
  const url = hash ? explorerTxUrl(chainId, hash) : null
  if (!url) return null
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
      View transaction ↗
    </a>
  )
}
