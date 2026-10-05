'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { formatUnits, maxUint256, type Address } from 'viem'
import { Refusal, refusalOf } from '@/components/project/flows/refusal'
import { reviewGate } from '@/components/project/flows/review-gate'
import { FIELD_INPUT, FIELD_LABEL } from '@/components/project/StakeAgeFields'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { confirmAction, sendingStatus, stepsIntro, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useStepPresses } from '@/hooks/useStepPresses'
import { useWallet } from '@/hooks/useWallet'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { parseAmount } from '@/lib/sticky-amount'
import { AS_STATUS, hasLeftovers, readAutoStick, vestableRewardGroups, type AutoStickState } from '@/lib/sticky-autostick'
import {
  autoStickLeftoverTxs,
  autoStickOffTxs,
  autoStickOnTxs,
  autoStickSettingsTx,
  beginVestingTx,
  compoundTx,
  repairTxs,
  type AutoStickChoice,
} from '@/lib/sticky-builders'
import { asSentence, formatDuration, stickyLabel } from '@/lib/sticky-format'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { quoteStick } from '@/lib/sticky-quotes'
import { refreshAfterAutoStick, refreshAfterCollect, refreshAfterRewardStick } from '@/lib/sticky-refresh'
import { readRewardSchedule, unlockSentence } from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'
import { useViewAs } from '@/lib/viewAs'

const PREPARE_UNREADABLE = "Could not prepare a change of auto-stick; the card says what could not be read."
const SCHEDULE_UNREADABLE = "Could not read the distributor's unlock schedule; the auto-stick form leaves it out."
const ISSUANCE = 'Priced at the backing when it runs. A mint of zero tokens reverts.'
const ALLOWANCE_HINT = 'Auto-stick can only pull rewards it just delivered to you, and only to stick them.'

/** The cooldowns the form offers, as the old client named them. */
const COOLDOWNS = [
  { label: 'DAY', seconds: 86_400 },
  { label: 'WEEK', seconds: 604_800 },
  { label: 'MONTH', seconds: 2_592_000 },
] as const
const WEEK = 604_800

/** What a press of the card asks for: the form to turn it on (or renew its allowance) or change its settings, or a
 * review of one of the others. `cleanup` takes back what an auto-stick that is off still has of the holder's. */
type Action = 'enable' | 'settings' | 'off' | 'repair' | 'now' | 'vest' | 'cleanup'
type FormMode = 'enable' | 'settings'

/** What the form holds: the minimum as typed, the cooldown, and the allowance, unlimited or a cap as typed. */
type Form = { mode: FormMode; minimum: string; cooldown: number; unlimited: boolean; cap: string }

/** What a review refused or could not read, and the account it was for (lowercase); a refusal of the wallet itself is no
 * account's, and stands until the wallet changes. */
type Failure = { message: string; account: string | null }

/** A change of auto-stick under review: for whom, the steps that send it, and what the dialog says of it. */
type Plan = {
  action: Action
  account: Address
  steps: readonly TxRequest[]
  rows: TxConfirmRow[]
  title: string
  doneTitle: string
}

/** The holder's choice, as the adapter takes it: the minimum in the staked token's units, more than nothing, and the cap,
 * unlimited or more than nothing. */
function choiceOf(form: Form, { decimals }: Pick<StickyProjectInfo, 'decimals'>): AutoStickChoice {
  let minimum: bigint
  try {
    minimum = parseAmount(form.minimum, decimals)
  } catch (reason) {
    throw new Refusal(asSentence((reason as Error).message))
  }
  if (minimum === 0n) throw new Refusal('Enter an amount greater than zero.')
  if (form.unlimited || form.mode === 'settings') return { minimum, cooldown: form.cooldown, cap: maxUint256 }
  let cap = 0n
  if (form.cap.trim() !== '') {
    try {
      cap = parseAmount(form.cap, decimals)
    } catch (reason) {
      throw new Refusal(asSentence((reason as Error).message))
    }
  }
  if (cap === 0n) throw new Refusal('Set an allowance cap, or choose unlimited.')
  return { minimum, cooldown: form.cooldown, cap }
}

/**
 * A change of auto-stick for `account`, planned from what the chain says of it now (`readAutoStick`), as the old client
 * planned each (OLD app.js:4423-4547). A repair whose allowance has run out asks for the form to renew it instead.
 */
async function planAutoStick(
  action: Action,
  {
    info,
    groups,
    account,
    form,
    signal,
  }: { info: StickyProjectInfo; groups: readonly bigint[]; account: Address; form: Form | null; signal: AbortSignal },
): Promise<Plan | 'renew'> {
  const { chainId, projectId, stakedToken, symbol, decimals, stSymbol } = info
  const label = stickyLabel(info)
  const on = { label: 'On', value: chainName(chainId) }
  const choice = action === 'enable' || action === 'settings' ? choiceOf(form!, info) : null
  const state = await readAutoStick(chainId, projectId, account, { info, groups, signal })
  if (state.status === AS_STATUS.INVALID_PROJECT) throw new Refusal('Auto-stick is unavailable for this project.')
  const when = (chosen: AutoStickChoice) => [
    { label: 'Auto-stick when', value: `at least ${formatUnits(chosen.minimum, decimals)} ${symbol} is ready` },
    { label: 'At most', value: `once every ${formatDuration(chosen.cooldown)}` },
  ]
  switch (action) {
    case 'enable':
      return {
        action,
        account,
        steps: autoStickOnTxs(info, state, choice!),
        rows: [
          ...when(choice!),
          { label: 'Allowance', value: choice!.cap === maxUint256 ? 'Unlimited' : `${formatUnits(choice!.cap, decimals)} ${symbol}` },
          on,
        ],
        title: `Turn on auto-stick for ${label}`,
        doneTitle: 'Auto-stick is on',
      }
    case 'settings':
      return {
        action,
        account,
        steps: [autoStickSettingsTx(info, state, choice!)],
        rows: [...when(choice!), on],
        title: `Auto-stick settings for ${label}`,
        doneTitle: 'Auto-stick settings saved',
      }
    case 'off':
      if (!state.enabled) throw new Refusal('Auto-stick is off already.')
      return {
        action,
        account,
        steps: autoStickOffTxs(info, state),
        rows: [{ label: 'Effect', value: 'Future rewards stay claimable as usual.' }, on],
        title: `Turn off auto-stick for ${label}`,
        doneTitle: 'Auto-stick is off',
      }
    case 'repair':
      if (state.status === AS_STATUS.INSUFFICIENT_ALLOWANCE) return 'renew'
      return {
        action,
        account,
        steps: repairTxs(info, state),
        rows: [{ label: 'Effect', value: 'The auto-stick contract can stick for you again.' }, on],
        title: `Repair auto-stick for ${label}`,
        doneTitle: 'Auto-stick permission restored',
      }
    case 'now': {
      if (state.status !== AS_STATUS.READY) throw new Refusal('Auto-stick is not ready. Its settings or rewards changed.')
      const { autoStick } = stickyDeployment(chainId)!
      const minted = await quoteStick(chainId, projectId, stakedToken, state.collectable, autoStick, account, { signal })
      return {
        action,
        account,
        steps: [compoundTx(info, account, state.groupIds)],
        rows: [
          { label: 'Stick', value: `${formatUnits(state.collectable, decimals)} ${symbol} of unlocked rewards`, strong: true },
          { label: 'Estimated Sticky tokens', value: `${formatUnits(minted, 18)} ${stSymbol}` },
          { label: 'Issuance', value: ISSUANCE },
          on,
        ],
        title: `Stick ready ${symbol} rewards`,
        doneTitle: 'Rewards auto-stuck',
      }
    }
    case 'cleanup': {
      if (state.enabled) throw new Refusal('Auto-stick is on. Turn it off instead.')
      const steps = autoStickLeftoverTxs(info, state)
      if (!steps.length) throw new Refusal('Auto-stick has no permissions left to remove.')
      const kept = [state.personallyTrusted ? 'stick for you' : '', state.allowance > 0n ? `move your ${symbol}` : '']
      return {
        action,
        account,
        steps,
        rows: [{ label: 'Effect', value: `The auto-stick contract can no longer ${kept.filter(Boolean).join(' or ')}.` }, on],
        title: 'Remove auto-stick permissions',
        doneTitle: 'Permissions removed',
      }
    }
    case 'vest': {
      if (!state.enabled) throw new Refusal('Turn on auto-stick before starting automatic reward unlocking.')
      const groupIds = await vestableRewardGroups(chainId, info, account, groups, { signal })
      if (!groupIds.length) throw new Refusal('There are no new reward rounds to unlock.')
      return {
        action,
        account,
        steps: [beginVestingTx(info, account, groupIds)],
        rows: [{ label: 'Effect', value: `Starts the unlock schedule for your ${symbol} rewards. No tokens move.` }, on],
        title: `Start unlocking ${symbol} rewards`,
        doneTitle: 'Unlocking started',
      }
    }
  }
}

/** What the button that sends a step says: approvals and trust that a teardown takes back say so. */
function actionOf(step: TxRequest | undefined, action: Action): string {
  const takesBack = action === 'off' || action === 'cleanup'
  switch (step?.functionName) {
    case 'setConfigFor':
      return step.args[1] === false ? 'Confirm & turn off' : action === 'settings' ? 'Confirm & save' : 'Confirm & turn on'
    case 'approve':
      return takesBack ? 'Confirm & remove allowance' : 'Confirm & approve'
    case 'setTrustedSenderFor':
      return step.args[2] === false ? 'Confirm & remove permission' : 'Confirm & trust'
    case 'beginVestingFor':
      return 'Confirm & start unlocking'
    default:
      return 'Confirm & stick'
  }
}

/** A choice among a few, each a button that says whether it is the one chosen. `name` marks the group. */
function Choices<T>({
  name,
  label,
  options,
  chosen,
  onChoose,
}: {
  name: string
  label: string
  options: readonly { label: string; value: T }[]
  chosen: T
  onChoose: (value: T) => void
}) {
  return (
    <div className="min-w-0">
      <p className={FIELD_LABEL}>{label}</p>
      <div role="group" aria-label={label} data-choices={name} className="flex flex-wrap gap-2">
        {options.map(option => (
          <button
            key={option.label}
            type="button"
            aria-pressed={option.value === chosen}
            onClick={() => onChoose(option.value)}
            className={`${option.value === chosen ? 'btn-primary' : 'btn-secondary'} px-3 py-1.5 text-sm`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * The auto-stick card's actions for the connected holder: turning auto-stick on (OLD saveAutoStick and its dialog,
 * index.html:1262-1289), renewing its allowance, changing its settings, turning it off, repairing its permission,
 * sticking ready rewards now and starting finished rounds unlocking. `state` is what the card shows, which says what is
 * offered; each review reads the holder's auto-stick again and plans from that.
 *
 * Turning it on and its settings open a form (the minimum, the cooldown, and to turn it on the allowance, unlimited or a
 * cap), whose review replaces it in the same card; the others open their review at once. Each step is sent on its own
 * press, from the account that reviewed it, and what auto-stick changed is read again once the review is done or closed
 * after a step went through. A wallet that cannot send, Signa or View as, is refused when a review starts.
 */
export function AutoStickFlow({
  chainId,
  projectId,
  info,
  state,
  groups,
}: {
  chainId: number
  projectId: number
  info: StickyProjectInfo
  state: AutoStickState
  /** The groups the project's rewards are in, which auto-stick reads and starts unlocking. */
  groups: readonly bigint[]
}) {
  const { address, isConnected, isCenterWallet, openSignIn } = useWallet()
  const { viewAs } = useViewAs()
  const tx = useSafeTx(chainId)
  const presses = useStepPresses(tx)
  const { landed } = presses
  const client = useQueryClient()
  const minimumId = useId()
  const capId = useId()
  const [form, setForm] = useState<Form | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const reading = useRef<AbortController | null>(null)

  const schedule = useQuery({
    queryKey: ['sticky-reward-schedule', chainId],
    queryFn: async ({ signal }) => {
      try {
        return await readRewardSchedule(chainId, { signal })
      } catch (error) {
        if (!signal.aborted) console.warn(SCHEDULE_UNREADABLE, { chainId }, error)
        throw error
      }
    },
    enabled: form !== null,
    staleTime: Infinity,
    retry: false,
  })

  const sending = tx.busy || tx.phase === 'review'
  const complete = plan !== null && landed === plan.steps.length
  const shown = address?.toLowerCase() ?? null
  const error = failure && (failure.account === null || failure.account === shown) ? failure.message : null

  /** The form, as the holder's settings now have it: a minimum of 1 and a week for one never set up. */
  const openForm = (mode: FormMode) =>
    setForm({
      mode,
      minimum: state.minimum > 0n ? formatUnits(state.minimum, info.decimals) : '1',
      cooldown: state.cooldown || WEEK,
      unlimited: true,
      cap: '',
    })

  async function startReview(action: Action) {
    const gate = reviewGate({ address, isConnected, isCenterWallet })
    if (!gate) return void openSignIn()
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
      const next = await planAutoStick(action, { info, groups, account, form, signal })
      if (signal.aborted) return
      if (next === 'renew') openForm('enable')
      else setPlan(next)
    } catch (reason) {
      if (signal.aborted) return
      const told = refusalOf(reason)
      if (!(told instanceof Refusal)) console.warn(PREPARE_UNREADABLE, { chainId, projectId }, told)
      setFailure({ message: asSentence(told instanceof Error ? told.message : String(told)), account: account.toLowerCase() })
    } finally {
      if (!signal.aborted) setPreparing(false)
    }
  }

  async function confirm() {
    if (!plan || sending) return
    // Every step is sent as the account that reviewed the change, and the engine refuses it while another is connected.
    await presses.press(plan.steps, (step, confirmedAt) =>
      tx.send(step, { reviewedAccount: plan.account, simulationBlockNumber: confirmedAt }),
    )
  }

  /** Closes the review, and the form with it once the change is done. A review closed after a step went through reads
   * auto-stick again, so the card says where it stands. */
  function closeReview() {
    reading.current?.abort()
    if (plan && !complete && landed > 0) refreshAfterAutoStick(client, chainId, projectId, plan.account)
    if (complete) setForm(null)
    setPlan(null)
    setPreparing(false)
    if (tx.phase !== 'success') tx.reset()
  }

  function closeForm() {
    reading.current?.abort()
    setForm(null)
    setFailure(null)
  }

  useEffect(() => {
    setFailure(current => (current?.account === null ? null : current))
  }, [address, isCenterWallet, viewAs])

  // What a change of auto-stick changed is read again once it has confirmed: a stick now mints for the holder, and
  // starting unlocking moves their rewards along, as a collect does.
  useEffect(() => {
    if (!complete || !plan) return
    if (plan.action === 'now') refreshAfterRewardStick(client, chainId, projectId, plan.account)
    else if (plan.action === 'vest') refreshAfterCollect(client, chainId, projectId, plan.account)
    else refreshAfterAutoStick(client, chainId, projectId, plan.account)
  }, [complete, plan, client, chainId, projectId])

  useEffect(() => () => reading.current?.abort(), [])

  const { enabled, status, canBeginVesting } = state
  const buttons: { label: string; press: () => void; primary?: boolean }[] = [
    enabled
      ? { label: 'Turn off auto-stick', press: () => void startReview('off'), primary: true }
      : { label: 'Turn on auto-stick', press: () => openForm('enable'), primary: true },
    ...(enabled && status === AS_STATUS.READY ? [{ label: 'Stick ready rewards now', press: () => void startReview('now') }] : []),
    ...(canBeginVesting ? [{ label: 'Start unlocking', press: () => void startReview('vest') }] : []),
    ...(enabled && status === AS_STATUS.NOT_TRUSTED ? [{ label: 'Repair permission', press: () => void startReview('repair') }] : []),
    ...(enabled && status === AS_STATUS.INSUFFICIENT_ALLOWANCE ? [{ label: 'Renew allowance', press: () => openForm('enable') }] : []),
    ...(enabled ? [{ label: 'Settings', press: () => openForm('settings') }] : []),
    ...(hasLeftovers(state) ? [{ label: 'Remove leftover permissions', press: () => void startReview('cleanup') }] : []),
  ]

  const review =
    plan || preparing ? (
      <TxConfirmDialog
        open
        preparing={!plan}
        onClose={closeReview}
        title={complete ? plan!.doneTitle : (plan?.title ?? 'Auto-stick')}
        rows={plan?.rows}
        steps={plan ? plan.steps.map((step, at) => ({ key: String(at), title: step.label ?? step.functionName })) : []}
        activeIndex={plan ? landed : -1}
        stepsIntro={plan ? stepsIntro(plan.steps.length, landed) : undefined}
        action={confirmAction(tx.phase, tx.phase === 'error' ? 'Retry' : plan ? actionOf(plan.steps[landed], plan.action) : 'Confirm')}
        cancelLabel={landed > 0 ? 'Close' : 'Cancel'}
        onConfirm={() => void confirm()}
        busy={sending}
        complete={complete}
        status={
          !plan ? (
            'Reading your auto-stick…'
          ) : tx.phase === 'success' ? (
            <ViewTransactionLink chainId={chainId} hash={tx.hash} />
          ) : (
            (sendingStatus(tx) ?? undefined)
          )
        }
        error={tx.error}
      />
    ) : null

  const blurb = schedule.data ? unlockSentence(schedule.data) : ''

  return (
    <>
      <div data-autostick-actions className="flex flex-wrap gap-2">
        {buttons.map(({ label, press, primary }) => (
          <button
            key={label}
            type="button"
            disabled={sending || preparing}
            onClick={press}
            className={`${primary ? 'btn-primary' : 'btn-secondary'} px-3 py-1.5 text-sm`}
          >
            {label}
          </button>
        ))}
      </div>
      {form ? null : <TxError error={plan || preparing ? null : error} />}
      {form ? (
        <ModalShell
          title={form.mode === 'settings' ? 'Auto-stick settings' : 'Turn on auto-stick'}
          onClose={plan || preparing ? closeReview : closeForm}
          maxWidth="max-w-md"
        >
          <div className="space-y-4">
            {blurb ? <p className="text-sm text-muted">{blurb}</p> : null}
            <div className="min-w-0">
              <label htmlFor={minimumId} className={FIELD_LABEL}>
                {`Minimum ${info.symbol} per auto-stick`}
              </label>
              <input
                id={minimumId}
                value={form.minimum}
                onChange={event => {
                  setForm({ ...form, minimum: event.target.value })
                  setFailure(null)
                }}
                placeholder="1"
                inputMode="decimal"
                autoComplete="off"
                maxLength={80}
                className={FIELD_INPUT}
              />
            </div>
            <Choices
              name="cooldown"
              label="At most once every"
              options={COOLDOWNS.map(({ label, seconds }) => ({ label, value: seconds }))}
              chosen={form.cooldown}
              onChoose={cooldown => setForm({ ...form, cooldown })}
            />
            {form.mode === 'enable' ? (
              <div className="space-y-2">
                <Choices
                  name="allowance"
                  label="Token allowance"
                  options={[
                    { label: 'UNLIMITED', value: true },
                    { label: 'CUSTOM CAP', value: false },
                  ]}
                  chosen={form.unlimited}
                  onChoose={unlimited => setForm({ ...form, unlimited })}
                />
                <p className="text-[13px] text-muted">{ALLOWANCE_HINT}</p>
                {form.unlimited ? null : (
                  <div className="min-w-0">
                    <label htmlFor={capId} className={FIELD_LABEL}>
                      {`Allowance cap (${info.symbol})`}
                    </label>
                    <input
                      id={capId}
                      value={form.cap}
                      onChange={event => {
                        setForm({ ...form, cap: event.target.value })
                        setFailure(null)
                      }}
                      placeholder="100"
                      inputMode="decimal"
                      autoComplete="off"
                      maxLength={80}
                      className={FIELD_INPUT}
                    />
                  </div>
                )}
              </div>
            ) : null}
            <TxError error={plan || preparing ? null : error} />
            <div className="flex justify-end">
              <button
                type="button"
                className="btn-primary min-h-[44px] px-5 text-sm"
                disabled={sending || preparing}
                onClick={() => void startReview(form.mode)}
              >
                {form.mode === 'settings' ? 'Save settings' : 'Turn on auto-stick'}
              </button>
            </div>
          </div>
          {review}
        </ModalShell>
      ) : (
        review
      )}
    </>
  )
}
