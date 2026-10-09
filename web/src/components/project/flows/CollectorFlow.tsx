'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { formatUnits, isAddressEqual, isHash, type Address, type Hex } from 'viem'
import { BridgeFlow } from '@/components/project/flows/BridgeFlow'
import { reviewGate } from '@/components/project/flows/review-gate'
import { FIELD_INPUT, FIELD_LABEL } from '@/components/project/StakeAgeFields'
import { TxConfirmDialog, type TxConfirmRow } from '@/components/ui/TxConfirmDialog'
import { TxError } from '@/components/ui/TxError'
import { confirmAction, sendingStatus, ViewTransactionLink } from '@/components/ui/TxProgress'
import { useSafeTx } from '@/hooks/useSafeTx'
import { useWallet } from '@/hooks/useWallet'
import { parseAmount } from '@/lib/sticky-amount'
import { createStickyBridge } from '@/lib/sticky-bridge'
import {
  assertPendingBridgeWrite, readPendingBridgeWrite, savePendingBridgeWrite, saveWatchedBridgeRoute,
  storeBridgeWrite, withBridgeLock, type PendingBridgeWrite,
} from '@/lib/sticky-bridge-journal'
import type { CollectorSource } from '@/lib/sticky-collector'
import { collectorWriteKind, createStickyCollectorDelivery, type CollectorDelivery } from '@/lib/sticky-collector-delivery'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { refreshAfterFund } from '@/lib/sticky-refresh'
import { groupLabel } from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'

const delivery = createStickyCollectorDelivery()
const bridge = createStickyBridge()
type Review = { identity: string; owner: Address; delivery: CollectorDelivery; rows: TxConfirmRow[] }
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
  const tx = useSafeTx(deployment.sourceChainId)
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
    setReview({ identity, owner: gate.account, delivery: prepared, rows: [
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
  async function confirm() {
    if (!active || busy) return
    const current = active
    await run(async () => {
      if (readPendingBridgeWrite(current.owner)) throw new Error('Recover the pending transaction before sending again.')
      const held: PendingBridgeWrite = { owner: current.owner, request: storeBridgeWrite(current.delivery.request) }
      const undo = async () => { savePendingBridgeWrite(current.owner, null) }
      assertCurrent(current.identity)
      // useSafeTx can adopt an existing Safe proposal without invoking beforeWrite.
      if (source.bridgeRoute) saveWatchedBridgeRoute(info.chainId, info.stToken, groupId, source.bridgeRoute)
      const hash = await tx.send(current.delivery.request, {
        reviewedAccount: current.owner, reviewedInParent: true,
        reverify: async () => { assertCurrent(current.identity); await delivery.reverify(current.delivery, current.owner); assertCurrent(current.identity) },
        beforeWrite: async () => {
          assertCurrent(current.identity)
          try {
            savePendingBridgeWrite(current.owner, held)
          } catch (reason) { savePendingBridgeWrite(current.owner, null); throw reason }
        },
        onBeforeWriteAborted: undo, onWriteRejected: undo,
      })
      if (hash) savePendingBridgeWrite(current.owner, { ...held, hash, safeProposal: tx.isSafe })
      setPending(readPendingBridgeWrite(current.owner))
    })
  }
  async function recover(hash: Hex, held: PendingBridgeWrite) {
    assertCurrent(identity)
    assertPendingBridgeWrite(held)
    const kind = collectorWriteKind(source, held)
    if (!kind) throw new Error('Recover this pending action in its original bridge or allocation panel.')
    const outcome = await bridge.verifyWrite(
      { chainId: deployment.sourceChainId }, held.owner, hash,
      { ...held.request, value: BigInt(held.request.value) },
      held.hash ? { hash: held.hash, safeProposal: held.safeProposal } : undefined,
    )
    assertCurrent(identity)
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
    handledHash.current = hash
    void withBridgeLock(async () => {
      assertCurrent(current.identity)
      const held = readPendingBridgeWrite(current.owner)
      if (!held) return
      await recover(hash, held)
      setReview(null); tx.reset(); await refresh()
    }, true).catch(reason => setError((reason as Error).message))
    // Process each canonical hash once against its frozen allocation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tx.phase, tx.hash, active])

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
      {active ? <TxConfirmDialog open title={active.delivery.request.label ?? 'Deliver queued rewards'} rows={active.rows} steps={[{ title: active.delivery.request.label ?? 'Deliver queued rewards' }]} activeIndex={0} onClose={closeReview} onConfirm={() => void confirm()} busy={busy} settled={tx.phase === 'submitted'} complete={false} action={confirmAction(tx.phase, remote ? 'Confirm & deliver' : 'Confirm & settle')} status={sendingStatus(tx) ?? undefined} error={tx.error} /> : null}
      {monitor ? <BridgeFlow info={info} sourceChainId={deployment.sourceChainId} delivery={{ route: source.bridgeRoute, groupId }} onClose={() => setMonitor(false)} onFunded={onSettled} /> : null}
    </div>
  )
}
