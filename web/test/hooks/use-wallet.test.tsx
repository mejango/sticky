import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletAuthContext } from '@/providers/WalletAuthContext'

const mocks = vi.hoisted(() => ({
  account: { address: undefined as string | undefined, isConnected: false, connector: undefined as { id: string } | undefined },
  connectAsync: vi.fn(),
  connectors: [] as { id: string; name: string; icon?: string; type?: string }[],
  disconnect: vi.fn(),
  deterministic: false,
}))

vi.mock('wagmi', () => ({
  useAccount: () => mocks.account,
  useConnect: () => ({ connectAsync: mocks.connectAsync, connectors: mocks.connectors }),
  useDisconnect: () => ({ disconnect: mocks.disconnect }),
}))
vi.mock('@/providers/Providers', () => ({ get IS_DETERMINISTIC_BROWSER() { return mocks.deterministic } }))

import { useWallet } from '@/hooks/useWallet'

const ALICE = '0x1111111111111111111111111111111111111111'
const announced = (id: string, name: string) => ({ id, name, icon: 'data:image/svg+xml,x', type: 'injected' })

let host: HTMLDivElement
let root: Root
const seen: { wallet?: ReturnType<typeof useWallet> } = {}
const wallet = () => seen.wallet!
const requestSignIn = vi.fn()

function Probe({ report }: { report: (value: ReturnType<typeof useWallet>) => void }) {
  report(useWallet())
  return null
}
const probe = <Probe report={value => { seen.wallet = value }} />

beforeEach(() => {
  mocks.account = { address: undefined, isConnected: false, connector: undefined }
  mocks.connectors = []
  mocks.deterministic = false
  requestSignIn.mockResolvedValue(undefined)
  host = document.createElement('div')
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
})

async function render(withContext = true) {
  await act(async () =>
    root.render(
      withContext ? (
        <WalletAuthContext.Provider value={{ requestSignIn }}>{probe}</WalletAuthContext.Provider>
      ) : (
        probe
      ),
    ),
  )
}

describe('useWallet', () => {
  it('reports no account until a wallet is connected', async () => {
    await render()
    expect(wallet().isConnected).toBe(false)
    expect(wallet().address).toBeUndefined()
    expect(wallet().isCenterWallet).toBe(false)
  })

  it('reports the connected address, and whether it is a Signa account', async () => {
    mocks.account = { address: ALICE, isConnected: true, connector: { id: 'io.metamask' } }
    await render()
    expect(wallet().address).toBe(ALICE)
    expect(wallet().isConnected).toBe(true)
    expect(wallet().isCenterWallet).toBe(false)

    mocks.account = { address: ALICE, isConnected: true, connector: { id: 'juicebox-center' } }
    await render()
    expect(wallet().isCenterWallet).toBe(true)
  })

  it('offers browser wallets only: never Signa or Para, and one entry per wallet name', async () => {
    mocks.connectors = [
      { id: 'injected', name: 'Injected' },
      announced('io.metamask', 'MetaMask'),
      { id: 'juicebox-center', name: 'Juicebox account' },
      { id: 'para', name: 'Para' },
      { id: 'coinbaseWalletSDK', name: 'Coinbase Wallet' },
      announced('com.coinbase.wallet', 'Coinbase Wallet'),
    ]
    await render()
    expect(wallet().connectors.map(connector => connector.id)).toEqual(['io.metamask', 'com.coinbase.wallet'])
  })

  it('connects the wallet with the id it is given, and refuses an id it does not have', async () => {
    mocks.connectors = [announced('io.metamask', 'MetaMask'), announced('io.rabby', 'Rabby')]
    mocks.connectAsync.mockResolvedValue({ accounts: [ALICE], chainId: 1 })
    await render()

    await expect(wallet().connectWith('io.rabby')).resolves.toEqual({ accounts: [ALICE], chainId: 1 })
    expect(mocks.connectAsync).toHaveBeenCalledExactlyOnceWith({ connector: mocks.connectors[1] })

    await expect(wallet().connectWith('juicebox-unknown')).rejects.toThrow('Unknown wallet')
    expect(mocks.connectAsync).toHaveBeenCalledOnce()
  })

  it('connects the Signa account by its own id even though it is not listed as a wallet', async () => {
    mocks.connectors = [announced('io.metamask', 'MetaMask'), { id: 'juicebox-center', name: 'Juicebox account' }]
    mocks.connectAsync.mockResolvedValue({ accounts: [ALICE], chainId: 8453 })
    await render()

    expect(wallet().connectors.map(connector => connector.id)).toEqual(['io.metamask'])
    await wallet().connectWith('juicebox-center')
    expect(mocks.connectAsync).toHaveBeenCalledExactlyOnceWith({ connector: mocks.connectors[1] })
  })

  it('opens the chooser and resolves once it closes, connected or not', async () => {
    let close = () => {}
    requestSignIn.mockReturnValue(new Promise<void>(resolve => { close = resolve }))
    await render()

    let settled = false
    const opened = wallet().openSignIn().then(() => { settled = true })
    await act(async () => { await Promise.resolve() })
    expect(requestSignIn).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    close()
    await opened
    expect(settled).toBe(true)
  })

  it('resolves at once where there is no chooser to open: outside a provider, and in the deterministic browser', async () => {
    await render(false)
    await expect(wallet().openSignIn()).resolves.toBeUndefined()

    mocks.deterministic = true
    await render()
    await expect(wallet().openSignIn()).resolves.toBeUndefined()
    expect(requestSignIn).not.toHaveBeenCalled()
  })

  it('signs out through wagmi', async () => {
    await render()
    wallet().disconnect()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })
})
