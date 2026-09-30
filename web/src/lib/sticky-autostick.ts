/**
 * Auto-stick and who can stick for a holder. Auto-stick is opt-in compounding: unlocked rewards in the staked token are
 * collected and stuck again for the same holder by the deployment's immutable StickyAutoStick adapter. What may
 * happen is the chain's word alone: the adapter's status, the holder's settings and the hook's trust are read from
 * their contracts, never taken from events.
 *
 * Addresses of senders are lowercase.
 */

import type { Address, ContractFunctionParameters } from 'viem'
import { stickyAutoStickAbi, stickyDistributorAbi, stickyHookAbi } from '@/lib/sticky-abis'
import { stickyDeployment, type StickyDeployment } from '@/lib/sticky-addresses'
import type { StickyEvent } from '@/lib/sticky-events'
import { formatAmount, formatDuration } from '@/lib/sticky-format'
import { pinnedBlock } from '@/lib/sticky-holders'
import type { Answer, StickyProjectInfo } from '@/lib/sticky-project'
import { earnedRewardsOf, need, readAt, type BlockPin } from '@/lib/sticky-rewards'

type Cancel = { signal?: AbortSignal }
/** The two tokens of a Sticky project: its Sticky token, and the token holders stick. */
type Tokens = Pick<StickyProjectInfo, 'stToken' | 'stakedToken'>

/** Why a holder's auto-stick can or cannot run now, as the adapter's `AutoStickStatus` numbers them. */
export const AS_STATUS = {
  READY: 0,
  DISABLED: 1,
  INVALID_PROJECT: 2,
  COOLDOWN: 3,
  BELOW_MINIMUM: 4,
  NOT_TRUSTED: 5,
  INSUFFICIENT_ALLOWANCE: 6,
  ZERO_ISSUANCE: 7,
} as const

/** A holder's auto-stick in one project, as one block has it. */
export type AutoStickState = {
  /** The reward groups the status was asked about: those with staked-token rewards to collect, or group 0 when none has. */
  groupIds: bigint[]
  /** An `AS_STATUS`. INVALID_PROJECT says the deployment cannot resolve the project's tokens: the card closes on it. */
  status: number
  /** What the groups hold to collect, in the staked token's units. */
  collectable: bigint
  /** What the holder let the adapter move of the staked token. */
  allowance: bigint
  /** When the cooldown ends, in Unix seconds, or 0 when there is none. */
  nextCompoundAt: number
  /** The least it sticks at once, in the staked token's units, and the shortest time between two sticks, in seconds. */
  minimum: bigint
  cooldown: number
  /** When it last stuck, in Unix seconds, or 0 when it never has. */
  lastCompoundedAt: number
  enabled: boolean
  /** The project launched with the adapter as a granter: no trust is needed from the holder. */
  projectGranter: boolean
  /** The holder trusts the adapter to stick for them. */
  personallyTrusted: boolean
  /** Whether finished rounds hold a share for the holder that the adapter could start unlocking. */
  canBeginVesting: boolean
}

const GROUP_UNREADABLE = 'Could not read what a reward group has to collect; counting it as nothing.'
const VESTING_UNREADABLE = 'Could not tell whether rewards can start unlocking; the card leaves out Start unlocking.'

function deploymentOn(chainId: number): StickyDeployment {
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  return deployment
}

/**
 * The reward groups a holder's staked-token rewards sit in: those of `groups` with something collectable, and what they
 * hold together. The adapter takes this list and applies the holder's minimum to the sum; an empty list reverts, so group
 * 0 stands in when nothing is ready. A group the distributor reverts on holds nothing.
 */
export async function stakedRewardGroups(
  chainId: number,
  { stToken, stakedToken }: Tokens,
  holder: Address,
  groups: readonly bigint[],
  { signal, pin }: Cancel & { pin?: BlockPin } = {},
): Promise<{ groupIds: bigint[]; collectable: bigint }> {
  const { distributor } = deploymentOn(chainId)
  const asked = groups.length ? groups : [0n]
  const answers = (await readAt(
    chainId,
    asked.map(
      (groupId): ContractFunctionParameters => ({
        address: distributor,
        abi: stickyDistributorAbi,
        functionName: 'collectableFor',
        args: [stToken, groupId, BigInt(holder), stakedToken],
      }),
    ),
    pin?.number,
    signal,
  )) as Answer<bigint>[]
  const amounts = asked.map((groupId, i) => {
    const answer = answers[i]
    if (answer.status === 'success') return answer.result
    console.warn(GROUP_UNREADABLE, { chainId, groupId }, answer.error)
    return 0n
  })
  const ready = asked.filter((_, i) => amounts[i] > 0n)
  return { groupIds: ready.length ? ready : [0n], collectable: amounts.reduce((sum, amount) => sum + amount, 0n) }
}

/** The groups of `groups` whose finished rounds hold a share of the holder's staked-token rewards that has not started
 * vesting. */
export async function vestableRewardGroups(
  chainId: number,
  { stToken, stakedToken }: Tokens,
  holder: Address,
  groups: readonly bigint[],
  options: Cancel & { pin?: BlockPin } = {},
): Promise<bigint[]> {
  const asked = groups.length ? groups : [0n]
  const earned = await earnedRewardsOf(
    chainId,
    stToken,
    holder,
    asked.map(groupId => ({ groupId, token: stakedToken })),
    { ...options, any: true },
  )
  return asked.filter((_, i) => earned[i] > 0n)
}

/**
 * A holder's auto-stick in a project: the groups holding staked-token rewards, the adapter's status for them and the
 * holder's settings, and whether the adapter can stick for the holder (the project granted it, or the holder trusts it),
 * all at one block. `groups` are those the project's rewards are in (see `rewardRows`). While it is on, it also looks
 * for finished rounds to start unlocking; that is a convenience, so when it cannot be read the card leaves it out and
 * the console says why.
 */
export async function readAutoStick(
  chainId: number,
  projectId: bigint,
  holder: Address,
  { info, groups, signal }: Cancel & { info: Tokens; groups: readonly bigint[] },
): Promise<AutoStickState> {
  const { autoStick, hook } = deploymentOn(chainId)
  const pin = await pinnedBlock(chainId, { signal })
  const { groupIds } = await stakedRewardGroups(chainId, info, holder, groups, { signal, pin })
  const [statusOf, configOf, granterOf, trustedOf] = await readAt(
    chainId,
    [
      { address: autoStick, abi: stickyAutoStickAbi, functionName: 'statusOf', args: [projectId, holder, groupIds] },
      { address: autoStick, abi: stickyAutoStickAbi, functionName: 'configOf', args: [projectId, holder] },
      { address: hook, abi: stickyHookAbi, functionName: 'isGranterOf', args: [projectId, autoStick] },
      { address: hook, abi: stickyHookAbi, functionName: 'isTrustedSenderOf', args: [projectId, holder, autoStick] },
    ],
    pin.number,
    signal,
  )
  const [status, collectable, allowance, nextCompoundAt] = need(
    statusOf as Answer<readonly [number, bigint, bigint, bigint]>,
    "the adapter's status",
  )
  const [minimum, cooldown, lastCompoundedAt, enabled] = need(
    configOf as Answer<readonly [bigint, number, number, boolean]>,
    "the holder's auto-stick settings",
  )
  let canBeginVesting = false
  if (enabled) {
    try {
      canBeginVesting = (await vestableRewardGroups(chainId, info, holder, groups, { signal, pin })).length > 0
    } catch (error) {
      if (signal?.aborted) throw error
      console.warn(VESTING_UNREADABLE, { chainId, projectId }, error)
    }
  }
  return {
    groupIds,
    status,
    collectable,
    allowance,
    nextCompoundAt: Number(nextCompoundAt),
    minimum,
    cooldown: Number(cooldown),
    lastCompoundedAt: Number(lastCompoundedAt),
    enabled,
    projectGranter: need(granterOf as Answer<boolean>, 'whether the project granted the adapter'),
    personallyTrusted: need(trustedOf as Answer<boolean>, 'whether the holder trusts the adapter'),
    canBeginVesting,
  }
}

/** The line under the settings that says what holds auto-stick back, or nothing when nothing does. */
export function asStatusLine(
  { status, nextCompoundAt, collectable, minimum }: Pick<AutoStickState, 'status' | 'nextCompoundAt' | 'collectable' | 'minimum'>,
  { symbol, decimals }: Pick<StickyProjectInfo, 'symbol' | 'decimals'>,
  now = Math.floor(Date.now() / 1000),
): string {
  switch (status) {
    case AS_STATUS.READY:
      return 'Ready to auto-stick'
    case AS_STATUS.COOLDOWN:
      return `Next auto-stick in ${formatDuration(Math.max(0, nextCompoundAt - now))}`
    case AS_STATUS.BELOW_MINIMUM:
      return `${formatAmount(collectable, decimals)} ${symbol} ready | minimum ${formatAmount(minimum, decimals)}`
    case AS_STATUS.NOT_TRUSTED:
      return 'Permission removed | repair setup'
    case AS_STATUS.INSUFFICIENT_ALLOWANCE:
      return 'Allowance exhausted | renew'
    case AS_STATUS.ZERO_ISSUANCE:
      return 'Wait for more rewards: the current amount is too small to mint a Sticky token unit'
    default:
      return ''
  }
}

/** Whose trust, in which project on which chain, `trustedSenders` reads. */
export type TrustReads = Cancel & { chainId: number; projectId: bigint; holder: Address }

/** The senders a holder's trust events name in a project, each once and in the order they were first named. The
 * auto-stick adapter is never one: the auto-stick card presents its trust. */
export function trustCandidates(
  events: readonly StickyEvent[],
  { chainId, projectId, holder }: Pick<TrustReads, 'chainId' | 'projectId' | 'holder'>,
): Address[] {
  const who = holder.toLowerCase()
  const adapter = deploymentOn(chainId).autoStick.toLowerCase()
  const named = events.flatMap(event =>
    event.kind === 'trust' &&
    event.sender !== undefined &&
    event.chainId === chainId &&
    event.projectId === projectId &&
    event.holder.toLowerCase() === who
      ? [event.sender.toLowerCase() as Address]
      : [],
  )
  return [...new Set(named)].filter(sender => sender !== adapter)
}

/**
 * The senders a holder trusts to stick for them in a project, from the project's events and the hook. The events name
 * every sender the holder ever trusted or stopped trusting; the hook says which they trust now. Anyone can write a trust
 * event for any project, so only the hook's answer lists a sender.
 */
export async function trustedSenders(events: readonly StickyEvent[], reads: TrustReads): Promise<Address[]> {
  const { chainId, projectId, holder, signal } = reads
  const candidates = trustCandidates(events, reads)
  if (!candidates.length) return []
  const { hook } = deploymentOn(chainId)
  const answers = (await readAt(
    chainId,
    candidates.map(
      (sender): ContractFunctionParameters => ({
        address: hook,
        abi: stickyHookAbi,
        functionName: 'isTrustedSenderOf',
        args: [projectId, holder, sender],
      }),
    ),
    undefined,
    signal,
  )) as Answer<boolean>[]
  return candidates.filter((_, i) => need(answers[i], 'whether a sender is trusted'))
}
