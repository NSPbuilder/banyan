/**
 * The two BC sales-tax rates, and BC's commission for collecting the PST.
 *
 * NEITHER CAN BE CHECKED BY ARITHMETIC. The CRA payroll tables vet themselves —
 * a mistyped bracket constant disagrees with the brackets around it — and
 * nothing here does: 5, 7, and the four numbers of the commission scale are
 * simply what two governments say they are. So what this file can offer instead
 * is WHERE each figure was read and WHEN, and a screen that says how long ago
 * that was. A figure nothing can verify can still be dated
 * (owner, 2026-09-12).
 *
 * AND THEY ARE DATED THE OTHER WAY TOO — by the day they take effect, not only
 * by the day they were read. The rates were two bare constants, so raising the
 * GST would have pre-filled a back-dated invoice at the new rate. History was
 * never at risk (the stored truth is the line's own amount, which stays
 * editable) but a document entered late for an earlier period was.
 */
import { parseMoney } from './money'

export type DatedFigures<T> = T & {
  /** The first day these apply. */
  from: string
  /** Where they were read. */
  source: string
  /** The day somebody last read them there. */
  readOn: string
}

export const SALES_TAX: Array<DatedFigures<{ gst: bigint; pst: bigint }>> = [
  {
    from: '2013-04-01',
    gst: 5n,
    pst: 7n,
    source: 'canada.ca "GST/HST rates"; gov.bc.ca "PST rate"',
    readOn: '2026-09-04',
  },
]

/**
 * BC's commission for collecting PST, on a return filed and paid on time.
 *
 * UNLIKE THE RATES, THIS ONE IS NOT A PRE-FILL. It is line C of the PST return
 * and it decides what is owed, so a figure that has moved is money wrong on a
 * return rather than a suggestion somebody can correct in the box.
 */
export const PST_COMMISSION_SCALE: Array<DatedFigures<{
  flat: bigint; flatUpTo: bigint; ratePerMille: bigint; max: bigint
}>> = [
  {
    from: '2013-04-01',
    flat: 2200n,
    flatUpTo: 33333n,
    ratePerMille: 66n,
    max: 19800n,
    source: 'gov.bc.ca "PST commission"',
    readOn: '2026-09-04',
  },
]

export class TaxFigureError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'TaxFigureError'
  }
}

/** The entry in force on a day, latest first — and a refusal before the first. */
function inForceOn<T extends { from: string }>(list: T[], on: string, what: string): T {
  const found = [...list].reverse().find((e) => on >= e.from)
  if (!found) {
    throw new TaxFigureError('NO_FIGURES',
      `${what} on file start on ${list[0]?.from ?? '(nothing)'}, and this is dated ${on}.`)
  }
  return found
}

export const salesTaxOn = (on: string) => inForceOn(SALES_TAX, on, 'The sales tax rates')

/** The same, for a screen: nothing rather than a refusal when the day is too early. */
export function figuresOnOrNull(on: string) {
  try {
    return { rates: salesTaxOn(on), scale: commissionScaleOn(on) }
  } catch (e) {
    if (e instanceof TaxFigureError) return null
    throw e
  }
}
export const commissionScaleOn = (on: string) =>
  inForceOn(PST_COMMISSION_SCALE, on, 'The PST commission scale')

/** How long ago the figures in force on a day were last read at their source. */
export function daysSinceRead(readOn: string, today: string): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${readOn}T00:00:00Z`)) / 86400000)
}

/**
 * When a figure nobody can check is old enough to be worth re-reading. A year,
 * because these move at budgets, and a budget is annual.
 */
export const RE_READ_AFTER_DAYS = 365

/**
 * The four tags a money amount can carry, the owner's list verbatim:
 * GST / PST / GST+PST / out of scope. Tags drive RESIDENT computation — the
 * person types an amount and a tag; the figures below are derived, always by
 * this one function, on the client for preview and on the server for the
 * posting. Two implementations would be two answers.
 */
export type TaxCode = 'GST' | 'PST' | 'GST_PST' | 'OUT_OF_SCOPE'

/**
 * The four tags. THE RATE IS NOT IN THE LABEL any more, and that is deliberate:
 * a dropdown reading "GST 5%" beside a back-dated line computed at some other
 * rate is a second place for the figure to be stale, and it would have meant
 * threading the document's date through four client components to keep the two
 * agreeing. Every form already shows the tax it worked out for the row, which
 * is the number that matters; the rates themselves, with where and when they
 * were read, are on the tax screen (owner, 2026-09-12).
 */
export const TAX_CODES: Array<{ code: TaxCode; label: string }> = [
  { code: 'OUT_OF_SCOPE', label: 'Out of scope' },
  { code: 'GST', label: 'GST' },
  { code: 'PST', label: 'PST' },
  { code: 'GST_PST', label: 'GST+PST' },
]

/**
 * NOTHING IS LOOKED UP FOR A LINE THAT CARRIES NO TAX. This asked the table
 * first and read the code second, so an out-of-scope line on a document dated
 * before the earliest figures was refused for a rate it did not want — and on
 * the invoice door that refusal escaped every catch and reached the browser as
 * a crash (independent critic, 2026-09-12).
 */
const rate = (code: TaxCode, on: string) => {
  if (code === 'OUT_OF_SCOPE') return { g: 0n, p: 0n }
  const r = salesTaxOn(on)
  return {
    g: code === 'GST' || code === 'GST_PST' ? r.gst : 0n,
    p: code === 'PST' || code === 'GST_PST' ? r.pst : 0n,
  }
}

const half = (num: bigint, den: bigint) => (num + den / 2n) / den

/**
 * What a tagged amount is made of. Integer cents throughout, half-up.
 *
 * Exclusive: the typed amount IS the base; taxes stack on top.
 * Inclusive: the typed amount is the TOTAL; the base is backed out at the
 * combined rate and the rounding remainder lands in the base — the taxes are
 * each computed at their own rate so the two boxes on a return are exact,
 * and base + gst + pst always reproduces the typed total to the cent.
 */
export function computeTax(amount: bigint, code: TaxCode, inclusive: boolean, on: string): {
  base: bigint; gst: bigint; pst: bigint; total: bigint
} {
  const { g, p } = rate(code, on)
  if (g === 0n && p === 0n) return { base: amount, gst: 0n, pst: 0n, total: amount }
  if (!inclusive) {
    const gst = half(amount * g, 100n)
    const pst = half(amount * p, 100n)
    return { base: amount, gst, pst, total: amount + gst + pst }
  }
  const base0 = half(amount * 100n, 100n + g + p)
  const gst = half(base0 * g, 100n)
  const pst = half(base0 * p, 100n)
  return { base: amount - gst - pst, gst, pst, total: amount }
}

export type TaxOverrides = { gst?: bigint; pst?: bigint }

export function parseTaxOverride(raw?: string | null): bigint | undefined {
  if (!raw?.trim()) return undefined
  if (!/\d/.test(raw)) throw new TaxFigureError('BAD_TAX_AMOUNT', 'Enter a tax amount with at most two decimals.')
  return parseMoney(raw)
}

/** Actual tax amounts override suggestions. A blank override still uses the
 * dated rate; zero is an explicit amount. Signs follow what the row adds. */
export function computeEnteredTax(
  amount: bigint, code: TaxCode, inclusive: boolean, on: string, overrides: TaxOverrides = {},
): ReturnType<typeof computeTax> {
  const wantsGst = code === 'GST' || code === 'GST_PST'
  const wantsPst = code === 'PST' || code === 'GST_PST'
  const sign = amount < 0n ? -1n : 1n
  const absolute = sign * amount
  for (const [name, selected, value] of [
    ['GST', wantsGst, overrides.gst], ['PST', wantsPst, overrides.pst],
  ] as const) {
    if (value === undefined) continue
    if (!selected && value !== 0n) throw new TaxFigureError('TAX_NOT_SELECTED', `Select ${name} in the tax code first.`)
    if (sign * value < 0n) throw new TaxFigureError('TAX_SIGN', `${name} must have the same sign as the amount.`)
  }
  // Fully specified amounts need no rate lookup (including historical dates).
  const autoGst = wantsGst && overrides.gst === undefined
  const autoPst = wantsPst && overrides.pst === undefined
  const automatic: TaxCode = autoGst && autoPst ? 'GST_PST' : autoGst ? 'GST' : autoPst ? 'PST' : 'OUT_OF_SCOPE'
  const fixed = sign * ((overrides.gst ?? 0n) + (overrides.pst ?? 0n))
  if (inclusive && fixed > 0n && fixed >= absolute) {
    throw new TaxFigureError('TAX_TOTAL', 'GST and PST must be less than the tax-included amount.')
  }
  const suggested = computeTax(inclusive ? absolute - fixed : absolute, automatic, inclusive, on)
  const gst = overrides.gst === undefined ? suggested.gst : sign * overrides.gst
  const pst = overrides.pst === undefined ? suggested.pst : sign * overrides.pst
  if (inclusive && absolute > 0n && gst + pst >= absolute) {
    throw new TaxFigureError('TAX_TOTAL', 'GST and PST must be less than the tax-included amount.')
  }
  const base = inclusive ? absolute - gst - pst : absolute
  return { base: sign * base, gst: sign * gst, pst: sign * pst,
    total: inclusive ? amount : amount + sign * (gst + pst) }
}

/**
 * What of the PST collected in a period the collector keeps:
 *
 *   collectable up to $22.00   → the whole amount
 *   $22.01 to $333.33          → $22.00
 *   over $333.33               → 6.6%, to a maximum of $198.00
 *
 * Late returns get no commission, and the worksheet says so beside the line.
 * The scale in force is chosen by the period's own end date, so a return filed
 * for an earlier period is worked out on the scale of that period.
 */
export function pstCommission(collectable: bigint, on: string): bigint {
  const scale = commissionScaleOn(on)
  if (collectable <= 0n) return 0n
  if (collectable <= scale.flat) return collectable
  if (collectable <= scale.flatUpTo) return scale.flat
  const pct = half(collectable * scale.ratePerMille, 1000n)
  return pct > scale.max ? scale.max : pct
}
