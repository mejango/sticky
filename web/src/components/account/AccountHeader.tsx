'use client'

import type { Address } from 'viem'
import { useWallet } from '@/hooks/useWallet'

/** A tile in a color of the address's own, dark enough for its letter to read, with the address's first character. */
function AddressBadge({ address }: { address: Address }) {
  const hue = Number(BigInt(address) % 360n)
  return (
    <svg viewBox="0 0 24 24" width={72} height={72} aria-hidden="true" className="shrink-0">
      <rect width="24" height="24" rx="6" fill={`hsl(${hue} 45% 36%)`} />
      <text
        x="12"
        y="16.4"
        fontSize="12"
        fontWeight="700"
        fill="#f0f7f9"
        textAnchor="middle"
        fontFamily="ui-monospace,Menlo,monospace"
      >
        {address.slice(2, 3).toUpperCase()}
      </text>
    </svg>
  )
}

/**
 * The account's logo, its title and its address. The title is "Your account" for the connected wallet, and "Account"
 * for any other account, the one the site is viewed as included: viewing as an account does not make it yours.
 */
export function AccountHeader({ address }: { address: Address }) {
  const { address: wallet } = useWallet()
  const yours = !!wallet && wallet.toLowerCase() === address.toLowerCase()
  return (
    <header className="flex items-center gap-4">
      <AddressBadge address={address} />
      <div className="min-w-0">
        <h1 className="font-agrandir-wide text-[19px] leading-tight">{yours ? 'Your account' : 'Account'}</h1>
        <div className="break-all text-muted">{address}</div>
      </div>
    </header>
  )
}
