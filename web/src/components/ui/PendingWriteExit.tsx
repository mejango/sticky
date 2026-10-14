import { useState } from 'react'
import { writeExitMessage, writeHeldMessage, WRITE_EXIT_LABEL } from '@bananapus/nana-sdk-core/review'
import type { PendingBridgeWrite } from '@/lib/sticky-bridge-journal'

/**
 * A domain journal's reservation that the wallet never answered, left by a reload: the SDK's line and its
 * exit. `exit` asks the SDK to release the call and reports whether the reservation may be cleared.
 */
export function PendingWriteExit({ pending, disabled, exit }: { pending: PendingBridgeWrite; disabled: boolean; exit: () => Promise<void> }) {
  const [working, setWorking] = useState(false)
  if (pending.hash || pending.safeProposal) return null
  return (
    <>
      <p className="text-sm text-muted">{writeHeldMessage()} {writeExitMessage({ value: pending.request.value })}</p>
      <button className="btn-link" disabled={disabled || working} onClick={() => { setWorking(true); void exit().finally(() => setWorking(false)) }}>{WRITE_EXIT_LABEL}</button>
    </>
  )
}
