'use client'

import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatUnits, getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from 'viem'
import { reviewGate } from '@/components/project/flows/review-gate'
import { Revalidating } from '@/components/ui/Revalidating'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { confirmAction, sendingStatus, stepsIntro, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useSettled } from '@/hooks/useSettled'
import { useStepPresses } from '@/hooks/useStepPresses'
import { useStickyPosition, useStickyProject } from '@/hooks/useStickyProject'
import { useWallet } from '@/hooks/useWallet'
import { isLostRecipient, LOST_RECIPIENT, stickyDeployment } from '@/lib/sticky-addresses'
import { readBalanceAndAllowance } from '@/lib/sticky-allowance'
import { parseAmount } from '@/lib/sticky-amount'
import { approveSteps, stickTx, type TxRequest } from '@/lib/sticky-builders'
import { asSentence, formatAmount } from '@/lib/sticky-format'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { assertCanStickFor, quoteStick, stickQuoteSentence } from '@/lib/sticky-quotes'
import { refreshAfterStick } from '@/lib/sticky-refresh'
import { chainName } from '@/lib/urn'
import { useViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'

/** How long a quote shown under the amount stays fresh. A review asks again. */
const QUOTE_FRESH_MS = 10_000

const MORE_THAN_HELD = 'That is more than you hold.'
const INVALID_RECIPIENT = 'Enter a valid recipient address.'
const REVIEW_UNREADABLE = 'Could not prepare a stick; its review says what could not be read.'
const QUOTE_UNREADABLE = 'Could not quote a stick; the line under the amount says what could not be read.'
const BALANCE_UNREADABLE = 'Could not check the balance before sending a step of a stick; the dialog says so.'

/** A read's failure as an error the holder is told of. The console is told why as well when the read failed to be made,
 * which its cause says: a refusal, like a holder who has not trusted the sender, has none. */
function told(label: string, about: object, reason: unknown): Error {
  const error = reason instanceof Error ? reason : new Error(String(reason))
  if (error.cause !== undefined) console.warn(label, about, error)
  return error
}

/** What the fields hold: the amount, and who it is for. An amount of 0n is an empty or unusable one; a beneficiary of
 * null is one that is not yet a usable address, or one the tokens would be lost in, which `recipientError` says. */
type Inputs = { amount: bigint; amountError: string | null; beneficiary: Address | null; recipientError: string | null }

/** What a review refused or could not read, and the account it was for (lowercase). It is shown only while the page shows
 * that account, the one the quote under the amount is for: it says nothing of another, whose own standing that quote
 * checks again. A refusal of the wallet itself, Signa or View as, is no account's: it stands until the wallet can send. */
type Failure = { message: string; account: string | null }

/** What a review froze: for whom, how much, what it mints at least, and the steps that send it. */
type Plan = {
  info: StickyProjectInfo
  terminal: Address
  account: Address
  beneficiary: Address
  amount: bigint
  minted: bigint
  steps: readonly TxRequest[]
}

/**
 * Sticking an amount of a project's staked token, for the signed-in holder (the Stick card) or for someone else (the
 * Airdrops tab's form): the fields, the quote of what the stick mints at least, and the review.
 *
 * The review is a dialog that opens at once and reads the balance, the allowance and the price again, and, for someone
 * else, whether they trust the sender. It then lists what it will send, an approval reset if the allowance needs one,
 * the approval, and the stick, and sends one on each confirmation through the transaction engine. The steps are planned
 * from what the chain says when the review opens, so an approval that landed before the page was reloaded is found and
 * not sent again. The stick carries the quote the review read as the minimum the chain must keep to.
 */
export function StickFlow({
  chainId,
  projectId,
  forSomeoneElse = false,
}: {
  chainId: number
  projectId: number
  forSomeoneElse?: boolean
}) {
  const { info, verified, failed } = useStickyProject(chainId, projectId)
  const { viewAs } = useViewAs()
  const { address, isConnected, isCenterWallet, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)
  const client = useQueryClient()
  const terminal = stickyDeployment(chainId)?.terminal

  const recipientId = useId()
  const amountId = useId()
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const settledAmount = useSettled(amount)
  const settledRecipient = useSettled(recipient)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  // The steps confirmed so far, one for each press: the dialog is on the one after them.
  const presses = useStepPresses(tx)
  const { landed } = presses
  const reading = useRef<AbortController | null>(null)

  // The account the page shows, which a visitor without a wallet has none of. A visitor's quote is asked as the zero
  // address, which a stick for oneself accepts.
  const viewer = viewAs ?? address ?? null
  const payer = forSomeoneElse ? viewer : (viewer ?? zeroAddress)
  const position = useStickyPosition(chainId, projectId, viewer, info)
  const wallet = position.data?.wallet

  function inputsOf(amountText: string, recipientText: string): Inputs {
    let parsed = 0n
    let amountError: string | null = null
    if (info && amountText.trim() !== '') {
      try {
        parsed = parseAmount(amountText, info.decimals)
      } catch (reason) {
        amountError = asSentence(reason instanceof Error ? reason.message : 'enter a valid amount')
      }
    }
    if (!forSomeoneElse) return { amount: parsed, amountError, beneficiary: payer, recipientError: null }
    const text = recipientText.trim()
    const valid = isAddress(text) && getAddress(text) !== zeroAddress
    const lost = valid && info !== undefined && isLostRecipient(info, text)
    return {
      amount: parsed,
      amountError,
      beneficiary: valid && !lost ? getAddress(text) : null,
      recipientError: lost ? LOST_RECIPIENT : text !== '' && !valid ? INVALID_RECIPIENT : null,
    }
  }
  // What the fields hold, and what they held when typing last settled, which the quote under the amount is for.
  const typed = inputsOf(amount, recipient)
  const quoted = inputsOf(settledAmount, settledRecipient)
  const settledNow = amount === settledAmount && recipient === settledRecipient

  const exceeds = (value: bigint) => wallet !== undefined && value > wallet
  const asking =
    verified && info && payer && quoted.beneficiary && quoted.amount > 0n && !exceeds(quoted.amount)
      ? { info, payer, beneficiary: quoted.beneficiary, amount: quoted.amount }
      : null
  const quote = useQuery({
    queryKey: ['sticky-quote', chainId, projectId, quoted.amount.toString(), payer, quoted.beneficiary],
    queryFn: asking
      ? async ({ signal }) => {
          const { info: staked, payer: sender, beneficiary, amount: value } = asking
          const about = { chainId, projectId }
          // Whether the sender may stick for them comes first: the terminal's preview refuses a sender who may not with
          // a revert that says nothing a holder can act on.
          if (forSomeoneElse && !isAddressEqual(sender, beneficiary)) {
            try {
              await assertCanStickFor(chainId, staked.projectId, sender, beneficiary, { signal })
            } catch (reason) {
              throw signal.aborted ? reason : new Error(asSentence(told(QUOTE_UNREADABLE, about, reason).message))
            }
          }
          try {
            return await quoteStick(chainId, staked.projectId, staked.stakedToken, value, sender, beneficiary, { signal })
          } catch (reason) {
            throw signal.aborted ? reason : new Error(`Could not quote: ${told(QUOTE_UNREADABLE, about, reason).message}`)
          }
        }
      : skipToken,
    retry: false,
    staleTime: QUOTE_FRESH_MS,
    // The last quote stays, faded, while the next one is read, unless it was for another account.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[4] === payer && previousQuery?.queryKey[5] === quoted.beneficiary ? previous : undefined,
  })

  const sending = tx.busy || tx.phase === 'review'
  const complete = plan !== null && landed === plan.steps.length
  const shown = viewer?.toLowerCase() ?? null
  const error = failure && (failure.account === null || failure.account === shown) ? failure.message : null
  const quoteFailed = quote.isError && settledNow
  const closed =
    !verified ||
    sending ||
    preparing ||
    (isConnected && (typed.amount <= 0n || typed.beneficiary === null || exceeds(typed.amount) || quoteFailed))

  async function review() {
    if (!info || !verified || !terminal) return
    const gate = reviewGate({ address, isConnected, isCenterWallet })
    if (!gate) {
      void openSignIn()
      return
    }
    // The engine refuses these too; saying so now keeps a plan from being built for an account that cannot send it.
    if (gate.refusal) {
      setFailure({ message: gate.refusal, account: null })
      return
    }
    const { account } = gate
    if (typed.amount <= 0n || typed.beneficiary === null) return
    const { beneficiary, amount: value } = typed
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    const { signal } = controller
    tx.reset()
    setFailure(null)
    setPlan(null)
    presses.restart()
    setPreparing(true)
    try {
      if (!isAddressEqual(beneficiary, account)) {
        await assertCanStickFor(chainId, info.projectId, account, beneficiary, { signal })
      }
      const { balance, allowance } = await readBalanceAndAllowance(
        chainId,
        { token: info.stakedToken, owner: account, spender: terminal },
        { signal },
      )
      if (balance < value) throw new Error(MORE_THAN_HELD)
      const minted = await quoteStick(chainId, info.projectId, info.stakedToken, value, account, beneficiary, { signal })
      const steps = [
        ...approveSteps(chainId, info.stakedToken, terminal, allowance, value, {
          symbol: info.symbol,
          decimals: info.decimals,
          mode: 'covering',
        }),
        stickTx(info, beneficiary, value, minted),
      ]
      if (signal.aborted) return
      setPlan({ info, terminal, account, beneficiary, amount: value, minted, steps })
    } catch (reason) {
      if (!signal.aborted) {
        const message = asSentence(told(REVIEW_UNREADABLE, { chainId, projectId }, reason).message)
        setFailure({ message, account: account.toLowerCase() })
      }
    } finally {
      if (!signal.aborted) setPreparing(false)
    }
  }

  /** The balance just before a step is sent: an approval does not fail for want of one, and the stick after it would. A
   * balance that cannot be read stops the step, and the console is told why. */
  async function verify({ info: staked, terminal: spender, account: owner, amount: value }: Plan) {
    const { balance } = await readBalanceAndAllowance(chainId, { token: staked.stakedToken, owner, spender }).catch(reason => {
      const unreadable = told(BALANCE_UNREADABLE, { chainId, projectId }, reason)
      throw new Error(asSentence(unreadable.message), { cause: unreadable })
    })
    if (balance < value) throw new Error(`Your ${staked.symbol} balance changed. Review the amount.`)
  }

  async function confirm() {
    if (!plan || sending) return
    // The plan is the reviewing account's: its balance, its allowance, its trust check and its quote. Every step is sent
    // as that account, and the engine refuses it, before a review opens, while another is connected.
    await presses.press(plan.steps, (step, confirmedAt) =>
      tx.send(step, { reviewedAccount: plan.account, simulationBlockNumber: confirmedAt, reverify: () => verify(plan) }),
    )
  }

  function close() {
    reading.current?.abort()
    setPlan(null)
    setPreparing(false)
    setFailure(null)
    if (complete) setAmount('')
    if (tx.phase !== 'success') tx.reset()
  }

  // A refusal for want of an external wallet stands until one connects. The plan it refused was built for the account
  // that could not send, so it is planned again for the one that connects.
  const reviewNow = useRef(review)
  reviewNow.current = review
  const refused = failure?.message === EXTERNAL_WALLET_REQUIRED || tx.error === EXTERNAL_WALLET_REQUIRED
  useEffect(() => {
    if (!refused || !isConnected || isCenterWallet) return
    setFailure(null)
    void reviewNow.current()
  }, [refused, isConnected, isCenterWallet])

  // A refusal for View as stands until View as ends.
  useEffect(() => {
    if (!viewAs) setFailure(current => (current?.message === VIEW_AS_WRITE_BLOCKED ? null : current))
  }, [viewAs])

  // What a stick changed is read again once its transaction has confirmed.
  useEffect(() => {
    if (complete) refreshAfterStick(client, chainId, projectId)
  }, [complete, client, chainId, projectId])

  useEffect(() => () => reading.current?.abort(), [])

  const action = forSomeoneElse ? 'Review stick' : 'Stick'
  const label = verified ? (isConnected ? action : 'Sign in to stick') : failed ? action : 'Checking…'

  // What the review said, under the button, while no plan is open. The line under the amount does not say it again.
  const shownError = plan ? null : error
  let hint: ReactNode = null
  if (quoted.amountError) hint = quoted.amountError
  else if (quoted.recipientError) hint = quoted.recipientError
  else if (quoted.amount > 0n && quoted.beneficiary !== null && info) {
    if (exceeds(quoted.amount)) hint = MORE_THAN_HELD
    else if (quote.isError) hint = quote.error.message === shownError ? null : <span className="text-err">{quote.error.message}</span>
    else if (quote.data !== undefined) hint = stickQuoteSentence(quote.data, info, forSomeoneElse)
    else if (quote.isFetching) hint = 'Checking the current backing price…'
  }
  const stale = !settledNow || quote.isFetching

  const field =
    'w-full rounded-[4px] border border-line bg-[#fdffff] py-1.5 pl-2 text-ink focus:border-amber focus:outline-none'
  // What a refusal said is about what was in the fields, which are no longer.
  const edit = (set: (value: string) => void, value: string) => {
    set(value)
    setFailure(null)
  }

  return (
    <div>
      {forSomeoneElse ? (
        <>
          <label htmlFor={recipientId} className="block text-xs text-muted">
            Recipient
          </label>
          <input
            id={recipientId}
            aria-label="Recipient address"
            placeholder="0x…"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={recipient}
            onChange={event => edit(setRecipient, event.target.value)}
            className={`${field} mt-1 pr-2`}
          />
          <label htmlFor={amountId} className="mt-2 block text-xs text-muted">
            Amount
          </label>
        </>
      ) : null}
      <div className={forSomeoneElse ? 'relative mt-1' : 'relative'}>
        <input
          id={amountId}
          aria-label="Amount of underlying tokens to stick"
          inputMode="decimal"
          autoComplete="off"
          placeholder="10"
          value={amount}
          onChange={event => edit(setAmount, event.target.value)}
          className={`${field} pr-16`}
        />
        <span className="absolute right-2.5 top-1/2 max-w-[60%] -translate-y-1/2 truncate text-muted">{info?.symbol}</span>
      </div>
      {!forSomeoneElse && info && wallet !== undefined ? (
        <p className="mt-[3px] truncate text-xs text-muted">
          <button
            type="button"
            title="Use full wallet balance"
            onClick={() => edit(setAmount, formatUnits(wallet, info.decimals))}
            className="btn-link min-h-0 text-xs"
          >
            {formatAmount(wallet, info.decimals)}
          </button>{' '}
          {info.symbol} in wallet
        </p>
      ) : null}
      <div data-stick-hint aria-live="polite" className="text-[13px] text-muted">
        {hint === null ? null : (
          <Revalidating as="div" pending={stale && quote.data !== undefined} className="mt-2">
            {hint}
          </Revalidating>
        )}
      </div>
      <TxError error={shownError} />
      <button type="button" disabled={closed} onClick={() => void review()} className="btn-primary mt-3 w-full px-4 py-[9px]">
        {label}
      </button>
      {plan || preparing ? (
        <TxConfirmDialog
          open
          preparing={!plan}
          onClose={close}
          title={complete ? 'Stick confirmed' : forSomeoneElse ? 'Confirm stick for someone else' : 'Confirm stick'}
          rows={plan ? rowsOf(plan, forSomeoneElse, chainId) : undefined}
          steps={plan ? plan.steps.map((step, at) => ({ key: String(at), title: step.label ?? step.functionName })) : []}
          activeIndex={plan ? landed : -1}
          stepsIntro={plan ? stepsIntro(plan.steps.length, landed) : undefined}
          action={confirmAction(
            tx.phase,
            tx.phase === 'error' ? 'Retry' : plan && landed === plan.steps.length - 1 ? 'Confirm & stick' : 'Confirm & approve',
          )}
          // Once a step has gone through, closing undoes nothing: what went through stays, and the next review finds it.
          cancelLabel={landed > 0 ? 'Close' : 'Cancel'}
          onConfirm={() => void confirm()}
          busy={sending}
          complete={complete}
          status={
            !plan ? (
              'Reading your balance, allowance and the current price…'
            ) : tx.phase === 'success' ? (
              <ViewTransactionLink chainId={chainId} hash={tx.hash} />
            ) : (
              (sendingStatus(tx) ?? undefined)
            )
          }
          error={tx.error}
        />
      ) : null}
    </div>
  )
}

/** The review's rows: every figure exact, with all its digits. */
function rowsOf({ info, beneficiary, amount, minted }: Plan, forSomeoneElse: boolean, chainId: number): TxConfirmRow[] {
  return [
    { label: 'Stick', value: `${formatUnits(amount, info.decimals)} ${info.symbol}`, strong: true },
    ...(forSomeoneElse ? [{ label: 'For', value: beneficiary, mono: true }] : []),
    {
      label: forSomeoneElse ? 'They get at least' : 'You get at least',
      value: `${formatUnits(minted, 18)} ${info.stSymbol}`,
      strong: true,
    },
    { label: 'On', value: chainName(chainId) },
  ]
}
