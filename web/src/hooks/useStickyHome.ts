'use client'

import type { BendystrawNetwork } from '@bananapus/nana-sdk-core'
import {
  queryOptions,
  skipToken,
  useQueries,
  useQueryClient,
  type QueryClient,
  type QueryObserverResult,
} from '@tanstack/react-query'
import { useMemo } from 'react'
import type { Address } from 'viem'
import { chainsForEnvironment } from '@/lib/chains'
import { untilAborted } from '@/lib/hook-logs'
import { inTurn } from '@/lib/in-turn'
import { PERSIST } from '@/lib/query-persist'
import { stickyChainIds } from '@/lib/sticky-addresses'
import { FEED_WINDOW, type FeedRow } from '@/lib/sticky-feed'
import {
  HOME_VERSION,
  groupHomeCards,
  homeChain,
  homeIndex,
  homeLatest,
  homePrices,
  homeSecuredSeries,
  type HomeCardGroup,
  type HomeChain,
  type SecuredSeries,
  type SupplyMove,
} from '@/lib/sticky-home'

/** How long the network's project list and newest events stay fresh: one read of them serves every chain's. */
const NETWORK_FRESH_MS = 30_000
const DAY_MS = 86_400_000
const CHAIN_UNREADABLE = "Could not read a chain's Sticky tokens; the home names the chain in its note."
/** When a refresh reads the home again: Bendystraw lists a launch a few seconds after it lands. */
const REFRESH_AFTER_MS = [0, 4_000, 12_000]

export type StickyHome = {
  /** The network's Sticky chains. None when Sticky is not deployed on it. */
  chains: number[]
  /** The Stickiest cards of the chains read so far, ranked. */
  cards: HomeCardGroup[]
  /** The newest FEED_WINDOW rows of Latest and of Airdrops across those chains, newest first. */
  activity: FeedRow[]
  airdrops: FeedRow[]
  /** What Sticky secures across the chains read in this visit, once each has its prices; null until then, or with no
   * card to value. */
  secured: SecuredSeries | null
  /** The chains whose last read failed. What they had before is not shown. */
  failedChains: number[]
  /** Whether a chain has neither answered nor failed yet. */
  pending: boolean
  /** Whether a chain on show is being read again, so what shows is not yet confirmed. */
  revalidating: boolean
  /** Forgets the home and reads it again from the start. */
  retry: () => void
}

/** The newest FEED_WINDOW rows of the chains' lists, newest first. Rows that tie keep their chain's order. */
function newestOf(lists: readonly FeedRow[][]): FeedRow[] {
  return lists
    .flat()
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, FEED_WINDOW)
}

/** What the browser keeps of a chain's part: its cards and lists. The chart's history is not kept: it grows with
 * every stick and unstick, and a store that grows past its budget is dropped whole. */
type KeptChain = Omit<HomeChain, 'supply'>

/** The staked tokens of a chain's cards, each once. */
const tokensOf = (chain: KeptChain | undefined): Address[] =>
  chain ? [...new Set(chain.cards.map(card => card.info.stakedToken))] : []

/** What the home takes of its chains' reads. Each part keeps its identity while it is unchanged (react-query shares
 * what `combine` returns), so the chart is valued again only when its inputs change. */
function chainsRead(results: QueryObserverResult<KeptChain>[]) {
  return {
    shown: results.map(read => (read.isError ? undefined : read.data)),
    failed: results.map(read => read.isError),
    pending: results.some(read => read.status === 'pending'),
    revalidating: results.some(read => read.isFetching && read.data !== undefined),
  }
}
const historiesRead = (results: QueryObserverResult<SupplyMove[]>[]) => results.map(read => read.data)
type ChainPrices = {
  prices: Map<Address, number> | undefined
  /** Whether there are prices to draw with: the chain's answer, or while its tokens change, its last one. */
  answered: boolean
  /** Whether the chain's answer for its tokens as they are now has come. */
  settled: boolean
}
const pricesRead = (results: QueryObserverResult<Map<Address, number> | null>[]): ChainPrices[] =>
  results.map(read => ({
    prices: read.data ?? undefined,
    answered: read.isSuccess,
    settled: read.isSuccess && !read.isPlaceholderData,
  }))

/** The prices a chain's latest answered price query gave, for whatever tokens it asked about. */
function lastPrices(client: QueryClient, network: BendystrawNetwork, chainId: number) {
  const [latest] = client
    .getQueryCache()
    .findAll({ queryKey: ['sticky-home', network, 'prices', chainId], predicate: query => query.state.status === 'success' })
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
  return latest?.state.data as Map<Address, number> | null | undefined
}

/** The chart, from the chains read in this visit, once each one's tokens have been priced. */
function securedOf(
  chains: readonly number[],
  shown: readonly (KeptChain | undefined)[],
  histories: readonly (SupplyMove[] | undefined)[],
  prices: readonly ChainPrices[],
): SecuredSeries | null {
  const charted = shown.flatMap((chain, at) => {
    const supply = histories[at]
    return chain && supply ? [{ at, chain: { ...chain, supply } }] : []
  })
  const priced = charted.every(({ at, chain }) => !tokensOf(chain).length || prices[at].answered)
  if (!priced || !charted.some(({ chain }) => chain.cards.length)) return null
  const priceOf = (chainId: number, token: Address) => prices[chains.indexOf(chainId)]?.prices?.get(token)
  return homeSecuredSeries(
    charted.map(({ chain }) => chain),
    priceOf,
    Math.floor(Date.now() / 1_000),
    chainId => prices[chains.indexOf(chainId)]?.settled ?? false,
  )
}

/**
 * The home of a network: each chain's part, read one chain after another and drawn as each arrives. Its cards and
 * lists are kept in the browser, so that a return visit shows the last ones at once while the chains are read again.
 * The chart draws from the chains read in this visit, as each one's prices arrive; prices are not kept either. A chain
 * whose read fails is named in `failedChains`, and the console hears why; the others still show.
 */
export function useStickyHome(network: BendystrawNetwork): StickyHome {
  const client = useQueryClient()
  const environment = network === 'testnet' ? 'testnet' : 'production'
  // In the site's order of chains, Ethereum, Optimism, Base and Arbitrum, as the old home read them: cards that tie,
  // a launch's chain icons and the chains a note names follow it.
  const chains = useMemo(() => {
    const deployed = stickyChainIds(environment)
    return chainsForEnvironment(environment)
      .map(chain => chain.id as number)
      .filter(chainId => deployed.includes(chainId))
  }, [environment])

  const reads = useQueries({
    queries: chains.map(chainId => ({
      queryKey: ['sticky-home', network, 'chain', chainId, HOME_VERSION],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        inTurn(client, signal, async () => {
          try {
            // The network's reads run on their own signals and serve every chain; a cancelled chain stops waiting.
            const index = await untilAborted(
              client.fetchQuery({
                queryKey: ['sticky-home', network, 'index'],
                queryFn: ({ signal: own }) => homeIndex(network, { signal: own }),
                staleTime: NETWORK_FRESH_MS,
              }),
              signal,
            )
            // Without Bendystraw's project list every chain is scanned, and its newest events would go unused.
            const latest = index
              ? await untilAborted(
                  client.fetchQuery({
                    queryKey: ['sticky-home', network, 'latest'],
                    queryFn: ({ signal: own }) => homeLatest(network, { signal: own }),
                    staleTime: NETWORK_FRESH_MS,
                  }),
                  signal,
                )
              : null
            const { supply, ...kept } = await homeChain(chainId, { index, latest, signal })
            client.setQueryData<SupplyMove[]>(['sticky-home', network, 'history', chainId], supply)
            return kept
          } catch (error) {
            if (!signal.aborted) console.warn(CHAIN_UNREADABLE, { network, chainId }, error)
            throw error
          }
        }),
      // Each request of a chain's read is retried already; a second go would only repeat its scans, and name the
      // chain later.
      retry: false,
      meta: PERSIST,
    })),
    combine: chainsRead,
  })
  // Only a chain's read puts its history here.
  const histories = useQueries({
    queries: chains.map(chainId =>
      queryOptions<SupplyMove[]>({ queryKey: ['sticky-home', network, 'history', chainId], queryFn: skipToken }),
    ),
    combine: historiesRead,
  })
  const prices = useQueries({
    queries: chains.map((chainId, at) => {
      const tokens = tokensOf(reads.shown[at])
      return {
        queryKey: ['sticky-home', network, 'prices', chainId, tokens],
        queryFn: ({ signal }: { signal: AbortSignal }) => homePrices(chainId, tokens, { signal }),
        enabled: tokens.length > 0,
        // A chain whose tokens change keeps the prices it had while the new list is priced, so the chart stays up.
        // The list is in the key, so the new list is a new query: its placeholder is the chain's last answer.
        placeholderData: () => lastPrices(client, network, chainId),
      }
    }),
    combine: pricesRead,
  })

  const today = Math.floor(Date.now() / DAY_MS)
  const secured = useMemo(
    () => securedOf(chains, reads.shown, histories, prices),
    // `today` is read by no line inside: a new day is when the chart's last point, and its axis, move on to now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chains, reads.shown, histories, prices, today],
  )
  const loaded = reads.shown.filter((chain): chain is KeptChain => chain !== undefined)

  return {
    chains,
    cards: groupHomeCards(loaded.flatMap(chain => chain.cards)),
    activity: newestOf(loaded.map(chain => chain.activity)),
    airdrops: newestOf(loaded.map(chain => chain.airdrops)),
    secured,
    failedChains: chains.filter((_, at) => reads.failed[at]),
    pending: reads.pending,
    revalidating: reads.revalidating,
    retry: () => void client.resetQueries({ queryKey: ['sticky-home', network] }),
  }
}

/** Reads every network's home again now, at +4 s and at +12 s, with its project list and newest events: after a
 * launch, Bendystraw lists the new project a few seconds after it lands. */
export function refreshStickyHome(client: QueryClient): void {
  const again = () => void client.invalidateQueries({ queryKey: ['sticky-home'] })
  for (const delay of REFRESH_AFTER_MS) {
    if (delay === 0) again()
    else setTimeout(again, delay)
  }
}
