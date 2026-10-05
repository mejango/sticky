'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { Refusal } from '@/components/project/flows/refusal'
import { reviewGate } from '@/components/project/flows/review-gate'
import { ModalShell } from '@/components/ui/ModalShell'
import { Revalidating } from '@/components/ui/Revalidating'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { confirmAction, sendingStatus, stepsIntro, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useSettled } from '@/hooks/useSettled'
import { useWallet } from '@/hooks/useWallet'
import { preflight } from '@/lib/preflight'
import { warned } from '@/lib/query-reads'
import { stickyAutoStickAbi, stickyHookAbi } from '@/lib/sticky-abis'
import { deploymentOn } from '@/lib/sticky-addresses'
import { parseShares, SHARE_DECIMALS } from '@/lib/sticky-amount'
import { unstickTxs } from '@/lib/sticky-builders'
import type { Answer, StickyProjectInfo } from '@/lib/sticky-project'
import { quoteUnstick, unstickQuoteSentence, type UnstickQuote } from '@/lib/sticky-quotes'
import { refreshAfterAutoStick, refreshAfterUnstick } from '@/lib/sticky-refresh'
import { need, readAt } from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'

/**
 * Unstick: take some or all of the viewer's Sticky tokens back as the staked token. A form takes the amount and quotes
 * it from the terminal; the main button plans the send from the chain, and a confirmation lists every transaction it
 * takes and sends them one at a time.
 *
 * An unstick of everything the holder has, while auto-stick is on, takes auto-stick apart first: it is turned off, and
 * the trust and the allowance the holder gave it are taken back, so that it keeps neither for a position that is gone.
 * Each of those is a transaction of its own and the unstick is the last. One that fails leaves the ones before it on
 * the chain; the confirmation says which went through and which did not. What went through is kept, for the account
 * that sent it, for as long as the flow is open, across a closed confirmation and a retry, which plan again from the
 * chain: what went through is never sent twice, and once one step of the teardown has gone through, the rest of it is
 * still planned, whatever a node that has not caught up says of auto-stick.
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

/** What went through in this flow, and for which account (lowercase). */
type Sent = { holder: string; steps: readonly TxRequest[] }
const NOTHING: readonly TxRequest[] = []
const NOTHING_SENT: Sent = { holder: '', steps: NOTHING }

/** What each step of an unstick says on the button that sends it. */
const ACTIONS: Record<string, string> = {
  setConfigFor: 'Turn off auto-stick',
  setTrustedSenderFor: 'Remove auto-stick permission',
  approve: 'Remove auto-stick allowance',
}
const actionFor = (step: TxRequest) => ACTIONS[step.functionName] ?? 'Confirm & unstick'
const titleOf = (step: TxRequest) => step.label ?? step.functionName
const titlesOf = (steps: readonly TxRequest[]) => steps.map(titleOf).join('; ')
/** A step that takes auto-stick apart: every step but the unstick itself. */
const isTeardown = (step: TxRequest) => step.functionName !== 'cashOutTokensOf'
const sameStep = (step: TxRequest) => (other: TxRequest) =>
  other.address === step.address && other.functionName === step.functionName

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

/** A reason that starts a sentence. */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

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

/**
 * The transactions an unstick of `count` takes, from what the chain says now, at one block for the holder's balance and
 * what auto-stick keeps of theirs: a full exit takes auto-stick apart first, and the unstick is last, with the quote's
 * net as its minimum. `went` is what has gone through in this flow for the holder. Once a step of the teardown has,
 * auto-stick counts as on whatever the chain says (it reads as off after the first step), so that the rest of the
 * teardown is planned, and no step that went through is planned again, nor an adapter that is already off turned off.
 */
async function planUnstick(
  info: StickyProjectInfo,
  holder: Address,
  count: bigint,
  went: readonly TxRequest[],
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
      state: { enabled: enabled || went.some(isTeardown), minimum, cooldown, personallyTrusted, allowance },
      balance,
    }
  }
  const quote = await quoteUnstick(chainId, projectId, stakedToken, holder, count, { signal })
  const steps = unstickTxs(info, holder, count, quote.net, standing).filter(
    step => !(off && step.functionName === 'setConfigFor') && !(isTeardown(step) && went.some(sameStep(step))),
  )
  // The unstick is tried against the chain as the holder will send it, before the plan is shown.
  await preflight(steps[steps.length - 1], holder, signal, 'The terminal would refuse this unstick')
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

/** Which transactions went through and which did not, in words. `left` is what has not: the first of it is the one being
 * sent, which is waited for, or the one that was tried and failed, which did not go through; the rest of it, and all of
 * it otherwise, has not been sent yet. */
function progress(went: readonly TxRequest[], left: readonly TxRequest[], state: 'sending' | 'failed' | 'idle'): string {
  const [next, ...later] = left
  const head = `Went through: ${titlesOf(went)}.`
  if (state === 'idle') return `${head} Not sent yet: ${titlesOf(left)}.`
  const tried = `${state === 'sending' ? 'Waiting for' : 'Did not go through'}: ${titleOf(next)}.`
  return `${head} ${tried}${later.length ? ` Not sent yet: ${titlesOf(later)}.` : ''}`
}

/** The account changed under a plan: what went through for the one that sent it is said, when anything did. */
function accountChanged(went: readonly TxRequest[], left: readonly TxRequest[]): string {
  return went.length > 0 ? `${ACCOUNT_CHANGED} ${progress(went, left, 'idle')}` : ACCOUNT_CHANGED
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
  const { address, isConnected, isCenterWallet, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)
  const client = useQueryClient()
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [sent, setSent] = useState<Sent>(NOTHING_SENT)
  const [accepted, setAccepted] = useState<{ step: TxRequest; holder: Address } | null>(null)
  const [preparing, setPreparing] = useState(false)
  const preparation = useRef<AbortController | null>(null)
  const waiting = useRef(false)
  const reviewAgain = useRef<() => void>(() => undefined)

  const who = address?.toLowerCase()
  // What went through is the plan's account's while there is a plan, and the connected account's otherwise.
  const landed = sent.holder === (plan?.holder ?? address)?.toLowerCase() ? sent.steps : NOTHING
  // A step the engine has taken and the chain has confirmed is busy until it is counted.
  const sending = tx.busy || tx.phase === 'review' || (tx.phase === 'success' && accepted !== null)
  const complete = plan !== null && plan.steps.length === 0

  const count = parseShares(amount)
  const typed = useSettled(amount)
  const settled = parseShares(typed)
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

  // A step is counted once the engine has taken it and the chain has confirmed it; the next send is for the next step.
  useEffect(() => {
    if (tx.phase !== 'success' || accepted === null) return
    const { step, holder } = accepted
    const key = holder.toLowerCase()
    setAccepted(null)
    setSent(record => ({ holder: key, steps: record.holder === key ? [...record.steps, step] : [step] }))
    setPlan(current => current && { ...current, steps: current.steps.slice(1) })
    setError(null)
    // What the step changed is read again: a step of the teardown changes only the holder's auto-stick and trust.
    if (isTeardown(step)) refreshAfterAutoStick(client, chainId, projectId, holder)
    else refreshAfterUnstick(client, chainId, projectId, holder)
  }, [tx.phase, accepted, client, chainId, projectId])

  // A plan is for one account. One whose account has gone is dropped, unless its send is on its way.
  useEffect(() => {
    if (!plan || complete || sending || plan.holder.toLowerCase() === who) return
    setPlan(null)
    setError(accountChanged(landed, plan.steps))
  }, [who, plan, complete, sending, landed])

  // Another account starts with nothing gone through, once the plan of the last one is gone.
  useEffect(() => {
    if (!plan) setSent(record => (record.holder === who ? record : NOTHING_SENT))
  }, [who, plan])

  // A press that was refused for want of a wallet that can send goes on once there is an account to send from.
  useEffect(() => {
    if (!waiting.current || !address) return
    waiting.current = false
    reviewAgain.current()
  }, [address, isCenterWallet])

  /** Plans `shares` from the chain and shows it. */
  async function prepare(shares: bigint) {
    if (!address) return
    preparation.current?.abort()
    const controller = new AbortController()
    preparation.current = controller
    setPreparing(true)
    try {
      const next = await planUnstick(info, address, shares, landed, controller.signal)
      if (controller.signal.aborted) return
      setPlan(next)
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
    const gate = reviewGate({ address, isConnected, isCenterWallet })
    if (!gate) {
      waiting.current = true
      await openSignIn()
      return
    }
    if (gate.refusal) {
      // A Signa session's press goes on once an external wallet connects.
      if (gate.refusal === EXTERNAL_WALLET_REQUIRED) waiting.current = true
      setError(gate.refusal)
      return
    }
    if (count === null || count <= 0n) return
    tx.reset()
    await prepare(count)
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

  async function sendNext() {
    if (!plan || sending || preparing) return
    const [step] = plan.steps
    setError(null)
    // Every step is sent as the holder the plan was made for, and the engine refuses it, before a review opens, while
    // another account is connected. Its send answers nothing while its lock is held, and a step it did not answer has
    // not been taken.
    const hash = await tx.send(step, { reviewedAccount: plan.holder, reverify: () => stillFits(info, plan, step) })
    if (hash !== null) setAccepted({ step, holder: plan.holder })
  }

  function retry() {
    if (!plan || sending) return
    setError(null)
    tx.reset()
    void prepare(plan.count)
  }

  function closeReview() {
    if (sending) return
    if (complete) {
      setSent(NOTHING_SENT)
      return onClose()
    }
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
  const inFlight = sendingStatus(tx)
  const steps = [...landed, ...(plan?.steps ?? [])]
  const takesAutoStickApart = plan !== null && plan.count === plan.balance && steps.some(isTeardown)
  const partway = landed.length > 0 && plan !== null && !complete
  const showsLink = complete || (tx.phase === 'pending' && !tx.safeProposalHash)

  const actionLabel = failed || (preparing && plan) ? 'Retry' : plan && plan.steps.length > 0 ? actionFor(plan.steps[0]) : 'Confirm & unstick'

  const status = preparing ? (
    plan ? CHECKING : PLANNING
  ) : plan && (partway || inFlight || showsLink) ? (
    <>
      {partway ? <span className="block">{progress(landed, plan.steps, sending ? 'sending' : failed ? 'failed' : 'idle')}</span> : null}
      {inFlight ? <span className="block">{inFlight}</span> : null}
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
          action={confirmAction(tx.phase, actionLabel)}
          cancelLabel={landed.length > 0 ? 'Close' : 'Cancel'}
          onConfirm={() => (failed ? retry() : void sendNext())}
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
