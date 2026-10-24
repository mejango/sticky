'use client'

import {
  getAccount,
  getPublicClient,
  getWalletClient,
  switchChain,
} from '@wagmi/core'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import { ReviewLineError, type WalletAdapter, type ReviewedSendDeps } from '@bananapus/nana-sdk-core/review'
import type { Address, PublicClient } from 'viem'
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

/** Only this app's proven pre-invocation refusals may release an SDK write hold. */
class WalletNotInvokedError extends ReviewLineError {
  readonly walletNotInvoked = true
  readonly code: number | undefined
  constructor(message: string, releaseHold: boolean, readonly acquisitionCause?: unknown) {
    super(message)
    this.code = releaseHold ? 4001 : undefined
  }
}

/** After SDK cleanup, retain the refusal line without misclassifying it as a wallet cancellation. */
export function readableWalletFailure(error: unknown): never {
  if (error instanceof WalletNotInvokedError && error.code === 4001) {
    throw Object.assign(new ReviewLineError(error.message), { acquisitionCause: error })
  }
  throw error
}

/** Acquire the current connector, then check and invoke in the same continuation. */
async function withCurrentWallet<T>(chainId: number | undefined,
  invoke: (wallet: Awaited<ReturnType<typeof getWalletClient>>, account: Address) => Promise<T>,
  releaseHold = false,
  finalGuard?: () => void,
): Promise<T> {
  const notSent = (message: string, cause?: unknown) => new WalletNotInvokedError(message, releaseHold, cause)
  const reviewed = getAccount(wagmiConfig)
  if (!reviewed.address) throw notSent('Connect a wallet first.')
  const account = reviewed.address
  const chain = chainId ?? reviewed.chainId
  const safe = isSafeConnection(wagmiConfig)
  const unchanged = () => {
    try { assertNoViewAs(); finalGuard?.() } catch (error) {
      throw notSent(error instanceof Error ? error.message : 'The reviewed action changed. Review again.', error)
    }
    const current = getAccount(wagmiConfig)
    if (current.address?.toLowerCase() !== account.toLowerCase()) {
      throw notSent('The connected account changed. Review again.')
    }
    if (chain === undefined || current.chainId !== chain || isSafeConnection(wagmiConfig) !== safe || !current.connector?.uid) {
      throw notSent('Wallet connection changed. Review the transaction again.')
    }
    return current.connector
  }
  // ponytail: three acquisitions; a continuously changing connector needs another review.
  for (let attempt = 0; attempt < 3; attempt++) {
    const connector = unchanged()
    let wallet: Awaited<ReturnType<typeof getWalletClient>>
    try {
      wallet = await getWalletClient(wagmiConfig, { account, connector, chainId: chain as JBChainId })
    } catch (error) {
      if (unchanged().uid !== connector.uid) continue
      throw notSent('Your wallet connection could not be confirmed. Review again.', error)
    }
    if (unchanged().uid !== connector.uid) continue
    // No await or callback separates the final checks from the actual wallet method.
    return invoke(wallet, account)
  }
  throw notSent('Wallet connection changed. Review the transaction again.')
}

/** Sticky owns the final invocation; returning a client to an awaiting adapter can make it stale again. */
export function createWalletAdapter(finalGuard?: () => void): WalletAdapter {
  return {
    kind: 'wallet',
    account: () => getAccount(wagmiConfig).address,
    chainId: () => getAccount(wagmiConfig).chainId,
    isSafe: () => isSafeConnection(wagmiConfig),
    switchChain: switchTo,
    sendTransaction: ({ chainId, ...tx }) => withCurrentWallet(chainId, (wallet, account) =>
      wallet.sendTransaction({ ...tx, account, chain: wallet.chain?.id === chainId ? wallet.chain : { id: chainId } }), true, finalGuard),
    signTypedData: typedData => withCurrentWallet(typedData.domain?.chainId === undefined ? undefined : Number(typedData.domain.chainId),
      (wallet, account) => wallet.signTypedData({ ...typedData, account }), false, finalGuard),
    signMessage: message => withCurrentWallet(undefined, (wallet, account) => wallet.signMessage({ account, message }), false, finalGuard),
    sendCalls: (chainId, calls) => withCurrentWallet(chainId, (wallet, account) =>
      wallet.sendCalls({ account, chain: wallet.chain?.id === chainId ? wallet.chain : { id: chainId }, calls: calls.map(({ to, data, value }) => ({ to, data, value })) }).then((result: { id: string }) => result.id), true, finalGuard),
  }
}

export const walletAdapter = createWalletAdapter()

/** What every reviewed send of Sticky goes through: its wallet, each chain's client, and the app's one write hold. */
export const reviewedSendDeps: ReviewedSendDeps = {
  adapter: walletAdapter,
  clientFor: chainId => publicClient(chainId as JBChainId),
  hold: holds,
}
