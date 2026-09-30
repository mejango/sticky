'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { erc20Abi, formatUnits, isAddressEqual, type Address } from 'viem'
import { AddressInput, parseAddress } from '@/components/project/flows/AddressInput'
import { reviewGate } from '@/components/project/flows/review-gate'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { stepsIntro, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useStickyPosition } from '@/hooks/useStickyProject'
import { useWallet } from '@/hooks/useWallet'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { parseShares, SHARE_DECIMALS } from '@/lib/sticky-amount'
import { transferTx } from '@/lib/sticky-builders'
import { formatAmount, stickyLabel } from '@/lib/sticky-format'
import type { Answer, StickyProjectInfo } from '@/lib/sticky-project'
import { refreshAfterTransfer } from '@/lib/sticky-refresh'
import { need, readAt } from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'

const LOCKED = 'This Sticky token is locked and cannot be transferred.'
const MORE_THAN_HELD = 'That is more than you hold.'
const BALANCE_CHANGED = 'Your token balance changed. Review the amount.'
const BALANCE_UNREADABLE = 'Could not read your Sticky balance. Try again.'
const LOST = 'Tokens sent to this Sticky contract are lost. Choose a different recipient.'

/** Sticky's own contracts that Sticky tokens can be sent to and never come back from: the Sticky token itself, the hook
 * and the terminal. */
function losesTokens(info: StickyProjectInfo, recipient: Address): boolean {
  const deployment = stickyDeployment(info.chainId)
  return [info.stToken, deployment?.hook, deployment?.terminal].some(
    contract => contract !== undefined && isAddressEqual(contract, recipient),
  )
}

/** What `holder` holds of the project's Sticky token now, from the token itself: a read that cannot be made is an
 * error, never zero. */
async function heldBy(info: StickyProjectInfo, holder: Address): Promise<bigint> {
  try {
    const [answer] = await readAt(
      info.chainId,
      [{ address: info.stToken, abi: erc20Abi, functionName: 'balanceOf', args: [holder] }],
      undefined,
      undefined,
    )
    return need(answer as Answer<bigint>, 'Your Sticky balance')
  } catch (cause) {
    console.warn("Could not read a holder's Sticky balance before a transfer.", { chainId: info.chainId, projectId: Number(info.projectId) }, cause)
    throw new Error(BALANCE_UNREADABLE, { cause })
  }
}

/** A transfer under review, for the account that asked for it: another account's is never shown or sent. */
type Review = {
  account: Address
  plan: TxRequest | null
  /** Whether it moves everything the account holds. */
  whole: boolean
  preparing: boolean
  error: string | null
}

const LABEL = 'mb-[3px] block text-xs font-semibold uppercase tracking-[1px] text-muted'

/**
 * Transferring Sticky tokens to another address, in a modal. Only a token that is not locked can move. The review reads
 * the holder's balance from the token, plans the one transfer, and its confirm replaces the form in the same card; the
 * balance is read again just before the wallet is asked. A wallet that cannot send, Signa or View as, is refused when
 * the review starts. Once the transfer is confirmed, what it changed is read again.
 */
export function TransferFlow({ info, onClose }: { info: StickyProjectInfo; onClose: () => void }) {
  const { chainId } = info
  const projectId = Number(info.projectId)
  const label = stickyLabel(info)
  const { address, isConnected, isCenterWallet, openSignIn } = useWallet()
  const tx = useSafeTx(chainId)
  const client = useQueryClient()
  const position = useStickyPosition(chainId, projectId, address ?? null, info)
  const amountId = useId()
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const attempt = useRef(0)

  const current = review && review.account === address ? review : null
  const plan = current?.plan ?? null
  const sending = tx.busy || tx.phase === 'review'
  const complete = tx.phase === 'success'
  const held = position.data?.staked
  const typed = parseShares(amount)
  const exceeds = typed !== null && held !== undefined && typed > held

  useEffect(() => {
    if (complete) refreshAfterTransfer(client, chainId, projectId)
  }, [complete, client, chainId, projectId])

  const edit = (set: (text: string) => void) => (text: string) => {
    set(text)
    setReview(null)
  }
  const editRecipient = edit(setRecipient)
  const editAmount = edit(setAmount)
  const fillMax = () => {
    if (held !== undefined) editAmount(formatUnits(held, SHARE_DECIMALS))
  }

  async function startReview() {
    const gate = reviewGate({ address, isConnected, isCenterWallet })
    if (!gate) return void openSignIn()
    const { account } = gate
    const refuse = (error: string) => setReview({ account, plan: null, whole: false, preparing: false, error })
    if (gate.refusal) return refuse(gate.refusal)
    if (info.soulbound) return refuse(LOCKED)
    const to = parseAddress(recipient)
    if (!to) return refuse('Enter a valid recipient address.')
    if (isAddressEqual(to, account)) return refuse('Choose a different recipient.')
    if (losesTokens(info, to)) return refuse(LOST)
    const count = amount.trim() === '' ? 0n : parseShares(amount)
    if (count === null) return refuse('Enter a valid amount.')
    if (count === 0n) return refuse('Enter an amount greater than zero.')

    const mine = ++attempt.current
    tx.reset()
    setReview({ account, plan: null, whole: false, preparing: true, error: null })
    try {
      const now = await heldBy(info, account)
      if (attempt.current !== mine) return
      if (count > now) return refuse(MORE_THAN_HELD)
      setReview({ account, plan: transferTx(info, to, count), whole: count === now, preparing: false, error: null })
    } catch (reason) {
      if (attempt.current === mine) refuse(reason instanceof Error ? reason.message : BALANCE_UNREADABLE)
    }
  }

  async function send() {
    if (!plan || !current || sending) return
    const [, count] = plan.args as readonly [Address, bigint]
    await tx.send(plan, {
      reverify: async () => {
        if ((await heldBy(info, current.account)) < count) throw new Error(BALANCE_CHANGED)
      },
    })
  }

  function closeReview() {
    attempt.current += 1
    setReview(null)
    if (complete) onClose()
    else tx.reset()
  }

  const [planTo, planCount] = (plan?.args ?? []) as readonly [Address?, bigint?]
  const holding =
    address === undefined
      ? null
      : held !== undefined
        ? `You hold ${formatAmount(held, SHARE_DECIMALS)} ${label}.`
        : position.isError
          ? 'Could not read your balance.'
          : 'Checking your balance…'

  return (
    <ModalShell title="Transfer" onClose={onClose} busy={sending} maxWidth="max-w-md">
      <div className="space-y-4">
        {holding ? (
          <p className="text-sm text-muted" title={held === undefined ? undefined : `${formatUnits(held, SHARE_DECIMALS)} ${label}`}>
            {holding}
          </p>
        ) : null}
        <AddressInput label="Recipient" value={recipient} onChange={editRecipient} chainId={chainId} />
        <div>
          <label htmlFor={amountId} className={LABEL}>
            Amount
          </label>
          <div className="relative">
            <input
              id={amountId}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              maxLength={80}
              value={amount}
              aria-invalid={exceeds || undefined}
              onChange={event => editAmount(event.target.value)}
              className="w-full rounded-[4px] border border-line bg-[#fdffff] py-1.5 pl-2 pr-28 text-ink focus:border-amber focus:outline-none aria-[invalid=true]:border-err"
            />
            <span className="absolute right-2.5 top-1/2 max-w-[45%] -translate-y-1/2 truncate text-muted">{label}</span>
          </div>
          <div className="mt-[3px] flex items-start justify-between gap-3 text-xs">
            <span className="min-w-0 text-err">{exceeds ? MORE_THAN_HELD : null}</span>
            <button
              type="button"
              title="Use your whole balance"
              disabled={held === undefined || held === 0n}
              onClick={fillMax}
              className="btn-link min-h-0 shrink-0 text-xs"
            >
              max
            </button>
          </div>
        </div>
        <p className="text-sm text-muted">Moved tokens start a new stick for the recipient.</p>
        <TxError error={plan || current?.preparing ? null : current?.error} />
        <div className="flex justify-end">
          <button
            type="button"
            className="btn-primary min-h-[44px] px-5 text-sm"
            disabled={sending || current?.preparing || exceeds}
            onClick={() => void startReview()}
          >
            {isConnected ? 'Review transfer' : 'Sign in to transfer'}
          </button>
        </div>
      </div>
      {plan || current?.preparing ? (
        <TxConfirmDialog
          open
          preparing={!plan}
          onClose={closeReview}
          title={complete ? 'Sticky tokens transferred' : 'Confirm transfer'}
          rows={
            planTo && planCount !== undefined
              ? [
                  { label: 'Transfer', value: `${formatUnits(planCount, SHARE_DECIMALS)} ${label}`, strong: true },
                  { label: 'To', value: planTo, mono: true },
                  { label: 'On', value: chainName(chainId) },
                ]
              : undefined
          }
          steps={[{ title: plan?.label ?? 'Transfer' }]}
          activeIndex={sending ? 0 : -1}
          stepsIntro={stepsIntro(1, complete ? 1 : 0)}
          complete={complete}
          busy={sending}
          action={tx.phase === 'error' ? 'Retry' : 'Confirm & transfer'}
          onConfirm={() => void send()}
          status={
            complete ? (
              <ViewTransactionLink chainId={chainId} hash={tx.hash} />
            ) : !plan ? (
              'Reading your balance…'
            ) : tx.phase === 'pending' ? (
              'Waiting for confirmation…'
            ) : undefined
          }
          error={tx.error}
        >
          <div className="space-y-1 text-sm text-muted">
            <p>The moved tokens start a new tranche now for the recipient. Your remaining tranches keep their dates.</p>
            {current?.whole ? <p>Sending your whole balance ends your current streak.</p> : null}
          </div>
        </TxConfirmDialog>
      ) : null}
    </ModalShell>
  )
}
