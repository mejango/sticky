import { decodeFunctionData, isAddress, isHash, parseAbi, type Address, type Hex } from 'viem'
import { jbSuckerV6Abi } from '@bananapus/nana-sdk-core/v6'
import type { TxRequest } from '@/hooks/useSafeTx'
import { bridgeCalldata, type BridgeMovement, type BridgeRoute, type createStickyBridge } from '@/lib/sticky-bridge'

export type StoredBridgeWrite = { chainId: number; address: Address; data: Hex; value: string; label: string }
export type BridgeRecord = {
  metadata: Hex
  owner: Address
  amount: string
  route: BridgeRoute
  receiver: Address
  groupId: string
  stickyToken: Address
  stickyProjectId: string
  prepareData: Hex
  createdAt: number
  steps: StoredBridgeWrite[]
  /** A returned hash supplements the authoritative write-ahead intent below. */
  submission?: { hash: Hex; safeProposal?: boolean }
  sourceHash?: Hex
  sourceVerified?: boolean
  leafIndex?: string
  status?: BridgeMovement['status'] | 'recover'
}
export type BridgeStorage = Pick<Storage, 'getItem' | 'setItem'>
export type PendingBridgeWrite = {
  owner: Address
  request: StoredBridgeWrite
  hash?: Hex
  safeProposal?: boolean
  recordKey?: string
  metadata?: Hex
}
const PREFIX = 'sticky:bridge:v3:'
export const bridgeStorageKey = (chainId: number, stickyToken: Address, groupId: bigint, owner: Address) =>
  `${PREFIX}${chainId}:${stickyToken.toLowerCase()}:${groupId}:${owner.toLowerCase()}`
const FAILED = 'Saved bridge recovery data is invalid. Keep this browser’s data and recover the original transfer before sending again.'

export function storeBridgeWrite(request: TxRequest): StoredBridgeWrite {
  return { chainId: request.chainId, address: request.address, data: bridgeCalldata(request), value: String(request.value ?? 0n), label: request.label ?? request.functionName }
}
export function restoreBridgeWrite(request: StoredBridgeWrite): TxRequest {
  const abi = [...jbSuckerV6Abi, ...parseAbi(['function approve(address spender, uint256 amount)'])]
  const decoded = decodeFunctionData({ abi, data: request.data })
  return { chainId: request.chainId, address: request.address, abi, functionName: decoded.functionName, args: decoded.args ?? [], value: BigInt(request.value), label: request.label }
}
function validWrite(write: StoredBridgeWrite): boolean {
  return !!write && Number.isSafeInteger(write.chainId) && isAddress(write.address, { strict: false }) && /^0x(?:[0-9a-f]{2})+$/i.test(write.data) && /^\d+$/.test(write.value) && typeof write.label === 'string'
}
/** Durable records are evidence hints only; route and source proofs are always re-read. */
export function readBridgeRecords(key: string, storage: BridgeStorage = localStorage): BridgeRecord[] {
  const raw = storage.getItem(key)
  if (raw === null) return []
  let records: BridgeRecord[]
  try { records = JSON.parse(raw) } catch { throw new Error(FAILED) }
  if (!Array.isArray(records) || records.length > 100 || records.some(record =>
    !record || !isHash(record.metadata) || !isAddress(record.owner, { strict: false }) || !/^\d+$/.test(record.amount) || !record.route?.source || !record.route?.destination ||
    !isAddress(record.receiver, { strict: false }) || !isAddress(record.stickyToken, { strict: false }) || !/^\d+$/.test(record.groupId) || !/^\d+$/.test(record.stickyProjectId) ||
    !/^0xaf629bbb[0-9a-f]{320}$/i.test(record.prepareData) || !Number.isFinite(record.createdAt) || !Array.isArray(record.steps) || record.steps.length > 3 || record.steps.some(write => !validWrite(write)) ||
    (record.submission && (!isHash(record.submission.hash) || (record.submission.safeProposal !== undefined && typeof record.submission.safeProposal !== 'boolean'))) ||
    key !== bridgeStorageKey(record.route.destination.chainId, record.stickyToken, BigInt(record.groupId), record.owner)
  )) throw new Error(FAILED)
  return records
}
export function saveBridgeRecords(key: string, records: BridgeRecord[], storage: BridgeStorage = localStorage): void {
  if (records.length > 100) throw new Error('This browser’s saved bridge history is full. Existing transfers can still be recovered; no new transfer was submitted.')
  const encoded = JSON.stringify(records)
  storage.setItem(key, encoded)
  if (storage.getItem(key) !== encoded) throw new Error('Bridge recovery could not be saved. No new transfer will be submitted.')
}
/** One write lock spans preparation, review and wallet submission, including other tabs. */
export async function withBridgeLock<T>(work: () => Promise<T>, wait = false): Promise<T> {
  if (!navigator.locks?.request) throw new Error('This browser cannot safely coordinate cross-chain transfers. Use a current browser with Web Locks support.')
  return navigator.locks.request('sticky-reward-bridge', { mode: 'exclusive', ...(!wait ? { ifAvailable: true } : {}) }, async lock => {
    if (!lock) throw new Error('A bridge action is already open in another tab.')
    return work()
  })
}
export async function updateBridgeRecords(key: string, update: (records: BridgeRecord[]) => BridgeRecord[], storage: BridgeStorage = localStorage) {
  if (!navigator.locks?.request) throw new Error('This browser cannot safely save bridge recovery across tabs.')
  return navigator.locks.request('sticky-reward-bridge-storage', { mode: 'exclusive' }, () => {
    const records = update(readBridgeRecords(key, storage))
    saveBridgeRecords(key, records, storage)
    return records
  })
}
export async function updateBridgeRecord(key: string, metadata: Hex, update: (record: BridgeRecord) => BridgeRecord) {
  return updateBridgeRecords(key, records => {
    const at = records.findIndex(record => record.metadata === metadata)
    if (at < 0) throw new Error('The saved bridge transfer disappeared. Refresh before continuing.')
    records[at] = update(records[at])
    return records
  })
}
export async function discardBridgeDraft(key: string, metadata: Hex) {
  return updateBridgeRecords(key, records => {
    const record = records.find(item => item.metadata === metadata)
    if (record && (record.submission || record.sourceHash || record.sourceVerified || readPendingBridgeWrite(record.owner)?.metadata === metadata)) throw new Error('This transfer may still execute. Recover its original transaction before cancelling.')
    return records.filter(item => item.metadata !== metadata)
  })
}
/** A copied metadata value or a noncanonical source log cannot release a saved prepare. */
export async function reconcileBridgeRecord(
  api: Pick<ReturnType<typeof createStickyBridge>, 'verifySource'>,
  key: string,
  record: BridgeRecord,
  rows: BridgeMovement[],
) {
  let found: BridgeMovement | undefined
  const pending = readPendingBridgeWrite(record.owner)
  const submission = record.submission ?? (pending?.metadata === record.metadata && pending.hash ? { hash: pending.hash, safeProposal: pending.safeProposal } : undefined)
  for (const row of rows.filter(item => item.leaf.metadata === record.metadata && item.caller.toLowerCase() === record.owner.toLowerCase())) {
    try { await api.verifySource(record.route, row, record.owner, record.prepareData, submission); found = row; break } catch { /* Keep the historical record until its exact source succeeds. */ }
  }
  if (found && (found.leaf.projectTokenCount !== BigInt(record.amount) || found.leaf.beneficiary.toLowerCase() !== `0x${record.receiver.slice(2).toLowerCase().padStart(64, '0')}`)) throw new Error('The recovered bridge leaf does not match the saved transfer.')
  await updateBridgeRecord(key, record.metadata, current => found
    ? { ...current, sourceHash: found.sourceHash, sourceVerified: true, leafIndex: String(found.leaf.index), status: found.status, steps: [] }
    : { ...current, sourceVerified: false, status: 'recover' })
  return !!found
}

const pendingKey = (owner: Address) => `sticky:bridge:pending:v1:${owner.toLowerCase()}`
export function readPendingBridgeWrite(owner: Address, storage: BridgeStorage = localStorage): PendingBridgeWrite | null {
  const raw = storage.getItem(pendingKey(owner))
  if (raw === null || raw === 'null') return null
  let value: PendingBridgeWrite
  try { value = JSON.parse(raw) } catch { throw new Error(FAILED) }
  if (!value || value.owner?.toLowerCase() !== owner.toLowerCase() || !validWrite(value.request) || (value.hash !== undefined && !isHash(value.hash)) || (value.metadata !== undefined && !isHash(value.metadata)) || (value.safeProposal !== undefined && typeof value.safeProposal !== 'boolean') || ((value.recordKey === undefined) !== (value.metadata === undefined)) || (value.recordKey !== undefined && typeof value.recordKey !== 'string')) throw new Error(FAILED)
  return value
}
/** Persist before any wallet call; clearing requires an explicit rejection or canonical exact-call proof. */
export function savePendingBridgeWrite(owner: Address, value: PendingBridgeWrite | null, storage: BridgeStorage = localStorage) {
  const encoded = JSON.stringify(value)
  storage.setItem(pendingKey(owner), encoded)
  if (storage.getItem(pendingKey(owner)) !== encoded) throw new Error('Bridge recovery could not be saved. No new transfer will be submitted.')
}
