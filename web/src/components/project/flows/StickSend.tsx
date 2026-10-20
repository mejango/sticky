'use client'

import { WRITE_HOLD_REVERTED_LINE } from '@bananapus/nana-sdk-core/review'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { formatUnits, isAddressEqual, type Address } from 'viem'
import { told } from '@/components/project/flows/refusal'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { confirmAction, sendingStatus, stepsIntro, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useStepPresses } from '@/hooks/useStepPresses'
import { useWallet } from '@/hooks/useWallet'
import { readBalanceAndAllowance } from '@/lib/sticky-allowance'
import { approveSteps, stickTx, type TxRequest } from '@/lib/sticky-builders'
import { asSentence } from '@/lib/sticky-format'
import { withApprovalParent } from '@/lib/sticky-hold-intent'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { assertCanStickFor, quoteStick } from '@/lib/sticky-quotes'
import { refreshAfterStick } from '@/lib/sticky-refresh'
import { stickFailure, type StickFailure } from '@/lib/sticky-stick-failure'
import { chainName } from '@/lib/urn'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'

const MORE_THAN_HELD = 'That is more than you hold.'
const REVIEW_UNREADABLE = 'Could not prepare a stick; its review says what could not be read.'
const BALANCE_UNREADABLE = 'Could not check the balance before sending a step of a stick; the dialog says so.'

/** A review the form asked for, as the fields and the wallet stood when Stick was pressed. A new `id` plans afresh. */
export type StickRequest = {
  id: number
  info: StickyProjectInfo
  terminal: Address
  account: Address
  beneficiary: Address
  amount: bigint
}

/** What a review froze: for whom, how much, what it mints at least, and the steps that send it. */
type Plan = Omit<StickRequest, 'id'> & { minted: bigint; steps: readonly TxRequest[] }

/**
 * A stick's review and its sends, which load when Stick is first pressed and stay mounted after, so a write the engine
 * holds keeps being followed once its dialog closes.
 *
 * The review is a dialog that opens at once and reads the balance, the allowance and the price again, and, for someone
 * else, whether they trust the sender. It then lists what it will send, an approval reset if the allowance needs one,
 * the approval, and the stick, and sends one on each confirmation through the transaction engine. The steps are planned
 * from what the chain says when the review opens, so an approval that landed before the page was reloaded is found and
 * not sent again. The stick carries the quote the review read as the minimum the chain must keep to.
 */
export function StickSend({
  chainId,
  projectId,
  forSomeoneElse,
  request,
  onFailure,
  onClose,
  onReviewAgain,
}: {
  chainId: number
  projectId: number
  forSomeoneElse: boolean
  request: StickRequest
  /** The review could not be planned: what the form says under the button, for the account it was planned for. */
  onFailure: (message: string, account: string) => void
  /** The dialog closed, after the whole plan confirmed or not. */
  onClose: (complete: boolean) => void
  /** The engine refused a Signa session and an external wallet has connected: the form reviews again for it. */
  onReviewAgain: () => void
}) {
  const { isConnected, isCenterWallet } = useWallet()
  const tx = useSafeTx(chainId)
  const client = useQueryClient()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [preparing, setPreparing] = useState(false)
  /** Why the last send failed, when the revert says. */
  const [failure, setFailure] = useState<StickFailure | null>(null)
  // The steps confirmed so far, one for each press: the dialog is on the one after them.
  const presses = useStepPresses(tx)
  const { landed } = presses
  const reading = useRef<AbortController | null>(null)
  const latest = useRef({ tx, presses, onFailure })
  latest.current = { tx, presses, onFailure }

  const sending = tx.busy || tx.phase === 'review'
  const complete = plan !== null && landed === plan.steps.length

  // Each request plans afresh from what the chain says now.
  useEffect(() => {
    const { info, terminal, account, beneficiary, amount: value } = request
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    const { signal } = controller
    latest.current.tx.reset()
    setFailure(null)
    setPlan(null)
    latest.current.presses.restart()
    setPreparing(true)
    void (async () => {
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
        const steps = withApprovalParent([
          ...approveSteps(chainId, info.stakedToken, terminal, allowance, value, {
            symbol: info.symbol,
            decimals: info.decimals,
            mode: 'covering',
          }),
          stickTx(info, beneficiary, value, minted),
        ], account)
        if (signal.aborted) return
        setPlan({ info, terminal, account, beneficiary, amount: value, minted, steps })
      } catch (reason) {
        if (!signal.aborted) {
          const message = asSentence(told(REVIEW_UNREADABLE, { chainId, projectId }, reason).message)
          latest.current.onFailure(message, account.toLowerCase())
        }
      } finally {
        if (!signal.aborted) setPreparing(false)
      }
    })()
  }, [request, chainId, projectId])

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
    setFailure(null)
    await presses.press(plan.steps, (step, confirmedAt) =>
      tx.send(step, {
        reviewedAccount: plan.account,
        simulationBlockNumber: confirmedAt,
        reverify: () => verify(plan),
        onFailure: error => setFailure(stickFailure(error, plan.info.stSymbol)),
      }),
    )
  }

  function close() {
    reading.current?.abort()
    setPlan(null)
    setPreparing(false)
    if (tx.phase !== 'success') tx.dismiss()
    onClose(complete)
  }

  // The engine's refusal for want of an external wallet stands until one connects. The plan it refused was built for the
  // account that could not send, so it is planned again for the one that connects.
  const reviewAgain = useRef(onReviewAgain)
  reviewAgain.current = onReviewAgain
  const refused = tx.error === EXTERNAL_WALLET_REQUIRED
  useEffect(() => {
    if (refused && isConnected && !isCenterWallet) reviewAgain.current()
  }, [refused, isConnected, isCenterWallet])

  // What a stick changed is read again once its transaction has confirmed.
  useEffect(() => {
    if (complete) refreshAfterStick(client, chainId, projectId)
  }, [complete, client, chainId, projectId])

  useEffect(() => () => reading.current?.abort(), [])

  if (!plan && !preparing) return null
  // A stick that would now mint less than its quote is quoted again, never sent with a looser minimum. A mined revert's
  // cause is not knowable from its receipt: it is quoted and simulated again, and that simulation says why.
  const reverted = tx.phase === 'error' && tx.error === WRITE_HOLD_REVERTED_LINE
  const requote = reverted || (tx.phase === 'error' && !!failure?.requote)
  return (
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
        requote ? 'Review again' : tx.phase === 'error' ? 'Retry' : plan && landed === plan.steps.length - 1 ? 'Confirm & stick' : 'Confirm & approve',
      )}
      // Once a step has gone through, closing undoes nothing: what went through stays, and the next review finds it.
      cancelLabel={landed > 0 ? 'Close' : 'Cancel'}
      onConfirm={() => (requote ? onReviewAgain() : void confirm())}
      busy={sending}
      complete={complete}
      settled={tx.phase === 'submitted'}
      status={
        !plan ? (
          'Reading your balance, allowance and the current price…'
        ) : tx.phase === 'success' ? (
          <ViewTransactionLink chainId={chainId} hash={tx.hash} />
        ) : (
          (sendingStatus(tx) ?? undefined)
        )
      }
      error={reverted ? 'The stick reverted.' : tx.phase === 'error' && failure ? failure.message : tx.error}
    />
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
