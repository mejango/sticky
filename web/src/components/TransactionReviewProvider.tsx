'use client'

import {
  type ComponentType,
  type PropsWithChildren,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { registerReviewHandler, type ReviewModel, type ReviewSimulation } from '@bananapus/nana-sdk-core/review'
import { createReviewQueue } from '@bananapus/nana-sdk-core/review/machines'
import { useAccount } from 'wagmi'
import { ModalDialog } from '@/components/ui/ModalShell'
import { loadReviewEngine } from '@/lib/review-engine'
import { useProjectReviewScope } from '@/providers/ProjectRouteContext'
import { useProjectRouteBlocked } from '@/providers/ProjectRouteBlockedContext'
import {
  registerFundingChainSelectionHandler,
  type FundingChainOption,
} from '@/lib/transaction-review'

export type PendingReview = {
  kind: 'review'
  id: number
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
}

export type PendingDialog = PendingReview | PendingFundingChainSelection
type DialogPayload = Omit<PendingReview, 'id'> | Omit<PendingFundingChainSelection, 'id'>
type DialogResult = boolean | number | null

export type TransactionReviewDialogProps = {
  pending: PendingDialog
  onFinish: (result: DialogResult) => void
  checkingProject?: boolean
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
  const routeBlocked = useProjectRouteBlocked()
  const { address } = useAccount()
  const [queue] = useState(() => createReviewQueue<DialogPayload, DialogResult>())
  const { active: entry, checking } = useSyncExternalStore(queue.subscribe, queue.getState, queue.getState)
  const active = useMemo(() => entry && ({ ...entry.payload, id: entry.id } as PendingDialog), [entry])
  const [Dialog, setDialog] = useState<ComponentType<TransactionReviewDialogProps> | null>(null)

  // Global dialogs live above the project subtree, so identity-keyed project remounting alone cannot cancel an old
  // project's pending approval. An approval belongs to the project and account that opened it, and none opens while the
  // project is being replaced or could not be verified. The SDK repeats the account check at the wallet boundary.
  useLayoutEffect(() => {
    queue.setContext({ scope, account: address, blocked: routeBlocked })
  }, [queue, scope, address, routeBlocked])
  useEffect(() => () => queue.cancelAll(), [queue])

  const enqueueFundingChainSelection = useCallback(
    async (options: readonly FundingChainOption[], initialChainId: number | null) => {
      const chosen = await queue.request(
        { kind: 'funding', options: options.map(option => ({ ...option })), initialChainId },
        { declined: null, approves: result => typeof result === 'number' },
      )
      return typeof chosen === 'number' ? chosen : null
    },
    [queue],
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

  const finish = useCallback((id: number, result: DialogResult) => void queue.finish(id, result), [queue])

  useEffect(
    () =>
      registerReviewHandler(async prompt => {
        // Core withdrew the prompt (the run's account changed): its dialog closes, or it leaves the queue.
        const approved = await queue.request(
          { kind: 'review', model: prompt.model, simulation: prompt.simulation },
          { declined: false, approves: result => result === true, signal: prompt.signal },
        )
        return approved === true ? prompt.confirmation : null
      }),
    [queue],
  )

  const activeId = active?.id
  // Keep the global queue ready immediately, but fetch the full decoder and
  // review UI only when a request arrives. Loading never authorizes a call;
  // cancellation, unmount, or a failed download resolves it as declined.
  useEffect(() => {
    if (activeId === undefined || Dialog) return
    let cancelled = false
    void loadDialog().then(
      module => {
        if (!cancelled) setDialog(() => module.TransactionReviewDialog)
      },
      () => {
        if (!cancelled) queue.cancel(activeId)
      },
    )
    return () => { cancelled = true }
  }, [activeId, Dialog, queue])

  return (
    <>
      {children}
      {active ? (
        Dialog ? (
          <Dialog
            key={active.id}
            pending={active}
            checkingProject={checking}
            onFinish={result => finish(active.id, result)}
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
