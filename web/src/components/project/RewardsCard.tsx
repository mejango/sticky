'use client'

import { Fragment, useId, useState, type FormEvent } from 'react'
import type { Address } from 'viem'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAutoStick, useRewardFunding, useRewards, useViewer } from '@/hooks/useStickyAirdrops'
import { useStickyProject } from '@/hooks/useStickyProject'
import { AS_STATUS } from '@/lib/sticky-autostick'
import { groupLabel, rewardLines, roundSentence, type RewardCard } from '@/lib/sticky-rewards'

/** A pot shows when something is in it or was sent to it. The staked token's under group 0 always does, so a holder can
 * always look for rewards there. */
function isShown({ groupId, token, funded, fundedThisRound, position }: RewardCard, stakedToken: Address): boolean {
  return (
    funded > 0n ||
    fundedThisRound > 0n ||
    position.collectable > 0n ||
    position.vesting > 0n ||
    position.earned > 0n ||
    (groupId === 0n && token === stakedToken.toLowerCase())
  )
}

/** What a pot offers to do with its rewards. Collecting also starts finished rounds vesting. The staked token's
 * rewards can be stuck in one step when the adapter may stick for the holder. Nothing is sent from the page yet: the
 * buttons wait for the transaction engine. */
function actionsOf({ position, token }: RewardCard, stakedToken: Address, canStick: boolean) {
  if (token === stakedToken.toLowerCase() && canStick && position.collectable > 0n) {
    return [
      { label: 'Claim & stick', className: 'btn-primary' },
      { label: 'Collect only', className: 'btn-secondary' },
    ]
  }
  const label = position.collectable > 0n ? 'Collect' : position.earned > 0n ? 'Start vesting' : ''
  return label ? [{ label, className: 'btn-secondary' }] : []
}

function RewardPlaceholder() {
  return (
    <div aria-busy="true" className="space-y-3">
      <Skeleton className="h-3 w-[70%] rounded" />
      <div className="space-y-2.5 rounded-md border border-line p-3">
        <Skeleton className="h-3 w-[40%] rounded" />
        <Skeleton className="h-2.5 w-[80%] rounded" />
        <Skeleton className="h-2.5 w-[60%] rounded" />
      </div>
    </div>
  )
}

function Reward({ card, stakedToken, canStick }: { card: RewardCard; stakedToken: Address; canStick: boolean }) {
  const actions = actionsOf(card, stakedToken, canStick)
  return (
    <li data-reward={`${card.groupId}:${card.token}`} className="min-w-0 rounded-md border border-line p-3">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <b className="font-medium">{groupLabel(card.groupId)}</b>
        <span className="ml-auto min-w-0 max-w-full truncate" title={card.token}>
          {card.meta.symbol}
        </span>
      </div>
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px] max-[520px]:grid-cols-1 max-[520px]:gap-y-0">
        {rewardLines(card).map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="m-0 break-words max-[520px]:mb-1.5">{value}</dd>
          </Fragment>
        ))}
      </dl>
      {actions.length ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {actions.map(({ label, className }) => (
            <button key={label} type="button" disabled className={`${className} px-3 py-1.5 text-sm`}>
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  )
}

/** A token to look for rewards in, for a holder who cannot find them in the funding logs. */
function CheckToken({ onCheck }: { onCheck: (token: Address) => void }) {
  const id = useId()
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)

  function check(event: FormEvent) {
    event.preventDefault()
    const text = value.trim()
    const valid = /^0x[0-9a-fA-F]{40}$/.test(text)
    setInvalid(!valid)
    if (!valid) return
    setValue('')
    onCheck(text.toLowerCase() as Address)
  }

  return (
    <form onSubmit={check} className="mt-4">
      <label htmlFor={id} className="block text-xs text-muted">
        Check another reward token
      </label>
      <div className="mt-1 flex gap-2">
        <input
          id={id}
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-[4px] border border-line bg-[#fdffff] px-2 py-1.5 text-ink focus:border-amber focus:outline-none"
        />
        <button type="submit" className="btn-secondary px-3 py-1.5 text-sm">
          Check
        </button>
      </div>
      {invalid ? (
        <p role="alert" className="mt-1 text-xs text-err">
          Enter a token address.
        </p>
      ) : null}
    </form>
  )
}

/**
 * The viewer's rewards: for each pot the distributor was funded for, and the staked token's under every group, what is
 * claimable now, vesting, and earned in finished rounds and not vesting yet, and what was funded. A stake-age group
 * pays only stake still held, so those pots come with a warning. The cards are read again every 15 seconds. Nothing is
 * sent from here yet, so the buttons are closed.
 */
export function RewardsCard({ chainId, projectId }: { chainId: number; projectId: number }) {
  const { info, failed, retry } = useStickyProject(chainId, projectId)
  const holder = useViewer()
  const [checked, setChecked] = useState<Address[]>([])
  const funding = useRewardFunding(chainId, projectId)
  const rewards = useRewards(chainId, projectId, holder, checked)
  const autoStick = useAutoStick(chainId, projectId, holder).data
  // Auto-stick fails closed: for a project the adapter cannot resolve, nothing is stuck through it.
  const canStick =
    autoStick !== undefined &&
    autoStick.status !== AS_STATUS.INVALID_PROJECT &&
    (autoStick.projectGranter || autoStick.personallyTrusted)
  const cards = rewards.data
  const shown = info && cards ? cards.filter(card => isShown(card, info.stakedToken)) : []

  return (
    <section aria-labelledby="rewards-title" className="card p-5">
      <h2 id="rewards-title" className="mb-2 font-agrandir-wide text-base leading-tight">
        Your rewards
      </h2>
      {failed ? (
        <p role="alert" className="text-err">
          Could not read this Sticky token.{' '}
          <button type="button" className="btn-link font-semibold" onClick={retry}>
            Try again
          </button>
        </p>
      ) : rewards.isError && cards === undefined ? (
        <p role="alert" className="text-err">
          Could not read the rewards.{' '}
          <button type="button" className="btn-link font-semibold" onClick={() => void rewards.refetch()}>
            Try again
          </button>
        </p>
      ) : !info || !cards ? (
        <RewardPlaceholder />
      ) : (
        <>
          {cards.length ? <p className="mb-2.5 text-muted">{roundSentence(cards[0].schedule)}</p> : null}
          {funding.isFetching && funding.data === undefined ? (
            <p className="mb-2.5 text-[13px] text-muted">Looking for more airdrops…</p>
          ) : null}
          {funding.isError ? (
            <p role="alert" className="mb-2.5 text-err">
              Could not list every airdrop.{' '}
              <button type="button" className="btn-link font-semibold" onClick={() => void funding.refetch()}>
                Try again
              </button>
            </p>
          ) : null}
          {shown.length ? (
            <ul className="m-0 grid list-none gap-2.5 p-0">
              {shown.map(card => (
                <Reward key={`${card.groupId}:${card.token}`} card={card} stakedToken={info.stakedToken} canStick={canStick} />
              ))}
            </ul>
          ) : (
            <p className="rounded-md border border-line p-3 text-muted">No rewards yet.</p>
          )}
          {shown.some(card => card.groupId !== 0n) ? (
            <p className="mt-2.5 text-muted">Claim stake-age rewards before unsticking, or you forfeit them.</p>
          ) : null}
          <CheckToken onCheck={token => setChecked(list => (list.includes(token) ? list : [...list, token]))} />
        </>
      )}
    </section>
  )
}
