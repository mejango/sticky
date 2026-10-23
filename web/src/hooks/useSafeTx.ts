'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getAccount } from '@wagmi/core'
import { useQueryClient } from '@tanstack/react-query'
import { refreshAfterConfirmedWrite } from '@/lib/sticky-refresh'
import {
  BaseError,
  encodeFunctionData,
  isAddressEqual,
  isHash,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { usePublicClient, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { useHeldSend, type HeldSendInput } from '@bananapus/nana-sdk-core/review/react'
import {
  gasWithHeadroom, settledLine, transactionMessage, HELD_AWAY_SUCCESS_LINE, HELD_CONFIRMING_LINE, WRITE_HOLD_UNCHECKED_LINE,
  SubmittedContractWriteError, WriteHeldError, WriteHoldBusyError, WriteHoldNonceError, WriteHoldStaleReviewError,
  type WriteHoldClient,
  type WriteHoldGate,
  type WriteHoldHandle,
} from '@bananapus/nana-sdk-core/review'
import { hasSafeService } from '@bananapus/nana-sdk-core/safe-service'
import { useWallet } from '@/hooks/useWallet'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { exitWarning, followDetached, holds } from '@/lib/write-holds'
import { holdIntent } from '@/lib/sticky-hold-intent'
import { legacyNamespaces } from '@/lib/legacy-intents'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { assertReviewedWallet } from '@/lib/wallet-core'
import { requestContractTransactionReview, requireTransactionReview, TransactionReviewCancelledError, type TransactionReviewRequest, type TransactionReviewRow } from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'
import { wagmiConfig } from '@/providers/Providers'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'
import { findPendingSafeAppProposal, isSafeConnection, SAFE_NONCE_GUIDANCE, useSafeConnection, type SafeAppCall } from '@/lib/safe-connector'

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

declare const reviewedCalls: unique symbol
/** An opaque proof that one decoded review approved an action's exact calls. Only `review` issues one. */
export type ReviewedCalls = { readonly [reviewedCalls]: true }
/** What each issued proof's review showed: the calls, and the account, wallet connection, Safe mode and hold line. */
const approvedReviews = new WeakMap<ReviewedCalls, Readonly<{ account: Address; connectorUid?: string; safe: boolean; line: string | null; calls: readonly string[] }>>()

export type TxSendOptions = {
  /**
   * The account this request was built for: the one that reviewed it, and
   * whose beneficiary, holder or recipient it names when it names one. Only
   * that account may send it: while another is connected, nothing is reviewed
   * or sent (see contract-write.ts).
   */
  reviewedAccount: Address
  reverify?: (request: TxRequest) => Promise<unknown>
  /**
   * The action's one decoded review already showed this exact call: it is sent without asking again. Any difference
   * (calldata, value, chain, account, wallet connection, Safe mode, hold line, a review notice) opens its own decoded review.
   */
  reviewed?: ReviewedCalls
  /** Persist an unknown-submission marker immediately before the wallet write. */
  beforeWrite?: () => unknown | Promise<unknown>
  /** Called if the final account gate aborts a persisted intent before the wallet write. */
  onBeforeWriteAborted?: () => unknown | Promise<unknown>
  /** Called only for a typed, explicit wallet rejection of the write itself. */
  onWriteRejected?: () => unknown | Promise<unknown>
  /** The error behind a send that failed before reaching the chain (simulation, estimate, wallet), for a flow to decode. */
  onFailure?: (error: unknown) => void
  /** A domain journal keeps this write's domain data beside the SDK hold, including the returned hash. */
  durableRecovery?: {
    reserve: () => unknown | Promise<unknown>
    releaseUnsubmitted: () => unknown | Promise<unknown>
    submitted: (hash: Hex, safe: boolean) => unknown | Promise<unknown>
    /** The user's exit released the SDK hold on this write: clear the reservation, keep the transfer's metadata. */
    released?: () => unknown | Promise<unknown>
  }
  /**
   * Simulate against a confirmed prerequisite block instead of a load
   * balancer's potentially lagging `latest` view. This is required when the
   * reviewed write immediately follows an ERC-20 or Permit2 approval.
   */
  simulationBlockNumber?: bigint
  /**
   * Plain-language sentence shown at the top of the mandatory review — for
   * when the freshly re-quoted payload is materially worse than what the
   * caller's panel displayed. Raw fixed-point arguments alone are not
   * effective disclosure of that.
   */
  reviewNotice?: string
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

/** The call a contract write request makes. */
function callOf(request: Pick<TxRequest, 'address' | 'abi' | 'functionName' | 'args' | 'value'>): SafeAppCall & { value: bigint } {
  return {
    to: request.address,
    data: encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args as unknown[] }),
    value: request.value ?? 0n,
  }
}

/** A call as a review approved it: its chain, target, calldata and value. */
function callKey(chainId: number, call: { to: Address; data: Hex; value?: bigint }): string {
  return `${chainId}:${call.to.toLowerCase()}:${call.data.toLowerCase()}:${call.value ?? 0n}`
}

/** A friendly one-line message out of a viem/wagmi error. */
function friendlyTxError(e: unknown): string {
  if (e instanceof BaseError) {
    const short = e.shortMessage || e.message
    if (/user rejected|denied/i.test(short)) return 'Transaction cancelled.'
    return transactionMessage(short)
  }
  if (e instanceof Error) return transactionMessage(e.message)
  return 'Something went wrong.'
}

/**
 * Where an intent-keyed write's older holds can be: origin/main held it under an app-local namespace (rebuilt by the
 * frozen legacy builder) with its own calldata, and before that by exact call, so a retry whose calldata differs (a new
 * quote) is found by the old namespaces and by the call's target and selector. An exact-call write needs none.
 */
export function legacyHolds(namespace: string | undefined, call: { to: Address; data: Hex }, request?: Parameters<typeof legacyNamespaces>[0]): ({ match: { to: Address; selector: Hex } } | string)[] {
  if (!namespace) return []
  return [{ match: { to: call.to, selector: call.data.slice(0, 10) as Hex } }, ...(request ? legacyNamespaces(request).filter(old => old !== namespace) : [])]
}

/**
 * The one transaction pipeline every project-page write flow uses: exact review, simulation, then the send under the
 * SDK's held send (useHeldSend, as every site sends a call known only at send time), which watches it, follows its transaction or Safe proposal, gives its one line and
 * its exit, and settles it. The flow shows the SDK's view; nothing here decides whether a write may be sent again.
 */
export function useSafeTx(chainId: number) {
  const { isConnected, isCenterWallet } = useWallet()
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const isSafe = useSafeConnection(wagmiConfig)

  const [phase, setPhase] = useState<TxPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  /** The hold settled this flow's write as reverted onchain. */
  const [reverted, setReverted] = useState(false)
  /** The wallet's reply for the write this flow sent: a transaction, or a Safe proposal. */
  const [sent, setSent] = useState<{ hash: Hex; safe: boolean } | null>(null)
  /** The hold's authenticated success, with its receipt. */
  const [result, setResult] = useState<{ hash: Hex; receipt: TransactionReceipt | null } | null>(null)
  /** Whether the write this flow sent is a Safe proposal. */
  const [safe, setSafe] = useState(false)
  const publicClient = usePublicClient({ chainId })
  const options = useRef<TxSendOptions | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const generation = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const renderedChain = useRef(chainId)
  useEffect(() => {
    if (renderedChain.current !== chainId) {
      renderedChain.current = chainId
      generation.current += 1
    }
  }, [chainId])

  const queryClient = useQueryClient()
  /** What the flow shows when it closes: a Safe proposal still with its signers keeps being followed. */
  const closing = useRef<{ handle?: WriteHoldHandle; client?: WriteHoldClient; chainId: number; follow: boolean }>({ chainId, follow: false })
  const reset = useCallback(() => {
    const { handle, client, chainId: on, follow } = closing.current
    // As before: a Safe proposal whose flow closed is still followed, and its reads refresh once it runs.
    if (follow && handle && client) followDetached(handle, client, () => refreshAfterConfirmedWrite(queryClient, on))
    generation.current += 1
    inFlight.current = false
    setPhase('idle')
    setError(null)
    setReverted(false)
    setSent(null)
    setResult(null)
  }, [queryClient])

  const write = useHeldSend({
    hold: holds,
    client: publicClient,
    // As often as before: a held write is asked again every 15 seconds while visible.
    pollMs: 15_000,
    onSettled: (settled, receipt) => {
      if (!('hash' in settled)) return
      if (settled.result === 'success') {
        setResult({ hash: settled.hash, receipt })
        setPhase('success')
      } else {
        setError(settledLine(settled))
        setReverted(settled.result === 'failed')
        setPhase('error')
      }
    },
    onReleased: by => {
      if (by !== 'user') return
      void Promise.resolve(options.current?.durableRecovery?.released?.()).catch(() => undefined)
      reset()
    },
  })
  const latest = useRef(write)
  latest.current = write

  // A direct write's receipt is handed to its hold, which verifies it and settles at once.
  // The transaction a direct write is followed by: the wallet's reply, or the one its hold already tracks.
  const tracked = write.state && write.state.status !== 'clear' && !write.state.record.safe
    ? ('hash' in write.state && write.state.hash ? write.state.hash : write.state.record.hash)
    : undefined
  const watched = (sent && !sent.safe ? sent.hash : undefined) ?? (phase === 'pending' ? tracked : undefined)
  const receipt = useWaitForTransactionReceipt({ hash: watched, chainId, timeout: 120_000, query: { enabled: !!watched } })
  const receiptData = watched && receipt.data?.transactionHash?.toLowerCase() === watched.toLowerCase() ? receipt.data : undefined
  useEffect(() => {
    if (!receiptData || !publicClient) return
    void latest.current.handle?.onReceipt(receiptData, publicClient).catch(() => undefined)
  }, [receiptData, publicClient])

  const send = useCallback(
    async (request: TxRequest, sendOptions: TxSendOptions) => {
      if (inFlight.current) return null
      if (isCenterWallet) {
        setError(EXTERNAL_WALLET_REQUIRED)
        setPhase('error')
        return null
      }
      if (getViewAs()) {
        setError(VIEW_AS_WRITE_BLOCKED)
        setPhase('error')
        return null
      }
      if (!isConnected || !publicClient) {
        setError('Connect a wallet first.')
        setPhase('error')
        return null
      }
      inFlight.current = true
      const attempt = generation.current
      const isCurrent = () => mounted.current && generation.current === attempt && renderedChain.current === chainId
      setError(null)
      setReverted(false)
      setPhase('simulating')
      setSent(null)
      setResult(null)
      // Read once: the review, the sent gas and the hold must all agree on whether a Safe proposes this call.
      const viaSafe = isSafeConnection(wagmiConfig)
      const connectorUid = getAccount(wagmiConfig).connector?.uid
      const account = sendOptions.reviewedAccount
      options.current = sendOptions
      let call: ReturnType<typeof callOf>
      let namespace: string | undefined
      try {
        call = callOf(request)
        namespace = holdIntent(request, account)
      } catch (e) {
        // A request that cannot be encoded is an error of its own; the next one is taken.
        inFlight.current = false
        setError(friendlyTxError(e))
        setPhase('error')
        return null
      }
      const held: HeldSendInput = { chainId: request.chainId, account, safe: viaSafe, namespace, legacy: legacyHolds(namespace, call, request), call }
      setSafe(viaSafe)
      let walletInvoked = false
      /** The wallet refused it, or it stopped before the wallet: the SDK dropped its reservation, nothing was sent. */
      let unsent = false
      const recovery = sendOptions.durableRecovery
      const execute = async (gate: WriteHoldGate): Promise<Hex> => {
        if (viaSafe && hasSafeService(request.chainId)) {
          // An action already in the Safe's queue is shown as it is and never proposed again.
          const queued = await findPendingSafeAppProposal(publicClient, request.chainId, account, call)
          if (queued) {
            await gate.beforeSend(queued.call)
            gate.afterSubmit(queued.proposalHash)
            await recovery?.submitted(queued.proposalHash, true)
            return queued.proposalHash
          }
        }
        const hash = await submitReviewedContractWrite({
          request,
          expectedAccount: account,
          review: async reviewed => {
            const proof = sendOptions.reviewed && approvedReviews.get(sendOptions.reviewed)
            if (proof && !sendOptions.reviewNotice && proof.safe === viaSafe && isAddressEqual(proof.account, account) && proof.connectorUid === connectorUid &&
              proof.line === holds.reviewLine() && proof.calls.includes(callKey(reviewed.chainId, callOf(reviewed)))) return
            const description = [sendOptions.reviewNotice, holds.reviewLine(), viaSafe ? SAFE_NONCE_GUIDANCE : null].filter(Boolean).join('\n\n')
            const approved = await requestContractTransactionReview(
              // A Safe app signs the sent gas as safeTxGas; 0 makes a failed call revert.
              { ...reviewed, account, ...(viaSafe ? { safeTxGas: 0n } : {}) },
              { label: reviewed.label, ...(description ? { description } : {}), ...(viaSafe ? { confirmLabel: 'Agree & continue to Safe' } : {}) },
            )
            if (!approved) throw new TransactionReviewCancelledError()
          },
          switchChain: async reviewedChainId => {
            if (getAccount(wagmiConfig).chainId === reviewedChainId) return
            await switchChainAsync({ chainId: reviewedChainId }).catch(() => {
              throw new Error(`Switch your wallet to ${chainName(reviewedChainId)} to continue.`)
            })
          },
          currentAccount: () => getAccount(wagmiConfig).address,
          reverify: sendOptions.reverify,
          // The SDK reserves the write first, so no journal ever records an attempt the hold does not hold.
          beforeWrite: async () => {
            await gate.beforeSend()
            try {
              await sendOptions.beforeWrite?.()
              await recovery?.reserve()
            } catch (failure) {
              gate.onRejected()
              await recovery?.releaseUnsubmitted()
              throw failure
            }
          },
          onBeforeWriteAborted: async () => {
            unsent = true
            gate.onRejected()
            await recovery?.releaseUnsubmitted()
            await sendOptions.onBeforeWriteAborted?.()
          },
          onWriteRejected: async () => {
            unsent = true
            gate.onRejected()
            await recovery?.releaseUnsubmitted()
            await sendOptions.onWriteRejected?.()
          },
          onWriteSubmitted: async (submitted: Hex) => {
            gate.afterSubmit(submitted)
            await recovery?.submitted(submitted, viaSafe)
          },
          // Simulation is the safety gate: only the simulation result reaches the wallet writer.
          simulate: async reviewed => {
            const simulation = {
              address: reviewed.address, abi: reviewed.abi, functionName: reviewed.functionName,
              args: reviewed.args as unknown[], value: reviewed.value, account,
              ...(sendOptions.simulationBlockNumber !== undefined ? { blockNumber: sendOptions.simulationBlockNumber } : {}),
            }
            const [{ request: simulated }, estimate] = await Promise.all([
              publicClient.simulateContract(simulation),
              publicClient.estimateContractGas(simulation),
            ])
            return { ...simulated, gas: viaSafe ? 0n : gasWithHeadroom(estimate) }
          },
          beforeSend: () => {
            // Reads and durable preparation can outlive the wallet connection that reviewed them.
            if (!isCurrent()) throw new Error('This review closed. Open the action again before sending.')
            assertReviewedWallet({ account, connectorUid, chainId: request.chainId, safe: viaSafe })
          },
          write: simulated => {
            walletInvoked = true
            return writeContractAsync({ ...simulated, chainId: request.chainId })
          },
          onPhase: next => { if (isCurrent()) setPhase(next) },
        })
        // A Safe reply that is not a 32-byte hash names no proposal and no execution.
        if (viaSafe && !isHash(hash)) throw new Error('Check this proposal in your Safe before sending it again.')
        return hash
      }
      try {
        const hash = await latest.current.send(held, execute)
        if (!isCurrent()) return null
        // A Safe proposal is with its signers: the flow may close. A direct write keeps the lock until it settles.
        if (viaSafe) inFlight.current = false
        setSent({ hash, safe: viaSafe })
        setPhase('pending')
        return hash
      } catch (e) {
        if (!isCurrent()) return null
        inFlight.current = false
        // Held, or a success that went through while away: the SDK's view shows it, with its exit or its send-again.
        if (e instanceof WriteHeldError || (e instanceof Error && e.message === HELD_AWAY_SUCCESS_LINE)) {
          setPhase('pending')
          void latest.current.check()
          return null
        }
        if (e instanceof WriteHoldStaleReviewError) {
          // Another window sent this intent while the review was open: its result if it settled, else its message.
          if (e.settled && 'hash' in e.settled) { setError(null); setPhase('pending'); void latest.current.check() } else { setError(e.message); setPhase('error') }
          return null
        }
        if (e instanceof WriteHoldBusyError || e instanceof WriteHoldNonceError) {
          setError(e.message)
          setPhase('error')
          return null
        }
        if (e instanceof SubmittedContractWriteError && typeof e.hash === 'string' && isHash(e.hash)) {
          setSent({ hash: e.hash, safe: viaSafe })
          setPhase('pending')
          return e.hash
        }
        // A write that may have reached the wallet stays held, whatever was thrown.
        // The SDK keeps it held (its view, current from this send on, shows it): never an error to retry.
        if (walletInvoked && !unsent) {
          setPhase('pending')
          return null
        }
        if (e instanceof TransactionReviewCancelledError) {
          setPhase('idle')
          return null
        }
        // A flow's reading of the failure never stops the engine from settling it.
        try { sendOptions.onFailure?.(e) } catch { /* the engine's own line stands */ }
        setError(friendlyTxError(e))
        setPhase('error')
        return null
      }
    },
    [chainId, isConnected, isCenterWallet, publicClient, switchChainAsync, writeContractAsync],
  )

  /**
   * One decoded review of every call one user action sends, with the action's summary rows above them. The proof it
   * returns lets each of those exact calls be sent without asking again. Throws TransactionReviewCancelledError when closed.
   */
  const review = useCallback(async (requests: readonly TxRequest[], { account, title, rows }: { account: Address; title?: string; rows?: readonly TransactionReviewRow[] }): Promise<ReviewedCalls> => {
    const viaSafe = isSafeConnection(wagmiConfig)
    const connectorUid = getAccount(wagmiConfig).connector?.uid
    const line = holds.reviewLine()
    const calls = requests.map(request => ({
      ...callOf(request), chainId: request.chainId, from: account, abi: request.abi, functionName: request.functionName, args: request.args,
      ...(request.label ? { label: request.label } : {}),
      // A Safe app signs the sent gas as safeTxGas; 0 makes a failed call revert.
      ...(viaSafe ? { safeTxGas: 0n } : {}),
    }))
    const description = [line, viaSafe ? SAFE_NONCE_GUIDANCE : null].filter(Boolean).join('\n\n')
    const request: TransactionReviewRequest = {
      calls, ...(title ? { title } : {}), ...(rows?.length ? { rows } : {}), ...(description ? { description } : {}),
      ...(viaSafe ? { confirmLabel: 'Agree & continue to Safe' } : {}),
    }
    await requireTransactionReview(request)
    const proof = Object.freeze({}) as ReviewedCalls
    approvedReviews.set(proof, Object.freeze({ account, connectorUid, safe: viaSafe, line, calls: Object.freeze(calls.map(call => callKey(call.chainId, call))) }))
    return proof
  }, [])

  // While the wallet's own prompt is open the call is reserved, not lost: the flow shows the prompt, not the hold.
  const prompting = phase === 'review' || phase === 'simulating' || phase === 'signing'
  const shown = phase === 'pending' && !prompting ? write : null
  // A result is the hold's settlement (onSettled); a receipt alone is followed, never shown as one. A reverted receipt
  // the hold keeps until finality lets the flow close while the hold keeps checking.
  const effectivePhase: TxPhase = !shown
    ? phase
    : shown.phase === 'confirming' && receiptData?.status === 'reverted'
      ? 'submitted'
    : shown.phase === 'confirming'
      ? (safe ? 'submitted' : 'pending')
      : shown.phase === 'awaiting' || shown.phase === 'held' || shown.phase === 'released' || shown.phase === 'succeeded'
        ? 'submitted'
        : shown.phase === 'settled' && shown.settled?.result !== 'success'
          ? 'error'
          // Nothing held and nothing sent (another window's write settled meanwhile): the flow may review again.
          : shown.phase === 'clear' && !sent
            ? 'idle'
            : 'pending'
  const notice = effectivePhase === 'submitted' && shown ? shown.line : null
  const runExit = () => { void write.exitAction?.run().catch(() => setError(WRITE_HOLD_UNCHECKED_LINE)) }
  const held = !shown
    ? null
    : write.exitAction
      ? { line: shown.line ?? '', warning: exitWarning(shown) ?? '', label: write.exitAction.label, notice: shown.notice, exit: runExit }
      : write.sendAgainAction
        ? { line: shown.line ?? '', warning: '', label: write.sendAgainAction.label, notice: shown.notice, exit: () => { void write.sendAgainAction?.run().then(reset) } }
        // A direct write the wallet has held a while: the SDK's pending line, no exit.
        : shown.phase === 'confirming' && !safe && shown.line && shown.line !== HELD_CONFIRMING_LINE
          ? { line: shown.line, warning: '', label: '', notice: shown.notice, exit: null }
          : null
  const awaitingProposal = shown?.phase === 'awaiting' && sent?.safe ? sent.hash : null
  closing.current = { handle: write.handle, client: publicClient as WriteHoldClient | undefined, chainId,
    follow: !!sent?.safe && (shown?.phase === 'awaiting' || shown?.phase === 'confirming') }
  // The lock is let go once the result is committed, so a click before that commit's effects sends nothing.
  useEffect(() => {
    if (effectivePhase === 'success' || effectivePhase === 'error' || effectivePhase === 'submitted') inFlight.current = false
  }, [effectivePhase])

  return {
    phase: effectivePhase,
    /** True while the transaction is in flight: simulating/signing/pending. */
    busy: effectivePhase === 'simulating' || effectivePhase === 'signing' || effectivePhase === 'pending',
    /** The confirm can end on Done: the transaction succeeded, or the hold has it. */
    settled: effectivePhase === 'success' || effectivePhase === 'submitted',
    /** The one line a `submitted` confirm shows: the hold's. */
    notice,
    /** A held write: its line, what sending again risks, and the user's exit (or its send-again). */
    held,
    /** The SDK's in-tab notice, whenever the hold carries one. */
    holdNotice: shown?.notice ?? null,
    /** Whether the connected writer is a Safe connector. */
    isSafe,
    error: effectivePhase === 'error' ? (error ?? (shown?.line || null)) : error,
    /** The write was mined and reverted: its receipt says so, not why. */
    reverted: effectivePhase === 'error' && (reverted || shown?.settled?.result === 'failed'),
    hash: result?.hash ?? watched ?? null,
    safeProposalHash: awaitingProposal,
    /** The wallet's original reply, retained if its durable handoff needs repair. */
    submissionHash: sent?.hash ?? null,
    submissionIsSafe: !!sent?.safe,
    safeNonceGuidance: awaitingProposal ? SAFE_NONCE_GUIDANCE : null,
    receipt: result?.receipt ?? null,
    send,
    review,
    reset,
    /** Close the current confirmation. The hold keeps the write; dismissing is never evidence that it can be sent again. */
    dismiss: reset,
  }
}
