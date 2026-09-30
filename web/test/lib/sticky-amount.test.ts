// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { parseAmount } from '@/lib/sticky-amount'

// What a holder types as an amount, in the smallest units of the token they mean, ported from the old client's
// `parseUnits` tests: an amount is never rounded to fit.

describe('parseAmount', () => {
  it('keeps every digit of a token\'s precision, including a token with no decimals', () => {
    expect(parseAmount('.000001', 6)).toBe(1n)
    expect(parseAmount('12.000001', 6)).toBe(12_000_001n)
    expect(parseAmount('12', 0)).toBe(12n)
    expect(parseAmount('1.', 6)).toBe(1_000_000n)
    expect(parseAmount('1.000000000000000001', 18)).toBe(1_000_000_000_000_000_001n)
    expect(parseAmount('0', 6)).toBe(0n)
  })

  it('ignores the space around what was typed', () => {
    expect(parseAmount(' 5 ', 6)).toBe(5_000_000n)
  })

  it('takes a token with more than 18 decimals', () => {
    expect(parseAmount('0.00000000000000000001', 20)).toBe(1n)
  })

  it.each(['', '.', '1.2.3', '-1', '+1', '1e6', '1,000', '0x10', 'ten', '1 000'])('refuses %j as no amount', text => {
    expect(() => parseAmount(text, 6)).toThrow('enter a valid amount')
  })

  it('refuses a fraction the token cannot hold, and never rounds it', () => {
    expect(() => parseAmount('0.0000001', 6)).toThrow('this token supports at most 6 decimal places')
    expect(() => parseAmount('1.0', 0)).toThrow('this token supports at most 0 decimal places')
  })

  it('refuses an amount that does not fit in a uint256, and a token whose decimals are not a byte', () => {
    const max = (1n << 256n) - 1n
    expect(parseAmount(max.toString(), 0)).toBe(max)
    expect(() => parseAmount((1n << 256n).toString(), 0)).toThrow('that amount is too large')
    expect(() => parseAmount('9'.repeat(200), 6)).toThrow('that amount is too large')
    expect(() => parseAmount('1', 256)).toThrow('invalid token decimals')
    expect(() => parseAmount('1', -1)).toThrow('invalid token decimals')
    expect(() => parseAmount('1', 1.5)).toThrow('invalid token decimals')
  })

  it('reads a long run of leading zeros as the small amount it is', () => {
    expect(parseAmount(`${'0'.repeat(120)}7`, 6)).toBe(7_000_000n)
  })
})
