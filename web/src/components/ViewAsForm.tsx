'use client'

import { useState, type FormEvent } from 'react'
import { isAddress, type Address } from 'viem'
import { useViewAs } from '@/lib/viewAs'

/** Browse the site as any address, without connecting anything. */
export function ViewAsForm({
  onDone,
  className,
}: {
  onDone: () => void
  className?: string
}) {
  const { setViewAs } = useViewAs()
  const [value, setValue] = useState('')
  const [invalid, setInvalid] = useState(false)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const input = value.trim()
    if (!isAddress(input)) {
      setInvalid(true)
      return
    }
    setViewAs(input as Address)
    onDone()
  }

  return (
    <form onSubmit={submit} className={className}>
      <input
        value={value}
        onChange={event => {
          setValue(event.target.value)
          setInvalid(false)
        }}
        placeholder="0x address"
        aria-label="Account address to preview"
        aria-invalid={invalid || undefined}
        autoFocus
        className="mb-1.5 w-full rounded-[4px] border border-line bg-[#fdffff] px-2 py-1.5 text-ink focus:border-amber aria-[invalid=true]:border-err"
      />
      {invalid ? (
        <p role="alert" className="mb-1.5 text-xs text-err">
          Enter an address
        </p>
      ) : null}
      <button type="submit" className="menu-item">
        View
      </button>
    </form>
  )
}
