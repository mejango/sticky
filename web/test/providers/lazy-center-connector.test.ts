import { createConfig, http } from '@wagmi/core'
import { mainnet } from 'wagmi/chains'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lazyCenterConnector } from '@/providers/lazy-center-connector'

const mocks = vi.hoisted(() => ({
  config: null as { issuer: string; audience: string } | null,
  implementation: {
    isAuthorized: vi.fn(),
    getProvider: vi.fn(),
  },
  wallet: { wallet: true },
  centerAccountConnector: vi.fn(),
  centerWalletClient: vi.fn(),
}))
vi.mock('@/providers/wallet-config', () => ({ get CENTER_WALLET_CONFIG() { return mocks.config } }))
vi.mock('@bananapus/nana-sdk-connect/wagmi', () => ({ centerAccountConnector: mocks.centerAccountConnector }))
vi.mock('@/providers/center-runtime', () => ({ centerWalletClient: mocks.centerWalletClient }))

const savedConnectionKey = () =>
  `center.wallet.connection.v1:https://signa.center:${window.location.origin}/center/callback`

function signa() {
  return createConfig({
    chains: [mainnet],
    connectors: [lazyCenterConnector()],
    transports: { [mainnet.id]: http() },
    multiInjectedProviderDiscovery: false,
    storage: null,
  }).connectors[0]
}

beforeEach(() => {
  mocks.config = { issuer: 'https://signa.center', audience: 'https://api.signa.center' }
  mocks.implementation.isAuthorized.mockResolvedValue(true)
  mocks.implementation.getProvider.mockResolvedValue({ request: vi.fn() })
  mocks.centerAccountConnector.mockReturnValue(() => mocks.implementation)
  mocks.centerWalletClient.mockReturnValue(mocks.wallet)
})

afterEach(() => {
  window.sessionStorage.clear()
})

describe('the Signa connector', () => {
  it('is the passkey account, under the id the sign-in dialog and the wallet list expect', () => {
    const connector = signa()
    expect([connector.id, connector.name, connector.type]).toEqual(['juicebox-center', 'Juicebox account', 'juicebox-center'])
  })

  it('keeps the Signa SDK unloaded for a visitor with no saved sign-in', async () => {
    const connector = signa()
    expect(await connector.getProvider()).toBeUndefined()
    expect(await connector.isAuthorized()).toBe(false)
    expect(mocks.centerAccountConnector).not.toHaveBeenCalled()
    expect(mocks.centerWalletClient).not.toHaveBeenCalled()
  })

  it('keeps it unloaded on a site with no Signa configuration, even with a saved sign-in', async () => {
    mocks.config = null
    window.sessionStorage.setItem(savedConnectionKey(), '{}')
    expect(await signa().isAuthorized()).toBe(false)
    expect(mocks.centerAccountConnector).not.toHaveBeenCalled()
  })

  it('restores this tab’s saved sign-in on a reload, through this origin’s callback', async () => {
    window.sessionStorage.setItem(savedConnectionKey(), '{}')
    const connector = signa()

    expect(await connector.isAuthorized()).toBe(true)

    expect(mocks.centerAccountConnector).toHaveBeenCalledOnce()
    const { wallet } = mocks.centerAccountConnector.mock.calls[0][0] as { wallet: () => Promise<unknown> }
    expect(await wallet()).toBe(mocks.wallet)
  })

  it('does not restore a sign-in saved for another issuer or another origin', async () => {
    window.sessionStorage.setItem(`center.wallet.connection.v1:https://evil.example:${window.location.origin}/center/callback`, '{}')
    window.sessionStorage.setItem('center.wallet.connection.v1:https://signa.center:https://evil.example/center/callback', '{}')
    expect(await signa().isAuthorized()).toBe(false)
    expect(mocks.centerAccountConnector).not.toHaveBeenCalled()
  })

  it('reads chain state through JB Center on Base', async () => {
    window.sessionStorage.setItem(savedConnectionKey(), '{}')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2105' }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await signa().isAuthorized()
    const { read } = mocks.centerAccountConnector.mock.calls[0][0] as {
      read: (request: { method: string }) => Promise<unknown>
    }

    await expect(read({ method: 'eth_chainId' })).resolves.toBe('0x2105')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('https://juicebox.center/v1/rpc/8453')
  })
})
