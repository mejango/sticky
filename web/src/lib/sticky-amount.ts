/** The most digits before the decimal point that fit in a uint256: 2^256 has 78. */
const MAX_WHOLE_DIGITS = 78

/**
 * An amount a holder typed, in the smallest units of a token with `decimals` (at most 255, a byte). It is digits with
 * at most one decimal point: no sign, exponent or separator. An amount with more decimal places than the token has is
 * refused and never rounded, and so is one that does not fit in a uint256. The messages are for the holder and start
 * in lowercase, to be used as the start of a sentence or after a prefix.
 */
export function parseAmount(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error('invalid token decimals')
  const input = text.trim()
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(input)) throw new Error('enter a valid amount')
  const [whole, fraction = ''] = input.split('.')
  if (fraction.length > decimals) throw new Error(`this token supports at most ${decimals} decimal places`)
  // Checked before the digits become a number, so that a long paste is never built into a huge one.
  if (whole.replace(/^0+/, '').length > MAX_WHOLE_DIGITS) throw new Error('that amount is too large')
  const amount = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  if (amount >= 1n << 256n) throw new Error('that amount is too large')
  return amount
}
