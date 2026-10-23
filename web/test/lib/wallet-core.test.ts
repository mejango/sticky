import type { Address } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
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

import { publicClient, reviewedSendDeps, walletAdapter } from '@/lib/wallet-core'

const ALICE = '0x1111111111111111111111111111111111111111' as Address

beforeEach(() => {
  mocks.getAccount.mockImplementation(() => ({ address: ALICE, chainId: 1 }))
  mocks.switchChain.mockResolvedValue(undefined)
})

describe('walletAdapter', () => {
  it('reads the connected account and chain', () => {
    expect(walletAdapter.account()).toBe(ALICE)
    expect(walletAdapter.chainId()).toBe(1)
  })

  it('switches through wagmi, and names the chain a wallet that cannot switch must be opened on', async () => {
    await walletAdapter.switchChain(84532)
    expect(mocks.switchChain).toHaveBeenCalledWith({ tag: 'config' }, { chainId: 84532 })
    mocks.switchChain.mockRejectedValueOnce(new Error('"Safe" does not support chain switching.'))
    await expect(walletAdapter.switchChain(84532)).rejects.toThrow('This wallet cannot switch chains. Open it on Base Sepolia and try again.')
  })

  it('passes any other switch failure on as it is', async () => {
    const refused = new Error('User rejected the request.')
    mocks.switchChain.mockRejectedValueOnce(refused)
    await expect(walletAdapter.switchChain(84532)).rejects.toBe(refused)
  })
})

describe('publicClient', () => {
  it('reads through the app’s client for the chain, and says so when there is none', () => {
    const client = { tag: 'public client' }
    mocks.getPublicClient.mockReturnValueOnce(client).mockReturnValueOnce(undefined)
    expect(publicClient(84532)).toBe(client)
    expect(mocks.getPublicClient).toHaveBeenCalledWith({ tag: 'config' }, { chainId: 84532 })
    expect(() => publicClient(84532)).toThrow('No RPC client is configured for chain 84532.')
    mocks.getPublicClient.mockReturnValueOnce(client)
    expect(reviewedSendDeps.clientFor(84532)).toBe(client)
  })
})
