'use client'

import { useState, type FormEvent } from 'react'
import { isAddress, type Address } from 'viem'
import { useViewAs } from '@/lib/viewAs'

/** Browse the site as any address, without connecting anything. */
export function ViewAsForm({ onDone }: { onDone: () => void }) {
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
    <form onSubmit={submit} className="px-2.5 pb-2 pt-1.5">
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
        className="w-full rounded-[4px] border border-line bg-[#fdffff] px-2 py-1.5 text-ink outline-none focus:border-amber aria-[invalid=true]:border-err"
      />
      {invalid ? (
        <p role="alert" className="mt-1.5 text-xs text-err">
          Enter an address
        </p>
      ) : null}
      <button type="submit" className="btn-primary mt-2.5 px-4 py-2">
        View
      </button>
    </form>
  )
}
