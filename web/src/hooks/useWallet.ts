'use client'
import type { Address } from 'viem'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { IS_DETERMINISTIC_BROWSER } from '@/providers/Providers'
import { offerableWallets } from '@/lib/wallet-list'
import { useWalletAuth } from '@/providers/WalletAuthContext'

export function useWallet() {
  const { address, isConnected, connector } = useAccount()
  const { connectAsync, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const { requestSignIn } = useWalletAuth()
  return {
    isConnected, address: address as Address | undefined,
    isCenterWallet: connector?.id === 'juicebox-center',
    connectors: offerableWallets(connectors),
    connectWith: (connectorId: string) => {
      const selected = connectors.find(item => item.id === connectorId)
      return selected ? connectAsync({ connector: selected }) : Promise.reject(new Error('Unknown wallet'))
    },
    /** Opens the wallet chooser and resolves once it closes, connected or not. */
    openSignIn: (): Promise<void> => IS_DETERMINISTIC_BROWSER ? Promise.resolve() : requestSignIn(),
    disconnect: () => disconnect(),
  }
}
