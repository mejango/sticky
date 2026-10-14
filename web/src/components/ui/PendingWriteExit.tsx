import { useEffect, useRef, useState } from 'react'
import { writeExitMessage, writeHeldMessage, WRITE_EXIT_LABEL } from '@bananapus/nana-sdk-core/review'
import type { StoredHold } from '@/hooks/useSafeTx'
import type { PendingBridgeWrite } from '@/lib/sticky-bridge-journal'

type Look = StoredHold

/**
 * A domain journal's reservation left by a reload or a closed review: the SDK's line for its call and its exit,
 * hashed or not. The exit shows only when the SDK offers one (a hash the chain still knows has none); `exit`
 * asks the SDK to release the call and clears the reservation only after it does.
 */
export function PendingWriteExit({ pending, disabled, look, settle, exit }: {
  pending: PendingBridgeWrite
  disabled: boolean
  look?: (write: { chainId: number; owner: PendingBridgeWrite['owner']; to: PendingBridgeWrite['request']['address']; data: PendingBridgeWrite['request']['data']; value: string; intent?: string }) => Promise<Look>
  /** The SDK settled the write on authenticated evidence: record it, never abandon. */
  settle?: (settlement: { hash: `0x${string}`; result: 'success' | 'failed' }) => Promise<boolean>
  exit: () => Promise<void>
}) {
  const [working, setWorking] = useState(false)
  const [shown, setShown] = useState<Look>(null)
  // Each settlement is recorded once per attempt; the callback is read through a ref so a new closure never restarts the look.
  const settledOnce = useRef<string | null>(null)
  const settling = useRef(false)
  const settleRef = useRef(settle)
  settleRef.current = settle
  const { chainId, address, data, value } = pending.request
  useEffect(() => {
    if (!look) return
    let stopped = false
    const ask = () => { void look({ chainId, owner: pending.owner, to: address, data, value, intent: pending.intent }).then(next => {
      if (stopped) return
      if (next && 'settled' in next) {
        const mark = `${pending.id}:${next.settled.hash}`
        // Handled only once adopted: a skipped (flow busy) or failed recovery is tried again at the next look.
        if (settledOnce.current !== mark && !settling.current && settleRef.current) {
          settling.current = true
          void Promise.resolve(settleRef.current(next.settled)).then(adopted => { if (adopted) settledOnce.current = mark }).catch(() => undefined).finally(() => { settling.current = false })
        }
        setShown(null)
        return
      }
      setShown(next)
    }).catch(() => undefined) }
    ask()
    const timer = setInterval(ask, 15_000)
    return () => { stopped = true; clearInterval(timer) }
  }, [look, chainId, pending.owner, pending.id, pending.intent, address, data, value])
  // Without the SDK's look, only a write that never returned a hash has an exit.
  const line = look ? (shown && 'line' in shown ? shown.line : undefined) : (!pending.hash && !pending.safeProposal ? writeHeldMessage() : undefined)
  const exitOffered = look && shown && 'exit' in shown && shown.exit
  const warning = look ? (shown && 'warning' in shown ? shown.warning : undefined) ?? (exitOffered ? writeExitMessage({ value }) : undefined) : writeExitMessage({ value })
  const offered = look ? !!exitOffered : !pending.hash && !pending.safeProposal
  if (!line) return null
  return (
    <>
      <p className="text-sm text-muted">{offered && warning ? `${line} ${warning}` : line}</p>
      {offered ? <button className="btn-link" disabled={disabled || working} onClick={() => { setWorking(true); void exit().finally(() => setWorking(false)) }}>{WRITE_EXIT_LABEL}</button> : null}
    </>
  )
}
