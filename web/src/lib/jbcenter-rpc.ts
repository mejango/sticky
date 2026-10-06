import {
  createJBCenterClient,
  createJBCenterLimiter,
  type JBCenterRpcRequest,
} from '@bananapus/nana-sdk-core/jbcenter'
import { createPublicClient, custom, hexToBigInt, http, type PublicClient, type Transport } from 'viem'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { jbCenterAppOrigin, jbCenterBaseUrl } from '@/lib/jbcenter-config'
import { sleep } from '@/lib/with-timeout'

/** JB Center load balances reads across RPC nodes that import blocks at
 * slightly different times. A read pinned to a block one node has already
 * imported can land on a sibling that has not, and the sibling answers
 * JSON-RPC -32001 — which viem renders as "Requested resource not found."
 * Waiting out the lag is the only correct answer: falling back to `latest`
 * would read state older than the approval the pinned block exists to
 * observe. Base mines every two seconds, so this schedule covers a few
 * blocks of drift. */
const BLOCK_LAG_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 2_000]

function isBehindHead(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === -32001
  )
}

/** A provider as viem's custom transport asks it: a request, and the signal of
 * the read that makes it, when it has one. */
type CenterProvider = {
  request(
    request: { method: string; params?: readonly unknown[] },
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
}

/** Retries reads that a lagging node cannot answer yet. Every method JB Center
 * allows is a read, so a retry can only repeat work, never repeat an effect.
 * The read's signal goes with every try, and a wait between tries ends the
 * moment it aborts. */
export function retryWhileBehindHead(
  provider: CenterProvider,
  delaysMs: readonly number[] = BLOCK_LAG_RETRY_DELAYS_MS,
): CenterProvider {
  return {
    async request(request, options) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await provider.request(request, options)
        } catch (error) {
          if (attempt >= delaysMs.length || !isBehindHead(error)) throw error
          await sleep(delaysMs[attempt], options?.signal)
        }
      }
    },
  }
}

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

const inBrowser = () => typeof window !== 'undefined'

/** Center's slots: the tab's requests to Center, every chain's and every
 * reader's together. Center counts each origin's requests, refused ones too,
 * in a fixed minute: 600 a minute for this site's origins, and a 429 whose
 * Retry-After says how long is left past that. Two in flight is what one log
 * scan of the hook always kept (`hook-logs.ts`), so reads that run side by
 * side ask no more of Center at once than one scan did, at most 343 requests a
 * minute at the quickest round trip staging measured (0.35 s). After a 429
 * with a Retry-After, none starts until it has passed, a minute at most. */
const centerLimiter = createJBCenterLimiter({ slots: 2 })

/** Center's RPC for `chainId`. In the browser, every request to Center, from
 * every chain's reader of the tab (the page's, wagmi's, the fee check's and the
 * Center wallet's), waits for one of Center's slots (`centerLimiter`), so the
 * reads of a page can run side by side within its one rate limit. Each try
 * takes its own slot, so one waiting out a node behind the head holds none, and
 * a request whose read is dropped stops and lets its slot go. */
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
  const center = createJBCenterClient({
    baseUrl: jbCenterBaseUrl(),
    fetch: browser ? browserFetch : serverFetch,
    timeoutMs,
  })
  // The SDK's `rpcProvider` drops the signal viem hands a request; `rpc` takes
  // it, so a read that is dropped stops its request and lets go of its slot.
  const ask: CenterProvider['request'] = (request, options) =>
    center.rpc(chainId, request as JBCenterRpcRequest, { signal: options?.signal })
  // Each try waits for a slot, and leaves the line unsent when its signal aborts.
  const send: CenterProvider['request'] = browser
    ? (request, options) => centerLimiter.run(() => ask(request, options), { signal: options?.signal })
    : ask
  return custom(retryWhileBehindHead({ request: send }), {
    retryCount: 1,
  })
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
 * has in flight stops and what waits for one of Center's slots is never sent.
 * A read viem can share with another page's (a `readContract` it batches, a
 * receipt or a block by its number) stays on the shared reader, so that one
 * page's signal neither splits the request nor stops the other page's read
 * (`test/page-signals.test.ts`); `freshHead` shares the head. A page's reader
 * reads its head afresh each time, sharing a request already under way: viem's
 * own `getBlockNumber` keeps every reader's last head for good, by the reader's
 * id, and a page's reader is made for each read of the page. A try waits 15 s,
 * as every other reader of the tab's does: two of a page's reads hold both of
 * Center's slots, a write's review and receipt reads included, for no longer.
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
