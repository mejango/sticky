// @vitest-environment jsdom

import { createConfig, http, reconnect } from '@wagmi/core'
import { mainnet } from 'wagmi/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { lazyConnector, wasRecentConnector } from '@/providers/lazy-connector'

afterEach(() => {
  window.localStorage.clear()
})

function connectorFixture() {
  const account = '0x0000000000000000000000000000000000000001' as const
  const implementation = {
    id: 'vendor',
    name: 'Vendor',
    type: 'vendor',
    connect: vi.fn(async () => ({ accounts: [account], chainId: mainnet.id })),
    disconnect: vi.fn(async () => {}),
    getAccounts: vi.fn(async () => [account]),
    getChainId: vi.fn(async () => mainnet.id),
    getProvider: vi.fn(async () => ({ request: vi.fn() })),
    isAuthorized: vi.fn(async () => true),
    onAccountsChanged: vi.fn(),
    onChainChanged: vi.fn(),
    onDisconnect: vi.fn(),
  }
  const load = vi.fn(async () => () => implementation)
  return { implementation, load }
}

describe('lazyConnector', () => {
  it('keeps the vendor SDK unimported through wagmi’s startup reconnect', async () => {
    // The regression that matters: `reconnect()` calls `getProvider()` on every
    // configured connector, so an ungated connector downloads its SDK on every
    // page load — for visitors who have never used that wallet.
    const { load } = connectorFixture()
    const config = createConfig({
      chains: [mainnet],
      connectors: [
        lazyConnector({
          id: 'vendor',
          name: 'Vendor',
          type: 'vendor',
          load: load as never,
          shouldRestore: () => false,
        }),
      ],
      transports: { [mainnet.id]: http() },
      multiInjectedProviderDiscovery: false,
      storage: null,
    })

    await reconnect(config)

    expect(load).not.toHaveBeenCalled()
    expect(await config.connectors[0].getProvider()).toBeUndefined()
    expect(await config.connectors[0].isAuthorized()).toBe(false)
  })

  it('loads once when the wallet is explicitly picked, gate or no gate', async () => {
    const { implementation, load } = connectorFixture()
    const config = createConfig({
      chains: [mainnet],
      connectors: [
        lazyConnector({
          id: 'vendor',
          name: 'Vendor',
          type: 'vendor',
          load: load as never,
          shouldRestore: () => false,
        }),
      ],
      transports: { [mainnet.id]: http() },
      multiInjectedProviderDiscovery: false,
      storage: null,
    })

    const [connector] = config.connectors
    await connector.connect?.({})
    await connector.getAccounts?.()

    expect(load).toHaveBeenCalledTimes(1)
    expect(implementation.connect).toHaveBeenCalledTimes(1)
  })
})

describe('wasRecentConnector', () => {
  it('matches wagmi’s serialized entry, and stays false when absent', () => {
    expect(wasRecentConnector('coinbaseWallet')).toBe(false)
    // wagmi serializes storage values, so the entry is a quoted JSON string.
    window.localStorage.setItem('wagmi.recentConnectorId', '"coinbaseWalletSDK"')
    expect(wasRecentConnector('coinbaseWallet')).toBe(true)
    expect(wasRecentConnector('walletConnect')).toBe(false)
  })
})
