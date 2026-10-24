import { registerReviewHandler, signReviewed, ReviewLineError, type ReviewedSignature } from '@bananapus/nana-sdk-core/review'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, erc20Abi, type Address } from 'viem'

const state = vi.hoisted(() => ({
  safe: false,
  config: {
    chains: [{ id: 1, name: 'Ethereum', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['http://unused'] } } }],
    state: { current: 'old', status: 'connected', connections: new Map<string, { accounts: Address[]; chainId: number; connector: unknown }>() },
  },
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: state.config }))
vi.mock('@/lib/safe-connector', () => ({ isSafeConnection: () => state.safe }))

// Both wagmi and viem are real: delay the connector work inside getWalletClient.
import { walletAdapter } from '@/lib/wallet-core'

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address
const HASH = `0x${'12'.repeat(32)}` as const
const SIGNATURE = `0x${'12'.repeat(65)}` as const
const external = new Set(['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_sendCalls'])

function connector(uid: string, pause?: { at: string; entered: () => void; wait: Promise<void> }) {
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_sendTransaction') return HASH
    if (method === 'personal_sign' || method === 'eth_signTypedData_v4') return SIGNATURE
    if (method === 'wallet_sendCalls') return 'batch'
    throw new Error(`Unexpected wallet method ${method}`)
  })
  const block = async (at: string) => { if (pause?.at === at) { pause.entered(); await pause.wait } }
  return {
    id: uid, uid, request,
    getAccounts: async () => [ACCOUNT],
    getChainId: async () => { await block('getChainId'); return 1 },
    getProvider: async () => { await block('getProvider'); return { request } },
  }
}
function select(wallet: ReturnType<typeof connector>, address = ACCOUNT, chainId = 1) {
  state.config.state.connections.set(wallet.uid, { accounts: [address], chainId, connector: wallet })
  state.config.state.current = wallet.uid
}
const calls = [{ to: ACCOUNT, data: '0x' as const, value: 0n }]
const actions = {
  payment: () => walletAdapter.sendTransaction({ chainId: 1, ...calls[0], value: 1n, gas: 21_000n }),
  approval: () => walletAdapter.sendTransaction({ chainId: 1, ...calls[0], gas: 50_000n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ACCOUNT, 1n] }) }),
  message: () => walletAdapter.signMessage('Review this action'),
  typed: () => walletAdapter.signTypedData({ domain: { name: 'Test', chainId: 1 }, types: { Test: [{ name: 'value', type: 'uint256' }] }, primaryType: 'Test', message: { value: 1n } }),
  batch: () => walletAdapter.sendCalls!(1, calls),
}
const invoked = (wallet: ReturnType<typeof connector>) => wallet.request.mock.calls.filter(([request]) => external.has(request.method))

beforeEach(() => { state.safe = false; state.config.state.connections.clear() })

describe('the actual wagmi acquisition boundary', () => {
  it.each(Object.entries(actions).flatMap(([kind, send]) => ['getChainId', 'getProvider'].map(at => ({ kind, send, at }))))(
    'uses the current connector for $kind after deferred $at', async ({ send, at }) => {
      const entered = Promise.withResolvers<void>()
      const wait = Promise.withResolvers<void>()
      const old = connector('old', { at, entered: entered.resolve, wait: wait.promise })
      const current = connector('current')
      select(old)
      const pending = send()
      await entered.promise
      select(current)
      wait.resolve()
      await pending
      expect(invoked(old)).toEqual([])
      expect(invoked(current)).toHaveLength(1)
    },
  )

  it('bounds acquisition retries when the connector keeps changing, without any external invocation', async () => {
    const wallets = Array.from({ length: 4 }, (_, index) => connector(String(index)))
    for (let index = 0; index < 3; index++) {
      vi.spyOn(wallets[index], 'getProvider').mockImplementation(async () => {
        select(wallets[index + 1])
        return { request: wallets[index].request }
      })
    }
    select(wallets[0])
    await expect(actions.payment()).rejects.toMatchObject({ code: 4001, walletNotInvoked: true })
    for (const wallet of wallets) expect(invoked(wallet)).toEqual([])
    expect(wallets[2].getProvider).toHaveBeenCalledOnce()
  })

  it('marks an acquisition failure as unsent and preserves its cause', async () => {
    const wallet = connector('old')
    const failure = new Error('Provider unavailable')
    vi.spyOn(wallet, 'getProvider').mockRejectedValue(failure)
    select(wallet)
    await expect(actions.payment()).rejects.toMatchObject({ code: 4001, walletNotInvoked: true, acquisitionCause: failure })
    expect(invoked(wallet)).toEqual([])
  })

  it.each(['message', 'typed'] as const)('preserves the actual context failure through SDK signReviewed for a %s signature', async kind => {
    const entered = Promise.withResolvers<void>()
    const wait = Promise.withResolvers<void>()
    const old = connector('old', { at: 'getProvider', entered: entered.resolve, wait: wait.promise })
    const current = connector('current')
    select(old)
    const unregister = registerReviewHandler(async prompt => prompt.confirmation)
    try {
      const signature: ReviewedSignature = kind === 'message'
        ? { kind: 'message' as const, chainId: 1, message: 'Review this action' }
        : { kind: 'permit2' as const, authorization: { chainId: 1, token: ACCOUNT, spender: ACCOUNT, amount: 1n, expiration: 1, nonce: 0, sigDeadline: 1n } }
      const pending = signReviewed([signature], { account: ACCOUNT }, { adapter: walletAdapter })
      const rejected = expect(pending).rejects.toThrow('The connected account changed. Review again.')
      await entered.promise
      select(current, '0x2222222222222222222222222222222222222222')
      wait.resolve()
      await rejected
      await expect(pending).rejects.toBeInstanceOf(ReviewLineError)
      expect(invoked(old)).toEqual([])
      expect(invoked(current)).toEqual([])
    } finally { unregister() }
  })

  it.each(['account', 'chain', 'Safe route', 'disconnect'] as const)('refuses a changed %s without invoking either wallet', async changed => {
    const entered = Promise.withResolvers<void>()
    const wait = Promise.withResolvers<void>()
    const old = connector('old', { at: 'getProvider', entered: entered.resolve, wait: wait.promise })
    const current = connector('current')
    select(old)
    const pending = actions.payment()
    const rejected = expect(pending).rejects.toMatchObject({ code: 4001, walletNotInvoked: true })
    await entered.promise
    select(current, changed === 'account' ? '0x2222222222222222222222222222222222222222' : ACCOUNT, changed === 'chain' ? 10 : 1)
    if (changed === 'Safe route') state.safe = true
    if (changed === 'disconnect') state.config.state.connections.clear()
    wait.resolve()
    await rejected
    expect(invoked(old)).toEqual([])
    expect(invoked(current)).toEqual([])
  })
})
