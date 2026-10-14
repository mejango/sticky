'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { refreshAfterConfirmedWrite } from '@/lib/sticky-refresh'
import { getAccount, getPublicClient } from '@wagmi/core'
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
import {
  gasWithHeadroom, transactionMessage, writeExitMessage, WRITE_EXIT_LABEL,
 WRITE_HOLD_REVERTED_LINE, WRITE_HOLD_UNCHECKED_LINE,
  SubmittedContractWriteError, WriteHeldError, WriteHoldBusyError, WriteHoldNonceError, WriteHoldStaleReviewError,
  waitForTrackedReceipt, type WriteHoldGate, type WriteHoldHandle, type WriteHoldState,
} from '@bananapus/nana-sdk-core/review'
import { hasSafeService } from '@bananapus/nana-sdk-core/safe-service'
import { holds } from '@/lib/write-holds'
import { holdIntent } from '@/lib/sticky-hold-intent'
import { legacyNamespaces } from '@/lib/legacy-intents'
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
  useSafeConnection,
  waitForSafeExecutionHash,
  watchSafeProposal,
  type SafeAppCall,
} from '@/lib/safe-connector'

/** How long the block-subscription watcher gets before its silence is reported. */
const RECEIPT_WATCH_TIMEOUT_MS = 120_000
const RECEIPT_POLL_INTERVAL_MS = 4_000
/** How often a held write asks the chain again. */
const HOLD_CHECK_INTERVAL_MS = 15_000

/** How long a proposal the Safe ran is given to name its execution before the line alone is shown. */
const EXECUTED_HASH_GRACE_MS = 120_000
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

/** What a panel learns of a stored write: the SDK's line and exit, or an authenticated settlement. */
export type StoredHold = { exit: boolean; line: string; warning?: string; checked?: boolean } | { settled: { hash: Hex; result: 'success' | 'failed' } } | null
/** How a user's exit on a stored write ended. Only `released` abandons; `settled` carries the authenticated hash. */
export type StoredExit = { outcome: 'released' } | { outcome: 'settled'; hash: Hex; result: 'success' | 'failed' } | { outcome: 'held' }

type FollowClient = NonNullable<ReturnType<typeof usePublicClient>>

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
  /** An existing durable journal owns this write, including the returned-hash handoff. */
  durableRecovery?: {
    reserve: () => unknown | Promise<unknown>
    releaseUnsubmitted: () => unknown | Promise<unknown>
    submitted: (hash: Hex, safe: boolean) => unknown | Promise<unknown>
    /** The user's exit released the SDK hold on this write: clear the reservation, keep the transfer's metadata. */
    released?: () => unknown | Promise<unknown>
    /** The SDK settled the write on authenticated evidence (never an abandon): record this hash and run the normal confirmed recovery. */
    settled?: (settlement: { hash: Hex; result: 'success' | 'failed' }) => unknown | Promise<unknown>
  }
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
  /** The hold's own authenticated word that it failed. The follower never ends here by itself. */
  | 'failed'

/** How a flow shows each: in flight, with the Safe, or settled. */
const SHOWN_AS: Record<ProposalPhase, TxPhase> = {
  checking: 'pending',
  executing: 'pending',
  awaiting: 'submitted',
  confirming: 'submitted',
  success: 'success',
  failed: 'error',
}

/** A hold cleared elsewhere with no settlement: neutral, since the result is unknown. */
const HELD_ELSEWHERE_NOTE = 'This transaction is no longer held here. Check your wallet before sending it again.'
const SAFE_EXECUTION_CONFIRMING = 'Executed by your Safe. Confirming it onchain.'
/** What a Safe app replied in place of a proposal or execution hash. */
const SAFE_REPLY_UNREADABLE = 'Check this proposal in your Safe before sending it again.'
/** A receipt still missing this long after its execution was first seen is not coming. */
const RECEIPT_HORIZON_MS = 60 * 60_000

type SafeProposal = {
  chainId: number
  safe: Address
  call: SafeAppCall
  /** The safeTxHash, or the execution's own hash when Safe{Wallet} executed at once. */
  proposalHash: Hex
  phase: ProposalPhase
  /** Identifies this entry, so a follower that outlives it (retired by another tab's exit) cannot touch a later one. */
  run: symbol
  executionHash: Hex | null
  receipt: TransactionReceipt | null
  /** The line for the hold's authenticated failure. */
  message: string | null
  /** The Safe's own log shows it ran, though no execution is named yet: the confirming line says so. */
  executed?: boolean
  /** The write hold of this call: told the moment the chain proves the Safe ran it, whether or not any flow is open. */
  hold?: WriteHoldHandle | null
  client?: FollowClient
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

/**
 * The one Safe flow rule: the follower ends app-side only on an authenticated success (and the user's exit or
 * dismissal). Every other end goes to the hold: `onExecuted` for a named execution, `onUnproven` otherwise. The
 * proposal then keeps its friendly confirming line while the hold's own checks continue behind it, until the hold
 * offers its exit or settles. It never goes back to awaiting signers, and no retry loop runs before the hold.
 */
function handToHold(key: string, executionHash?: Hex, executed = false): void {
  const proposal = proposals.get(key)
  if (!proposal) return
  if (proposal.hold && proposal.client) {
    const call = executionHash
      ? proposal.hold.onExecuted(proposal.client, executionHash)
      : executed ? proposal.hold.onExecuted(proposal.client) : proposal.hold.onUnproven(proposal.client, proposal.proposalHash)
    void call.catch(() => undefined)
  }
  updateProposal(key, { phase: 'confirming', ...(executed ? { executed: true } : {}) })
}

/** Rechecks use the same follower; concurrent flows never start a second one. */
function startFollowingProposal(key: string, client: FollowClient, reply: boolean): void {
  if (followingProposals.has(key)) return
  followingProposals.add(key)
  void followProposal(key, client, reply)
    .catch(() => handToHold(key))
    .finally(() => followingProposals.delete(key))
}

/**
 * A proposal holds its call until it ends with an authenticated result; the hold keeps the rest.
 */
function holdsCall(proposal: SafeProposal | undefined): proposal is SafeProposal {
  return !!proposal && SHOWN_AS[proposal.phase] !== 'success' && SHOWN_AS[proposal.phase] !== 'error'
}

/** The execution a proposal awaiting its signers runs in, or how it ends before it runs. */
type Outcome = { executionHash: Hex } | { handOff: true; executed: boolean }

/**
 * Waits for the proposal's execution, from Safe's service and the chain, and
 * where the service lists the proposal, watches it: it ends early when its
 * deadline passes before the Safe ran it, or when the Safe's nonce moves past
 * it ({@link watchSafeProposal}). Whichever answers first stops the other.
 */
async function awaitExecution(
  { chainId, safe, proposalHash, hold }: SafeProposal,
  client: FollowClient,
): Promise<Outcome> {
  type Ended = Outcome | { ranOnChain: true }
  const stop = new AbortController()
  const executed = waitForSafeExecutionHash(chainId, proposalHash, { client, signal: stop.signal }).then(
    (executionHash): Ended => ({ executionHash }),
    async (reason: unknown): Promise<Ended> => {
      // Safe's service says it ran and failed: the execution its record names decides.
      const reported = await reportedSafeExecution(reason, chainId, safe, proposalHash)
      return reported
        ? { executionHash: reported }
        : { handOff: true, executed: false }
    },
  )
  const ended = hasSafeService(chainId)
    ? watchSafeProposal(client, chainId, safe, proposalHash, stop.signal).then(
        (end): Ended => (end === 'executed' ? { ranOnChain: true } : { handOff: true, executed: false }),
      )
    : new Promise<never>(() => {})
  let grace: ReturnType<typeof setTimeout> | undefined
  try {
    const first = await Promise.race([executed, ended])
    if (!('ranOnChain' in first)) return first
    // The Safe's own event proves it ran: the hold keeps that at once, even with no result yet.
    void hold?.onExecuted(client).catch(() => undefined)
    // The Safe's own event shows it ran this proposal. Its execution hash,
    // from the service, decides the result; without one the line alone stands.
    const named = await Promise.race([
      executed,
      new Promise<null>(resolve => { grace = setTimeout(() => resolve(null), EXECUTED_HASH_GRACE_MS) }),
    ])
    return named && 'executionHash' in named ? named : { handOff: true, executed: true }
  } finally {
    clearTimeout(grace)
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
  const { safe, call, proposalHash, run } = proposal
  // An entry the user's other tab retired is not ours any more: a late callback of this follower changes nothing.
  const live = () => proposals.get(key)?.run === run
  const step = (next: Partial<SafeProposal>) => { if (live()) updateProposal(key, next) }
  const end = (executionHash?: Hex, executed = false) => { if (live()) handToHold(key, executionHash, executed) }
  // A reply the chain knows as a transaction is the execution itself; the
  // transaction read here is the one the execution is bound on.
  let execution = reply ? await atOnceExecution(client, proposalHash) : null
  let executionHash = execution ? proposalHash : null
  if (!executionHash) {
    step({ phase: 'awaiting' })
    const awaited = await awaitExecution(proposal, client)
    if ('executionHash' in awaited) executionHash = awaited.executionHash
    // An execution returned at once that the node learned only after the probe
    // is the execution: the chain is asked once more before the proposal ends.
    else if (!awaited.executed && (execution = await chainAnswer(() => client.getTransaction({ hash: proposalHash })))) {
      executionHash = proposalHash
    } else {
      end(undefined, awaited.executed)
      return
    }
  }
  step({ phase: 'executing', executionHash })
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
        // No receipt ever proved this execution: the hold decides, and offers its exit when due.
        end()
        return
      }
      break
    }
    step({ phase: 'confirming' })
  }
  if (receipt.status !== 'success') {
    // A failed or foreign execution is the hold's to settle or refuse; the follower ends nothing itself.
    end(executionHash)
    return
  }
  // Only the Safe's own event for this proposal decides it, and an execution
  // returned at once must also have run the reviewed call. Its receipt proves
  // its transaction exists, so with none read yet, a node that shows none is
  // only behind: the hold keeps it.
  const atOnce = receipt.transactionHash.toLowerCase() === proposalHash.toLowerCase()
  const transaction =
    atOnce && !execution
      ? await chainAnswer(() => client.getTransaction({ hash: proposalHash }), {
          exists: true,
          onRetry: () => step({ phase: 'confirming' }),
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
  if (!live()) return
  // Only an authenticated success ends app-side; the hold is told either way.
  if (status === 'success') {
    void proposal.hold?.onExecuted(client, executionHash).catch(() => undefined)
    step({ phase: 'success', receipt })
    return
  }
  end(status === 'failed' ? executionHash : undefined)
}

/**
 * A registry entry never outlives its hold. Before an entry is reused or adopted, the hold's settlement for the same
 * call (kept by the SDK, and read from any tab) closes it with the authenticated result, whatever flow is mounted.
 */
function reconcileProposal(key: string, state: WriteHoldState): void {
  if (state.status !== 'clear' || !state.settled || !('hash' in state.settled) || !proposals.has(key)) return
  const settled = state.settled
  updateProposal(key, settled.result === 'success'
    ? { phase: 'success', executionHash: settled.hash }
    : { phase: 'failed', executionHash: settled.hash, message: `Safe executed the proposal, but the onchain transaction failed (${settled.hash}).` })
}

/** Another tab's exit cleared the hold with no settlement: the entry goes, and any follower still running for it is ignored. */
function retireProposal(key: string): void {
  if (proposals.delete(key)) notifyProposals()
}

/** Record a proposal and follow it; `reply` says whether the hash is the wallet's own answer. */
function recordProposal(
  proposal: Pick<SafeProposal, 'chainId' | 'safe' | 'call' | 'proposalHash'> & { ran?: boolean; hold?: WriteHoldHandle | null },
  client: FollowClient,
  reply: boolean,
  onConfirmed: () => void,
): string {
  const key = proposalKey(proposal.chainId, proposal.safe, proposal.call)
  proposals.set(key, {
    ...proposal,
    phase: reply ? 'checking' : 'awaiting',
    run: Symbol(key),
    executionHash: null,
    receipt: null,
    message: null,
    client,
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
/**
 * Where an intent-keyed write's older holds can be: origin/main held it under an app-local namespace (rebuilt by the
 * frozen legacy builder) with its own calldata, and before that by exact call, so a retry whose calldata differs (a new
 * quote) is found by the old namespaces and by the call's target and selector. An exact-call write needs none.
 */
function legacyHolds(namespace: string | undefined, call: { chainId: number; to: Address; data: Hex }, request?: Parameters<typeof legacyNamespaces>[0]): ({ match: { to: Address; selector: Hex } } | string)[] {
  if (!namespace) return []
  return [{ match: { to: call.to, selector: call.data.slice(0, 10) as Hex } }, ...(request ? legacyNamespaces(request).filter(old => old !== namespace) : [])]
}

/** The hold for a write a domain journal saved, opened the way its send opened it. */
function openStored(write: StoredWrite): WriteHoldHandle {
  return holds.open(
    { chainId: write.chainId, account: write.owner, safe: !!write.safeProposal, namespace: write.intent, call: { to: write.to, data: write.data, value: write.value } },
    { legacy: legacyHolds(write.intent, write) },
  )
}

/** A write a domain journal saved: its call, the intent key it was held under, and the reference it was given, if any. */
type StoredWrite = { chainId: number; owner: Address; to: Address; data: Hex; value: bigint | string; intent?: string; hash?: Hex; safeProposal?: boolean; submittedAt?: number }

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
  /** True from the moment the call is reserved until the wallet's own promise settles: nothing recovers an attempt still at the prompt. */
  const walletOpenRef = useRef(false)
  /** Clears a domain journal's reservation when the user's exit releases the hold. */
  const releasedRef = useRef<(() => unknown | Promise<unknown>) | null>(null)
  /** Records an authenticated settlement the SDK reached for the write this flow sent. */
  const settledRef = useRef<((settlement: { hash: Hex; result: 'success' | 'failed' }) => unknown | Promise<unknown>) | null>(null)
  const generation = useRef(0)
  const renderedChain = useRef(chainId)
  useEffect(() => {
    if (renderedChain.current !== chainId) {
      renderedChain.current = chainId
      generation.current += 1
    }
  }, [chainId])
  /** The write hold of the call this flow sent last, and what the SDK says of it. */
  const [hold, setHold] = useState<WriteHoldHandle | null>(null)
  const holdRef = useRef<WriteHoldHandle | null>(null)
  const [held, setHeld] = useState<WriteHoldState | null>(null)
  const heldRef = useRef<WriteHoldState | null>(null)
  /** The reservation of the attempt this flow shows: states of any other reservation belong to someone else. */
  const reservationRef = useRef<string | null>(null)
  /** True while this flow's own exit runs: the clear it emits is the user's doing, not another tab's. */
  const exitingRef = useRef(false)
  /** The registry key of the Safe proposal this flow's hold stands for, shown or not. */
  const proposalKeyRef = useRef<string | null>(null)
  /** How a hold the user was looking at ended without a send: its settlement, kept. */
  const [settledNote, setSettledNote] = useState<string | null>(null)
  /**
   * `local`: the state came from this flow's own receipt, which its normal success path already handles.
   * Otherwise a hold on screen that clears with an SDK-authenticated settlement (this tab or another's) ends the
   * attempt whatever it offered before: the settlement is handed off and the pending phase finishes.
   */
  const showHeld = useCallback((value: WriteHoldState | null, local = false): boolean => {
    const shown = value && value.status !== 'clear' ? value : null
    // A contended read (the lock was busy) is only the saved record: it never hides an exit already shown.
    if (shown && shown.checked === false && heldRef.current && heldRef.current.status !== 'clear' && heldRef.current.exit && heldRef.current.reservation === shown.reservation) return false
    // A newer reservation this flow did not start (another window's attempt after this one ended) is not this flow's to show.
    if (value?.reservation) {
      if (reservationRef.current && reservationRef.current !== value.reservation) return false
      if (shown) reservationRef.current = value.reservation
    }
    if (!shown && value?.status === 'clear' && heldRef.current && (!local || (!value.settled && !exitingRef.current))) {
      const settled = value.settled
      const offered = 'exit' in heldRef.current && heldRef.current.exit
      if (settled && 'hash' in settled) {
        const domain = settledRef.current
        settledRef.current = null
        // A Safe proposal never outlives its settled hold: the registry entry takes the authenticated result.
        const registryKey = shownKeyRef.current ?? proposalKeyRef.current
        if (registryKey) reconcileProposal(registryKey, value)
        if (domain) {
          void Promise.resolve(domain({ hash: settled.hash, result: settled.result })).catch(() => undefined)
          setSettledNote(settled.result === 'failed' ? WRITE_HOLD_REVERTED_LINE : 'Your earlier transaction went through.')
          setPhase('submitted')
        } else if (!shownKeyRef.current) {
          // An ordinary write: finish the pending phase on the authenticated hash. A Safe proposal's phase is the registry's.
          setHash(settled.hash)
          setSettledNote('Your earlier transaction went through.')
          if (settled.result === 'success') setPhase('success')
          else { setSettledNote(null); setError(WRITE_HOLD_REVERTED_LINE); setPhase('error') }
          inFlightRef.current = false
        }
      } else if (offered) {
        // Cleared with no evidence handed back (another tab's exit): nothing is known of the result, so nothing is claimed.
        const registryKey = shownKeyRef.current ?? proposalKeyRef.current
        if (registryKey) retireProposal(registryKey)
        showProposal(null)
        setSettledNote(HELD_ELSEWHERE_NOTE)
        setPhase('submitted')
      }
    }
    heldRef.current = shown
    setHeld(shown)
    return true
  }, [showProposal])
  const watchHold = useCallback((next: WriteHoldHandle | null) => {
    holdRef.current = next
    reservationRef.current = null
    setHold(next)
    if (!next) setHeld(null)
  }, [])
  useEffect(() => {
    if (!hold) return
    // Only the SDK's gate offers an exit (peek, replay and other tabs' changes carry none), so what it emits is shown as is.
    const observe = (state: WriteHoldState) => {
      if (holdRef.current !== hold || !mounted.current) return
      // A settlement is taken from the read that returned it (the poll, the exit, the receipt), never from its emission.
      if (state.status === 'clear' && state.settled) return
      // An emission grants no exit, and revokes none: the gate's last answer for the same record stands until the next read.
      const current = heldRef.current
      if (current && state.status !== 'clear' && !state.exit && current.status === state.status && current.exit && current.record.id === state.record.id) return
      showHeld(state, true)
    }
    // Anything the controller said before this subscription is read from the saved record.
    try { observe(hold.peek()) } catch { /* An unreadable record shows at the next look. */ }
    return hold.subscribe(observe)
  }, [hold, showHeld])

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

  const receiptReverted = phase === 'pending' && receiptData?.status === 'reverted'
  const recoveryReceipt = shownKey ? proposal?.receipt : receiptData
  // The SDK's state for the call decides what the flow shows while it holds.
  const holdWaits = held?.status === 'pending-known-hash' || held?.status === 'ran-executed'
  // While the wallet's own prompt is open the call is reserved, not lost: no exit yet.
  const wallet = phase === 'simulating' || phase === 'signing'
  const exitOffered = !wallet && held && held.status !== 'clear' && held.exit ? held : null
  const recoveryProofPending = holdWaits && (shownKey
    ? proposal?.phase === 'success' || proposal?.phase === 'failed'
    : !!recoveryReceipt)
  // A Safe proposal's state is the registry's. Its confirm ends on Done while
  // the signers decide, and when its result can't be proven here; no send of
  // its action goes out while the hold keeps the call.
  const effectivePhase: TxPhase = exitOffered
    ? 'submitted'
    : recoveryProofPending
      ? recoveryReceipt?.status === 'reverted' || proposal?.phase === 'failed'
        ? 'submitted'
        : 'pending'
    : shownKey
    ? proposal
      ? SHOWN_AS[proposal.phase]
      : 'idle'
    : phase === 'pending' && receiptData?.status === 'success'
      ? 'success'
      : receiptReverted
        ? 'error'
        : phase
  const notice = exitOffered?.line ?? settledNote ?? (recoveryProofPending
    ? 'Checking the original transaction’s canonical result before allowing another action.'
    :
    proposal?.phase === 'awaiting'
      ? (proposal.message ?? SAFE_PROPOSAL_AWAITING)
      // The friendly line stays until the hold's own exit is due; its checks continue behind it.
      : proposal?.phase === 'confirming'
        ? (proposal.executionHash || proposal.executed ? SAFE_EXECUTION_CONFIRMING : SAFE_PROPOSAL_AWAITING)
        : null)
  const effectiveError = shownKey
    ? proposal && SHOWN_AS[proposal.phase] === 'error' && !exitOffered
      ? proposal.message
      : null
    : receiptReverted
      ? `Transaction reverted onchain${hash ? ` (${hash})` : ''}.`
      : phase === 'pending' && receipt.isError && !receiptData
        ? `Transaction${hash ? ` ${hash}` : ''} was submitted, but confirmation is temporarily unavailable.`
        : error
  const awaitingProposal =
    proposal?.phase === 'checking' || proposal?.phase === 'awaiting' ? proposal.proposalHash : null

  /**
   * Show what the SDK says of the held call, and follow its hash or proposal.
   * Returns the hash a held call is already tracked by.
   */
  const apply = useCallback((state: WriteHoldState, restart = true): Hex | null => {
    if (!showHeld(state)) return null
    inFlightRef.current = false
    if (state.status === 'clear') return null
    const record = state.record
    if (state.status === 'pending-known-hash' || state.status === 'ran-executed' || state.status === 'safe-unproven' || (state.status === 'looks-done' && state.hash)) {
      const known = 'hash' in state ? state.hash : undefined
      if (record.safe) {
        const call = { ...record.call, value: BigInt(record.call.value) }
        const key = proposalKey(record.chainId, record.account, call)
        const proposalHash = known ?? record.hash
        if (proposalHash && publicClient) {
          // The registry follows a proposal it already has; only a missing one (a fresh page) is made again.
          if (!proposals.has(key)) {
            recordProposal({ chainId: record.chainId, safe: record.account, call, proposalHash, hold: holdRef.current, ...(state.status === 'ran-executed' ? { ran: true } : {}) },
              publicClient, true, () => refreshDetachedProposal(key, record.chainId))
          } else if (restart && proposals.get(key)?.phase === 'awaiting') startFollowingProposal(key, publicClient, false)
          showProposal(key)
        }
      } else if (known) setHash(known)
      setPhase('pending')
      return known ?? null
    }
    setPhase('submitted')
    return null
  }, [publicClient, refreshDetachedProposal, showHeld, showProposal])

  // The receipt of the held write releases it once the SDK has verified it; a
  // Safe execution the registry proved is reported the same way.
  useEffect(() => {
    if (!hold || !publicClient) return
    const confirmed = shownKey ? proposal?.receipt : receiptData
    if (!confirmed) return
    let stopped = false
    void hold.onReceipt(confirmed, publicClient)
      .then(state => { if (!stopped && holdRef.current === hold && mounted.current) showHeld(state, true) })
      .catch(() => { /* Unverified is not released; the next look asks again. */ })
    return () => { stopped = true }
  }, [hold, publicClient, shownKey, proposal?.receipt, receiptData, showHeld])
  const holdOpen = !!held
  // While held, the SDK is asked again: a hash that shows up is followed, a
  // dropped one earns the exit, and a confirmation releases it.
  useEffect(() => {
    if (!hold || !publicClient || !holdOpen) return
    const timer = setInterval(() => {
      void hold.state(publicClient)
        .then(next => { if (holdRef.current === hold && mounted.current && !walletOpenRef.current) apply(next, false) })
        .catch(() => { /* A node that cannot answer keeps the hold. */ })
    }, HOLD_CHECK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [hold, publicClient, holdOpen, apply])

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
      const attempt = generation.current
      const isCurrent = () => mounted.current && generation.current === attempt && renderedChain.current === chainId
      setError(null)
      // Asking the hold takes a moment: the flow is already sending, not idle.
      setPhase('simulating')
      setHash(null)
      showProposal(null)
      setPolledReceipt(null)
      watchHold(null)
      setSettledNote(null)
      // Read once: the review, the sent gas and the proposal tracking must all
      // agree on whether a Safe proposes this call.
      const viaSafe = isSafeConnection(wagmiConfig)
      const connectorUid = getAccount(wagmiConfig).connector?.uid
      const account = options.reviewedAccount
      let walletInvoked = false
      let handle: WriteHoldHandle | null = null
      try {
        /** The exact call simulated and sent, which a Safe execution must run. */
        let sentCall = callOf(request)
        proposalKeyRef.current = viaSafe ? proposalKey(request.chainId, account, sentCall) : null
        // A domain journal (bridge, collector) holds its own writes; every other write is held here.
        // The SDK hold covers every write; a domain journal keeps its own reservation beside it.
        const namespace = holdIntent(request, account)
        handle = holds.open({ chainId: request.chainId, account, safe: viaSafe, namespace, call: sentCall }, { legacy: legacyHolds(namespace, { chainId: request.chainId, ...sentCall }, request) })
        releasedRef.current = options.durableRecovery?.released ?? null
        settledRef.current = options.durableRecovery?.settled ?? null
        watchHold(handle)
        const execute = async (gate: WriteHoldGate | null) => {
          if (!isCurrent()) return null
          if (viaSafe) {
            // An action the Safe already has, from this session or its own queue,
            // is shown as it is and never proposed again.
            const key = proposalKey(request.chainId, account, sentCall)
            // The registry's entry is reconciled with the hold's settlement before it is reused or adopted.
            if (handle) reconcileProposal(key, handle.peek())
            const held = proposals.get(key)
            let queued: Awaited<ReturnType<typeof findPendingSafeAppProposal>> = null
            if (!holdsCall(held) && hasSafeService(request.chainId)) {
              // Reading Safe's queue takes a moment: the flow shows it checking.
              setPhase('simulating')
              queued = await findPendingSafeAppProposal(publicClient, request.chainId, account, sentCall)
            }
            if (!isCurrent()) return null
            if (holdsCall(held) || queued) {
              if (queued) {
                const { proposalHash, call } = queued
                recordProposal({ chainId: request.chainId, safe: account, call, proposalHash, hold: handle }, publicClient, false,
                  () => refreshDetachedProposal(key, request.chainId))
              } else if (held?.phase === 'awaiting') {
                startFollowingProposal(key, publicClient, false)
              }
              inFlightRef.current = false
              showProposal(key)
              const existing = proposals.get(key)!
              if (gate) {
                await gate.beforeSend(existing.call)
                gate.afterSubmit(existing.proposalHash)
              }
              await options.durableRecovery?.submitted(existing.proposalHash, true)
              return isCurrent() ? existing.proposalHash : null
            }
          }
          const txHash = await submitReviewedContractWrite({
            request,
            expectedAccount: account,
            review: async reviewed => {
              // A review notice always opens the review, even where the caller
              // already rendered the payload — the notice exists precisely
              // because what was rendered is no longer what will be signed.
              if (options.reviewedInParent && !options.reviewNotice && !holds.reviewLine()) return
              const description = [
                options.reviewNotice,
                holds.reviewLine(),
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
            beforeWrite: async () => {
              await options.beforeWrite?.()
              await options.durableRecovery?.reserve()
              walletOpenRef.current = true
              try { await gate?.beforeSend() } catch (failure) {
                // The wallet never opens: the domain reservation made just before ends here, not later.
                walletOpenRef.current = false
                await options.durableRecovery?.releaseUnsubmitted()
                throw failure
              }
            },
            onBeforeWriteAborted: async () => {
              walletOpenRef.current = false
              gate?.onRejected()
              await options.durableRecovery?.releaseUnsubmitted()
              await options.onBeforeWriteAborted?.()
            },
            onWriteRejected: async () => {
              walletOpenRef.current = false
              gate?.onRejected()
              await options.durableRecovery?.releaseUnsubmitted()
              await options.onWriteRejected?.()
            },
            onWriteSubmitted: async (hash: Hex) => {
              gate?.afterSubmit(hash)
              await options.durableRecovery?.submitted(hash, viaSafe)
            },
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
              if (!isCurrent()) throw new Error('This review closed. Open the action again before sending.')
              assertReviewedWallet({ account, connectorUid, chainId: request.chainId, safe: viaSafe })
            },
            write: simulated => {
              walletInvoked = true
              walletOpenRef.current = true
              return writeContractAsync({ ...simulated, chainId: request.chainId }).finally(() => { walletOpenRef.current = false })
            },
            onPhase: next => { if (isCurrent()) setPhase(next) },
          })
          if (!isCurrent()) return null
          if (viaSafe) {
            // A reply that is not a 32-byte hash names no proposal and no execution.
            if (!isHash(txHash)) throw new Error(SAFE_REPLY_UNREADABLE)
            // The registry holds the call from here; this flow only shows it.
            inFlightRef.current = false
            showProposal(
              recordProposal(
                { chainId: request.chainId, safe: account, call: sentCall, proposalHash: txHash, hold: handle },
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
        }
        return handle ? await handle.send(publicClient, execute) : await execute(null)
      } catch (e) {
        walletOpenRef.current = false
        if (!isCurrent()) return null
        inFlightRef.current = false
        // The call is held: its state says why, and a hash it already has is followed.
        if (e instanceof WriteHeldError) {
          const tracked = apply(e.state)
          // The refusal's state carries no exit; the chain-checked read decides whether this hold has one now.
          if (handle) void handle.state(publicClient).then(next => apply(next, false)).catch(() => undefined)
          return tracked
        }
        if (e instanceof WriteHoldStaleReviewError) {
          // Another window sent this intent while the review was open: its message, or its result if it already settled.
          if (e.settled && 'hash' in e.settled) {
            setSettledNote(e.settled.result === 'failed' ? WRITE_HOLD_REVERTED_LINE : 'Your earlier transaction went through.')
            setPhase('submitted')
          } else { setError(e.message); setPhase('error') }
          return null
        }
        if (e instanceof WriteHoldBusyError || e instanceof WriteHoldNonceError) {
          setError(e.message)
          setPhase('error')
          return null
        }
        if (e instanceof SubmittedContractWriteError && typeof e.hash === 'string' && isHash(e.hash)) {
          if (viaSafe) {
            const call = callOf(request)
            showProposal(recordProposal({ chainId: request.chainId, safe: account, call, proposalHash: e.hash, hold: handle },
              publicClient, true, () => refreshDetachedProposal(proposalKey(request.chainId, account, call), request.chainId)))
          } else setHash(e.hash)
          setPhase('pending')
          return e.hash
        }
        // A write that may have reached the wallet stays held, whatever was thrown.
        if (handle && walletInvoked) {
          try {
            const state = await handle.state(publicClient)
            if (state.status !== 'clear') return apply(state)
          } catch {
            setError(WRITE_HOLD_UNCHECKED_LINE)
            setPhase('submitted')
            return null
          }
        }
        if (e instanceof TransactionReviewCancelledError) {
          setPhase('idle')
          return null
        }
        setError(friendlyTxError(e))
        setPhase('error')
        return null
      }
    },
    [chainId, isConnected, isCenterWallet, publicClient, refreshDetachedProposal, showProposal, switchChainAsync, writeContractAsync, watchHold, apply],
  )

  /**
   * Clear this flow's state, as a new review opens. A Safe proposal stays in
   * the registry: still followed while pending, and still held when unproven,
   * since the user may not have seen its line.
   */
  const reset = useCallback(() => {
    generation.current += 1
    inFlightRef.current = false
    setPhase('idle')
    setError(null)
    setHash(null)
    showProposal(null)
    watchHold(null)
    setSettledNote(null)
  }, [showProposal, watchHold])

  /** The user checked their wallet: the SDK releases the record they saw, if it is still the one held. */
  const exitHold = useCallback(async (shown: WriteHoldState) => {
    const current = holdRef.current
    if (!current || !publicClient) return
    exitingRef.current = true
    try {
      const { released, state } = await current.exit(shown, { checkedWallet: true }, publicClient)
      if (released) {
        await releasedRef.current?.()
        releasedRef.current = null
        const key = shownKeyRef.current
        // The hold is released: the registry's entry for this call no longer stands in the way of a fresh proposal.
        if (key && holdsCall(proposals.get(key))) {
          proposals.delete(key)
          notifyProposals()
        }
        reset()
      } else if (state.status === 'clear' && state.settled && 'hash' in state.settled) {
        // A confirmation landed meanwhile: the SDK settled it on authenticated evidence. This is never an abandon.
        const settle = settledRef.current
        settledRef.current = null
        await settle?.({ hash: state.settled.hash, result: state.settled.result })
        showHeld(state)
      } else apply(state)
    } catch { /* The hold stays; the next look shows why. */ } finally { exitingRef.current = false }
  }, [publicClient, reset, apply, showHeld])

  /** What the SDK says of a stored write (hashed or not), so a panel shows its line and offers an exit only when the SDK does. */
  const storedHold = useCallback(async (write: StoredWrite): Promise<StoredHold> => {
    try {
      const client = getPublicClient(wagmiConfig, { chainId: write.chainId as never }) as unknown as Parameters<WriteHoldHandle['state']>[0] | undefined
      if (!client) return null
      const state = await openStored(write).state(client)
      if (state.status === 'clear') return state.settled && 'hash' in state.settled ? { settled: { hash: state.settled.hash, result: state.settled.result } } : null
      return { exit: state.exit, line: state.line, checked: state.checked, ...('warning' in state && state.warning ? { warning: state.warning } : {}) }
    } catch { return null }
  }, [])

  /**
   * A domain reservation main's journal left with no SDK record (hashless, hashed or a Safe proposal): adopt it into a
   * hold, keeping its hash or proposal hash and the time it was saved, and keep the uncertainty, so the SDK offers its warned, explicit exit. Nothing is ever released here. A call that
   * already has a hold, or a settlement, is left as it is.
   */
  const adoptStored = useCallback(async (write: StoredWrite): Promise<void> => {
    try {
      const client = getPublicClient(wagmiConfig, { chainId: write.chainId as never }) as unknown as Parameters<WriteHoldHandle['state']>[0] | undefined
      if (!client) return
      const stored = openStored(write)
      const state = await stored.state(client)
      if (state.status !== 'clear' || state.settled) return
      // Atomic: reserved only when the key still has no hold and no settlement, under the lock; otherwise the current
      // state comes back and nothing is taken. A saved hash (or a Safe proposal's hash) is verified and kept.
      await stored.adopt(state, write.safeProposal && write.hash ? { safe: { safeTxHash: write.hash }, submittedAt: write.submittedAt } : write.hash ? { hash: write.hash, submittedAt: write.submittedAt } : undefined, client)
    } catch { /* The reservation stays in its journal, and the panel's own recovery still applies. */ }
  }, [])

  /**
   * A write saved by a domain journal that a reload left held, with no flow open: the SDK's exit for
   * its exact call. True when the call is no longer held, so the caller may clear its own reservation.
   */
  const exitStored = useCallback(async (write: StoredWrite): Promise<StoredExit> => {
    try {
      const client = getPublicClient(wagmiConfig, { chainId: write.chainId as never }) as unknown as Parameters<WriteHoldHandle['state']>[0] | undefined
      if (!client) return { outcome: 'held' }
      const stored = openStored(write)
      const settledOf = (state: WriteHoldState): StoredExit =>
        state.status === 'clear' && state.settled && 'hash' in state.settled
          ? { outcome: 'settled', hash: state.settled.hash, result: state.settled.result }
          // Cleared with no evidence handed back: not an abandon, so the caller's reservation stays.
          : { outcome: 'held' }
      const state = await stored.state(client)
      if (state.status === 'clear') return settledOf(state)
      if (!state.exit) return { outcome: 'held' }
      const { released, state: after } = await stored.exit(state, { checkedWallet: true }, client)
      return released ? { outcome: 'released' } : settledOf(after)
    } catch { return { outcome: 'held' } }
  }, [])

  /**
   * Close the current confirmation. The durable recovery owner remains held;
   * dismissing an unproven display is never evidence that it can be sent again.
   * A pending Safe proposal stays followed in the background.
   */
  const dismiss = useCallback(() => {
    reset()
  }, [reset])

  // The SDK's line for each state; only a state with an exit gets the button.
  const heldView = !held || held.status === 'clear' || wallet
    ? null
    : held.status === 'pending-known-hash'
      ? !shownKey && phase === 'pending' && receipt.isError && !receiptData
        ? { line: held.line, warning: '', label: WRITE_EXIT_LABEL, exit: null, notice: held.notice }
        : null
      : held.exit
        ? {
            line: held.line,
            warning: 'warning' in held && held.warning ? held.warning : writeExitMessage(held.record.call),
            label: WRITE_EXIT_LABEL,
            notice: held.notice,
            exit: () => { void exitHold(held) },
          }
        : null

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
    /** A write the chain has not placed: its line, what sending again risks, and the user's exit. */
    held: heldView,
    /** The SDK's in-tab notice, whenever the hold carries one, whether or not an exit is offered. */
    holdNotice: held && held.status !== 'clear' ? (held.notice ?? null) : null,
    /** Whether the connected writer is a Safe connector. */
    isSafe,
    error: effectiveError,
    hash: shownKey ? (proposal?.executionHash ?? null) : hash,
    safeProposalHash: awaitingProposal,
    /** The wallet's original reply, retained if its durable handoff needs repair. */
    submissionHash: shownKey ? (proposal?.proposalHash ?? null) : hash,
    submissionIsSafe: !!shownKey,
    safeNonceGuidance: awaitingProposal ? SAFE_NONCE_GUIDANCE : null,
    receipt: shownKey ? (proposal?.receipt ?? null) : (receiptData ?? null),
    /** The transaction has a hash, but its result could not be confirmed here. */
    confirmationUncertain: !!exitOffered || (!shownKey && phase === 'pending' && receipt.isError && !receiptData),
    send,
    exitStored,
    storedHold,
    adoptStored,
    reset,
    dismiss,
  }
}
