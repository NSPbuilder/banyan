import { formatNumber } from './numbers'

/**
 * Money is stored and computed as an integer number of cents, held in a BigInt.
 *
 * Why BigInt and not number: mixing a BigInt with a plain number throws a
 * TypeError instead of silently producing a float. In an accounting system
 * that noisy failure is worth much more than the convenience.
 */
export type Cents = bigint

const SCALE = 100n

/** '1234.56' | '1,234.56' | '$1,234.56' | 1234.56 -> 123456n */
export function parseMoney(input: string | number): Cents {
  const raw = String(input).trim().replace(/[$,\s]/g, '')
  if (raw === '') return 0n

  const m = /^(-?)(\d*)(?:\.(\d{0,}))?$/.exec(raw)
  if (!m) throw new Error(`Not a valid amount: "${input}"`)

  const [, sign, whole, frac = ''] = m
  if (frac.length > 2) throw new Error(`Amounts carry at most 2 decimals: "${input}"`)

  const cents = BigInt(whole || '0') * SCALE + BigInt(frac.padEnd(2, '0') || '0')
  return sign === '-' ? -cents : cents
}

/** 123456n -> '1,234.56' */
export function formatMoney(cents: Cents, opts: { sign?: 'accounting' | 'minus' } = {}): string {
  const negative = cents < 0n
  const abs = negative ? -cents : cents
  const whole = abs / SCALE
  const frac = abs % SCALE

  const body =
    formatNumber(whole) + '.' + frac.toString().padStart(2, '0')

  if (!negative) return body
  return opts.sign === 'accounting' ? `(${body})` : `-${body}`
}

/** Exact decimal text for a money input, without thousands separators. */
export function moneyInput(cents: Cents): string {
  return formatMoney(cents).replaceAll(',', '')
}

/**
 * Split an amount across n ways without losing a cent.
 * The remainder is handed to the earliest buckets, one cent each, so the parts
 * always add back up to the whole. Every allocation in this system must go
 * through here — that is the point of integer cents.
 */
export function allocate(total: Cents, weights: number[]): Cents[] {
  if (weights.length === 0) return []
  const totalWeight = weights.reduce((a, b) => a + b, 0)
  if (totalWeight <= 0) throw new Error('allocate() needs weights that sum above zero')

  const negative = total < 0n
  const abs = negative ? -total : total

  const parts = weights.map((w) => (abs * BigInt(Math.round(w * 1e6))) / BigInt(Math.round(totalWeight * 1e6)))
  let remainder = abs - parts.reduce((a, b) => a + b, 0n)

  for (let i = 0; remainder > 0n; i = (i + 1) % parts.length, remainder--) parts[i] += 1n

  return negative ? parts.map((p) => -p) : parts
}

/** Debit-positive convention: a debit is a positive amount, a credit negative. */
export const debit = (cents: Cents): Cents => (cents < 0n ? -cents : cents)
export const credit = (cents: Cents): Cents => (cents < 0n ? cents : -cents)
