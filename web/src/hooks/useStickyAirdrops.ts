'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { Address } from 'viem'
import { scanInTurn, useStickyEvents, useStickyProject, warned } from '@/hooks/useStickyProject'
import { useWallet } from '@/hooks/useWallet'
import { readAutoStick, trustCandidates, trustedSenders } from '@/lib/sticky-autostick'
import { discoverFunding, readRewards, rewardRows } from '@/lib/sticky-rewards'
import { useViewAs } from '@/lib/viewAs'

/**
 * A Sticky project's Airdrops tab: which pots the distributor was funded for, the viewer's standing in them, their
 * auto-stick, and who they trust to stick for them. The keys start with the chain and project, so a page for another
 * project never shows this one's answers. The browser keeps none of these queries: what belongs to the viewer is an
 * account's, and the pots' scan keeps its own history (`keptScanToHead`). Every read waits for this visit's read of the
 * project: a copy of it that the browser kept from an earlier visit names the tokens, and nothing is read on its word.
 */

/** How long the pots stay fresh. */
const FUNDING_FRESH_MS = 30_000
/** How often what belongs to the viewer is read again while the page is in view. */
const REFRESH_MS = 15_000

const FUNDING_UNREADABLE = "Could not list a Sticky project's airdrops; the Airdrops tab shows only the staked token's."
const REWARDS_UNREADABLE = "Could not read the viewer's airdrop rewards; the Airdrops tab keeps the last it showed."
const AUTOSTICK_UNREADABLE = "Could not read the viewer's auto-stick; the Airdrops tab keeps the last it showed."
const TRUSTED_UNREADABLE = "Could not read who the viewer trusts to stick for them; the Airdrops tab keeps the last it showed."

/** The account the page shows the reads of: the one in View as, or else the connected one. */
export function useViewer(): Address | null {
  const { viewAs } = useViewAs()
  const { address } = useWallet()
  return viewAs ?? address ?? null
}

/** Every pot a project's Sticky token has been funded for, from the distributor's Fund logs (`discoverFunding`), read
 * once for the whole tab. It is tried once: a scan that cannot finish fails the same way again. */
export function useRewardFunding(chainId: number, projectId: number) {
  const client = useQueryClient()
  const { info, verified } = useStickyProject(chainId, projectId)
  return useQuery({
    queryKey: ['sticky-project', chainId, projectId, 'funding'],
    queryFn: ({ signal }) =>
      warned(FUNDING_UNREADABLE, { chainId, projectId }, signal, () =>
        scanInTurn(client, signal, () => discoverFunding(chainId, info!.stToken, BigInt(projectId), { signal })),
      ),
    enabled: verified,
    staleTime: FUNDING_FRESH_MS,
    retry: false,
  })
}

/** Whether the pots are known: found, or that could not be, and the tab goes on with the staked token's. */
const isSettled = (funding: { isSuccess: boolean; isError: boolean }) => funding.isSuccess || funding.isError

/**
 * The viewer's cards, one for each pot: the funded ones, the staked token's under every group, and the tokens in
 * `checked` under every group. They are read again every 15 seconds while the tab is in view. With no viewer they show
 * what was funded, and nothing collectable. Finding the pots can take a scan, so the staked token's are read at once,
 * and when the scan lands the cards are read again for all the pots, the same viewer's cards showing meanwhile.
 */
export function useRewards(chainId: number, projectId: number, holder: Address | null, checked: readonly Address[]) {
  const { info, verified } = useStickyProject(chainId, projectId)
  const funding = useRewardFunding(chainId, projectId)
  const stakedToken = info?.stakedToken
  const rows = useMemo(
    () => (stakedToken ? rewardRows(stakedToken, funding.data ?? [], checked).rows : []),
    [stakedToken, funding.data, checked],
  )
  return useQuery({
    queryKey: ['sticky-rewards', chainId, projectId, holder, rows.map(row => `${row.groupId}:${row.token}`).join(',')],
    queryFn: ({ signal }) =>
      warned(REWARDS_UNREADABLE, { chainId, projectId }, signal, () =>
        readRewards(chainId, info!.stToken, holder, rows, { signal }),
      ),
    enabled: verified && rows.length > 0,
    // Another pot to read is no other viewer: only the same account's cards stay while they are read again.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[3] === holder ? previous : undefined),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  })
}

/** The viewer's auto-stick, read again every 15 seconds while the tab is in view. It waits for the pots: the groups it
 * asks the adapter about are theirs. */
export function useAutoStick(chainId: number, projectId: number, holder: Address | null) {
  const { info } = useStickyProject(chainId, projectId)
  const funding = useRewardFunding(chainId, projectId)
  const stakedToken = info?.stakedToken
  const groups = useMemo(() => (stakedToken ? rewardRows(stakedToken, funding.data ?? []).groups : []), [stakedToken, funding.data])
  return useQuery({
    queryKey: ['sticky-autostick', chainId, projectId, holder, groups.join(',')],
    queryFn: ({ signal }) =>
      warned(AUTOSTICK_UNREADABLE, { chainId, projectId }, signal, () =>
        readAutoStick(chainId, BigInt(projectId), holder!, { info: info!, groups, signal }),
      ),
    enabled: holder !== null && isSettled(funding),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  })
}

/** The senders the viewer trusts to stick for them: the ones the project's events name, confirmed by the hook, and read
 * again every 15 seconds while the tab is in view. */
export function useTrustedSenders(chainId: number, projectId: number, holder: Address | null) {
  const events = useStickyEvents(chainId, projectId).data?.events
  const candidates = useMemo(
    () => (events && holder ? trustCandidates(events, { chainId, projectId: BigInt(projectId), holder }) : []),
    [events, holder, chainId, projectId],
  )
  return useQuery({
    queryKey: ['sticky-trusted', chainId, projectId, holder, candidates.join(',')],
    queryFn: ({ signal }) =>
      warned(TRUSTED_UNREADABLE, { chainId, projectId }, signal, () =>
        trustedSenders(events!, { chainId, projectId: BigInt(projectId), holder: holder!, signal }),
      ),
    enabled: holder !== null && events !== undefined,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  })
}
