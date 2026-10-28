import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * Does the balance cache still describe the journal?
 *
 * Every statement — the templated ones, the cash flow, the changes in equity
 * — reads period_balance. If that cache is wrong, both sides of a statement
 * are wrong by the same amount and the totals still agree, so no check built
 * from a statement's own figures can see it. This is the one question that
 * reaches past the cache to the journal, and it is asked in one place so
 * every statement asks it the same way: the balance sheet did, the two
 * derived statements did not (whole-project audit, 2026-09-13).
 */
export async function driftProblem(ledgerId: string): Promise<string | null> {
  const drift = await db.execute<{ check_name: string }>(sql`
    SELECT check_name FROM check_balance_integrity(${ledgerId}::uuid) LIMIT 20`)
  if (drift.length === 0) return null
  const kinds = [...new Set(drift.map((d) => d.check_name))].join(', ')
  return `These figures come from a balance cache that no longer agrees with the journal ` +
    `(${drift.length === 20 ? '20 or more' : drift.length} disagreement${drift.length === 1 ? '' : 's'}: ${kinds}). ` +
    `Every figure below may be wrong. Rebuild the balances from the company page.`
}
