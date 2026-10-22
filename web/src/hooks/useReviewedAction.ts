'use client'

import { getAccount, getPublicClient, getWalletClient, switchChain } from '@wagmi/core'
import { viemWalletAdapter } from '@bananapus/nana-sdk-core/review'
import { useReviewedRun } from '@bananapus/nana-sdk-core/review/react'
import type { PublicClient } from 'viem'
import { useWallet } from '@/hooks/useWallet'
import { isSafeConnection } from '@/lib/safe-connector'
import { getViewAs, VIEW_AS_WRITE_BLOCKED } from '@/lib/viewAs'
import { holds } from '@/lib/write-holds'
import { wagmiConfig } from '@/providers/Providers'
import { EXTERNAL_WALLET_REQUIRED } from '@/providers/WalletAuthContext'

/** Mirrors @bananapus/nana-sdk-core/review/react useReviewedRun: Sticky's wallet, chains, write hold and guard. The Signa
 * connector signs in only, so its writes are refused here until it sends through its own reviewer. */
export function useReviewedAction(): ReturnType<typeof useReviewedRun> {
  const { address, isCenterWallet } = useWallet()
  return useReviewedRun({
    account: address,
    adapter: viemWalletAdapter({
      walletClient: () => getWalletClient(wagmiConfig),
      account: () => getAccount(wagmiConfig).address,
      chainId: () => getAccount(wagmiConfig).chainId,
      isSafe: () => isSafeConnection(wagmiConfig),
      switchChain: chainId => switchChain(wagmiConfig, { chainId: chainId as never }),
    }),
    clientFor: chainId => getPublicClient(wagmiConfig, { chainId: chainId as never }) as PublicClient,
    hold: holds,
    guard: () => {
      if (isCenterWallet) throw new Error(EXTERNAL_WALLET_REQUIRED)
      if (getViewAs()) throw new Error(VIEW_AS_WRITE_BLOCKED)
    },
  })
}
