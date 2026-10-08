'use client'

import { useQueryClient } from '@tanstack/react-query'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { isHash, type Hex } from 'viem'
import { ModalShell } from '@/components/ui/ModalShell'
import { ProjectLink } from '@/components/ProjectLink'
import { displayChainName, explorerTxUrl } from '@/lib/chainDisplay'
import type { ChainEnvironment } from '@/lib/chains'
import { STICKY_LAUNCH_EVENT, takeStickyLaunchRequest } from '@/lib/sticky-launch-events'
import type { LaunchPlan } from '@/lib/sticky-launch-plan'
import { STICKY_LAUNCH_KEY, launchCanClear, launchComplete, type StickyLaunchSession } from '@/lib/sticky-launch-session'

const CreateForm = dynamic(() => import('./StickyCreateForm').then(module => module.StickyCreateForm), { loading: () => <p role="status">Loading create form…</p> })
type Controller = ReturnType<typeof import('@/lib/sticky-launch-adapter').createBrowserStickyLaunchController>
const message = (error: unknown) => error instanceof Error ? error.message : 'Could not finish this step. Your saved launch is kept for recovery.'

/** The saved launch lives above routes. Closing a dialog never discards its publication or wallet evidence. */
export function StickyLaunchHost() {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [environment, setEnvironment] = useState<ChainEnvironment>('production')
  const [session, setSession] = useState<StickyLaunchSession | null>(null)
  const [error, setError] = useState('')
  const [corrupt, setCorrupt] = useState(false)
  const [restoring, setRestoring] = useState(true)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState('')
  const [hash, setHash] = useState('')
  const [hashChain, setHashChain] = useState<number | null>(null)
  const controller = useRef<Promise<Controller> | null>(null)
  const lastResults = useRef('')
  const acting = useRef(false)

  const changed = useCallback((next: StickyLaunchSession | null) => {
    setSession(next)
    const results = JSON.stringify(next?.results ?? {})
    if (results !== lastResults.current) {
      lastResults.current = results
      void import('@/hooks/useStickyHome').then(module => module.refreshStickyHome(queryClient))
    }
  }, [queryClient])
  const getController = useCallback(() => {
    if (!controller.current) controller.current = import('@/lib/sticky-launch-adapter').then(module =>
      module.createBrowserStickyLaunchController({ changed, phase: setPhase }))
    return controller.current
  }, [changed])
  const restore = useCallback(async () => {
    setRestoring(true)
    try {
      const current = (await getController()).load()
      changed(current ? { ...current, results: {} } : null); setCorrupt(false); setError('')
    } catch (failure) { setError(message(failure)); setCorrupt(true) }
    finally { setRestoring(false) }
  }, [changed, getController])

  useEffect(() => {
    try {
      if (localStorage.getItem(STICKY_LAUNCH_KEY) !== null) void restore()
      else setRestoring(false)
    } catch (failure) { setError(message(failure)); setCorrupt(true); setRestoring(false) }
    const show = (event: Event) => {
      const detail: unknown = takeStickyLaunchRequest() ?? (event as CustomEvent).detail
      setEnvironment(detail === 'testnet' ? 'testnet' : 'production')
      setOpen(true)
    }
    const storage = (event: StorageEvent) => { if (event.key === STICKY_LAUNCH_KEY || event.key === null) void restore() }
    window.addEventListener(STICKY_LAUNCH_EVENT, show)
    window.addEventListener('storage', storage)
    const pending = takeStickyLaunchRequest()
    if (pending) { setEnvironment(pending); setOpen(true) }
    return () => { window.removeEventListener(STICKY_LAUNCH_EVENT, show); window.removeEventListener('storage', storage) }
  }, [restore])

  const action = useCallback(async (run: (controller: Controller) => Promise<unknown>, quiet = false) => {
    if (acting.current) return
    acting.current = true
    if (!quiet) { setBusy(true); setError('') }
    try { await run(await getController()) }
    catch (failure) { if (!quiet) setError(message(failure)) }
    finally { acting.current = false; if (!quiet) { setBusy(false); setPhase('') } }
  }, [getController])

  const savedLaunchId = session?.plan.id
  useEffect(() => {
    if (!savedLaunchId || corrupt || restoring) return
    const check = () => { if (!document.hidden) void action(current => current.refresh(), true) }
    check()
    const interval = window.setInterval(check, 12_000)
    document.addEventListener('visibilitychange', check)
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', check) }
  }, [savedLaunchId, corrupt, restoring, action])

  const prepare = async (plan: LaunchPlan, capability: 'sponsored' | 'self-paid' | 'unavailable') => {
    const current = await getController()
    await current.prepare(plan, capability)
  }
  const complete = session ? launchComplete(session) : false
  const chainId = hashChain ?? session?.plan.targets[0].chainId
  return <>
    {session || corrupt ? <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card px-4 py-3 text-center shadow-lg">
      <button type="button" className="btn-link font-semibold" onClick={() => setOpen(true)}>
        {session ? `${session.plan.symbol}: ${Object.keys(session.results).length} of ${session.plan.targets.length} chains confirmed. ${complete ? 'View launch' : 'Resume launch'}` : 'Saved launch needs recovery'}
      </button>
    </div> : null}
    {open ? <ModalShell title={session ? `${session.plan.symbol} launch` : 'Make your token sticky'} onClose={() => setOpen(false)} busy={busy}>
      <div className="space-y-4">
        {error ? <p role="alert" className="break-words text-sm text-err">{error}</p> : null}
        {busy ? <p role="status" className="text-sm text-muted">{phase || 'Preparing launch…'}</p> : null}
        {restoring ? <p role="status">Restoring saved launch…</p>
          : corrupt ? <p className="text-sm">Keep this browser’s recovery data. A new launch is blocked until the saved record can be recovered.</p>
          : session ? <>
            <p className="text-sm text-muted">{session.plan.name} backs {session.plan.symbol} with {session.plan.tokenSymbol}. This launch is saved in this browser.</p>
            <p className="break-all text-xs text-muted">Wallet: {session.plan.owner}</p>
            <ul className="space-y-3">{session.plan.targets.map(target => {
              const result = session.results[target.chainId]
              const href = result && explorerTxUrl(target.chainId, result.hash)
              return <li key={target.chainId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3 text-sm">
                <span>{displayChainName(target.chainId)}</span>
                {result ? <span className="flex gap-3"><ProjectLink className="btn-link" chainId={target.chainId} projectId={BigInt(result.projectId)} onClick={() => setOpen(false)}>Open Sticky token</ProjectLink>{href ? <a className="btn-link" href={href} target="_blank" rel="noopener noreferrer">Transaction</a> : null}</span>
                  : <span className="text-muted">{session.direct?.started || session.payment?.started || session.published || session.listing.requested ? 'Waiting for verified deployment' : 'Ready for review'}</span>}
              </li>
            })}</ul>
            {session.error || session.listing.error ? <p className="break-words text-sm text-err">{session.error || session.listing.error}</p> : null}
            <div className="flex flex-wrap gap-3">
              <button type="button" className="btn-secondary px-3 py-2" disabled={busy} onClick={() => void action(current => current.refresh())}>Check again</button>
              {!complete && (session.direct?.started || session.payment?.started) ? <button type="button" className="btn-secondary px-3 py-2" disabled={busy} onClick={() => void action(current => current.retry())}>Check failed transaction for retry</button> : null}
              {!complete && !session.direct?.started && !session.payment?.started && (!session.listing.requested || session.listing.selfPaid) ?
                <button type="button" className="btn-primary px-3 py-2" disabled={busy} onClick={() => void action(current => current.run())}>{session.mode === 'center' ? 'Request sponsored launch' : 'Continue launch'}</button> : null}
              {!complete && session.mode === 'center' && !session.listing.requested ? <button type="button" className="btn-secondary px-3 py-2" disabled={busy} onClick={() => void action(async current => { await current.selfPay(); await current.run() })}>Pay for launch myself</button> : null}
              {!session.listing.intentId && session.listing.state !== 'unavailable' ? <button type="button" className="btn-secondary px-3 py-2" disabled={busy} onClick={() => void action(current => current.list())}>List on Juicebox Center</button> : null}
              {launchCanClear(session) ? <button type="button" className="btn-secondary px-3 py-2" disabled={busy} onClick={() => void action(async current => { await current.clear(); setOpen(false) })}>{complete ? 'Finish' : session.directAttempts?.length ? 'Discard failed launch' : 'Discard unsubmitted launch'}</button> : null}
            </div>
            {!complete ? <details className="text-sm"><summary className="cursor-pointer font-medium">Recover with a transaction hash</summary>
              <p className="my-2 text-muted">Use the mined deployment transaction. It will be checked against this saved launch before it counts as confirmed.</p>
              <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); if (chainId && isHash(hash)) void action(current => current.addHash(chainId, hash as Hex)) }}>
                <select aria-label="Recovery chain" className="rounded border border-line bg-card p-2" value={chainId} disabled={busy} onChange={event => setHashChain(Number(event.target.value))}>{session.plan.targets.map(target => <option key={target.chainId} value={target.chainId}>{displayChainName(target.chainId)}</option>)}</select>
                <input aria-label="Deployment transaction hash" className="min-w-0 flex-1 rounded border border-line bg-card p-2" value={hash} onChange={event => setHash(event.target.value)} placeholder="0x…" disabled={busy} />
                <button className="btn-secondary px-3 py-2" disabled={busy || !isHash(hash)}>Check transaction</button>
              </form>
            </details> : null}
          </> : <CreateForm environment={environment} busy={busy} prepare={prepare} working={value => { setBusy(value); if (value) setError('') }} failed={failure => setError(message(failure))} />}
      </div>
    </ModalShell> : null}
  </>
}
