'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { Address } from 'viem'
import { useShowing } from '@/hooks/useShowing'
import { useStickyEvents, useStickyProject } from '@/hooks/useStickyProject'
import { useWallet } from '@/hooks/useWallet'
import { inTurn } from '@/lib/in-turn'
import { FRESH_MS, VIEWER_REFRESH, warned } from '@/lib/query-reads'
import { readAutoStick, trustCandidates, trustedSenders } from '@/lib/sticky-autostick'
import { holderReadKey, projectKey } from '@/lib/sticky-keys'
import { discoverFunding, readRewards, rewardRows, type RewardPot } from '@/lib/sticky-rewards'
import { useViewAs } from '@/lib/viewAs'

/**
 * A Sticky project's Airdrops tab: which pots the distributor was funded for, the viewer's standing in them, their
 * auto-stick, and who they trust to stick for them. The keys start with the chain and project, so a page for another
 * project never shows this one's answers. The browser keeps none of these queries: what belongs to the viewer is an
 * account's, and the pots' scan keeps its own history (`keptScanToHead`). Every read waits for this visit's read of the
 * project: a copy of it that the browser kept from an earlier visit names the tokens, and nothing is read on its word.
 * What belongs to the viewer is read again every 15 seconds and when the browser tab is shown again. While the panel is
 * hidden it is not read at all (`useShowing`), and it is read at once when the panel is shown again.
 */

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
    queryKey: projectKey(chainId, projectId, 'funding'),
    queryFn: ({ signal }) =>
      warned(FUNDING_UNREADABLE, { chainId, projectId }, signal, () =>
        inTurn(client, signal, () => discoverFunding(chainId, info!.stToken, BigInt(projectId), { signal })),
      ),
    enabled: verified,
    staleTime: FRESH_MS,
    retry: false,
  })
}

/** Whether the pots are known: found, or that could not be, and the tab goes on with the staked token's. */
const isSettled = (funding: { isSuccess: boolean; isError: boolean }) => funding.isSuccess || funding.isError

const NO_TOKENS: readonly Address[] = []
const NO_POTS = { groups: [] as bigint[], rows: [] as RewardPot[], more: 0 }

/**
 * The pots the tab looks at (`rewardRows`): the newest funded ones, and the staked token, and the tokens in `checked`,
 * under group 0 and the groups of those. `more` is how many funded pots are left out, `funding` is the read that found
 * them. Until it has, the staked token's pot under group 0 stands alone.
 */
export function useRewardPots(chainId: number, projectId: number, checked: readonly Address[] = NO_TOKENS) {
  const { info } = useStickyProject(chainId, projectId)
  const funding = useRewardFunding(chainId, projectId)
  const stakedToken = info?.stakedToken
  const pots = useMemo(
    () => (stakedToken ? rewardRows(stakedToken, funding.data ?? [], checked) : NO_POTS),
    [stakedToken, funding.data, checked],
  )
  return { ...pots, funding }
}

/**
 * The viewer's cards, one for each of `rows` (the pots from `useRewardPots`). With no viewer they show what was funded,
 * and nothing collectable. Finding the pots can take a scan, so the staked token's are read at once, and when the scan
 * lands the cards are read again for all the pots, the same viewer's cards showing meanwhile. The staked token's own
 * symbol and decimals are the verified project's, so no other token can keep its pot from showing.
 */
export function useRewards(chainId: number, projectId: number, holder: Address | null, rows: readonly RewardPot[]) {
  const { info, verified } = useStickyProject(chainId, projectId)
  const showing = useShowing()
  return useQuery({
    queryKey: [
      ...holderReadKey('sticky-rewards', chainId, projectId),
      holder,
      rows.map(row => `${row.groupId}:${row.token}`).join(','),
    ],
    queryFn: ({ signal }) =>
      warned(REWARDS_UNREADABLE, { chainId, projectId }, signal, () => {
        const staked = info!.stakedToken.toLowerCase() as Address
        const known = new Map([[staked, { symbol: info!.symbol, decimals: info!.decimals }]])
        return readRewards(chainId, info!.stToken, holder, rows, { signal, known })
      }),
    enabled: verified && rows.length > 0 && showing,
    // Another pot to read is no other viewer: only the same account's cards stay while they are read again.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[3] === holder ? previous : undefined),
    ...VIEWER_REFRESH,
  })
}

/** The viewer's auto-stick. It waits for the pots: the groups it asks the adapter about are theirs. */
export function useAutoStick(chainId: number, projectId: number, holder: Address | null) {
  const { info } = useStickyProject(chainId, projectId)
  const { groups, funding } = useRewardPots(chainId, projectId)
  const showing = useShowing()
  return useQuery({
    queryKey: [...holderReadKey('sticky-autostick', chainId, projectId), holder, groups.join(',')],
    queryFn: ({ signal }) =>
      warned(AUTOSTICK_UNREADABLE, { chainId, projectId }, signal, () =>
        readAutoStick(chainId, BigInt(projectId), holder!, { info: info!, groups, signal }),
      ),
    enabled: holder !== null && isSettled(funding) && showing,
    ...VIEWER_REFRESH,
  })
}

/** The senders the viewer trusts to stick for them: the ones the project's events name, confirmed by the hook. */
export function useTrustedSenders(chainId: number, projectId: number, holder: Address | null) {
  const events = useStickyEvents(chainId, projectId).data?.events
  const showing = useShowing()
  const candidates = useMemo(
    () => (events && holder ? trustCandidates(events, { chainId, projectId: BigInt(projectId), holder }) : []),
    [events, holder, chainId, projectId],
  )
  return useQuery({
    queryKey: [...holderReadKey('sticky-trusted', chainId, projectId), holder, candidates.join(',')],
    queryFn: ({ signal }) =>
      warned(TRUSTED_UNREADABLE, { chainId, projectId }, signal, () =>
        trustedSenders(events!, { chainId, projectId: BigInt(projectId), holder: holder!, signal }),
      ),
    enabled: holder !== null && events !== undefined && showing,
    ...VIEWER_REFRESH,
  })
}
