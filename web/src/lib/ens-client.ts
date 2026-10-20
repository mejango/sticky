import { mainnet } from '@bananapus/nana-sdk-core/chains'
import { createPublicClient, http } from 'viem'

/** The mainnet reader of ENS names. `ens.ts` imports it when a name is first looked up, so a page that shows no name
 * does not load viem's public client for it. */
export const ensClient = createPublicClient({
  chain: mainnet,
  // CORS-friendly public RPC (several big providers block browser origins).
  transport: http('https://ethereum-rpc.publicnode.com'),
  // No CCIP-Read. The resolver of a name is the account's own choice, and an off-chain lookup would send this
  // browser to a URL that account picked.
  ccipRead: false,
})
