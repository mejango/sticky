'use client'

import { useQuery } from '@tanstack/react-query'
import { isAddress } from 'viem'
import { ensAvailable, lookupEnsName } from '@/lib/ens'

/** Resolve an address's primary ENS name on mainnet, for an account of a production chain. */
export function useEnsName(address: string | undefined, chainId: number) {
  return useQuery({
    queryKey: ['ensName', address?.toLowerCase()],
    queryFn: () => lookupEnsName(address!, chainId),
    enabled: !!address && isAddress(address) && ensAvailable(chainId),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
    retry: 1,
  })
}
