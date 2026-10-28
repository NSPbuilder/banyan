/** Native money uses the currency's minor unit. Ledger money remains CAD cents. */
export const FX_SCALE = 1_000_000_000_000n
const MAX_MONEY = 9_223_372_036_854_775_807n

export class FxError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'FxError'
  }
}

export type FxSnapshot = {
  currency: string
  /** CAD for one major unit of foreign currency, fixed decimal text. */
  rate: string
  observedOn: string
  source: 'BOC' | 'manual' | 'carrying'
  reference: string
  settlement?: { bankCurrency: string; grossMinor: string; feeMinor: string; reference: string; actualRate?: FxSnapshot }
}

export function currencyDigits(currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency) || !Intl.supportedValuesOf('currency').includes(currency)) {
    throw new FxError('CURRENCY', 'Choose a recognized currency code.')
  }
  // ISO 4217 IDR uses two minor digits; ICU's local display convention rounds it to whole rupiah.
  // SIX List One: https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
  if (currency === 'IDR') return 2
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits!
}

export function fxDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(Date.parse(value + 'T00:00:00Z'))
      || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) {
    throw new FxError('DATE', 'Enter a valid date in YYYY-MM-DD format.')
  }
  return value
}

export function moneyRange(value: bigint): bigint {
  if (value > MAX_MONEY || value < -MAX_MONEY) throw new FxError('AMOUNT_RANGE', 'That amount exceeds the ledger range.')
  return value
}

export function parseNative(value: string, currency: string): bigint {
  const digits = currencyDigits(currency)
  const text = value.trim().replaceAll(',', '')
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!m || (m[3]?.length ?? 0) > digits) {
    throw new FxError('AMOUNT', `${currency} amounts allow at most ${digits} decimal places.`)
  }
  const units = BigInt(m[2]) * 10n ** BigInt(digits) + BigInt((m[3] ?? '').padEnd(digits, '0') || '0')
  return moneyRange(m[1] ? -units : units)
}

export function nativeInput(value: bigint, currency: string): string {
  const digits = currencyDigits(currency), scale = 10n ** BigInt(digits)
  const abs = value < 0n ? -value : value
  return (value < 0n ? '-' : '') + (abs / scale).toString()
    + (digits ? '.' + (abs % scale).toString().padStart(digits, '0') : '')
}

export function formatNative(value: bigint, currency: string): string {
  const [whole, fraction] = nativeInput(value, currency).split('.')
  return (value < 0n && BigInt(whole) === 0n ? '-' : '')
    + BigInt(whole).toLocaleString('en-CA') + (fraction === undefined ? '' : '.' + fraction)
}

/** A scoped formatter for bank amounts; no shared mutable display currency. */
export const nativeMoney = (currency = 'CAD') => (value: bigint, options: { sign?: 'accounting' | 'minus' } = {}) =>
  value < 0n && options.sign === 'accounting' ? `(${formatNative(-value, currency)})` : formatNative(value, currency)

/** Round halves away from zero; no floating-point money or exchange rates. */
export function roundRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new FxError('DIVISOR', 'The allocation denominator must be positive.')
  const negative = numerator < 0n, abs = negative ? -numerator : numerator
  const result = (abs + denominator / 2n) / denominator
  return negative ? -result : result
}

export function rateUnits(value: string): bigint {
  if (!/^\d{1,9}(?:\.\d{1,12})?$/.test(value)) throw new FxError('RATE', 'Enter a positive exchange rate with at most 12 decimal places.')
  const [whole, frac = ''] = value.split('.')
  const result = BigInt(whole) * FX_SCALE + BigInt(frac.padEnd(12, '0'))
  if (result <= 0n) throw new FxError('RATE', 'The exchange rate must be greater than zero.')
  return result
}

export function canonicalRate(value: string): string {
  const units = rateUnits(value)
  return `${units / FX_SCALE}.${(units % FX_SCALE).toString().padStart(12, '0')}`
}

export function toFunctional(native: bigint, currency: string, rate: string): bigint {
  return moneyRange(roundRatio(native * rateUnits(rate) * 100n, 10n ** BigInt(currencyDigits(currency)) * FX_SCALE))
}

export function carryingRate(base: bigint, native: bigint, currency: string): string {
  if (base === 0n && native !== 0n) return '0.000000000000'
  if (native === 0n || (base < 0n) !== (native < 0n)) throw new FxError('CARRYING', 'The carrying amount and native balance must have the same direction.')
  const units = roundRatio((base < 0n ? -base : base) * FX_SCALE * 10n ** BigInt(currencyDigits(currency)), (native < 0n ? -native : native) * 100n)
  return canonicalRate(`${units / FX_SCALE}.${(units % FX_SCALE).toString().padStart(12, '0')}`)
}

/** The last settlement consumes the exact residue, including prior rounding. */
export function releaseCarrying(carrying: bigint, nativeToSettle: bigint, nativeBalance: bigint): bigint {
  if (nativeToSettle <= 0n || nativeBalance <= 0n || nativeToSettle > nativeBalance) throw new FxError('OVERPAYS', 'Settlement must be positive and cannot exceed the native balance.')
  return nativeToSettle === nativeBalance ? carrying : roundRatio(carrying * nativeToSettle, nativeBalance)
}

export function validateSnapshot(snapshot: FxSnapshot): FxSnapshot {
  currencyDigits(snapshot.currency)
  fxDate(snapshot.observedOn)
  if (!['BOC', 'manual', 'carrying'].includes(snapshot.source) || !snapshot.reference?.trim() || snapshot.reference.length > 1000) {
    throw new FxError('RATE_EVIDENCE', 'Record the rate source and a reference for the actual rate used.')
  }
  if (snapshot.settlement) {
    const settlement=snapshot.settlement
    currencyDigits(settlement.bankCurrency)
    if (!/^[0-9]{1,19}$/.test(settlement.grossMinor) || !/^[0-9]{1,19}$/.test(settlement.feeMinor)
      || !settlement.reference?.trim() || settlement.reference.length>1000) throw new FxError('SETTLEMENT_EVIDENCE','Keep actual cash, fees and their source reference with the settlement.')
    moneyRange(BigInt(settlement.grossMinor));moneyRange(BigInt(settlement.feeMinor))
    if (settlement.actualRate) {
      if (settlement.actualRate.settlement) throw new FxError('SETTLEMENT_EVIDENCE','Actual-rate evidence cannot contain another settlement.')
      validateSnapshot(settlement.actualRate)
    }
  }
  return { ...snapshot, rate: snapshot.source === 'carrying' && /^0(?:\.0{1,12})?$/.test(snapshot.rate)
    ? '0.000000000000' : canonicalRate(snapshot.rate), reference: snapshot.reference.trim() }
}
