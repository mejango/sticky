'use client'

import type { BendystrawNetwork } from '@bananapus/nana-sdk-core'
import type { Address } from 'viem'
import { AccountNote } from '@/components/account/AccountNote'
import { StickyFeed } from '@/components/StickyFeed'
import { useAccountActivity } from '@/hooks/useStickyAccount'

/**
 * An account's newest activity across the chains of a network, laid out as the home's Latest list is, each row naming
 * its project. It draws a placeholder until a chain has a row or every chain has answered, and counts the chains that
 * could not be read, with a Retry: a chain that could not be read is never an account with no activity.
 */
export function AccountActivity({ address, network }: { address: Address; network: BendystrawNetwork }) {
  const { rows, labels, failedChains, pending, retry } = useAccountActivity(network, address)
  const loading = pending && rows.length === 0
  // A list that could not be read whole never says it is empty.
  const shown = loading || rows.length > 0 || failedChains.length === 0
  return (
    <section aria-labelledby="account-activity" aria-busy={loading} className="min-w-0">
      <h2 id="account-activity" className="mb-2 mt-1 font-agrandir-wide text-xl">
        Activity
      </h2>
      {shown ? (
        <StickyFeed
          rows={loading ? undefined : rows}
          empty="No activity yet"
          label={row => labels.get(`${row.chainId}:${row.projectId}`)}
        />
      ) : null}
      <AccountNote failedChains={failedChains} onRetry={retry} />
    </section>
  )
}
