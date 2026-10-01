'use client'

import { useSyncExternalStore } from 'react'
import type { Hex } from 'viem'
import type { Config } from 'wagmi'
import { getAccount, getPublicClient } from 'wagmi/actions'
import {
  isSafeWalletPeer,
  waitForSafeExecutionHash as waitForExecution,
} from '@bananapus/nana-sdk-core/safe-service'
import {
  getWalletConnectPeerUrl,
  getWatchedConfig,
  subscribeWalletConnectPeer,
} from '@/lib/safe-wallet-peer'

export {
  SAFE_NONCE_GUIDANCE,
  SAFE_PREFIX,
  SAFE_SERVICE_PREFIX,
  safeServiceBase,
  swapDeadline,
} from '@bananapus/nana-sdk-core/safe-service'

/**
 * Whether the connected wallet proposes to a Safe rather than sending: the
 * Safe app, or Safe{Wallet} over WalletConnect, which answers the same way.
 */
export function isSafeConnection(config: Config): boolean {
  try {
    const id = getAccount(config).connector?.id
    return (
      id === 'safe' ||
      (id === 'walletConnect' && isSafeWalletPeer(getWalletConnectPeerUrl()))
    )
  } catch {
    return false
  }
}

/** isSafeConnection for rendering: it renders again once the WalletConnect peer is known. */
export function useSafeConnection(config: Config): boolean {
  return useSyncExternalStore(
    subscribeWalletConnectPeer,
    () => isSafeConnection(config),
    () => false,
  )
}

/** ExecutionFailure(bytes32,uint256), the same topic in Safe 1.3 and 1.4. */
const SAFE_EXECUTION_FAILURE_TOPIC =
  '0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23'

/**
 * Whether a Safe execution's receipt shows `safe` failing the proposal. A Safe
 * signed with a nonzero safeTxGas or gasPrice logs ExecutionFailure instead of
 * reverting, so the receipt itself reads success. `proposalHash` is what the
 * wallet returned: the safeTxHash, or, when Safe{Wallet} executed at once,
 * this execution's own hash. A receipt can execute several of the Safe's
 * transactions, so a safeTxHash must match the failure's own.
 */
export function safeExecutionFailed(
  receipt: {
    transactionHash: Hex
    logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[]
  },
  safe: string,
  proposalHash: Hex,
): boolean {
  const safeTxHash =
    receipt.transactionHash.toLowerCase() === proposalHash.toLowerCase()
      ? null
      : proposalHash.toLowerCase()
  return receipt.logs.some(log => {
    if (
      log.address.toLowerCase() !== safe.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== SAFE_EXECUTION_FAILURE_TOPIC
    ) {
      return false
    }
    // Safe 1.4 indexes the safeTxHash; Safe 1.3 logs it as the first data word.
    const failed = log.topics.length > 1 ? log.topics[1] : `0x${log.data.slice(2, 66)}`
    return !safeTxHash || failed?.toLowerCase() === safeTxHash
  })
}

/**
 * The SDK's wait, reading the chain as well: Safe{Wallet} over WalletConnect
 * replies with the execution's own hash when the owner executes at once. An
 * explicit `client` wins.
 */
export function waitForSafeExecutionHash(
  chainId: number,
  safeTxHash: Hex,
  options: NonNullable<Parameters<typeof waitForExecution>[2]> = {},
): Promise<Hex> {
  const config = getWatchedConfig()
  return waitForExecution(chainId, safeTxHash, {
    ...options,
    client: options.client ?? (config && getPublicClient(config, { chainId })),
  })
}
