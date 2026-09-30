/**
 * Where the old client's links go. The old client was one page that read its view from the address: `?chain=<id>`
 * named the chain it read and `#/project/<id>`, `#/@<handle>` and `#/account/<address>` named the view, each project
 * with an optional tab (`app.js:5895-5949`). Every one of those links was written as `/?chain=…#/…`, so the home page
 * reads its address once, on load, and sends the visitor to the same view at its path.
 */

import { displayChainSlug } from '@/lib/chainDisplay'
import { environmentForChainIds } from '@/lib/chains'
import { decodeProjectRouteSegment } from '@/lib/project-route'
import { projectPath } from '@/lib/urn'

/** The chain of an old link with no `?chain=`: Ethereum, the old client's `STICKY_DEFAULT_CHAIN` default. */
const DEFAULT_CHAIN_ID = 1

const TAB = '(overview|tokens|airdrops|latest)'
// The old client's patterns, with its trailing slash. A hash that fits none of them showed the home page.
const ACCOUNT = /^#\/account\/(0x[0-9a-fA-F]{40})$/
const HANDLE = new RegExp(`^#/@([^/]+)(?:/${TAB})?/?$`)
const PROJECT = new RegExp(`^#/project/(\\d+)(?:/${TAB})?/?$`)

/** The tab an old link named, as the hash of its page. Overview is the page's first tab, so it needs none. */
const tabHash = (tab: string | undefined) => (tab && tab !== 'overview' ? `#${tab}` : '')

/**
 * The path an old link goes to, or null when the address is not an old link, or is one with nowhere to go. `search`
 * is `location.search` and `hash` is `location.hash`.
 *
 * A project's own path names its chain, and a handle names its project through ENS on production chains, so
 * `?chain=` picks a project's chain and nothing more. An account or the home names no chain, so a testnet chain in
 * `?chain=` becomes `?network=testnet`, as the old client took its network from the chain. What comes back is never an
 * old link itself: its search has no `chain` and its hash is a tab, so it cannot send the visitor round again.
 */
export function legacyRoute(search: string, hash: string): string | null {
  const chainId = Number(new URLSearchParams(search).get('chain') || DEFAULT_CHAIN_ID)
  const network = environmentForChainIds([chainId]) === 'testnet' ? '?network=testnet' : ''

  const project = PROJECT.exec(hash)
  if (project) {
    // A chain we do not route has no slug to name it by.
    if (displayChainSlug(chainId) === null) return null
    return `${projectPath(chainId, BigInt(project[1]))}${tabHash(project[2])}`
  }

  const handle = HANDLE.exec(hash)
  if (handle) return `/@${encodeURIComponent(decodeProjectRouteSegment(handle[1]) ?? handle[1])}${tabHash(handle[2])}`

  const account = ACCOUNT.exec(hash)
  if (account) return `/account/${account[1]}${network}`

  // Anything else showed the home, which is already where a production visitor is.
  return network ? `/${network}` : null
}
