'use client'

import type { Address } from 'viem'
import { useEnsName } from 'wagmi'
import { shortAddress } from '@/lib/sticky-format'
import { IS_DETERMINISTIC_BROWSER } from '@/providers/Providers'

/** ENS identities always resolve on Ethereum, independent of the selected project chain. */
export function useAccountIdentity(address?: Address) {
  const { data: name } = useEnsName({
    address,
    chainId: 1,
    query: {
      enabled: !!address && !IS_DETERMINISTIC_BROWSER,
      staleTime: 5 * 60_000,
      retry: 1,
    },
  })
  return {
    name,
    label: name || (address ? shortAddress(address) : ''),
  }
}
