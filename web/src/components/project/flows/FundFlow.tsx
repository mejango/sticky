'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { formatUnits, type Address } from 'viem'
import { Refusal, refusalOf } from '@/components/project/flows/refusal'
import { parseRewardToken } from '@/components/project/flows/reward-token'
import { reviewGate } from '@/components/project/flows/review-gate'
import { FIELD_INPUT, FIELD_LABEL, StakeAgeFields } from '@/components/project/StakeAgeFields'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { confirmAction, sendingStatus, stepsIntro, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useStepPresses } from '@/hooks/useStepPresses'
import { useWallet } from '@/hooks/useWallet'
import { asked } from '@/lib/hook-logs'
import { stickyDistributorAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { readBalanceAndAllowance, readNativeBalance } from '@/lib/sticky-allowance'
import { parseAmount } from '@/lib/sticky-amount'
import { fundTxs } from '@/lib/sticky-builders'
import { asSentence, stickyLabel } from '@/lib/sticky-format'
import type { Answer, StickyProjectInfo } from '@/lib/sticky-project'
import { refreshAfterFund } from '@/lib/sticky-refresh'
import {
  groupIdFromWeeks,
  groupLabel,
  groupSentence,
  NATIVE_REWARD_TOKEN,
  need,
  readAt,
  rewardTokenMeta,
  type TokenMeta,
} from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'
import { useViewAs } from '@/lib/viewAs'

const PREPARE_UNREADABLE = 'Could not prepare an airdrop; its form says what could not be read.'
const BALANCE_UNREADABLE = 'Could not check the balance before sending a step of an airdrop; the dialog says so.'
const NOT_A_TOKEN = 'Enter a valid reward token address or ETH.'
const NOT_ACCEPTED = 'The distributor does not accept this stake-age window.'
const NOTHING = 'Enter an amount greater than zero.'
const MORE_THAN_HELD = 'That is more than you hold.'
const ACCEPTS = 'whether the distributor accepts this stake-age window'

/** What a review refused or could not read, and the account it was for (lowercase), and is shown for: a refusal of the
 * wallet itself, Signa or View as, is no account's, and stands until the wallet changes. */
type Failure = { message: string; account: string | null }

/** What a review froze: who sends, which token, how much and for which group, and the steps that send it. */
type Plan = {
  account: Address
  token: Address
  meta: TokenMeta
  amount: bigint
  groupId: bigint
  steps: readonly TxRequest[]
}

/** What `owner` holds of `token` and has let `spender` take of it, read now. ETH is sent with the call, and needs no
 * allowance. */
async function fundsOf(chainId: number, token: Address, owner: Address, spender: Address, signal?: AbortSignal) {
  if (token.toLowerCase() === NATIVE_REWARD_TOKEN) {
    const balance = signal ? await readNativeBalance(chainId, owner, { signal }) : await readNativeBalance(chainId, owner)
    return { balance, allowance: 0n }
  }
  return signal
    ? readBalanceAndAllowance(chainId, { token, owner, spender }, { signal })
    : readBalanceAndAllowance(chainId, { token, owner, spender })
}

/**
 * An airdrop of what the form holds, planned from what the chain says now: the token and its decimals, the group the
 * weeks name and whether the distributor accepts it, and what the funder holds and has approved. What the funder asked
 * for and cannot have is refused (`Refusal`) before anything is read that it does not need, as the old client's
 * `fundRewards` refused it (OLD app.js:4093).
 */
async function planFund(
  info: StickyProjectInfo,
  account: Address,
  fields: { token: string; minWeeks: string; maxWeeks: string; amount: string },
  signal: AbortSignal,
): Promise<Plan> {
  const { chainId, stToken, stakedToken } = info
  const { distributor } = stickyDeployment(chainId)!
  const token = parseRewardToken(fields.token, stakedToken)
  if (!token) throw new Refusal(NOT_A_TOKEN)
  let groupId: bigint
  try {
    groupId = groupIdFromWeeks(fields.minWeeks, fields.maxWeeks)
  } catch (reason) {
    throw new Refusal(asSentence((reason as Error).message))
  }
  const meta = await rewardTokenMeta(chainId, token, { signal })
  let amount: bigint
  try {
    amount = parseAmount(fields.amount, meta.decimals)
  } catch (reason) {
    throw new Refusal(asSentence((reason as Error).message))
  }
  if (amount === 0n) throw new Refusal(NOTHING)
  // The distributor is the word on which groups it accepts, as it was the old client's.
  const [accepts] = (await asked(
    ACCEPTS,
    () =>
      readAt(
        chainId,
        [{ address: distributor, abi: stickyDistributorAbi, functionName: 'isValidGroupId', args: [groupId] }],
        undefined,
        signal,
      ),
    signal,
  )) as Answer<boolean>[]
  if (!need(accepts, ACCEPTS)) throw new Refusal(NOT_ACCEPTED)
  const { balance, allowance } = await fundsOf(chainId, token, account, distributor, signal)
  if (balance < amount) throw new Refusal(MORE_THAN_HELD)
  return {
    account,
    token,
    meta,
    amount,
    groupId,
    steps: fundTxs(chainId, { stToken, token, amount, groupId, allowance, ...meta }),
  }
}

/** The review's rows: what goes, to whom, and how they share it, every figure exact. */
function rowsOf({ meta, amount, groupId }: Plan, info: StickyProjectInfo): TxConfirmRow[] {
  return [
    { label: 'Send', value: `${formatUnits(amount, meta.decimals)} ${meta.symbol}`, strong: true },
    { label: 'To', value: groupLabel(groupId), strong: true },
    { label: 'How', value: groupSentence(groupId) },
    { label: 'Project', value: `${stickyLabel(info)} #${info.projectId}` },
    { label: 'On', value: chainName(info.chainId) },
  ]
}

/**
 * Sending airdrop rewards to a project's Sticky token holders, in a modal: a token (an address, or ETH), the stake-age
 * window of the holders it rewards, and an amount. The chain to send from is this one; sending from another chain is a
 * bridge, which comes with the bridge flows.
 *
 * The review opens in the same card and reads the token, whether the distributor accepts the group, and the funder's
 * balance and allowance, then lists what it sends: an approval of the amount to the distributor when the allowance does
 * not cover it (a reset to zero first when it is not zero), and the airdrop itself; ETH is the call's value and needs no
 * approval. Each is sent on its own press, from the account that reviewed it, and the balance is read again before each.
 * Once the airdrop is confirmed, the pots are read again and its token is checked for rewards (`onFunded`).
 */
export function FundFlow({
  chainId,
  projectId,
  info,
  onClose,
  onFunded,
}: {
  chainId: number
  projectId: number
  /** The project as this visit read it. */
  info: StickyProjectInfo
  onClose: () => void
  /** The token of an airdrop that went through, in lowercase. */
  onFunded: (token: Address) => void
}) {
  const { address, isConnected, isCenterWallet, openSignIn } = useWallet()
  const { viewAs } = useViewAs()
  const tx = useSafeTx(chainId)
  const presses = useStepPresses(tx)
  const { landed } = presses
  const client = useQueryClient()
  const ids = { from: useId(), token: useId(), amount: useId() }
  const [token, setToken] = useState('')
  const [minWeeks, setMinWeeks] = useState('')
  const [maxWeeks, setMaxWeeks] = useState('')
  const [amount, setAmount] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const reading = useRef<AbortController | null>(null)
  const funded = useRef(onFunded)
  funded.current = onFunded

  const sending = tx.busy || tx.phase === 'review'
  const complete = plan !== null && landed === plan.steps.length
  const shown = address?.toLowerCase() ?? null
  const error = failure && (failure.account === null || failure.account === shown) ? failure.message : null

  async function startReview() {
    const gate = reviewGate({ address, isConnected, isCenterWallet })
    if (!gate) return void openSignIn()
    // The engine refuses these too; saying so now keeps a plan from being built for an account that cannot send it.
    if (gate.refusal) return setFailure({ message: gate.refusal, account: null })
    const { account } = gate
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    const { signal } = controller
    tx.reset()
    presses.restart()
    setFailure(null)
    setPlan(null)
    setPreparing(true)
    try {
      const next = await planFund(info, account, { token, minWeeks, maxWeeks, amount }, signal)
      if (!signal.aborted) setPlan(next)
    } catch (reason) {
      if (signal.aborted) return
      const told = refusalOf(reason)
      if (!(told instanceof Refusal)) console.warn(PREPARE_UNREADABLE, { chainId, projectId }, told)
      setFailure({ message: asSentence(told instanceof Error ? told.message : String(told)), account: account.toLowerCase() })
    } finally {
      if (!signal.aborted) setPreparing(false)
    }
  }

  /** The balance just before a step is sent: an approval does not fail for want of one, and the airdrop after it would.
   * A balance that cannot be read stops the step, and the console is told why. */
  async function verify({ token: sent, account, amount: value, meta }: Plan) {
    let balance: bigint
    try {
      ;({ balance } = await fundsOf(chainId, sent, account, stickyDeployment(chainId)!.distributor))
    } catch (reason) {
      console.warn(BALANCE_UNREADABLE, { chainId, projectId }, reason)
      throw new Error(asSentence(reason instanceof Error ? reason.message : String(reason)), { cause: reason })
    }
    if (balance < value) throw new Error(`Your ${meta.symbol} balance changed. Review the amount.`)
  }

  async function confirm() {
    if (!plan || sending) return
    // Every step is sent as the account that reviewed the airdrop, and the engine refuses it while another is connected.
    await presses.press(plan.steps, (step, confirmedAt) =>
      tx.send(step, { reviewedAccount: plan.account, simulationBlockNumber: confirmedAt, reverify: () => verify(plan) }),
    )
  }

  function closeReview() {
    reading.current?.abort()
    if (complete) return onClose()
    setPlan(null)
    setPreparing(false)
    if (tx.phase !== 'success') tx.reset()
  }

  // A refusal of the wallet itself is about the wallet that was connected, or the account in View as: another is asked
  // again on its own press.
  useEffect(() => {
    setFailure(current => (current?.account === null ? null : current))
  }, [address, isCenterWallet, viewAs])

  // What an airdrop changed is read again once it has confirmed, and its token is looked for rewards in.
  useEffect(() => {
    if (!complete || !plan) return
    refreshAfterFund(client, chainId, projectId, plan.account)
    funded.current(plan.token.toLowerCase() as Address)
  }, [complete, plan, client, chainId, projectId])

  useEffect(() => () => reading.current?.abort(), [])

  // What a refusal said is about what was in the fields, which are no longer.
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value)
    setFailure(null)
  }
  const next = plan?.steps[landed]

  return (
    <ModalShell title="Airdrop" onClose={plan || preparing ? closeReview : onClose} maxWidth="max-w-md">
      <div className="space-y-3">
        <div className="grid gap-3 min-[480px]:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
          <div className="min-w-0">
            <label htmlFor={ids.from} className={FIELD_LABEL}>
              From chain
            </label>
            <select id={ids.from} defaultValue={chainId} className={FIELD_INPUT}>
              <option value={chainId}>{chainName(chainId)}</option>
            </select>
          </div>
          <div className="min-w-0">
            <label htmlFor={ids.token} className={FIELD_LABEL}>
              Airdropped token
            </label>
            <input
              id={ids.token}
              value={token}
              onChange={event => edit(setToken)(event.target.value)}
              placeholder="0x… or ETH"
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
              className={`${FIELD_INPUT} font-mono text-xs`}
            />
          </div>
        </div>
        <StakeAgeFields minWeeks={minWeeks} maxWeeks={maxWeeks} onMinWeeks={edit(setMinWeeks)} onMaxWeeks={edit(setMaxWeeks)} />
        <div className="min-w-0">
          <label htmlFor={ids.amount} className={FIELD_LABEL}>
            Amount
          </label>
          <input
            id={ids.amount}
            value={amount}
            onChange={event => edit(setAmount)(event.target.value)}
            placeholder="100"
            inputMode="decimal"
            autoComplete="off"
            maxLength={80}
            className={FIELD_INPUT}
          />
        </div>
        <TxError error={plan || preparing ? null : error} />
        <div className="flex justify-end">
          <button
            type="button"
            className="btn-primary min-h-[44px] px-5 text-sm"
            disabled={sending || preparing}
            onClick={() => void startReview()}
          >
            {isConnected ? 'Send' : 'Sign in to send'}
          </button>
        </div>
      </div>
      {plan || preparing ? (
        <TxConfirmDialog
          open
          preparing={!plan}
          onClose={closeReview}
          title={complete ? 'Airdrop sent' : 'Confirm airdrop'}
          rows={plan ? rowsOf(plan, info) : undefined}
          steps={plan ? plan.steps.map((step, at) => ({ key: String(at), title: step.label ?? step.functionName })) : []}
          activeIndex={plan ? landed : -1}
          stepsIntro={plan ? stepsIntro(plan.steps.length, landed) : undefined}
          action={confirmAction(
            tx.phase,
            tx.phase === 'error' ? 'Retry' : next?.functionName === 'approve' ? 'Confirm & approve' : 'Confirm & send',
          )}
          // Once a step has gone through, closing undoes nothing: what went through stays, and the next review finds it.
          cancelLabel={landed > 0 ? 'Close' : 'Cancel'}
          onConfirm={() => void confirm()}
          busy={sending}
          complete={complete}
          status={
            !plan ? (
              'Reading the token, your balance and allowance…'
            ) : tx.phase === 'success' ? (
              <ViewTransactionLink chainId={chainId} hash={tx.hash} />
            ) : (
              (sendingStatus(tx) ?? undefined)
            )
          }
          error={tx.error}
        />
      ) : null}
    </ModalShell>
  )
}
