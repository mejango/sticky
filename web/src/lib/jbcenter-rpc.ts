import {
  createJBCenterRpcProvider,
  createPacedJBCenterLimiter,
} from '@bananapus/nana-sdk-core/jbcenter'
import { custom, http, type Transport } from 'viem'
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
