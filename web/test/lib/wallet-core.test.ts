import type { Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: { address: undefined as Address | undefined, chainId: undefined as number | undefined },
  getAccount: vi.fn(),
  getPublicClient: vi.fn(),
  getWalletClient: vi.fn(),
  switchChain: vi.fn(),
}))

vi.mock('@wagmi/core', () => ({
  getAccount: mocks.getAccount,
  getPublicClient: mocks.getPublicClient,
  getWalletClient: mocks.getWalletClient,
  switchChain: mocks.switchChain,
}))
vi.mock('@/providers/Providers', () => ({ wagmiConfig: { tag: 'config' } }))

import { connectedWallet, publicClient } from '@/lib/wallet-core'

const ALICE = '0x1111111111111111111111111111111111111111' as Address
const BOB = '0x2222222222222222222222222222222222222222' as Address
const WALLET = { tag: 'wallet client' }
const CHANGED = 'The connected account changed. Review again.'

beforeEach(() => {
  mocks.account = { address: ALICE, chainId: 1 }
  mocks.getAccount.mockImplementation(() => ({ ...mocks.account }))
  mocks.switchChain.mockImplementation(async (_config: unknown, { chainId }: { chainId: number }) => {
    mocks.account = { ...mocks.account, chainId }
  })
  mocks.getWalletClient.mockResolvedValue(WALLET)
})

describe('connectedWallet', () => {
  it('switches the wallet to the request’s chain before it hands out the wallet client', async () => {
    await expect(connectedWallet(84532, { changedError: CHANGED })).resolves.toEqual({ wallet: WALLET, account: ALICE })

    expect(mocks.switchChain).toHaveBeenCalledWith({ tag: 'config' }, { chainId: 84532 })
    expect(mocks.getWalletClient).toHaveBeenCalledWith({ tag: 'config' }, { chainId: 84532 })
    expect(mocks.switchChain.mock.invocationCallOrder[0]).toBeLessThan(mocks.getWalletClient.mock.invocationCallOrder[0])
  })

  it('does not switch a wallet already on the chain', async () => {
    mocks.account = { address: ALICE, chainId: 84532 }
    await connectedWallet(84532, { changedError: CHANGED })
    expect(mocks.switchChain).not.toHaveBeenCalled()
    expect(mocks.getWalletClient).toHaveBeenCalledOnce()
  })

  it('names the chain a wallet that cannot switch must be opened on', async () => {
    mocks.switchChain.mockRejectedValueOnce(new Error('"Safe" does not support chain switching.'))
    await expect(connectedWallet(84532, { changedError: CHANGED })).rejects.toThrow(
      'This wallet cannot switch chains. Open it on Base Sepolia and try again.',
    )
    expect(mocks.getWalletClient).not.toHaveBeenCalled()
  })

  it('passes any other switch failure on as it is', async () => {
    const refused = new Error('User rejected the request.')
    mocks.switchChain.mockRejectedValueOnce(refused)
    await expect(connectedWallet(84532, { changedError: CHANGED })).rejects.toBe(refused)
  })

  it('refuses an account that changed with the switch, or is not the one expected', async () => {
    mocks.switchChain.mockImplementationOnce(async () => {
      mocks.account = { address: BOB, chainId: 84532 }
    })
    await expect(connectedWallet(84532, { requireUnchanged: true, changedError: CHANGED })).rejects.toThrow(CHANGED)

    mocks.account = { address: ALICE, chainId: 84532 }
    await expect(connectedWallet(84532, { expected: BOB, changedError: CHANGED })).rejects.toThrow(CHANGED)
  })

  it('asks for a wallet when none is connected', async () => {
    mocks.account = { address: undefined, chainId: undefined }
    await expect(connectedWallet(84532, { changedError: CHANGED })).rejects.toThrow('Connect a wallet first.')
    expect(mocks.switchChain).not.toHaveBeenCalled()
  })
})

describe('publicClient', () => {
  it('reads through the app’s client for the chain, and says so when there is none', () => {
    const client = { tag: 'public client' }
    mocks.getPublicClient.mockReturnValueOnce(client).mockReturnValueOnce(undefined)
    expect(publicClient(84532)).toBe(client)
    expect(mocks.getPublicClient).toHaveBeenCalledWith({ tag: 'config' }, { chainId: 84532 })
    expect(() => publicClient(84532)).toThrow('No RPC client is configured for chain 84532.')
  })
})
