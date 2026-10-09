// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBridgePrepareTx } from '@bananapus/nana-sdk-core/v6'
import { maxUint256, pad, zeroAddress, type Address, type Hex } from 'viem'
import { bridgeCalldata, type BridgeMovement, type BridgeRoute } from '@/lib/sticky-bridge'
import {
  assertPendingBridgeWrite, bridgeStorageKey, createPendingBridgeWrite, discardBridgeDraft, readBridgeRecords, readPendingBridgeWrite, reconcileBridgeRecord,
  restoreBridgeWrite, saveBridgeRecords, savePendingBridgeWrite, storeBridgeWrite, updateBridgeRecords, withBridgeLock,
  readWatchedBridgeRoutes, saveWatchedBridgeRoute, savePendingBridgeSubmission, retryPendingBridgeSubmission,
  type BridgeRecord, type PendingBridgeWrite,
} from '@/lib/sticky-bridge-journal'

vi.mock('@/lib/jbcenter-rpc', () => ({ jbCenterPublicClient: vi.fn() }))
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
    await withBridgeLock(async () => saveWatchedBridgeRoute(10, stToken, 4008n, route))
    expect(readWatchedBridgeRoutes(10, stToken.toUpperCase().replace('0X', '0x') as Address, 4008n)).toEqual([recoveryRoute])
    savePendingBridgeWrite(owner, null)
    savePendingBridgeWrite(A(99), null)
    expect(readWatchedBridgeRoutes(10, stToken, 4008n)).toEqual([recoveryRoute])
    expect(readWatchedBridgeRoutes(8453, stToken, 4008n)).toEqual([])
    expect(readWatchedBridgeRoutes(10, A(99), 4008n)).toEqual([])
    expect(readWatchedBridgeRoutes(10, stToken, 0n)).toEqual([])
  })

  it('keeps only route hints, never saved readiness, transfer status or proof', () => {
    const forged = { ...route, canPrepare: true, status: 'claimed', proof: [H(1)], sourceVerified: true,
      source: { ...route.source, confirmed: true }, sourceMeta: { ...route.sourceMeta, verified: true } }
    saveWatchedBridgeRoute(10, stToken, 4008n, forged)
    expect(readWatchedBridgeRoutes(10, stToken, 4008n)).toEqual([recoveryRoute])
    expect(JSON.parse(localStorage.getItem(watchKey)!)).toEqual([recoveryRoute])
  })

  it('retains the original route after terminal, label and readiness changes without adding a duplicate', () => {
    saveWatchedBridgeRoute(10, stToken, 4008n, route)
    const original = localStorage.getItem(watchKey)
    saveWatchedBridgeRoute(10, stToken, 4008n, { ...route, terminal: A(88), canPrepare: false,
      sourceMeta: { symbol: 'RENAMED', decimals: 6 }, rewardMeta: { symbol: 'UPDATED', decimals: 8 } })
    expect(localStorage.getItem(watchKey)).toBe(original)
    expect(readWatchedBridgeRoutes(10, stToken, 4008n)).toEqual([recoveryRoute])
  })

  it.each<keyof BridgeRoute>(['destinationSucker', 'sourceProjectId', 'destinationProjectId', 'sourceToken', 'rewardToken', 'remoteBackingToken'])('rejects a conflicting %s on the same route identity without replacing evidence', field => {
    saveWatchedBridgeRoute(10, stToken, 4008n, route)
    const original = localStorage.getItem(watchKey)
    const changed = { ...route, [field]: field.endsWith('ProjectId') ? '99' : A(99) }
    expect(() => saveWatchedBridgeRoute(10, stToken, 4008n, changed)).toThrow('different endpoint binding')
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
  ])('refuses a forged %s watch on read and save without overwriting it', (_field, forged) => {
    const raw = JSON.stringify([forged])
    localStorage.setItem(watchKey, raw)
    expect(() => readWatchedBridgeRoutes(10, stToken, 4008n)).toThrow('route recovery data is invalid')
    expect(() => saveWatchedBridgeRoute(10, stToken, 4008n, route)).toThrow('route recovery data is invalid')
    expect(localStorage.getItem(watchKey)).toBe(raw)
    localStorage.removeItem(watchKey)
    expect(() => saveWatchedBridgeRoute(10, stToken, 4008n, forged as BridgeRoute)).toThrow('route recovery data is invalid')
    expect(localStorage.getItem(watchKey)).toBeNull()
  })

  it.each<[number, Address, bigint]>([[999, stToken, 0n], [10, zeroAddress, 0n], [10, stToken, 1n]])('rejects an invalid home pool scope %s/%s/%s before accessing storage', (homeChainId, stickyToken, groupId) => {
    const storage = { getItem: vi.fn(), setItem: vi.fn() }
    expect(() => readWatchedBridgeRoutes(homeChainId, stickyToken, groupId, storage)).toThrow('route recovery data is invalid')
    expect(() => saveWatchedBridgeRoute(homeChainId, stickyToken, groupId, route, storage)).toThrow('route recovery data is invalid')
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it.each(['not JSON', 'null', '{}', JSON.stringify([route, route])])('refuses malformed or duplicate route history (%s)', raw => {
    localStorage.setItem(watchKey, raw)
    expect(() => readWatchedBridgeRoutes(10, stToken, 4008n)).toThrow('route recovery data is invalid')
    expect(() => saveWatchedBridgeRoute(10, stToken, 4008n, route)).toThrow('route recovery data is invalid')
    expect(localStorage.getItem(watchKey)).toBe(raw)
  })

  it('allows an existing route at capacity and refuses a 101st route without losing history', () => {
    const routes = Array.from({ length: 100 }, (_, index) => ({ ...route, sourceSucker: A(index + 100) }))
    for (const route of routes) saveWatchedBridgeRoute(10, stToken, 4008n, route)
    const original = localStorage.getItem(watchKey)
    expect(() => saveWatchedBridgeRoute(10, stToken, 4008n, routes[0])).not.toThrow()
    expect(() => saveWatchedBridgeRoute(10, stToken, 4008n, route)).toThrow('route history is full')
    expect(localStorage.getItem(watchKey)).toBe(original)
    localStorage.setItem(watchKey, JSON.stringify([...routes, route]))
    expect(() => readWatchedBridgeRoutes(10, stToken, 4008n)).toThrow('route recovery data is invalid')
  })

  it('refuses denied storage or a write that does not survive readback', () => {
    expect(() => saveWatchedBridgeRoute(10, stToken, 4008n, route, { getItem: () => null, setItem: () => { throw new Error('Storage denied') } })).toThrow('Storage denied')
    expect(() => saveWatchedBridgeRoute(10, stToken, 4008n, route, { getItem: () => null, setItem: () => {} })).toThrow('route recovery could not be saved')
  })
})

describe('new bridge durable intent and source recovery', () => {
  it.each([false, true])('retains an exact returned hash through repeated save failures and retries its raw commit (Safe %s)', safeProposal => {
    const original = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    let raw: string | null = null, writable = true
    const storage = { getItem: () => raw, setItem: (_key: string, value: string) => {
      if (!writable) throw new Error('Storage unavailable')
      raw = value
    } }
    savePendingBridgeWrite(owner, original, storage)
    writable = false
    for (let attempt = 0; attempt < 2; attempt++) expect(() => savePendingBridgeSubmission(original, H(90), safeProposal, storage)).toThrow('Storage unavailable')
    const submitted = readPendingBridgeWrite(owner, storage)!
    expect(submitted).toEqual({ ...original, hash: H(90), safeProposal })
    expect(JSON.parse(raw!)).toEqual(original)
    expect(() => assertPendingBridgeWrite(submitted, storage)).toThrow('changed')
    expect(() => retryPendingBridgeSubmission(submitted, storage)).toThrow('Storage unavailable')
    expect(readPendingBridgeWrite(owner, { ...storage })).toEqual(original)
    expect(() => savePendingBridgeSubmission(original, H(91), safeProposal, storage)).toThrow('changed')
    writable = true
    retryPendingBridgeSubmission(submitted, storage)
    expect(JSON.parse(raw!)).toEqual(submitted)
    expect(() => assertPendingBridgeWrite(submitted, storage)).not.toThrow()
    savePendingBridgeWrite(owner, null, storage)
    expect(readPendingBridgeWrite(owner, storage)).toBeNull()
  })
  it.each(['id', 'hash', 'metadata'] as const)('never overlays or retries a retained reply after the raw %s changes', field => {
    const original = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request), recordKey: key, metadata })
    let raw = JSON.stringify(original)
    const storage = { getItem: () => raw, setItem: vi.fn(() => { throw new Error('Storage unavailable') }) }
    expect(() => savePendingBridgeSubmission(original, H(90), false, storage)).toThrow('Storage unavailable')
    const submitted = readPendingBridgeWrite(owner, storage)!
    const replacement = { ...original, [field]: field === 'id' ? crypto.randomUUID() : H(91) }
    raw = JSON.stringify(replacement)
    expect(() => retryPendingBridgeSubmission(submitted, storage)).toThrow('changed')
    expect(readPendingBridgeWrite(owner, storage)).toEqual(replacement)
    expect(() => retryPendingBridgeSubmission(submitted, storage)).toThrow('changed')
    expect(storage.setItem).toHaveBeenCalledOnce()
    expect(JSON.parse(raw)).toEqual(replacement)
  })
  it.each([false, true])('keeps an unreadable submission private until its exact reservation can be read (replaced %s)', replaced => {
    const original = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    const submitted = { ...original, hash: H(90), safeProposal: true }
    let readable = false, raw = JSON.stringify(original)
    const storage = { getItem: () => {
      if (!readable) throw new Error('Storage unavailable')
      return raw
    }, setItem: vi.fn((_key: string, value: string) => { raw = value }) }
    for (let attempt = 0; attempt < 2; attempt++) expect(() => savePendingBridgeSubmission(original, H(90), true, storage)).toThrow('Storage unavailable')
    expect(() => readPendingBridgeWrite(owner, storage)).toThrow('Storage unavailable')
    expect(() => retryPendingBridgeSubmission(submitted, storage)).toThrow('Storage unavailable')
    expect(storage.setItem).not.toHaveBeenCalled()
    const replacement = { ...original, id: crypto.randomUUID() }
    if (replaced) raw = JSON.stringify(replacement)
    readable = true
    expect(readPendingBridgeWrite(owner, storage)).toEqual(replaced ? replacement : submitted)
    if (replaced) expect(() => retryPendingBridgeSubmission(submitted, storage)).toThrow('changed')
    else {
      retryPendingBridgeSubmission(submitted, storage)
      expect(JSON.parse(raw)).toEqual(submitted)
    }
  })
  it('does not let an older unreadable repair overwrite a newer attempt’s retained reply', () => {
    const older = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    const newer = createPendingBridgeWrite({ owner, request: storeBridgeWrite(request) })
    let readable = true
    const storage = { getItem: () => {
      if (!readable) throw new Error('Storage unavailable')
      return JSON.stringify(newer)
    }, setItem: () => { throw new Error('Storage unavailable') } }
    expect(() => savePendingBridgeSubmission(newer, H(91), false, storage)).toThrow('Storage unavailable')
    readable = false
    expect(() => savePendingBridgeSubmission(older, H(90), false, storage)).toThrow('Storage unavailable')
    readable = true
    expect(readPendingBridgeWrite(owner, storage)).toEqual({ ...newer, hash: H(91), safeProposal: false })
    expect(() => retryPendingBridgeSubmission({ ...older, hash: H(90), safeProposal: false }, storage)).toThrow('changed')
  })
  it('binds returned hashes to unique full reservations while preserving readable legacy records', () => {
    const legacy = { owner, request: storeBridgeWrite(request), recordKey: key, metadata }
    savePendingBridgeWrite(owner, legacy)
    expect(readPendingBridgeWrite(owner)).toEqual(legacy)
    expect(() => savePendingBridgeSubmission(legacy, H(90))).toThrow('changed')
    const original = createPendingBridgeWrite(legacy)
    const replacement = createPendingBridgeWrite(legacy)
    expect(original.id).not.toBe(replacement.id)
    savePendingBridgeWrite(owner, original)
    const submitted = savePendingBridgeSubmission(original, H(90), false)
    expect(savePendingBridgeSubmission(original, H(90), false)).toEqual(submitted)
    for (const next of [replacement, { ...replacement, hash: H(91) }, { ...original, metadata: H(99) }]) {
      savePendingBridgeWrite(owner, next)
      expect(() => savePendingBridgeSubmission(original, H(90), false)).toThrow('changed')
      expect(readPendingBridgeWrite(owner)).toEqual(next)
    }
    savePendingBridgeWrite(owner, null)
    expect(() => savePendingBridgeSubmission(original, H(90))).toThrow('changed')
  })
  it.each(['', 'old-attempt', 7])('rejects a malformed optional reservation identity (%s)', id => {
    localStorage.setItem(`sticky:bridge:pending:v1:${owner.toLowerCase()}`, JSON.stringify({ owner, request: storeBridgeWrite(request), id }))
    expect(() => readPendingBridgeWrite(owner)).toThrow('Saved bridge recovery')
  })
  it('wallet-action:queue-cross-chain-rewards round-trips exact calldata, identity and approval-free request without losing integer precision', () => {
    saveBridgeRecords(key, [record])
    expect(readBridgeRecords(key)).toEqual([record])
    expect(bridgeCalldata(restoreBridgeWrite(readBridgeRecords(key)[0].steps[0]))).toBe(record.prepareData)
    expect(readBridgeRecords(bridgeStorageKey(10, stToken, 4008n, A(99)))).toEqual([])
  })
  it('refuses malformed or mis-scoped storage and never replaces it with an empty history', () => {
    localStorage.setItem(key, 'not JSON')
    expect(() => readBridgeRecords(key)).toThrow('Saved bridge recovery')
    expect(localStorage.getItem(key)).toBe('not JSON')
    localStorage.setItem(key, JSON.stringify([{ ...record, owner: A(99) }]))
    expect(() => readBridgeRecords(key)).toThrow('Saved bridge recovery')
  })
  it('rejects malformed original hash and nonboolean Safe routing flags', () => {
    localStorage.setItem(key, JSON.stringify([{ ...record, submission: { hash: H(90), safeProposal: 'false' } }]))
    expect(() => readBridgeRecords(key)).toThrow('Saved bridge recovery')
    localStorage.setItem(`sticky:bridge:pending:v1:${owner.toLowerCase()}`, JSON.stringify({ owner, request: storeBridgeWrite(request), hash: H(90), safeProposal: 'false' }))
    expect(() => readPendingBridgeWrite(owner)).toThrow('Saved bridge recovery')
  })
  it('requires durable verified storage before writing and retains history at its limit', () => {
    expect(() => savePendingBridgeWrite(owner, { owner, request: storeBridgeWrite(request) }, { getItem: () => null, setItem: () => {} })).toThrow('could not be saved')
    expect(() => saveBridgeRecords(key, Array<BridgeRecord>(101).fill(record))).toThrow('history is full')
  })
  it.each([undefined, H(90)])('accepts an unchanged pending snapshot with submission %s without writing storage', hash => {
    const held: PendingBridgeWrite = { owner, request: storeBridgeWrite(request), hash }
    let saved: string | null = null
    const storage = { getItem: () => saved, setItem: vi.fn((_key: string, value: string) => { saved = value }) }
    savePendingBridgeWrite(owner, held, storage)
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
    savePendingBridgeWrite(owner, held)
    const snapshot = readPendingBridgeWrite(owner)!
    const newer = replace(held)
    savePendingBridgeWrite(owner, newer)
    await expect(withBridgeLock(async () => {
      assertPendingBridgeWrite(snapshot)
      savePendingBridgeWrite(owner, null)
    })).rejects.toThrow('pending bridge transaction changed')
    expect(readPendingBridgeWrite(owner)).toEqual(newer)
  })
  it.each([null, 'null'])('refuses a disappeared pending snapshot (%s) without recreating it', raw => {
    const held: PendingBridgeWrite = { owner, request: storeBridgeWrite(request), hash: H(90) }
    const storage = { getItem: () => raw, setItem: vi.fn() }
    expect(() => assertPendingBridgeWrite(held, storage)).toThrow('pending bridge transaction changed')
    expect(storage.setItem).not.toHaveBeenCalled()
  })
  it.each(['not JSON', '{"owner":false}', '{"request":{}}'])('refuses malformed pending storage (%s) without modifying it', raw => {
    const held: PendingBridgeWrite = { owner, request: storeBridgeWrite(request), hash: H(90) }
    const storage = { getItem: () => raw, setItem: vi.fn() }
    expect(() => assertPendingBridgeWrite(held, storage)).toThrow()
    expect(storage.setItem).not.toHaveBeenCalled()
  })
  it('does not infer that an unknown submission without a hash was never sent', async () => {
    saveBridgeRecords(key, [record])
    savePendingBridgeWrite(owner, { owner, request: storeBridgeWrite(request), recordKey: key, metadata })
    expect(readPendingBridgeWrite(owner)?.hash).toBeUndefined()
    await expect(discardBridgeDraft(key, metadata)).rejects.toThrow('may still execute')
    expect(readBridgeRecords(key)).toHaveLength(1)
  })
  it('can cancel only a current unsubmitted draft and rereads before deleting an old rendered row', async () => {
    saveBridgeRecords(key, [record])
    await discardBridgeDraft(key, metadata)
    expect(readBridgeRecords(key)).toEqual([])
    saveBridgeRecords(key, [{ ...record, sourceHash: H(90) }])
    await expect(discardBridgeDraft(key, metadata)).rejects.toThrow('may still execute')
    expect(readBridgeRecords(key)[0].sourceHash).toBe(H(90))
  })
  it('does not release a copied metadata donor or a canonical-source proof failure', async () => {
    saveBridgeRecords(key, [record])
    const api = { verifySource: vi.fn().mockRejectedValue(new Error('Noncanonical')) }
    expect(await reconcileBridgeRecord(api, key, record, [{ ...row, caller: A(99) }])).toBe(false)
    expect(api.verifySource).not.toHaveBeenCalled()
    expect(await reconcileBridgeRecord(api, key, record, [row])).toBe(false)
    expect(readBridgeRecords(key)[0]).toMatchObject({ sourceVerified: false, status: 'recover' })
  })
  it('preserves historical hashes after a reorg and never labels them as verified', async () => {
    const historical = { ...record, sourceHash: H(90), sourceVerified: true }
    saveBridgeRecords(key, [historical])
    expect(await reconcileBridgeRecord({ verifySource: vi.fn() }, key, historical, [])).toBe(false)
    expect(readBridgeRecords(key)[0]).toMatchObject({ sourceHash: H(90), sourceVerified: false, status: 'recover' })
  })
  it('binds source recovery to the original Safe proposal, including a crash before its hash was copied into the transfer', async () => {
    saveBridgeRecords(key, [record])
    const submission = { hash: H(77), safeProposal: true }
    savePendingBridgeWrite(owner, { owner, request: storeBridgeWrite(request), metadata, recordKey: key, ...submission })
    const api = { verifySource: vi.fn().mockResolvedValue({}) }
    expect(await reconcileBridgeRecord(api, key, record, [row])).toBe(true)
    expect(api.verifySource).toHaveBeenCalledWith(route, row, owner, record.prepareData, submission)
    expect(readBridgeRecords(key)[0]).toMatchObject({ sourceHash: row.sourceHash, sourceVerified: true, leafIndex: '0', status: 'queued', steps: [] })
    expect(readPendingBridgeWrite(owner)).not.toBeNull()
  })
  it('checks amount and receiver after source proof, never treating a similar leaf as this transfer', async () => {
    saveBridgeRecords(key, [record])
    await expect(reconcileBridgeRecord({ verifySource: vi.fn().mockResolvedValue({}) }, key, record, [{ ...row, leaf: { ...row.leaf, projectTokenCount: 999n } }])).rejects.toThrow('does not match')
  })
  it('merges durable mutations under one storage lock and serializes wallet actions across tabs', async () => {
    await updateBridgeRecords(key, records => [...records, record])
    await updateBridgeRecords(key, records => [...records, { ...record, metadata: H(20) }])
    expect(readBridgeRecords(key)).toHaveLength(2)
    await withBridgeLock(async () => {})
    expect(locks.mock.calls.map(call => call[0])).toEqual(['sticky-reward-bridge-storage', 'sticky-reward-bridge-storage', 'sticky-reward-bridge'])
    vi.stubGlobal('navigator', {})
    await expect(withBridgeLock(async () => {})).rejects.toThrow('Web Locks')
  })
})
