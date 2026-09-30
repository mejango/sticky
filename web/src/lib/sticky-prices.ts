/**
 * What a token is worth in US dollars, from DexScreener. A price is looked up by chain and contract address, and
 * never by symbol: two unrelated tokens with one ticker must not be valued as one asset. A token DexScreener has no
 * usable pair for has no entry, and is never priced at zero.
 */

import type { Address } from 'viem'
import { withTimeout } from '@/lib/with-timeout'

/** DexScreener's names for the production chains it is asked about. A testnet has none, and so no prices. */
const DEXSCREENER_CHAIN: Record<number, string> = {
  1: 'ethereum',
  10: 'optimism',
  8453: 'base',
  42_161: 'arbitrum',
}

const ENDPOINT = 'https://api.dexscreener.com/tokens/v1'

/** How many addresses one DexScreener request may name. */
const ADDRESSES_PER_REQUEST = 30

/** How long DexScreener has to answer one request: a price is an extra, so a slow one should not hold a page. */
const TIMEOUT_MS = 5_000

export type PriceOptions = {
  signal?: AbortSignal
  /** In tests, the fetch to use instead of the browser's. */
  fetch?: typeof fetch
}

type Best = { price: number; liquidity: number }

/** A pair as DexScreener lists it, and as far as it is read: `priceUsd` is the base's price in USD and
 * `priceNative` its price in the quote. Every field is checked where it is used, and a listing that is no object is
 * skipped. */
type Pair = {
  baseToken?: { address?: unknown } | null
  quoteToken?: { address?: unknown } | null
  priceUsd?: unknown
  priceNative?: unknown
  liquidity?: { usd?: unknown } | null
}

const addressOf = (token: Pair['baseToken']) => (typeof token?.address === 'string' ? token.address.toLowerCase() : null)

/** The USD price of `address` in `pair`, or null when the pair does not give it a usable one: the pair's own price
 * when the token is its base, and the base's USD price over the base's price in the token when the token is its
 * quote. A price that is not a finite number above zero is no price. */
function priceIn(pair: Pair | null, address: string): number | null {
  let price: number
  if (addressOf(pair?.baseToken) === address) {
    price = Number(pair?.priceUsd)
  } else if (addressOf(pair?.quoteToken) === address) {
    const baseInQuote = Number(pair?.priceNative)
    price = baseInQuote > 0 ? Number(pair?.priceUsd) / baseInQuote : Number.NaN
  } else {
    return null
  }
  return Number.isFinite(price) && price > 0 ? price : null
}

/**
 * The USD price of one whole of each of `tokens` on chain `chainId`, from the pair with the most liquidity that has
 * the token as its base or its quote (the first listed, when two are as deep). The map is filed under the address as
 * the caller wrote it. It is empty, with no request made, on a testnet and for no tokens. It rejects when DexScreener
 * does not answer well, so that no answer is not taken for no prices.
 */
export async function usdPrices(
  chainId: number,
  tokens: readonly Address[],
  { signal, fetch: fetcher = fetch }: PriceOptions = {},
): Promise<Map<Address, number>> {
  const chain = DEXSCREENER_CHAIN[chainId]
  const wanted = [...new Set(tokens.map(token => token.toLowerCase()))]
  const best = new Map<string, Best>()
  if (!chain) return new Map()

  for (let start = 0; start < wanted.length; start += ADDRESSES_PER_REQUEST) {
    const addresses = wanted.slice(start, start + ADDRESSES_PER_REQUEST)
    const pairs = await withTimeout(TIMEOUT_MS, signal, async timed => {
      const response = await fetcher(`${ENDPOINT}/${chain}/${addresses.join(',')}`, { signal: timed })
      if (!response.ok) throw new Error(`price request failed (${response.status})`)
      const body: unknown = await response.json()
      if (!Array.isArray(body)) throw new Error('price response was not a list')
      return body as (Pair | null)[]
    })

    for (const address of addresses) {
      for (const pair of pairs) {
        const price = priceIn(pair, address)
        const depth = Number(pair?.liquidity?.usd)
        const liquidity = Number.isFinite(depth) ? depth : 0
        const current = best.get(address)
        if (price !== null && (!current || liquidity > current.liquidity)) {
          best.set(address, { price, liquidity })
        }
      }
    }
  }

  const prices = new Map<Address, number>()
  for (const token of tokens) {
    const found = best.get(token.toLowerCase())
    if (found) prices.set(token, found.price)
  }
  return prices
}
