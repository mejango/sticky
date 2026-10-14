'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useHeldWrite, useSavedAttempt } from '@bananapus/nana-sdk-core/review/react'
import type { WriteHoldClient } from '@bananapus/nana-sdk-core/review'
import type { LaunchAttempt } from '@/lib/sticky-launch-adapter'
import type { StickyLaunchSession } from '@/lib/sticky-launch-session'
import { attempts, exitWarning, holds } from '@/lib/write-holds'

type Controller = ReturnType<typeof import('@/lib/sticky-launch-adapter').createBrowserStickyLaunchController>
type Act = (run: (controller: Controller) => Promise<unknown>, quiet?: boolean) => Promise<void>

/**
 * A saved launch's attempt, recovered by the SDK before anything else is offered: held (its line and exit), done (its
 * hash joins the journal and is followed), or the one explicit check action An attempt the user's exit
 * or check retired is recorded in the journal as exited, which reopens the launch.
 */
export function LaunchRecovery({ controller, session, generation, busy, act }: {
  controller: Controller
  session: StickyLaunchSession
  /** Bumped after each refresh of the journal: recovery is asked again. */
  generation: number
  busy: boolean
  act: Act
}) {
  const saved = JSON.stringify(session)
  // The saved journal stands for the attempt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const bundle = useMemo(() => controller.attempt(session), [controller, saved])
  const recovery = useSavedAttempt({ recovery: attempts, attempt: bundle?.attempt, client: bundle?.client, checkNext: 'Create again' })
  const { outcome, recover, retire, checkAction, unreadableAction } = recovery
  const latest = useRef({ act, retire, kind: bundle?.kind })
  latest.current = { act, retire, kind: bundle?.kind }

  const status = outcome?.status
  const first = useRef(generation)
  /** The outcome whose settlement or retirement was handed to the journal; asked again after each refresh. */
  const recorded = useRef<string | null>(null)
  useEffect(() => {
    if (first.current === generation || status === 'held') return
    first.current = generation
    recorded.current = null
    void recover()
  }, [generation, status, recover])

  useEffect(() => {
    const kind = latest.current.kind
    if (!outcome || !kind) return
    const mark = JSON.stringify(outcome)
    if (recorded.current === mark) return
    if (outcome.status === 'done') {
      recorded.current = mark
      const hash = outcome.hash
      // A followed settlement: its hash and result join the journal, which verifies the deployment, then it retires.
      void latest.current.act(async current => {
        if (hash && kind !== 'sponsor') await current.record(kind, { hash, result: outcome.result })
        await current.refresh()
        await latest.current.retire({ by: 'settled', ...(hash ? { hash } : {}) })
      }, true)
    } else if (outcome.status === 'none' && outcome.retired && outcome.retired !== 'settled') {
      recorded.current = mark
      void latest.current.act(current => current.exited(kind), true)
    }
  }, [outcome])

  if (!bundle || !outcome) return null
  if (outcome.status === 'held') {
    return <HeldLaunch bundle={bundle} busy={busy}
      onSettled={() => void recover()}
      // Never behind the host's busy flag: the SDK's retirement takes its own locks, and the journal follows on 'none'.
      onReleased={by => void (by === 'user' ? retire({ by: 'exit' }) : recover())} />
  }
  if (!checkAction) return null
  return (
    <div role="status" className="space-y-2 text-sm">
      <p>{checkAction.line}</p>
      <p className="text-muted">{checkAction.warning}</p>
      <button type="button" className="btn-secondary px-3 py-2" disabled={busy} onClick={() => void act(async current => { if ((await checkAction.run()).retired) await current.exited(bundle.kind) })}>{checkAction.label}</button>
      {unreadableAction ? <>
        <p>{unreadableAction.line}</p>
        <button type="button" className="btn-secondary px-3 py-2" disabled={busy} onClick={() => void act(async current => { if ((await unreadableAction.run()).retired) await current.exited(bundle.kind) })}>{unreadableAction.label}</button>
      </> : null}
    </div>
  )
}

/** The hold of a launch submission: the SDK's line, its warning and in-tab notice, and its exit when due. */
function HeldLaunch({ bundle, busy, onSettled, onReleased }: {
  bundle: LaunchAttempt
  busy: boolean
  onSettled: () => void
  onReleased: (by: 'user' | 'other-tab') => void
}) {
  const { attempt } = bundle
  const write = useHeldWrite({ hold: holds, chainId: attempt.chainId, account: attempt.account, safe: attempt.safe,
    namespace: attempt.namespaces[0], call: attempt.call, client: bundle.client as WriteHoldClient, onSettled, onReleased })
  if (!write.line) return null
  const warning = exitWarning(write)
  return (
    <div role="status" className="space-y-1 text-sm">
      <p>{write.line}</p>
      {warning ? <p className="text-muted">{warning}</p> : null}
      {write.notice ? <p className="text-muted">{write.notice}</p> : null}
      {write.exitAction ? <button type="button" className="btn-secondary px-3 py-2" disabled={busy} onClick={() => void write.exitAction!.run().catch(() => undefined)}>{write.exitAction.label}</button> : null}
    </div>
  )
}
