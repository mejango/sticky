'use client'

import { useId } from 'react'
import { getAddress, isAddress, isAddressEqual, zeroAddress, type Address } from 'viem'
import { useEnsName } from '@/hooks/useEnsName'

/**
 * The address `text` names, checksummed, or null. It must be a whole address, written all in lowercase or with its
 * checksum right (viem's strict `isAddress`, which refuses one written all in capitals), and not the zero address:
 * nothing can be sent from it, and no one holds what is sent to it.
 */
export function parseAddress(text: string): Address | null {
  const input = text.trim()
  return isAddress(input) && !isAddressEqual(input, zeroAddress) ? getAddress(input) : null
}

/** What a production chain calls `address`, under the field that holds it. A testnet names no one: `useEnsName` reads no
 * name there. */
export function EnsName({ address, chainId }: { address: string | undefined; chainId: number }) {
  const { data: name } = useEnsName(address, chainId)
  return name ? <p className="mt-[3px] truncate text-xs text-muted">{name}</p> : null
}

/** A labelled field for an address a flow sends to or trusts. The flow validates it with `parseAddress`. */
export function AddressInput({
  label,
  value,
  onChange,
  chainId,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  chainId: number
}) {
  const id = useId()
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-[3px] block text-xs font-semibold uppercase tracking-[1px] text-muted">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="0x…"
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        className="min-h-[36px] w-full rounded-[4px] border border-line bg-[#fdffff] px-2 py-1.5 font-mono text-xs text-ink focus:border-amber focus:outline-none"
      />
      <EnsName address={parseAddress(value) ?? undefined} chainId={chainId} />
    </div>
  )
}
