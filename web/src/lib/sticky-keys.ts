import type { BendystrawNetwork } from '@bananapus/nana-sdk-core'
import type { QueryKey } from '@tanstack/react-query'

/**
 * The keys Sticky's reads are kept under in the query cache. The hooks read under them and a send's refresh
 * (`sticky-refresh.ts`) invalidates by them, so a key that changes changes for both. Each builder gives the start of a
 * key, and a hook adds what else its read depends on. The queries the browser keeps (a project's info, sticks, Latest
 * and chains) write their keys out in full, with the same start: the persist-scope test reads a kept query's key as it
 * is written, to see that it names no account.
 */

/** A part of a Sticky project's page. */
export type ProjectPart =
  | 'info'
  | 'events'
  | 'holders'
  | 'sticks'
  | 'latest'
  | 'page-balances'
  | 'flows'
  | 'siblings'
  | 'funding'

/** A part of a project's page: `['sticky-project', chainId, projectId, part, …]`. */
export const projectKey = (chainId: number, projectId: number, part: ProjectPart) =>
  ['sticky-project', chainId, projectId, part] as const

/** What a project's page reads for one account. */
export type HolderRead = 'sticky-position' | 'sticky-tranches' | 'sticky-rewards' | 'sticky-autostick' | 'sticky-trusted'

/** Every account's `read` of a project: `[read, chainId, projectId, …]`. The hook adds the account, then the rest. */
export const holderReadKey = (read: HolderRead, chainId: number, projectId: number) => [read, chainId, projectId] as const

/** Every account page's reads. */
export const ACCOUNT_PAGES = ['sticky-account'] as const

/** An account page's read of `holder`, in lowercase: `['sticky-account', network, holder, part, …]`. */
export const accountKey = (network: BendystrawNetwork, holder: string, part: 'index' | 'positions' | 'activity') =>
  [...ACCOUNT_PAGES, network, holder, part] as const

/** Every Sticky project of a chain, which an account page scans for when Bendystraw cannot list the account's. */
export const deployedKey = (network: BendystrawNetwork, chainId: number) =>
  [...ACCOUNT_PAGES, network, 'deployed', chainId] as const

/** The account a key of `holderReadKey` or `accountKey` is for, in lowercase: `'deployed'` for a chain's list of
 * projects, which is no account's. */
export function accountOfKey(key: QueryKey): string {
  return String(key[0] === ACCOUNT_PAGES[0] ? key[2] : key[3]).toLowerCase()
}
