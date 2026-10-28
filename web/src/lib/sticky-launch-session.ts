import { isAddress, isHash, type Hex } from 'viem'
import type { RelayrPayment, RelayrQuote } from '@bananapus/nana-sdk-core/review/relayr'
import { errorLine, ReviewLineError, TransactionReviewCancelledError, writeIntentKey, type SavedAttempt } from '@bananapus/nana-sdk-core/review'
import { requireSingleHomeChain, validateLaunchCall, type LaunchPlan, type LaunchTarget } from '@/lib/sticky-launch-plan'

export const STICKY_LAUNCH_KEY = 'sticky-launch-pending-v1'
export type LaunchResult = { hash: Hex; projectId: string; token: `0x${string}` }
/** `exited`: the user took the SDK's exit for this attempt, so no later step asks for mined-failure proof of it. */
export type LaunchSubmission = { hash?: Hex; proposalHash?: Hex; started: boolean; exited?: boolean; settled?: 'success' | 'failed' }
export type LaunchPaymentSubmission = LaunchSubmission & { option: RelayrPayment; confirmed?: boolean }
export type StickyLaunchSession = {
  version: 1
  plan: LaunchPlan
  mode: 'direct' | 'relayr' | 'center'
  published: boolean
  bundleUuid?: string
  quote?: RelayrQuote
  direct?: LaunchSubmission
  payment?: LaunchPaymentSubmission
  directAttempts?: LaunchSubmission[]
  paymentAttempts?: LaunchPaymentSubmission[]
  candidates: Record<number, Hex[]>
  results: Record<number, LaunchResult>
  /** Deployments once authenticated, kept apart from the display results a refresh rebuilds: a later failed read never forgets them. */
  proven?: Record<number, LaunchResult>
  listing: {
    state: 'pending' | 'published' | 'unlisted' | 'unavailable'
    intentId?: string
    requested?: boolean
    /** The user checked an uncertain sponsor request and took the exit: it no longer blocks. */
    requestExited?: boolean
    /** When the sponsor request was saved (ms): discovery that stays empty past the SDK's 30 minutes earns the check. */
    requestedAt?: number
    selfPaid?: boolean
    error?: string
    recorded: Record<number, Hex>
    /** The listing message the wallet signed with a creation still confirming: published from it once the creation is. */
    signed?: { message: string; signature: Hex }
  }
  error?: string
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export function validateStickyLaunch(value: unknown): StickyLaunchSession {
  // Older multi-target records retain their evidence; authority-bearing actions enforce one home below.
  const session = value as StickyLaunchSession | null
  if (!session || session.version !== 1 || !session.plan || !isAddress(session.plan.owner) ||
      typeof session.plan.id !== 'string' || !session.plan.id || !isAddress(session.plan.token) ||
      typeof session.plan.name !== 'string' || !session.plan.name || typeof session.plan.symbol !== 'string' || !session.plan.symbol ||
      typeof session.plan.tokenName !== 'string' || typeof session.plan.tokenSymbol !== 'string' ||
      !Number.isInteger(session.plan.tokenDecimals) || session.plan.tokenDecimals < 0 || session.plan.tokenDecimals > 255 ||
      typeof session.plan.cashOutTaxRate !== 'string' || !/^\d+$/.test(session.plan.cashOutTaxRate) || BigInt(session.plan.cashOutTaxRate) > 9999n ||
      typeof session.plan.soulbound !== 'boolean' || typeof session.plan.projectUri !== 'string' || !session.plan.projectUri ||
      !['production', 'testnet'].includes(session.plan.environment) ||
      !Array.isArray(session.plan.targets) || !session.plan.targets.length || session.plan.targets.length > 8 ||
      !['direct', 'relayr', 'center'].includes(session.mode) || typeof session.published !== 'boolean' ||
      !session.candidates || !session.results || !session.listing || !session.listing.recorded ||
      !['pending', 'published', 'unlisted', 'unavailable'].includes(session.listing.state)) {
    throw new ReviewLineError('The saved launch is unreadable. Keep its recovery data; do not launch it again.')
  }
  const ids = new Set<number>()
  for (const target of session.plan.targets) {
    if (!Number.isSafeInteger(target.chainId) || ids.has(target.chainId) ||
        !isAddress(target.deployer) || !isAddress(target.controller) || !isAddress(target.projects) ||
        !target.call || target.call.chain !== target.chainId ||
        target.call.target.toLowerCase() !== target.deployer.toLowerCase() ||
        !/^0x00d5ce37[0-9a-f]+$/i.test(target.call.data) || !/^\d+$/.test(target.call.value) ||
        !Array.isArray(session.candidates[target.chainId]) ||
        session.candidates[target.chainId].some(hash => !isHash(hash))) {
      throw new ReviewLineError('The saved launch calls are invalid. Keep its recovery data.')
    }
    validateLaunchCall(session.plan, target)
    ids.add(target.chainId)
  }
  if ((session.mode === 'direct' && ids.size !== 1) || (session.quote && !session.published) ||
      (session.listing.state === 'published' && !session.listing.intentId) ||
      (session.listing.requested !== undefined && typeof session.listing.requested !== 'boolean') ||
      (session.listing.selfPaid !== undefined && typeof session.listing.selfPaid !== 'boolean') ||
      (session.listing.requested && session.listing.selfPaid) ||
      (session.listing.signed !== undefined && (typeof session.listing.signed.message !== 'string' ||
        !/^0x[0-9a-fA-F]+$/.test(session.listing.signed.signature)))) {
    throw new ReviewLineError('The saved launch publication is invalid. Keep its recovery data.')
  }
  for (const history of [session.directAttempts, session.paymentAttempts]) {
    if (history !== undefined && (!Array.isArray(history) || history.some(attempt => !attempt?.started || !attempt.hash))) {
      throw new ReviewLineError('The saved launch attempts are invalid. Keep their recovery data.')
    }
  }
  for (const submitted of [session.direct, session.payment, ...(session.directAttempts ?? []), ...(session.paymentAttempts ?? [])]) {
    if (submitted && (typeof submitted.started !== 'boolean' ||
        (submitted.settled !== undefined && !['success', 'failed'].includes(submitted.settled)) ||
        (submitted.hash !== undefined && !isHash(submitted.hash)) ||
        (submitted.proposalHash !== undefined && !isHash(submitted.proposalHash)) ||
        (!submitted.started && (!!submitted.hash || !!submitted.proposalHash)))) {
      throw new ReviewLineError('The saved launch submission is invalid. Keep its recovery data.')
    }
  }
  return session
}

/** A write is durable before a signature or external publication can escape. */
export function createStickyLaunchStore(storage: Store) {
  return {
    load(): StickyLaunchSession | null {
      const raw = storage.getItem(STICKY_LAUNCH_KEY)
      return raw === null ? null : validateStickyLaunch(JSON.parse(raw))
    },
    save(session: StickyLaunchSession): StickyLaunchSession {
      validateStickyLaunch(session)
      const raw = JSON.stringify(session)
      storage.setItem(STICKY_LAUNCH_KEY, raw)
      if (storage.getItem(STICKY_LAUNCH_KEY) !== raw) throw new ReviewLineError('Launch recovery could not be saved. Nothing further was sent.')
      return JSON.parse(raw) as StickyLaunchSession
    },
    remove() {
      storage.removeItem(STICKY_LAUNCH_KEY)
      if (storage.getItem(STICKY_LAUNCH_KEY) !== null) throw new ReviewLineError('The saved launch could not be cleared.')
    },
  }
}

export const launchComplete = (session: StickyLaunchSession) =>
  session.plan.targets.every(target => !!session.results[target.chainId])

export const launchCanClear = (session: StickyLaunchSession) => launchComplete(session) ||
  (!session.published && !session.direct?.started && !session.payment?.started && !session.listing.requested)

/** An authenticated deployment is saved: the launch went through, whatever a later read says. */
export const launchEstablished = (session: StickyLaunchSession) => Object.keys(session.proven ?? {}).length > 0
/** How long a sponsor request that discovery cannot find keeps waiting before it earns the explicit check. */
export const SPONSOR_WINDOW_MS = 30 * 60_000
/**
 * A sponsored deployment was requested and discovery cannot say what happened: past its 30 minutes, or when discovery
 * failed with no candidate, it is a saved attempt whose recovery is the SDK's. Within the window it keeps waiting.
 */
export function sponsorUnresolved(session: StickyLaunchSession, now = Date.now()): boolean {
  if (!session.listing.requested || session.listing.selfPaid || launchComplete(session) || launchEstablished(session) || session.direct?.started || session.payment?.started) return false
  const known = session.plan.targets.some(target => session.candidates[target.chainId]?.length)
  return now - (session.listing.requestedAt ?? now) >= SPONSOR_WINDOW_MS || (!!session.error && !known)
}

/** A launch's saved attempt, for the SDK's recovery: which submission it is and what the journal saved of it. */
export type SavedLaunch = { kind: 'direct' | 'payment' | 'sponsor'; attempt: SavedAttempt<true> }
/** Where a launch submission is held: `namespace` now, and `earlier` keys an older deploy held it under. */
type LaunchCall = { chainId: number; call: { to: `0x${string}`; data: Hex; value: bigint }; namespace: string; earlier?: string[] }

/**
 * The saved attempt of a launch, from what its journal saved and nothing fresh: the started direct or payment
 * submission, or a sponsor request discovery could not find in its window. Older multi-pool records are read-only
 * recovery and have none. Recovery decides; the journal only says what was saved.
 */
export function launchAttempt(session: StickyLaunchSession, deps: {
  /** Where the submission is held: its chain, call and intent. */
  key: (session: StickyLaunchSession, kind: 'direct' | 'payment') => LaunchCall
  /** The journal now, read fresh. */
  load: () => StickyLaunchSession | null
  /** Whether the connected wallet is a Safe, for a submission saved before its proposal hash. */
  safe: () => boolean
  /** The domain check of one transaction: this launch's deployment, or its funding. */
  verify: (kind: 'direct' | 'payment', hash: Hex) => Promise<boolean>
}): SavedLaunch | null {
  const { plan } = session
  if (plan.targets.length !== 1) return null
  const proven = () => launchEstablished(session) || launchComplete(session)
  // Rule E's journal re-read: a success the journal saved is never retired by a check or an exit.
  const confirmRetirable = async () => {
    const latest = deps.load()
    return !latest || !(launchEstablished(latest) || launchComplete(latest) || latest.direct?.settled === 'success' || latest.payment?.settled === 'success')
  }
  const kind = session.payment?.started ? 'payment' : session.direct?.started ? 'direct' : null
  if (kind) {
    const submitted = session[kind]!
    const { chainId, call, namespace, earlier = [] } = deps.key(session, kind)
    const history = (kind === 'direct' ? session.directAttempts : session.paymentAttempts) ?? []
    const before = history.flatMap(attempt => [attempt.hash, attempt.proposalHash]).filter((hash): hash is Hex => !!hash)
    const hash = submitted.hash && submitted.hash !== submitted.proposalHash ? submitted.hash : undefined
    return { kind, attempt: {
      chainId, account: plan.owner, safe: !!submitted.proposalHash || deps.safe(), namespaces: [namespace, ...earlier], call,
      saved: { started: true, ...(submitted.proposalHash ? { safeTxHash: submitted.proposalHash } : {}), ...(hash ? { hash } : {}), ...(before.length ? { before } : {}) },
      confirmRetirable,
      authenticate: async found => ((found ? await deps.verify(kind, found) : proven()) ? { result: 'proven', value: true } : { result: 'unknown' }),
    } }
  }
  if (!sponsorUnresolved(session)) return null
  // A sponsor request sends nothing from this wallet: its hold is never reserved, so only discovery can prove it.
  return { kind: 'sponsor', attempt: {
    chainId: plan.targets[0].chainId, account: plan.owner,
    namespaces: [writeIntentKey('sticky-sponsor', { plan: plan.id, requestedAt: session.listing.requestedAt ?? 0 })],
    saved: { started: true, ...(session.listing.requestedAt ? { submittedAt: session.listing.requestedAt } : {}) },
    confirmRetirable,
    authenticate: async () => (proven() ? { result: 'proven', value: true } : { result: 'unknown' }),
  } }
}

export type SubmissionCallbacks = {
  beforeWrite: () => Promise<void>
  rejected: () => void
  submitted: (hash: Hex, proposalHash?: Hex) => void
}

/** What became of a listing signed with the creation: published under its id, or not, and why. */
export type ListingCallbacks = {
  published: (intentId: string) => void
  failed: (message: string) => void
  /** The wallet signed the listing, but its creation is still confirming: kept to publish once it is. */
  signed: (message: string, signature: Hex) => void
}

/** The hold's authenticated result for a launch submission. */
export type LaunchSettlement = { hash: Hex; result: 'success' | 'failed' }

export type StickyLaunchPorts = {
  store: ReturnType<typeof createStickyLaunchStore>
  guard: (owner: `0x${string}`) => void
  quote: (plan: LaunchPlan, rememberUuid: (uuid: string) => void, beforePublish: () => void) => Promise<RelayrQuote>
  status: (session: StickyLaunchSession) => Promise<Record<number, Hex[]>>
  choosePayment: (session: StickyLaunchSession) => Promise<RelayrPayment>
  /**
   * The wallet's creation, under one review: with `listing`, the listing message is signed in the same review and
   * published once the creation is sent.
   */
  sendDirect: (session: StickyLaunchSession, callbacks: SubmissionCallbacks, listing?: ListingCallbacks) => Promise<void>
  sendPayment: (session: StickyLaunchSession, callbacks: SubmissionCallbacks) => Promise<void>
  verifyPayment: (session: StickyLaunchSession) => Promise<boolean>
  requireRetry: (session: StickyLaunchSession, kind: 'direct' | 'payment', purpose: 'retry' | 'retire') => Promise<void>
  verifyDeployment: (session: StickyLaunchSession, target: LaunchTarget, hash: Hex) => Promise<LaunchResult | null>
  /** Signs the listing under its own review and publishes it: its id. */
  publishListing: (plan: LaunchPlan) => Promise<string>
  /** Publishes the listing from the signature the wallet already gave, asking nothing: its id. */
  publishSignedListing: (plan: LaunchPlan, signed: { message: string; signature: Hex }) => Promise<string>
  sponsor: (session: StickyLaunchSession, beforeRequest: () => void) => Promise<void>
  record: (session: StickyLaunchSession, chainId: number, result: LaunchResult) => Promise<boolean>
  /** Whether the SDK lets the saved attempt of this launch be discarded (its followed success retired first). */
  canDiscard: (session: StickyLaunchSession) => Promise<boolean>
  changed?: (session: StickyLaunchSession | null) => void
}

/** Sticky's deploy call has no replay nonce. A published unknown quote is never replaced. */
export function createStickyLaunchController(ports: StickyLaunchPorts) {
  let busy = false
  const save = (session: StickyLaunchSession) => {
    const saved = ports.store.save(session)
    ports.changed?.(saved)
    return saved
  }
  const load = () => {
    const session = ports.store.load()
    if (!session) throw new ReviewLineError('No launch is saved.')
    return session
  }
  const exclusively = async <T>(run: () => Promise<T>): Promise<T> => {
    if (busy) throw new ReviewLineError('This launch is already being processed.')
    busy = true
    try { return await run() } finally { busy = false }
  }
  /** Whether the launch still has a listing to publish. */
  const unlisted = (session: StickyLaunchSession) => !session.listing.intentId && session.listing.state !== 'unavailable'
  const listed: ListingCallbacks = {
    published: intentId => { const session = load(); save({ ...session, listing: { ...session.listing, state: 'published', intentId, error: undefined } }) },
    failed: message => { const session = load(); save({ ...session, listing: { ...session.listing, state: 'unlisted', error: message } }) },
    signed: (message, signature) => { const session = load(); save({ ...session, listing: { ...session.listing, signed: { message, signature } } }) },
  }
  /** A launch recovered with its listing signed before the creation confirmed: that listing is published now. */
  async function publishSigned(session: StickyLaunchSession) {
    const { signed } = session.listing
    if (!signed || session.listing.intentId || !launchComplete(session)) return session
    try {
      const intentId = await ports.publishSignedListing(session.plan, signed)
      return save({ ...session, listing: { ...session.listing, state: 'published', intentId, signed: undefined, error: undefined } })
    } catch (error) {
      // Kept: the next check publishes it again.
      return save({ ...session, listing: { ...session.listing, error: error instanceof Error ? errorLine(error) : 'Listing will need another check.' } })
    }
  }
  async function listing(session: StickyLaunchSession) {
    requireSingleHomeChain(session.plan.targets)
    if (!unlisted(session)) return session
    try {
      ports.guard(session.plan.owner)
      listed.published(await ports.publishListing(session.plan))
    } catch (error) {
      // Closing its review is no failure of the listing: the launch stops there, as it was.
      if (error instanceof TransactionReviewCancelledError) throw error
      listed.failed(error instanceof Error ? errorLine(error) : 'Listing unavailable.')
    }
    return load()
  }
  async function refreshSession(session: StickyLaunchSession) {
    // Authenticated results of an older journal join `proven` before the display results are cleared.
    let current = save({ ...session, results: {}, proven: { ...session.results, ...session.proven }, ...(session.listing.requested && !session.listing.requestedAt ? { listing: { ...session.listing, requestedAt: Date.now() } } : {}) })
    if (current.quote || current.listing.requested || current.direct?.started) {
      try {
        const found = await ports.status(current)
        const candidates = { ...current.candidates }
        for (const target of current.plan.targets) {
          candidates[target.chainId] = [...new Set([...candidates[target.chainId], ...(found[target.chainId] ?? [])])]
        }
        current = save({ ...current, candidates, error: undefined })
      } catch (error) {
        current = save({ ...current, error: error instanceof Error ? errorLine(error) : 'Could not check the saved launch.' })
      }
    }
    // Previously confirmed receipts must remain canonical; one unavailable chain cannot renew old proof.
    const results: Record<number, LaunchResult> = {}
    for (const target of current.plan.targets) {
      for (const hash of current.candidates[target.chainId]) {
        try {
          const result = await ports.verifyDeployment(current, target, hash)
          if (result) { results[target.chainId] = result; break }
        } catch { /* A bad candidate cannot prevent another canonical receipt from proving this chain. */ }
      }
    }
    // Merge, never overwrite: a settlement or proof another writer saved while this refresh awaited is kept.
    const latest = ports.store.load()
    const kept = <T extends LaunchSubmission>(mine: T | undefined, theirs: T | undefined): T | undefined =>
      mine && theirs?.settled && !mine.settled && theirs.hash ? { ...mine, hash: theirs.hash, settled: theirs.settled } : mine
    current = save({ ...current, results, proven: { ...latest?.proven, ...current.proven, ...results },
      direct: kept(current.direct, latest?.direct), payment: kept(current.payment, latest?.payment) })
    if (current.payment?.hash) {
      let confirmed = false
      try { confirmed = await ports.verifyPayment(current) } catch { /* Unknown funding keeps its exact intent. */ }
      current = save({ ...current, payment: { ...current.payment, confirmed } })
    }
    if (current.listing.intentId && current.plan.targets.length === 1) {
      for (const target of current.plan.targets) {
        const result = current.results[target.chainId]
        if (!result || current.listing.recorded[target.chainId] === result.hash) continue
        try {
          if (await ports.record(current, target.chainId, result)) {
            current = save({ ...current, listing: { ...current.listing, recorded: { ...current.listing.recorded, [target.chainId]: result.hash } } })
          }
        } catch (error) {
          current = save({ ...current, listing: { ...current.listing, error: error instanceof Error ? errorLine(error) : 'Listing will need another check.' } })
        }
      }
    }
    return current
  }
/** The hold's authenticated hash is the submission's hash from here: the journal's own checks run on that transaction. */
  function saveSettlement(session: StickyLaunchSession, kind: 'direct' | 'payment', { hash, result }: { hash: Hex; result: 'success' | 'failed' }) {
    const chainId = session.plan.targets[0].chainId
    const candidates = { ...session.candidates, [chainId]: [...new Set([...session.candidates[chainId], hash])] }
    return kind === 'direct'
      ? save({ ...session, direct: { ...session.direct, started: true, hash, settled: result }, candidates })
      : save({ ...session, payment: { ...session.payment!, started: true, hash, settled: result }, candidates })
  }
  function callbacks(kind: 'direct' | 'payment'): SubmissionCallbacks {
    return {
      async beforeWrite() {
        const session = load()
        requireSingleHomeChain(session.plan.targets)
        ports.guard(session.plan.owner)
        if (session[kind === 'direct' ? 'directAttempts' : 'paymentAttempts']?.length) {
          await ports.requireRetry(session, kind, 'retry')
          ports.guard(session.plan.owner)
          requireSingleHomeChain(session.plan.targets)
        }
        if (session[kind]?.started) throw new ReviewLineError('This launch already has a wallet submission. Recover it before continuing.')
        if (kind === 'direct') save({ ...session, direct: { started: true } })
        else if (session.payment) save({ ...session, payment: { ...session.payment, started: true } })
      },
      rejected() {
        const session = load()
        if (kind === 'direct') save({ ...session, direct: undefined })
        else save({ ...session, payment: undefined })
      },
      submitted(hash, proposalHash) {
        const session = load()
        if (kind === 'direct') {
          const chainId = session.plan.targets[0].chainId
          save({ ...session, direct: { started: true, hash, proposalHash },
            candidates: { ...session.candidates, [chainId]: [...new Set([...session.candidates[chainId], hash])] } })
        } else if (session.payment) save({ ...session, payment: { ...session.payment, started: true, hash, proposalHash } })
      },
    }
  }
  return {
    load: ports.store.load,
    prepare(plan: LaunchPlan, capability: 'sponsored' | 'self-paid' | 'unavailable') {
      requireSingleHomeChain(plan.targets)
      ports.guard(plan.owner)
      if (ports.store.load()) throw new ReviewLineError('Finish or resume the saved launch first.')
      return save({ version: 1, plan, mode: capability === 'sponsored' ? 'center' : 'direct',
        published: false, candidates: Object.fromEntries(plan.targets.map(target => [target.chainId, []])), results: {},
        listing: { state: capability === 'unavailable' ? 'unavailable' : 'pending', recorded: {} } })
    },
    run: () => exclusively(async () => {
      const saved = load()
      requireSingleHomeChain(saved.plan.targets)
      let session = await refreshSession(saved)
      if (launchComplete(session)) return publishSigned(session)
      ports.guard(session.plan.owner)
      if (session.direct?.started || session.payment?.started || (session.listing.requested && !session.listing.selfPaid)) return session
      if (session.mode === 'center') {
        // A sponsored launch is its signed listing: one review of the message, then the sponsor's request.
        session = await listing(session)
        if (!session.listing.intentId) {
          session = save({ ...session, mode: 'direct' })
        } else {
          await ports.sponsor(session, () => {
            ports.guard(session.plan.owner)
            requireSingleHomeChain(session.plan.targets)
            if (session.listing.requested) throw new ReviewLineError('This sponsor request was already published.')
            // Save immediately before request: a timeout may still queue the deployment.
            session = save({ ...session, listing: { ...session.listing, requested: true, requestedAt: Date.now() } })
          })
          if (!session.listing.requested) throw new ReviewLineError('The sponsor request was not durably recorded.')
          return refreshSession(load())
        }
      }
      if (session.mode === 'direct') {
        await ports.sendDirect(session, callbacks('direct'), unlisted(session) ? listed : undefined)
        return refreshSession(load())
      }
      if (!session.published) {
        const quote = await ports.quote(session.plan, uuid => { session = save({ ...session, bundleUuid: uuid }) }, () => {
          ports.guard(session.plan.owner)
          requireSingleHomeChain(session.plan.targets)
          if (session.published) throw new ReviewLineError('This launch was already published.')
          session = save({ ...session, published: true })
        })
        if (!session.published) throw new ReviewLineError('The launch publication was not durably recorded.')
        session = save({ ...session, quote, bundleUuid: quote.bundle_uuid })
      }
      if (!session.quote) throw new ReviewLineError('This launch may already be published. Keep it saved and recover its deployment hashes; publishing again could create duplicates.')
      const option = await ports.choosePayment(session)
      if (!session.quote.payment_info.some(quoted => JSON.stringify(quoted) === JSON.stringify(option))) {
        throw new ReviewLineError('Choose one of the saved quote’s actual payment options.')
      }
      ports.guard(session.plan.owner)
      session = save({ ...session, payment: { option, started: false } })
      await ports.sendPayment(session, callbacks('payment'))
      return refreshSession(load())
    }),
    refresh: () => exclusively(async () => publishSigned(await refreshSession(load()))),
    retry: () => exclusively(async () => {
      const saved = load()
      requireSingleHomeChain(saved.plan.targets)
      const session = await refreshSession(saved)
      if (launchComplete(session)) return publishSigned(session)
      ports.guard(session.plan.owner)
      const kind = session.payment?.started ? 'payment' : 'direct'
      const submitted = session[kind]
      if (!submitted?.started || !submitted.hash) {
        throw new ReviewLineError('This submission has no recorded transaction hash. Check your wallet, then use the exit shown for it; another receipt cannot release an unknown wallet submission.')
      }
      await ports.requireRetry(session, kind, 'retry')
      ports.guard(session.plan.owner)
      return kind === 'direct'
        ? save({ ...session, directAttempts: [...(session.directAttempts ?? []), submitted], direct: undefined })
        : save({ ...session, paymentAttempts: [...(session.paymentAttempts ?? []), session.payment!], payment: undefined })
    }),
    /** A settlement the SDK followed for the submission this launch started: its hash and result join the journal. */
    record: (kind: 'direct' | 'payment', settled: LaunchSettlement) => exclusively(async () => {
      const session = load()
      return session[kind]?.started ? saveSettlement(session, kind, settled) : session
    }),
    /**
     * The SDK retired the saved attempt on the user's exit or check: the journal records it as exited, so no later step
     * asks for its failure proof, and the flow reopens. A sponsor request reopens for a deliberate new request. A success
     * saved meanwhile is never retired.
     */
    exited: (kind: 'direct' | 'payment' | 'sponsor') => exclusively(async () => {
      const session = load()
      if (launchEstablished(session) || session.direct?.settled === 'success' || session.payment?.settled === 'success') return session
      if (kind === 'sponsor') {
        return session.listing.requested && !session.listing.selfPaid ? save({ ...session, listing: { ...session.listing, requested: false, requestExited: true } }) : session
      }
      const submitted = session[kind]
      if (!submitted?.started) return session
      return kind === 'direct'
        ? save({ ...session, directAttempts: submitted.hash ? [...(session.directAttempts ?? []), { ...submitted, exited: true }] : session.directAttempts, direct: undefined })
        : save({ ...session, paymentAttempts: submitted.hash ? [...(session.paymentAttempts ?? []), { ...session.payment!, exited: true }] : session.paymentAttempts, payment: undefined })
    }),
    selfPay: () => exclusively(async () => {
      const session = load()
      requireSingleHomeChain(session.plan.targets)
      ports.guard(session.plan.owner)
      if (session.mode !== 'center' || session.listing.requested) {
        throw new ReviewLineError('This launch may already be running. Keep its saved recovery and check again.')
      }
      return save({ ...session, mode: 'direct',
        listing: { ...session.listing, selfPaid: true } })
    }),
    list: () => exclusively(async () => {
      const listed = await listing(load()).catch(error => {
        if (error instanceof TransactionReviewCancelledError) return load()
        throw error
      })
      return refreshSession(listed)
    }),
    addHash: (chainId: number, hash: Hex) => exclusively(async () => {
      const session = load()
      if (!isHash(hash) || !session.candidates[chainId]) throw new ReviewLineError('Enter a transaction hash for one of this launch’s chains.')
      return refreshSession(save({ ...session, candidates: { ...session.candidates, [chainId]: [...new Set([...session.candidates[chainId], hash])] } }))
    }),
    clear: () => exclusively(async () => {
      const session = await refreshSession(load())
      if (!launchCanClear(session)) throw new ReviewLineError('This launch has published or submitted calls. Recover it before starting another.')
      // The SDK decides whether its saved attempt may go: never while held, or with a success not yet followed.
      if (!(await ports.canDiscard(session))) throw new ReviewLineError('This launch is still being confirmed. Check again before finishing.')
      // A later success does not let a stale failed-attempt proof be forgotten.
      const history = { ...session, direct: undefined, payment: undefined }
      if (session.directAttempts?.length) await ports.requireRetry(history, 'direct', 'retire')
      if (session.paymentAttempts?.length) await ports.requireRetry(history, 'payment', 'retire')
      ports.store.remove()
      ports.changed?.(null)
    }),
  }
}
