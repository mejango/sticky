import { isAddress, isHash, type Hex } from 'viem'
import type { RelayrPayment, RelayrQuote } from '@bananapus/nana-sdk-core/review/relayr'
import { validateLaunchCall, type LaunchPlan, type LaunchTarget } from '@/lib/sticky-launch-plan'

export const STICKY_LAUNCH_KEY = 'sticky-launch-pending-v1'
export type LaunchResult = { hash: Hex; projectId: string; token: `0x${string}` }
export type LaunchSubmission = { hash?: Hex; proposalHash?: Hex; started: boolean }
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
  listing: {
    state: 'pending' | 'published' | 'unlisted' | 'unavailable'
    intentId?: string
    requested?: boolean
    selfPaid?: boolean
    error?: string
    recorded: Record<number, Hex>
  }
  error?: string
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export function validateStickyLaunch(value: unknown): StickyLaunchSession {
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
    throw new Error('The saved launch is unreadable. Keep its recovery data; do not launch it again.')
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
      throw new Error('The saved launch calls are invalid. Keep its recovery data.')
    }
    validateLaunchCall(session.plan, target)
    ids.add(target.chainId)
  }
  if ((session.mode === 'direct' && ids.size !== 1) || (session.quote && !session.published) ||
      (session.listing.state === 'published' && !session.listing.intentId) ||
      (session.listing.requested !== undefined && typeof session.listing.requested !== 'boolean') ||
      (session.listing.selfPaid !== undefined && typeof session.listing.selfPaid !== 'boolean') ||
      (session.listing.requested && session.listing.selfPaid)) {
    throw new Error('The saved launch publication is invalid. Keep its recovery data.')
  }
  for (const history of [session.directAttempts, session.paymentAttempts]) {
    if (history !== undefined && (!Array.isArray(history) || history.some(attempt => !attempt?.started || !attempt.hash))) {
      throw new Error('The saved launch attempts are invalid. Keep their recovery data.')
    }
  }
  for (const submitted of [session.direct, session.payment, ...(session.directAttempts ?? []), ...(session.paymentAttempts ?? [])]) {
    if (submitted && (typeof submitted.started !== 'boolean' ||
        (submitted.hash !== undefined && !isHash(submitted.hash)) ||
        (submitted.proposalHash !== undefined && !isHash(submitted.proposalHash)) ||
        (!submitted.started && (!!submitted.hash || !!submitted.proposalHash)))) {
      throw new Error('The saved launch submission is invalid. Keep its recovery data.')
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
      if (storage.getItem(STICKY_LAUNCH_KEY) !== raw) throw new Error('Launch recovery could not be saved. Nothing further was sent.')
      return JSON.parse(raw) as StickyLaunchSession
    },
    remove() {
      storage.removeItem(STICKY_LAUNCH_KEY)
      if (storage.getItem(STICKY_LAUNCH_KEY) !== null) throw new Error('The saved launch could not be cleared.')
    },
  }
}

export const launchComplete = (session: StickyLaunchSession) =>
  session.plan.targets.every(target => !!session.results[target.chainId])

export const launchCanClear = (session: StickyLaunchSession) => launchComplete(session) ||
  (!session.published && !session.direct?.started && !session.payment?.started && !session.listing.requested)

export type SubmissionCallbacks = {
  beforeWrite: () => Promise<void>
  rejected: () => void
  submitted: (hash: Hex, proposalHash?: Hex) => void
}

export type StickyLaunchPorts = {
  store: ReturnType<typeof createStickyLaunchStore>
  guard: (owner: `0x${string}`) => void
  review: (plan: LaunchPlan, sponsored: boolean) => Promise<void>
  quote: (plan: LaunchPlan, rememberUuid: (uuid: string) => void, beforePublish: () => void) => Promise<RelayrQuote>
  status: (session: StickyLaunchSession) => Promise<Record<number, Hex[]>>
  choosePayment: (session: StickyLaunchSession) => Promise<RelayrPayment>
  sendDirect: (session: StickyLaunchSession, callbacks: SubmissionCallbacks) => Promise<void>
  sendPayment: (session: StickyLaunchSession, callbacks: SubmissionCallbacks) => Promise<void>
  verifyPayment: (session: StickyLaunchSession) => Promise<boolean>
  requireRetry: (session: StickyLaunchSession, kind: 'direct' | 'payment', purpose: 'retry' | 'retire') => Promise<void>
  verifyDeployment: (session: StickyLaunchSession, target: LaunchTarget, hash: Hex) => Promise<LaunchResult | null>
  publishListing: (plan: LaunchPlan) => Promise<string>
  sponsor: (session: StickyLaunchSession, beforeRequest: () => void) => Promise<void>
  record: (session: StickyLaunchSession, chainId: number, result: LaunchResult) => Promise<boolean>
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
    if (!session) throw new Error('No launch is saved.')
    return session
  }
  const exclusively = async <T>(run: () => Promise<T>): Promise<T> => {
    if (busy) throw new Error('This launch is already being processed.')
    busy = true
    try { return await run() } finally { busy = false }
  }
  async function listing(session: StickyLaunchSession) {
    if (session.listing.intentId || session.listing.state === 'unavailable') return session
    try {
      ports.guard(session.plan.owner)
      const intentId = await ports.publishListing(session.plan)
      return save({ ...session, listing: { ...session.listing, state: 'published', intentId, error: undefined } })
    } catch (error) {
      return save({ ...session, listing: { ...session.listing, state: 'unlisted', error: error instanceof Error ? error.message : 'Listing unavailable.' } })
    }
  }
  async function refreshSession(session: StickyLaunchSession) {
    let current = save({ ...session, results: {} })
    if (current.quote || current.listing.requested || current.direct?.started) {
      try {
        const found = await ports.status(current)
        const candidates = { ...current.candidates }
        for (const target of current.plan.targets) {
          candidates[target.chainId] = [...new Set([...candidates[target.chainId], ...(found[target.chainId] ?? [])])]
        }
        current = save({ ...current, candidates, error: undefined })
      } catch (error) {
        current = save({ ...current, error: error instanceof Error ? error.message : 'Could not check the saved launch.' })
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
    current = save({ ...current, results })
    if (current.payment?.hash) {
      let confirmed = false
      try { confirmed = await ports.verifyPayment(current) } catch { /* Unknown funding keeps its exact intent. */ }
      current = save({ ...current, payment: { ...current.payment, confirmed } })
    }
    if (current.listing.intentId) {
      for (const target of current.plan.targets) {
        const result = current.results[target.chainId]
        if (!result || current.listing.recorded[target.chainId] === result.hash) continue
        try {
          if (await ports.record(current, target.chainId, result)) {
            current = save({ ...current, listing: { ...current.listing, recorded: { ...current.listing.recorded, [target.chainId]: result.hash } } })
          }
        } catch (error) {
          current = save({ ...current, listing: { ...current.listing, error: error instanceof Error ? error.message : 'Listing will need another check.' } })
        }
      }
    }
    return current
  }
  function callbacks(kind: 'direct' | 'payment'): SubmissionCallbacks {
    return {
      async beforeWrite() {
        const session = load()
        ports.guard(session.plan.owner)
        if (session[kind === 'direct' ? 'directAttempts' : 'paymentAttempts']?.length) {
          await ports.requireRetry(session, kind, 'retry')
          ports.guard(session.plan.owner)
        }
        if (session[kind]?.started) throw new Error('This launch already has a wallet submission. Recover it before continuing.')
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
      ports.guard(plan.owner)
      if (ports.store.load()) throw new Error('Finish or resume the saved launch first.')
      return save({ version: 1, plan, mode: capability === 'sponsored' ? 'center' : plan.targets.length === 1 ? 'direct' : 'relayr',
        published: false, candidates: Object.fromEntries(plan.targets.map(target => [target.chainId, []])), results: {},
        listing: { state: capability === 'unavailable' ? 'unavailable' : 'pending', recorded: {} } })
    },
    run: () => exclusively(async () => {
      let session = await refreshSession(load())
      if (launchComplete(session)) return session
      ports.guard(session.plan.owner)
      if (session.direct?.started || session.payment?.started || (session.listing.requested && !session.listing.selfPaid)) return session
      await ports.review(session.plan, session.mode === 'center')
      ports.guard(session.plan.owner)
      session = await listing(session)
      if (session.mode === 'center') {
        if (!session.listing.intentId) {
          session = save({ ...session, mode: session.plan.targets.length === 1 ? 'direct' : 'relayr' })
        } else {
          await ports.sponsor(session, () => {
            ports.guard(session.plan.owner)
            if (session.listing.requested) throw new Error('This sponsor request was already published.')
            // Save immediately before request: a timeout may still queue the deployment.
            session = save({ ...session, listing: { ...session.listing, requested: true } })
          })
          if (!session.listing.requested) throw new Error('The sponsor request was not durably recorded.')
          return refreshSession(load())
        }
      }
      if (session.mode === 'direct') {
        await ports.sendDirect(session, callbacks('direct'))
        return refreshSession(load())
      }
      if (!session.published) {
        const quote = await ports.quote(session.plan, uuid => { session = save({ ...session, bundleUuid: uuid }) }, () => {
          ports.guard(session.plan.owner)
          if (session.published) throw new Error('This launch was already published.')
          session = save({ ...session, published: true })
        })
        if (!session.published) throw new Error('The launch publication was not durably recorded.')
        session = save({ ...session, quote, bundleUuid: quote.bundle_uuid })
      }
      if (!session.quote) throw new Error('This launch may already be published. Keep it saved and recover its deployment hashes; publishing again could create duplicates.')
      const option = await ports.choosePayment(session)
      if (!session.quote.payment_info.some(quoted => JSON.stringify(quoted) === JSON.stringify(option))) {
        throw new Error('Choose one of the saved quote’s actual payment options.')
      }
      ports.guard(session.plan.owner)
      session = save({ ...session, payment: { option, started: false } })
      await ports.sendPayment(session, callbacks('payment'))
      return refreshSession(load())
    }),
    refresh: () => exclusively(() => refreshSession(load())),
    retry: () => exclusively(async () => {
      const session = await refreshSession(load())
      if (launchComplete(session)) return session
      ports.guard(session.plan.owner)
      const kind = session.payment?.started ? 'payment' : 'direct'
      const submitted = session[kind]
      if (!submitted?.started || !submitted.hash) {
        throw new Error('This submission has no recorded transaction hash. Keep it saved; another receipt cannot release an unknown wallet submission.')
      }
      await ports.requireRetry(session, kind, 'retry')
      ports.guard(session.plan.owner)
      return kind === 'direct'
        ? save({ ...session, directAttempts: [...(session.directAttempts ?? []), submitted], direct: undefined })
        : save({ ...session, paymentAttempts: [...(session.paymentAttempts ?? []), session.payment!], payment: undefined })
    }),
    selfPay: () => exclusively(async () => {
      const session = load()
      ports.guard(session.plan.owner)
      if (session.mode !== 'center' || session.listing.requested) {
        throw new Error('This launch may already be running. Keep its saved recovery and check again.')
      }
      return save({ ...session, mode: session.plan.targets.length === 1 ? 'direct' : 'relayr',
        listing: { ...session.listing, selfPaid: true } })
    }),
    list: () => exclusively(async () => refreshSession(await listing(load()))),
    addHash: (chainId: number, hash: Hex) => exclusively(async () => {
      const session = load()
      if (!isHash(hash) || !session.candidates[chainId]) throw new Error('Enter a transaction hash for one of this launch’s chains.')
      return refreshSession(save({ ...session, candidates: { ...session.candidates, [chainId]: [...new Set([...session.candidates[chainId], hash])] } }))
    }),
    clear: () => exclusively(async () => {
      const session = await refreshSession(load())
      if (!launchCanClear(session)) throw new Error('This launch has published or submitted calls. Recover it before starting another.')
      // A later success does not let a stale failed-attempt proof be forgotten.
      const history = { ...session, direct: undefined, payment: undefined }
      if (session.directAttempts?.length) await ports.requireRetry(history, 'direct', 'retire')
      if (session.paymentAttempts?.length) await ports.requireRetry(history, 'payment', 'retire')
      ports.store.remove()
      ports.changed?.(null)
    }),
  }
}
