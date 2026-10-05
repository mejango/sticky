import type { InvalidateQueryFilters, QueryClient } from '@tanstack/react-query'
import type { Address } from 'viem'
import {
  ACCOUNT_PAGES,
  accountOfKey,
  holderReadKey,
  projectKey,
  type HolderRead,
  type ProjectPart,
} from '@/lib/sticky-keys'

/** When a refresh reads again: now, and twice more, since the index and the nodes behind Center can be a few seconds
 * behind the block that was just confirmed. */
export const REFRESH_AFTER_MS = [0, 4_000, 12_000] as const

/** Invalidates what each of `filters` names, now and at +4 s and +12 s. */
export function refreshOnSchedule(client: QueryClient, filters: readonly InvalidateQueryFilters[]): void {
  const again = () => {
    for (const filter of filters) void client.invalidateQueries(filter)
  }
  for (const delay of REFRESH_AFTER_MS) {
    if (delay === 0) again()
    else setTimeout(again, delay)
  }
}

/** What a stick or an unstick changes of a project's page: its figures, and what its holders and Latest are read from.
 * Each refresh below reads again what its send changed and nothing else, and none reads a project's whole key again: it
 * also holds the Overview's scans, which a send must not queue ahead of the holders and Latest. */
const PAGE: readonly ProjectPart[] = ['info', 'events', 'holders', 'sticks', 'latest', 'page-balances']
/** What a transfer changes of it: who holds what, and the history that says so. The supply and backing stay. */
const HOLDINGS: readonly ProjectPart[] = ['events', 'holders', 'sticks', 'latest', 'page-balances']
/** What shares minted, burned or moved change of an account in a project. */
const STAKE: readonly HolderRead[] = ['sticky-position', 'sticky-tranches', 'sticky-rewards']

const ofPage = (chainId: number, projectId: number, parts: readonly ProjectPart[]): InvalidateQueryFilters[] =>
  parts.map(part => ({ queryKey: projectKey(chainId, projectId, part) }))

const ofEveryone = (chainId: number, projectId: number, reads: readonly HolderRead[]): InvalidateQueryFilters[] =>
  reads.map(read => ({ queryKey: holderReadKey(read, chainId, projectId) }))

/** `holder`'s own reads, whatever the case of the address in their keys. */
function ofHolder(chainId: number, projectId: number, holder: Address, reads: readonly HolderRead[]): InvalidateQueryFilters[] {
  const who = holder.toLowerCase()
  return reads.map(read => ({
    queryKey: holderReadKey(read, chainId, projectId),
    predicate: query => accountOfKey(query.queryKey) === who,
  }))
}

/** A stick: the project's figures, holders and Latest, every account's stick, tranches and rewards in it (a stick can
 * be for someone else), and the account pages' positions and activity, but not each chain's list of every Sticky
 * project, a scan that no stick changes. */
export function refreshAfterStick(client: QueryClient, chainId: number, projectId: number): void {
  refreshOnSchedule(client, [
    ...ofPage(chainId, projectId, PAGE),
    ...ofEveryone(chainId, projectId, STAKE),
    { queryKey: ACCOUNT_PAGES, predicate: query => accountOfKey(query.queryKey) !== 'deployed' },
  ])
}

/** An unstick: the project's figures, holders and Latest, and the holder's own stick, tranches, rewards, auto-stick and
 * account page. */
export function refreshAfterUnstick(client: QueryClient, chainId: number, projectId: number, holder: Address): void {
  const who = holder.toLowerCase()
  refreshOnSchedule(client, [
    ...ofPage(chainId, projectId, PAGE),
    ...ofHolder(chainId, projectId, holder, [...STAKE, 'sticky-autostick']),
    { queryKey: ACCOUNT_PAGES, predicate: query => accountOfKey(query.queryKey) === who },
  ])
}

/** A change of a holder's auto-stick (turning it on or off, its settings, its trust or allowance): their auto-stick and
 * who they trust, and nothing else. */
export function refreshAfterAutoStick(client: QueryClient, chainId: number, projectId: number, holder: Address): void {
  refreshOnSchedule(client, ofHolder(chainId, projectId, holder, ['sticky-autostick', 'sticky-trusted']))
}

/** A transfer: who holds what and the history that says so, the sender's and the recipient's stick, tranches and
 * rewards, and the account pages, but not each chain's list of every Sticky project, which no transfer changes. */
export function refreshAfterTransfer(client: QueryClient, chainId: number, projectId: number): void {
  refreshOnSchedule(client, [
    ...ofPage(chainId, projectId, HOLDINGS),
    ...ofEveryone(chainId, projectId, STAKE),
    { queryKey: ACCOUNT_PAGES, predicate: query => accountOfKey(query.queryKey) !== 'deployed' },
  ])
}

/** A change of trust is one hook event: the list of trusted senders is read from the history and confirmed with the
 * hook, and the auto-stick card reads whether the holder trusts the adapter. */
export function refreshAfterTrust(client: QueryClient, chainId: number, projectId: number): void {
  refreshOnSchedule(client, [
    ...ofPage(chainId, projectId, ['events']),
    ...ofEveryone(chainId, projectId, ['sticky-trusted', 'sticky-autostick']),
  ])
}

/** An airdrop: the pots the distributor was funded for, what every account has in them and the auto-stick that reads
 * their groups, and what the funder holds of the staked token, which can be what they sent. */
export function refreshAfterFund(client: QueryClient, chainId: number, projectId: number, funder: Address): void {
  refreshOnSchedule(client, [
    ...ofPage(chainId, projectId, ['funding']),
    ...ofEveryone(chainId, projectId, ['sticky-rewards', 'sticky-autostick']),
    ...ofHolder(chainId, projectId, funder, ['sticky-position']),
  ])
}

/** A collect of rewards: the holder's rewards and the auto-stick that reads them, and their stick, whose wallet a reward
 * in the staked token is paid to. */
export function refreshAfterCollect(client: QueryClient, chainId: number, projectId: number, holder: Address): void {
  refreshOnSchedule(client, ofHolder(chainId, projectId, holder, ['sticky-position', 'sticky-rewards', 'sticky-autostick']))
}

/** A stick of a holder's rewards (a claim and stick, or auto-stick's stick of ready rewards now): what an unstick
 * changes, since it mints for the holder and collects their rewards, and who they trust, which a claim's trust step can
 * change. */
export function refreshAfterRewardStick(client: QueryClient, chainId: number, projectId: number, holder: Address): void {
  const who = holder.toLowerCase()
  refreshOnSchedule(client, [
    ...ofPage(chainId, projectId, PAGE),
    ...ofHolder(chainId, projectId, holder, [...STAKE, 'sticky-autostick', 'sticky-trusted']),
    { queryKey: ACCOUNT_PAGES, predicate: query => accountOfKey(query.queryKey) === who },
  ])
}

/** A reward address created: the reward addresses, whether each is created and what it holds. */
export function refreshAfterReceiver(client: QueryClient, chainId: number, projectId: number): void {
  refreshOnSchedule(client, ofPage(chainId, projectId, ['receiver']))
}

/** A reward address's arrivals settled: an airdrop from the address, so the pots, what every account has in them and the
 * auto-stick that reads their groups, and what the reward addresses hold. */
export function refreshAfterSettle(client: QueryClient, chainId: number, projectId: number): void {
  refreshOnSchedule(client, [
    ...ofPage(chainId, projectId, ['funding', 'receiver']),
    ...ofEveryone(chainId, projectId, ['sticky-rewards', 'sticky-autostick']),
  ])
}
