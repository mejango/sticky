'use client'

import { useEffect, useState } from 'react'

/** How long typing must stop before a flow reads what was typed, such as quoting an amount. */
const SETTLE_MS = 250

/** `value`, once it has stayed the same for 250 ms. */
export function useSettled<T>(value: T): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), SETTLE_MS)
    return () => clearTimeout(timer)
  }, [value])
  return settled
}
