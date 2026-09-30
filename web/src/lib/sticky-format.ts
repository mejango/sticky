/**
 * How Sticky shows an amount and a span of time. Amounts follow juicebox.money's `formatTokenAmount`, so a figure
 * reads the same on both sites; durations and ages are the old client's.
 */

import { formatUnits } from 'viem'

/**
 * A token amount in its smallest units, as the reader sees it: grouped in `en-US` whatever the browser's locale, at
 * most `maxDigits` decimals, and an amount too small for them shown to its first significant figure, so a real
 * amount never reads as nothing. Inputs and exact review rows are not for this: they keep every digit.
 */
export function formatAmount(value: bigint, decimals: number, maxDigits = 4): string {
  const amount = Number(formatUnits(value, decimals))
  if (amount === 0) return '0'
  if (amount > 0 && amount < 0.0001) return amount.toFixed(Math.ceil(-Math.log10(amount))).replace(/0+$/, '')
  return amount.toLocaleString('en-US', { maximumFractionDigits: maxDigits })
}

/** A span of `seconds` by its two largest units: `1d 1h`, `3h 20m`, `4m 5s`. Nothing at all reads `0d`. */
export function formatDuration(seconds: number | bigint): string {
  const total = Number(seconds)
  if (total === 0) return '0d'
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m ${total % 60}s`
}

/** How long ago Unix time `timestamp` was: `now` inside a minute, and for a time ahead of the clock, then `5m ago`,
 * `2h ago` and `3d ago`. */
export function ago(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000) - timestamp
  if (seconds < 60) return 'now'
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}
