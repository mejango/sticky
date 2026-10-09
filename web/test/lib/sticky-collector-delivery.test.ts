import { buildStickyCollectorSendTx, buildStickyCollectorSettleTx } from '@bananapus/nana-sdk-core/v6'
import { zeroAddress } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeCalldata } from '@/lib/sticky-bridge'
import { storeBridgeWrite } from '@/lib/sticky-bridge-journal'
import { collectorWriteKind, createStickyCollectorDelivery } from '@/lib/sticky-collector-delivery'
import {
  COLLECTOR_SOURCE as SOURCE, COLLECTOR_OWNER as OWNER, COLLECTOR_ROUTE as ROUTE,
  collectorAddress as A, collectorHash as H, localCollectorSource,
} from '../collector-fixtures'

const mocks = vi.hoisted(() => ({ verify: vi.fn(), pending: vi.fn(), tokenMeta: vi.fn(), transportValue: vi.fn() }))
vi.mock('@/lib/sticky-collector', () => ({ createStickyCollector: () => mocks }))
vi.mock('@/lib/sticky-bridge', async original => ({ ...(await original<typeof import('@/lib/sticky-bridge')>()), createStickyBridge: () => mocks }))
const model = createStickyCollectorDelivery()
beforeEach(() => {
  mocks.verify.mockReset().mockResolvedValue(SOURCE.verified)
  mocks.pending.mockReset().mockResolvedValue(10n)
  mocks.tokenMeta.mockReset().mockResolvedValue(ROUTE.sourceMeta)
  mocks.transportValue.mockReset().mockResolvedValue(77n)
})

describe('collector execution preparation', () => {
  it('wallet-action:deliver-queued-rewards uses the SDK send for a partial bucket and quotes its exact atomic transaction for the caller', async () => {
    const result = await model.prepare(SOURCE, OWNER, 3n)
    expect(result.request).toMatchObject({ chainId: 1, address: SOURCE.allocation.deployment.address, functionName: 'send', args: [3n, SOURCE.allocation.stickyToken, 4000n, 3n, ROUTE.sourceSucker, ROUTE.backingToken], value: 77n })
    expect(result.pending).toBe(10n)
    const [route, caller, build] = mocks.transportValue.mock.calls[0]
    expect(route).toEqual(ROUTE)
    expect(caller).toBe(OWNER)
    expect(build(123n)).toMatchObject({ ...result.request, value: 123n })
    expect(bridgeCalldata(result.request)).toBe(bridgeCalldata(buildStickyCollectorSendTx({ ...SOURCE.allocation, amount: 3n, sucker: ROUTE.sourceSucker, backingToken: ROUTE.backingToken, value: 77n })))
  })

  it('wallet-action:settle-queued-rewards settles on the selected home chain without constructing a remote payment', async () => {
    const source = localCollectorSource()
    mocks.verify.mockResolvedValue(source.verified)
    const result = await model.prepare(source, OWNER, 4n)
    expect(result.request).toMatchObject({ chainId: 10, functionName: 'settle', args: [3n, source.allocation.stickyToken, 4000n, 4n] })
    expect(result.request.value).toBeUndefined()
    expect(mocks.transportValue).not.toHaveBeenCalled()
  })

  it.each([0n, -1n, 11n])('refuses amount %s outside the fresh remaining allocation', async amount => {
    await expect(model.prepare(SOURCE, OWNER, amount)).rejects.toThrow('remaining queued allocation')
    expect(mocks.transportValue).not.toHaveBeenCalled()
  })

  it('shows accepted credits but refuses delivery before source token deployment', async () => {
    const credits = { ...SOURCE, verified: { ...SOURCE.verified, sourceToken: zeroAddress } }
    expect(await model.read(credits)).toEqual({ pending: 10n, meta: { symbol: 'Project #3 credits', decimals: 18 } })
    expect(mocks.tokenMeta).not.toHaveBeenCalled()
    mocks.verify.mockResolvedValue(credits.verified)
    await expect(model.prepare(credits, OWNER, 1n)).rejects.toThrow('Deploy the source project’s ERC-20')
  })

  it('rechecks queue custody and refuses increased transport budgets or receiver changes after review', async () => {
    const reviewed = await model.prepare(SOURCE, OWNER, 7n)
    mocks.pending.mockResolvedValue(6n)
    await expect(model.reverify(reviewed, OWNER)).rejects.toThrow('remaining queued allocation')
    mocks.pending.mockResolvedValue(10n)
    mocks.transportValue.mockResolvedValue(78n)
    await expect(model.reverify(reviewed, OWNER)).rejects.toThrow('changed')
    mocks.transportValue.mockResolvedValue(70n)
    await expect(model.reverify(reviewed, OWNER)).resolves.toBeUndefined()
    mocks.verify.mockResolvedValue({ ...SOURCE.verified, receiver: A(99) })
    await expect(model.reverify(reviewed, OWNER)).rejects.toThrow('changed')
  })

  it('keeps a zero-fee transport payment at zero', async () => {
    mocks.transportValue.mockResolvedValue(0n)
    expect((await model.prepare(SOURCE, OWNER, 1n)).request.value).toBe(0n)
  })
})

describe('collector pending scope', () => {
  const pending = () => ({ owner: OWNER, request: storeBridgeWrite(buildStickyCollectorSendTx({ ...SOURCE.allocation, amount: 3n, sucker: ROUTE.sourceSucker, backingToken: ROUTE.backingToken, value: 77n })) })
  it('recognizes only this allocation and direct route, never a linked prepare record', () => {
    const held = pending()
    expect(collectorWriteKind(SOURCE, held)).toBe('send')
    expect(collectorWriteKind(SOURCE, { ...held, metadata: H(3), recordKey: 'prepare' })).toBeNull()
    expect(collectorWriteKind(SOURCE, { ...held, request: { ...held.request, chainId: 10 } })).toBeNull()
    expect(collectorWriteKind(SOURCE, { ...held, request: { ...held.request, address: A(99) } })).toBeNull()
    expect(collectorWriteKind({ ...SOURCE, allocation: { ...SOURCE.allocation, groupId: 0n } }, held)).toBeNull()
    expect(collectorWriteKind({ ...SOURCE, bridgeRoute: { ...ROUTE, sourceSucker: A(99) } }, held)).toBeNull()
    expect(collectorWriteKind(SOURCE, { ...held, request: { ...held.request, data: '0x12345678' } })).toBeNull()
  })
  it('recognizes home-chain settlement for its exact source project and group', () => {
    const source = localCollectorSource()
    const held = { owner: OWNER, request: storeBridgeWrite(buildStickyCollectorSettleTx({ ...source.allocation, amount: 2n })) }
    expect(collectorWriteKind(source, held)).toBe('settle')
    expect(collectorWriteKind(SOURCE, held)).toBeNull()
  })
})
