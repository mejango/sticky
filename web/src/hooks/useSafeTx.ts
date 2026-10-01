'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getAccount } from '@wagmi/core'
import { BaseError, type Abi, type Address } from 'viem'
import {
  usePublicClient,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { useWallet } from '@/hooks/useWallet'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { gasWithHeadroom } from '@bananapus/nana-sdk-core/review'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import {
  requestContractTransactionReview,
  TransactionReviewCancelledError,
} from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'
import { wagmiConfig } from '@/providers/Providers'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'
import {
  isSafeConnection,
  SAFE_NONCE_GUIDANCE,
  safeExecutionFailed,
  useSafeConnection,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'

/** How long the block-subscription watcher gets before its silence is reported. */
const RECEIPT_WATCH_TIMEOUT_MS = 120_000
const RECEIPT_POLL_INTERVAL_MS = 4_000
/** ~10 minutes of direct lookups, matching the watcher's own retry horizon. */
const RECEIPT_POLL_ATTEMPTS = 150

type PolledReceipt = NonNullable<
  Awaited<ReturnType<NonNullable<ReturnType<typeof usePublicClient>>['getTransactionReceipt']>>
>

export type TxPhase =
  | 'idle'
  | 'review'
  | 'simulating'
  | 'signing'
  | 'pending'
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
}

export type TxSendOptions = {
  reverify?: (request: TxRequest) => Promise<unknown>
  /** Persist an unknown-submission marker immediately before the wallet write. */
  beforeWrite?: () => unknown | Promise<unknown>
  /** Called if the final account gate aborts a persisted intent before the wallet write. */
  onBeforeWriteAborted?: () => unknown | Promise<unknown>
  /** Called only for a typed, explicit wallet rejection of the write itself. */
  onWriteRejected?: () => unknown | Promise<unknown>
  /**
   * The exact request was already rendered in a parent confirmation surface.
   * This skips only the second app-owned review; account checks, revalidation,
   * simulation, duplicate protection, and the wallet confirmation still run.
   */
  reviewedInParent?: boolean
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

/** A friendly one-line message out of a viem/wagmi error. */
function friendlyTxError(e: unknown): string {
  if (e instanceof BaseError) {
    const short = e.shortMessage || e.message
    if (/user rejected|denied/i.test(short)) return 'Transaction cancelled.'
    return short
  }
  if (e instanceof Error) return e.message
  return 'Something went wrong.'
}

/**
 * The one transaction pipeline every project-page write flow uses
 * (website/ parity: exact review → simulate → send → status):
 *
 * 1. `send(request)` opens the global exact-payload review, then switches
 *    chains if needed and SIMULATES the approved call
 *    (nothing is ever sent that doesn't simulate clean), then requests the
 *    wallet signature and tracks the receipt.
 * 2. Phases drive the caller's UI; `error` carries a friendly message.
 */
export function useSafeTx(chainId: number) {
  const { isConnected, address, isCenterWallet } = useWallet()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const isSafe = useSafeConnection(wagmiConfig)

  const [phase, setPhase] = useState<TxPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  const [safeProposalHash, setSafeProposalHash] = useState<`0x${string}` | null>(
    null,
  )
  const [safeConfirmationUncertain, setSafeConfirmationUncertain] = useState(false)
  /** The Safe and proposal whose execution `hash` is, once it is known. */
  const [safeExecution, setSafeExecution] = useState<{ safe: Address; proposalHash: `0x${string}` } | null>(null)
  const inFlightRef = useRef(false)

  const receipt = useWaitForTransactionReceipt({
    hash: hash ?? undefined,
    chainId,
    // Bounded: a stalled watcher must surface as "confirmation unavailable",
    // never as a spinner that outlives the transaction it is watching.
    timeout: RECEIPT_WATCH_TIMEOUT_MS,
    query: { enabled: !!hash && !safeProposalHash },
  })

  // The watcher subscribes to new blocks and can sit pending forever on some
  // wallet/RPC pairs even after the transaction mined (it stranded pay flows
  // at "Confirming onchain…" after a Permit2 approval). A plain receipt lookup
  // on an interval is the second source of truth; whichever answers first wins.
  const [polledReceipt, setPolledReceipt] = useState<PolledReceipt | null>(null)
  useEffect(() => {
    setPolledReceipt(null)
    if (!hash || safeProposalHash || !publicClient) return
    if (typeof publicClient.getTransactionReceipt !== 'function') return
    let cancelled = false
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      if (attempts > RECEIPT_POLL_ATTEMPTS) {
        clearInterval(timer)
        return
      }
      void publicClient
        .getTransactionReceipt({ hash })
        .then(found => {
          if (cancelled || !found) return
          clearInterval(timer)
          setPolledReceipt(found)
        })
        .catch(() => undefined)
    }, RECEIPT_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [hash, safeProposalHash, publicClient])
  // React Query may retain the prior query's data while a new hash starts.
  // Only a receipt for this exact transaction can settle this action.
  const receiptData = hash
    ? [receipt.data, polledReceipt].find(
        candidate => candidate?.transactionHash?.toLowerCase() === hash.toLowerCase(),
      )
    : undefined

  useEffect(() => {
    if (!safeProposalHash) return
    const controller = new AbortController()
    void waitForSafeExecutionHash(chainId, safeProposalHash, {
      signal: controller.signal,
    })
      .then(executionHash => {
        setHash(executionHash)
        setSafeProposalHash(null)
        setSafeConfirmationUncertain(false)
      })
      .catch(reason => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        const message = friendlyTxError(reason)
        if (/executed the proposal.*failed/i.test(message)) {
          setError(message)
          setPhase('error')
        } else {
          // Losing access to Safe's service does not undo a signed proposal.
          // Keep its send lock until execution can be checked externally.
          setError(`Safe proposal submitted, but confirmation is unavailable. Check Safe before taking another action. ${message}`)
          setSafeConfirmationUncertain(true)
          setPhase('pending')
        }
      })
    return () => controller.abort()
  }, [chainId, safeProposalHash])

  // A successful receipt *query* can still contain an onchain revert. Only the
  // receipt's status is authoritative, and for a Safe execution, the Safe's own
  // ExecutionFailure. A receipt RPC error leaves the already submitted
  // transaction pending/unknown so the UI never invites a duplicate submission
  // merely because confirmation could not be read.
  const safeExecutionReverted =
    phase === 'pending' &&
    receiptData?.status === 'success' &&
    !!safeExecution &&
    safeExecutionFailed(receiptData, safeExecution.safe, safeExecution.proposalHash)
  const receiptReverted =
    phase === 'pending' && (receiptData?.status === 'reverted' || safeExecutionReverted)
  const effectivePhase: TxPhase =
    phase === 'pending' && receiptData?.status === 'success' && !safeExecutionReverted
      ? 'success'
      : receiptReverted
        ? 'error'
        : phase
  const effectiveError = safeExecutionReverted
    ? `Safe executed the proposal, but the onchain transaction failed${hash ? ` (${hash})` : ''}.`
    : receiptReverted
      ? `Transaction reverted onchain${hash ? ` (${hash})` : ''}.`
      : phase === 'pending' && receipt.isError && !receiptData
        ? `Transaction${hash ? ` ${hash}` : ''} was submitted, but confirmation is temporarily unavailable. Check the explorer and do not submit it again yet.`
        : error

  useEffect(() => {
    if (effectivePhase === 'success' || effectivePhase === 'error') {
      inFlightRef.current = false
    }
  }, [effectivePhase])

  const send = useCallback(
    async (
      request: TxRequest,
      options?: TxSendOptions,
    ) => {
      if (inFlightRef.current) return null
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
      inFlightRef.current = true
      setError(null)
      setHash(null)
      setSafeProposalHash(null)
      setSafeConfirmationUncertain(false)
      setSafeExecution(null)
      setPolledReceipt(null)
      // Read once: the review, the sent gas and the proposal tracking must all
      // agree on whether a Safe proposes this call.
      const viaSafe = isSafeConnection(wagmiConfig)
      try {
        const txHash = await submitReviewedContractWrite({
          request,
          expectedAccount: address,
          review: async reviewed => {
            // A review notice always opens the review, even where the caller
            // already rendered the payload — the notice exists precisely
            // because what was rendered is no longer what will be signed.
            if (options?.reviewedInParent && !options?.reviewNotice) return
            const description = [
              options?.reviewNotice,
              viaSafe ? SAFE_NONCE_GUIDANCE : null,
            ]
              .filter(Boolean)
              .join('\n\n')
            const approved = await requestContractTransactionReview(
              {
                ...reviewed,
                account: address,
                // A Safe app signs the sent gas as safeTxGas; 0 makes a failed call revert.
                ...(viaSafe ? { safeTxGas: 0n } : {}),
              },
              {
                label: reviewed.label,
                ...(description ? { description } : {}),
                ...(viaSafe
                  ? { confirmLabel: 'Agree & continue to Safe' }
                  : {}),
              },
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
          reverify: options?.reverify,
          beforeWrite: options?.beforeWrite,
          onBeforeWriteAborted: options?.onBeforeWriteAborted,
          onWriteRejected: options?.onWriteRejected,
          // Simulation is the safety gate: the exact reviewed call, args, and
          // value must succeed before a signature is requested. Only the
          // simulation result reaches the wallet writer.
          simulate: async reviewed => {
            const simulationRequest = {
              address: reviewed.address,
              abi: reviewed.abi,
              functionName: reviewed.functionName,
              args: reviewed.args as unknown[],
              value: reviewed.value,
              account: address,
              ...(options?.simulationBlockNumber !== undefined
                ? { blockNumber: options.simulationBlockNumber }
                : {}),
            }
            const [{ request: simulated }, estimate] = await Promise.all([
              publicClient.simulateContract(simulationRequest),
              publicClient.estimateContractGas(simulationRequest),
            ])
            return {
              ...simulated,
              gas: viaSafe ? 0n : gasWithHeadroom(estimate),
            }
          },
          write: async simulated => {
            // A WalletConnect peer read can land mid-flow and change the answer.
            if (isSafeConnection(wagmiConfig) !== viaSafe) {
              // Nothing reaches the wallet, so a marker written for this write is withdrawn.
              if (options?.beforeWrite) await options.onBeforeWriteAborted?.()
              throw new Error('Wallet connection changed. Review the transaction again.')
            }
            return writeContractAsync(simulated)
          },
          onPhase: setPhase,
        })
        setHash(txHash)
        if (viaSafe) setSafeProposalHash(txHash)
        if (viaSafe && address) setSafeExecution({ safe: address, proposalHash: txHash })
        setPhase('pending')
        return txHash
      } catch (e) {
        inFlightRef.current = false
        if (e instanceof TransactionReviewCancelledError) {
          setPhase('idle')
          return null
        }
        setError(friendlyTxError(e))
        setPhase('error')
        return null
      }
    },
    [isConnected, address, isCenterWallet, publicClient, switchChainAsync, writeContractAsync],
  )

  const reset = useCallback(() => {
    inFlightRef.current = false
    setPhase('idle')
    setError(null)
    setHash(null)
    setSafeProposalHash(null)
    setSafeConfirmationUncertain(false)
    setSafeExecution(null)
  }, [])

  return {
    phase: effectivePhase,
    /** True while the transaction is in flight: simulating/signing/pending. */
    busy:
      effectivePhase === 'simulating' ||
      effectivePhase === 'signing' ||
      effectivePhase === 'pending',
    /** Whether the connected writer is a Safe connector. */
    isSafe,
    error: effectiveError,
    hash,
    safeProposalHash,
    safeNonceGuidance: safeProposalHash ? SAFE_NONCE_GUIDANCE : null,
    receipt: receiptData ?? null,
    /** The transaction has a hash, but the current RPC could not confirm it. */
    confirmationUncertain: phase === 'pending' && (safeConfirmationUncertain || (receipt.isError && !receiptData)),
    send,
    reset,
  }
}
