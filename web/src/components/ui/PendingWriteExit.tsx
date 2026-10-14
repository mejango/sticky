import { useEffect, useState } from 'react'
import { writeExitMessage, writeHeldMessage, WRITE_EXIT_LABEL } from '@bananapus/nana-sdk-core/review'
import type { PendingBridgeWrite } from '@/lib/sticky-bridge-journal'

type Look = { exit: boolean; line: string; warning?: string } | null

/**
 * A domain journal's reservation left by a reload or a closed review: the SDK's line for its call and its exit,
 * hashed or not. The exit shows only when the SDK offers one (a hash the chain still knows has none); `exit`
 * asks the SDK to release the call and clears the reservation only after it does.
 */
export function PendingWriteExit({ pending, disabled, look, exit }: {
  pending: PendingBridgeWrite
  disabled: boolean
  look?: (write: { chainId: number; owner: PendingBridgeWrite['owner']; to: PendingBridgeWrite['request']['address']; data: PendingBridgeWrite['request']['data']; value: string }) => Promise<Look>
  exit: () => Promise<void>
}) {
  const [working, setWorking] = useState(false)
  const [shown, setShown] = useState<Look>(null)
  const { chainId, address, data, value } = pending.request
  useEffect(() => {
    if (!look) return
    let stopped = false
    const ask = () => { void look({ chainId, owner: pending.owner, to: address, data, value }).then(next => { if (!stopped) setShown(next) }).catch(() => undefined) }
    ask()
    const timer = setInterval(ask, 15_000)
    return () => { stopped = true; clearInterval(timer) }
  }, [look, chainId, pending.owner, address, data, value])
  // Without the SDK's look, only a write that never returned a hash has an exit.
  const line = look ? shown?.line : (!pending.hash && !pending.safeProposal ? writeHeldMessage() : undefined)
  const warning = look ? shown?.warning ?? (shown?.exit ? writeExitMessage({ value }) : undefined) : writeExitMessage({ value })
  const offered = look ? !!shown?.exit : !pending.hash && !pending.safeProposal
  if (!line) return null
  return (
    <>
      <p className="text-sm text-muted">{offered && warning ? `${line} ${warning}` : line}</p>
      {offered ? <button className="btn-link" disabled={disabled || working} onClick={() => { setWorking(true); void exit().finally(() => setWorking(false)) }}>{WRITE_EXIT_LABEL}</button> : null}
    </>
  )
}
