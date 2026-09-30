'use client'

import { useEnsName } from '@/hooks/useEnsName'

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function AddressText({ address, chainId }: { address: string; chainId: number }) {
  const { data: ensName } = useEnsName(address, chainId)
  return <>{ensName ?? truncateAddress(address)}</>
}

/** Prefer ENS, retain the compact address as the fallback and full-address
 * tooltip. */
export function AddressLabel({
  address,
  chainId,
  className,
}: {
  address: string
  /** The chain the address acts on: a testnet's accounts get no mainnet name. */
  chainId: number
  className?: string
}) {
  return (
    <span className={className} title={address}>
      <AddressText address={address} chainId={chainId} />
    </span>
  )
}
