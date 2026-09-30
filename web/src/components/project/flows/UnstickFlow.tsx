'use client'

import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { BaseError, ContractFunctionRevertedError, erc20Abi, formatUnits, parseUnits, type Address } from 'viem'
import { ModalShell } from '@/components/ui/ModalShell'
import { Revalidating } from '@/components/ui/Revalidating'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { stepsIntro, ViewTransactionLink } from '@/components/ui/TxProgress'
import { txPhaseLabel, useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { untilAborted } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { warned } from '@/lib/query-reads'
import { stickyAutoStickAbi, stickyHookAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { unstickTxs } from '@/lib/sticky-builders'
import type { Answer, StickyProjectInfo } from '@/lib/sticky-project'
import { quoteUnstick, unstickQuoteSentence, type UnstickQuote } from '@/lib/sticky-quotes'
import { need, readAt } from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'

/**
 * Unstick: take some or all of the viewer's Sticky tokens back as the staked token. A form takes the amount and quotes
 * it from the terminal; the main button plans the send from the chain, and a confirmation lists every transaction it
 * takes and sends them one at a time.
 *
 * An unstick of everything the holder has, while auto-stick is on, takes auto-stick apart first: it is turned off, and
 * the trust and the allowance the holder gave it are taken back, so that it keeps neither for a position that is gone.
 * Each of those is a transaction of its own and the unstick is the last. One that fails leaves the ones before it on
 * the chain; the confirmation says which went through and which did not, and a retry plans again from the chain, so
 * that what went through is never sent twice and what a full exit still has to take apart is not forgotten.
 *
 * The plan is for one account. The minimum the unstick sends is the net of a quote read from the terminal for this
 * plan, the unstick is tried against the chain before the plan is shown, and before each send the holder's balance
 * (and, for the unstick, the quote) is read again and the send stops if they no longer fit what was reviewed.
 */

const PLANNING = "Reading your balance and the terminal's quote…"
const CHECKING = 'Checking what went through…'
const QUOTING = 'Quoting from the terminal…'
const BALANCE_CHANGED = 'Your Sticky token balance changed. Review the unstick again.'
const ACCOUNT_CHANGED = 'Connected account changed. Review the unstick again.'
const PLAN_UNREADABLE = 'Could not plan an unstick; the dialog says why.'
const BALANCE_UNREADABLE = "Could not read the holder's Sticky token balance; the amount is left as it is."
const QUOTE_UNREADABLE = "Could not quote an unstick; the dialog's quote line says why."
/** A full bonus returns nothing, so there is nothing for the terminal to quote. */
const FULL_BONUS = 10_000n
/** How long typing settles before the amount is quoted. */
const QUOTE_SETTLE_MS = 250
const REFRESH_AFTER_MS = [0, 4_000, 12_000]
/** Sticky tokens have 18 decimals. */
const SHARE_DECIMALS = 18

/** What each step of an unstick says on the button that sends it. */
const ACTIONS: Record<string, string> = {
  setConfigFor: 'Turn off auto-stick',
  setTrustedSenderFor: 'Remove auto-stick permission',
  approve: 'Remove auto-stick allowance',
}
const actionFor = (step: TxRequest) => ACTIONS[step.functionName] ?? 'Confirm & unstick'
const titleOf = (step: TxRequest) => step.label ?? step.functionName
const titlesOf = (steps: readonly TxRequest[]) => steps.map(titleOf).join('; ')

/**
 * What a review is made of: the account it is for, the amount, what the chain said the holder has of it, the quote, and
 * the transactions still to send, in order, the unstick last. The transactions that went through are not in it.
 */
type Plan = {
  holder: Address
  count: bigint
  balance: bigint
  quote: UnstickQuote
  steps: readonly TxRequest[]
}

/** What the holder asked for and cannot have: said to them, and no failure of the page's own. */
class Refusal extends Error {}

/** A reason that starts a sentence. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** The Sticky tokens an amount field names, or null for anything else: a sign, an exponent, a digit past the 18th. */
function sharesOf(text: string): bigint | null {
  const value = text.trim()
  return /^(\d+\.?\d*|\.\d+)$/.test(value) && (value.split('.')[1]?.length ?? 0) <= SHARE_DECIMALS
    ? parseUnits(value, SHARE_DECIMALS)
    : null
}

function deploymentOn(chainId: number) {
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  return deployment
}

/** What a holder has of a project's Sticky tokens, read from the chain now. */
async function heldBy(
  { chainId, stToken }: Pick<StickyProjectInfo, 'chainId' | 'stToken'>,
  holder: Address,
  signal?: AbortSignal,
): Promise<bigint> {
  const [held] = await readAt(
    chainId,
    [{ address: stToken, abi: erc20Abi, functionName: 'balanceOf', args: [holder] }],
    undefined,
    signal,
  )
  return need(held as Answer<bigint>, 'your Sticky token balance')
}

/** Why the chain refuses a call, in the words of its revert when it has any. */
function reasonOf(error: unknown): string {
  if (!(error instanceof BaseError)) return error instanceof Error ? error.message : 'no reason was given'
  const reverted = error.walk(cause => cause instanceof ContractFunctionRevertedError)
  return reverted instanceof ContractFunctionRevertedError
    ? (reverted.data?.errorName ?? reverted.reason ?? reverted.shortMessage)
    : error.shortMessage
}

/** The unstick tried against the chain as the holder will send it: the request the review shows, asked of a node. */
async function preflight(step: TxRequest, holder: Address, signal: AbortSignal): Promise<void> {
  try {
    await untilAborted(
      jbCenterPublicClient(step.chainId).simulateContract({
        account: holder,
        address: step.address,
        abi: step.abi,
        functionName: step.functionName,
        args: step.args as unknown[],
      }),
      signal,
    )
  } catch (cause) {
    if (signal.aborted) throw cause
    throw new Error(`The terminal would refuse this unstick: ${reasonOf(cause)}`, { cause })
  }
}

/**
 * The transactions an unstick of `count` takes, from what the chain says now, at one block for the holder's balance and
 * what auto-stick keeps of theirs: a full exit takes auto-stick apart first, and the unstick is last, with the quote's
 * net as its minimum. Auto-stick counts as standing while it is on, and while the trust and the allowance the holder
 * gave it are, which is what an exit that failed after turning it off leaves. An adapter that is off is not turned off
 * again.
 */
async function planUnstick(
  info: StickyProjectInfo,
  holder: Address,
  count: bigint,
  signal: AbortSignal,
): Promise<Plan> {
  const { chainId, projectId, stToken, stakedToken, stSymbol } = info
  const { autoStick, hook } = deploymentOn(chainId)
  const [held, config, trust, allowed] = await readAt(
    chainId,
    [
      { address: stToken, abi: erc20Abi, functionName: 'balanceOf', args: [holder] },
      { address: autoStick, abi: stickyAutoStickAbi, functionName: 'configOf', args: [projectId, holder] },
      { address: hook, abi: stickyHookAbi, functionName: 'isTrustedSenderOf', args: [projectId, holder, autoStick] },
      { address: stakedToken, abi: erc20Abi, functionName: 'allowance', args: [holder, autoStick] },
    ],
    undefined,
    signal,
  )
  const balance = need(held as Answer<bigint>, 'your Sticky token balance')
  if (count > balance) {
    throw new Refusal(`You hold ${formatUnits(balance, SHARE_DECIMALS)} ${stSymbol}, less than the amount to unstick.`)
  }
  let standing: Parameters<typeof unstickTxs>[4]
  let off = false
  if (count === balance) {
    const [minimum, cooldown, , enabled] = need(
      config as Answer<readonly [bigint, number, number, boolean]>,
      'your auto-stick settings',
    )
    const personallyTrusted = need(trust as Answer<boolean>, 'whether you trust the auto-stick contract')
    const allowance = need(allowed as Answer<bigint>, 'what the auto-stick contract may move for you')
    off = !enabled
    standing = {
      state: { enabled: enabled || personallyTrusted || allowance > 0n, minimum, cooldown, personallyTrusted, allowance },
      balance,
    }
  }
  const quote = await quoteUnstick(chainId, projectId, stakedToken, holder, count, { signal })
  const steps = unstickTxs(info, holder, count, quote.net, standing).filter(
    step => !(off && step.functionName === 'setConfigFor'),
  )
  await preflight(steps[steps.length - 1], holder, signal)
  return { holder, count, balance, quote, steps }
}

/** The review's rows: what goes, what is kept, and what comes back at least, in exact digits. */
function reviewRows(info: StickyProjectInfo, { count, balance, quote }: Plan): TxConfirmRow[] {
  const amount = (value: bigint) => `${formatUnits(value, info.decimals)} ${info.symbol}`
  return [
    { label: 'Unstick', value: `${formatUnits(count, SHARE_DECIMALS)} ${info.stSymbol}`, strong: true },
    ...(balance > count
      ? [{ label: 'You keep', value: `${formatUnits(balance - count, SHARE_DECIMALS)} ${info.stSymbol}` }]
      : []),
    { label: 'Minimum you receive', value: amount(quote.net), strong: true },
    ...(quote.fee > 0n ? [{ label: 'Protocol fee', value: amount(quote.fee) }] : []),
    ...(quote.net === 0n
      ? [{ label: 'Effect', value: 'Your Sticky tokens are burned and no underlying tokens come back.' }]
      : []),
    { label: 'On', value: chainName(info.chainId) },
  ]
}

/** Stops a send that no longer fits what was reviewed: the holder's balance, and for the unstick, what it pays. */
async function stillFits(info: StickyProjectInfo, plan: Plan, step: TxRequest): Promise<void> {
  if ((await heldBy(info, plan.holder)) !== plan.balance) throw new Error(BALANCE_CHANGED)
  if (step.functionName !== 'cashOutTokensOf') return
  const { chainId, projectId, stakedToken, decimals, symbol } = info
  const { net } = await quoteUnstick(chainId, projectId, stakedToken, plan.holder, plan.count)
  if (net < plan.quote.net) {
    throw new Error(
      `The terminal now pays ${formatUnits(net, decimals)} ${symbol}, less than the ` +
        `${formatUnits(plan.quote.net, decimals)} you reviewed. Review the unstick again.`,
    )
  }
}

/**
 * The reads a confirmed step changes, and no others. The unstick changes the project's figures, holders and Latest, the
 * holder's own stick, tranches, rewards and auto-stick, and the holder's account page; a step that takes auto-stick
 * apart changes the holder's auto-stick and who they trust, and nothing else. The Overview's scans are in neither.
 */
function changedBy(chainId: number, projectId: number, holder: Address, unstick: boolean) {
  const who = holder.toLowerCase()
  const ofProject = unstick ? ['info', 'events', 'holders', 'sticks', 'latest', 'page-balances'] : []
  const ofHolder = unstick
    ? ['sticky-position', 'sticky-tranches', 'sticky-rewards', 'sticky-autostick']
    : ['sticky-autostick', 'sticky-trusted']
  return ({ queryKey: key }: { queryKey: readonly unknown[] }) =>
    (key[0] === 'sticky-project' && key[1] === chainId && key[2] === projectId && ofProject.includes(String(key[3]))) ||
    (ofHolder.includes(String(key[0])) && key[1] === chainId && key[2] === projectId && String(key[3]).toLowerCase() === who) ||
    (unstick && key[0] === 'sticky-account' && String(key[2]).toLowerCase() === who)
}

/** Reads what `step` changed again, now and at +4 s and +12 s: the node that answered first may not have its block yet. */
function refreshAfterSend(client: QueryClient, chainId: number, projectId: number, holder: Address, step: TxRequest): void {
  const changed = changedBy(chainId, projectId, holder, step.functionName === 'cashOutTokensOf')
  const again = () => void client.invalidateQueries({ predicate: changed })
  for (const delay of REFRESH_AFTER_MS) {
    if (delay === 0) again()
    else setTimeout(again, delay)
  }
}

/** Which transactions went through and which did not, in words. `left` is what has not: one being sent is waited for,
 * and after a failure none of it went through, and otherwise it has not been sent yet. */
function progress(went: readonly TxRequest[], left: readonly TxRequest[], state: 'sending' | 'failed' | 'idle'): string {
  const [next, ...later] = left
  const head = `Went through: ${titlesOf(went)}.`
  if (state === 'sending') return `${head} Waiting for: ${titleOf(next)}.${later.length ? ` Not sent yet: ${titlesOf(later)}.` : ''}`
  return `${head} ${state === 'failed' ? 'Did not go through' : 'Not sent yet'}: ${titlesOf(left)}.`
}

/** The value, once it has stayed the same for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return settled
}

const pct = (basisPoints: bigint) => `${Number(basisPoints) / 100}%`

export function UnstickFlow({
  chainId,
  projectId,
  info,
  onClose,
}: {
  chainId: number
  projectId: number
  info: StickyProjectInfo
  onClose: () => void
}) {
  const { address, isCenterWallet, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)
  const client = useQueryClient()
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [landed, setLanded] = useState<readonly TxRequest[]>([])
  const [preparing, setPreparing] = useState(false)
  const preparation = useRef<AbortController | null>(null)
  const sent = useRef<{ step: TxRequest; holder: Address } | null>(null)
  const waiting = useRef(false)
  const reviewAgain = useRef<() => void>(() => undefined)

  const sending = tx.busy || tx.phase === 'review'
  const complete = plan !== null && plan.steps.length === 0
  const who = address?.toLowerCase()

  const count = sharesOf(amount)
  const typed = useSettled(amount, QUOTE_SETTLE_MS)
  const settled = sharesOf(typed)
  const quotable =
    address !== undefined && settled !== null && settled > 0n && info.totalSupply > 0n && info.cashOutTaxRate !== FULL_BONUS
  const quote = useQuery({
    queryKey: ['sticky-unstick-quote', chainId, projectId, address, settled?.toString() ?? null],
    queryFn: ({ signal }) =>
      warned(QUOTE_UNREADABLE, { chainId, projectId }, signal, () =>
        quoteUnstick(
          chainId,
          info.projectId,
          info.stakedToken,
          address!,
          settled! > info.totalSupply ? info.totalSupply : settled!,
          { signal },
        ),
      ),
    enabled: quotable,
    retry: false,
    // The last quote stays, faded, until the next lands; it is never another account's.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[3] === address ? previous : undefined),
  })

  useEffect(
    () => () => {
      preparation.current?.abort()
    },
    [],
  )

  // What went through is recorded once, for the send that made it; the next send is for the next step.
  useEffect(() => {
    if (tx.phase !== 'success' || sent.current === null) return
    const { step, holder } = sent.current
    sent.current = null
    setLanded(list => [...list, step])
    setPlan(current => current && { ...current, steps: current.steps.slice(1) })
    setError(null)
    refreshAfterSend(client, chainId, projectId, holder, step)
  }, [tx.phase, client, chainId, projectId])

  // A plan is for one account. One whose account has gone is dropped, unless its send is on its way.
  useEffect(() => {
    if (!plan || complete || sending || plan.holder.toLowerCase() === who) return
    setPlan(null)
    setError(ACCOUNT_CHANGED)
  }, [who, plan, complete, sending])

  // A press that was refused for want of a wallet that can send goes on once there is an account to send from.
  useEffect(() => {
    if (!waiting.current || !address) return
    waiting.current = false
    reviewAgain.current()
  }, [address, isCenterWallet])

  /** Plans `shares` from the chain and shows it. What `went` through in this visit to the dialog is not planned again,
   * whatever a node that has not caught up with it says. */
  async function prepare(shares: bigint, went: readonly TxRequest[]) {
    if (!address) return
    preparation.current?.abort()
    const controller = new AbortController()
    preparation.current = controller
    setPreparing(true)
    try {
      const next = await planUnstick(info, address, shares, controller.signal)
      if (controller.signal.aborted) return
      const done = (step: TxRequest) => went.some(ran => ran.address === step.address && ran.functionName === step.functionName)
      setPlan({ ...next, steps: next.steps.filter(step => !done(step)) })
      setError(null)
    } catch (reason) {
      if (controller.signal.aborted) return
      if (!(reason instanceof Refusal)) console.warn(PLAN_UNREADABLE, { chainId, projectId }, reason)
      setError(reason instanceof Error ? sentence(reason.message) : 'The unstick could not be planned.')
    } finally {
      if (preparation.current === controller) {
        preparation.current = null
        setPreparing(false)
      }
    }
  }

  async function review() {
    setError(null)
    if (!address) {
      waiting.current = true
      await openSignIn()
      return
    }
    if (isCenterWallet) {
      waiting.current = true
      setError(EXTERNAL_WALLET_REQUIRED)
      return
    }
    if (getViewAs()) {
      setError(VIEW_AS_WRITE_BLOCKED)
      return
    }
    if (count === null || count <= 0n) return
    setLanded([])
    tx.reset()
    await prepare(count, [])
  }
  reviewAgain.current = () => void review()

  async function max() {
    if (!address) return
    try {
      setAmount(formatUnits(await heldBy(info, address), SHARE_DECIMALS))
    } catch (reason) {
      console.warn(BALANCE_UNREADABLE, { chainId, projectId }, reason)
      setError('Could not read your balance.')
    }
  }

  function sendNext() {
    if (!plan || sending || preparing) return
    if (address?.toLowerCase() !== plan.holder.toLowerCase()) {
      setPlan(null)
      setError(ACCOUNT_CHANGED)
      return
    }
    const [step] = plan.steps
    sent.current = { step, holder: plan.holder }
    setError(null)
    void tx.send(step, { reverify: () => stillFits(info, plan, step) })
  }

  function retry() {
    if (!plan || sending) return
    setError(null)
    tx.reset()
    void prepare(plan.count, landed)
  }

  function closeReview() {
    if (sending) return
    if (complete) return onClose()
    preparation.current?.abort()
    preparation.current = null
    setPreparing(false)
    setError(plan && landed.length > 0 ? progress(landed, plan.steps, 'idle') : null)
    setPlan(null)
    tx.reset()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void review()
  }

  const failed = error !== null || tx.phase === 'error'
  const flowError = error ?? tx.error
  const inFlight = txPhaseLabel(tx.phase, { idle: '', pending: 'Waiting for confirmation…' })
  const steps = [...landed, ...(plan?.steps ?? [])]
  const takesAutoStickApart = steps.some(step => step.functionName !== 'cashOutTokensOf')
  const partway = landed.length > 0 && plan !== null && !complete
  const showsLink = complete || (tx.phase === 'pending' && !tx.safeProposalHash)

  const actionLabel = failed || (preparing && plan) ? 'Retry' : plan && plan.steps.length > 0 ? actionFor(plan.steps[0]) : 'Confirm & unstick'

  const status = preparing ? (
    plan ? CHECKING : PLANNING
  ) : plan && (partway || inFlight || showsLink) ? (
    <>
      {partway ? <span className="block">{progress(landed, plan.steps, sending ? 'sending' : failed ? 'failed' : 'idle')}</span> : null}
      {inFlight ? <span className="block">{tx.safeNonceGuidance ?? inFlight}</span> : null}
      {showsLink ? <ViewTransactionLink chainId={chainId} hash={tx.hash} /> : null}
    </>
  ) : undefined

  const hint =
    info.cashOutTaxRate > 0n
      ? `Newest tokens unstick first, and up to ${pct(info.cashOutTaxRate)} stays behind for remaining holders.`
      : 'Newest tokens unstick first.'
  const quoteLine =
    settled === null || settled === 0n
      ? ''
      : info.cashOutTaxRate === FULL_BONUS
        ? '100% stickiness bonus: unsticking burns your Sticky tokens and returns nothing.'
        : !address
          ? 'Sign in to quote your unstick.'
          : quote.isError
            ? `Quote unavailable: ${quote.error.message}`
            : quote.data
              ? unstickQuoteSentence(quote.data, settled, info)
              : QUOTING

  return (
    <ModalShell
      title={`Unstick ${info.symbol}`}
      onClose={plan || preparing ? closeReview : onClose}
      busy={sending}
      maxWidth="max-w-md"
    >
      <form onSubmit={submit}>
        <div className="relative">
          <input
            aria-label="Amount of Sticky tokens to unstick"
            inputMode="decimal"
            autoComplete="off"
            placeholder="5"
            value={amount}
            onChange={event => setAmount(event.target.value)}
            className="w-full rounded-[4px] border border-line bg-[#fdffff] py-1.5 pl-2 pr-28 text-ink focus:border-amber focus:outline-none"
          />
          <span className="absolute right-2.5 top-1/2 max-w-[60%] -translate-y-1/2 truncate text-muted">
            {info.stSymbol}
          </span>
        </div>
        <p className="mt-[3px] text-right text-xs">
          <button type="button" disabled={!address} onClick={() => void max()} className="btn-link min-h-0 text-xs">
            max
          </button>
        </p>
        <p className="mt-2 text-[13px] text-muted">{hint}</p>
        <p className="mt-1.5 min-h-5 text-[13px] text-muted" aria-live="polite">
          <Revalidating pending={quote.isFetching && quote.data !== undefined}>{quoteLine}</Revalidating>
        </p>
        <TxError error={plan || preparing ? null : error} />
        <div className="mt-4 flex justify-end">
          <button
            type="submit"
            disabled={preparing || (address !== undefined && (count === null || count <= 0n))}
            className="btn-primary px-4 py-[9px]"
          >
            {address ? 'Unstick' : 'Sign in to unstick'}
          </button>
        </div>
      </form>
      {plan || preparing ? (
        <TxConfirmDialog
          open
          preparing={preparing}
          onClose={closeReview}
          title={complete ? 'Unstick confirmed' : 'Confirm unstick'}
          rows={plan ? reviewRows(info, plan) : undefined}
          steps={steps.map((step, at) => ({ key: `${at}:${step.functionName}`, title: titleOf(step) }))}
          activeIndex={landed.length}
          stepsIntro={stepsIntro(steps.length, landed.length)}
          action={txPhaseLabel(tx.phase, { idle: actionLabel, pending: 'Confirming…' })}
          cancelLabel={landed.length > 0 ? 'Close' : 'Cancel'}
          onConfirm={() => (failed ? retry() : sendNext())}
          busy={sending}
          complete={complete}
          status={status}
          error={flowError}
        >
          {takesAutoStickApart ? (
            <p className="text-sm text-smoke-700">This unsticks everything you hold, so auto-stick is taken apart first.</p>
          ) : null}
        </TxConfirmDialog>
      ) : null}
    </ModalShell>
  )
}
