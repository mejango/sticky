'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { formatUnits, type Address } from 'viem'
import { Refusal, refusalOf } from '@/components/project/flows/refusal'
import { reviewGate } from '@/components/project/flows/review-gate'
import { parseRewardToken } from '@/components/project/flows/reward-token'
import { FIELD_INPUT, FIELD_LABEL, StakeAgeFields } from '@/components/project/StakeAgeFields'
import { CopyAddress } from '@/components/ui/CopyAddress'
import { DETAIL_LABEL, DETAIL_LIST, DETAIL_VALUE } from '@/components/ui/detail-list'
import { Disclosure } from '@/components/ui/Disclosure'
import { Skeleton } from '@/components/ui/Skeleton'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { confirmAction, sendingStatus, stepsIntro, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useStepPresses } from '@/hooks/useStepPresses'
import { useWallet } from '@/hooks/useWallet'
import { preflight } from '@/lib/preflight'
import { FRESH_MS, warned } from '@/lib/query-reads'
import { createReceiverTx, settleTx } from '@/lib/sticky-builders'
import { asSentence, formatAmount } from '@/lib/sticky-format'
import { projectKey } from '@/lib/sticky-keys'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { readArrivals, readReceiver } from '@/lib/sticky-receivers'
import { refreshAfterReceiver, refreshAfterSettle } from '@/lib/sticky-refresh'
import { groupIdFromWeeks, groupLabel, groupNote, NATIVE_REWARD_TOKEN, rewardTokenMeta, type TokenMeta } from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'
import { useViewAs } from '@/lib/viewAs'

const RECEIVER_UNREADABLE = "Could not read a group's reward address; the Airdrops tab says so."
const ARRIVALS_UNREADABLE = 'Could not read what a reward address holds to settle; the Airdrops tab leaves it out.'
const PREPARE_UNREADABLE = 'Could not prepare a reward address step; the panel says what could not be read.'
const REFUSES = 'The reward receiver factory would refuse this'
const NOT_ERC20 = 'Enter an ERC-20 token address'

/** What a review refused or could not read, and the account it was for (lowercase); a refusal of the wallet itself is no
 * account's, and stands until the wallet changes. */
type Failure = { message: string; account: string | null }

/** A reward address step under review: creating the address, or settling what it holds of a token. */
type Plan = {
  kind: 'create' | 'settle'
  account: Address
  /** The token a settle settles, in lowercase. */
  token: Address | null
  steps: readonly TxRequest[]
  rows: TxConfirmRow[]
}

/** What a reward address holds of `token`, for the panel, with the token's symbol and decimals; or, for an address that
 * is no token, the line that says so, which is the chain's answer and so not told to the console. */
async function arrivalsOf(
  chainId: number,
  receiver: Address,
  token: Address,
  signal: AbortSignal,
): Promise<{ refused: string } | { meta: TokenMeta; amount: bigint }> {
  let meta: TokenMeta
  try {
    meta = await rewardTokenMeta(chainId, token, { signal })
  } catch (reason) {
    const told = refusalOf(reason)
    if (signal.aborted || !(told instanceof Refusal)) throw reason
    return { refused: asSentence(told.message) }
  }
  return { meta, amount: await readArrivals(chainId, receiver, token, { signal }) }
}

/** The group the weeks name, or the reason they name none, as a refusal. */
function groupOf(minWeeks: string, maxWeeks: string): bigint {
  try {
    return groupIdFromWeeks(minWeeks, maxWeeks)
  } catch (reason) {
    throw new Refusal(asSentence((reason as Error).message))
  }
}

/** The group's reward address created, read now: one that exists already is refused, and the creation is tried
 * against the chain as the holder will send it (OLD createRewardAddress, app.js:4064). */
async function planCreate(info: StickyProjectInfo, groupId: bigint, account: Address, signal: AbortSignal): Promise<Plan> {
  const { chainId, stToken } = info
  const { address, created } = await readReceiver(chainId, stToken, groupId, { signal })
  if (created) throw new Refusal('This reward address is created already.')
  const step = createReceiverTx(chainId, { stToken, groupId })
  await preflight(step, account, signal, REFUSES)
  return {
    kind: 'create',
    account,
    token: null,
    steps: [step],
    rows: [
      { label: 'Who', value: groupLabel(groupId) },
      { label: 'Reward address', value: address, mono: true },
      { label: 'On', value: chainName(chainId) },
    ],
  }
}

/** What the group's reward address holds of an ERC-20 settled into airdrops, read now: ETH is refused, and so are an
 * address with nothing to settle and a factory that settles into another distributor; the settle is tried against the
 * chain as the holder will send it (OLD settleArrivals, app.js:4591). */
async function planSettle(
  info: StickyProjectInfo,
  groupId: bigint,
  tokenText: string,
  account: Address,
  signal: AbortSignal,
): Promise<Plan> {
  const { chainId, stToken, stakedToken } = info
  const token = parseRewardToken(tokenText, stakedToken)
  if (!token) throw new Refusal(`${NOT_ERC20}.`)
  if (token.toLowerCase() === NATIVE_REWARD_TOKEN) throw new Refusal('Reward receivers settle ERC-20 tokens. Fund ETH rewards directly.')
  const receiver = await readReceiver(chainId, stToken, groupId, { signal })
  const meta = await rewardTokenMeta(chainId, token, { signal })
  const pending = await readArrivals(chainId, receiver.address, token, { signal })
  if (pending === 0n) throw new Refusal(`There are no ${meta.symbol} arrivals to settle.`)
  const step = settleTx(chainId, { stToken, groupId, token })
  await preflight(step, account, signal, REFUSES)
  return {
    kind: 'settle',
    account,
    token: token.toLowerCase() as Address,
    steps: [step],
    rows: [
      { label: 'Settle', value: `${formatUnits(pending, meta.decimals)} ${meta.symbol}`, strong: true },
      { label: 'Who', value: groupLabel(groupId) },
      { label: 'Receiver', value: receiver.address, mono: true },
      { label: 'Effect', value: "The receiver's whole balance becomes this round's rewards for those holders." },
      { label: 'On', value: chainName(chainId) },
    ],
  }
}

/**
 * The reward address of a group of the project's holders, behind its disclosure (OLD index.html:981-1002): one receiver
 * for each Sticky token and group, which turns plain transfers, like a launchpad's fee payouts, into airdrops once anyone
 * settles them. Its address is fixed before it exists, so it can be given out at once. Opened, it reads where the address
 * is and whether it has been created, and what it holds of the token to settle (blank for the staked token); the factory
 * is held to this deployment's distributor first.
 *
 * Create onchain and Settle into airdrops each open a review, which reads the address again, refuses what cannot be done
 * (an address created already, ETH, nothing to settle) and tries the step against the chain before it opens; the step is
 * sent from the account that reviewed it. Signa and View as are refused when a review starts. `onSettled` hears the
 * token of a settle that went through.
 */
export function ReceiverFlow({
  chainId,
  projectId,
  info,
  onSettled,
}: {
  chainId: number
  projectId: number
  info: StickyProjectInfo
  onSettled: (token: Address) => void
}) {
  const { address, isConnected, isCenterWallet, openSignIn } = useWallet()
  const { viewAs } = useViewAs()
  const tx = useSafeTx(chainId)
  const presses = useStepPresses(tx)
  const { landed } = presses
  const client = useQueryClient()
  const tokenId = useId()
  const [opened, setOpened] = useState(false)
  const [minWeeks, setMinWeeks] = useState('')
  const [maxWeeks, setMaxWeeks] = useState('')
  const [tokenText, setTokenText] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const reading = useRef<AbortController | null>(null)
  const settledToken = useRef(onSettled)
  settledToken.current = onSettled

  const { groupId } = groupNote(minWeeks, maxWeeks)
  const receiver = useQuery({
    queryKey: [...projectKey(chainId, projectId, 'receiver'), groupId?.toString() ?? ''],
    queryFn: ({ signal }) =>
      warned(RECEIVER_UNREADABLE, { chainId, projectId }, signal, () => readReceiver(chainId, info.stToken, groupId!, { signal })),
    enabled: opened && groupId !== null,
    staleTime: FRESH_MS,
    retry: false,
  })
  const token = parseRewardToken(tokenText, info.stakedToken)
  const erc20 = token && token.toLowerCase() !== NATIVE_REWARD_TOKEN ? token : null
  const at = receiver.data?.address
  const arrivals = useQuery({
    queryKey: [...projectKey(chainId, projectId, 'receiver'), 'arrivals', at ?? '', erc20 ?? ''],
    queryFn: ({ signal }) => warned(ARRIVALS_UNREADABLE, { chainId, projectId }, signal, () => arrivalsOf(chainId, at!, erc20!, signal)),
    enabled: opened && at !== undefined && erc20 !== null,
    staleTime: FRESH_MS,
    retry: false,
  })

  const sending = tx.busy || tx.phase === 'review'
  const complete = plan !== null && landed === plan.steps.length
  const shown = address?.toLowerCase() ?? null
  const error = failure && (failure.account === null || failure.account === shown) ? failure.message : null

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
      const group = groupOf(minWeeks, maxWeeks)
      const next =
        kind === 'create'
          ? await planCreate(info, group, account, signal)
          : await planSettle(info, group, tokenText, account, signal)
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

  async function confirm() {
    if (!plan || sending) return
    // The step is sent as the account that reviewed it, and the engine refuses it while another is connected.
    await presses.press(plan.steps, step => tx.send(step, { reviewedAccount: plan.account }))
  }

  function close() {
    reading.current?.abort()
    setPlan(null)
    setPreparing(false)
    if (tx.phase !== 'success') tx.reset()
  }

  useEffect(() => {
    setFailure(current => (current?.account === null ? null : current))
  }, [address, isCenterWallet, viewAs])

  // What a step changed is read again once it has confirmed, and a settled token is looked for rewards in.
  useEffect(() => {
    if (!complete || !plan) return
    if (plan.kind === 'create') return refreshAfterReceiver(client, chainId, projectId)
    refreshAfterSettle(client, chainId, projectId)
    settledToken.current(plan.token!)
  }, [complete, plan, client, chainId, projectId])

  useEffect(() => () => reading.current?.abort(), [])

  const held = arrivals.data
  const arrivalsLine =
    token === null || erc20 === null
      ? NOT_ERC20
      : held
        ? 'refused' in held
          ? held.refused
          : `${formatAmount(held.amount, held.meta.decimals)} ${held.meta.symbol} waiting to settle`
        : arrivals.isError
          ? 'Could not read what it holds.'
          : null

  return (
    <>
      <Disclosure summary="Reward address for fee payouts and transfers" className="mt-2.5 text-[13px]" onToggle={setOpened}>
        <div className="mt-2.5 space-y-3">
          <p className="text-muted">Tokens sent here become airdrops once anyone settles them.</p>
          <StakeAgeFields minWeeks={minWeeks} maxWeeks={maxWeeks} onMinWeeks={setMinWeeks} onMaxWeeks={setMaxWeeks} />
          {receiver.isError ? (
            <p role="alert" className="text-err">
              {asSentence(receiver.error.message)}{' '}
              <button type="button" className="btn-link font-semibold" onClick={() => void receiver.refetch()}>
                Try again
              </button>
            </p>
          ) : receiver.data ? (
            <dl
              data-receiver
              className={DETAIL_LIST}
            >
              <dt className={DETAIL_LABEL}>Reward address</dt>
              <dd className={DETAIL_VALUE}>
                <span className="break-all font-mono text-xs leading-[1.4]">{receiver.data.address}</span>
                <CopyAddress label="reward" address={receiver.data.address} />
              </dd>
              <dt className={DETAIL_LABEL}>Status</dt>
              <dd className={DETAIL_VALUE}>
                {receiver.data.created ? 'Created' : 'Not created yet'}
              </dd>
            </dl>
          ) : opened && groupId !== null ? (
            <div aria-busy="true" className="space-y-2">
              <Skeleton className="h-3 w-[80%] rounded" />
              <Skeleton className="h-3 w-[40%] rounded" />
            </div>
          ) : null}
          {receiver.data && !receiver.data.created ? (
            <button
              type="button"
              disabled={sending || preparing}
              onClick={() => void startReview('create')}
              className="btn-secondary px-3 py-1.5 text-sm"
            >
              Create onchain
            </button>
          ) : null}
          <div className="min-w-0">
            <label htmlFor={tokenId} className={FIELD_LABEL}>
              Token to settle
            </label>
            <input
              id={tokenId}
              value={tokenText}
              onChange={event => {
                setTokenText(event.target.value)
                setFailure(null)
              }}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
              className={`${FIELD_INPUT} font-mono text-xs`}
            />
            <p data-arrivals className="mt-1.5 min-h-5 text-muted">
              {arrivalsLine}
            </p>
          </div>
          <button
            type="button"
            disabled={sending || preparing}
            onClick={() => void startReview('settle')}
            className="btn-secondary px-3 py-1.5 text-sm"
          >
            Settle into airdrops
          </button>
          <TxError error={plan || preparing ? null : error} />
        </div>
      </Disclosure>
      {plan || preparing ? (
        <TxConfirmDialog
          open
          preparing={!plan}
          onClose={close}
          title={
            complete
              ? plan!.kind === 'create'
                ? 'Reward address created'
                : 'Arrivals settled into rewards'
              : plan?.kind === 'create'
                ? 'Create reward address'
                : 'Settle into airdrops'
          }
          rows={plan?.rows}
          steps={plan ? plan.steps.map((step, index) => ({ key: String(index), title: step.label ?? step.functionName })) : []}
          activeIndex={plan ? landed : -1}
          stepsIntro={plan ? stepsIntro(plan.steps.length, landed) : undefined}
          action={confirmAction(
            tx.phase,
            tx.phase === 'error' ? 'Retry' : plan?.kind === 'create' ? 'Confirm & create' : 'Confirm & settle',
          )}
          cancelLabel={landed > 0 ? 'Close' : 'Cancel'}
          onConfirm={() => void confirm()}
          busy={sending}
          complete={complete}
          status={
            !plan ? (
              'Reading the reward address…'
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
