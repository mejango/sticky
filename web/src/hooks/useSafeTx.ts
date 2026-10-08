'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { refreshAfterConfirmedWrite } from '@/lib/sticky-refresh'
import { getAccount } from '@wagmi/core'
import {
  BaseError,
  encodeFunctionData,
  isHash,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import {
  usePublicClient,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi'
import { useWallet } from '@/hooks/useWallet'
import { submitReviewedContractWrite } from '@/lib/contract-write'
import { gasWithHeadroom, transactionMessage, waitForTrackedReceipt } from '@bananapus/nana-sdk-core/review'
import { hasSafeService } from '@bananapus/nana-sdk-core/safe-service'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { assertReviewedWallet } from '@/lib/wallet-core'
import {
  requestContractTransactionReview,
  TransactionReviewCancelledError,
} from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'
import { wagmiConfig } from '@/providers/Providers'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'
import {
  atOnceExecution,
  chainAnswer,
  findPendingSafeAppProposal,
  heldCall,
  isSafeConnection,
  readSafeAppExecution,
  reportedSafeExecution,
  SAFE_NONCE_GUIDANCE,
  SAFE_PROPOSAL_AWAITING,
  SAFE_PROPOSAL_UNCONFIRMED,
  useSafeConnection,
  waitForSafeExecutionHash,
  watchSafeProposal,
  type SafeAppCall,
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
  /** With a Safe, and not settled here: awaiting its signers, or its result unproven. */
  | 'submitted'
  | 'success'
  | 'error'

type FollowClient = NonNullable<ReturnType<typeof usePublicClient>>

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
  /**
   * The account this request was built for: the one that reviewed it, and
   * whose beneficiary, holder or recipient it names when it names one. Only
   * that account may send it: while another is connected, nothing is reviewed
   * or sent (see contract-write.ts).
   */
  reviewedAccount: Address
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

/** The call a contract write request makes. */
function callOf(request: Pick<TxRequest, 'address' | 'abi' | 'functionName' | 'args' | 'value'>): SafeAppCall {
  return {
    to: request.address,
    data: encodeFunctionData({
      abi: request.abi,
      functionName: request.functionName,
      args: request.args as unknown[],
    }),
    value: request.value,
  }
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

// ── Safe proposals ───────────────────────────────────────────────────────────

/** Where a Safe proposal is, as its follow reads it. */
type ProposalPhase =
  /** The reply may be the execution itself: Safe{Wallet} executing at once. */
  | 'checking'
  /** With the Safe, awaiting its signers. */
  | 'awaiting'
  /** Executed: its receipt is being read. */
  | 'executing'
  /**
   * Executed, and not confirmed yet: its receipt still missing (held until it
   * arrives, or an hour after the execution was seen), or its transaction not
   * yet shown by a node behind its receipt.
   */
  | 'confirming'
  | 'success'
  | 'failed'
  /** Over, but this app can't prove it ran: held until the user dismisses it. */
  | 'unproven'
  /** Its deadline passed before the Safe ran it, so the contract refuses it now. */
  | 'expired'
  /** The Safe's nonce moved past it without running it. */
  | 'replaced'

/** How a flow shows each: in flight, with the Safe, or settled. */
const SHOWN_AS: Record<ProposalPhase, TxPhase> = {
  checking: 'pending',
  executing: 'pending',
  awaiting: 'submitted',
  confirming: 'submitted',
  unproven: 'submitted',
  success: 'success',
  failed: 'error',
  expired: 'error',
  replaced: 'error',
}

const SAFE_EXECUTION_CONFIRMING = 'Executed by your Safe. Confirming it onchain.'
/** What a Safe app replied in place of a proposal or execution hash. */
const SAFE_REPLY_UNREADABLE = 'Safe did not return a proposal hash. Check Safe before sending this again.'
const SAFE_PROPOSAL_EXPIRED = "This Safe proposal's deadline passed. Review it again."
const SAFE_PROPOSAL_REPLACED = 'Safe moved past this proposal without running it. Review it again.'
/** A receipt still missing this long after its execution was first seen is not coming. */
const RECEIPT_HORIZON_MS = 60 * 60_000

type SafeProposal = {
  chainId: number
  safe: Address
  call: SafeAppCall
  /** The safeTxHash, or the execution's own hash when Safe{Wallet} executed at once. */
  proposalHash: Hex
  phase: ProposalPhase
  executionHash: Hex | null
  receipt: TransactionReceipt | null
  /** The line for an end other than success: failed, unproven, expired or replaced. */
  message: string | null
  onConfirmed: () => void
}

/**
 * Every Safe proposal made here this session, by chain, Safe and the call it
 * holds: the exact call, with any field stamped at send time blanked
 * ({@link heldCall}). Every useSafeTx shares it and the registry follows each
 * proposal itself, so a flow that closes, remounts or changes chain never
 * drops one, and the same action is never proposed twice while one is
 * pending. Nothing is persisted: a reload starts empty, and Safe's own queue
 * answers for what it holds.
 */
const proposals = new Map<string, SafeProposal>()
const proposalListeners = new Set<() => void>()
const followingProposals = new Set<string>()

function subscribeProposals(listener: () => void): () => void {
  proposalListeners.add(listener)
  return () => {
    proposalListeners.delete(listener)
  }
}

function notifyProposals(): void {
  for (const listener of proposalListeners) listener()
}

function proposalKey(chainId: number, safe: Address, call: SafeAppCall): string {
  const held = heldCall(call)
  return `${chainId}:${safe.toLowerCase()}:${held.to.toLowerCase()}:${held.value ?? 0n}:${held.data.toLowerCase()}`
}

function updateProposal(key: string, next: Partial<SafeProposal>): void {
  const current = proposals.get(key)
  if (!current) return
  proposals.set(key, { ...current, ...next })
  if (next.phase === 'success' && current.phase !== 'success') current.onConfirmed()
  notifyProposals()
}

/** A distinct execution hash cannot make the original Safe proposal safe to repeat. */
function unconfirmedProposal(key: string, message = SAFE_PROPOSAL_UNCONFIRMED): Partial<SafeProposal> {
  const proposal = proposals.get(key)
  const knownProposal = proposal?.executionHash &&
    proposal.executionHash.toLowerCase() !== proposal.proposalHash.toLowerCase()
  return { phase: knownProposal ? 'awaiting' : 'unproven', message }
}

/** Rechecks use the same follower; concurrent flows never start a second one. */
function startFollowingProposal(key: string, client: FollowClient, reply: boolean): void {
  if (followingProposals.has(key)) return
  followingProposals.add(key)
  void followProposal(key, client, reply)
    .catch(() => updateProposal(key, unconfirmedProposal(key)))
    .finally(() => followingProposals.delete(key))
}

/**
 * A proposal holds its call until it ends: while pending, and when unproven
 * until dismissed. It ends with a result, or once it can no longer run.
 */
function holdsCall(proposal: SafeProposal | undefined): proposal is SafeProposal {
  return !!proposal && SHOWN_AS[proposal.phase] !== 'success' && SHOWN_AS[proposal.phase] !== 'error'
}

/** The execution a proposal awaiting its signers runs in, or how it ends before it runs. */
type Outcome = { executionHash: Hex } | { phase: ProposalPhase; message: string }

/**
 * Waits for the proposal's execution, from Safe's service and the chain, and
 * where the service lists the proposal, watches it: it ends early when its
 * deadline passes before the Safe ran it, or when the Safe's nonce moves past
 * it ({@link watchSafeProposal}). Whichever answers first stops the other.
 */
async function awaitExecution(
  { chainId, safe, proposalHash }: SafeProposal,
  client: FollowClient,
): Promise<Outcome> {
  const stop = new AbortController()
  const executed = waitForSafeExecutionHash(chainId, proposalHash, { client, signal: stop.signal }).then(
    (executionHash): Outcome => ({ executionHash }),
    async (reason: unknown): Promise<Outcome> => {
      // Safe's service says it ran and failed: the execution its record names decides.
      const reported = await reportedSafeExecution(reason, chainId, safe, proposalHash)
      return reported
        ? { executionHash: reported }
        : { phase: 'unproven', message: `${SAFE_PROPOSAL_UNCONFIRMED} ${friendlyTxError(reason)}` }
    },
  )
  const ended = hasSafeService(chainId)
    ? watchSafeProposal(client, chainId, safe, proposalHash, stop.signal).then(
        (end): Outcome =>
          end === 'expired'
            ? { phase: 'expired', message: SAFE_PROPOSAL_EXPIRED }
            : { phase: 'replaced', message: SAFE_PROPOSAL_REPLACED },
      )
    : new Promise<never>(() => {})
  try {
    return await Promise.race([executed, ended])
  } finally {
    stop.abort()
  }
}

/**
 * Follow a proposal to its result, whatever becomes of the flow that made it.
 * It ends unproven only on the chain's last word ({@link chainAnswer}): a
 * node that can't answer keeps it held, and is asked again a minute later.
 */
async function followProposal(key: string, client: FollowClient, reply: boolean): Promise<void> {
  const proposal = proposals.get(key)
  if (!proposal) return
  const { safe, call, proposalHash } = proposal
  // A reply the chain knows as a transaction is the execution itself; the
  // transaction read here is the one the execution is bound on.
  let execution = reply ? await atOnceExecution(client, proposalHash) : null
  let executionHash = execution ? proposalHash : null
  if (!executionHash) {
    updateProposal(key, { phase: 'awaiting' })
    const awaited = await awaitExecution(proposal, client)
    if ('executionHash' in awaited) executionHash = awaited.executionHash
    // An execution returned at once that the node learned only after the probe
    // is the execution: the chain is asked once more before the proposal ends.
    else if (
      awaited.phase === 'unproven' &&
      (execution = await chainAnswer(() => client.getTransaction({ hash: proposalHash })))
    ) {
      executionHash = proposalHash
    } else {
      updateProposal(key, awaited.phase === 'unproven' ? unconfirmedProposal(key, awaited.message) : awaited)
      return
    }
  }
  updateProposal(key, { phase: 'executing', executionHash })
  const failed = `Safe executed the proposal, but the onchain transaction failed (${executionHash}).`
  // The execution was first seen now: its receipt has an hour from here.
  const seenAt = Date.now()
  let receipt: TransactionReceipt | null = null
  while (!receipt) {
    receipt = await waitForTrackedReceipt(client, executionHash).catch(() => null)
    if (receipt) break
    if (Date.now() - seenAt >= RECEIPT_HORIZON_MS) {
      const hash = executionHash
      receipt = await chainAnswer(() => client.getTransactionReceipt({ hash }))
      if (!receipt) {
        updateProposal(key, unconfirmedProposal(key))
        return
      }
      break
    }
    updateProposal(key, { phase: 'confirming' })
  }
  if (receipt.status !== 'success') {
    updateProposal(key, {
      ...(executionHash.toLowerCase() === proposalHash.toLowerCase()
        ? { phase: 'failed' as const, message: failed }
        : unconfirmedProposal(key)),
      receipt,
    })
    return
  }
  // Only the Safe's own event for this proposal decides it, and an execution
  // returned at once must also have run the reviewed call. Its receipt proves
  // its transaction exists, so with none read yet, a node that shows none is
  // only behind: the proposal stays held, and can end its confirm on Done.
  const atOnce = receipt.transactionHash.toLowerCase() === proposalHash.toLowerCase()
  const transaction =
    atOnce && !execution
      ? await chainAnswer(() => client.getTransaction({ hash: proposalHash }), {
          exists: true,
          onRetry: () => updateProposal(key, { phase: 'confirming' }),
        })
      : execution
  const { status } = await readSafeAppExecution({
    client: {
      getTransaction: async () => {
        if (!transaction) throw new Error(`The chain has no transaction ${proposalHash}.`)
        return transaction
      },
    },
    receipt,
    safe,
    proposalHash,
    calls: [call],
  }).catch(() => ({ status: 'unproven' as const }))
  updateProposal(
    key,
    status === 'success'
      ? { phase: 'success', receipt }
      : status === 'failed'
        ? { phase: 'failed', receipt, message: failed }
        : { ...unconfirmedProposal(key), receipt },
  )
}

/** Record a proposal and follow it; `reply` says whether the hash is the wallet's own answer. */
function recordProposal(
  proposal: Pick<SafeProposal, 'chainId' | 'safe' | 'call' | 'proposalHash'>,
  client: FollowClient,
  reply: boolean,
  onConfirmed: () => void,
): string {
  const key = proposalKey(proposal.chainId, proposal.safe, proposal.call)
  proposals.set(key, {
    ...proposal,
    phase: reply ? 'checking' : 'awaiting',
    executionHash: null,
    receipt: null,
    message: null,
    onConfirmed,
  })
  notifyProposals()
  startFollowingProposal(key, client, reply)
  return key
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
  const queryClient = useQueryClient()
  const { isConnected, isCenterWallet } = useWallet()
  const publicClient = usePublicClient({ chainId })
  const { writeContractAsync } = useWriteContract()
  const { switchChainAsync } = useSwitchChain()
  const isSafe = useSafeConnection(wagmiConfig)

  const [phase, setPhase] = useState<TxPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  /** The transaction an ordinary send is waiting on. */
  const [hash, setHash] = useState<`0x${string}` | null>(null)
  /** The Safe proposal this flow shows, by its key in the registry. */
  const [shownKey, setShownKey] = useState<string | null>(null)
  const shownKeyRef = useRef<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const showProposal = useCallback((key: string | null) => {
    shownKeyRef.current = key
    setShownKey(key)
  }, [])
  const refreshDetachedProposal = useCallback((key: string, confirmedChainId: number) => {
    // A visible flow owns its precise refresh schedule. Once it closes, the
    // background follower keeps its cached display evidence from staying fresh.
    if (!mounted.current || shownKeyRef.current !== key) {
      refreshAfterConfirmedWrite(queryClient, confirmedChainId)
    }
  }, [queryClient])
  const proposal = useSyncExternalStore(
    subscribeProposals,
    () => (shownKey ? proposals.get(shownKey) : undefined),
    () => undefined,
  )
  const inFlightRef = useRef(false)

  const receipt = useWaitForTransactionReceipt({
    hash: hash ?? undefined,
    chainId,
    // Bounded: a stalled watcher must surface as "confirmation unavailable",
    // never as a spinner that outlives the transaction it is watching.
    timeout: RECEIPT_WATCH_TIMEOUT_MS,
    query: { enabled: !!hash },
  })

  // The watcher subscribes to new blocks and can sit pending forever on some
  // wallet/RPC pairs even after the transaction mined (it stranded pay flows
  // at "Confirming onchain…" after a Permit2 approval). A plain receipt lookup
  // on an interval is the second source of truth; whichever answers first wins.
  const [polledReceipt, setPolledReceipt] = useState<PolledReceipt | null>(null)
  useEffect(() => {
    setPolledReceipt(null)
    if (!hash || !publicClient) return
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
  }, [hash, publicClient])
  // React Query may retain the prior query's data while a new hash starts.
  // Only a receipt for this exact transaction can settle this action.
  const receiptData = hash
    ? [receipt.data, polledReceipt].find(
        candidate => candidate?.transactionHash?.toLowerCase() === hash.toLowerCase(),
      )
    : undefined

  // An ordinary send settles on its receipt's status alone. A receipt RPC
  // error leaves it pending/unknown, so the UI never invites a duplicate
  // submission merely because confirmation could not be read.
  const receiptReverted = phase === 'pending' && receiptData?.status === 'reverted'
  // A Safe proposal's state is the registry's. Its confirm ends on Done while
  // the signers decide, and when its result can't be proven here; no send of
  // its action goes out until it ends, or the user dismisses an unproven
  // result after its line. One the registry no longer holds (dismissed in
  // another flow) shows nothing.
  const effectivePhase: TxPhase = shownKey
    ? proposal
      ? SHOWN_AS[proposal.phase]
      : 'idle'
    : phase === 'pending' && receiptData?.status === 'success'
      ? 'success'
      : receiptReverted
        ? 'error'
        : phase
  const notice =
    proposal?.phase === 'awaiting'
      ? (proposal.message ?? SAFE_PROPOSAL_AWAITING)
      : proposal?.phase === 'confirming'
        ? SAFE_EXECUTION_CONFIRMING
        : proposal?.phase === 'unproven'
          ? (proposal.message ?? SAFE_PROPOSAL_UNCONFIRMED)
          : null
  const effectiveError = shownKey
    ? proposal && SHOWN_AS[proposal.phase] === 'error'
      ? proposal.message
      : null
    : receiptReverted
      ? `Transaction reverted onchain${hash ? ` (${hash})` : ''}.`
      : phase === 'pending' && receipt.isError && !receiptData
        ? `Transaction${hash ? ` ${hash}` : ''} was submitted, but confirmation is temporarily unavailable. Check the explorer and do not submit it again yet.`
        : error
  const awaitingProposal =
    proposal?.phase === 'checking' || proposal?.phase === 'awaiting' ? proposal.proposalHash : null

  useEffect(() => {
    if (effectivePhase === 'success' || effectivePhase === 'error') {
      inFlightRef.current = false
    }
  }, [effectivePhase])

  const send = useCallback(
    async (
      request: TxRequest,
      options: TxSendOptions,
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
      showProposal(null)
      setPolledReceipt(null)
      // Read once: the review, the sent gas and the proposal tracking must all
      // agree on whether a Safe proposes this call.
      const viaSafe = isSafeConnection(wagmiConfig)
      const connectorUid = getAccount(wagmiConfig).connector?.uid
      const account = options.reviewedAccount
      try {
        /** The exact call simulated and sent, which a Safe execution must run. */
        let sentCall = callOf(request)
        if (viaSafe) {
          // An action the Safe already has, from this session or its own queue,
          // is shown as it is and never proposed again.
          const key = proposalKey(request.chainId, account, sentCall)
          const held = proposals.get(key)
          let queued: Awaited<ReturnType<typeof findPendingSafeAppProposal>> = null
          if (!holdsCall(held) && hasSafeService(request.chainId)) {
            // Reading Safe's queue takes a moment: the flow shows it checking.
            setPhase('simulating')
            queued = await findPendingSafeAppProposal(publicClient, request.chainId, account, sentCall)
          }
          if (holdsCall(held) || queued) {
            if (queued) {
              const { proposalHash, call } = queued
              recordProposal({ chainId: request.chainId, safe: account, call, proposalHash }, publicClient, false,
                () => refreshDetachedProposal(key, request.chainId))
            } else if (held?.phase === 'awaiting') {
              startFollowingProposal(key, publicClient, false)
            }
            inFlightRef.current = false
            showProposal(key)
            return proposals.get(key)!.proposalHash
          }
        }
        const txHash = await submitReviewedContractWrite({
          request,
          expectedAccount: account,
          review: async reviewed => {
            // A review notice always opens the review, even where the caller
            // already rendered the payload — the notice exists precisely
            // because what was rendered is no longer what will be signed.
            if (options.reviewedInParent && !options.reviewNotice) return
            const description = [
              options.reviewNotice,
              viaSafe ? SAFE_NONCE_GUIDANCE : null,
            ]
              .filter(Boolean)
              .join('\n\n')
            const approved = await requestContractTransactionReview(
              {
                ...reviewed,
                account,
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
          reverify: options.reverify,
          beforeWrite: options.beforeWrite,
          onBeforeWriteAborted: options.onBeforeWriteAborted,
          onWriteRejected: options.onWriteRejected,
          // Simulation is the safety gate: the exact reviewed call, args, and
          // value must succeed before a signature is requested. Only the
          // simulation result reaches the wallet writer.
          simulate: async reviewed => {
            sentCall = callOf(reviewed)
            const simulationRequest = {
              address: reviewed.address,
              abi: reviewed.abi,
              functionName: reviewed.functionName,
              args: reviewed.args as unknown[],
              value: reviewed.value,
              account,
              ...(options.simulationBlockNumber !== undefined
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
          beforeSend: () => {
            // Reads and durable preparation can outlive the wallet connection
            // that reviewed them. This final synchronous gate is SDK-owned.
            assertReviewedWallet({ account, connectorUid, chainId: request.chainId, safe: viaSafe })
          },
          write: simulated => writeContractAsync({ ...simulated, chainId: request.chainId }),
          onPhase: setPhase,
        })
        if (viaSafe) {
          // A reply that is not a 32-byte hash names no proposal and no execution.
          if (!isHash(txHash)) throw new Error(SAFE_REPLY_UNREADABLE)
          // The registry holds the call from here; this flow only shows it.
          inFlightRef.current = false
          showProposal(
            recordProposal(
              { chainId: request.chainId, safe: account, call: sentCall, proposalHash: txHash },
              publicClient,
              true,
              () => refreshDetachedProposal(proposalKey(request.chainId, account, sentCall), request.chainId),
            ),
          )
        } else {
          setHash(txHash)
        }
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
    [isConnected, isCenterWallet, publicClient, refreshDetachedProposal, showProposal, switchChainAsync, writeContractAsync],
  )

  /**
   * Clear this flow's state, as a new review opens. A Safe proposal stays in
   * the registry: still followed while pending, and still held when unproven,
   * since the user may not have seen its line.
   */
  const reset = useCallback(() => {
    inFlightRef.current = false
    setPhase('idle')
    setError(null)
    setHash(null)
    showProposal(null)
  }, [showProposal])

  /**
   * The user closed the confirm after its line. An unproven Safe result is
   * released: its call is the user's to send again. A pending proposal stays
   * followed and held.
   */
  const dismiss = useCallback(() => {
    if (shownKey && proposals.get(shownKey)?.phase === 'unproven') {
      proposals.delete(shownKey)
      notifyProposals()
    }
    reset()
  }, [reset, shownKey])

  return {
    phase: effectivePhase,
    /** True while the transaction is in flight: simulating/signing/pending. */
    busy:
      effectivePhase === 'simulating' ||
      effectivePhase === 'signing' ||
      effectivePhase === 'pending',
    /** The confirm can end on Done: the transaction succeeded, or it is with a Safe. */
    settled: effectivePhase === 'success' || effectivePhase === 'submitted',
    /** The one line a `submitted` confirm shows. */
    notice,
    /** Whether the connected writer is a Safe connector. */
    isSafe,
    error: effectiveError,
    hash: shownKey ? (proposal?.executionHash ?? null) : hash,
    safeProposalHash: awaitingProposal,
    safeNonceGuidance: awaitingProposal ? SAFE_NONCE_GUIDANCE : null,
    receipt: shownKey ? (proposal?.receipt ?? null) : (receiptData ?? null),
    /** The transaction has a hash, but its result could not be confirmed here. */
    confirmationUncertain: shownKey
      ? proposal?.phase === 'unproven' || (proposal?.phase === 'awaiting' && !!proposal.message)
      : phase === 'pending' && receipt.isError && !receiptData,
    send,
    reset,
    dismiss,
  }
}
