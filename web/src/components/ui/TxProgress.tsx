import { explorerTxUrl } from '@/lib/chainDisplay'

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
