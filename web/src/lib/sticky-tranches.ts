/**
 * A holder's tranches, for the Tokens tab: what they staked and when, one Sticky stick at a time. A holder can be
 * given a million dust tranches, so the list is never read whole: a page is 50 of them, counted from the newest, and
 * the count and the slice are read at one block, so a burn between the two cannot shift the range.
 */

import type { Address } from 'viem'
import { untilAborted } from '@/lib/hook-logs'
import { jbCenterPublicClient } from '@/lib/jbcenter-rpc'
import { stickyHookAbi } from '@/lib/sticky-abis'
import { deploymentOn } from '@/lib/sticky-addresses'

/** How many tranches a page holds. */
export const TRANCHES_PER_PAGE = 50

/** What a holder staked in one stick: Sticky shares, with 18 decimals, and when, in Unix seconds. */
export type Tranche = { amount: bigint; timestamp: number }

export type TranchePage = {
  /** The page's tranches, oldest first. */
  tranches: Tranche[]
  /** How many tranches the holder has. */
  total: bigint
  /** The page these are: 0 is the newest. The page asked for, or the last one when it asked for one past it. */
  page: number
  /** Where in the holder's list the page starts: the number of tranches older than it. */
  start: bigint
}

/**
 * The page `requestedPage` of `holder`'s tranches in a project, at `block`. A page past the last, which burns can leave
 * a page open at, is the last one, and a page before the first is the first. A page with fewer tranches than its range
 * holds is refused, not shown.
 */
export async function readTranchePage(
  chainId: number,
  projectId: bigint,
  holder: Address,
  requestedPage: number,
  block: bigint,
  { signal }: { signal?: AbortSignal } = {},
): Promise<TranchePage> {
  const deployment = deploymentOn(chainId)
  const { hook } = deployment
  const client = jbCenterPublicClient(chainId)

  const total = await untilAborted(
    client.readContract({
      address: hook,
      abi: stickyHookAbi,
      functionName: 'trancheCountOf',
      args: [projectId, holder],
      blockNumber: block,
    }),
    signal,
  )
  if (total === 0n) return { tranches: [], total, page: 0, start: 0n }

  const perPage = BigInt(TRANCHES_PER_PAGE)
  const lastPage = (total - 1n) / perPage
  const wanted = BigInt(Math.max(0, Math.floor(requestedPage)))
  const page = wanted > lastPage ? lastPage : wanted
  const end = total - page * perPage
  const start = end > perPage ? end - perPage : 0n

  const read = await untilAborted(
    client.readContract({
      address: hook,
      abi: stickyHookAbi,
      functionName: 'tranchesOf',
      args: [projectId, holder, start, end - start],
      blockNumber: block,
    }),
    signal,
  )
  if (BigInt(read.length) !== end - start) throw new Error('The RPC returned an incomplete tranche page.')
  return {
    tranches: read.map(({ amount, timestamp }) => ({ amount, timestamp })),
    total,
    page: Number(page),
    start,
  }
}
