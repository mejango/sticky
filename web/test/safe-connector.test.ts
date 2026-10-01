import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import type { Hex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeConnector = { id: string; name: string; getProvider?: () => Promise<unknown> }
type Account = { connector?: FakeConnector }

const runtime = vi.hoisted(() => ({
  connector: undefined as FakeConnector | undefined,
  onChange: (_account: Account) => {},
  unwatch: () => {},
  getPublicClient: vi.fn(),
  waitForSafeExecutionHash: vi.fn(),
}))

vi.mock('wagmi/actions', () => ({
  getAccount: () => ({ connector: runtime.connector }),
  getPublicClient: runtime.getPublicClient,
  watchAccount: (_config: unknown, { onChange }: { onChange: (account: Account) => void }) => {
    runtime.onChange = onChange
    return runtime.unwatch
  },
}))
vi.mock('@bananapus/nana-sdk-core/safe-service', async importOriginal => ({
  ...(await importOriginal<typeof import('@bananapus/nana-sdk-core/safe-service')>()),
  waitForSafeExecutionHash: runtime.waitForSafeExecutionHash,
}))

import {
  isSafeConnection,
  useSafeConnection,
  waitForSafeExecutionHash,
} from '@/lib/safe-connector'
import { watchSafeWalletPeer } from '@/lib/safe-wallet-peer'

const config = { tag: 'config' } as never
const HASH = `0x${'ab'.repeat(32)}` as Hex

function walletConnect(getProvider: () => Promise<unknown>): FakeConnector {
  return { id: 'walletConnect', name: 'WalletConnect', getProvider }
}

/** A WalletConnect connection whose session names `url` as the peer. */
function peer(url: string): FakeConnector {
  return walletConnect(async () => ({ session: { peer: { metadata: { url } } } }))
}

/** Connects `connector` and lets the watcher read its session. */
async function connect(connector: FakeConnector | undefined) {
  runtime.connector = connector
  await act(async () => {
    runtime.onChange({ connector })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  // Every test starts watching a disconnected wallet, with no peer recorded.
  runtime.connector = undefined
  watchSafeWalletPeer(config)
})

// The Safe service helpers are tested in @bananapus/nana-sdk-core/safe-service.
describe('Safe connector detection', () => {
  it('matches the Safe app by its connector id, not a name containing "safe"', () => {
    runtime.connector = { id: 'injected', name: 'SafePal' }
    expect(isSafeConnection(config)).toBe(false)
    runtime.connector = { id: 'app.safepal', name: 'SafePal Wallet' }
    expect(isSafeConnection(config)).toBe(false)
    runtime.connector = { id: 'safe', name: 'Safe' }
    expect(isSafeConnection(config)).toBe(true)
  })

  it('is Safe{Wallet} over WalletConnect, and no other peer', async () => {
    await connect(peer('https://app.safe.global'))
    expect(isSafeConnection(config)).toBe(true)
    await connect(peer('https://www.safepal.com'))
    expect(isSafeConnection(config)).toBe(false)
    await connect(peer('https://app.safe.global.example'))
    expect(isSafeConnection(config)).toBe(false)
  })

  it('checks the connection once when it starts watching, and returns the unwatch', async () => {
    runtime.connector = peer('https://app.safe.global')
    let unwatch!: () => void
    await act(async () => {
      unwatch = watchSafeWalletPeer(config)
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(isSafeConnection(config)).toBe(true)
    expect(unwatch).toBe(runtime.unwatch)
  })

  it('keeps Safe{Wallet} while it reads the session again', async () => {
    await connect(peer('https://app.safe.global'))
    // A gas choice made during the read must still be the Safe's.
    runtime.onChange({ connector: walletConnect(() => new Promise(() => {})) })
    expect(isSafeConnection(config)).toBe(true)
  })

  it('keeps the newest answer when an earlier session read finishes later', async () => {
    let finish!: (provider: unknown) => void
    runtime.onChange({
      connector: walletConnect(() => new Promise(resolve => { finish = resolve })),
    })
    await connect(peer('https://www.safepal.com'))
    await act(async () => {
      finish({ session: { peer: { metadata: { url: 'https://app.safe.global' } } } })
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(isSafeConnection(config)).toBe(false)
  })

  it('forgets Safe{Wallet} when a session cannot be read', async () => {
    await connect(peer('https://app.safe.global'))
    await connect(walletConnect(() => Promise.reject(new Error('Session expired'))))
    expect(isSafeConnection(config)).toBe(false)
  })

  it('renders again once Safe{Wallet} is recognized', async () => {
    const Probe = () => String(useSafeConnection(config))
    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(createElement(Probe))
    })
    expect(renderer.toJSON()).toBe('false')
    await connect(peer('https://app.safe.global'))
    expect(renderer.toJSON()).toBe('true')
    await act(async () => renderer.unmount())
  })
})

describe('Safe execution wait', () => {
  it('passes the chain’s public client from the watched config', async () => {
    const chainClient = { getTransaction: vi.fn() }
    runtime.getPublicClient.mockReturnValue(chainClient)
    runtime.waitForSafeExecutionHash.mockResolvedValue(HASH)
    const signal = new AbortController().signal

    await expect(waitForSafeExecutionHash(10, HASH, { signal })).resolves.toBe(HASH)
    expect(runtime.getPublicClient).toHaveBeenCalledWith(config, { chainId: 10 })
    expect(runtime.waitForSafeExecutionHash).toHaveBeenLastCalledWith(10, HASH, {
      client: chainClient,
      signal,
    })

    await waitForSafeExecutionHash(1, HASH)
    expect(runtime.getPublicClient).toHaveBeenLastCalledWith(config, { chainId: 1 })
    expect(runtime.waitForSafeExecutionHash).toHaveBeenLastCalledWith(1, HASH, {
      client: chainClient,
    })
  })

  it('lets an explicit client win over the watched config', async () => {
    const client = { getTransaction: vi.fn() }
    runtime.waitForSafeExecutionHash.mockResolvedValue(HASH)

    await waitForSafeExecutionHash(10, HASH, { client })
    expect(runtime.waitForSafeExecutionHash).toHaveBeenLastCalledWith(10, HASH, { client })
    expect(runtime.getPublicClient).not.toHaveBeenCalled()
  })
})
