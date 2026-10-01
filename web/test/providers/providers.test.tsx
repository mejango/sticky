import { dehydrate, QueryClient, useQueryClient } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { erc20Abi } from 'viem'
import { useConfig } from 'wagmi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeState } from '@/lib/query-persist'

vi.mock('@/providers/ExternalWalletDialog', () => ({
  ExternalWalletDialog: ({ onClose, walletsOnly }: { onClose: () => void; walletsOnly?: boolean }) => (
    <div data-testid="chooser" data-wallets-only={String(walletsOnly === true)}>
      <button type="button" onClick={onClose}>Close chooser</button>
    </div>
  ),
}))

const SIGNA_ENV = {
  NEXT_PUBLIC_CENTER_WALLET_ENABLED: 'true',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_ID: 'reviewed-base-passkey',
  NEXT_PUBLIC_CENTER_WALLET_MANIFEST_REVISION: `0x${'11'.repeat(32)}`,
  NEXT_PUBLIC_CENTER_WALLET_MAXIMUM_NETWORK_FEE_WEI: '100000000000000',
}

// The wagmi config and the environment flags are read when the module loads, so each test loads its own copy.
async function load(env: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  vi.resetModules()
  const [providers, auth] = await Promise.all([
    import('@/providers/Providers'),
    import('@/providers/WalletAuthContext'),
  ])
  return { ...providers, ...auth }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  window.localStorage.clear()
})

const mount = (tree: ReactNode) => act(async () => root.render(tree))
const chooser = () => host.querySelector('[data-testid="chooser"]')

describe('Providers', () => {
  it('gives the app one query client and one wagmi config, with the read defaults', async () => {
    const { Providers, wagmiConfig } = await load()
    const seen: { client?: QueryClient; config?: unknown } = {}
    function Probe() {
      seen.client = useQueryClient()
      seen.config = useConfig()
      return <p>the app</p>
    }

    await mount(<Providers><Probe /></Providers>)

    expect(host.textContent).toBe('the app')
    expect(seen.config).toBe(wagmiConfig)
    expect(seen.client!.getDefaultOptions().queries).toMatchObject({
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    })
  })

  it('serves all four production chains and all four testnets, and no other', async () => {
    const { wagmiConfig, SUPPORTED_CHAINS } = await load()
    expect(wagmiConfig.chains.map(chain => chain.id)).toEqual([1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614])
    expect(SUPPORTED_CHAINS.map(chain => chain.id)).toEqual(wagmiConfig.chains.map(chain => chain.id))
  })

  it('lists the browser wallet first, and Signa only where the site enables it', async () => {
    const plain = await load()
    expect(plain.wagmiConfig.connectors.map(connector => connector.id)).toEqual(['injected', 'coinbaseWalletSDK', 'safe'])

    const withSigna = await load(SIGNA_ENV)
    expect(withSigna.wagmiConfig.connectors.map(connector => connector.id)).toEqual([
      'injected', 'juicebox-center', 'coinbaseWalletSDK', 'safe',
    ])
  })

  it('opens the chooser on request, and answers every waiting caller when it closes', async () => {
    const { Providers, useWalletAuth } = await load()
    let requestSignIn = () => Promise.resolve()
    function Probe() {
      requestSignIn = useWalletAuth().requestSignIn
      return null
    }
    await mount(<Providers><Probe /></Providers>)
    expect(chooser()).toBeNull()

    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => { first = requestSignIn(); second = requestSignIn() })
    expect(host.querySelectorAll('[data-testid="chooser"]')).toHaveLength(1)
    let answered = 0
    void first.then(() => answered++)
    void second.then(() => answered++)
    await act(async () => { await Promise.resolve() })
    expect(answered).toBe(0)

    await act(async () => host.querySelector('button')!.click())

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(chooser()).toBeNull()

    await act(async () => { void requestSignIn() })
    expect(chooser()).not.toBeNull()
  })

  it('opens the chooser with the external wallets alone when a write from a Signa session asks for one', async () => {
    const { Providers, useWalletAuth } = await load()
    let requestSignIn: (options?: { walletsOnly?: boolean }) => Promise<void> = () => Promise.resolve()
    function Probe() {
      requestSignIn = useWalletAuth().requestSignIn
      return null
    }
    await mount(<Providers><Probe /></Providers>)

    let asked!: Promise<void>
    await act(async () => { asked = requestSignIn({ walletsOnly: true }) })
    expect(chooser()!.getAttribute('data-wallets-only')).toBe('true')
    await act(async () => host.querySelector('button')!.click())
    await expect(asked).resolves.toBeUndefined()
    expect(chooser()).toBeNull()

    await act(async () => { void requestSignIn() })
    expect(chooser()!.getAttribute('data-wallets-only')).toBe('false')
  })

  it('holds the one review queue every write waits on', async () => {
    const { Providers } = await load()
    const { requestContractTransactionReview } = await import('@/lib/transaction-review')
    const call = {
      chainId: 84532,
      address: '0x1111111111111111111111111111111111111111',
      abi: erc20Abi,
      functionName: 'approve',
      args: ['0x2222222222222222222222222222222222222222', 1n],
    } as const
    await expect(requestContractTransactionReview(call)).rejects.toThrow('Transaction review is unavailable')

    await mount(<Providers><p>the app</p></Providers>)
    let answered = false
    const asked = requestContractTransactionReview(call).then(approved => {
      answered = true
      return approved
    })
    await act(async () => { await Promise.resolve() })
    expect(answered).toBe(false)

    // Leaving the page declines what is waiting: nothing is approved by default.
    await act(async () => root.unmount())
    await expect(asked).resolves.toBe(false)
    root = createRoot(host)
  })

  it('has no wallets, no reconnect and no chooser in the deterministic browser', async () => {
    const { Providers, IS_DETERMINISTIC_BROWSER, wagmiConfig, useWalletAuth } = await load({
      NEXT_PUBLIC_DETERMINISTIC_BROWSER: 'true',
      ...SIGNA_ENV,
    })
    let requestSignIn = () => Promise.resolve()
    function Probe() {
      requestSignIn = useWalletAuth().requestSignIn
      return null
    }
    await mount(<Providers><Probe /></Providers>)

    expect(IS_DETERMINISTIC_BROWSER).toBe(true)
    expect(wagmiConfig.connectors).toEqual([])
    await act(async () => { await requestSignIn() })
    expect(chooser()).toBeNull()
  })

  describe('cached reads', () => {
    async function seedCache() {
      const seed = new QueryClient()
      await seed.fetchQuery({
        queryKey: ['ruleset', 1],
        queryFn: async () => ({ weight: 5n }),
        meta: { persist: 'immutable' },
      })
      window.localStorage.setItem('sticky:query-cache:v1', serializeState(dehydrate(seed)))
    }

    it('restores last session’s reads from Sticky’s own cache key at once, before the page has loaded', async () => {
      await seedCache()
      vi.spyOn(document, 'readyState', 'get').mockReturnValue('interactive')
      const { Providers } = await load()
      let client!: QueryClient
      function Probe() {
        client = useQueryClient()
        return null
      }

      await mount(<Providers><Probe /></Providers>)

      expect(client.getQueryData(['ruleset', 1])).toEqual({ weight: 5n })
    })
  })
})
