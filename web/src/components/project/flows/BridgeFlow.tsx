'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits, isAddress, isHash, toHex, type Address, type Hex } from 'viem'
import { ReceiverFlow } from '@/components/project/flows/ReceiverFlow'
import { reviewGate } from '@/components/project/flows/review-gate'
import { FIELD_INPUT, FIELD_LABEL, StakeAgeFields } from '@/components/project/StakeAgeFields'
import { ModalShell } from '@/components/ui/ModalShell'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { confirmAction, sendingStatus, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx, type TxRequest } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { parseAmount } from '@/lib/sticky-amount'
import { bridgeCalldata, bridgeRouteId, bridgeWriteHasUniqueReference, createStickyBridge, type BridgeMovement, type BridgeRoute } from '@/lib/sticky-bridge'
import {
  assertPendingBridgeWrite, bridgeStorageKey, createPendingBridgeWrite, discardBridgeDraft, readBridgeRecords, readPendingBridgeWrite, readWatchedBridgeRoutes, reconcileBridgeRecord,
  restoreBridgeWrite, retryPendingBridgeSubmission, savePendingBridgeWrite, savePendingBridgeSubmission, storeBridgeWrite, updateBridgeRecord, updateBridgeRecords, withBridgeLock,
  type BridgeRecord, type PendingBridgeWrite,
} from '@/lib/sticky-bridge-journal'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { readReceiver } from '@/lib/sticky-receivers'
import { refreshAfterFund } from '@/lib/sticky-refresh'
import { groupIdFromWeeks, groupLabel } from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'
import type { JBChainId } from '@bananapus/nana-sdk-core'

const bridge = createStickyBridge()
type Item = { route: BridgeRoute; row: BridgeMovement }
type Review = {
  owner: Address
  identity: string
  key: string
  request: TxRequest
  route: BridgeRoute
  receiver: Address
  record?: BridgeRecord
  movement?: BridgeMovement
  rows: TxConfirmRow[]
  confirmedAt?: bigint
  attempt?: PendingBridgeWrite
}
const messages = {
  queued: 'Queued on the origin chain. Ready to send.',
  'in-flight': 'Crossing chains. Refresh after the bridge delivers.',
  claimable: 'Arrived. Ready to claim into rewards.',
  claimed: 'Claimed into the receiver. Settle its remaining balance into airdrops.',
}
const changed = 'The wallet, project or bridge changed. Review this transfer again.'

/** The complete cross-chain airdrop, with saved exact requests and independently verified effects. */
export function BridgeFlow({ info, sourceChainId, delivery, onClose, onFunded }: {
  info: StickyProjectInfo
  sourceChainId: JBChainId
  /** Watch collector deliveries without preparing another wallet-funded transfer. The group is fixed. */
  delivery?: { route?: BridgeRoute; groupId: bigint }
  onClose: () => void
  onFunded: (token: Address) => void
}) {
  const wallet = useWallet()
  const client = useQueryClient()
  const id = useId()
  const [token, setToken] = useState('')
  const [amount, setAmount] = useState('')
  const [minWeeks, setMinWeeks] = useState('')
  const [maxWeeks, setMaxWeeks] = useState('')
  const [routes, setRoutes] = useState<BridgeRoute[]>(delivery?.route ? [delivery.route] : [])
  const [selected, setSelected] = useState(0)
  const [records, setRecords] = useState<BridgeRecord[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingBridgeWrite | null>(null)
  const [recoveryHash, setRecoveryHash] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settle, setSettle] = useState<{ token: Address; groupId: bigint; identity: string } | null>(null)
  const tx = useSafeTx(review?.request.chainId ?? sourceChainId)
  const generation = useRef(0)
  const handledHash = useRef<Hex | null>(null)
  const identity = `${info.chainId}:${info.projectId}:${info.stToken}:${sourceChainId}:${wallet.address ?? ''}:${minWeeks}:${maxWeeks}:${delivery?.groupId ?? 'manual'}:${delivery?.route ? bridgeRouteId(delivery.route) : ''}`
  const currentIdentity = useRef(identity)
  useEffect(() => { currentIdentity.current = identity; generation.current += 1; return () => { currentIdentity.current = ''; generation.current += 1 } }, [identity])
  const active = review?.identity === identity ? review : null
  const busy = working || tx.busy || tx.phase === 'review'

  const assertCurrent = (expected: string) => {
    if (currentIdentity.current !== expected) throw new Error(changed)
  }
  const owner = () => {
    const gate = reviewGate(wallet)
    if (!gate) { wallet.openSignIn(); throw new Error('Sign in with the wallet that holds the origin tokens.') }
    if (gate.refusal) throw new Error(gate.refusal)
    return gate.account
  }
  async function context() {
    const groupId = delivery?.groupId ?? groupIdFromWeeks(minWeeks, maxWeeks)
    const account = owner()
    if (delivery?.route && (delivery.route.source.chainId !== sourceChainId || delivery.route.destination.chainId !== info.chainId)) {
      throw new Error('The saved route does not belong to this source and home chain.')
    }
    const receiver = (await readReceiver(info.chainId, info.stToken, groupId)).address
    assertCurrent(identity)
    return { groupId, account, receiver, key: bridgeStorageKey(info.chainId, info.stToken, groupId, account) }
  }
  async function refresh() {
    const mine = ++generation.current
    try {
      const account = owner()
      setPending(readPendingBridgeWrite(account))
      const contextValue = await context()
      const saved = readBridgeRecords(contextValue.key)
      if (mine === generation.current) setRecords(saved)
      const watched = readWatchedBridgeRoutes(info.chainId, info.stToken, contextValue.groupId)
      const selectedRoutes = delivery ? (delivery.route ? [delivery.route] : []) : routes
      const allRoutes = new Map([...watched, ...selectedRoutes].map(route => [bridgeRouteId(route), route]))
      for (const record of saved) allRoutes.set(bridgeRouteId(record.route), record.route)
      const next: Item[] = []
      const failures: string[] = []
      for (const route of allRoutes.values()) {
        if (route.source.chainId !== sourceChainId || route.destination.chainId !== info.chainId) continue
        try {
          const rows = await bridge.movements(route, contextValue.receiver)
          for (const record of saved.filter(item => bridgeRouteId(item.route) === bridgeRouteId(route))) await reconcileBridgeRecord(bridge, contextValue.key, record, rows)
          next.push(...rows.map(row => ({ route, row })))
        } catch (reason) { failures.push((reason as Error).message) }
      }
      if (mine !== generation.current) return
      setRecords(readBridgeRecords(contextValue.key))
      setItems(next)
      setLoadedIdentity(identity)
      setPending(readPendingBridgeWrite(contextValue.account))
      setError(failures.length ? `Some delivery routes could not be read: ${failures.join(' ')}` : null)
    } catch (reason) { if (mine === generation.current) setError((reason as Error).message) }
  }
  useEffect(() => {
    if (!wallet.address) return
    void refresh()
    // Changing the scoped destination/account/group starts a new recovery read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])

  async function run(work: () => Promise<void>) {
    if (busy) return
    setWorking(true); setError(null)
    try { await withBridgeLock(work) } catch (reason) { setError((reason as Error).message) } finally { setWorking(false) }
  }
  async function findRoutes() {
    const checked = token.trim()
    if (!isAddress(checked, { strict: false })) throw new Error('Enter the project token’s address on the origin chain.')
    const found = await bridge.discover({ source: { chainId: sourceChainId }, destination: { chainId: info.chainId as JBChainId }, sourceToken: checked })
    assertCurrent(identity)
    if (!found.length) throw new Error('This token has no verified direct bridge to this chain.')
    setRoutes(found); setSelected(0)
  }
  const rowsFor = (record: BridgeRecord): TxConfirmRow[] => [
    { label: 'Send', value: `${formatUnits(BigInt(record.amount), record.route.sourceMeta.decimals)} ${record.route.sourceMeta.symbol} on ${chainName(record.route.source.chainId)}`, strong: true },
    { label: 'Origin token', value: record.route.sourceToken, mono: true },
    { label: 'Bridge contract', value: record.route.sourceSucker, mono: true },
    { label: 'Receive', value: `${record.route.rewardMeta.symbol} on ${chainName(record.route.destination.chainId)}` },
    { label: 'Reward address', value: record.receiver, mono: true },
    { label: 'Rewards', value: groupLabel(BigInt(record.groupId)) },
    { label: 'Minimum backing', value: `${formatUnits(BigInt(restoreBridgeWrite(record.steps.at(-1)!).args[2] as bigint), record.route.backingMeta.decimals)} ${record.route.backingMeta.symbol}` },
    { label: 'Transfer reference', value: record.metadata, mono: true },
    { label: 'Afterward', value: 'Send the queued batch, wait for delivery, claim the arrival, then settle it into airdrops.' },
  ]
  async function start(record?: BridgeRecord) {
    if (delivery) throw new Error('Use the allocation panel to deliver queued collector rewards.')
    const { account, receiver, groupId, key } = await context()
    if (readPendingBridgeWrite(account)) throw new Error('Recover the pending bridge transaction before starting another.')
    const saved = readBridgeRecords(key)
    if (!record && saved.length >= 100) throw new Error('This browser’s saved bridge history is full. Recover existing transfers first.')
    for (const previous of saved) {
      if (previous.metadata === record?.metadata && !previous.submission && !previous.sourceHash) continue
      if (!(await reconcileBridgeRecord(bridge, key, previous, await bridge.movements(previous.route, receiver)))) throw new Error('Recover the saved origin transfer before starting another bridge transfer.')
    }
    const route = record?.route ?? routes[selected]
    if (!route || route.source.chainId !== sourceChainId || route.destination.chainId !== info.chainId) throw new Error('Find and review this token’s bridge first.')
    const count = record ? BigInt(record.amount) : parseAmount(amount, route.sourceMeta.decimals)
    const metadata = record?.metadata ?? toHex(crypto.getRandomValues(new Uint8Array(32)))
    const plan = await bridge.prepare({ route, owner: account, amount: count, receiver, metadata })
    assertCurrent(identity)
    const next: BridgeRecord = { metadata, owner: account, receiver, groupId: String(groupId), stickyToken: info.stToken, stickyProjectId: String(info.projectId), route, amount: String(count), prepareData: bridgeCalldata(plan.steps.at(-1)!), createdAt: record?.createdAt ?? Date.now(), steps: plan.steps.map(storeBridgeWrite) }
    if (record) await updateBridgeRecord(key, record.metadata, current => {
      if (current.submission || current.sourceHash) throw new Error('This transfer may still execute. Recover it first.')
      return next
    })
    else await updateBridgeRecords(key, current => [...current, next])
    assertCurrent(identity)
    tx.reset(); handledHash.current = null
    setReview({ identity, owner: account, key, receiver, route, record: next, request: plan.steps[0], rows: rowsFor(next) })
    setRecords(readBridgeRecords(key))
  }
  async function reviewMovement(item: Item) {
    if (item.route.source.chainId !== sourceChainId || item.route.destination.chainId !== info.chainId || loadedIdentity !== identity) {
      throw new Error('This arrival belongs to another source or home chain. Refresh delivery status.')
    }
    const { account, receiver, key, groupId } = await context()
    if (readPendingBridgeWrite(account)) throw new Error('Recover the pending bridge transaction before starting another.')
    const request = item.row.status === 'queued' ? await bridge.flush(item.route, account, receiver) : await bridge.claim(item.route, item.row, account, receiver)
    assertCurrent(identity)
    tx.reset(); handledHash.current = null
    setReview({ identity, owner: account, key, receiver, route: item.route, movement: item.row, request, rows: [
      { label: 'Reward token', value: item.route.rewardToken, mono: true }, { label: 'Reward address', value: receiver, mono: true },
      { label: 'Rewards', value: groupLabel(groupId) }, { label: 'On', value: chainName(request.chainId) },
      { label: 'Bridge contract', value: request.address, mono: true },
      { label: 'Bridge transport budget', value: `${formatUnits(request.value ?? 0n, 18)} ETH` },
      { label: 'Source transaction', value: item.row.sourceHash, mono: true },
    ] })
  }
  async function verifyReview(current: Review) {
    assertCurrent(current.identity)
    if (current.record) {
      const live = await bridge.prepare({ route: current.route, owner: current.owner, amount: BigInt(current.record.amount), receiver: current.receiver, metadata: current.record.metadata })
      const reviewed = storeBridgeWrite(current.request)
      if (!live.steps.some(step => {
        const candidate = storeBridgeWrite(step)
        return candidate.chainId === reviewed.chainId && candidate.address.toLowerCase() === reviewed.address.toLowerCase() && candidate.data.toLowerCase() === reviewed.data.toLowerCase() && candidate.value === reviewed.value
      })) throw new Error('The saved bridge step or quote changed. Close and review the transfer again.')
    } else {
      const live = current.request.functionName === 'toRemote' ? await bridge.flush(current.route, current.owner, current.receiver) : await bridge.claim(current.route, current.movement!, current.owner, current.receiver)
      if (bridgeCalldata(live) !== bridgeCalldata(current.request) || (live.value ?? 0n) > (current.request.value ?? 0n)) throw new Error('The bridge changed. Close and review this step again.')
    }
    assertCurrent(current.identity)
  }
  async function confirm() {
    if (!active || busy) return
    const current = active
    await run(async () => {
      if (readPendingBridgeWrite(current.owner)) throw new Error('Recover the pending bridge transaction before sending it again.')
      const held = createPendingBridgeWrite({ owner: current.owner, request: storeBridgeWrite(current.request), ...(current.record ? { metadata: current.record.metadata, recordKey: current.key } : {}) })
      setReview({ ...current, attempt: held })
      let reserved = false
      const undo = async () => {
        assertPendingBridgeWrite(held)
        savePendingBridgeWrite(current.owner, null)
      }
      await tx.send(current.request, {
        reviewedAccount: current.owner, reviewedInParent: true, simulationBlockNumber: current.confirmedAt,
        reverify: () => verifyReview(current),
        durableRecovery: {
          reserve: async () => {
            assertCurrent(current.identity)
            try { savePendingBridgeWrite(current.owner, held); reserved = true } catch (reason) {
              // This callback has not reached the wallet; undo a partial local write.
              try { if (readPendingBridgeWrite(current.owner)) await undo() } catch { /* Preserve another attempt or unreadable storage. */ }
              throw reason
            }
          },
          releaseUnsubmitted: undo,
          submitted: async (hash, safeProposal) => {
            // A queued Safe proposal can be adopted without reserving a new write.
            if (!reserved && !readPendingBridgeWrite(current.owner)) { savePendingBridgeWrite(current.owner, held); reserved = true }
            const submitted = savePendingBridgeSubmission(held, hash, safeProposal)
            if (current.record && current.request.functionName === 'prepare') await updateBridgeRecord(current.key, current.record.metadata, record => {
              assertPendingBridgeWrite(submitted)
              return { ...record, submission: { hash, safeProposal } }
            })
          },
        },
      })
      setPending(readPendingBridgeWrite(current.owner))
    })
  }
  async function recover(hash: Hex, held: PendingBridgeWrite) {
    retryPendingBridgeSubmission(held)
    assertPendingBridgeWrite(held)
    const outcome = await bridge.verifyWrite({ chainId: held.request.chainId as JBChainId }, held.owner, hash, { ...held.request, value: BigInt(held.request.value) }, held.hash ? { hash: held.hash, safeProposal: held.safeProposal } : undefined)
    assertPendingBridgeWrite(held)
    if (held.metadata && held.recordKey) {
      const record = readBridgeRecords(held.recordKey).find(item => item.metadata === held.metadata)
      if (!record) throw new Error('The saved transfer is missing. Keep the transaction hash for recovery.')
      if (held.request.data === record.prepareData && outcome.success) {
        if (!(await reconcileBridgeRecord(bridge, held.recordKey, record, await bridge.movements(record.route, record.receiver), held))) throw new Error('The source transaction is confirmed. Its exact bridge event is not available yet; refresh to recover it.')
      } else await updateBridgeRecord(held.recordKey, held.metadata, current => {
        assertPendingBridgeWrite(held)
        return { ...current, submission: undefined, steps: outcome.success && current.steps[0]?.data === held.request.data ? current.steps.slice(1) : current.steps }
      })
    }
    assertPendingBridgeWrite(held)
    savePendingBridgeWrite(held.owner, null)
    setPending(null)
    if (!outcome.success) throw new Error('The bridge transaction reverted. Its saved transfer can be reviewed again.')
    refreshAfterFund(client, info.chainId, Number(info.projectId), held.owner)
    return outcome.receipt.blockNumber
  }
  useEffect(() => {
    if (tx.phase !== 'success' || !tx.hash || !active || handledHash.current === tx.hash) return
    const current = active, hash = tx.hash
    const submissionHash = tx.submissionHash, safeProposal = tx.submissionIsSafe
    void withBridgeLock(async () => {
      let held = readPendingBridgeWrite(current.owner)
      if (!held) return
      // The engine retains its actual wallet reply if the original hash save
      // failed. Repair that exact intent under its owner lock before recovery.
      if (!current.attempt || !(submissionHash ?? held.hash)) throw new Error('The original wallet attempt is unavailable. Recover its saved transaction before continuing.')
      held = savePendingBridgeSubmission(current.attempt, (submissionHash ?? held.hash)!, submissionHash ? safeProposal : held.safeProposal)
      if (current.record && current.request.functionName === 'prepare') await updateBridgeRecord(current.key, current.record.metadata,
        record => { assertPendingBridgeWrite(held!); return { ...record, submission: { hash: held!.hash!, safeProposal: held!.safeProposal } } })
      const confirmedAt = await recover(hash, held)
      handledHash.current = hash
      assertCurrent(current.identity)
      const record = current.record && readBridgeRecords(current.key).find(item => item.metadata === current.record!.metadata)
      if (record?.steps.length) {
        tx.reset(); handledHash.current = null
        setReview({ ...current, record: { ...current.record!, steps: record.steps }, confirmedAt, request: restoreBridgeWrite(record.steps[0]) })
      } else { setReview(null); tx.reset() }
      await refresh()
    }, true).catch(reason => setError((reason as Error).message))
    // Each canonical hash is processed once, against the frozen review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase, tx.hash, tx.submissionHash, tx.submissionIsSafe, active])

  function closeReview() {
    generation.current += 1
    setReview(null)
    tx.dismiss()
    void refresh()
  }
  return (
    <ModalShell title={delivery ? "Track reward delivery" : "Airdrop across chains"} onClose={active ? closeReview : onClose} busy={busy} maxWidth="max-w-lg">
      <div className="space-y-3">
        <p className="text-sm text-muted">From {chainName(sourceChainId)} to {chainName(info.chainId)}.</p>
        {delivery ? <p className="text-sm text-muted">{groupLabel(delivery.groupId)}. Only verified bridge arrivals can be claimed into this pool’s rewards.</p> : <>
        <label htmlFor={`${id}-token`} className={FIELD_LABEL}>Origin project token</label>
        <input disabled={busy || !!active} id={`${id}-token`} className={`${FIELD_INPUT} font-mono text-xs`} value={token} placeholder="0x…" onChange={event => { setToken(event.target.value); setRoutes([]) }} />
        <button className="btn-link" disabled={busy} onClick={() => void run(findRoutes)}>Find bridge</button>
        {routes.length ? <label className={FIELD_LABEL}>Bridge route<select disabled={busy || !!active} className={FIELD_INPUT} value={selected} onChange={event => setSelected(Number(event.target.value))}>{routes.map((route, index) => <option key={bridgeRouteId(route)} value={index}>{route.sourceMeta.symbol} → {route.rewardMeta.symbol} via {route.backingMeta.symbol}{route.canPrepare ? '' : ' (recovery only)'}</option>)}</select></label> : null}
        <fieldset disabled={busy || !!active}><StakeAgeFields minWeeks={minWeeks} maxWeeks={maxWeeks} onMinWeeks={setMinWeeks} onMaxWeeks={setMaxWeeks} /></fieldset>
        <label htmlFor={`${id}-amount`} className={FIELD_LABEL}>Amount</label>
        <input disabled={busy || !!active} id={`${id}-amount`} className={FIELD_INPUT} value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" placeholder="100" />
        <div className="flex flex-wrap gap-3"><button className="btn-primary" disabled={busy || !!pending || !routes[selected]?.canPrepare} onClick={() => void run(() => start())}>Review transfer</button></div>
        </>}
        <button className="btn-link" disabled={busy} onClick={() => void refresh()}>Refresh bridge status</button>
        {pending ? <div role="status" className="space-y-2 border-t border-line pt-3">
          <p className="text-sm">A bridge transaction may still execute. Check its wallet status before continuing.</p>
          {!pending.hash && !bridgeWriteHasUniqueReference(pending.request.data) ? <p className="text-sm text-muted">The wallet did not return a submission reference. A matching historical approval or bridge-send transaction cannot prove this attempt finished; this browser keeps further bridge actions locked.</p> : null}
          {pending.safeProposal ? <p className="text-sm text-muted">Open the Safe queue and finish its approvals. Use the executed transaction hash below when it is ready.</p> : null}
          <label htmlFor={`${id}-hash`} className={FIELD_LABEL}>Executed transaction hash</label>
          <input id={`${id}-hash`} className={`${FIELD_INPUT} font-mono text-xs`} value={recoveryHash} placeholder={pending.safeProposal ? '0x…' : pending.hash ?? '0x…'} onChange={event => setRecoveryHash(event.target.value)} />
          <button className="btn-link" disabled={busy} onClick={() => void run(async () => {
            const hash = recoveryHash || (!pending.safeProposal ? pending.hash : '')
            if (!hash || !isHash(hash)) throw new Error('Enter the executed transaction hash from the wallet.')
            await recover(hash, pending); await refresh()
          })}>Check transaction</button>
        </div> : null}
        {records.filter(record => loadedIdentity === identity && !record.sourceVerified && !delivery).map(record => <div key={record.metadata} className="space-y-2 border-t border-line pt-3">
          <p className="text-sm">Saved transfer: {formatUnits(BigInt(record.amount), record.route.sourceMeta.decimals)} {record.route.sourceMeta.symbol} from {chainName(record.route.source.chainId)}.</p>
          {!record.submission && !record.sourceHash ? <div className="flex gap-3"><button className="btn-link" disabled={busy || !!pending} onClick={() => void run(() => start(record))}>Continue transfer</button><button className="btn-link" disabled={busy || !!pending} onClick={() => void run(async () => { await discardBridgeDraft(bridgeStorageKey(info.chainId, info.stToken, BigInt(record.groupId), record.owner), record.metadata); await refresh() })}>Cancel unsubmitted transfer</button></div> : <p className="text-sm text-muted">Keep this saved reference until the origin transaction is verified.</p>}
        </div>)}
        {(loadedIdentity === identity ? items : []).map(item => <div key={`${bridgeRouteId(item.route)}:${item.row.leaf.index}`} className="space-y-2 border-t border-line pt-3">
          <p className="text-sm">{formatUnits(item.row.leaf.projectTokenCount, item.route.sourceMeta.decimals)} {item.route.sourceMeta.symbol}: {messages[item.row.status]}</p>
          <ViewTransactionLink chainId={item.route.source.chainId} hash={item.row.sourceHash} />
          {item.row.status === 'queued' || item.row.status === 'claimable' ? <button className="btn-link" disabled={busy || !!pending} onClick={() => void run(() => reviewMovement(item))}>{item.row.status === 'queued' ? 'Send across chains' : 'Claim arrival'}</button> : null}
          {item.row.status === 'claimed' ? <button className="btn-link" onClick={() => setSettle({ token: item.route.rewardToken, groupId: delivery?.groupId ?? groupIdFromWeeks(minWeeks, maxWeeks), identity })}>Check unsettled rewards</button> : null}
        </div>)}
        {settle?.identity === identity ? <ReceiverFlow key={`${settle.token}:${settle.groupId}`} info={info} chainId={info.chainId} projectId={Number(info.projectId)} initialToken={settle.token} initialGroupId={settle.groupId} initiallyOpen onSettled={onFunded} /> : null}
        <TxError error={error} />
      </div>
      {active ? <TxConfirmDialog open title={active.request.label ?? 'Confirm bridge step'} rows={[...active.rows, ...(active.request.functionName === 'approve' ? [{ label: 'Allowance after approval', value: `${formatUnits(BigInt(active.request.args[1] as bigint), active.route.sourceMeta.decimals)} ${active.route.sourceMeta.symbol}` }] : [])]} steps={(active.record?.steps ?? [storeBridgeWrite(active.request)]).map(step => ({ title: step.label }))} activeIndex={0} onClose={closeReview} onConfirm={() => void confirm()} busy={busy} settled={tx.phase === 'submitted'} complete={false} action={confirmAction(tx.phase, active.request.functionName === 'approve' ? 'Confirm & approve' : active.request.functionName === 'prepare' ? 'Confirm & queue' : active.request.functionName === 'claim' ? 'Confirm & claim' : 'Confirm & send')} status={sendingStatus(tx) ?? undefined} error={tx.error} /> : null}
    </ModalShell>
  )
}
