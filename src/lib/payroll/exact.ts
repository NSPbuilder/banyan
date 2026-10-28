/**
 * Exact arithmetic for payroll, in integer cents.
 *
 * The engine this is ported from used Python's `Decimal`; this repository's
 * money is `bigint` cents. Neither of them is a float, and that is the whole
 * point: CRA's formulas multiply a year's income by a rate and subtract a
 * constant, and a payroll that is a cent out every payday is wrong twenty-six
 * times a year in a way nobody notices until the T4 does not foot.
 *
 * So a rate is kept as an exact FRACTION (0.0595 is 595/10000, not 0.0595),
 * a chain of multiplications stays a fraction until the moment T4127 says to
 * round, and rounding is half away from zero — Python's ROUND_HALF_UP, which
 * is what the source engine and CRA's own tables use.
 */

/** An exact fraction. `den` is always positive. */
export type Frac = { num: bigint; den: bigint }

/** Cents as a fraction, so a whole expression can stay exact. */
export const asFrac = (cents: bigint): Frac => ({ num: cents, den: 1n })

/**
 * A decimal string as an exact fraction: '0.0595' → 595/10000.
 * Written as strings in `rates.ts` for exactly this reason.
 */
export function rate(decimal: string): Frac {
  const negative = decimal.startsWith('-')
  const body = negative ? decimal.slice(1) : decimal
  const [whole, frac = ''] = body.split('.')
  const den = 10n ** BigInt(frac.length)
  const num = BigInt(whole || '0') * den + BigInt(frac || '0')
  return { num: negative ? -num : num, den }
}

/** A decimal string of DOLLARS as integer cents: '3500.00' → 350000n. */
export function dollars(decimal: string): bigint {
  const f = rate(decimal)
  return roundFrac({ num: f.num * 100n, den: f.den })
}

export const mul = (a: Frac, b: Frac): Frac => ({ num: a.num * b.num, den: a.den * b.den })
export const add = (a: Frac, b: Frac): Frac =>
  ({ num: a.num * b.den + b.num * a.den, den: a.den * b.den })
export const sub = (a: Frac, b: Frac): Frac =>
  ({ num: a.num * b.den - b.num * a.den, den: a.den * b.den })
export const div = (a: Frac, b: Frac): Frac => ({
  num: b.num < 0n ? -a.num * b.den : a.num * b.den,
  den: b.num < 0n ? -a.den * b.num : a.den * b.num,
})

export const cmp = (a: Frac, b: Frac): number => {
  const left = a.num * b.den
  const right = b.num * a.den
  return left < right ? -1 : left > right ? 1 : 0
}
export const lesser = (a: Frac, b: Frac): Frac => (cmp(a, b) <= 0 ? a : b)

/**
 * To the nearest cent, half AWAY FROM ZERO — CRA's ordinary rounding, and
 * Python's ROUND_HALF_UP, which is what the ported engine's every figure was
 * checked against.
 */
export function roundFrac(f: Frac): bigint {
  const negative = f.num < 0n
  const n = negative ? -f.num : f.num
  const rounded = (2n * n + f.den) / (2n * f.den)
  return negative ? -rounded : rounded
}

/** Toward zero — the CPP per-period exemption, which T4127 Table 6.1 truncates. */
export function truncFrac(f: Frac): bigint {
  const negative = f.num < 0n
  const n = negative ? -f.num : f.num
  const truncated = n / f.den
  return negative ? -truncated : truncated
}

/** Multiply cents by a rate and round to the cent. */
export const atRate = (cents: bigint, r: Frac): bigint => roundFrac(mul(asFrac(cents), r))

export const clampAtLeastZero = (v: bigint): bigint => (v < 0n ? 0n : v)

/** `amount`, but never more than what is left of an annual maximum. */
export function capped(amount: bigint, remaining: bigint): bigint {
  const room = clampAtLeastZero(remaining)
  return amount <= room ? amount : room
}
