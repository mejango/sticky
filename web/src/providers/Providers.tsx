'use client'

// Clear callback data before loading a wallet SDK or rendering.
import './center-callback'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type PropsWithChildren, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createConfig, injected, WagmiProvider } from 'wagmi'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { jbCenterRpcTransport } from '@/lib/jbcenter-rpc'
import { installQueryPersistence } from '@/lib/query-persist'
import { WalletAuthContext } from './WalletAuthContext'
import { lazyCenterConnector } from './lazy-center-connector'
import { externalWalletConnectors } from './wallet-connectors'
import { CENTER_WALLET_ENABLED } from './wallet-config'
import { ExternalWalletDialog } from './ExternalWalletDialog'
import { arbitrum, arbitrumSepolia, base, baseSepolia, mainnet, optimism, optimismSepolia, sepolia } from '@bananapus/nana-sdk-core/chains'

export const IS_DETERMINISTIC_BROWSER = process.env.NEXT_PUBLIC_DETERMINISTIC_BROWSER === 'true'
export { SUPPORTED_CHAINS } from '@/lib/chains'
const transports = {
  [mainnet.id]: jbCenterRpcTransport(mainnet.id), [optimism.id]: jbCenterRpcTransport(optimism.id),
  [base.id]: jbCenterRpcTransport(base.id), [arbitrum.id]: jbCenterRpcTransport(arbitrum.id),
  [sepolia.id]: jbCenterRpcTransport(sepolia.id), [optimismSepolia.id]: jbCenterRpcTransport(optimismSepolia.id),
  [baseSepolia.id]: jbCenterRpcTransport(baseSepolia.id), [arbitrumSepolia.id]: jbCenterRpcTransport(arbitrumSepolia.id),
}

/** One connection state for Center and existing external wallets. Vendor clients load only
 * when selected or when their own saved connection is restored. */
export const wagmiConfig = createConfig({ chains: SUPPORTED_CHAINS, transports,
  connectors: IS_DETERMINISTIC_BROWSER ? [] : [injected({ shimDisconnect: true }),
    ...(CENTER_WALLET_ENABLED ? [lazyCenterConnector()] : []), ...externalWalletConnectors()],
  multiInjectedProviderDiscovery: !IS_DETERMINISTIC_BROWSER, ssr: true })

export function Providers({ children }: PropsWithChildren) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: {
    staleTime: 30_000, gcTime: 10 * 60_000, retry: 1, refetchOnWindowFocus: false,
  } } }))
  // Restore cached client data only after streamed server content has hydrated.
  useEffect(() => {
    let teardown: (() => void) | undefined
    const restore = () => { teardown = installQueryPersistence(queryClient) }
    if (document.readyState === 'complete') restore()
    else window.addEventListener('load', restore, { once: true })
    return () => { window.removeEventListener('load', restore); teardown?.() }
  }, [queryClient])
  const [walletOpen, setWalletOpen] = useState(false)
  const waiting = useRef<(() => void)[]>([])
  const requestSignIn = useCallback(() => {
    if (IS_DETERMINISTIC_BROWSER) return Promise.resolve()
    setWalletOpen(true)
    return new Promise<void>(resolve => { waiting.current = [...waiting.current, resolve] })
  }, [])
  const closeWallet = useCallback(() => {
    setWalletOpen(false)
    const pending = waiting.current
    waiting.current = []
    for (const resolve of pending) resolve()
  }, [])
  const walletAuth = useMemo(() => ({ requestSignIn }), [requestSignIn])
  return <QueryClientProvider client={queryClient}>
    <WagmiProvider config={wagmiConfig} reconnectOnMount={!IS_DETERMINISTIC_BROWSER}>
      <WalletAuthContext.Provider value={walletAuth}>
        {children}
        {walletOpen ? <ExternalWalletDialog onClose={closeWallet} /> : null}
      </WalletAuthContext.Provider>
    </WagmiProvider>
  </QueryClientProvider>
}
