'use client'

import { useEffect, useState } from 'react'
import { isMobileDevice } from '@/lib/walletLinks'

export type MobileWalletState =
  | 'not-mobile'
  | 'checking'
  | 'injected'
  | 'handoff'

/**
 * MetaMask Mobile injects its provider later than desktop extensions and emits
 * `ethereum#initialized` when it is ready. Give it the documented three-second
 * initialization window before offering to reopen the page in a wallet app.
 */
export function useMobileWallet(): MobileWalletState {
  const [state, setState] = useState<MobileWalletState>('not-mobile')

  useEffect(() => {
    if (!isMobileDevice(navigator)) return
    const browserWindow = window as typeof window & { ethereum?: unknown }
    if (browserWindow.ethereum) {
      setState('injected')
      return
    }

    setState('checking')
    let settled = false
    let timer: number | undefined
    const stopListening = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
      window.removeEventListener('ethereum#initialized', providerReady)
      window.removeEventListener('eip6963:announceProvider', providerReady)
    }
    const providerReady = () => {
      if (settled) return
      settled = true
      stopListening()
      setState('injected')
    }
    window.addEventListener('ethereum#initialized', providerReady)
    window.addEventListener('eip6963:announceProvider', providerReady)
    timer = window.setTimeout(() => {
      settled = true
      stopListening()
      setState(browserWindow.ethereum ? 'injected' : 'handoff')
    }, 3000)

    return () => {
      settled = true
      stopListening()
    }
  }, [])

  return state
}
