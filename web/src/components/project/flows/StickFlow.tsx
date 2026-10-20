'use client'

import { skipToken, useQuery } from '@tanstack/react-query'
import dynamic from 'next/dynamic'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatUnits, getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from 'viem'
import { told } from '@/components/project/flows/refusal'
import { reviewGate } from '@/components/project/flows/review-gate'
import type { StickRequest } from '@/components/project/flows/StickSend'
import { Revalidating } from '@/components/ui/Revalidating'
import { TxError } from '@/components/ui/TxError'
import { useSettled } from '@/hooks/useSettled'
import { useStickyPosition, useStickyProject } from '@/hooks/useStickyProject'
import { useWallet } from '@/hooks/useWallet'
import { isLostRecipient, LOST_RECIPIENT, stickyDeployment } from '@/lib/sticky-addresses'
import { parseAmount } from '@/lib/sticky-amount'
import { asSentence, formatAmount } from '@/lib/sticky-format'
import { assertCanStickFor, quoteStick, stickQuoteSentence } from '@/lib/sticky-quotes'
import { useViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'

// The review and the transaction engine load when Stick is first pressed; the pointer or focus reaching the form fetches
// them ahead of the press.
const StickSend = dynamic(() => import('@/components/project/flows/StickSend').then(module => module.StickSend), {
  ssr: false,
})
const preloadStickSend = () => void import('@/components/project/flows/StickSend')

/** How long a quote shown under the amount stays fresh. A review asks again. */
const QUOTE_FRESH_MS = 10_000

const MORE_THAN_HELD = 'That is more than you hold.'
const INVALID_RECIPIENT = 'Enter a valid recipient address.'
const QUOTE_UNREADABLE = 'Could not quote a stick; the line under the amount says what could not be read.'

/** What the fields hold: the amount, and who it is for. An amount of 0n is an empty or unusable one; a beneficiary of
 * null is one that is not yet a usable address, or one the tokens would be lost in, which `recipientError` says. */
type Inputs = { amount: bigint; amountError: string | null; beneficiary: Address | null; recipientError: string | null }

/** What a review refused or could not read, and the account it was for (lowercase). It is shown only while the page shows
 * that account, the one the quote under the amount is for: it says nothing of another, whose own standing that quote
 * checks again. A refusal of the wallet itself, Signa or View as, is no account's: it stands until the wallet can send. */
type Failure = { message: string; account: string | null }

/**
 * Sticking an amount of a project's staked token, for the signed-in holder (the Stick card) or for someone else (the
 * Airdrops tab's form): the fields, the quote of what the stick mints at least, and the review, which is StickSend's.
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
  const terminal = stickyDeployment(chainId)?.terminal

  const recipientId = useId()
  const amountId = useId()
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const settledAmount = useSettled(amount)
  const settledRecipient = useSettled(recipient)
  // The last review asked for (StickSend stays mounted from the first), and whether its dialog is open.
  const [request, setRequest] = useState<StickRequest | null>(null)
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

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

  const shown = viewer?.toLowerCase() ?? null
  const error = failure && (failure.account === null || failure.account === shown) ? failure.message : null
  const quoteFailed = quote.isError && settledNow
  const closed =
    !verified ||
    open ||
    (isConnected && (typed.amount <= 0n || typed.beneficiary === null || exceeds(typed.amount) || quoteFailed))

  function review() {
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
    if (typed.amount <= 0n || typed.beneficiary === null) return
    setFailure(null)
    setOpen(true)
    setRequest(last => ({
      id: (last?.id ?? 0) + 1,
      info,
      terminal,
      account: gate.account,
      beneficiary: typed.beneficiary!,
      amount: typed.amount,
    }))
  }

  function closeReview(complete: boolean) {
    setOpen(false)
    setFailure(null)
    if (complete) setAmount('')
  }

  // A refusal for want of an external wallet stands until one connects. The plan it refused was built for the account
  // that could not send, so it is planned again for the one that connects. StickSend does the same for the engine's.
  const reviewNow = useRef(review)
  reviewNow.current = review
  const refused = failure?.message === EXTERNAL_WALLET_REQUIRED
  useEffect(() => {
    if (!refused || !isConnected || isCenterWallet) return
    setFailure(null)
    void reviewNow.current()
  }, [refused, isConnected, isCenterWallet])

  // A refusal for View as stands until View as ends.
  useEffect(() => {
    if (!viewAs) setFailure(current => (current?.message === VIEW_AS_WRITE_BLOCKED ? null : current))
  }, [viewAs])

  const action = forSomeoneElse ? 'Review stick' : 'Stick'
  const label = verified ? (isConnected ? action : 'Sign in to stick') : failed ? action : 'Checking…'

  // What the review said, under the button, while no plan is open. The line under the amount does not say it again.
  const shownError = open ? null : error
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
    <div onPointerEnter={preloadStickSend} onFocus={preloadStickSend} onTouchStart={preloadStickSend}>
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
      {request ? (
        <StickSend
          chainId={chainId}
          projectId={projectId}
          forSomeoneElse={forSomeoneElse}
          request={request}
          onFailure={(message, account) => {
            setOpen(false)
            setFailure({ message, account })
          }}
          onClose={closeReview}
          onReviewAgain={() => {
            setFailure(null)
            reviewNow.current()
          }}
        />
      ) : null}
    </div>
  )
}
