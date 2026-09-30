import { mainnet } from '@bananapus/nana-sdk-core/chains'
import { createPublicClient, http, isAddress, type Address } from 'viem'
import { PRODUCTION_CHAINS } from '@/lib/chains'

/**
 * ENS names of accounts, cached. ENS lives on mainnet regardless of which chain a project is on. Handles, the
 * `/@name` routes, are resolved on the server in `sticky-handles.ts`; nothing here needs ENSIP-15 normalization,
 * which is left out of the browser.
 */

const ensClient = createPublicClient({
  chain: mainnet,
  // CORS-friendly public RPC (several big providers block browser origins).
  transport: http('https://ethereum-rpc.publicnode.com'),
  // No CCIP-Read. The resolver of a name is the account's own choice, and an off-chain lookup would send this
  // browser to a URL that account picked.
  ccipRead: false,
})
const IS_DETERMINISTIC_BROWSER =
  process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'

const nameCache = new Map<string, Promise<string | null>>()

/** Whether mainnet names describe the accounts of `chainId`: they do for a production chain, and not for a
 * testnet, where an address is not evidence of who holds the same one on mainnet. */
export function ensAvailable(chainId: number): boolean {
  return PRODUCTION_CHAINS.some(chain => chain.id === chainId)
}

/** An address's primary ENS name, cached with its misses and failures, or null when it has none, on a chain where
 * names are not read (see `ensAvailable`), or for something that is not an address. */
export function lookupEnsName(
  address: string,
  chainId: number,
): Promise<string | null> {
  const key = address.trim().toLowerCase()
  if (IS_DETERMINISTIC_BROWSER || !ensAvailable(chainId) || !isAddress(key)) {
    return Promise.resolve(null)
  }
  let name = nameCache.get(key)
  if (!name) {
    name = ensClient.getEnsName({ address: key as Address }).catch(() => null)
    nameCache.set(key, name)
  }
  return name
}
