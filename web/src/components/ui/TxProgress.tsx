import { txPhaseLabel, type TxPhase } from '@/hooks/useSafeTx'
import { explorerTxUrl } from '@/lib/chainDisplay'

/** A flow's confirm button, from the engine's phase: what the engine is doing while it sends a step (the check before
 * the wallet is asked, the wallet's own prompt, the wait for the chain), and the button's own `idle` label otherwise. */
export function confirmAction(phase: TxPhase, idle: string): string {
  return txPhaseLabel(phase, { idle, pending: 'Confirming…' })
}

/** The line a flow's confirm shows while the engine sends a step, from the engine's phase: the check before the wallet
 * is asked, the wallet's own prompt, then the wait for the chain, or a Safe's guidance while it waits on a proposal.
 * Null while nothing is being sent. */
export function sendingStatus({ phase, safeNonceGuidance }: { phase: TxPhase; safeNonceGuidance?: string | null }): string | null {
  const label = txPhaseLabel(phase, { idle: '', pending: 'Waiting for confirmation…' })
  return label ? (safeNonceGuidance ?? label) : null
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
