import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, type Tx } from './acting'
import { daysInMonth } from './dates'
import { GST_EDITABLE_LINES, type GstAdjustment, type GstKey } from './gst-adjustment-fields'
import { parseMoney } from './money'

export class GstAdjustmentError extends Error {}
const validDate = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  return y >= 1900 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
}
const checkRange = (ledgerId: string, from: string, to: string) => {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(ledgerId)
      || !validDate(from) || !validDate(to) || from > to)
    throw new GstAdjustmentError('Choose a valid company and return date range.')
}
export async function gstAdjustmentFor(ledgerId: string, from: string, to: string, on: Pick<Tx, 'execute'> = db) {
  checkRange(ledgerId, from, to)
  const [row] = await on.execute<GstAdjustment>(sql`SELECT id::text, sales::text, collected::text,
    itcs::text, reason, version, updated_at::text, updated_by FROM gst_return_adjustment
    WHERE ledger_id=${ledgerId}::uuid AND from_date=${from}::date AND to_date=${to}::date`)
  return row ?? null
}
export async function saveGstAdjustment(ledgerId: string, actor: string, input: {
  from: string; to: string; version: number; reason: string; reset?: boolean
  sales: string; collected: string; itcs: string
}) {
  checkRange(ledgerId, input.from, input.to)
  if (!Number.isSafeInteger(input.version) || input.version < 0)
    throw new GstAdjustmentError('Reload the return before saving.')
  const values = {} as Record<GstKey, string | null>
  for (const { key, line } of GST_EDITABLE_LINES) {
    const text = input.reset ? '' : input[key].trim()
    if (!text) { values[key] = null; continue }
    try {
      if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) throw Error()
      const cents = parseMoney(text)
      if (cents < -9_000_000_000_000_000_000n || cents > 9_000_000_000_000_000_000n) throw Error()
      values[key] = String(cents)
    } catch { throw new GstAdjustmentError(`Line ${line}: enter an amount with at most two decimal places, or leave it blank to use the books.`) }
  }
  const reason = input.reset ? 'Reset to book figures' : input.reason.trim()
  if (!reason || reason.length > 4000) throw new GstAdjustmentError('Explain the change in 1–4,000 characters.')
  return db.transaction(async tx => {
    await acting(tx, actor)
    const [ledger] = await tx.execute(sql`SELECT l.id FROM ledger l JOIN entity e ON e.id=l.entity_id
      WHERE l.id=${ledgerId}::uuid AND e.archived_at IS NULL FOR SHARE OF e`)
    if (!ledger) throw new GstAdjustmentError('This company is unavailable or archived.')
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gst:${ledgerId}:${input.from}:${input.to}`},0))`)
    const before = await gstAdjustmentFor(ledgerId, input.from, input.to, tx)
    if ((before?.version ?? 0) !== input.version)
      throw new GstAdjustmentError('This return changed in another window. Reload it before saving.')
    if (!before && GST_EDITABLE_LINES.every(({ key }) => values[key] === null)) return { version: 0 }
    if (before && before.reason === reason && GST_EDITABLE_LINES.every(({ key }) => before[key] === values[key]))
      return { version: before.version }
    const [row] = await tx.execute<{ version: number }>(sql`INSERT INTO gst_return_adjustment
      (ledger_id,from_date,to_date,sales,collected,itcs,reason,updated_by)
      VALUES(${ledgerId}::uuid,${input.from}::date,${input.to}::date,${values.sales}::bigint,
        ${values.collected}::bigint,${values.itcs}::bigint,${reason},${actor})
      ON CONFLICT(ledger_id,from_date,to_date) DO UPDATE SET sales=excluded.sales,collected=excluded.collected,
        itcs=excluded.itcs,reason=excluded.reason,updated_by=excluded.updated_by,
        updated_at=clock_timestamp(),version=gst_return_adjustment.version+1 RETURNING version`)
    return row
  })
}
