import {
  createJBCenterClient,
  type JBCenterRpcRequest,
} from '@bananapus/nana-sdk-core/jbcenter'
import { createPublicClient, custom, http, type PublicClient, type Transport } from 'viem'
import { inCenterSlots, throughCenterSlots } from '@/lib/center-limit'
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

/** Center's RPC for `chainId`. In the browser, every request to Center, from
 * every chain's reader of the tab (the page's, wagmi's, the fee check's and the
 * Center wallet's), waits for one of Center's slots (`center-limit.ts`), so the
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
    return inBrowser() ? throughCenterSlots(fixture) : fixture
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
  return custom(retryWhileBehindHead({ request: browser ? inCenterSlots(ask) : ask }), {
    retryCount: 1,
  })
}

const publicClients = new Map<number, PublicClient>()

/** One cached Center reader per chain. Multicall batching needs the chain's
 * multicall3 address; without `chain` viem quietly sends every read on its own,
 * and those bursts hit the one rate limit Center applies across all chains. */
export function jbCenterPublicClient(chainId: number): PublicClient {
  let client = publicClients.get(chainId)
  if (!client) {
    client = createPublicClient({
      chain: SUPPORTED_CHAINS.find(chain => chain.id === chainId),
      transport: jbCenterRpcTransport(chainId, 60_000),
      batch: { multicall: true },
    }) as PublicClient
    publicClients.set(chainId, client)
  }
  return client
}
