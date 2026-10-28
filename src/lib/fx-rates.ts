import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, type Runner } from './acting'
import { FxError, canonicalRate, currencyDigits, fxDate, validateSnapshot, type FxSnapshot } from './fx-money'

const VALET = 'https://www.bankofcanada.ca/valet'
const MAX_BYTES = 2 * 1024 * 1024
type JsonObject = Record<string, unknown>
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FxError('BOC_DATA', 'BOC returned an invalid data shape.')
  return value as JsonObject
}

export function parseBocCatalog(value: unknown) {
  const group = object(object(value).groupDetail)
  if (group.name !== 'FX_RATES_DAILY') throw new FxError('BOC_GROUP', 'Unexpected BOC exchange-rate group.')
  const rows = Object.entries(object(group.groupSeries)).map(([series, entry]) => {
    if (!/^FX[A-Z]{3}CAD$/.test(series)) throw new FxError('BOC_SERIES', 'Unexpected BOC currency series.')
    const currency = series.slice(2, 5), detail = object(entry)
    const description = detail.description
    if (typeof description !== 'string' || description.length > 2000 || detail.label !== `${currency}/CAD`) throw new FxError('BOC_DATA', 'BOC currency metadata is incomplete.')
    return { currency, series, name: description, digits: currencyDigits(currency), historical: description.toLowerCase().includes('historical series') }
  })
  if (!rows.length || rows.length > 200) throw new FxError('BOC_DATA', 'BOC returned an empty or oversized currency catalog.')
  return rows
}

export function parseBocObservations(value: unknown, series: Set<string>, from: string, to: string): FxSnapshot[] {
  fxDate(from); fxDate(to)
  const data = object(value)
  if (!Array.isArray(data.observations) || data.observations.length > 40) throw new FxError('BOC_DATA', 'BOC returned invalid observations.')
  const result: FxSnapshot[] = [], seen = new Set<string>()
  for (const raw of data.observations) {
    const row = object(raw), date = String(row.d)
    fxDate(date)
    if (date < from || date > to) throw new FxError('BOC_DATE', 'BOC returned a rate outside the requested dates.')
    for (const [key, observation] of Object.entries(row)) {
      if (key === 'd') continue
      if (!series.has(key) || !/^FX[A-Z]{3}CAD$/.test(key)) throw new FxError('BOC_SERIES', 'BOC returned an unexpected series.')
      const quote = object(observation)
      if (quote.v === undefined || quote.v === null || quote.v === '') continue
      if (typeof quote.v !== 'string') throw new FxError('BOC_RATE', 'BOC rates must be decimal text.')
      const id = `${key}:${date}`
      if (seen.has(id)) throw new FxError('BOC_DATA', 'BOC returned a duplicate quote.')
      seen.add(id)
      result.push(validateSnapshot({ currency: key.slice(2, 5), rate: canonicalRate(quote.v), observedOn: date,
        source: 'BOC', reference: `${VALET}/observations/${key}/json?start_date=${date}&end_date=${date}` }))
    }
  }
  return result
}

async function valetJson(path: string): Promise<unknown> {
  const response = await fetch(VALET + path, { signal: AbortSignal.timeout(15_000), cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } })
  if (!response.ok || !response.body) throw new FxError('BOC_UNAVAILABLE', `BOC is unavailable (${response.status}). Saved rates remain available; try again or enter an evidenced actual rate.`)
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_BYTES) throw new FxError('BOC_SIZE', 'The BOC response exceeds the allowed size.')
      chunks.push(chunk.value)
    }
  } finally { await reader.cancel() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new FxError('BOC_DATA', 'BOC did not return valid JSON.') }
}

/** An explicit operator refresh; fetching rates never enables a currency. */
export async function refreshFxRates(date: string, actor: string) {
  fxDate(date)
  const catalog = parseBocCatalog(await valetJson('/groups/FX_RATES_DAILY/json'))
  const from = new Date(Date.parse(date + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10)
  const observations = parseBocObservations(await valetJson(`/observations/group/FX_RATES_DAILY/json?start_date=${from}&end_date=${date}`), new Set(catalog.map(c => c.series)), from, date)
  return db.transaction(async tx => {
    await acting(tx, actor)
    for (const row of catalog) {
      const [old] = await tx.execute<{ minor_digits: number }>(sql`SELECT minor_digits FROM fx_currency WHERE code=${row.currency} FOR UPDATE`)
      if (old && old.minor_digits !== row.digits) throw new FxError('PRECISION_CHANGED', 'Currency precision changed; a reviewed migration is required before using that catalog.')
      await tx.execute(sql`INSERT INTO fx_currency(code,name,minor_digits,boc_series,historical)
        VALUES(${row.currency},${row.name},${row.digits},${row.series},${row.historical})
        ON CONFLICT(code) DO UPDATE SET name=excluded.name,boc_series=excluded.boc_series,historical=excluded.historical`)
    }
    for (const quote of observations) await tx.execute(sql`INSERT INTO fx_rate(currency,observed_on,rate,source,reference)
      VALUES(${quote.currency},${quote.observedOn}::date,${quote.rate}::numeric,'BOC',${quote.reference})
      ON CONFLICT(currency,observed_on) DO UPDATE SET rate=excluded.rate,reference=excluded.reference,fetched_at=now()`)
    await tx.execute(sql`INSERT INTO audit_log(actor,action,table_name,record_id,context)
      VALUES(${actor},'fx_reference_refresh','fx_rate',${date},${JSON.stringify({ date, currencies: catalog.length, quotes: observations.length })}::jsonb)`)
    return { currencies: catalog.length, quotes: observations.length, from, to: date }
  })
}

export async function fxRateFor(currency: string, date: string, on: Runner = db, actual?: FxSnapshot): Promise<FxSnapshot> {
  fxDate(date)
  if (currency === 'CAD') return { currency, rate: '1.000000000000', observedOn: date, source: 'carrying', reference: 'Functional currency' }
  if (actual) {
    const quote = validateSnapshot(actual)
    if (quote.currency !== currency || quote.observedOn > date || quote.source !== 'manual') throw new FxError('ACTUAL_RATE', 'An actual rate must name this currency, its source evidence and a date no later than the transaction.')
    return quote
  }
  const [row] = await on.execute<{ rate: string; observed_on: string; reference: string }>(sql`
    SELECT rate::text,observed_on::text,reference FROM fx_rate WHERE currency=${currency}
      AND observed_on<=${date}::date AND observed_on>=${date}::date-7 ORDER BY observed_on DESC LIMIT 1`)
  if (!row) throw new FxError('RATE_MISSING', `No ${currency}/CAD quote is saved within seven days on or before ${date}. Fetch BOC rates or enter an actual rate with evidence.`)
  return { currency, rate: canonicalRate(row.rate), observedOn: row.observed_on, source: 'BOC', reference: row.reference }
}
