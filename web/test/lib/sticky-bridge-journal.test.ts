// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildBridgePrepareTx } from '@bananapus/nana-sdk-core/v6'
import { pad, type Address, type Hex } from 'viem'
import { bridgeCalldata, type BridgeMovement, type BridgeRoute } from '@/lib/sticky-bridge'
import {
  bridgeStorageKey, discardBridgeDraft, readBridgeRecords, readPendingBridgeWrite, reconcileBridgeRecord,
  restoreBridgeWrite, saveBridgeRecords, savePendingBridgeWrite, storeBridgeWrite, updateBridgeRecords, withBridgeLock,
  type BridgeRecord,
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

describe('new bridge durable intent and source recovery', () => {
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
