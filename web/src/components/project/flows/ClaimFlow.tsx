'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { erc20Abi, formatUnits, type Address } from 'viem'
import { Refusal, refusalOf } from '@/components/project/flows/refusal'
import { reviewGate } from '@/components/project/flows/review-gate'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { confirmAction, sendingStatus, stepsIntro, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useStepPresses } from '@/hooks/useStepPresses'
import { useWallet } from '@/hooks/useWallet'
import { asked } from '@/lib/hook-logs'
import { preflight } from '@/lib/preflight'
import { stickyDistributorAbi, stickyHookAbi } from '@/lib/sticky-abis'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { stakedRewardGroups } from '@/lib/sticky-autostick'
import { claimAndStickTxs, collectTx } from '@/lib/sticky-builders'
import { asSentence } from '@/lib/sticky-format'
import type { Answer, StickyProjectInfo } from '@/lib/sticky-project'
import { quoteStick } from '@/lib/sticky-quotes'
import { refreshAfterCollect, refreshAfterRewardStick } from '@/lib/sticky-refresh'
import { groupLabel, hasRewardsToVest, need, readAt, type RewardCard } from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'
import { useViewAs } from '@/lib/viewAs'

const PREPARE_UNREADABLE = 'Could not prepare a claim of rewards; the pot says what could not be read.'
const CLAIM_UNREADABLE = 'Could not check the claim before sending a step of it; the dialog says so.'
const NOTHING_TO_CLAIM = 'There are no rewards to unlock or collect yet.'
const COLLECT_EFFECT =
  "Collects unlocked rewards and starts vesting finished rounds. This round's rewards stay locked until it ends."
const FORFEIT = 'Stake-age rewards pay only stake you still hold. Unstick before claiming and they stay in the pot.'
const RATE = 'Current backing price at execution, which can change before confirmation.'
const STANDING = "the auto-stick contract's standing with you"

/** What a review refused or could not read, and the account it was for (lowercase); a refusal of the wallet itself is no
 * account's, and stands until the wallet changes. */
type Failure = { message: string; account: string | null }

/** A claim under review: collecting one pot (which starts vesting what finished rounds earned), or claiming and sticking
 * the staked token's rewards across `groupIds`; who claims, what is ready, and the steps that send it. */
type Plan = {
  kind: 'collect' | 'stick'
  account: Address
  collectable: bigint
  groupIds: readonly bigint[]
  /** What the stick mints at least, when the adapter can already stick for the holder. */
  minted: bigint | null
  steps: readonly TxRequest[]
}

/** One pot collected for `account`, read now: what has unlocked, else whether finished rounds earned anything to start
 * vesting (a vesting-only collect can succeed and do nothing), and the collect tried against the chain (OLD
 * claimReward, app.js:4130). */
async function planCollect(info: StickyProjectInfo, card: RewardCard, account: Address, signal: AbortSignal): Promise<Plan> {
  const { chainId, stToken } = info
  const { distributor } = stickyDeployment(chainId)!
  const { groupId, token } = card
  const [ready] = (await asked(
    'what you can collect',
    () =>
      readAt(
        chainId,
        [{ address: distributor, abi: stickyDistributorAbi, functionName: 'collectableFor', args: [stToken, groupId, BigInt(account), token] }],
        undefined,
        signal,
      ),
    signal,
  )) as Answer<bigint>[]
  const collectable = need(ready, 'what you can collect')
  if (collectable === 0n && !(await hasRewardsToVest(chainId, stToken, account, token, groupId, { signal }))) {
    throw new Refusal(NOTHING_TO_CLAIM)
  }
  const step = collectTx(chainId, { stToken, groupId, holder: account, token, collectable })
  await preflight(step, account, signal, 'The distributor would refuse this')
  return { kind: 'collect', account, collectable, groupIds: [groupId], minted: null, steps: [step] }
}

/** The staked token's rewards claimed and stuck for `account`, read now: what is collectable across `groups`, whether
 * the adapter can stick for the holder and what it may move of their tokens, and, when it can stick already, what the
 * stick mints at least (OLD claimAndStick, app.js:4549). */
async function planClaimAndStick(
  info: StickyProjectInfo,
  groups: readonly bigint[],
  account: Address,
  signal: AbortSignal,
): Promise<Plan> {
  const { chainId, projectId, stakedToken } = info
  const { autoStick, hook } = stickyDeployment(chainId)!
  const { groupIds, collectable } = await stakedRewardGroups(chainId, info, account, groups, { signal })
  if (collectable === 0n) throw new Refusal('Nothing is claimable yet. Rewards unlock a round after you collect them.')
  const [granter, trusted, allowed] = (await asked(
    STANDING,
    () =>
      readAt(
        chainId,
        [
          { address: hook, abi: stickyHookAbi, functionName: 'isGranterOf', args: [projectId, autoStick] },
          { address: hook, abi: stickyHookAbi, functionName: 'isTrustedSenderOf', args: [projectId, account, autoStick] },
          { address: stakedToken, abi: erc20Abi, functionName: 'allowance', args: [account, autoStick] },
        ],
        undefined,
        signal,
      ),
    signal,
  )) as Answer<unknown>[]
  const canStick = need(granter as Answer<boolean>, STANDING) || need(trusted as Answer<boolean>, STANDING)
  const allowance = need(allowed as Answer<bigint>, STANDING)
  // A trust step that has not been sent cannot be quoted for: the adapter quotes on chain, and refuses a mint of nothing.
  const minted = canStick
    ? await quoteStick(chainId, projectId, stakedToken, collectable, autoStick, account, { signal }).catch(reason => {
        throw refusalOf(reason)
      })
    : null
  return {
    kind: 'stick',
    account,
    collectable,
    groupIds,
    minted,
    steps: claimAndStickTxs(info, { groupIds, collectable, allowance, canStick }),
  }
}

/** The review's rows, every figure exact. */
function rowsOf(plan: Plan, info: StickyProjectInfo, card: RewardCard): TxConfirmRow[] {
  const on = { label: 'On', value: chainName(info.chainId) }
  if (plan.kind === 'stick') {
    return [
      { label: 'Claim', value: `${formatUnits(plan.collectable, info.decimals)} ${info.symbol}`, strong: true },
      {
        label: 'Estimated Sticky tokens',
        value: plan.minted === null ? 'Quoted on chain after your trust step' : `${formatUnits(plan.minted, 18)} ${info.stSymbol}`,
      },
      { label: 'Rate', value: RATE },
      on,
    ]
  }
  return [
    { label: 'Ready', value: `${formatUnits(plan.collectable, card.meta.decimals)} ${card.meta.symbol}`, strong: true },
    { label: 'Who', value: groupLabel(card.groupId) },
    { label: 'Effect', value: COLLECT_EFFECT },
    ...(card.groupId === 0n ? [] : [{ label: 'Forfeit', value: FORFEIT }]),
    on,
  ]
}

/** What the button that sends a step says. */
function actionOf(step: TxRequest | undefined, plan: Plan): string {
  if (plan.kind === 'collect') return plan.collectable > 0n ? 'Confirm & collect' : 'Confirm & start vesting'
  if (step?.functionName === 'approve') return 'Confirm & approve'
  if (step?.functionName === 'setTrustedSenderFor') return 'Confirm & trust'
  return 'Confirm & stick'
}

/**
 * A reward pot's actions for the holder: collect what has unlocked (which starts vesting what finished rounds earned, in
 * the same call), start vesting when only that is there, and for the staked token, when the auto-stick adapter can stick
 * for the holder, claim and stick it in one call with "Collect only" beside it. `canStick` says what the auto-stick card
 * read of that; each review reads it again.
 *
 * A review reads the pot, or the staked token's rewards across `groups` and the adapter's standing, and refuses a claim
 * of nothing before it opens. Claim & stick lists an approval of the claim to the adapter when the allowance does not
 * cover it, a trust of the adapter when neither the holder nor the project lets it stick, and the claim; each step is
 * sent on its own press, from the account that reviewed it, and the claim is read again before each. A wallet that
 * cannot send, Signa or View as, is refused when a review starts, under the buttons.
 */
export function ClaimFlow({
  chainId,
  projectId,
  info,
  card,
  groups,
  canStick,
  onReviewing,
}: {
  chainId: number
  projectId: number
  info: StickyProjectInfo
  card: RewardCard
  /** The groups the project's rewards are in, which a claim and stick collects from. */
  groups: readonly bigint[]
  canStick: boolean
  /** Hears whether a review of this pot is open, which the card keeps the pot listed for. */
  onReviewing?: (open: boolean) => void
}) {
  const { address, isConnected, isCenterWallet, openSignIn } = useWallet()
  const { viewAs } = useViewAs()
  const tx = useSafeTx(chainId)
  const presses = useStepPresses(tx)
  const { landed } = presses
  const client = useQueryClient()
  const [plan, setPlan] = useState<Plan | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const reading = useRef<AbortController | null>(null)

  const sending = tx.busy || tx.phase === 'review'
  const complete = plan !== null && landed === plan.steps.length
  const shown = address?.toLowerCase() ?? null
  const error = failure && (failure.account === null || failure.account === shown) ? failure.message : null
  const staked = card.token === info.stakedToken.toLowerCase()
  const { collectable, earned } = card.position

  async function startReview(kind: Plan['kind']) {
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
      const next =
        kind === 'stick' ? await planClaimAndStick(info, groups, account, signal) : await planCollect(info, card, account, signal)
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

  /** A claim and stick approves exactly what was collectable, so before each step that is read again: a claim that
   * has grown or shrunk is reviewed again. A claim that cannot be read stops the step, and the console is told why. */
  async function verify(reviewed: Plan) {
    if (reviewed.kind !== 'stick') return
    let now: bigint
    try {
      ;({ collectable: now } = await stakedRewardGroups(chainId, info, reviewed.account, reviewed.groupIds))
    } catch (reason) {
      console.warn(CLAIM_UNREADABLE, { chainId, projectId }, reason)
      throw new Error(asSentence(reason instanceof Error ? reason.message : String(reason)), { cause: reason })
    }
    if (now !== reviewed.collectable) throw new Error('Your claimable rewards changed. Review again.')
  }

  async function confirm() {
    if (!plan || sending) return
    // Every step is sent as the account that reviewed the claim, and the engine refuses it while another is connected.
    await presses.press(plan.steps, (step, confirmedAt) =>
      tx.send(step, { reviewedAccount: plan.account, simulationBlockNumber: confirmedAt, reverify: () => verify(plan) }),
    )
  }

  function close() {
    reading.current?.abort()
    setPlan(null)
    setPreparing(false)
    if (tx.phase !== 'success') tx.dismiss()
  }

  useEffect(() => {
    setFailure(current => (current?.account === null ? null : current))
  }, [address, isCenterWallet, viewAs])

  // What a claim changed is read again once it has confirmed.
  useEffect(() => {
    if (!complete || !plan) return
    if (plan.kind === 'stick') refreshAfterRewardStick(client, chainId, projectId, plan.account)
    else refreshAfterCollect(client, chainId, projectId, plan.account)
  }, [complete, plan, client, chainId, projectId])

  useEffect(() => () => reading.current?.abort(), [])

  // A review stays open until it is closed, whatever its pot comes to show once its step lands.
  const open = plan !== null || preparing
  const reviewing = useRef(onReviewing)
  reviewing.current = onReviewing
  useEffect(() => reviewing.current?.(open), [open])

  const actions: { label: string; kind: Plan['kind']; primary: boolean }[] =
    staked && canStick && collectable > 0n
      ? [
          { label: 'Claim & stick', kind: 'stick', primary: true },
          { label: 'Collect only', kind: 'collect', primary: false },
        ]
      : collectable > 0n
        ? [{ label: 'Collect', kind: 'collect', primary: false }]
        : earned > 0n
          ? [{ label: 'Start vesting', kind: 'collect', primary: false }]
          : []
  if (!actions.length && !open && error === null) return null

  const symbol = plan?.kind === 'stick' ? info.symbol : card.meta.symbol
  const doneTitle = plan?.kind === 'stick' ? 'Rewards claimed and stuck' : plan && plan.collectable > 0n ? 'Rewards collected' : 'Unlocking started'

  return (
    <>
      {actions.length ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {actions.map(({ label, kind, primary }) => (
            <button
              key={label}
              type="button"
              disabled={sending || preparing}
              onClick={() => void startReview(kind)}
              className={`${primary ? 'btn-primary' : 'btn-secondary'} px-3 py-1.5 text-sm`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <TxError error={open ? null : error} />
      {open ? (
        <TxConfirmDialog
          open
          preparing={!plan}
          onClose={close}
          title={complete ? doneTitle : plan?.kind === 'stick' ? `Claim & stick ${symbol} rewards` : `Claim ${symbol} rewards`}
          rows={plan ? rowsOf(plan, info, card) : undefined}
          steps={plan ? plan.steps.map((step, at) => ({ key: String(at), title: step.label ?? step.functionName })) : []}
          activeIndex={plan ? landed : -1}
          stepsIntro={plan ? stepsIntro(plan.steps.length, landed) : undefined}
          action={confirmAction(tx.phase, tx.phase === 'error' ? 'Retry' : plan ? actionOf(plan.steps[landed], plan) : 'Confirm')}
          cancelLabel={landed > 0 ? 'Close' : 'Cancel'}
          onConfirm={() => void confirm()}
          busy={sending}
          complete={complete}
          settled={tx.phase === 'submitted'}
          status={
            !plan ? (
              'Reading your rewards…'
            ) : tx.phase === 'success' ? (
              <ViewTransactionLink chainId={chainId} hash={tx.hash} />
            ) : (
              (sendingStatus(tx) ?? undefined)
            )
          }
          error={tx.error}
        />
      ) : null}
    </>
  )
}
