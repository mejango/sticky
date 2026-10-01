'use client'

import type { Config, Connector } from 'wagmi'
import { getAccount, watchAccount } from 'wagmi/actions'

type WalletConnectProvider = { session?: { peer?: { metadata?: { url?: string } } } }

// Kept apart from safe-connector: the root layout mounts this watcher, and the
// Safe service code that module carries would otherwise load on every page.
let watchedConfig: Config | undefined
let peerUrl: string | undefined
/** Counts session reads, so a slower read of an earlier connection never overwrites a newer answer. */
let reads = 0
const listeners = new Set<() => void>()

/** The config watchSafeWalletPeer follows, once the app has mounted it. */
export function getWatchedConfig(): Config | undefined {
  return watchedConfig
}

/** The connected WalletConnect peer's URL; undefined for any other wallet. */
export function getWalletConnectPeerUrl(): string | undefined {
  return peerUrl
}

/** Calls `listener` after each read of the connected wallet's peer. Returns the unsubscribe. */
export function subscribeWalletConnectPeer(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Follows the connected wallet and records its WalletConnect peer, the only
 * thing that tells Safe{Wallet} apart from other WalletConnect wallets. The
 * previous peer stands while a session is read again, so a decision made
 * during the read (gas 0) matches the one made before it. Returns the unwatch.
 */
export function watchSafeWalletPeer(config: Config): () => void {
  watchedConfig = config
  const check = async (connector: Connector | undefined) => {
    const read = ++reads
    let url: string | undefined
    if (connector?.id === 'walletConnect') {
      try {
        const provider = (await connector.getProvider()) as WalletConnectProvider | undefined
        url = provider?.session?.peer?.metadata?.url
      } catch {
        // A session that cannot be read is not known to be Safe{Wallet}.
      }
    }
    if (read !== reads) return
    peerUrl = url
    for (const listener of listeners) listener()
  }
  void check(getAccount(config).connector)
  return watchAccount(config, { onChange: account => void check(account.connector) })
}
