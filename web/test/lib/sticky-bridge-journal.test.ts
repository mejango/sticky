// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LockLostError } from '@bananapus/nana-sdk-core/review/locks'
import { buildBridgePrepareTx } from '@bananapus/nana-sdk-core/v6'
import { maxUint256, pad, zeroAddress, type Address, type Hex } from 'viem'
import { bridgeCalldata, type BridgeMovement, type BridgeRoute } from '@/lib/sticky-bridge'
import {
  adoptSettlementHash, endPendingBridgeAttempt, assertPendingBridgeWrite, bridgeStorageKey, createPendingBridgeWrite, discardBridgeDraft, readBridgeRecords, readPendingBridgeWrite, reconcileBridgeRecord,
  restoreBridgeWrite, saveBridgeRecords, savePendingBridgeWrite, storeBridgeWrite, updateBridgeRecords, withBridgeLock,
  readWatchedBridgeRoutes, saveWatchedBridgeRoute, savePendingBridgeSubmission, retryPendingBridgeSubmission,
  type BridgeRecord, type PendingBridgeWrite,
} from '@/lib/sticky-bridge-journal'

vi.mock('@/lib/jbcenter-public-client', () => ({ jbCenterPublicClient: vi.fn() }))
const A = (value: number) => `0x${BigInt(value).toString(16).padStart(40, '0')}` as Address
const H = (value: number) => `0x${BigInt(value).toString(16).padStart(64, '0')}` as Hex
const route: BridgeRoute = {
  source: { chainId: 1 }, destination: { chainId: 10 }, sourceSucker: A(1), destinationSucker: A(2), sourceProjectId: '21', destinationProjectId: '22',
  sourceToken: A(3), rewardToken: A(4), backingToken: A(5), remoteBackingToken: A(6), terminal: A(7), sourceMeta: { symbol: 'SRC', decimals: 18 }, rewardMeta: { symbol: 'DST', decimals: 18 }, backingMeta: { symbol: 'ETH', decimals: 18 }, canPrepare: true,
}
const owner = A(10), receiver = A(11), stToken = A(12), metadata = H(13)
const request = buildBridgePrepareTx({ chainId: 1, sucker: route.sourceSucker, projectTokenCount: 1000n, beneficiary: receiver, minTokensReclaimed: 1n, token: route.backingToken, metadata })
const record: BridgeRecord = { metadata, owner, receiver, stickyToken: stToken, stickyProjectId: '31', groupId: '4008', route, amount: '1000', prepareData: bridgeCalldata(request), createdAt: 1_000, steps: [storeBridgeWrite(request)] }
const key = bridgeStorageKey(10, stToken, 4008n, owner)
const row = { leaf: { index: 0n, beneficiary: pad(receiver), projectTokenCount: 1000n, terminalTokenAmount: 1n, metadata }, caller: owner, sourceHash: H(14), leafHash: H(15), status: 'queued' } as BridgeMovement
/** The bridge lock, held throughout: each journal write checks it. */
const HELD = { assertHeld: async () => {} }
const locks = vi.fn(async (_name: string, _options: unknown, work: (lock: object) => unknown) => work({}))
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('navigator', { locks: { request: locks } })
  locks.mockClear()
})

describe('pool-scoped bridge route recovery hints', () => {
  const watchKey = `sticky:bridge:watch:v1:10:${stToken.toLowerCase()}:4008`
  const recoveryRoute = { ...route, canPrepare: false }

  it('keeps the route across reload and wallet changes, scoped to the home token and reward group', async () => {
    expect(readWatchedBridgeRoutes(10, stToken, 4008n)).toEqual([])
    await withBridgeLock(async () => await saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, route))
    expect(readWatchedBridgeRoutes(10, stToken.toUpperCase().replace('0X', '0x') as Address, 4008n)).toEqual([recoveryRoute])
    await savePendingBridgeWrite(HELD, owner, null)
    await savePendingBridgeWrite(HELD, A(99), null)
    expect(readWatchedBridgeRoutes(10, stToken, 4008n)).toEqual([recoveryRoute])
    expect(readWatchedBridgeRoutes(8453, stToken, 4008n)).toEqual([])
    expect(readWatchedBridgeRoutes(10, A(99), 4008n)).toEqual([])
    expect(readWatchedBridgeRoutes(10, stToken, 0n)).toEqual([])
  })

  it('keeps only route hints, never saved readiness, transfer status or proof', async () => {
    const forged = { ...route, canPrepare: true, status: 'claimed', proof: [H(1)], sourceVerified: true,
      source: { ...route.source, confirmed: true }, sourceMeta: { ...route.sourceMeta, verified: true } }
    await saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, forged)
    expect(readWatchedBridgeRoutes(10, stToken, 4008n)).toEqual([recoveryRoute])
    expect(JSON.parse(localStorage.getItem(watchKey)!)).toEqual([recoveryRoute])
  })

  it('retains the original route after terminal, label and readiness changes without adding a duplicate', async () => {
    await saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, route)
    const original = localStorage.getItem(watchKey)
    await saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, { ...route, terminal: A(88), canPrepare: false,
      sourceMeta: { symbol: 'RENAMED', decimals: 6 }, rewardMeta: { symbol: 'UPDATED', decimals: 8 } })
    expect(localStorage.getItem(watchKey)).toBe(original)
    expect(readWatchedBridgeRoutes(10, stToken, 4008n)).toEqual([recoveryRoute])
  })

  it.each<keyof BridgeRoute>(['destinationSucker', 'sourceProjectId', 'destinationProjectId', 'sourceToken', 'rewardToken', 'remoteBackingToken'])('rejects a conflicting %s on the same route identity without replacing evidence', async field => {
    await saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, route)
    const original = localStorage.getItem(watchKey)
    const changed = { ...route, [field]: field.endsWith('ProjectId') ? '99' : A(99) }
    await expect(saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, changed)).rejects.toThrow('different endpoint binding')
    expect(localStorage.getItem(watchKey)).toBe(original)
  })

  it.each<[string, unknown]>([
    ['missing route', null],
    ['missing source', { ...route, source: null }],
    ['unsupported source', { ...route, source: { chainId: 999 } }],
    ['wrong home', { ...route, destination: { chainId: 8453 } }],
    ['same chain', { ...route, source: { chainId: 10 } }],
    ['different environment', { ...route, source: { chainId: 11155111 } }],
    ['zero source project', { ...route, sourceProjectId: '0' }],
    ['noncanonical project', { ...route, sourceProjectId: '021' }],
    ['overflowed destination project', { ...route, destinationProjectId: String(maxUint256 + 1n) }],
    ['zero source sucker', { ...route, sourceSucker: zeroAddress }],
    ['zero destination sucker', { ...route, destinationSucker: zeroAddress }],
    ['credits-only source token', { ...route, sourceToken: zeroAddress }],
    ['zero reward token', { ...route, rewardToken: zeroAddress }],
    ['invalid backing token', { ...route, backingToken: '0x1234' }],
    ['zero remote backing token', { ...route, remoteBackingToken: zeroAddress }],
    ['zero terminal', { ...route, terminal: zeroAddress }],
    ['missing metadata', { ...route, sourceMeta: null }],
    ['oversized symbol', { ...route, sourceMeta: { symbol: 'x'.repeat(257), decimals: 18 } }],
    ['nonstring symbol', { ...route, rewardMeta: { symbol: 42, decimals: 18 } }],
    ['negative decimals', { ...route, backingMeta: { symbol: 'ETH', decimals: -1 } }],
    ['fractional decimals', { ...route, backingMeta: { symbol: 'ETH', decimals: 1.5 } }],
    ['unsupported decimals', { ...route, backingMeta: { symbol: 'ETH', decimals: 37 } }],
  ])('refuses a forged %s watch on read and save without overwriting it', async (_field, forged) => {
    const raw = JSON.stringify([forged])
    localStorage.setItem(watchKey, raw)
    expect(() => readWatchedBridgeRoutes(10, stToken, 4008n)).toThrow('route recovery data is invalid')
    await expect(saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, route)).rejects.toThrow('route recovery data is invalid')
    expect(localStorage.getItem(watchKey)).toBe(raw)
    localStorage.removeItem(watchKey)
    await expect(saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, forged as BridgeRoute)).rejects.toThrow('route recovery data is invalid')
    expect(localStorage.getItem(watchKey)).toBeNull()
  })

  it.each<[number, Address, bigint]>([[999, stToken, 0n], [10, zeroAddress, 0n], [10, stToken, 1n]])('rejects an invalid home pool scope %s/%s/%s before accessing storage', async (homeChainId, stickyToken, groupId) => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() }
    expect(() => readWatchedBridgeRoutes(homeChainId, stickyToken, groupId, storage)).toThrow('route recovery data is invalid')
    await expect(saveWatchedBridgeRoute(HELD, homeChainId, stickyToken, groupId, route, storage)).rejects.toThrow('route recovery data is invalid')
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it.each(['not JSON', 'null', '{}', JSON.stringify([route, route])])('refuses malformed or duplicate route history (%s)', async raw => {
    localStorage.setItem(watchKey, raw)
    expect(() => readWatchedBridgeRoutes(10, stToken, 4008n)).toThrow('route recovery data is invalid')
    await expect(saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, route)).rejects.toThrow('route recovery data is invalid')
    expect(localStorage.getItem(watchKey)).toBe(raw)
  })

  it('allows an existing route at capacity and refuses a 101st route without losing history', async () => {
    const routes = Array.from({ length: 100 }, (_, index) => ({ ...route, sourceSucker: A(index + 100) }))
    for (const route of routes) await saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, route)
    const original = localStorage.getItem(watchKey)
    await saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, routes[0])
    await expect(saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, route)).rejects.toThrow('route history is full')
    expect(localStorage.getItem(watchKey)).toBe(original)
    localStorage.setItem(watchKey, JSON.stringify([...routes, route]))
    expect(() => readWatchedBridgeRoutes(10, stToken, 4008n)).toThrow('route recovery data is invalid')
  })

  it('refuses denied storage or a write that does not survive readback', async () => {
    await expect(saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, route, { getItem: () => null, setItem: () => { throw new Error('Storage denied') } })).rejects.toThrow('Storage denied')
    await expect(saveWatchedBridgeRoute(HELD, 10, stToken, 4008n, route, { getItem: () => null, setItem: () => {} })).rejects.toThrow('route recovery could not be saved')
  })
})

describe('a settlement keeps its authenticated result in the journal', () => {
  it('stores the result with the adopted hash, and again when the same hash is adopted with a result', async () => {
    const original = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    let raw: string | null = null
    const storage = { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value } }
    await savePendingBridgeWrite(HELD, owner, original, storage)
    const adopted = await adoptSettlementHash(HELD, owner, original.id, H(90), storage, 'success')
    expect(adopted).toMatchObject({ hash: H(90), settled: 'success' })
    expect(readPendingBridgeWrite(owner, storage)).toMatchObject({ hash: H(90), settled: 'success' })
    // A hash saved without a result learns it when the SDK's settlement arrives.
    const bare = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    await savePendingBridgeWrite(HELD, owner, null, storage)
    await savePendingBridgeWrite(HELD, owner, { ...bare, hash: H(91) }, storage)
    await adoptSettlementHash(HELD, owner, bare.id, H(91), storage, 'success')
    expect(readPendingBridgeWrite(owner, storage)).toMatchObject({ hash: H(91), settled: 'success' })
  })
})

describe('a Safe proposal keeps its authenticated success', () => {
  const store = () => {
    let raw: string | null = null
    return { getItem: () => raw, setItem: (_key: string, value: string) => { raw = value } }
  }

  it('records the result next to the proposal identity, and the attempt can no longer be ended', async () => {
    const storage = store()
    const proposal = { ...createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) }), hash: H(90), safeProposal: true }
    await savePendingBridgeWrite(HELD, owner, proposal, storage)
    const adopted = await adoptSettlementHash(HELD, owner, proposal.id, H(91), storage, 'success')
    expect(adopted).toMatchObject({ hash: H(90), safeProposal: true, settled: 'success', settledHash: H(91) })
    await endPendingBridgeAttempt(HELD, owner, proposal.id, storage)
    expect(readPendingBridgeWrite(owner, storage)).toMatchObject({ settled: 'success' })
  })

  it('still ends an attempt with no saved success', async () => {
    const storage = store()
    const pending = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    await savePendingBridgeWrite(HELD, owner, pending, storage)
    await endPendingBridgeAttempt(HELD, owner, pending.id, storage)
    expect(readPendingBridgeWrite(owner, storage)).toBeNull()
  })
})

describe('new bridge durable intent and source recovery', () => {
  it.each([false, true])('retains an exact returned hash through repeated save failures and retries its raw commit (Safe %s)', async safeProposal => {
    const original = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    let raw: string | null = null, writable = true
    const storage = { getItem: () => raw, setItem: (_key: string, value: string) => {
      if (!writable) throw new Error('Storage unavailable')
      raw = value
    } }
    await savePendingBridgeWrite(HELD, owner, original, storage)
    writable = false
    for (let attempt = 0; attempt < 2; attempt++) await expect(savePendingBridgeSubmission(HELD, original, H(90), safeProposal, storage)).rejects.toThrow('Storage unavailable')
    const submitted = readPendingBridgeWrite(owner, storage)!
    expect(submitted).toEqual({ ...original, hash: H(90), safeProposal })
    expect(JSON.parse(raw!)).toEqual(original)
    expect(() => assertPendingBridgeWrite(submitted, storage)).toThrow('changed')
    await expect(retryPendingBridgeSubmission(HELD, submitted, storage)).rejects.toThrow('Storage unavailable')
    expect(readPendingBridgeWrite(owner, { ...storage })).toEqual(original)
    await expect(savePendingBridgeSubmission(HELD, original, H(91), safeProposal, storage)).rejects.toThrow('changed')
    writable = true
    await retryPendingBridgeSubmission(HELD, submitted, storage)
    expect(JSON.parse(raw!)).toEqual(submitted)
    expect(() => assertPendingBridgeWrite(submitted, storage)).not.toThrow()
    await savePendingBridgeWrite(HELD, owner, null, storage)
    expect(readPendingBridgeWrite(owner, storage)).toBeNull()
  })
  it.each(['id', 'hash', 'metadata'] as const)('never overlays or retries a retained reply after the raw %s changes', async field => {
    const original = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request), recordKey: key, metadata })
    let raw = JSON.stringify(original)
    const storage = { getItem: () => raw, setItem: vi.fn(() => { throw new Error('Storage unavailable') }) }
    await expect(savePendingBridgeSubmission(HELD, original, H(90), false, storage)).rejects.toThrow('Storage unavailable')
    const submitted = readPendingBridgeWrite(owner, storage)!
    const replacement = { ...original, [field]: field === 'id' ? crypto.randomUUID() : H(91) }
    raw = JSON.stringify(replacement)
    await expect(retryPendingBridgeSubmission(HELD, submitted, storage)).rejects.toThrow('changed')
    expect(readPendingBridgeWrite(owner, storage)).toEqual(replacement)
    await expect(retryPendingBridgeSubmission(HELD, submitted, storage)).rejects.toThrow('changed')
    expect(storage.setItem).toHaveBeenCalledOnce()
    expect(JSON.parse(raw)).toEqual(replacement)
  })
  it.each([false, true])('keeps an unreadable submission private until its exact reservation can be read (replaced %s)', async replaced => {
    const original = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    const submitted = { ...original, hash: H(90), safeProposal: true }
    let readable = false, raw = JSON.stringify(original)
    const storage = { getItem: () => {
      if (!readable) throw new Error('Storage unavailable')
      return raw
    }, setItem: vi.fn((_key: string, value: string) => { raw = value }) }
    for (let attempt = 0; attempt < 2; attempt++) await expect(savePendingBridgeSubmission(HELD, original, H(90), true, storage)).rejects.toThrow('Storage unavailable')
    expect(() => readPendingBridgeWrite(owner, storage)).toThrow('Storage unavailable')
    await expect(retryPendingBridgeSubmission(HELD, submitted, storage)).rejects.toThrow('Storage unavailable')
    expect(storage.setItem).not.toHaveBeenCalled()
    const replacement = { ...original, id: crypto.randomUUID() }
    if (replaced) raw = JSON.stringify(replacement)
    readable = true
    expect(readPendingBridgeWrite(owner, storage)).toEqual(replaced ? replacement : submitted)
    if (replaced) await expect(retryPendingBridgeSubmission(HELD, submitted, storage)).rejects.toThrow('changed')
    else {
      await retryPendingBridgeSubmission(HELD, submitted, storage)
      expect(JSON.parse(raw)).toEqual(submitted)
    }
  })
  it('does not let an older unreadable repair overwrite a newer attempt’s retained reply', async () => {
    const older = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    const newer = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    let readable = true
    const storage = { getItem: () => {
      if (!readable) throw new Error('Storage unavailable')
      return JSON.stringify(newer)
    }, setItem: () => { throw new Error('Storage unavailable') } }
    await expect(savePendingBridgeSubmission(HELD, newer, H(91), false, storage)).rejects.toThrow('Storage unavailable')
    readable = false
    await expect(savePendingBridgeSubmission(HELD, older, H(90), false, storage)).rejects.toThrow('Storage unavailable')
    readable = true
    expect(readPendingBridgeWrite(owner, storage)).toEqual({ ...newer, hash: H(91), safeProposal: false })
    await expect(retryPendingBridgeSubmission(HELD, { ...older, hash: H(90), safeProposal: false }, storage)).rejects.toThrow('changed')
  })
  it('binds returned hashes to unique full reservations while preserving readable legacy records', async () => {
    const legacy = { owner, request: storeBridgeWrite(request), recordKey: key, metadata }
    await savePendingBridgeWrite(HELD, owner, legacy)
    expect(readPendingBridgeWrite(owner)).toEqual(legacy)
    await expect(savePendingBridgeSubmission(HELD, legacy, H(90))).rejects.toThrow('changed')
    const original = createPendingBridgeWrite(legacy)
    const replacement = createPendingBridgeWrite(legacy)
    expect(original.id).not.toBe(replacement.id)
    await savePendingBridgeWrite(HELD, owner, original)
    const submitted = await savePendingBridgeSubmission(HELD, original, H(90), false)
    expect(await savePendingBridgeSubmission(HELD, original, H(90), false)).toEqual(submitted)
    for (const next of [replacement, { ...replacement, hash: H(91) }, { ...original, metadata: H(99) }]) {
      await savePendingBridgeWrite(HELD, owner, next)
      await expect(savePendingBridgeSubmission(HELD, original, H(90), false)).rejects.toThrow('changed')
      expect(readPendingBridgeWrite(owner)).toEqual(next)
    }
    await savePendingBridgeWrite(HELD, owner, null)
    await expect(savePendingBridgeSubmission(HELD, original, H(90))).rejects.toThrow('changed')
  })
  it.each(['', 'old-attempt', 7])('rejects a malformed optional reservation identity (%s)', async id => {
    localStorage.setItem(`sticky:bridge:pending:v1:${owner.toLowerCase()}`, JSON.stringify({ owner, request: storeBridgeWrite(request), id }))
    expect(() => readPendingBridgeWrite(owner)).toThrow('Saved bridge recovery')
  })
  it('wallet-action:queue-cross-chain-rewards round-trips exact calldata, identity and approval-free request without losing integer precision', async () => {
    await saveBridgeRecords(HELD, key, [record])
    expect(readBridgeRecords(key)).toEqual([record])
    expect(bridgeCalldata(restoreBridgeWrite(readBridgeRecords(key)[0].steps[0]))).toBe(record.prepareData)
    expect(readBridgeRecords(bridgeStorageKey(10, stToken, 4008n, A(99)))).toEqual([])
  })
  it('refuses malformed or mis-scoped storage and never replaces it with an empty history', async () => {
    localStorage.setItem(key, 'not JSON')
    expect(() => readBridgeRecords(key)).toThrow('Saved bridge recovery')
    expect(localStorage.getItem(key)).toBe('not JSON')
    localStorage.setItem(key, JSON.stringify([{ ...record, owner: A(99) }]))
    expect(() => readBridgeRecords(key)).toThrow('Saved bridge recovery')
  })
  it('rejects malformed original hash and nonboolean Safe routing flags', async () => {
    localStorage.setItem(key, JSON.stringify([{ ...record, submission: { hash: H(90), safeProposal: 'false' } }]))
    expect(() => readBridgeRecords(key)).toThrow('Saved bridge recovery')
    localStorage.setItem(`sticky:bridge:pending:v1:${owner.toLowerCase()}`, JSON.stringify({ owner, request: storeBridgeWrite(request), hash: H(90), safeProposal: 'false' }))
    expect(() => readPendingBridgeWrite(owner)).toThrow('Saved bridge recovery')
  })
  it('requires durable verified storage before writing and retains history at its limit', async () => {
    await expect(savePendingBridgeWrite(HELD, owner, { owner, request: storeBridgeWrite(request) }, { getItem: () => null, setItem: () => {} })).rejects.toThrow('could not be saved')
    await expect(saveBridgeRecords(HELD, key, Array<BridgeRecord>(101).fill(record))).rejects.toThrow('history is full')
  })
  it.each([undefined, H(90)])('accepts an unchanged pending snapshot with submission %s without writing storage', async hash => {
    const held: PendingBridgeWrite = { owner, request: storeBridgeWrite(request), hash }
    let saved: string | null = null
    const storage = { getItem: () => saved, setItem: vi.fn((_key: string, value: string) => { saved = value }) }
    await savePendingBridgeWrite(HELD, owner, held, storage)
    const snapshot = readPendingBridgeWrite(owner, storage)!
    storage.setItem.mockClear()
    expect(() => assertPendingBridgeWrite(snapshot, storage)).not.toThrow()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(readPendingBridgeWrite(owner, storage)).toEqual(snapshot)
  })
  it.each<[string, (held: PendingBridgeWrite) => PendingBridgeWrite]>([
    ['reservation despite identical calldata', held => ({ ...held, id: crypto.randomUUID() })],
    ['hash despite identical calldata', held => ({ ...held, hash: H(91) })],
    ['Safe routing flag', held => ({ ...held, safeProposal: true })],
    ['chain', held => ({ ...held, request: { ...held.request, chainId: 10 } })],
    ['contract', held => ({ ...held, request: { ...held.request, address: A(99) } })],
    ['calldata', held => ({ ...held, request: { ...held.request, data: '0x12345678' } })],
    ['value', held => ({ ...held, request: { ...held.request, value: '1' } })],
    ['label', held => ({ ...held, request: { ...held.request, label: 'Another delivery' } })],
    ['record key', held => ({ ...held, recordKey: `${key}:new` })],
    ['metadata', held => ({ ...held, metadata: H(92) })],
  ])('refuses stale recovery after the pending %s changes and leaves the newer write intact', async (_field, replace) => {
    const held: PendingBridgeWrite = { owner, request: storeBridgeWrite(request), hash: H(90), safeProposal: false, recordKey: key, metadata }
    await savePendingBridgeWrite(HELD, owner, held)
    const snapshot = readPendingBridgeWrite(owner)!
    const newer = replace(held)
    await savePendingBridgeWrite(HELD, owner, newer)
    await expect(withBridgeLock(async () => {
      assertPendingBridgeWrite(snapshot)
      await savePendingBridgeWrite(HELD, owner, null)
    })).rejects.toThrow('pending bridge transaction changed')
    expect(readPendingBridgeWrite(owner)).toEqual(newer)
  })
  it.each([null, 'null'])('refuses a disappeared pending snapshot (%s) without recreating it', async raw => {
    const held: PendingBridgeWrite = { owner, request: storeBridgeWrite(request), hash: H(90) }
    const storage = { getItem: () => raw, setItem: vi.fn() }
    expect(() => assertPendingBridgeWrite(held, storage)).toThrow('pending bridge transaction changed')
    expect(storage.setItem).not.toHaveBeenCalled()
  })
  it.each(['not JSON', '{"owner":false}', '{"request":{}}'])('refuses malformed pending storage (%s) without modifying it', async raw => {
    const held: PendingBridgeWrite = { owner, request: storeBridgeWrite(request), hash: H(90) }
    const storage = { getItem: () => raw, setItem: vi.fn() }
    expect(() => assertPendingBridgeWrite(held, storage)).toThrow()
    expect(storage.setItem).not.toHaveBeenCalled()
  })
  it('does not infer that an unknown submission without a hash was never sent', async () => {
    await saveBridgeRecords(HELD, key, [record])
    await savePendingBridgeWrite(HELD, owner, { owner, request: storeBridgeWrite(request), recordKey: key, metadata })
    expect(readPendingBridgeWrite(owner)?.hash).toBeUndefined()
    await expect(discardBridgeDraft(HELD, key, metadata)).rejects.toThrow('may still execute')
    expect(readBridgeRecords(key)).toHaveLength(1)
  })
  it('can cancel only a current unsubmitted draft and rereads before deleting an old rendered row', async () => {
    await saveBridgeRecords(HELD, key, [record])
    await discardBridgeDraft(HELD, key, metadata)
    expect(readBridgeRecords(key)).toEqual([])
    await saveBridgeRecords(HELD, key, [{ ...record, sourceHash: H(90) }])
    await expect(discardBridgeDraft(HELD, key, metadata)).rejects.toThrow('may still execute')
    expect(readBridgeRecords(key)[0].sourceHash).toBe(H(90))
  })
  it('does not release a copied metadata donor or a canonical-source proof failure', async () => {
    await saveBridgeRecords(HELD, key, [record])
    const api = { verifySource: vi.fn().mockRejectedValue(new Error('Noncanonical')) }
    expect(await reconcileBridgeRecord(HELD, api, key, record, [{ ...row, caller: A(99) }])).toBe(false)
    expect(api.verifySource).not.toHaveBeenCalled()
    expect(await reconcileBridgeRecord(HELD, api, key, record, [row])).toBe(false)
    expect(readBridgeRecords(key)[0]).toMatchObject({ sourceVerified: false, status: 'recover' })
  })
  it('preserves historical hashes after a reorg and never labels them as verified', async () => {
    const historical = { ...record, sourceHash: H(90), sourceVerified: true }
    await saveBridgeRecords(HELD, key, [historical])
    expect(await reconcileBridgeRecord(HELD, { verifySource: vi.fn() }, key, historical, [])).toBe(false)
    expect(readBridgeRecords(key)[0]).toMatchObject({ sourceHash: H(90), sourceVerified: false, status: 'recover' })
  })
  it('binds source recovery to the original Safe proposal, including a crash before its hash was copied into the transfer', async () => {
    await saveBridgeRecords(HELD, key, [record])
    const submission = { hash: H(77), safeProposal: true }
    await savePendingBridgeWrite(HELD, owner, { owner, request: storeBridgeWrite(request), metadata, recordKey: key, ...submission })
    const api = { verifySource: vi.fn().mockResolvedValue({}) }
    expect(await reconcileBridgeRecord(HELD, api, key, record, [row])).toBe(true)
    expect(api.verifySource).toHaveBeenCalledWith(route, row, owner, record.prepareData, submission)
    expect(readBridgeRecords(key)[0]).toMatchObject({ sourceHash: row.sourceHash, sourceVerified: true, leafIndex: '0', status: 'queued', steps: [] })
    expect(readPendingBridgeWrite(owner)).not.toBeNull()
  })
  it('checks amount and receiver after source proof, never treating a similar leaf as this transfer', async () => {
    await saveBridgeRecords(HELD, key, [record])
    await expect(reconcileBridgeRecord(HELD, { verifySource: vi.fn().mockResolvedValue({}) }, key, record, [{ ...row, leaf: { ...row.leaf, projectTokenCount: 999n } }])).rejects.toThrow('does not match')
  })
  it('reconciles from a status refresh, which holds no lock, only while the bridge lock is free', async () => {
    await saveBridgeRecords(HELD, key, [record])
    const api = { verifySource: vi.fn().mockResolvedValue({}) }
    // Another action holds the bridge lock: the refresh writes nothing, and that action reconciles the record itself.
    vi.stubGlobal('navigator', { locks: { request: async (name: string, options: { ifAvailable?: boolean }, work: (lock: object | null) => unknown) =>
      work(name === 'sticky-reward-bridge' && options.ifAvailable ? null : {}) } })
    await expect(reconcileBridgeRecord(null, api, key, record, [row])).resolves.toBe(true)
    expect(readBridgeRecords(key)[0].sourceVerified).toBeUndefined()
    vi.stubGlobal('navigator', { locks: { request: locks } })
    await expect(reconcileBridgeRecord(null, api, key, record, [row])).resolves.toBe(true)
    expect(readBridgeRecords(key)[0].sourceVerified).toBe(true)
  })

  it('writes nothing once the bridge lock is lost: every journal write checks it first', async () => {
    const lost = new LockLostError('sticky-reward-bridge')
    const LOST = { assertHeld: async () => { throw lost } }
    await saveBridgeRecords(HELD, key, [record])
    const held = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    await savePendingBridgeWrite(HELD, owner, held)
    // Sticky's own keys: the SDK's storage-lock bookkeeping is its own.
    const sticky = () => Object.fromEntries(Object.entries({ ...localStorage }).filter(([key]) => key.startsWith('sticky:')))
    const before = sticky()
    await expect(saveBridgeRecords(LOST, key, [])).rejects.toBe(lost)
    await expect(updateBridgeRecords(LOST, key, () => [])).rejects.toBe(lost)
    await expect(savePendingBridgeWrite(LOST, owner, null)).rejects.toBe(lost)
    await expect(savePendingBridgeSubmission(LOST, held, H(90))).rejects.toBe(lost)
    await expect(endPendingBridgeAttempt(LOST, owner, held.id)).rejects.toBe(lost)
    await expect(saveWatchedBridgeRoute(LOST, 10, stToken, 4008n, route)).rejects.toBe(lost)
    expect(sticky()).toEqual(before)
  })

  it('merges durable mutations under one storage lock and serializes wallet actions across tabs', async () => {
    await updateBridgeRecords(HELD, key, records => [...records, record])
    await updateBridgeRecords(HELD, key, records => [...records, { ...record, metadata: H(20) }])
    expect(readBridgeRecords(key)).toHaveLength(2)
    await withBridgeLock(async () => {})
    expect(locks.mock.calls.map(call => call[0])).toEqual(['sticky-reward-bridge-storage', 'sticky-reward-bridge-storage', 'sticky-reward-bridge'])
    // Without Web Locks, the SDK's fallback lock still runs the action (R119).
    vi.stubGlobal('navigator', {})
    await expect(withBridgeLock(async () => 'ran')).resolves.toBe('ran')
    await expect(updateBridgeRecords(HELD, key, records => records)).resolves.toHaveLength(2)
  })
})
