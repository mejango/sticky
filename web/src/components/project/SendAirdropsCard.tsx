'use client'

import { useState } from 'react'
import type { Address } from 'viem'
import { FundFlow } from '@/components/project/flows/FundFlow'
import { ReceiverFlow } from '@/components/project/flows/ReceiverFlow'
import { ReservedSplitRecipe } from '@/components/project/ReservedSplitRecipe'
import { StakeAgeFields } from '@/components/project/StakeAgeFields'
import { CopyAddress } from '@/components/ui/CopyAddress'
import { DETAIL_LABEL, DETAIL_LIST, DETAIL_VALUE } from '@/components/ui/detail-list'
import { Disclosure } from '@/components/ui/Disclosure'
import { useStickyProject } from '@/hooks/useStickyProject'
import { stickyDeployment } from '@/lib/sticky-addresses'
import { groupLabel, groupNote } from '@/lib/sticky-rewards'
import { chainName } from '@/lib/urn'

/** One of the split's values, with a copy button when it is an address. */
function SplitValue({ label, address, text }: { label: string; address?: string; text?: string }) {
  return (
    <>
      <dt className={DETAIL_LABEL}>{label}</dt>
      <dd className={DETAIL_VALUE}>
        {address ? (
          <>
            <span className="break-all font-mono text-xs leading-[1.4]">{address}</span>
            <CopyAddress label={label.toLowerCase()} address={address} />
          </>
        ) : (
          text
        )}
      </dd>
    </>
  )
}

/**
 * The split a Juicebox project adds to fund this project's airdrops from its payouts: the distributor is the split's
 * hook, the Sticky token its beneficiary, and the reward group its project ID (OLD index.html:963-980). Nothing is sent
 * from here.
 */
function SplitRecipe({ chainId, stToken }: { chainId: number; stToken: Address }) {
  const [minWeeks, setMinWeeks] = useState('')
  const [maxWeeks, setMaxWeeks] = useState('')
  const { groupId } = groupNote(minWeeks, maxWeeks)
  const distributor = stickyDeployment(chainId)?.distributor
  if (!distributor) return null
  return (
    <Disclosure summary="Same-chain payout splits" className="mt-3.5 text-[13px]">
      <div className="mt-2.5 space-y-3">
        <p className="text-muted">
          Add a payout split with these values to a Juicebox project on {chainName(chainId)}. Each distribution funds rewards here.
        </p>
        <StakeAgeFields minWeeks={minWeeks} maxWeeks={maxWeeks} onMinWeeks={setMinWeeks} onMaxWeeks={setMaxWeeks} />
        {groupId !== null ? <dl
          data-split-recipe
          className={DETAIL_LIST}
        >
          <SplitValue label="Split hook" address={distributor} />
          <SplitValue label="Beneficiary" address={stToken} />
          <SplitValue
            label="Project ID"
            text={`${groupId} (reward group: ${groupLabel(groupId).toLowerCase()})`}
          />
        </dl> : null}
      </div>
    </Disclosure>
  )
}

/**
 * Sending airdrop rewards to the project's Sticky token holders: everyone stuck, or only stakes held for a number of
 * weeks. Send opens the airdrop's form (`FundFlow`) once this visit has read the project; one disclosure gives the split
 * that funds them from a Juicebox project's payouts, and another a group's reward address (`ReceiverFlow`). `onFunded`
 * hears the token of an airdrop or a settle that went through.
 */
export function SendAirdropsCard({
  chainId,
  projectId,
  onFunded,
}: {
  chainId: number
  projectId: number
  onFunded: (token: Address) => void
}) {
  const { info, verified } = useStickyProject(chainId, projectId)
  const [sending, setSending] = useState(false)
  return (
    <section aria-labelledby="send-airdrops-title" className="card p-5">
      <h2 id="send-airdrops-title" className="mb-2 font-agrandir-wide text-base leading-tight">
        Send airdrop rewards
      </h2>
      <p className="mb-2.5 text-muted">Reward everyone stuck, or only stakes held for a minimum number of weeks.</p>
      <button type="button" disabled={!verified} onClick={() => setSending(true)} className="btn-primary px-4 py-[9px]">
        Send
      </button>
      {info && verified ? <SplitRecipe chainId={chainId} stToken={info.stToken} /> : null}
      {info && verified ? <ReservedSplitRecipe info={info} onFunded={onFunded} /> : null}
      {info && verified ? <ReceiverFlow chainId={chainId} projectId={projectId} info={info} onSettled={onFunded} /> : null}
      {sending && info && verified ? (
        <FundFlow chainId={chainId} projectId={projectId} info={info} onClose={() => setSending(false)} onFunded={onFunded} />
      ) : null}
    </section>
  )
}
