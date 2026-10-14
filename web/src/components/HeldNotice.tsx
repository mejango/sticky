'use client'

import { HeldWritesNotice, useHeldWrites } from '@bananapus/nana-sdk-core/review/react'
import type { WriteHoldClient } from '@bananapus/nana-sdk-core/review'
import type { Address } from 'viem'
import { usePublicClient } from 'wagmi'
import { SUPPORTED_CHAINS } from '@/lib/chains'
import { holds } from '@/lib/write-holds'

/**
 * Every write held for the connected account that needs the user, on each chain: the SDK's line and its release. Each
 * listed write is followed while it is held, so one whose dialog closed still settles. A write that is only confirming
 * shows in its own flow, never here.
 */
export function HeldNotice({ account }: { account: Address }) {
  return <>{SUPPORTED_CHAINS.map(chain => <ChainHeldNotice key={chain.id} chainId={chain.id} account={account} />)}</>
}

function ChainHeldNotice({ chainId, account }: { chainId: number; account: Address }) {
  const client = usePublicClient({ chainId }) as WriteHoldClient | undefined
  const items = useHeldWrites({ hold: holds, chainId, account, client }).filter(item => item.view.phase === 'held')
  return <HeldWritesNotice items={items} className="held-notice mx-auto my-3 max-w-3xl space-y-2 rounded-lg border border-line bg-card px-4 py-3 text-sm" />
}
