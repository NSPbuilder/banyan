import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * What every account did over a span, read from the journal itself.
 *
 * The two statements the linear template model cannot render — cash flows
 * and changes in equity — are both statements about MOVEMENT, and both need
 * to tell three kinds of movement apart that `period_balance` folds together:
 *
 *   opening-balance entries   the books' starting position, entered as an
 *                             entry dated inside the first span. Not a flow:
 *                             nobody paid the opening cash in that month.
 *   closing entries           the year-end entry that moves the year's result
 *                             into retained earnings, and its reversal when a
 *                             year is reopened. A shuffle between equity
 *                             components; not income, not a flow.
 *   everything else           the transactions of the span.
 *
 * A reversal is classed by the ROOT of its chain — the entry with no
 * `reverses_id` — not by its own source type, which is always 'adjustment':
 * otherwise reopening a year would exclude the close and count the reversal,
 * and the two would no longer cancel. The whole chain, not one hop: the
 * reversal of a reopen is reachable from the entry screen ("Reverse it
 * without replacing" on a posted reversal), and the first version classed
 * that second hop by the first reversal's own 'adjustment' (critic).
 *
 * Every figure is signed the way the ledger signs it: debit positive, credit
 * negative. `opening + openingEntries + movement + closingEntries = closing`
 * for every account, and each of the four sums to zero across the ledger —
 * the identities the statements' own proof lines rest on.
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'

export type AccountMovement = {
  id: string
  code: string
  name: string
  accountType: AccountType
  roles: string[]
  /** Balance the day before the span begins. */
  opening: bigint
  /** Opening-balance entries dated inside the span. */
  openingEntries: bigint
  /** The span's transactions, less closing entries and their reversals. */
  movement: bigint
  /** Year-end closing entries and their reversals, dated inside the span. */
  closingEntries: bigint
  /** Balance at the span's last day. */
  closing: bigint
}

export type SpanDates = { fromPeriodId: string; toPeriodId: string }

/** The dates a span of fiscal periods covers — the `span` CTE every ranged query opens with. */
export const spanDates = (fromPeriodId: string, toPeriodId: string) => sql`
      SELECT f.start_date, t.end_date
        FROM fiscal_period f, fiscal_period t
       WHERE f.id = ${fromPeriodId}::uuid AND t.id = ${toPeriodId}::uuid`

/** A profit-and-loss account: the two types a year's close sweeps into equity. */
export const isPl = (m: AccountMovement) => m.accountType === 'revenue' || m.accountType === 'expense'

export async function accountMovements(
  ledgerId: string, fromPeriodId: string, toPeriodId: string,
): Promise<AccountMovement[]> {
  const rows = await db.execute<{
    id: string; code: string; name: string; account_type: AccountType; roles: string[]
    opening: string; opening_entries: string; movement: string; closing_entries: string; closing: string
  }>(sql`
    WITH RECURSIVE span AS (${spanDates(fromPeriodId, toPeriodId)}),
    -- Every entry, with the source of the ROOT of its reversal chain: the
    -- roots are the entries that reverse nothing; each step adds the
    -- entries that reverse a node already reached.
    root AS (
      SELECT id, source_type AS root_source, 0 AS depth
        FROM journal_entry
       WHERE ledger_id = ${ledgerId}::uuid AND reverses_id IS NULL
      UNION ALL
      SELECT je.id, root.root_source, root.depth + 1
        FROM journal_entry je
        JOIN root ON je.reverses_id = root.id
       WHERE root.depth < 32
    ),
    lines AS (
      SELECT jl.account_id, jl.amount, je.entry_date,
             -- A reversal wears the source of the root it descends from.
             COALESCE(root.root_source, je.source_type) AS source
        FROM journal_line jl
        JOIN journal_entry je ON je.id = jl.entry_id
        LEFT JOIN root ON root.id = je.id
        CROSS JOIN span
       WHERE je.ledger_id = ${ledgerId}::uuid
         AND je.status IN ('posted', 'reversed')
         AND je.entry_date <= span.end_date
    )
    SELECT a.id::text, a.code, a.name, a.account_type,
           COALESCE((SELECT array_agg(ar.role ORDER BY ar.role) FROM account_role ar WHERE ar.account_id = a.id), '{}') AS roles,
           COALESCE(SUM(l.amount) FILTER (WHERE l.entry_date < span.start_date), 0)::text AS opening,
           COALESCE(SUM(l.amount) FILTER (WHERE l.entry_date >= span.start_date AND l.source = 'opening_balance'), 0)::text AS opening_entries,
           COALESCE(SUM(l.amount) FILTER (WHERE l.entry_date >= span.start_date AND l.source NOT IN ('opening_balance', 'period_close')), 0)::text AS movement,
           COALESCE(SUM(l.amount) FILTER (WHERE l.entry_date >= span.start_date AND l.source = 'period_close'), 0)::text AS closing_entries,
           COALESCE(SUM(l.amount), 0)::text AS closing
      FROM account a
      CROSS JOIN span
      LEFT JOIN lines l ON l.account_id = a.id
     WHERE a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
     GROUP BY a.id, a.code, a.name, a.account_type, span.start_date
     ORDER BY a.code`)
  return rows.map((r) => ({
    id: r.id, code: r.code, name: r.name, accountType: r.account_type, roles: r.roles,
    opening: BigInt(r.opening), openingEntries: BigInt(r.opening_entries),
    movement: BigInt(r.movement), closingEntries: BigInt(r.closing_entries), closing: BigInt(r.closing),
  }))
}

/** The span's periods, named, for a statement's heading — the same shape renderStatement returns. */
export async function spanPeriod(ledgerId: string, fromPeriodId: string, toPeriodId: string) {
  const [row] = await db.execute<{
    id: string; name: string; start_date: string; end_date: string; year_name: string
  }>(sql`
    SELECT t.id::text, t.name, f.start_date::text, t.end_date::text, fy.name AS year_name
      FROM fiscal_period f, fiscal_period t
      JOIN fiscal_year fy ON fy.id = t.fiscal_year_id
     WHERE f.id = ${fromPeriodId}::uuid AND t.id = ${toPeriodId}::uuid
       AND f.ledger_id = ${ledgerId}::uuid AND t.ledger_id = ${ledgerId}::uuid`)
  return row ? { id: row.id, name: row.name, startDate: row.start_date, endDate: row.end_date, yearName: row.year_name } : null
}

const sum = (xs: Iterable<bigint>) => { let t = 0n; for (const x of xs) t += x; return t }
export const total = (ms: AccountMovement[], pick: (m: AccountMovement) => bigint) => sum(ms.map(pick))
