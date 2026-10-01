'use client'

import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { useShowing } from '@/hooks/useShowing'
import { FRESH_MS, warned } from '@/lib/query-reads'
import { pinnedBlock, verifyHolderPage, type HolderRow, type StickyPosition } from '@/lib/sticky-holders'
import { holderReadKey, projectKey } from '@/lib/sticky-keys'
import { readTranchePage, type TranchePage } from '@/lib/sticky-tranches'

/**
 * What the Tokens tab reads beyond the project page's own: a holder's tranches, and the balances of the holders a page
 * of the leaderboard shows. The tranches are an account's, so the browser never keeps them. The balances are public,
 * and stay in memory: which holders a page shows changes with the sort and the page.
 */

const TRANCHES_UNREADABLE = "Could not read the viewer's tranches; the Tokens tab offers to try again."
const BALANCES_UNCHECKED =
  "Could not read the visible holders' balances from the hook; the leaderboard keeps the balances the index gave."

/** A holder's page of tranches, and the time of the block it was read at, which its ages are measured at. */
type HolderTranches = TranchePage & { now: number }

/**
 * The page `requestedPage` of `holder`'s tranches, read at the block of the holder's `position` (the Stick card's): so
 * the tranches and the stick beside them are one block's, and the block's time is what their ages are measured at.
 * Nothing is read before there is a position, which waits for the project, or while the tab's panel is hidden. The
 * position is read again every 15 seconds and when the tab is shown again, and each block it is read at is a page of its
 * own here: the tranches follow it, and the panel, shown again, reads the page of the block the position is at. The
 * browser never keeps them: they are an account's. Another page is read while the one shown stays; another account's
 * page never does.
 */
export function useHolderTranches(
  chainId: number,
  projectId: number,
  holder: Address | null,
  requestedPage: number,
  position: StickyPosition | undefined,
) {
  const showing = useShowing()
  return useQuery<HolderTranches>({
    queryKey: [
      ...holderReadKey('sticky-tranches', chainId, projectId),
      holder,
      requestedPage,
      position?.blockNumber.toString() ?? null,
    ],
    queryFn: ({ signal }) =>
      warned(TRANCHES_UNREADABLE, { chainId, projectId }, signal, async () => {
        const page = await readTranchePage(chainId, BigInt(projectId), holder!, requestedPage, position!.blockNumber, { signal })
        return { ...page, now: position!.timestamp }
      }),
    enabled: holder !== null && position !== undefined && showing,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[3] === holder ? previous : undefined),
  })
}

/**
 * What the hook says each of `rows` holds now, in their order, read at one block: the balances the visible page of the
 * leaderboard shows in place of the index's. Nothing is read for no rows. The answer is balances alone, so it fits
 * whichever rows the page is showing when it lands.
 */
export function useCheckedBalances(chainId: number, projectId: number, rows: readonly HolderRow[]) {
  return useQuery<bigint[]>({
    queryKey: [...projectKey(chainId, projectId, 'page-balances'), rows.map(row => row.holder)],
    queryFn: ({ signal }) =>
      warned(BALANCES_UNCHECKED, { chainId, projectId }, signal, async () => {
        const pin = await pinnedBlock(chainId, { signal })
        const checked = await verifyHolderPage(chainId, BigInt(projectId), rows, pin.number, { signal })
        return checked.map(row => row.staked)
      }),
    enabled: rows.length > 0,
    staleTime: FRESH_MS,
  })
}
