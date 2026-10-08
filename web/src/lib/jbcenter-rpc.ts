import {
  createJBCenterRpcProvider,
  createPacedJBCenterLimiter,
} from '@bananapus/nana-sdk-core/jbcenter'
import { createPublicClient, custom, hexToBigInt, http, type PublicClient, type Transport } from 'viem'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { jbCenterAppOrigin, jbCenterBaseUrl } from '@/lib/jbcenter-config'

const FIXTURE_NETWORKS: Record<number, string> = {
  1: 'mainnet',
  10: 'optimism-mainnet',
  8453: 'base-mainnet',
  42161: 'arbitrum-mainnet',
  11155111: 'sepolia',
  11155420: 'optimism-sepolia',
  84532: 'base-sepolia',
  421614: 'arbitrum-sepolia',
}

const serverFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set('Origin', jbCenterAppOrigin())
  return fetch(input, { ...init, headers })
}

const browserFetch: typeof fetch = (input, init) => window.fetch(input, init)
// Admit starts before the provider starts its timeout, including a shared 429 cooldown.
const centerLimiter = createPacedJBCenterLimiter()

const inBrowser = () => typeof window !== 'undefined'

/** Center's RPC for `chainId`. Center load balances reads across nodes that
 * import blocks at slightly different times, so a read pinned to a block one
 * node has imported can land on one that has not, which answers JSON-RPC
 * -32001 ("Requested resource not found." in viem). The SDK's provider asks
 * again after 250, 500, 1,000, 2,000 and 2,000 ms: reading `latest` instead
 * would read state older than the block the read pins. The read's signal goes
 * with every try, and a wait between tries ends the moment it aborts. In the
 * browser, every request to Center, from every chain's reader of the tab (the
 * page's, wagmi's, the fee check's and the Center wallet's), shares the SDK's
 * request-start pacing. Slow responses do not hold up other chains, every
 * retry is paced, and a 429's Retry-After pauses new starts across the tab.
 * A page's abort cancels its queued and in-flight requests. */
export function jbCenterRpcTransport(
  chainId: number,
  timeoutMs = 15_000,
): Transport {
  if (process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true') {
    const network = FIXTURE_NETWORKS[chainId]
    const origin =
      process.env.NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN ??
      'http://127.0.0.1:4399'
    const fixture = network ? http(`${origin}/rpc/${network}`) : http()
    return inBrowser() ? centerLimiter.transport(fixture) : fixture
  }
  const browser = inBrowser()
  return custom(
    createJBCenterRpcProvider(chainId, {
      baseUrl: jbCenterBaseUrl(),
      fetch: browser ? browserFetch : serverFetch,
      timeoutMs,
      limiter: browser ? centerLimiter : undefined,
    }),
    { retryCount: 1 },
  )
}

/** `transport`, with `signal` on every request made without one of its own. */
const withSignal =
  (transport: Transport, signal: AbortSignal): Transport =>
  parameters => {
    const built = transport(parameters)
    const request = ((args, options) =>
      built.request(args, { ...options, signal: options?.signal ?? signal })) as typeof built.request
    return { ...built, request }
  }

const publicClients = new Map<number, PublicClient>()
const pageReaders = new WeakMap<AbortSignal, Map<number, PublicClient>>()

/** One cached Center reader per chain, and one per chain for each page signal
 * it is asked with. Multicall batching needs the chain's multicall3 address;
 * without `chain` viem quietly sends every read on its own, and those bursts
 * hit the one rate limit Center applies across all chains. A page's reader
 * sends every request with the page's signal, so when the page is left, what it
 * has in flight stops and what waits for its paced start is never sent.
 * A read viem can share with another page's (a `readContract` it batches, a
 * receipt or a block by its number) stays on the shared reader, so that one
 * page's signal neither splits the request nor stops the other page's read
 * (`test/page-signals.test.ts`); `freshHead` shares the head. A page's reader
 * reads its head afresh each time, sharing a request already under way: viem's
 * own `getBlockNumber` keeps every reader's last head for good, by the reader's
 * id, and a page's reader is made for each read of the page. A try waits 15 s,
 * as every other reader of the tab's does, independently of the other reads.
 * The slowest of the 3,261 requests measured against staging took 6.0 s. */
export function jbCenterPublicClient(chainId: number, signal?: AbortSignal): PublicClient {
  let clients = publicClients
  if (signal) {
    clients = pageReaders.get(signal) ?? new Map()
    pageReaders.set(signal, clients)
  }
  let client = clients.get(chainId)
  if (!client) {
    const transport = jbCenterRpcTransport(chainId)
    client = createPublicClient({
      chain: SUPPORTED_CHAINS.find(chain => chain.id === chainId),
      transport: signal ? withSignal(transport, signal) : transport,
      batch: { multicall: true },
    }) as PublicClient
    if (signal) {
      client = client.extend(reader => ({
        getBlockNumber: async () =>
          hexToBigInt(await reader.request({ method: 'eth_blockNumber' }, { dedupe: true, signal })),
      })) as PublicClient
    }
    clients.set(chainId, client)
  }
  return client
}
