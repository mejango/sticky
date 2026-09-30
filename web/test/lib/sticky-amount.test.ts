// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { parseAmount, parseShares, SHARE_DECIMALS } from '@/lib/sticky-amount'

// What a holder types as an amount, in the smallest units of the token they mean, ported from the old client's
// `parseUnits` tests: an amount is never rounded to fit. Every flow reads its amount here: a stick in the staked token's
// decimals, and an unstick and a transfer in Sticky shares.

/** Typed amounts that are no amount at all: signs, exponents, separators, other scripts' digits and whatever else. */
const NOT_AMOUNTS = [
  '',
  ' ',
  '.',
  '1.2.3',
  '-1',
  '+1',
  '\u22121',
  '1e6',
  '1E6',
  '1e-6',
  'Infinity',
  'NaN',
  '1,000',
  '1,5',
  '1_000',
  '0x10',
  '0b1',
  'ten',
  '1 000',
  '1\u00a0000',
  '1\u202f000',
  '\u0661\u0662\u0663',
  '\uff11\uff12\uff13',
  '\u0967',
  '\u{1d7cf}',
  '\u066b5',
]

describe('parseAmount', () => {
  it("keeps every digit of a token's precision, including a token with no decimals", () => {
    expect(parseAmount('.000001', 6)).toBe(1n)
    expect(parseAmount('12.000001', 6)).toBe(12_000_001n)
    expect(parseAmount('12', 0)).toBe(12n)
    expect(parseAmount('1.', 6)).toBe(1_000_000n)
    expect(parseAmount('1.000000000000000001', 18)).toBe(1_000_000_000_000_000_001n)
    expect(parseAmount('0', 6)).toBe(0n)
  })

  it('ignores the space around what was typed', () => {
    expect(parseAmount(' 5 ', 6)).toBe(5_000_000n)
    expect(parseAmount('\t5\n', 6)).toBe(5_000_000n)
  })

  it('takes a token with more than 18 decimals', () => {
    expect(parseAmount('0.00000000000000000001', 20)).toBe(1n)
  })

  it.each(NOT_AMOUNTS)('refuses %j as no amount', text => {
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

describe('parseShares', () => {
  it('reads Sticky shares, which have 18 decimals, to the last place', () => {
    expect(SHARE_DECIMALS).toBe(18)
    expect(parseShares('1')).toBe(10n ** 18n)
    expect(parseShares('1.')).toBe(10n ** 18n)
    expect(parseShares('.5')).toBe(5n * 10n ** 17n)
    expect(parseShares('1.234567890123456789')).toBe(1_234_567_890_123_456_789n)
    expect(parseShares('0.000000000000000001')).toBe(1n)
    expect(parseShares(' 2 ')).toBe(2n * 10n ** 18n)
    expect(parseShares('0')).toBe(0n)
    expect(parseShares('0.000000000000000000')).toBe(0n)
  })

  it('gives nothing for a 19th decimal, which would be rounded away', () => {
    expect(parseShares('0.0000000000000000001')).toBeNull()
    expect(parseShares('1.0000000000000000000')).toBeNull()
  })

  it.each(NOT_AMOUNTS)('gives nothing for %j', text => {
    expect(parseShares(text)).toBeNull()
  })

  it('gives nothing for more shares than a uint256 holds', () => {
    const most = ((1n << 256n) - 1n) / 10n ** 18n
    expect(parseShares(most.toString())).toBe(most * 10n ** 18n)
    expect(parseShares((most + 1n).toString())).toBeNull()
  })
})
