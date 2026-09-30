import { getAddress, type Address } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usdPrices } from '@/lib/sticky-prices'

const BASE = 8453
const BASE_SEPOLIA = 84532
const token = (digit: string) => `0x${digit.repeat(40)}` as Address
const TOKEN = token('a')
const OTHER = token('b')
const USDC = token('c')
const WETH = token('d')

type Side = { address: string }
type Pair = {
  baseToken: Side
  quoteToken: Side
  priceUsd?: string | null
  priceNative?: string | null
  liquidity?: { usd?: number }
}

/** A DexScreener pair as `/tokens/v1/{chain}/{addresses}` lists it: `base` priced in USD and in `quote`. */
const pair = (
  base: string,
  quote: string,
  priceUsd: string | null | undefined,
  priceNative: string | null | undefined,
  liquidity?: number,
): Pair => ({
  baseToken: { address: base },
  quoteToken: { address: quote },
  priceUsd,
  priceNative,
  ...(liquidity === undefined ? {} : { liquidity: { usd: liquidity } }),
})

/** A DexScreener that answers each request with the next reply, and remembers what it was asked. */
function dexscreener(...replies: (Pair[] | Response)[]) {
  const asked: string[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push(String(input))
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const reply = replies[Math.min(asked.length - 1, replies.length - 1)]
    return reply instanceof Response ? reply : new Response(JSON.stringify(reply), { status: 200 })
  })
  return { fetcher: fetcher as unknown as typeof fetch, asked }
}

afterEach(() => vi.useRealTimers())

describe('usdPrices', () => {
  it('asks DexScreener for the chain and the addresses, each once and in lower case', async () => {
    const { fetcher, asked } = dexscreener([])
    await usdPrices(BASE, [TOKEN, OTHER, getAddress(TOKEN)], { fetch: fetcher })
    expect(asked).toEqual([`https://api.dexscreener.com/tokens/v1/base/${TOKEN},${OTHER}`])
  })

  it.each([
    [1, 'ethereum'],
    [10, 'optimism'],
    [8453, 'base'],
    [42161, 'arbitrum'],
  ])('reads chain %s as DexScreener\'s %s', async (chainId, name) => {
    const { fetcher, asked } = dexscreener([])
    await usdPrices(chainId, [TOKEN], { fetch: fetcher })
    expect(asked).toEqual([`https://api.dexscreener.com/tokens/v1/${name}/${TOKEN}`])
  })

  it('prices a token that is the base of a pair at that pair\'s USD price', async () => {
    const { fetcher } = dexscreener([pair(TOKEN, USDC, '2.5', '2.5', 1_000)])
    expect(await usdPrices(BASE, [TOKEN], { fetch: fetcher })).toEqual(new Map([[TOKEN, 2.5]]))
  })

  it('prices a token that is the quote of a pair at the base\'s USD price over its price in the quote', async () => {
    // One WETH is 4,000 USD and 4,000 of the token: the token is worth 1 USD.
    const { fetcher } = dexscreener([pair(WETH, TOKEN, '4000', '4000', 1_000)])
    expect(await usdPrices(BASE, [TOKEN], { fetch: fetcher })).toEqual(new Map([[TOKEN, 1]]))
    // One base is 2 USD and 8 of the token: the token is worth a quarter of a dollar.
    const quarter = dexscreener([pair(USDC, TOKEN, '2', '8', 1_000)])
    expect(await usdPrices(BASE, [TOKEN], { fetch: quarter.fetcher })).toEqual(new Map([[TOKEN, 0.25]]))
  })

  it('takes the pair with the most liquidity, whichever side the token is on and wherever the pair is listed', async () => {
    const asBase = pair(TOKEN, USDC, '1', '1', 10_000)
    const asQuote = pair(WETH, TOKEN, '4000', '2000', 90_000) // 2 USD
    const thin = pair(TOKEN, WETH, '9', '9', 100)
    for (const pairs of [
      [asBase, asQuote, thin],
      [thin, asQuote, asBase],
      [asQuote, thin, asBase],
    ]) {
      const { fetcher } = dexscreener(pairs)
      expect(await usdPrices(BASE, [TOKEN], { fetch: fetcher })).toEqual(new Map([[TOKEN, 2]]))
    }
    // A deeper pair wins as readily when the token is its base.
    const deeper = dexscreener([asQuote, pair(TOKEN, USDC, '1', '1', 95_000)])
    expect(await usdPrices(BASE, [TOKEN], { fetch: deeper.fetcher })).toEqual(new Map([[TOKEN, 1]]))
  })

  it('keeps the first pair listed when two are equally liquid, and reads a pair without liquidity as none', async () => {
    const tied = dexscreener([pair(TOKEN, USDC, '3', '3', 500), pair(TOKEN, WETH, '5', '5', 500)])
    expect(await usdPrices(BASE, [TOKEN], { fetch: tied.fetcher })).toEqual(new Map([[TOKEN, 3]]))
    const unlisted = dexscreener([pair(TOKEN, USDC, '3', '3'), pair(TOKEN, WETH, '5', '5', 1)])
    expect(await usdPrices(BASE, [TOKEN], { fetch: unlisted.fetcher })).toEqual(new Map([[TOKEN, 5]]))
    const alone = dexscreener([pair(TOKEN, USDC, '3', '3')])
    expect(await usdPrices(BASE, [TOKEN], { fetch: alone.fetcher })).toEqual(new Map([[TOKEN, 3]]))
  })

  it('leaves a token without a usable price out, and never prices it at zero', async () => {
    const { fetcher } = dexscreener([
      pair(TOKEN, USDC, '0', '0', 9_000),
      pair(TOKEN, WETH, null, '1', 9_000),
      pair(TOKEN, USDC, 'not a number', '1', 9_000),
      pair(TOKEN, USDC, 'Infinity', '1', 9_000),
      pair(WETH, TOKEN, '4000', '0', 9_000), // a quote price cannot be worked out from a zero rate
      pair(WETH, TOKEN, '4000', null, 9_000),
      pair(WETH, TOKEN, undefined, '2', 9_000),
      pair(WETH, TOKEN, '-4000', '-2', 9_000), // two negatives are no price either
      pair(TOKEN, USDC, '-3', '-3', 9_000),
      pair(USDC, OTHER, '1', '1', 9_000),
    ])
    expect(await usdPrices(BASE, [TOKEN, OTHER], { fetch: fetcher })).toEqual(new Map([[OTHER, 1]]))
  })

  it('prices the tokens of one request independently, and matches an address in any letter case', async () => {
    const checksummed = getAddress(TOKEN)
    const { fetcher } = dexscreener([
      pair(checksummed, USDC, '7', '7', 1_000),
      pair(getAddress(USDC), OTHER, '1', '0.5', 2_000), // OTHER is quoted: 1 / 0.5
    ])
    const prices = await usdPrices(BASE, [TOKEN, OTHER, WETH], { fetch: fetcher })
    expect(prices).toEqual(new Map([[TOKEN, 7], [OTHER, 2]]))
  })

  it('files a price under each spelling of an address the caller wrote', async () => {
    const checksummed = getAddress(TOKEN)
    const { fetcher } = dexscreener([pair(TOKEN, USDC, '7', '7', 1_000)])
    const prices = await usdPrices(BASE, [checksummed, TOKEN], { fetch: fetcher })
    expect(prices.get(checksummed)).toBe(7)
    expect(prices.get(TOKEN)).toBe(7)
    expect(prices.size).toBe(2)
  })

  it('has no prices on a testnet, or on a chain DexScreener is not asked about, and asks nothing', async () => {
    const { fetcher } = dexscreener([pair(TOKEN, USDC, '7', '7', 1_000)])
    for (const chainId of [BASE_SEPOLIA, 11155111, 11155420, 421614, 137]) {
      expect(await usdPrices(chainId, [TOKEN], { fetch: fetcher })).toEqual(new Map())
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('has no prices for no tokens, and asks nothing', async () => {
    const { fetcher } = dexscreener([])
    expect(await usdPrices(BASE, [], { fetch: fetcher })).toEqual(new Map())
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('asks for at most 30 addresses at a time, one request after another', async () => {
    const many = Array.from({ length: 65 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}` as Address)
    let running = 0
    let overlapped = false
    const asked: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      asked.push(String(input))
      running += 1
      overlapped ||= running > 1
      await Promise.resolve()
      running -= 1
      return new Response(JSON.stringify([pair(many[64], USDC, '3', '3', 1)]), { status: 200 })
    }) as unknown as typeof fetch

    const prices = await usdPrices(BASE, many, { fetch: fetcher })

    expect(asked.map(url => url.split('/').at(-1)!.split(',').length)).toEqual([30, 30, 5])
    expect(overlapped).toBe(false)
    expect(asked.join(',').split(/[/,]/).filter(part => part.startsWith('0x'))).toEqual(many)
    expect(prices.get(many[64])).toBe(3)
  })

  it('merges the prices of every request', async () => {
    const many = Array.from({ length: 31 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}` as Address)
    const { fetcher } = dexscreener([pair(many[0], USDC, '1', '1', 10)], [pair(many[30], USDC, '2', '2', 10)])
    const prices = await usdPrices(BASE, many, { fetch: fetcher })
    expect(prices).toEqual(new Map([[many[0], 1], [many[30], 2]]))
  })

  it('rejects when DexScreener does not answer well, rather than reporting no prices', async () => {
    await expect(
      usdPrices(BASE, [TOKEN], { fetch: dexscreener(new Response('busy', { status: 429 })).fetcher }),
    ).rejects.toThrow('price request failed (429)')
    await expect(
      usdPrices(BASE, [TOKEN], { fetch: dexscreener(new Response('{"pairs":[]}', { status: 200 })).fetcher }),
    ).rejects.toThrow('price response was not a list')
    await expect(
      usdPrices(BASE, [TOKEN], { fetch: dexscreener(new Response('<html>', { status: 200 })).fetcher }),
    ).rejects.toThrow()
    await expect(
      usdPrices(BASE, [TOKEN], { fetch: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as never }),
    ).rejects.toThrow('Failed to fetch')
  })

  it('skips a listing that is not a pair, and reads the rest', async () => {
    const { fetcher } = dexscreener([null, 'x', 3, {}, { baseToken: null, quoteToken: 5 }, pair(TOKEN, USDC, '4', '4', 1)] as never)
    expect(await usdPrices(BASE, [TOKEN], { fetch: fetcher })).toEqual(new Map([[TOKEN, 4]]))
  })

  it('gives up on a request that takes longer than five seconds', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      }),
    ) as unknown as typeof fetch
    const outcome = usdPrices(BASE, [TOKEN], { fetch: fetcher }).then(
      () => 'answered',
      (error: { name: string }) => error.name,
    )
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe('TimeoutError')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops asking when the caller does', async () => {
    const caller = new AbortController()
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      }),
    ) as unknown as typeof fetch
    const outcome = usdPrices(BASE, [TOKEN], { fetch: fetcher, signal: caller.signal })
    caller.abort(new Error('left the page'))
    await expect(outcome).rejects.toThrow('left the page')
  })
})
