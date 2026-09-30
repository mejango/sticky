import { parseUnits } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ago, formatAmount, formatDuration } from '@/lib/sticky-format'

// The old client's format.test.cjs, which pulled formatUnits, formatAmount, formatDuration and ago out of
// app.js with vm. `units` is what that file's helper of the same name built: whole and fractional digits
// scaled by the token's decimals.
const units = (amount: string, decimals = 18) => parseUnits(amount, decimals)

describe('formatAmount', () => {
  it('groups amounts with at most four decimals, like juicebox.money', () => {
    expect(formatAmount(units('32577559.305605237523530572'), 18)).toBe('32,577,559.3056')
    expect(formatAmount(units('1234.5'), 18)).toBe('1,234.5')
    expect(formatAmount(units('10'), 18)).toBe('10')
    expect(formatAmount(units('1.234567', 6), 6)).toBe('1.2346')
    expect(formatAmount(units('1.23456789'), 18, 2)).toBe('1.23')
  })

  it('shows a tiny amount as its first significant figure instead of reading as zero', () => {
    expect(formatAmount(units('0.000004586733'), 18)).toBe('0.000005')
    expect(formatAmount(units('0.00004'), 18)).toBe('0.00004')
    expect(formatAmount(1n, 18)).toBe('0.000000000000000001')
    expect(formatAmount(units('0.0001'), 18)).toBe('0.0001')
  })

  it('shows zero as a plain zero, whatever the decimals', () => {
    expect(formatAmount(0n, 18)).toBe('0')
    expect(formatAmount(0n, 6)).toBe('0')
  })

  it('reads the same in every browser locale', () => {
    const toLocaleString = Number.prototype.toLocaleString
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
      this: number,
      locales?: never,
      options?: never,
    ) {
      return toLocaleString.call(this, locales ?? 'de-DE', options)
    } as never)
    expect(formatAmount(units('1234.5'), 18)).toBe('1,234.5')
  })
})

describe('formatDuration', () => {
  it('reads an empty duration as zero days, like juicebox.money', () => {
    expect(formatDuration(0)).toBe('0d')
    expect(formatDuration(0n)).toBe('0d')
  })

  it('names the two largest units of a duration', () => {
    expect(formatDuration(90_000)).toBe('1d 1h')
    expect(formatDuration(3 * 86_400)).toBe('3d 0h')
    expect(formatDuration(3_600 + 5 * 60)).toBe('1h 5m')
    expect(formatDuration(59 * 60 + 59)).toBe('59m 59s')
    expect(formatDuration(45)).toBe('0m 45s')
  })

  it('takes seconds from a contract as a bigint', () => {
    expect(formatDuration(604_800n)).toBe('7d 0h')
  })
})

describe('ago', () => {
  const now = Date.UTC(2026, 8, 30, 12, 0, 0)
  const seconds = Math.floor(now / 1000)

  afterEach(() => vi.useRealTimers())

  it('reads fresh activity as now, and older activity by its largest unit', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    expect(ago(seconds - 5)).toBe('now')
    expect(ago(seconds - 59)).toBe('now')
    expect(ago(seconds - 60)).toBe('1m ago')
    expect(ago(seconds - 3_599)).toBe('59m ago')
    expect(ago(seconds - 7_200)).toBe('2h ago')
    expect(ago(seconds - 86_399)).toBe('23h ago')
    expect(ago(seconds - 3 * 86_400)).toBe('3d ago')
  })

  it('never reads a time ahead of the clock as anything but now', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    expect(ago(seconds + 30)).toBe('now')
  })
})
