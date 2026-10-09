'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { zeroAddress, type Address } from 'viem'
import { BridgeFlow } from '@/components/project/flows/BridgeFlow'
import { CollectorFlow } from '@/components/project/flows/CollectorFlow'
import { FIELD_INPUT, FIELD_LABEL, StakeAgeFields } from '@/components/project/StakeAgeFields'
import { CopyAddress } from '@/components/ui/CopyAddress'
import { DETAIL_LABEL, DETAIL_LIST, DETAIL_VALUE } from '@/components/ui/detail-list'
import { Disclosure } from '@/components/ui/Disclosure'
import { chainsForEnvironment, environmentForChainIds } from '@/lib/chains'
import { bridgeRouteId } from '@/lib/sticky-bridge'
import { reservedSplitPercent, stickyCollector, type CollectorSource } from '@/lib/sticky-collector'
import type { StickyProjectInfo } from '@/lib/sticky-project'
import { groupNote } from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'

/** Configuration is read-only here. Source-project owners install the verified recipe in their reserved splits. */
export function ReservedSplitRecipe(props: { info: StickyProjectInfo; onFunded: (token: Address) => void }) {
  const { chainId, projectId, stToken } = props.info
  return <ReservedSplitForm key={`${chainId}:${projectId}:${stToken.toLowerCase()}`} {...props} />
}

function ReservedSplitForm({ info, onFunded }: { info: StickyProjectInfo; onFunded: (token: Address) => void }) {
  const [sourceChainId, setSourceChainId] = useState(info.chainId)
  const [sourceProject, setSourceProject] = useState('')
  const [minWeeks, setMinWeeks] = useState('')
  const [maxWeeks, setMaxWeeks] = useState('')
  const [percentage, setPercentage] = useState('')
  const [sources, setSources] = useState<CollectorSource[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [watching, setWatching] = useState(false)
  const generation = useRef(0)
  const id = useId()
  useEffect(() => () => { generation.current++ }, [])
  const configured = stickyCollector.deployment(sourceChainId, info.chainId)
  const { groupId } = groupNote(minWeeks, maxWeeks)
  const selected = sources[selectedIndex]
  const choices = chainsForEnvironment(environmentForChainIds([info.chainId]))
  const sourceChain = choices.find(chain => chain.id === sourceChainId)
  let split: ReturnType<typeof stickyCollector.recipe> | undefined
  let percentError = ''
  if (selected && percentage.trim()) {
    try { split = stickyCollector.recipe(selected, reservedSplitPercent(percentage)) }
    catch (reason) { percentError = reason instanceof Error ? reason.message : 'Enter a valid reserved-token percentage.' }
  }

  const invalidate = () => {
    generation.current++
    setSources([])
    setSelectedIndex(0)
    setBusy(false)
    setError('')
    setWatching(false)
  }
  const check = async () => {
    if (groupId === null) return
    const current = ++generation.current
    setBusy(true)
    setSources([])
    setError('')
    try {
      const found = await stickyCollector.discover({ sourceChainId, homeChainId: info.chainId, sourceProject, stickyToken: info.stToken, groupId })
      if (current === generation.current) { setSources(found); setSelectedIndex(0) }
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof Error ? reason.message : 'Could not verify the source route.')
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }

  return (
    <Disclosure summary="Reserved-token rewards" className="mt-3.5 text-[13px]">
      <div className="mt-2.5 space-y-3">
        <p className="text-muted">Route a Juicebox V6 project’s reserved tokens to this pool on {chainName(info.chainId)}. Anyone can deliver queued rewards; source owners configure the split.</p>
        <div>
          <label htmlFor={`${id}-source`} className={FIELD_LABEL}>Source chain</label>
          <select id={`${id}-source`} className={FIELD_INPUT} value={sourceChainId} onChange={event => { invalidate(); setSourceChainId(Number(event.target.value)) }}>
            {choices.map(chain => <option key={chain.id} value={chain.id}>{chainName(chain.id)}</option>)}
          </select>
        </div>
        {!configured ? <p role="status">No verified collector deployment is configured from {chainName(sourceChainId)} to {chainName(info.chainId)}. A reserved-token split recipe is unavailable.</p> : null}
        <div>
          <label htmlFor={`${id}-project`} className={FIELD_LABEL}>Source project ID or token address</label>
          <input id={`${id}-project`} className={FIELD_INPUT} autoComplete="off" value={sourceProject} placeholder="3 or a project token address" onChange={event => { invalidate(); setSourceProject(event.target.value) }} />
        </div>
        <StakeAgeFields minWeeks={minWeeks} maxWeeks={maxWeeks} onMinWeeks={value => { invalidate(); setMinWeeks(value) }} onMaxWeeks={value => { invalidate(); setMaxWeeks(value) }} />
        <button type="button" className="btn-primary px-3 py-2" disabled={!configured || !sourceProject.trim() || groupId === null || busy} onClick={() => void check()}>{busy ? 'Checking route…' : 'Check route'}</button>
        {error ? <p role="alert" className="text-err">{error}</p> : null}
        {sources.length > 1 ? <div>
          <label htmlFor={`${id}-route`} className={FIELD_LABEL}>Direct route</label>
          <select id={`${id}-route`} className={FIELD_INPUT} value={selectedIndex} onChange={event => setSelectedIndex(Number(event.target.value))}>
            {sources.map((source, index) => <option key={source.bridgeRoute ? bridgeRouteId(source.bridgeRoute) : 'local'} value={index}>{source.bridgeRoute?.backingMeta.symbol} · {source.bridgeRoute?.sourceSucker}</option>)}
          </select>
        </div> : null}
        {selected ? <>
          <p className="text-muted">Verified project #{String(selected.allocation.sourceProjectId)} on {chainName(sourceChainId)} → this pool on {chainName(info.chainId)}.</p>
          {selected.verified.sourceToken === zeroAddress ? <p className="text-muted">Project credits can queue here. Delivery waits until the source project deploys its ERC-20.</p> : null}
          <div>
            <label htmlFor={`${id}-percent`} className={FIELD_LABEL}>Percentage of reserved tokens</label>
            <input id={`${id}-percent`} className={FIELD_INPUT} inputMode="decimal" autoComplete="off" value={percentage} placeholder="0–100" onChange={event => setPercentage(event.target.value)} />
            <p className="mt-1 text-muted">This is a share of reserved tokens, not total issuance.</p>
          </div>
          {percentError ? <p role="alert" className="text-err">{percentError}</p> : null}
          {split ? <>
            <p>Add these values to project #{String(selected.allocation.sourceProjectId)}’s <strong>reserved-token splits</strong> on {chainName(sourceChainId)}.</p>
            <dl data-reserved-split-recipe className={DETAIL_LIST}>
              {[
                { label: 'Split hook', value: split.hook, address: true },
                { label: 'Beneficiary', value: split.beneficiary, address: true },
                { label: 'Project ID (reward group)', value: String(split.projectId) },
                { label: 'Reserved-token share', value: `${percentage.trim()}%` },
              ].map(row => <div key={row.label} className="contents"><dt className={DETAIL_LABEL}>{row.label}</dt><dd className={DETAIL_VALUE}><span className={row.address ? 'break-all font-mono text-xs' : ''}>{row.value}</span>{row.address ? <CopyAddress label={`reserved ${row.label.toLowerCase()}`} address={row.value} /> : null}</dd></div>)}
            </dl>
          </> : null}
          <CollectorFlow key={`${sourceChainId}:${selected.allocation.sourceProjectId}:${selected.allocation.groupId}:${selectedIndex}`} source={selected} info={info} onSettled={onFunded} />
        </> : null}
        {sourceChainId !== info.chainId && groupId !== null ? <button type="button" className="btn-link" onClick={() => setWatching(true)}>Check prior deliveries</button> : null}
        {watching && sourceChain && groupId !== null ? <BridgeFlow info={info} sourceChainId={sourceChain.id} delivery={{ groupId }} onClose={() => setWatching(false)} onFunded={onFunded} /> : null}
      </div>
    </Disclosure>
  )
}
