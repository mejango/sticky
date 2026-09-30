import { createConfig, http, reconnect } from '@wagmi/core'
import { mainnet } from 'wagmi/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateConnectorFn } from 'wagmi'

// Each vendor module records that it was imported. A wallet's SDK must stay out
// of the page until the visitor picks that wallet or its own saved connection
// is restored.
const imported = vi.hoisted(() => [] as string[])
vi.mock('wagmi/connectors/coinbaseWallet', () => {
  imported.push('coinbaseWallet')
  return { coinbaseWallet: vi.fn() }
})
vi.mock('wagmi/connectors/safe', () => {
  imported.push('safe')
  return { safe: vi.fn() }
})
vi.mock('wagmi/connectors/walletConnect', () => {
  imported.push('walletConnect')
  return { walletConnect: vi.fn() }
})

afterEach(() => {
  imported.length = 0
  window.localStorage.clear()
})

function configFor(connectors: CreateConnectorFn[]) {
  return createConfig({
    chains: [mainnet],
    connectors,
    transports: { [mainnet.id]: http() },
    multiInjectedProviderDiscovery: false,
    storage: null,
  })
}

async function freshConnectors() {
  vi.resetModules()
  return (await import('@/providers/wallet-connectors')).externalWalletConnectors()
}

describe('externalWalletConnectors', () => {
  it('offers Coinbase Wallet and Safe, and hides WalletConnect while no project id is configured', async () => {
    const config = configFor(await freshConnectors())
    expect(config.connectors.map(connector => connector.id)).toEqual(['coinbaseWalletSDK', 'safe'])
  })

  it('offers WalletConnect first once a project id is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID', 'project-id')
    const config = configFor(await freshConnectors())
    expect(config.connectors.map(connector => connector.id)).toEqual(['walletConnect', 'coinbaseWalletSDK', 'safe'])
  })

  it('keeps every vendor SDK out of an anonymous page load, through wagmi’s startup reconnect', async () => {
    vi.stubEnv('NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID', 'project-id')
    const config = configFor(await freshConnectors())

    await reconnect(config)

    expect(imported).toEqual([])
    for (const connector of config.connectors) {
      expect(await connector.getProvider(), connector.id).toBeUndefined()
      expect(await connector.isAuthorized(), connector.id).toBe(false)
    }
  })

  it('restores Coinbase Wallet and WalletConnect only for the wallet the visitor last used', async () => {
    vi.stubEnv('NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID', 'project-id')
    const config = configFor(await freshConnectors())
    window.localStorage.setItem('wagmi.recentConnectorId', '"walletConnect"')

    // The vendor factory is a stub, so the delegate cannot finish loading. Reaching the import is the point.
    await config.connectors.find(connector => connector.id === 'walletConnect')!.getProvider().catch(() => {})

    expect(imported).toEqual(['walletConnect'])
  })
})
