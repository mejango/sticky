'use client'

import {
  getAccount,
  getPublicClient,
  getWalletClient,
  switchChain,
} from '@wagmi/core'
import type { JBChainId } from '@bananapus/nana-sdk-core'
import type { Address, PublicClient } from 'viem'
import { wagmiConfig } from '@/providers/Providers'
import { chainName } from '@/lib/urn'

/**
 * Shared wagmi plumbing for the transaction boundaries (relayr, safe). This
 * module must not import those files — it sits below both.
 */

export function publicClient(chainId: JBChainId): PublicClient {
  const client = getPublicClient(wagmiConfig, { chainId })
  if (!client) throw new Error(`No RPC client is configured for chain ${chainId}.`)
  return client as PublicClient
}

/**
 * The connected wallet client on `chainId`, switching chains when needed.
 * Throws `changedError` if the account is missing afterwards, differs from
 * `expected`, or (with `requireUnchanged`) differs from the account that was
 * connected before the switch.
 */
export async function connectedWallet(
  chainId: JBChainId,
  {
    expected,
    requireUnchanged = false,
    changedError,
  }: {
    expected?: Address
    requireUnchanged?: boolean
    changedError: string
  },
) {
  const before = getAccount(wagmiConfig)
  if (!before.address) throw new Error('Connect a wallet first.')
  if (before.chainId !== chainId) {
    await switchChain(wagmiConfig, { chainId }).catch(error => {
      // Safe apps cannot switch chains; the wagmi error only names the connector.
      throw /does not support chain switching/.test(String(error))
        ? new Error(`This wallet cannot switch chains. Open it on ${chainName(chainId)} and try again.`)
        : error
    })
  }
  const wallet = await getWalletClient(wagmiConfig, { chainId })
  const account = getAccount(wagmiConfig).address
  if (
    !account ||
    (requireUnchanged &&
      account.toLowerCase() !== before.address.toLowerCase()) ||
    (expected && account.toLowerCase() !== expected.toLowerCase())
  ) {
    throw new Error(changedError)
  }
  return { wallet, account }
}
