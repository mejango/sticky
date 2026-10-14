'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Hex } from 'viem'
import { getPublicClient } from '@wagmi/core'
import { useHeldWrite, useSavedAttempt } from '@bananapus/nana-sdk-core/review/react'
import { HELD_SUCCESS_LINE, intent, writeIntentKey, type SavedAttempt, type WriteHoldClient } from '@bananapus/nana-sdk-core/review'
import { readPendingBridgeWrite, type PendingBridgeWrite } from '@/lib/sticky-bridge-journal'
import { attempts, exitWarning, holds } from '@/lib/write-holds'
import { wagmiConfig } from '@/providers/Providers'

/**
 * The saved attempt a bridge or collector reservation stands for, from what its journal saved and nothing fresh. A
 * record saved before writes carried their intent is found by its own key: with no hold there, its saved hash is
 * adopted against the exact call, and a hashless one reaches the explicit check.
 */
export function pendingAttempt(pending: PendingBridgeWrite, authenticate: (hash: Hex) => Promise<boolean>): SavedAttempt<Hex> {
  const { request } = pending
  return {
    chainId: request.chainId,
    account: pending.owner,
    safe: !!pending.safeProposal,
    namespaces: [pending.intent ?? writeIntentKey('sticky-saved-write', { chain: request.chainId, owner: intent.address(pending.owner), to: intent.address(request.address), data: intent.hex(request.data) })],
    call: { to: request.address, data: request.data, value: BigInt(request.value) },
    saved: {
      started: true,
      ...(pending.hash ? (pending.safeProposal ? { safeTxHash: pending.hash } : { hash: pending.hash }) : {}),
      ...(pending.at ? { submittedAt: pending.at } : {}),
    },
    // Rule E's journal re-read: a success the journal saved is never retired by a check or an exit.
    confirmRetirable: async () => {
      const stored = readPendingBridgeWrite(pending.owner)
      return !(stored && stored.id === pending.id && stored.settled === 'success')
    },
    authenticate: async hash => (hash && (await authenticate(hash)) ? { result: 'proven', value: hash } : { result: 'unknown' }),
  }
}

/**
 * A journal's saved write, recovered by the SDK before anything else is offered: held (its line and exit), done (the
 * flow records it), or the one explicit check. An attempt the user's exit or check retired leaves the journal.
 */
export function SavedWriteRecovery({ pending, disabled, authenticate, record, end }: {
  pending: PendingBridgeWrite
  disabled: boolean
  /** The flow's domain check of one transaction: true when it is this write's success. */
  authenticate: (hash: Hex) => Promise<boolean>
  /** Record a settlement the SDK followed: the flow's own recovery runs on it. True once recorded. */
  record: (hash: Hex, result: 'success' | 'failed') => Promise<boolean>
  /** The attempt was retired by the user's exit or check: its journal reservation ends. */
  end: () => Promise<void>
}) {
  const chainId = pending.request.chainId
  const client = useMemo(() => getPublicClient(wagmiConfig, { chainId: chainId as never }) as unknown as WriteHoldClient | undefined, [chainId])
  const check = useRef(authenticate)
  check.current = authenticate
  const saved = JSON.stringify(pending)
  // The saved fields stand for the attempt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const attempt = useMemo(() => pendingAttempt(pending, hash => check.current(hash)), [saved])
  const recovery = useSavedAttempt({ recovery: attempts, attempt, client })
  const { outcome, recover, retire, checkAction, unreadableAction } = recovery
  const [working, setWorking] = useState(false)
  const run = (work: () => Promise<unknown>) => {
    setWorking(true)
    void work().catch(() => undefined).finally(() => setWorking(false))
  }
  const recorded = useRef<string | null>(null)
  const latest = useRef({ record, end, retire })
  latest.current = { record, end, retire }
  useEffect(() => {
    if (!outcome) return
    const mark = JSON.stringify(outcome)
    if (recorded.current === mark) return
    if (outcome.status === 'done' && outcome.hash) {
      const hash = outcome.hash
      recorded.current = mark
      void latest.current.record(hash, outcome.result)
        .then(done => (done ? latest.current.retire({ by: 'settled', hash }) : (recorded.current = null)))
        .catch(() => { recorded.current = null })
    } else if (outcome.status === 'none' && outcome.retired && outcome.retired !== 'settled') {
      recorded.current = mark
      void latest.current.end().catch(() => { recorded.current = null })
    }
  }, [outcome])
  // Asked again every 15 seconds while the answer can still change; a held write watches itself.
  const status = outcome?.status
  useEffect(() => {
    if (!status || status === 'held') return
    const timer = setInterval(() => void recover(), 15_000)
    return () => clearInterval(timer)
  }, [status, recover])

  if (!outcome) return null
  if (outcome.status === 'held') {
    return <HeldSavedWrite attempt={attempt} client={client} disabled={disabled}
      onSettled={() => void recover()}
      onReleased={by => run(async () => { if (by === 'user') await retire({ by: 'exit' }); else await recover() })} />
  }
  if (outcome.status === 'done' && outcome.result === 'success') {
    return (
      <>
        <p className="text-sm">{HELD_SUCCESS_LINE}</p>
        {!outcome.authenticated ? <button className="btn-link" disabled={disabled || working} onClick={() => run(recover)}>Check again</button> : null}
      </>
    )
  }
  if (!checkAction) return null
  return (
    <>
      <p className="text-sm text-muted">{`${checkAction.line} ${checkAction.warning}`}</p>
      <button className="btn-link" disabled={disabled || working} onClick={() => run(async () => { if ((await checkAction.run()).retired) await end() })}>{checkAction.label}</button>
      {unreadableAction ? <>
        <p className="text-sm text-muted">{unreadableAction.line}</p>
        <button className="btn-link" disabled={disabled || working} onClick={() => run(async () => { if ((await unreadableAction.run()).retired) await end() })}>{unreadableAction.label}</button>
      </> : null}
    </>
  )
}

/** The hold of a saved write: the SDK's line, its in-tab notice and its exit when due. */
function HeldSavedWrite({ attempt, client, disabled, onSettled, onReleased }: {
  attempt: SavedAttempt<Hex>
  client: WriteHoldClient | undefined
  disabled: boolean
  onSettled: () => void
  onReleased: (by: 'user' | 'other-tab') => void
}) {
  const [namespace, ...legacy] = attempt.namespaces
  const write = useHeldWrite({ hold: holds, chainId: attempt.chainId, account: attempt.account, safe: attempt.safe, namespace,
    ...(legacy.length ? { legacy } : {}), call: attempt.call, client, onSettled, onReleased })
  if (!write.line) return null
  const warning = exitWarning(write)
  return (
    <>
      <p className="text-sm text-muted">{warning ? `${write.line} ${warning}` : write.line}</p>
      {write.notice ? <p className="text-sm text-muted">{write.notice}</p> : null}
      {write.exitAction ? <button className="btn-link" disabled={disabled} onClick={() => void write.exitAction!.run().catch(() => undefined)}>{write.exitAction.label}</button> : null}
    </>
  )
}
