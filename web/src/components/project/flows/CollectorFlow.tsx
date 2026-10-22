'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits, isAddressEqual, isHash, type Address, type Hex } from 'viem'
import { BridgeFlow } from '@/components/project/flows/BridgeFlow'
import { reviewGate } from '@/components/project/flows/review-gate'
import { FIELD_INPUT, FIELD_LABEL } from '@/components/project/StakeAgeFields'
import { TxConfirmDialog } from '@/components/ui/TxConfirmDialog'
import { holdIntent } from '@/lib/sticky-hold-intent'
import { SavedWriteRecovery } from '@/components/ui/SavedWriteRecovery'
import { TxError } from '@/components/ui/TxError'
import { confirmAction, sendingStatus, ViewTransactionLink } from '@/components/ui/TxProgress'
import { reviewedCall, useReviewedAction } from '@/hooks/useReviewedAction'
import { useWallet } from '@/hooks/useWallet'
import { parseAmount } from '@/lib/sticky-amount'
import { createStickyBridge } from '@/lib/sticky-bridge'
import {
  adoptSettlementHash, assertPendingBridgeWrite, ensurePendingBridgeId, endPendingBridgeAttempt, createPendingBridgeWrite, readPendingBridgeWrite, retryPendingBridgeSubmission, savePendingBridgeWrite, savePendingBridgeSubmission, saveWatchedBridgeRoute,
  storeBridgeWrite, withBridgeLock, type PendingBridgeWrite,
} from '@/lib/sticky-bridge-journal'
import type { CollectorSource } from '@/lib/sticky-collector'
import { collectorWriteKind, createStickyCollectorDelivery, type CollectorDelivery } from '@/lib/sticky-collector-delivery'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { refreshAfterFund } from '@/lib/sticky-refresh'
import { groupLabel } from '@/lib/sticky-rewards'
import type { TransactionReviewRow } from '@/lib/transaction-review'
import { chainName } from '@/lib/urn'

const delivery = createStickyCollectorDelivery()
const bridge = createStickyBridge()
type Review = { identity: string; owner: Address; delivery: CollectorDelivery; rows: TransactionReviewRow[]; attempt?: PendingBridgeWrite; autoSend?: boolean }
const changed = 'The wallet, pool or allocation changed. Review this delivery again.'

/** A source allocation is already held by the collector. Anyone may pay to deliver it to its fixed home pool. */
export function CollectorFlow({ source, info, onSettled }: {
  source: CollectorSource
  info: StickyProjectInfo
  onSettled: (token: Address) => void
}) {
  const wallet = useWallet()
  const client = useQueryClient()
  const id = useId()
  const { deployment, sourceProjectId, stickyToken, groupId } = source.allocation
  const [queue, setQueue] = useState<Awaited<ReturnType<typeof delivery.read>>>()
  const [amount, setAmount] = useState('')
  const [pending, setPending] = useState<PendingBridgeWrite | null>(null)
  const [recoveryHash, setRecoveryHash] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [monitor, setMonitor] = useState(false)
  const [result, setResult] = useState<'submitted' | 'settled' | null>(null)
  const tx = useReviewedAction()
  const identity = JSON.stringify({
    homeChainId: info.chainId, projectId: String(info.projectId), token: info.stToken, owner: wallet.address,
    deployment, sourceProjectId: String(sourceProjectId), stickyToken, groupId: String(groupId),
    verified: { ...source.verified, destinationProjectId: String(source.verified.destinationProjectId) }, route: source.bridgeRoute,
  })
  const currentIdentity = useRef(identity)
  const generation = useRef(0)
  const handledHash = useRef<Hex | null>(null)
  const active = review?.identity === identity ? review : null
  const busy = working || tx.busy || tx.phase === 'review'
  const remote = deployment.sourceChainId !== info.chainId

  const assertCurrent = (expected: string) => {
    if (currentIdentity.current !== expected || deployment.destinationChainId !== info.chainId || !isAddressEqual(stickyToken, info.stToken)) {
      throw new Error(changed)
    }
  }
  async function refresh() {
    const mine = ++generation.current
    try {
      setPending(wallet.address ? readPendingBridgeWrite(wallet.address) : null)
      assertCurrent(identity)
      const fresh = await delivery.read(source)
      if (mine !== generation.current) return
      setQueue(fresh); setError(null)
    } catch (reason) { if (mine === generation.current) setError((reason as Error).message) }
  }
  useEffect(() => {
    currentIdentity.current = identity
    setQueue(undefined); setAmount(''); setResult(null); setMonitor(false)
    void refresh()
    return () => { currentIdentity.current = ''; generation.current += 1 }
    // A changed pool, source, group or wallet invalidates every in-memory review.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])

  async function run(work: () => Promise<void>) {
    if (busy) return
    setWorking(true); setError(null)
    try { await withBridgeLock(work) } catch (reason) { setError((reason as Error).message) } finally { setWorking(false) }
  }
  async function start() {
    const gate = reviewGate(wallet)
    if (!gate) { wallet.openSignIn(); return }
    if (gate.refusal) throw new Error(gate.refusal)
    if (readPendingBridgeWrite(gate.account)) throw new Error('Recover the pending bridge transaction before delivering another allocation.')
    if (!queue) throw new Error('Read the queued allocation before choosing an amount.')
    const count = parseAmount(amount, queue.meta.decimals)
    const prepared = await delivery.prepare(source, gate.account, count)
    assertCurrent(identity)
    tx.reset(); handledHash.current = null
    // The button was the choice: its one decoded review opens as soon as this step renders.
    setReview({ identity, owner: gate.account, delivery: prepared, autoSend: true, rows: [
      { label: 'Deliver', value: `${formatUnits(count, prepared.meta.decimals)} ${prepared.meta.symbol}`, strong: true },
      { label: 'Source chain', value: chainName(deployment.sourceChainId) },
      { label: 'Home chain', value: chainName(info.chainId) },
      { label: 'Source collector', value: deployment.address, mono: true },
      { label: 'Reward address', value: prepared.verified.receiver, mono: true },
      { label: 'Rewards', value: groupLabel(groupId) },
      { label: 'Bridge payment', value: `${formatUnits(prepared.request.value ?? 0n, 18)} ETH` },
      { label: 'Afterward', value: remote ? 'Wait for bridge delivery, claim the arrival, then settle it into airdrops.' : 'The allocation settles into this pool’s airdrops.' },
    ] })
  }
  async function confirm(chosen: Review) {
    const current = { ...chosen, autoSend: false }
    await run(async () => {
      assertCurrent(current.identity)
      if (readPendingBridgeWrite(current.owner)) throw new Error('Recover the pending transaction before sending again.')
      const held = createPendingBridgeWrite({ owner: current.owner, request: storeBridgeWrite(current.delivery.request), intent: holdIntent(current.delivery.request, current.owner) })
      setReview({ ...current, attempt: held })
      let reserved = false
      const undo = () => endPendingBridgeAttempt(current.owner, held.id)
      // The engine can adopt an existing Safe proposal without reaching beforeWallet.
      if (source.bridgeRoute) saveWatchedBridgeRoute(info.chainId, info.stToken, groupId, source.bridgeRoute)
      await tx.run({
        account: current.owner,
        calls: [reviewedCall(current.delivery.request, current.owner)],
        title: current.delivery.request.label ?? 'Deliver queued rewards',
        context: current.rows,
        reverify: async () => { assertCurrent(current.identity); await delivery.reverify(current.delivery, current.owner); assertCurrent(current.identity) },
        beforeWallet: async () => {
          assertCurrent(current.identity)
          try {
            savePendingBridgeWrite(current.owner, held)
            reserved = true
          } catch (reason) {
            try { if (readPendingBridgeWrite(current.owner)) await undo() } catch { /* Preserve another attempt or unreadable storage. */ }
            throw reason
          }
        },
        // Only a reservation this send made is ended: one it found is another attempt's.
        onUnsent: async () => { if (reserved) await undo() },
        onSubmitted: (_call, _step, hash, { safe }) => {
          if (!reserved && !readPendingBridgeWrite(current.owner)) { savePendingBridgeWrite(current.owner, held); reserved = true }
          savePendingBridgeSubmission(held, hash, safe)
        },
        // The user's exit released the SDK hold: the reservation goes, the saved transfer stays.
        onReleased: async () => { await endPendingBridgeAttempt(current.owner, held.id); setPending(null) },
        onCancelled: closeReview,
      })
      setPending(readPendingBridgeWrite(current.owner))
    })
  }
  /** True once the settlement is adopted. A busy flow skips it and a failed recovery leaves it, so the panel asks again. */
  async function settleFromPanel(held: PendingBridgeWrite, hash: Hex, result?: 'success' | 'failed'): Promise<boolean> {
    if (busy) return false
    let adopted = false
    await run(async () => { await settleStored(held, hash, result); adopted = true })
    return adopted
  }
  /** The SDK settled this write on authenticated evidence: its hash becomes the submission reference, and the normal recovery runs. */
  async function settleStored(held: PendingBridgeWrite, hash: Hex, result?: 'success' | 'failed') {
    const stored = readPendingBridgeWrite(held.owner)
    if (!stored || stored.id !== held.id) throw new Error('The pending bridge transaction changed. Refresh its recovery before continuing.')
    await recover(hash, await adoptSettlementHash(stored.owner, stored.id, hash, undefined, result))
    await refresh()
  }
  async function recover(hash: Hex, held: PendingBridgeWrite) {
    assertCurrent(identity)
    retryPendingBridgeSubmission(held)
    assertPendingBridgeWrite(held)
    const kind = collectorWriteKind(source, held)
    if (!kind) throw new Error('Recover this pending action in its original bridge or allocation panel.')
    const outcome = await bridge.verifyWrite(
      { chainId: deployment.sourceChainId }, held.owner, hash,
      { ...held.request, value: BigInt(held.request.value) },
      held.hash ? { hash: held.hash, safeProposal: held.safeProposal } : undefined,
    )
    assertCurrent(identity)
    assertPendingBridgeWrite(held)
    if (outcome.success && kind === 'send' && source.bridgeRoute) {
      saveWatchedBridgeRoute(info.chainId, info.stToken, groupId, source.bridgeRoute)
    }
    savePendingBridgeWrite(held.owner, null); setPending(null)
    if (!outcome.success) throw new Error('The transaction reverted. The remaining allocation can be reviewed again.')
    setResult(kind === 'send' ? 'submitted' : 'settled')
    if (kind === 'settle') {
      refreshAfterFund(client, info.chainId, Number(info.projectId), held.owner)
      onSettled(source.verified.rewardToken)
    }
  }
  useEffect(() => {
    if (tx.phase !== 'success' || !tx.hash || !active || handledHash.current === tx.hash) return
    const current = active, hash = tx.hash
    const submissionHash = tx.submissionHash, safeProposal = tx.submissionIsSafe
    void withBridgeLock(async () => {
      assertCurrent(current.identity)
      let held = readPendingBridgeWrite(current.owner)
      if (!held) return
      if (!current.attempt || !(submissionHash ?? held.hash)) throw new Error('The original wallet attempt is unavailable. Recover its saved transaction before continuing.')
      held = savePendingBridgeSubmission(current.attempt, (submissionHash ?? held.hash)!, submissionHash ? safeProposal : held.safeProposal)
      await recover(hash, held)
      handledHash.current = hash
      setReview(null); tx.reset(); await refresh()
    }, true).catch(reason => setError((reason as Error).message))
    // Process each canonical hash once against its frozen allocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase, tx.hash, tx.submissionHash, tx.submissionIsSafe, active])

  // A legacy reservation with no attempt id gets a durable one under the domain lock, so adoption, the exit and its end name one attempt.
  const legacyOwner = pending && !pending.id ? pending.owner : null
  useEffect(() => {
    if (!legacyOwner) return
    void withBridgeLock(async () => { setPending(ensurePendingBridgeId(legacyOwner)) }, true).catch(() => undefined)
  }, [legacyOwner])
  // A chosen delivery is sent from its own render.
  useEffect(() => {
    if (!active?.autoSend || busy || tx.phase !== 'idle') return
    setReview({ ...active, autoSend: false })
    void confirm(active)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, busy, tx.phase])
  function closeReview() { setReview(null); tx.dismiss(); void refresh() }
  const ours = pending ? collectorWriteKind(source, pending) : null
  return (
    <div className="space-y-3 border-t border-line pt-3">
      <p className="text-sm">Queued on {chainName(deployment.sourceChainId)}: {queue ? `${formatUnits(queue.pending, queue.meta.decimals)} ${queue.meta.symbol}` : 'Reading…'}. Anyone can deliver these rewards.</p>
      <label htmlFor={`${id}-amount`} className={FIELD_LABEL}>Amount to deliver</label>
      <div className="flex items-center gap-2">
        <input id={`${id}-amount`} className={FIELD_INPUT} value={amount} disabled={busy || !!active} onChange={event => setAmount(event.target.value)} inputMode="decimal" />
        <button className="btn-link" disabled={busy || !!active || !queue} onClick={() => queue && setAmount(formatUnits(queue.pending, queue.meta.decimals))}>Max</button>
      </div>
      <div className="flex flex-wrap gap-3">
        <button className="btn-primary" disabled={busy || !!pending || !queue?.pending} onClick={() => void run(start)}>Review delivery</button>
        <button className="btn-link" disabled={busy} onClick={() => void refresh()}>Refresh allocation</button>
        {remote ? <button className="btn-link" disabled={busy} onClick={() => setMonitor(true)}>Track deliveries</button> : null}
      </div>
      {result ? <p role="status" className="text-sm">{result === 'submitted' ? 'Submitted on the source chain. Bridge delivery, claim and settlement are still pending.' : 'Settled into this pool’s airdrops.'}</p> : null}
      {pending ? <div role="status" className="space-y-2">
        <p className="text-sm">A transaction may still execute. Recover it before delivering another allocation.</p>
        {ours ? <>
          {!pending.hash ? <p className="text-sm text-muted">The wallet returned no submission reference. This attempt remains locked; a matching earlier transaction cannot prove it finished.</p> : null}
          <SavedWriteRecovery pending={pending} disabled={busy}
            authenticate={async hash => (await bridge.verifyWrite({ chainId: deployment.sourceChainId }, pending.owner, hash, { ...pending.request, value: BigInt(pending.request.value) }, pending.hash ? { hash: pending.hash, safeProposal: pending.safeProposal } : undefined)).success}
            record={(hash, result) => settleFromPanel(pending, hash, result)}
            end={() => withBridgeLock(async () => { await endPendingBridgeAttempt(pending.owner, pending.id); setPending(readPendingBridgeWrite(pending.owner)); await refresh() }, true)} />
          {pending.safeProposal ? <p className="text-sm text-muted">Complete the Safe proposal, then check its executed transaction hash.</p> : null}
          {pending.hash && !pending.safeProposal ? <ViewTransactionLink chainId={pending.request.chainId} hash={pending.hash} /> : null}
          <label htmlFor={`${id}-hash`} className={FIELD_LABEL}>Executed transaction hash</label>
          <input id={`${id}-hash`} className={`${FIELD_INPUT} font-mono text-xs`} value={recoveryHash} onChange={event => setRecoveryHash(event.target.value)} placeholder={pending.safeProposal ? '0x…' : pending.hash ?? '0x…'} />
          <button className="btn-link" disabled={busy} onClick={() => void run(async () => {
            const hash = recoveryHash || (!pending.safeProposal ? pending.hash : '')
            if (!hash || !isHash(hash)) throw new Error('Enter the executed transaction hash from the wallet.')
            await recover(hash, pending); await refresh()
          })}>Check transaction</button>
        </> : <p className="text-sm text-muted">Recover the pending action in its original bridge or allocation panel.</p>}
      </div> : null}
      <TxError error={error} />
      {active ? <TxConfirmDialog open title={active.delivery.request.label ?? 'Deliver queued rewards'} rows={active.rows} steps={[{ title: active.delivery.request.label ?? 'Deliver queued rewards' }]} activeIndex={0} onClose={closeReview} onConfirm={() => void confirm(active)} busy={busy} settled={tx.phase === 'submitted'} complete={false} action={confirmAction(tx.phase, 'Review again')} status={sendingStatus(tx) ?? undefined} error={tx.error} /> : null}
      {monitor ? <BridgeFlow info={info} sourceChainId={deployment.sourceChainId} delivery={{ route: source.bridgeRoute, groupId }} onClose={() => setMonitor(false)} onFunded={onSettled} /> : null}
    </div>
  )
}
