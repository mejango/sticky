/**
 * A Sticky project's airdrop rewards: who a reward pot is for, what a holder has in each pot, and the words that say
 * so. A funder sends a token to the distributor for one reward group of a Sticky token's holders: group 0 is everyone
 * holding at the round's snapshot, and any other group is a stake-age window, `minWeeks * 1000 + maxWeeks`, where
 * maxWeeks 0 means no upper bound. A pot is one group's rewards in one token. What a holder has in a pot is claimable
 * now, vesting (collected, and unlocking a round at a time), or earned in finished rounds and not vesting yet.
 *
 * Every amount a holder has is read from the distributor, never added up from fundings: Bendystraw's fundings, and the
 * distributor's Fund logs when it cannot answer, say which pots exist and what was sent to each. All of a refresh's
 * reads are made at one pinned block and together, a request for each step (and one more for every 250 calls) and not
 * for each pot. A reward token is any contract, so its symbol and decimals are read apart from the distributor's own
 * answers, where a token that keeps a request from being answered leaves out only itself, and what is read of a token
 * is kept, so a refresh does not read it again.
 *
 * Funding is permissionless: anyone can fund any group with any token. So the pots looked at are capped
 * (`MAX_FUNDED_POTS`), and what a refresh costs does not grow with what a project's enemies fund it with.
 *
 * Addresses of tokens are lowercase.
 */

import { NATIVE_TOKEN } from '@bananapus/nana-sdk-core'
import { STICKY_CRITERIA_BASE, STICKY_MAX_CRITERIA_WEEKS, validateStickyGroupId } from '@bananapus/nana-sdk-core/v6'
import {
  decodeEventLog,
  erc20Abi,
  erc20Abi_bytes32,
  getAbiItem,
  hexToString,
  pad,
  toEventSelector,
  type AbiEvent,
  type Address,
  type ContractFunctionParameters,
  type Hex,
} from 'viem'
import { inChainOrder, untilAborted, type ScannedLog } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { stickyDistributorAbi, stickyHookAbi, stickyTokenAbi } from '@/lib/sticky-abis'
import { stickyDeployment, type StickyDeployment } from '@/lib/sticky-addresses'
import {
  keptScanToHead,
  notIndexed,
  orNull,
  projectCreationBlock,
  scanFrom,
  scanToHead,
  tailOrNull,
  type StickyReadDeps,
} from '@/lib/sticky-events'
import { formatAmount, formatDuration } from '@/lib/sticky-format'
import { pinnedBlock } from '@/lib/sticky-holders'
import { indexedStickyFunding } from '@/lib/sticky-indexed'
import { answered, capped, type Answer } from '@/lib/sticky-project'

type Cancel = { signal?: AbortSignal }

/** The block a refresh reads at, and that block's time in Unix seconds. */
export type BlockPin = { number: bigint; timestamp: number }

// ---------------------------------------------------------------- reward groups

const CRITERIA_BASE = STICKY_CRITERIA_BASE
const MAX_CRITERIA_WEEKS = BigInt(STICKY_MAX_CRITERIA_WEEKS)

/** The stake-age window a group id names: at least `minWeeks` old, and at most `maxWeeks`, or 0 for no upper bound.
 * Group 0 has none. */
export function decodeGroupId(groupId: bigint): { minWeeks: bigint; maxWeeks: bigint } {
  return { minWeeks: groupId / CRITERIA_BASE, maxWeeks: groupId % CRITERIA_BASE }
}

/** Whether the distributor accepts a group: 0, or a window of a minimum of 1 to 520 weeks and a maximum of none or the
 * minimum to 520. */
export const isValidGroupId = (groupId: bigint) => validateStickyGroupId(groupId) === null

/** The two stake-age fields as a group id. A blank or zero minimum is everyone, and a blank maximum is no upper bound. */
export function groupIdFromWeeks(minValue: string, maxValue: string): bigint {
  const parse = (value: string, label: string) => {
    const text = value.trim()
    if (text === '') return null
    if (!/^\d{1,4}$/.test(text)) throw new Error(`${label} must be a whole number of weeks`)
    return BigInt(text)
  }
  const minWeeks = parse(minValue, 'the minimum stake age') ?? 0n
  const maxWeeks = parse(maxValue, 'the maximum stake age') ?? 0n
  if (minWeeks > MAX_CRITERIA_WEEKS || maxWeeks > MAX_CRITERIA_WEEKS) {
    throw new Error(`stake age is limited to ${MAX_CRITERIA_WEEKS} weeks`)
  }
  if (minWeeks === 0n && maxWeeks !== 0n) throw new Error('a maximum stake age needs a minimum of at least 1 week')
  if (maxWeeks !== 0n && maxWeeks < minWeeks) throw new Error('the maximum stake age must be at least the minimum')
  return minWeeks * CRITERIA_BASE + maxWeeks
}

export function groupLabel(groupId: bigint): string {
  const { minWeeks, maxWeeks } = decodeGroupId(groupId)
  if (groupId === 0n) return 'Everyone'
  return maxWeeks === 0n ? `Staked ${minWeeks}+ weeks` : `Staked ${minWeeks}–${maxWeeks} weeks`
}

/** One line on who the funder chose, shared by the funding form and the confirmation. */
export function groupSentence(groupId: bigint): string {
  const { minWeeks, maxWeeks } = decodeGroupId(groupId)
  if (groupId === 0n) return "Everyone holding at the round's snapshot shares it."
  const weeks = (count: bigint) => `${count} week${count === 1n ? '' : 's'}`
  const window = maxWeeks === 0n ? `at least ${weeks(minWeeks)} old` : `between ${weeks(minWeeks)} and ${weeks(maxWeeks)} old`
  return `Only stake ${window} when the round starts shares it, and holders who unstick before claiming forfeit their share.`
}

/** The group two stake-age fields name, or why they name none, with the sentence a form shows for either. */
export function groupNote(minValue: string, maxValue: string): { groupId: bigint | null; text: string } {
  try {
    const groupId = groupIdFromWeeks(minValue, maxValue)
    return { groupId, text: groupSentence(groupId) }
  } catch (error) {
    return { groupId: null, text: (error as Error).message }
  }
}

/** The epochs of a tenure group's stake at a round whose snapshot is in `epoch`: the stake added through `hi` less the
 * stake added before `lo` (nothing when `lo` is 0), or null when the snapshot is younger than the group's minimum age
 * and no stake is old enough. */
export function tenureWindow(groupId: bigint, epoch: bigint): { hi: bigint; lo: bigint } | null {
  const { minWeeks, maxWeeks } = decodeGroupId(groupId)
  if (epoch < minWeeks) return null
  return { hi: epoch - minWeeks, lo: maxWeeks === 0n || epoch < maxWeeks ? 0n : epoch - maxWeeks }
}

// ---------------------------------------------------------------- the words

/** The distributor's round clock, and the round it is in. Round r starts at `start + roundDuration * r`. */
export type RewardSchedule = { roundDuration: bigint; vestingRounds: bigint; start: bigint; round: bigint }

/** When round `round` starts, in Unix seconds. */
export const roundStartOf = ({ start, roundDuration }: RewardSchedule, round: bigint) => start + roundDuration * round

export const dateLabel = (seconds: bigint | number) =>
  new Date(Number(seconds) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

export const dateTimeLabel = (seconds: bigint | number) =>
  new Date(Number(seconds) * 1000).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

/** A holder's standing in one pot, in the reward token's units. */
export type RewardPosition = {
  /** Unlocked, and paid out by collecting. */
  collectable: bigint
  /** Collected and still unlocking. */
  vesting: bigint
  /** Earned in finished rounds and not vesting yet: collecting starts it. */
  earned: bigint
  /** When the next round's share unlocks, or null when nothing is vesting. */
  nextUnlockAt: bigint | null
  /** When the last vesting entry unlocks, or null when nothing is vesting or the next unlock is the last. */
  unlockedAt: bigint | null
}

export type TokenMeta = { symbol: string; decimals: number }

/** One group's rewards in one token, and everything ever sent to it (0 for a pot only checked by hand). */
export type RewardPot = { groupId: bigint; token: Address; funded: bigint }

/** A pot that was funded, and the block it was last funded in. */
export type FundedPot = RewardPot & { fundedAt: bigint }

/** A pot as a holder sees it, and the schedule its dates are on. */
export type RewardCard = RewardPot & {
  meta: TokenMeta
  /** What was sent to the pot in the round the schedule is in. */
  fundedThisRound: bigint
  position: RewardPosition
  schedule: RewardSchedule
}

/** The line above the reward cards. */
export function roundSentence(schedule: RewardSchedule): string {
  const { round, roundDuration, vestingRounds } = schedule
  const weeks = roundDuration === 604_800n ? 'week' : formatDuration(roundDuration)
  const share = vestingRounds === 4n ? 'quarter' : `1/${vestingRounds}`
  return (
    `Round ${round} ends ${dateTimeLabel(roundStartOf(schedule, round + 1n))}. ` +
    `Your share then vests over ${vestingRounds} rounds, a ${share} each ${weeks}, starting when you collect.`
  )
}

/** One pot's lines, stating amounts and dates. */
export function rewardLines({
  position,
  meta,
  funded,
  fundedThisRound,
  schedule,
}: Pick<RewardCard, 'position' | 'meta' | 'funded' | 'fundedThisRound' | 'schedule'>): [string, string][] {
  const amount = (value: bigint) => `${formatAmount(value, meta.decimals)} ${meta.symbol}`
  const endsAt = roundStartOf(schedule, schedule.round + 1n)
  const lines: [string, string][] = [['Claimable now', amount(position.collectable)]]
  if (position.vesting > 0n) {
    const later = position.unlockedAt !== null && position.unlockedAt !== position.nextUnlockAt
    lines.push([
      'Vesting',
      `${amount(position.vesting)}. Next unlock ${dateLabel(position.nextUnlockAt ?? endsAt)}.` +
        (later ? ` All unlocked ${dateLabel(position.unlockedAt!)}.` : ''),
    ])
  } else {
    lines.push(['Vesting', 'None'])
  }
  if (position.earned > 0n) {
    const last = roundStartOf(schedule, schedule.round + schedule.vestingRounds)
    const share = schedule.vestingRounds === 4n ? 'quarter' : 'share'
    lines.push([
      'Earned, not vesting',
      `About ${amount(position.earned)} from finished rounds. Collect to start vesting: ` +
        `a ${share} unlocks ${dateLabel(endsAt)}, all by ${dateLabel(last)}.`,
    ])
  }
  lines.push([
    'Funded',
    (fundedThisRound > 0n ? `${amount(fundedThisRound)} this round, splits ${dateLabel(endsAt)}.` : 'None this round.') +
      ` ${amount(funded)} in total.`,
  ])
  return lines
}

// ---------------------------------------------------------------- reads

/** The token JB's contracts use for the chain's native currency (JBConstants.NATIVE_TOKEN), which the distributor
 * books ETH under, in lowercase as the pots' tokens are. */
export const NATIVE_REWARD_TOKEN = NATIVE_TOKEN.toLowerCase() as Address
/** How many calls one Multicall3 request carries. */
const CALLS_PER_REQUEST = 250
/** How many reward tokens one request asks the symbol and decimals of. */
const TOKENS_PER_REQUEST = 25
/** How many rounds of one pot a pass reads, and how many unresolved rounds a pot may have before it is not read. */
const ROUNDS_PER_PASS = 16n
const MAX_UNRESOLVED_ROUNDS = 4096n
/** How many vesting entries from the latest one are read. A holder has one entry for each collection. */
const VESTING_ENTRIES = 32

const REWARD_TOKEN_UNREADABLE = 'Could not read a reward token; leaving its rewards out.'

const FUND = toEventSelector(getAbiItem({ abi: stickyDistributorAbi, name: 'Fund' }) as AbiEvent)

const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`

function deploymentOn(chainId: number): StickyDeployment {
  const deployment = stickyDeployment(chainId)
  if (!deployment) throw new Error(`Sticky is not deployed on chain ${chainId}.`)
  return deployment
}

/** What one call answered, or why the read cannot go on. */
export function need<T>(answer: Answer<T>, what: string): T {
  if (answer.status === 'success') return answer.result
  throw new Error(`${what} could not be read.`, { cause: answer.error })
}

/**
 * `calls`, asked at `block` (the head when there is none) in the fewest Multicall3 requests, and answered in order. A
 * call that reverted is an answer, and a request that got none is thrown.
 */
export async function readAt(
  chainId: number,
  calls: readonly ContractFunctionParameters[],
  block: bigint | undefined,
  signal: AbortSignal | undefined,
): Promise<Answer<unknown>[]> {
  const client = jbCenterPublicClient(chainId)
  const answers: Answer<unknown>[] = []
  for (let at = 0; at < calls.length; at += CALLS_PER_REQUEST) {
    if (signal?.aborted) throw signal.reason
    // The calls are already counted out, so viem is told not to split them.
    const asked = client.multicall({
      contracts: calls.slice(at, at + CALLS_PER_REQUEST),
      allowFailure: true,
      batchSize: 0,
      blockNumber: block,
    })
    answers.push(...answered((await untilAborted(asked, signal)) as Answer<unknown>[]))
  }
  return answers
}

const distributorCall = (distributor: Address, functionName: string, args?: readonly unknown[]): ContractFunctionParameters => ({
  address: distributor,
  abi: stickyDistributorAbi,
  functionName,
  args,
})

/** The distributor's round clock and the round it is in, read at `pin` (the head by default). */
export async function readRewardSchedule(
  chainId: number,
  { pin, signal }: Cancel & { pin?: BlockPin } = {},
): Promise<RewardSchedule> {
  const { distributor } = deploymentOn(chainId)
  const at = pin ?? (await pinnedBlock(chainId, { signal }))
  const names = ['ROUND_DURATION', 'VESTING_ROUNDS', 'STARTING_TIMESTAMP', 'currentRound']
  const answers = (await readAt(chainId, names.map(name => distributorCall(distributor, name)), at.number, signal)) as Answer<bigint>[]
  const [roundDuration, vestingRounds, start, round] = answers.map((answer, i) => need(answer, `the distributor's ${names[i]}`))
  if (roundDuration === 0n || vestingRounds === 0n) throw new Error('the distributor returned an invalid round schedule')
  return { roundDuration, vestingRounds, start, round }
}

// ---- the pots

/** Every read `discoverFunding` makes, so a test can stand in for Bendystraw and Center. */
export type FundingReadDeps = {
  /** Bendystraw's fundings of a Sticky token, with the block they are as of. */
  indexedFunding: typeof indexedStickyFunding
  /** The distributor's logs that match a filter, from its block through the head. */
  scan: StickyReadDeps['scan']
  /** The same, with the history kept in this browser under a key, so a return visit scans only the blocks since. */
  keptScan: typeof keptScanToHead
  /** The block a project was created in, or null when it cannot be found. */
  creationBlock: typeof projectCreationBlock
}

/** A caller's signal, which every read gets, and in tests the reads to use instead of the real ones. */
export type FundingReadOptions = Cancel & Partial<FundingReadDeps>

const liveFunding: FundingReadDeps = {
  indexedFunding: indexedStickyFunding,
  scan: scanToHead,
  keptScan: keptScanToHead,
  creationBlock: projectCreationBlock,
}

const FUNDING_UNAVAILABLE = 'Bendystraw could not list the airdrops funded; scanning the distributor for them instead.'

/** One funding, from either source: the pot it went to, what it sent, and where it is in the chain. */
type Funding = { groupId: bigint; token: Address; amount: bigint; blockNumber: bigint; logIndex: number }

function fundingOfLog(log: ScannedLog): Funding {
  const { args } = decodeEventLog({
    abi: stickyDistributorAbi,
    eventName: 'Fund',
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  })
  const { groupId, amount } = args
  return { groupId, token: args.token.toLowerCase() as Address, amount, blockNumber: log.blockNumber, logIndex: log.logIndex }
}

/** The pots fundings in the order of the chain make: one for each group and token, in the order they were first
 * funded, with everything sent to it and the block it was last funded in. */
function potsOf(fundings: readonly Funding[]): FundedPot[] {
  const pots = new Map<string, FundedPot>()
  for (const { groupId, token, amount, blockNumber } of fundings) {
    const id = `${groupId}:${token}`
    const pot = pots.get(id) ?? { groupId, token, funded: 0n, fundedAt: 0n }
    pots.set(id, { ...pot, funded: pot.funded + amount, fundedAt: blockNumber })
  }
  return [...pots.values()]
}

/**
 * Every pot the distributor has been funded for a Sticky token: one for each group and token it was funded in, in the
 * order they were first funded, with everything sent to it and the block it was last funded in. Bendystraw lists the
 * fundings, and a scan of the distributor's Fund logs from just below the block it is indexed through (never below the
 * project's creation) adds the newer ones; a funding both have counts once. When Bendystraw cannot answer, has no
 * status for the chain, or is so far behind the head that the tail is longer than a scan may read (as when it replays
 * its history), the Fund logs are scanned from the project's creation block instead, and this browser keeps what that
 * scan read, so a later visit scans only newer blocks; what Bendystraw answers for is not kept. It rejects when neither
 * can finish: a list of pots is never quietly shorter.
 */
export async function discoverFunding(
  chainId: number,
  stToken: Address,
  projectId: bigint,
  options: FundingReadOptions = {},
): Promise<FundedPot[]> {
  const { signal, ...given } = options
  const deps: FundingReadDeps = { ...liveFunding, ...given }
  const deployment = deploymentOn(chainId)
  const { distributor } = deployment
  const hook = stToken.toLowerCase() as Address
  const topics = [FUND, pad(hook, { size: 32 })]
  const about = { chainId, projectId }
  const [fromBlock, indexed] = await Promise.all([
    deps.creationBlock(chainId, projectId, { signal }),
    orNull(() => deps.indexedFunding(chainId, hook, signal), signal, FUNDING_UNAVAILABLE, about),
  ])
  const asOf = indexed?.blocks.get(chainId)
  if (indexed && asOf !== undefined) {
    const filter = { address: distributor, topics, fromBlock: scanFrom(asOf, deployment, fromBlock) }
    const tail = await tailOrNull(() => deps.scan(chainId, filter, { signal }), FUNDING_UNAVAILABLE, about)
    if (tail !== null) {
      const ours = indexed.rows.filter(row => row.chainId === chainId && row.hook === hook)
      return potsOf([...ours, ...notIndexed(chainId, ours, tail).map(fundingOfLog)].sort(inChainOrder))
    }
  }
  const key = `${chainId}:${distributor.toLowerCase()}:fund:${hook}`
  const logs = await deps.keptScan(chainId, key, { address: distributor, topics, fromBlock }, { signal })
  return potsOf(logs.map(fundingOfLog))
}

/** How many of the funded pots are looked at. Anyone can fund any group with any token, so a project can be given as
 * many pots as an enemy cares to pay for, and the newest are the ones that matter to a holder. */
export const MAX_FUNDED_POTS = 12

/**
 * The pots to look at: the newest `limit` funded ones (by when each was last funded, shown in the order they were first
 * funded), and the staked token and any token checked by hand under group 0 and the group of each of those, so a holder
 * can always look for rewards where the funded pots could not be listed. `groups` are those, in order, and `more` is
 * how many funded pots are left out.
 */
export function rewardRows(
  stakedToken: Address,
  funded: readonly FundedPot[],
  checked: Iterable<Address> = [],
  limit = MAX_FUNDED_POTS,
): { groups: bigint[]; rows: RewardPot[]; more: number } {
  const newest = new Set(
    funded.length <= limit
      ? funded
      : [...funded].sort((a, b) => (a.fundedAt === b.fundedAt ? 0 : a.fundedAt > b.fundedAt ? -1 : 1)).slice(0, limit),
  )
  const shown = funded.filter(pot => newest.has(pot))
  const known = new Set([stakedToken, ...checked].map(token => token.toLowerCase() as Address))
  const groups = [...new Set([0n, ...shown.map(pot => pot.groupId)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const rows = new Map<string, RewardPot>(
    shown.map(({ groupId, token, funded: amount }) => [`${groupId}:${token}`, { groupId, token, funded: amount }]),
  )
  for (const groupId of groups) {
    for (const token of known) {
      const id = `${groupId}:${token}`
      if (!rows.has(id)) rows.set(id, { groupId, token, funded: 0n })
    }
  }
  return { groups, rows: [...rows.values()], more: funded.length - shown.length }
}

// ---- the reward tokens

/** A token's symbol and decimals from what it answered to `symbol()` as a string, `decimals()` and `symbol()` as a
 * bytes32 (which MKR returns). A token that gives no valid decimals has no meta, and one that gives no symbol is named
 * by its address. What a token returns is kept to the length a project's own tokens' names are. */
function tokenMetaOf(token: Address, answers: readonly Answer<unknown>[]): TokenMeta {
  const [symbolOf, decimalsOf, symbolBytes32Of] = answers as [Answer<string>, Answer<number>, Answer<Hex>]
  const decimals = need(decimalsOf, "the reward token's decimals")
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`the reward token returned ${decimals} as its decimals`)
  }
  const symbol =
    symbolOf.status === 'success'
      ? capped(symbolOf.result)
      : symbolBytes32Of.status === 'success'
        ? capped(hexToString(symbolBytes32Of.result, { size: 32 }).replace(/\0+$/, ''))
        : ''
  return { symbol: symbol || shortAddress(token), decimals }
}

const tokenCalls = (token: Address): ContractFunctionParameters[] => [
  { address: token, abi: erc20Abi, functionName: 'symbol' },
  { address: token, abi: erc20Abi, functionName: 'decimals' },
  { address: token, abi: erc20Abi_bytes32, functionName: 'symbol' },
]

/** What has been read of each reward token's symbol and decimals, by chain and address, for the session: they do not
 * change. */
const tokenMetas = new Map<string, TokenMeta>()
/** The tokens that could not be read, by chain and address, and when each may be asked about again. */
const tokensUnreadable = new Map<string, number>()
/** How long a token that could not be read is left alone. A hostile token costs a lost request, a probe of Center and a
 * request for each of its neighbours, and would cost them again on every refresh. */
const UNREADABLE_MS = 3 * 60_000

/**
 * The symbol and decimals of each reward token that can be read, at `block`: those the caller `known`, and those read
 * before, cost nothing, and a token that could not be read a moment ago is left out without asking again. A token is
 * any contract, so what it answers is not trusted and what it does to a request is not known: one that returns more
 * than Center carries, or runs Multicall3 out of gas, takes the request with it. So when the tokens' request is lost,
 * Center is asked afresh for its head. If it answers, each token is read alone and one whose own request is lost is
 * left out, with why; if not, the lost request's error is thrown. A token that answers without valid decimals is left
 * out, with why.
 */
async function readTokenMetas(
  chainId: number,
  tokens: readonly Address[],
  block: bigint,
  signal: AbortSignal | undefined,
  known: ReadonlyMap<Address, TokenMeta>,
): Promise<Map<Address, TokenMeta>> {
  const metas = new Map<Address, TokenMeta>()
  const keyOf = (token: Address) => `${chainId}:${token}`
  const unread: Address[] = []
  for (const token of tokens) {
    const meta = token === NATIVE_REWARD_TOKEN ? { symbol: 'ETH', decimals: 18 } : (known.get(token) ?? tokenMetas.get(keyOf(token)))
    if (meta) metas.set(token, meta)
    else if ((tokensUnreadable.get(keyOf(token)) ?? 0) <= Date.now()) unread.push(token)
  }
  const leaveOut = (token: Address, error: unknown) => {
    tokensUnreadable.set(keyOf(token), Date.now() + UNREADABLE_MS)
    console.warn(REWARD_TOKEN_UNREADABLE, { chainId, token }, error)
  }
  const keep = (token: Address, answers: readonly Answer<unknown>[]) => {
    try {
      const meta = tokenMetaOf(token, answers)
      metas.set(token, meta)
      tokenMetas.set(keyOf(token), meta)
      tokensUnreadable.delete(keyOf(token))
    } catch (error) {
      leaveOut(token, error)
    }
  }
  for (let at = 0; at < unread.length; at += TOKENS_PER_REQUEST) {
    const some = unread.slice(at, at + TOKENS_PER_REQUEST)
    try {
      const answers = await readAt(chainId, some.flatMap(tokenCalls), block, signal)
      some.forEach((token, i) => keep(token, answers.slice(i * 3, i * 3 + 3)))
    } catch (lost) {
      if (signal?.aborted) throw lost
      // cacheTime 0: a head read a moment ago is cached, and only a fresh request says Center still answers.
      await untilAborted(jbCenterPublicClient(chainId).getBlockNumber({ cacheTime: 0 }), signal).catch(() => {
        throw signal?.aborted ? signal.reason : lost
      })
      for (const token of some) {
        try {
          keep(token, await readAt(chainId, tokenCalls(token), block, signal))
        } catch (error) {
          if (signal?.aborted) throw error
          leaveOut(token, error)
        }
      }
    }
  }
  return metas
}

/** A reward token's symbol and decimals, for a flow that sends it: ETH with 18 for JB's native token, which nothing is
 * asked of, and otherwise what the token answers. A token that gives no valid decimals is refused, and never taken to
 * have 18. */
export async function rewardTokenMeta(chainId: number, token: Address, { signal }: Cancel = {}): Promise<TokenMeta> {
  if (token.toLowerCase() === NATIVE_REWARD_TOKEN) return { symbol: 'ETH', decimals: 18 }
  return tokenMetaOf(token, await readAt(chainId, tokenCalls(token), undefined, signal))
}

// ---- what a holder has earned

/** Where one refresh reads: the chain, the Sticky token whose holders are rewarded, the block, and the round. */
type Frame = { chainId: number; stToken: Address; block: bigint; timestamp: number; round: bigint; signal?: AbortSignal }

type PotRef = { groupId: bigint; token: Address }
type RoundState = readonly [amount: bigint, snapshotBlock: number, claimedAmount: bigint, claimDeadline: number, totalStake: bigint]

/**
 * A holder's stake in each of `entries`, the round and snapshot of a pot's round. Everyone's (group 0) is the votes at
 * the snapshot. A stake-age group's is the stake still held in its window, read from the hook as the distributor reads
 * it, from the epoch of the snapshot and the project the Sticky token belongs to.
 */
async function stakesOf(
  { chainId, stToken, block, signal }: Frame,
  holder: Address,
  entries: readonly { groupId: bigint; round: bigint; snapshot: bigint }[],
): Promise<bigint[]> {
  if (!entries.length) return []
  const { distributor, hook } = deploymentOn(chainId)
  const tenure = entries.filter(entry => entry.groupId !== 0n)
  const snapshots = [...new Set(entries.filter(entry => entry.groupId === 0n).map(entry => entry.snapshot))]
  const rounds = [...new Set(tenure.map(entry => entry.round))]
  const first = await readAt(
    chainId,
    [
      ...snapshots.map(snapshot => ({ address: stToken, abi: stickyTokenAbi, functionName: 'getPastVotes', args: [holder, snapshot] })),
      ...rounds.map(round => distributorCall(distributor, 'snapshotEpochOf', [round])),
      ...(tenure.length ? [{ address: stToken, abi: stickyTokenAbi, functionName: 'PROJECT_ID' }] : []),
    ],
    block,
    signal,
  )
  const votes = new Map(snapshots.map((snapshot, i) => [snapshot, need(first[i] as Answer<bigint>, 'the votes at a snapshot')]))
  const epochs = new Map(
    rounds.map((round, i) => [round, need(first[snapshots.length + i] as Answer<bigint>, "a snapshot's epoch")]),
  )
  const projectId = tenure.length ? need(first[first.length - 1] as Answer<bigint>, "the Sticky token's project") : 0n

  const windows = new Map(tenure.map(entry => [entry, tenureWindow(entry.groupId, epochs.get(entry.round)!)]))
  const through = new Set<bigint>()
  for (const window of windows.values()) {
    if (!window) continue
    through.add(window.hi)
    if (window.lo > 0n) through.add(window.lo - 1n)
  }
  const stakes = await readAt(
    chainId,
    [...through].map(epoch => ({ address: hook, abi: stickyHookAbi, functionName: 'stakedBalanceThroughEpochOf', args: [projectId, holder, epoch] })),
    block,
    signal,
  )
  const held = new Map([...through].map((epoch, i) => [epoch, need(stakes[i] as Answer<bigint>, 'the stake through an epoch')]))
  return entries.map(entry => {
    if (entry.groupId === 0n) return votes.get(entry.snapshot)!
    const window = windows.get(entry)!
    if (!window) return 0n
    return held.get(window.hi)! - (window.lo === 0n ? 0n : held.get(window.lo - 1n)!)
  })
}

/**
 * What a holder has earned in finished rounds that has not started vesting, for each pot, summed as the distributor
 * materializes it: each round's pot pro-rata to the holder's stake, capped at what the pot still holds. Rounds are
 * read 16 at a time for every pot together. With `any`, a pot that has earned something is not read further: the
 * amount is then only a floor.
 */
async function earnedFrom(
  frame: Frame,
  holder: Address,
  pots: readonly (PotRef & { cursor: bigint })[],
  any: boolean,
): Promise<bigint[]> {
  const { chainId, stToken, block, timestamp, round, signal } = frame
  const { distributor } = deploymentOn(chainId)
  // Keep unusual distributor histories bounded. Rewards that have unlocked can always be collected directly.
  if (pots.some(pot => round > pot.cursor + MAX_UNRESOLVED_ROUNDS)) {
    throw new Error('reward history is too large to check; use a distributor client to start unlocking')
  }
  const earned = pots.map(() => 0n)
  const next = pots.map(pot => pot.cursor)
  let open = pots.flatMap((_, i) => (next[i] < round ? [i] : []))
  while (open.length) {
    const asked = open.flatMap(i => {
      const count = round - next[i] < ROUNDS_PER_PASS ? round - next[i] : ROUNDS_PER_PASS
      return Array.from({ length: Number(count) }, (_, k) => ({ i, round: next[i] + BigInt(k) }))
    })
    const states = await readAt(
      chainId,
      asked.map(({ i, round: at }) => distributorCall(distributor, 'rewardRoundOf', [stToken, pots[i].groupId, pots[i].token, at])),
      block,
      signal,
    )
    const live = asked.flatMap(({ i, round: at }, k) => {
      const [amount, snapshot, claimed, deadline, totalStake] = need(states[k] as Answer<RoundState>, 'a reward round')
      if (amount === 0n || totalStake === 0n || (deadline !== 0 && timestamp >= deadline)) return []
      return [{ i, round: at, amount, snapshot: BigInt(snapshot), claimed, totalStake }]
    })
    const stakes = await stakesOf(frame, holder, live.map(({ i, round: at, snapshot }) => ({ groupId: pots[i].groupId, round: at, snapshot })))
    live.forEach(({ i, amount, claimed, totalStake }, k) => {
      const share = (amount * stakes[k]) / totalStake
      const left = amount > claimed ? amount - claimed : 0n
      earned[i] += share < left ? share : left
    })
    for (const i of open) next[i] += ROUNDS_PER_PASS
    open = open.filter(i => next[i] < round && !(any && earned[i] > 0n))
  }
  return earned
}

/** What `holder` has earned in finished rounds and not started vesting, for each of `pots`: see `earnedFrom`. Read at
 * `pin` (the head by default). */
export async function earnedRewardsOf(
  chainId: number,
  stToken: Address,
  holder: Address,
  pots: readonly PotRef[],
  { signal, pin, any = false }: Cancel & { pin?: BlockPin; any?: boolean } = {},
): Promise<bigint[]> {
  if (!pots.length) return []
  const { distributor } = deploymentOn(chainId)
  const at = pin ?? (await pinnedBlock(chainId, { signal }))
  const answers = (await readAt(
    chainId,
    [
      distributorCall(distributor, 'currentRound'),
      ...pots.map(pot => distributorCall(distributor, 'nextClaimRoundOf', [stToken, pot.groupId, BigInt(holder), pot.token])),
    ],
    at.number,
    signal,
  )) as Answer<bigint>[]
  const [round, ...cursors] = answers.map((answer, i) => need(answer, i === 0 ? 'the current round' : 'where a holder has resolved rewards'))
  const frame: Frame = { chainId, stToken, block: at.number, timestamp: at.timestamp, round, signal }
  return earnedFrom(frame, holder, pots.map((pot, i) => ({ ...pot, cursor: cursors[i] })), any)
}

/** Whether finished rounds hold a share of a pot for `holder` that collecting would start vesting. A vesting-only
 * transaction can succeed and do nothing, so this is asked before one is offered. */
export async function hasRewardsToVest(
  chainId: number,
  stToken: Address,
  holder: Address,
  token: Address,
  groupId = 0n,
  { signal }: Cancel = {},
): Promise<boolean> {
  const [earned] = await earnedRewardsOf(chainId, stToken, holder, [{ groupId, token }], { signal, any: true })
  return earned > 0n
}

// ---- a holder's pots

/**
 * A holder's standing in each of `groups` (the pots to look at: see `rewardRows`), with each token's symbol and
 * decimals and the schedule the dates are on, all read at one block. `known` are tokens the caller has the symbol and
 * decimals of, and which are not read: the staked token's come from the verified project, so no token can keep the
 * staked token's own pot from showing. A pot whose token cannot be read is left out. With no holder, the pots show what
 * was funded and nothing collectable. A read that fails fails the whole call: an amount the distributor could not give is
 * never shown as zero.
 */
export async function readRewards(
  chainId: number,
  stToken: Address,
  holder: Address | null,
  groups: readonly RewardPot[],
  { signal, known = new Map() }: Cancel & { known?: ReadonlyMap<Address, TokenMeta> } = {},
): Promise<RewardCard[]> {
  const { distributor } = deploymentOn(chainId)
  const at = await pinnedBlock(chainId, { signal })
  const clock = await readRewardSchedule(chainId, { pin: at, signal })
  const metas = await readTokenMetas(chainId, [...new Set(groups.map(pot => pot.token))], at.number, signal, known)
  const pots = groups.flatMap(pot => {
    const meta = metas.get(pot.token)
    return meta ? [{ ...pot, meta }] : []
  })
  if (!pots.length) return []

  // What was funded this round and, for a holder, what they can collect and have claimed, their latest vesting entry
  // and the first round they have not resolved.
  const standing = ['collectableFor', 'claimedFor', 'latestVestedIndexOf', 'nextClaimRoundOf']
  const per = holder ? standing.length + 1 : 1
  const answers = await readAt(
    chainId,
    pots.flatMap(pot => [
      distributorCall(distributor, 'rewardRoundOf', [stToken, pot.groupId, pot.token, clock.round]),
      ...(holder ? standing.map(name => distributorCall(distributor, name, [stToken, pot.groupId, BigInt(holder), pot.token])) : []),
    ]),
    at.number,
    signal,
  )
  const rows = pots.map((_, i) => {
    const [pot, ...mine] = answers.slice(i * per, (i + 1) * per)
    const fundedThisRound = need(pot as Answer<RoundState>, "a pot's round")[0]
    if (!holder) return { fundedThisRound, collectable: 0n, claimed: 0n, latest: 0n, cursor: 0n }
    const [collectable, claimed, latest, cursor] = mine.map(answer => need(answer as Answer<bigint>, "a holder's standing in a pot"))
    return { fundedThisRound, collectable, claimed, latest, cursor }
  })

  // A pot with something vesting has entries to read: the round that unlocks last sets when all of it has.
  const lastRelease = pots.map(() => 0n)
  if (holder) {
    const vesting = rows.flatMap((row, i) => (row.claimed > row.collectable ? [i] : []))
    const entries = await readAt(
      chainId,
      vesting.flatMap(i =>
        Array.from({ length: VESTING_ENTRIES }, (_, k) =>
          distributorCall(distributor, 'vestingDataOf', [stToken, pots[i].groupId, BigInt(holder), pots[i].token, rows[i].latest + BigInt(k)]),
        ),
      ),
      at.number,
      signal,
    )
    // Entries past the last one revert.
    vesting.forEach((i, n) => {
      for (const entry of entries.slice(n * VESTING_ENTRIES, (n + 1) * VESTING_ENTRIES)) {
        if (entry.status !== 'success') break
        const [release] = entry.result as readonly [bigint, bigint, bigint]
        if (release > lastRelease[i]) lastRelease[i] = release
      }
    })
  }

  const frame: Frame = { chainId, stToken, block: at.number, timestamp: at.timestamp, round: clock.round, signal }
  const earned = holder ? await earnedFrom(frame, holder, pots.map((pot, i) => ({ ...pot, cursor: rows[i].cursor })), false) : []
  return pots.map((pot, i) => {
    const vesting = rows[i].claimed > rows[i].collectable ? rows[i].claimed - rows[i].collectable : 0n
    return {
      ...pot,
      fundedThisRound: rows[i].fundedThisRound,
      position: {
        collectable: rows[i].collectable,
        vesting,
        earned: earned[i] ?? 0n,
        nextUnlockAt: vesting > 0n ? roundStartOf(clock, clock.round + 1n) : null,
        unlockedAt: vesting > 0n && lastRelease[i] > clock.round ? roundStartOf(clock, lastRelease[i]) : null,
      },
      schedule: clock,
    }
  })
}
