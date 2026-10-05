'use client'

import { useCallback, useState } from 'react'
import type { Address } from 'viem'
import { AutoStickCard } from '@/components/project/AutoStickCard'
import { StickFlow } from '@/components/project/flows/StickFlow'
import { RewardsCard } from '@/components/project/RewardsCard'
import { SendAirdropsCard } from '@/components/project/SendAirdropsCard'
import { TrustedSenders } from '@/components/project/TrustedSenders'
import { ShowingPanel } from '@/hooks/useShowing'

/**
 * A Sticky project's Airdrops tab: sticking for someone else, sending airdrop rewards, the viewer's rewards, their
 * auto-stick, and who they trust to stick for them. What it reads about the viewer goes on only while its panel is
 * showing.
 */
export function AirdropsTab({ chainId, projectId }: { chainId: number; projectId: number }) {
  // The tokens looked for rewards in by hand, in lowercase: those checked in the rewards card, and the token of each
  // airdrop sent from this tab, whose pot then shows where the funded pots cannot be listed, as in the old client.
  const [checked, setChecked] = useState<Address[]>([])
  const check = useCallback((token: Address) => setChecked(list => (list.includes(token) ? list : [...list, token])), [])
  return (
    <ShowingPanel className="flex flex-col gap-5">
      <section aria-labelledby="stick-for-title" className="card p-5">
        <h2 id="stick-for-title" className="mb-2 font-agrandir-wide text-base leading-tight">
          Stick for someone else
        </h2>
        <p className="mb-2.5 text-muted">They must trust your wallet, unless you are a trusted sender.</p>
        <StickFlow chainId={chainId} projectId={projectId} forSomeoneElse />
      </section>
      <SendAirdropsCard chainId={chainId} projectId={projectId} onFunded={check} />
      <RewardsCard chainId={chainId} projectId={projectId} checked={checked} onCheck={check} />
      <AutoStickCard chainId={chainId} projectId={projectId} />
      <TrustedSenders chainId={chainId} projectId={projectId} />
    </ShowingPanel>
  )
}
