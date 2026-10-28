import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * Recompute period_balance for a ledger from its journal lines.
 *
 * The journal is the truth; period_balance is a cache of it. This is always
 * safe to run — it cannot alter a single entry — and it is the remedy whenever
 * check_balance_integrity() reports drift.
 *
 * Kept out of the server action itself so it can be tested without a request.
 */
export async function rebuildLedgerBalances(ledgerId: string, actor = 'system') {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ledgerId)) {
    throw new Error('Bad ledger id')
  }

  return db.transaction(async (tx) => {
    const [before] = await tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM check_balance_integrity(${ledgerId}::uuid)`)
    await tx.execute(sql`SELECT rebuild_period_balances(${ledgerId}::uuid)`)
    const [after] = await tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM check_balance_integrity(${ledgerId}::uuid)`)

    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
      VALUES (${actor}, 'rebuild_balances', 'period_balance', ${ledgerId},
              ${JSON.stringify({ findings: Number(before.n) })}::jsonb,
              ${JSON.stringify({ findings: Number(after.n) })}::jsonb,
              ${JSON.stringify({ ledgerId })}::jsonb)
    `)

    return { findingsBefore: Number(before.n), findingsAfter: Number(after.n) }
  })
}

/**
 * The trial balance for ONE period.
 *
 * It takes a period id, never a period number. `period_no` restarts at 1 in
 * every fiscal year, so filtering on it returned March 2026 AND March 2027 once
 * a second year existed — two years added together in one trial balance, and a
 * React duplicate-key warning as the only outward sign.
 */
/**
 * The fiscal periods covering a date range, snapped outward: the first period
 * whose end reaches `from`, the last whose start is within `to`. Screens whose
 * figures live in `period_balance` resolve their picker's range through this
 * and SAY when the snap moved the edges — the picker picks dates, the books
 * keep months.
 */
export async function resolvePeriodSpan(ledgerId: string, from: string, to: string) {
  const periods = await db.execute<{
    id: string; name: string; start_date: string; end_date: string; status: string
  }>(sql`
    SELECT fp.id::text, fp.name, fp.start_date::text, fp.end_date::text, fp.status
      FROM fiscal_period fp
     WHERE fp.ledger_id = ${ledgerId}::uuid
       AND fp.end_date >= ${from}::date
       AND fp.start_date <= ${to}::date
     ORDER BY fp.start_date`)
  if (periods.length === 0) return null
  const first = periods[0]
  const last = periods[periods.length - 1]
  return {
    fromPeriod: first,
    toPeriod: last,
    periods,
    snapped: first.start_date !== from || last.end_date !== to,
  }
}

/**
 * The books' first day — the ONE spelling: the first fiscal period's start.
 *
 * The home page, the report pages' "All time" preset and the breakdown's
 * position fallback all need this, and a second phrasing (min fiscal_year
 * start, say) would be the two-lists defect waiting for the day the two
 * tables disagree.
 */
export async function firstBookDay(ledgerId: string): Promise<string | null> {
  const [row] = await db.execute<{ start_date: string | null }>(sql`
    SELECT min(start_date)::text AS start_date FROM fiscal_period
     WHERE ledger_id = ${ledgerId}::uuid`)
  return row?.start_date ?? null
}

/**
 * Movement over a SPAN of periods, position at its end. `debit`/`credit` sum
 * every covered period's movement; `balance` is the closing balance of the
 * last period — a position, which a range does not change, only ends.
 */
export async function trialBalanceSpan(
  ledgerId: string, fromPeriodId: string, toPeriodId: string,
) {
  return db.execute<{
    id: string; code: string; name: string; debit: string; credit: string; balance: string
  }>(sql`
    WITH span AS (
      SELECT f.start_date, t.end_date, t.id AS to_id
        FROM fiscal_period f, fiscal_period t
       WHERE f.id = ${fromPeriodId}::uuid AND t.id = ${toPeriodId}::uuid
    )
    SELECT a.id::text, a.code, a.name,
           COALESCE(SUM(pb.period_debit), 0)::text AS debit,
           COALESCE(SUM(pb.period_credit), 0)::text AS credit,
           COALESCE(SUM(pb.closing_balance) FILTER (WHERE pb.period_id = span.to_id), 0)::text AS balance
      FROM span, period_balance pb
      JOIN account a ON a.id = pb.account_id
      JOIN fiscal_period fp ON fp.id = pb.period_id
     WHERE pb.ledger_id = ${ledgerId}::uuid
       AND fp.start_date >= span.start_date
       AND fp.end_date <= span.end_date
     GROUP BY a.id, a.code, a.name, span.to_id
     ORDER BY a.code`)
}

// One period is a span of one. Delegating (rather than keeping a second
// query) means a single arithmetic serves the overview, the CSV export and
// every caller — two implementations of "trial balance" could disagree.
export async function trialBalance(ledgerId: string, periodId: string) {
  return trialBalanceSpan(ledgerId, periodId, periodId)
}
