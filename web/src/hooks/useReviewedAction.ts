'use client'

import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { encodeFunctionData, keccak256, stringToHex, type Abi, type Address, type Hex, type TransactionReceipt } from 'viem'
import {
  HELD_CONFIRMING_LINE,
  openStepHold,
  REVIEWED_ACCOUNT_CHANGED_LINE,
  WRITE_HOLD_REVERTED_LINE,
  WRITE_HOLD_UNCHECKED_LINE,
  type ReviewContextRow,
  type ReviewedAction,
  type ReviewedCall,
  type ReviewedResult,
  type WriteHoldClient,
} from '@bananapus/nana-sdk-core/review'
import { useReviewedRun } from '@bananapus/nana-sdk-core/review/react'
import { useWallet } from '@/hooks/useWallet'
import { legacyNamespaces } from '@/lib/legacy-intents'
import { isSafeConnection, SAFE_NONCE_GUIDANCE, useSafeConnection } from '@/lib/safe-connector'
import { holdIntent } from '@/lib/sticky-hold-intent'
import { refreshAfterConfirmedWrite } from '@/lib/sticky-refresh'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { publicClient, reviewedSendDeps } from '@/lib/wallet-core'
import { exitWarning, followDetached, holds } from '@/lib/write-holds'
import { wagmiConfig } from '@/providers/Providers'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'

export type TxPhase =
  | 'idle'
  | 'review'
  | 'simulating'
  | 'signing'
  | 'pending'
  /** With a Safe, or held: the hold's own line says where it is. */
  | 'submitted'
  | 'success'
  | 'error'

/** A contract write, as Sticky's builders return it. */
export type TxRequest = {
  chainId: number
  address: `0x${string}`
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
  label?: string
  /** An approval step's parent action, as its intent key: the hold of an approval belongs to the action it serves. */
  parent?: string
}

/**
 * The shared in-flight button copy: the fixed simulating/signing strings every
 * flow uses, the caller's `pending` progress text, and its `idle` label
 * (any non-in-flight phase falls through to `idle`). `confirm` overrides the
 * signing string for flows with more specific wallet copy.
 */
export function txPhaseLabel(
  phase: TxPhase,
  labels: { idle: string; pending: string; confirm?: string },
): string {
  if (phase === 'simulating') return 'Double-checking the transaction…'
  if (phase === 'signing') return labels.confirm ?? 'Confirm in your wallet…'
  if (phase === 'pending') return labels.pending
  return labels.idle
}

/**
 * Where an intent-keyed write's older holds can be: origin/main held it under an app-local namespace (rebuilt by the
 * frozen legacy builder) with its own calldata, and before that by exact call, so a retry whose calldata differs (a new
 * quote) is found by the old namespaces and by the call's target and selector. An exact-call write needs none.
 */
export function legacyHolds(namespace: string | undefined, call: { to: Address; data: Hex }, request?: Parameters<typeof legacyNamespaces>[0]): NonNullable<ReviewedCall['legacy']>[number][] {
  if (!namespace) return []
  return [{ match: { to: call.to, selector: call.data.slice(0, 10) as Hex } }, ...(request ? legacyNamespaces(request).filter(old => old !== namespace) : [])]
}

/** One reviewed step from a contract write request: its exact bytes, decoded for the review, under its hold keys. */
export function reviewedCall(request: TxRequest, account: Address, step: Pick<ReviewedCall, 'dependsOnPrior' | 'simulationBlockNumber'> = {}): ReviewedCall {
  const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args as unknown[] })
  const intent = holdIntent(request, account)
  return {
    chainId: request.chainId,
    to: request.address,
    data,
    value: request.value ?? 0n,
    abi: request.abi,
    functionName: request.functionName,
    args: request.args,
    ...(request.label ? { label: request.label } : {}),
    ...(intent ? { intent, legacy: legacyHolds(intent, { to: request.address, data }, request) } : {}),
    ...step,
  }
}

/**
 * A plan's steps as one reviewed sequence: each step after the first on its chain simulates on the block the one
 * before it confirmed in, and the first may wait for a prerequisite confirmed outside the plan (`after`).
 */
export function reviewedSteps(requests: readonly TxRequest[], account: Address, after?: bigint): ReviewedCall[] {
  return requests.map((request, index) =>
    reviewedCall(request, account, index > 0 && requests[index - 1].chainId === request.chainId
      ? { dependsOnPrior: true }
      : after === undefined ? {} : { simulationBlockNumber: after }))
}

/**
 * The key a sequence is saved under to resume it: its exact bytes, so a retry of the same steps resumes where it
 * stopped and a plan made afresh starts over (each step's hold still refuses one already sent).
 */
export function sequenceScope(calls: readonly ReviewedCall[]): string {
  const sent = calls.map(call => [call.chainId, call.to.toLowerCase(), call.data.toLowerCase(), String(call.value ?? 0n)])
  return `sticky:${keccak256(stringToHex(JSON.stringify(sent)))}`
}

export type ReviewedRun = Omit<ReviewedAction, 'account' | 'guard' | 'scope' | 'context' | 'reverify'> & {
  /** The account the calls were built for: the run is refused, before its review, unless it is connected. */
  account: Address
  /**
   * A stale-state check before each step; it throws to stop with nothing sent. `confirmedAt` is the block the step
   * before it confirmed in during this run, where its simulation runs, so the check reads the same state.
   */
  reverify?: (call: ReviewedCall, index: number, confirmedAt: bigint | undefined) => Promise<void>
  /** The action's summary rows above its calls. */
  context?: readonly ReviewContextRow[]
  /** The user's exit released the hold of this action's step: a domain journal ends its reservation. */
  onReleased?: () => unknown | Promise<unknown>
  /** The person closed the review, or refused the wallet's prompt: nothing was sent, nothing is held. */
  onCancelled?: () => void
}

/**
 * Sticky's one reviewed send, over core's useReviewedRun: Sticky's wallet, chains, write hold and guard, with each
 * run's progress as the phases the flows show. Core reviews once, simulates, holds, journals and sends every step;
 * this hook only maps its state for display. The Signa connector signs in only, so its writes are refused here until
 * it sends through its own reviewer.
 */
export function useReviewedAction() {
  const queryClient = useQueryClient()
  const { address, isCenterWallet } = useWallet()
  const isSafe = useSafeConnection(wagmiConfig)
  const [submission, setSubmission] = useState<{ hash: Hex; safe: boolean } | null>(null)
  const [result, setResult] = useState<ReviewedResult | null>(null)
  /** How many of the run's steps confirmed, from its progress: it outlives a failure, which resets core's state. */
  const [landed, setLanded] = useState(0)
  /** The user's exit could not be checked: the hold keeps the write. */
  const [exitError, setExitError] = useState<string | null>(null)
  const inFlight = useRef(false)
  /** Counts account changes: a run reviewed before one sends nothing after it, even once the account is back. */
  const accountEpoch = useRef(0)
  useEffect(() => { accountEpoch.current += 1 }, [address])
  /** A run that ended with nothing finished: once its state shows, it is read for a cancel. */
  const [ended, setEnded] = useState<{ onCancelled: () => void } | null>(null)
  const last = useRef<{ action: ReviewedRun; chainId: number; proposed: ReviewedCall | null } | null>(null)
  const runner = useReviewedRun({
    account: address,
    ...reviewedSendDeps,
    onProgress: progress => setLanded(progress.phase === 'done' ? progress.total : progress.step),
    guard: () => {
      if (isCenterWallet) throw new Error(EXTERNAL_WALLET_REQUIRED)
      if (getViewAs()) throw new Error(VIEW_AS_WRITE_BLOCKED)
    },
  })

  const run = async (action: ReviewedRun): Promise<ReviewedResult | null> => {
    if (inFlight.current || !action.calls.length) return null
    inFlight.current = true
    setResult(null)
    setSubmission(null)
    setLanded(0)
    setExitError(null)
    const viaSafe = isSafeConnection(wagmiConfig)
    const { onReleased: _released, onCancelled, reverify, ...sent } = action
    /** The direct transactions this run sent, by step. */
    const hashes: Hex[] = []
    last.current = { action, chainId: action.calls[0].chainId, proposed: null }
    const epoch = accountEpoch.current
    try {
      const description = [action.description, holds.reviewLine(), viaSafe ? SAFE_NONCE_GUIDANCE : null].filter(Boolean).join('\n\n')
      const done = await runner.run({
        ...sent,
        ...(action.calls.length > 1 ? { scope: sequenceScope(action.calls) } : {}),
        ...(description ? { description } : {}),
        ...(viaSafe && !action.confirmLabel ? { confirmLabel: 'Agree & continue to Safe' } : {}),
        ...(reverify ? {
          reverify: async (call: ReviewedCall, index: number) => {
            // Core simulates this step on the block the step before it confirmed in: the check reads there too.
            const before = hashes[index - 1]
            await reverify(call, index, before ? (await publicClient(call.chainId as JBChainId).getTransactionReceipt({ hash: before })).blockNumber : undefined)
          },
        } : {}),
        beforeWallet: async (call, step) => {
          if (accountEpoch.current !== epoch) throw new Error(REVIEWED_ACCOUNT_CHANGED_LINE)
          await action.beforeWallet?.(call, step)
        },
        onSubmitted: async (call, step, hash, how) => {
          if (!how.safe) hashes[step] = hash
          setSubmission({ hash, safe: how.safe })
          await action.onSubmitted?.(call, step, hash, how)
        },
      })
      if (done?.status === 'proposed' && last.current?.action === action) last.current.proposed = action.calls[done.step] ?? null
      setResult(done)
      if (!done && onCancelled) setEnded({ onCancelled })
      return done
    } finally {
      inFlight.current = false
    }
  }

  const { held: shown } = runner
  // Core says a run that returned nothing was cancelled by leaving its error empty, with nothing held.
  useEffect(() => {
    if (!ended) return
    setEnded(null)
    if (runner.phase === 'idle' && !runner.error && !shown) ended.onCancelled()
  }, [ended, runner.phase, runner.error, shown])
  /** Whether the held step is a Safe's proposal. */
  const heldSafe = !!shown?.state && shown.state.status !== 'clear' && shown.state.record.safe
  // Core's phase, with its held view: a run that stopped with a step in flight is held, with that hold's line.
  const phase: TxPhase =
    runner.phase === 'done' ? 'success'
      : runner.phase === 'proposed' ? 'submitted'
        : runner.phase === 'receipt' ? 'pending'
          : runner.phase !== 'idle' ? runner.phase
            : shown ? (shown.phase === 'confirming' && !heldSafe ? 'pending' : 'submitted')
              : runner.error ? 'error'
                : 'idle'

  const onReleased = last.current?.action.onReleased
  const runExit = () => {
    setExitError(null)
    void runner.exitAction?.run().then(released => {
      if (!released) return
      // The hold's line was the run's error: once released, the action is offered again with nothing failed.
      runner.reset()
      void Promise.resolve(onReleased?.()).catch(() => undefined)
    }, () => setExitError(WRITE_HOLD_UNCHECKED_LINE))
  }
  const held = !shown
    ? null
    : runner.exitAction
      ? { line: shown.line ?? '', warning: exitWarning(shown) ?? '', label: runner.exitAction.label, notice: shown.notice, exit: runExit }
      : runner.sendAgainAction
        ? { line: shown.line ?? '', warning: '', label: runner.sendAgainAction.label, notice: shown.notice, exit: () => { void runner.sendAgainAction?.run().then(reset) } }
        // A direct write the wallet has held a while: the SDK's pending line, no exit.
        : shown.phase === 'confirming' && !heldSafe && shown.line && shown.line !== HELD_CONFIRMING_LINE
          ? { line: shown.line, warning: '', label: '', notice: shown.notice, exit: null }
          : null

  function reset() {
    if (inFlight.current) return
    // A Safe proposal whose flow closed is still followed, and its reads refresh once it runs.
    const proposed = last.current?.proposed
    if (proposed && address) {
      followDetached(openStepHold(holds, address, true, proposed), publicClient(proposed.chainId as JBChainId) as WriteHoldClient, () => refreshAfterConfirmedWrite(queryClient, proposed.chainId))
    }
    last.current = null
    setEnded(null)
    setResult(null)
    setSubmission(null)
    setLanded(0)
    setExitError(null)
    runner.reset()
  }

  const hash = result?.status === 'done' ? result.hashes.at(-1) ?? null : runner.hash ?? (submission && !submission.safe ? submission.hash : null)
  const receipt: TransactionReceipt | null = result?.status === 'done' ? result.receipts.at(-1) ?? null : null
  const safeProposalHash = phase === 'submitted' ? runner.safeTxHash : null
  return {
    run,
    phase,
    /** True while the run is in flight: in review, simulating, signing or awaiting its receipt. */
    busy: phase === 'review' || phase === 'simulating' || phase === 'signing' || phase === 'pending',
    /** The confirm can end on Done: the run succeeded, or a Safe or the hold has it. */
    settled: phase === 'success' || phase === 'submitted',
    /** The one line a `submitted` confirm shows: the hold's. */
    notice: phase === 'submitted' ? shown?.line ?? null : null,
    /** A held write: its line, what sending again risks, and the user's exit (or its send-again). */
    held,
    /** The SDK's in-tab notice, whenever the hold carries one. */
    holdNotice: shown?.notice ?? null,
    /** Whether the connected writer is a Safe connector. */
    isSafe,
    error: exitError ?? (phase === 'error' ? runner.error : null),
    /** The value the failed run threw, with its cause chain, for a flow's own decoder. */
    failure: runner.failure,
    /** A step was mined and reverted: its receipt says so, not why. */
    reverted: phase === 'error' && runner.failure instanceof Error && runner.failure.message === WRITE_HOLD_REVERTED_LINE,
    /** How many of the run's steps confirmed: the confirm is on the one after them. */
    landed,
    hash,
    safeProposalHash,
    /** The wallet's reply for the run's latest step: a transaction, or a Safe proposal. */
    submissionHash: submission?.hash ?? null,
    submissionIsSafe: !!submission?.safe,
    safeNonceGuidance: safeProposalHash ? SAFE_NONCE_GUIDANCE : null,
    receipt,
    reset,
    /** Close the current confirmation. The hold keeps the write; dismissing is never evidence that it can be sent again. */
    dismiss: reset,
  }
}

export type ReviewedActionState = ReturnType<typeof useReviewedAction>
