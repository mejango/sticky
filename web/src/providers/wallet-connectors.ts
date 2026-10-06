'use client'

import type { CreateConnectorFn } from 'wagmi'
import { lazyConnector, wasRecentConnector } from './lazy-connector'

// Keep external wallet configuration independent of the lazy Center client.

const APP = {
  name: 'Sticky',
  description:
    'Stick a Juicebox token, hold your streak, and share the bonus left behind by everyone who unsticks.',
  url: process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'https://sticky.center',
}

const WALLET_CONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID?.trim() ?? ''

/**
 * WalletConnect — the only route to mobile wallets that aren't in this browser.
 *
 * Absent unless a project id is configured: WalletConnect's relay rejects
 * unregistered ids, so a connector without one is a button that always fails.
 *
 * `showQrModal: false` suppresses the vendor's own modal. wagmi re-emits the
 * pairing URI as a `display_uri` message, which our sign-in sheet renders as a
 * QR, so no third-party chrome appears.
 */
function lazyWalletConnect(): CreateConnectorFn | undefined {
  if (!WALLET_CONNECT_PROJECT_ID) return undefined
  return lazyConnector({
    id: 'walletConnect',
    name: 'WalletConnect',
    type: 'walletConnect',
    shouldRestore: () => wasRecentConnector('walletConnect'),
    load: async () => {
      const { walletConnect } = await import('wagmi/connectors/walletConnect')
      return walletConnect({
        projectId: WALLET_CONNECT_PROJECT_ID,
        showQrModal: false,
        metadata: {
          name: APP.name,
          description: APP.description,
          url: APP.url,
          icons: [`${APP.url}/assets/drip-corner.png`],
        },
      })
    },
  })
}

/** Coinbase Wallet, which is not an injected provider outside its extension. */
function lazyCoinbaseWallet(): CreateConnectorFn {
  return lazyConnector({
    id: 'coinbaseWalletSDK',
    name: 'Coinbase Wallet',
    type: 'coinbaseWallet',
    shouldRestore: () => wasRecentConnector('coinbaseWallet'),
    load: async () => {
      const { coinbaseWallet } = await import('wagmi/connectors/coinbaseWallet')
      return coinbaseWallet({
        appName: APP.name,
        appLogoUrl: `${APP.url}/assets/drip-corner.png`,
      })
    },
  })
}

/**
 * Safe, which only exists when the app is running as a Safe App.
 *
 * Gated on being framed rather than on a stored id: Safe connects itself
 * through the parent frame, so there is no prior click to remember, and the
 * check is exact — outside an iframe this connector can never succeed.
 */
function lazySafe(): CreateConnectorFn {
  return lazyConnector({
    id: 'safe',
    name: 'Safe',
    type: 'safe',
    shouldRestore: () => {
      try {
        return window.self !== window.top
      } catch {
        // Cross-origin framing throws on access, which itself means we are
        // framed — exactly the case Safe cares about.
        return true
      }
    },
    load: async () => {
      const { safe } = await import('wagmi/connectors/safe')
      return safe({ allowedDomains: [/app\.safe\.global$/, /app\.5afe\.dev$/] })
    },
  })
}

/**
 * Every non-injected wallet, in the order the sign-in sheet lists them.
 * These wagmi modules dynamically import their optional Coinbase, Safe, and
 * WalletConnect SDK peers. Keep those package dependencies installed; knip's
 * explicit dependency exceptions cover these imports inside node_modules.
 */
export function externalWalletConnectors(): CreateConnectorFn[] {
  return [lazyWalletConnect(), lazyCoinbaseWallet(), lazySafe()].filter(
    (connector): connector is CreateConnectorFn => !!connector,
  )
}
