'use client'

import type { BendystrawNetwork } from '@bananapus/nana-sdk-core'
import { queryOptions, skipToken, useQueries, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { Address } from 'viem'
import { chainsForEnvironment } from '@/lib/chains'
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
/** When a refresh reads the home again: Bendystraw lists a launch a few seconds after it lands. */
const REFRESH_AFTER_MS = [0, 4_000, 12_000]

/** The home read under way with each query client. */
const reading = new WeakMap<QueryClient, Promise<unknown>>()

/** `read`, once the home's earlier reads with this client have ended, however they ended: Center has one rate limit for
 * every chain, so the chains are read one after another. A read cancelled while it waits does not start. */
function inTurn<T>(client: QueryClient, signal: AbortSignal, read: () => Promise<T>): Promise<T> {
  const turn = (reading.get(client) ?? Promise.resolve()).then(() => {
    if (signal.aborted) throw signal.reason
    return read()
  })
  // The next read waits for this one to settle. This one's failure goes to its own caller, through `turn`.
  reading.set(client, turn.catch(() => undefined))
  return turn
}

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

/**
 * The home of a network: each chain's part, read one chain after another and drawn as each arrives. Its cards and
 * lists are kept in the browser, so that a return visit shows the last ones at once while the chains are read again.
 * The chart draws from the chains read in this visit, as each one's prices arrive; prices are not kept either. A chain
 * whose read fails is named in `failedChains`, and the others still show.
 */
export function useStickyHome(network: BendystrawNetwork): StickyHome {
  const client = useQueryClient()
  const environment = network === 'testnet' ? 'testnet' : 'production'
  const deployed = stickyChainIds(environment)
  // In the site's order of chains, Ethereum, Optimism, Base and Arbitrum, as the old home read them: cards that tie,
  // a launch's chain icons and the chains a note names follow it.
  const chains = chainsForEnvironment(environment)
    .map(chain => chain.id as number)
    .filter(chainId => deployed.includes(chainId))

  const reads = useQueries({
    queries: chains.map(chainId => ({
      queryKey: ['sticky-home', network, 'chain', chainId, HOME_VERSION],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        inTurn(client, signal, async () => {
          const index = await client.fetchQuery({
            queryKey: ['sticky-home', network, 'index'],
            queryFn: ({ signal: own }) => homeIndex(network, { signal: own }),
            staleTime: NETWORK_FRESH_MS,
          })
          // Without Bendystraw's project list every chain is scanned, and its newest events would go unused.
          const latest = index
            ? await client.fetchQuery({
                queryKey: ['sticky-home', network, 'latest'],
                queryFn: ({ signal: own }) => homeLatest(network, { signal: own }),
                staleTime: NETWORK_FRESH_MS,
              })
            : null
          const { supply, ...kept } = await homeChain(chainId, { index, latest, signal })
          client.setQueryData<SupplyMove[]>(['sticky-home', network, 'history', chainId], supply)
          return kept
        }),
      meta: PERSIST,
    })),
  })
  const shown = reads.map(read => (read.isError ? undefined : read.data))
  // Only a chain's read puts its history here.
  const histories = useQueries({
    queries: chains.map(chainId =>
      queryOptions<SupplyMove[]>({ queryKey: ['sticky-home', network, 'history', chainId], queryFn: skipToken }),
    ),
  })

  const prices = useQueries({
    queries: chains.map((chainId, at) => {
      const tokens = tokensOf(shown[at])
      return {
        queryKey: ['sticky-home', network, 'prices', chainId, tokens],
        queryFn: ({ signal }: { signal: AbortSignal }) => homePrices(chainId, tokens, { signal }),
        enabled: tokens.length > 0,
      }
    }),
  })

  const loaded = shown.filter((chain): chain is KeptChain => chain !== undefined)
  const charted = shown.flatMap((chain, at) => {
    const supply = histories[at].data
    return chain && supply ? [{ ...chain, supply }] : []
  })
  const priced = charted.every(chain => !tokensOf(chain).length || prices[chains.indexOf(chain.chainId)].isSuccess)
  const priceOf = (chainId: number, token: Address) => prices[chains.indexOf(chainId)]?.data?.get(token)
  const secured =
    priced && charted.some(chain => chain.cards.length)
      ? homeSecuredSeries(charted, priceOf, Math.floor(Date.now() / 1_000))
      : null

  return {
    chains,
    cards: groupHomeCards(loaded.flatMap(chain => chain.cards)),
    activity: newestOf(loaded.map(chain => chain.activity)),
    airdrops: newestOf(loaded.map(chain => chain.airdrops)),
    secured,
    failedChains: chains.filter((_, at) => reads[at].isError),
    pending: reads.some(read => read.status === 'pending'),
    revalidating: reads.some(read => read.isFetching && read.data !== undefined),
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
