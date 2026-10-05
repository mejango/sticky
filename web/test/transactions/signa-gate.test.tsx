// @vitest-environment jsdom

/**
 * Review Focus #5: Signa signs in, and an external wallet sends. With Signa as the connected wallet a write is
 * refused before anything reaches it (Homerun's gate in useSafeTx), the flow says "This action needs an external
 * wallet." and offers "Connect a wallet", which opens the chooser with the external wallets alone. The wallet here is
 * a real wagmi connection whose provider records every request made of it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { parseAbi, type Address } from 'viem'
import { connect } from '@wagmi/core'
import { createConfig, createConnector, http, WagmiProvider, type Config } from 'wagmi'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { baseSepolia } from '@bananapus/nana-sdk-core/chains'

const state = vi.hoisted(() => ({ config: undefined as unknown, requestReview: vi.fn() }))

vi.mock('@/providers/Providers', () => ({
  IS_DETERMINISTIC_BROWSER: false,
  get wagmiConfig() {
    return state.config
  },
}))
vi.mock('@/lib/transaction-review', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/transaction-review')>()),
  requestContractTransactionReview: state.requestReview,
}))

import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { useSafeTx } from '@/hooks/useSafeTx'
import { EXTERNAL_WALLET_REQUIRED, WalletAuthContext } from '@/providers/WalletAuthContext'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const HOOK = '0x2222222222222222222222222222222222222222' as Address
const request = {
  chainId: baseSepolia.id,
  address: HOOK,
  abi: parseAbi(['function setTrustedSenderFor(uint256 projectId, address sender, bool trusted)']),
  functionName: 'setTrustedSenderFor',
  args: [23n, ALICE, true] as const,
  label: 'Trust a sender',
}

/** A wallet whose provider records what is asked of it and answers nothing. */
function wallet(id: string) {
  const asked = vi.fn(async ({ method }: { method: string }) => {
    throw new Error(`The wallet was asked for ${method}.`)
  })
  const connector = createConnector(() => ({
    id,
    name: id,
    type: id,
    async connect({ chainId }: { chainId?: number } = {}) {
      return { accounts: [ALICE] as never, chainId: chainId ?? baseSepolia.id }
    },
    async disconnect() {},
    async getAccounts() {
      return [ALICE]
    },
    async getChainId() {
      return baseSepolia.id
    },
    async getProvider() {
      return { request: asked }
    },
    async isAuthorized() {
      return true
    },
    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {},
  }))
  return { connector, asked }
}

let host: HTMLDivElement
let root: Root
const requestSignIn = vi.fn()

beforeEach(() => {
  requestSignIn.mockResolvedValue(undefined)
  state.requestReview.mockResolvedValue(false)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

async function connected(id: string) {
  const { connector, asked } = wallet(id)
  const config = createConfig({
    chains: [baseSepolia],
    connectors: [connector],
    transports: { [baseSepolia.id]: http('http://127.0.0.1:1') },
    multiInjectedProviderDiscovery: false,
    storage: null,
  })
  state.config = config
  await connect(config, { connector: config.connectors[0] })
  asked.mockClear()
  return { config, asked }
}

function TrustFlow() {
  const tx = useSafeTx(baseSepolia.id)
  return (
    <TxConfirmDialog
      open
      onClose={() => {}}
      title="Trust this sender"
      steps={[{ title: 'Trust the sender' }]}
      activeIndex={tx.busy ? 0 : -1}
      busy={tx.busy}
      action="Confirm & trust"
      onConfirm={() => void tx.send(request, { reviewedAccount: ALICE })}
      error={tx.error}
    />
  )
}

async function render(config: Config, tree: ReactNode) {
  await act(async () =>
    root.render(
      <WagmiProvider config={config} reconnectOnMount={false}>
        <QueryClientProvider client={new QueryClient()}>
          <WalletAuthContext.Provider value={{ requestSignIn }}>{tree}</WalletAuthContext.Provider>
        </QueryClientProvider>
      </WagmiProvider>,
    ),
  )
}

const dialog = () => document.querySelector('dialog')!
const button = (name: string) => [...document.querySelectorAll('button')].find(item => item.textContent === name)

describe('a write while Signa is the connected wallet', () => {
  it('wallet-action:submit-a-reviewed-direct-write is refused before the wallet is asked anything, and offers to connect an external wallet', async () => {
    const { config, asked } = await connected('juicebox-center')
    await render(config, <TrustFlow />)

    await act(async () => button('Confirm & trust')!.click())

    expect(dialog().textContent).toContain('This action needs an external wallet.')
    expect(button('Connect a wallet')).toBeDefined()
    expect(asked).not.toHaveBeenCalled()
    expect(state.requestReview).not.toHaveBeenCalled()

    await act(async () => button('Connect a wallet')!.click())
    expect(requestSignIn).toHaveBeenCalledWith({ walletsOnly: true })
    expect(asked).not.toHaveBeenCalled()
  })

  it('goes on to the review from an external wallet', async () => {
    const { config } = await connected('io.rabby')
    await render(config, <TrustFlow />)

    await act(async () => button('Confirm & trust')!.click())

    expect(state.requestReview).toHaveBeenCalledOnce()
    expect(dialog().textContent).not.toContain(EXTERNAL_WALLET_REQUIRED)
    expect(button('Connect a wallet')).toBeUndefined()
  })
})

describe('the error block under a flow’s button', () => {
  it('offers the external wallet for the Signa refusal, and nothing for other errors', async () => {
    const { config } = await connected('juicebox-center')
    await render(
      config,
      <>
        <TxError error={EXTERNAL_WALLET_REQUIRED} />
        <TxError error="The wallet did not send the transaction." />
      </>,
    )
    const blocks = [...host.querySelectorAll('p')]
    expect(blocks.map(block => block.textContent)).toEqual([
      'This action needs an external wallet. Connect a wallet',
      'The wallet did not send the transaction.',
    ])
    await act(async () => button('Connect a wallet')!.click())
    expect(requestSignIn).toHaveBeenCalledWith({ walletsOnly: true })
  })
})
