'use client'

import {
  type ComponentType,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { Address } from 'viem'
import { registerReviewHandler, type ReviewModel, type ReviewSimulation } from '@bananapus/nana-sdk-core/review'
import { useAccount } from 'wagmi'
import { ModalDialog } from '@/components/ui/ModalShell'
import { loadReviewEngine } from '@/lib/review-engine'
import { useProjectReviewScope, type ProjectReviewScope } from '@/providers/ProjectRouteContext'
import { useProjectRouteBlocked } from '@/providers/ProjectRouteBlockedContext'
import {
  registerFundingChainSelectionHandler,
  type FundingChainOption,
} from '@/lib/transaction-review'

export type PendingReview = {
  kind: 'review'
  id: number
  resolve: (approved: boolean) => void
  scope?: ProjectReviewScope | null
  account?: Address
  /** Core's prompt: the model it bound, confirmed only by its own confirmation. */
  model: ReviewModel
  /** Core's review-time simulation, which runs while the review is open. */
  simulation?: Promise<ReviewSimulation>
}

export type PendingFundingChainSelection = {
  kind: 'funding'
  id: number
  options: readonly FundingChainOption[]
  initialChainId: number | null
  resolve: (chainId: number | null) => void
  scope?: ProjectReviewScope | null
  account?: Address
}

export type PendingDialog = PendingReview | PendingFundingChainSelection

export type TransactionReviewDialogProps = {
  pending: PendingDialog
  onFinish: (result: boolean | number | null) => void
  checkingProject?: boolean
}

function cancelPendingDialog(pending: PendingDialog) {
  if (pending.kind === 'review') pending.resolve(false)
  else pending.resolve(null)
}

let dialogLoad: Promise<typeof import('./TransactionReviewDialog')> | undefined
/** The dialog's one download, shared by its preload and the first review; a failed one is tried again next time. */
function loadDialog() {
  dialogLoad ??= import('./TransactionReviewDialog').catch(error => {
    dialogLoad = undefined
    throw error
  })
  return dialogLoad
}

/**
 * Global, promise-based modal queue. Every low-level transaction boundary
 * registers with this one provider, so simultaneous multichain flows review
 * sequentially and each approval applies to one immutable call snapshot.
 */
export function TransactionReviewProvider({ children }: PropsWithChildren) {
  const scope = useProjectReviewScope()
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const routeBlocked = useProjectRouteBlocked()
  const routeBlockedRef = useRef(routeBlocked)
  routeBlockedRef.current = routeBlocked
  const { address } = useAccount()
  const accountRef = useRef<Address | undefined>(address)
  accountRef.current = address
  const nextId = useRef(1)
  const activeRef = useRef<PendingDialog | null>(null)
  const queueRef = useRef<PendingDialog[]>([])
  const [active, setActive] = useState<PendingDialog | null>(null)
  const [checkingProject, setCheckingProject] = useState<number | null>(null)
  const [Dialog, setDialog] = useState<ComponentType<TransactionReviewDialogProps> | null>(null)

  const enqueueDialog = useCallback((pending: PendingDialog) => {
    // A delayed preparation must not become an unscoped approval while its
    // project is being replaced or could not be verified.
    if (routeBlockedRef.current) {
      cancelPendingDialog(pending)
      return
    }
    if (activeRef.current) {
      queueRef.current.push(pending)
      return
    }
    activeRef.current = pending
    setActive(pending)
  }, [])

  const enqueueFundingChainSelection = useCallback(
    (options: readonly FundingChainOption[], initialChainId: number | null) =>
      new Promise<number | null>(resolve => {
        enqueueDialog({
          kind: 'funding',
          id: nextId.current++,
          options: options.map(option => ({ ...option })),
          initialChainId,
          resolve,
          scope: scopeRef.current,
          account: accountRef.current,
        })
      }),
    [enqueueDialog],
  )

  // The review engine and its dialog load on the first intent (a press or a focus anywhere) or once the page is idle,
  // so the first review opens without a wait.
  useEffect(() => {
    let loaded = false
    const load = () => {
      if (loaded) return
      loaded = true
      void loadReviewEngine().catch(() => undefined)
      void loadDialog().catch(() => undefined)
    }
    const idle = window.requestIdleCallback?.(load) ?? window.setTimeout(load, 2_000)
    document.addEventListener('pointerdown', load, { capture: true, once: true })
    document.addEventListener('focusin', load, { capture: true, once: true })
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle)
      else window.clearTimeout(idle)
      document.removeEventListener('pointerdown', load, { capture: true })
      document.removeEventListener('focusin', load, { capture: true })
    }
  }, [])
  useEffect(
    () => registerFundingChainSelectionHandler(enqueueFundingChainSelection),
    [enqueueFundingChainSelection],
  )

  // Global dialogs live above the project subtree, so identity-keyed project
  // remounting alone cannot cancel an old project's pending approval.
  useLayoutEffect(() => {
    const current = activeRef.current
    if (current?.scope && current.scope.identity !== scope?.identity) {
      cancelPendingDialog(current)
      activeRef.current = null
      setActive(null)
    }
    queueRef.current = queueRef.current.filter(pending => {
      if (!pending.scope || pending.scope.identity === scope?.identity) return true
      cancelPendingDialog(pending)
      return false
    })
  }, [scope?.identity])

  // An approval belongs to the account that opened it, even while an alias
  // proof is pending. The SDK repeats this check at the wallet boundary.
  useLayoutEffect(() => {
    const matches = (pending: PendingDialog) => pending.account?.toLowerCase() === address?.toLowerCase()
    const current = activeRef.current
    if (current && !matches(current)) {
      cancelPendingDialog(current)
      activeRef.current = null
      setActive(null)
    }
    queueRef.current = queueRef.current.filter(pending => {
      if (matches(pending)) return true
      cancelPendingDialog(pending)
      return false
    })
  }, [address])

  useEffect(
    () => () => {
      if (activeRef.current) cancelPendingDialog(activeRef.current)
      queueRef.current.forEach(cancelPendingDialog)
      activeRef.current = null
      queueRef.current = []
    },
    [],
  )

  const finish = useCallback(async (id: number, result: boolean | number | null) => {
    const current = activeRef.current
    if (!current || current.id !== id) return
    const approves = current.kind === 'review' ? result === true : typeof result === 'number'
    if (approves && current.account?.toLowerCase() !== accountRef.current?.toLowerCase()) result = null
    if (approves && current.scope) {
      setCheckingProject(id)
      const verified = await current.scope.verify().catch(() => false)
      setCheckingProject(currentId => currentId === id ? null : currentId)
      // Cancellation or another dialog while the proof was pending wins.
      if (activeRef.current !== current) return
      if (!verified || scopeRef.current?.identity !== current.scope.identity
        || current.account?.toLowerCase() !== accountRef.current?.toLowerCase()) result = null
    }
    const next = queueRef.current.shift() ?? null
    activeRef.current = next
    setActive(next)
    if (current.kind === 'review') current.resolve(result === true)
    else current.resolve(typeof result === 'number' ? result : null)
  }, [])

  useEffect(
    () =>
      registerReviewHandler(async prompt => {
        const approved = await new Promise<boolean>(resolve => {
          const pending: PendingReview = { kind: 'review', id: nextId.current++, model: prompt.model, simulation: prompt.simulation, resolve, scope: scopeRef.current, account: accountRef.current }
          // Core withdrew the prompt (the run's account changed): its dialog closes, or it leaves the queue.
          prompt.signal.addEventListener('abort', () => {
            if (activeRef.current === pending) void finish(pending.id, null)
            else {
              queueRef.current = queueRef.current.filter(queued => queued !== pending)
              resolve(false)
            }
          }, { once: true })
          enqueueDialog(pending)
        })
        return approved ? prompt.confirmation : null
      }),
    [enqueueDialog, finish],
  )

  // Keep the global queue ready immediately, but fetch the full decoder and
  // review UI only when a request arrives. Loading never authorizes a call;
  // cancellation, unmount, or a failed download resolves it as declined.
  useEffect(() => {
    if (!active || Dialog) return
    let cancelled = false
    void loadDialog().then(
      module => {
        if (!cancelled) setDialog(() => module.TransactionReviewDialog)
      },
      () => {
        if (!cancelled) finish(active.id, null)
      },
    )
    return () => { cancelled = true }
  }, [active, Dialog, finish])

  return (
    <>
      {children}
      {active ? (
        Dialog ? (
          <Dialog
            key={active.id}
            pending={active}
            checkingProject={checkingProject === active.id}
            onFinish={result => { void finish(active.id, result) }}
          />
        ) : (
          <ModalDialog
            key={active.id}
            onClose={() => finish(active.id, null)}
            labelledBy={`transaction-review-loading-${active.id}`}
            className="items-start justify-center px-3 py-5 sm:px-6 sm:py-10"
          >
            <div className="card w-full max-w-lg p-5 shadow-2xl">
              <p id={`transaction-review-loading-${active.id}`} role="status">
                Loading transaction review…
              </p>
              <button
                type="button"
                onClick={() => finish(active.id, null)}
                className="btn-secondary mt-4 min-h-[44px] px-5 text-sm"
              >
                Cancel
              </button>
            </div>
          </ModalDialog>
        )
      ) : null}
    </>
  )
}
