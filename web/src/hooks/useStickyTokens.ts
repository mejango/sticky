'use client'

import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { pinnedBlock, verifyHolderPage, type HolderRow } from '@/lib/sticky-holders'
import { readTranchePage, type TranchePage } from '@/lib/sticky-tranches'

/**
 * What the Tokens tab reads beyond the project page's own: a holder's tranches, and the balances of the holders a page
 * of the leaderboard shows. The tranches are an account's, so the browser never keeps them. The balances are public,
 * and stay in memory: which holders a page shows changes with the sort and the page.
 */

/** How long a page of balances stays fresh. */
const FRESH_MS = 30_000
/** How often a holder's tranches are read again while the page is in view, as the Stick card's stick is. */
const TRANCHES_REFRESH_MS = 15_000

const TRANCHES_UNREADABLE = "Could not read the viewer's tranches; the Tokens tab offers to try again."
const BALANCES_UNCHECKED =
  "Could not read the visible holders' balances from the hook; the leaderboard keeps the balances the index gave."

/** A holder's page of tranches, and the time of the block it was read at, which its ages are measured at. */
type HolderTranches = TranchePage & { now: number }

/** What `read` gives, or its failure, which the console hears about under `label` unless the read was cancelled. */
async function warned<T>(label: string, about: object, signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (!signal.aborted) console.warn(label, about, error)
    throw error
  }
}

/**
 * The page `requestedPage` of `holder`'s tranches, read at one block, once there is a holder. It is read again every 15
 * seconds while the tab is in view, and the browser never keeps it: it is an account's. Another page is read while the
 * one shown stays; another account's page never does.
 */
export function useHolderTranches(chainId: number, projectId: number, holder: Address | null, requestedPage: number) {
  return useQuery<HolderTranches>({
    queryKey: ['sticky-tranches', chainId, projectId, holder, requestedPage],
    queryFn: ({ signal }) =>
      warned(TRANCHES_UNREADABLE, { chainId, projectId }, signal, async () => {
        const pin = await pinnedBlock(chainId, { signal })
        const page = await readTranchePage(chainId, BigInt(projectId), holder!, requestedPage, pin.number, { signal })
        return { ...page, now: pin.timestamp }
      }),
    enabled: holder !== null,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[3] === holder ? previous : undefined),
    refetchInterval: TRANCHES_REFRESH_MS,
    refetchIntervalInBackground: false,
  })
}

/**
 * What the hook says each of `rows` holds now, in their order, read at one block: the balances the visible page of the
 * leaderboard shows in place of the index's. Nothing is read for no rows. The answer is balances alone, so it fits
 * whichever rows the page is showing when it lands.
 */
export function useCheckedBalances(chainId: number, projectId: number, rows: readonly HolderRow[]) {
  return useQuery<bigint[]>({
    queryKey: ['sticky-project', chainId, projectId, 'page-balances', rows.map(row => row.holder)],
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
