import { createPublicClient, hexToBigInt, type PublicClient, type Transport } from 'viem'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'

// The Center reader pages use, apart from the transport the root layout's wallet config needs, so the shell does not
// load viem's public client actions.

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
