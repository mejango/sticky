import {
  createJBCenterRpcProvider,
  type JBCenterRpcProvider,
} from '@bananapus/nana-sdk-core/jbcenter'
import { createPublicClient, custom, http, type PublicClient, type Transport } from 'viem'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { jbCenterAppOrigin, jbCenterBaseUrl } from '@/lib/jbcenter-config'

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

/** Retries reads that a lagging node cannot answer yet. Every method JB Center
 * allows is a read, so a retry can only repeat work, never repeat an effect. */
export function retryWhileBehindHead(
  provider: JBCenterRpcProvider,
  delaysMs: readonly number[] = BLOCK_LAG_RETRY_DELAYS_MS,
): JBCenterRpcProvider {
  return {
    async request(request) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await provider.request(request)
        } catch (error) {
          if (attempt >= delaysMs.length || !isBehindHead(error)) throw error
          await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]))
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

export function jbCenterRpcTransport(
  chainId: number,
  timeoutMs = 15_000,
): Transport {
  if (process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true') {
    const network = FIXTURE_NETWORKS[chainId]
    const origin =
      process.env.NEXT_PUBLIC_BROWSER_FIXTURE_ORIGIN ??
      'http://127.0.0.1:4399'
    return network ? http(`${origin}/rpc/${network}`) : http()
  }
  return custom(
    retryWhileBehindHead(
      createJBCenterRpcProvider(chainId, {
        baseUrl: jbCenterBaseUrl(),
        fetch: typeof window === 'undefined' ? serverFetch : browserFetch,
        timeoutMs,
      }),
    ),
    { retryCount: 1 },
  )
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
