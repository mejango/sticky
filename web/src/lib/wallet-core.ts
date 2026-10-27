'use client'

import {
  getAccount,
  getPublicClient,
  getWalletClient,
  switchChain,
} from '@wagmi/core'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { ReviewLineError, viemWalletAdapter, type WalletAdapter, type ReviewedSendDeps } from '@bananapus/nana-sdk-core/review'
import type { PublicClient, WalletClient } from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import { chainName } from '@/lib/urn'
import { isSafeConnection } from '@/lib/safe-connector'
import { holds } from '@/lib/write-holds'
import { assertNoViewAs } from '@/lib/viewAs'

/**
 * Shared wagmi identity plumbing for transaction and signature boundaries.
 * Product journals and execution policy remain in their owning adapters.
 */

export function publicClient(chainId: JBChainId): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId })
  if (!client) throw new Error(`No RPC client is configured for chain ${chainId}.`)
  return client as PublicClient
}

/** Switches the wallet to `chainId`. A Safe app cannot switch: it is told which chain to open on. */
async function switchTo(chainId: number): Promise<void> {
  await switchChain(wagmiConfig, { chainId: chainId as JBChainId }).catch(error => {
    // Safe apps cannot switch chains; the wagmi error only names the connector.
    throw /does not support chain switching/.test(String(error))
      ? new ReviewLineError(`This wallet cannot switch chains. Open it on ${chainName(chainId)} and try again.`)
      : error
  })
}

/** Core's wallet adapter over the connected wagmi connector, checked again as each request reaches the wallet. */
export function createWalletAdapter(finalGuard?: () => void): WalletAdapter {
  return viemWalletAdapter({
    walletClient: () => {
      const { address, chainId, connector } = getAccount(wagmiConfig)
      return getWalletClient(wagmiConfig, { account: address, chainId: chainId as JBChainId, connector }) as Promise<WalletClient>
    },
    account: () => getAccount(wagmiConfig).address,
    chainId: () => getAccount(wagmiConfig).chainId,
    isSafe: () => isSafeConnection(wagmiConfig),
    switchChain: switchTo,
    connector: () => getAccount(wagmiConfig).connector?.uid,
    check: () => {
      assertNoViewAs()
      finalGuard?.()
    },
  })
}

export const walletAdapter = createWalletAdapter()

/** What every reviewed send of Sticky goes through: its wallet, each chain's client, and the app's one write hold. */
export const reviewedSendDeps: ReviewedSendDeps = {
  adapter: walletAdapter,
  clientFor: chainId => publicClient(chainId as JBChainId),
  hold: holds,
}
