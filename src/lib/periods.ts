import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * Closing a period is the control that protects a filed figure.
 *
 * Everything the database needs for it has existed since 0003 and 0007 — the
 * status gate, the boundary freeze, the audit triggers, and
 * check_period_assignments(), which has had no caller at all. A detector nobody
 * runs is not a detector, which is what this file finally fixes.
 */

export class PeriodError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PeriodError'
  }
}

export type Readiness = {
  severity: 'blocking' | 'warning'
  /** 'period' if it is about this period alone; 'ledger' if about the whole book. */
  scope: 'period' | 'ledger'
  what: string
  detail: string
}

/**
 * What a person should see before closing a period.
 *
 * A WARNING is a judgement the owner is better placed to make: an accountant
 * may know perfectly well that a draft is going nowhere, and a system that
 * argues with someone who understands the situation better than it does is
 * worse than one that says what it sees. Warnings never refuse.
 *
 * A BLOCKING item is not a judgement. Both of them mean the figures about to be
 * frozen are not the ledger's — a cache that disagrees with the journal, or an
 * entry filed under a period it is not dated in. `closePeriod` refuses on
 * those, and an override has to be asked for explicitly and is recorded.
 */
export async function periodReadiness(ledgerId: string, periodId: string): Promise<Readiness[]> {
  const found: Readiness[] = []

  const [period] = await db.execute<{
    name: string; status: string; start_date: string; end_date: string
    year_name: string; fiscal_year_id: string
  }>(sql`
    SELECT fp.name, fp.status, fp.start_date::text, fp.end_date::text,
           fy.name AS year_name, fy.id::text AS fiscal_year_id
      FROM fiscal_period fp JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
     WHERE fp.id = ${periodId}::uuid AND fp.ledger_id = ${ledgerId}::uuid`)
  if (!period) throw new PeriodError('NO_PERIOD', 'That period does not exist.')

  // Drafts dated inside it. They are in no balance, so closing does not lose
  // them — but it does mean they can no longer be posted where they belong.
  const [drafts] = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM journal_entry
     WHERE ledger_id = ${ledgerId}::uuid AND status = 'draft'
       AND entry_date BETWEEN ${period.start_date}::date AND ${period.end_date}::date`)
  if (Number(drafts.n) > 0) {
    found.push({
      severity: 'warning',
      scope: 'period',
      what: `${drafts.n} draft${drafts.n === '1' ? '' : 's'} dated in ${period.name}`,
      detail: 'Closing does not delete them, but they can no longer be posted to this period. '
            + 'Post or discard them first, or reopen the period later.',
    })
  }

  // The cache every statement and the trial balance read.
  const drift = await db.execute<{ check_name: string }>(sql`
    SELECT check_name FROM check_balance_integrity(${ledgerId}::uuid) LIMIT 5`)
  if (drift.length > 0) {
    found.push({
      severity: 'blocking',
      scope: 'ledger',
      what: 'The balance cache disagrees with the journal',
      detail: 'Every figure on every statement comes from that cache. Rebuild the balances '
            + 'before closing, or the numbers being frozen are not the ledger\'s.',
    })
  }

  // The detector 0007 added and nothing has run until now.
  const misfiled = await db.execute<{ entry_no: string; reason: string }>(sql`
    SELECT entry_no, reason FROM check_period_assignments(${ledgerId}::uuid) LIMIT 5`)
  if (misfiled.length > 0) {
    found.push({
      severity: 'blocking',
      scope: 'ledger',
      what: `${misfiled.length} entr${misfiled.length === 1 ? 'y is' : 'ies are'} filed under the wrong period`,
      detail: misfiled.map((m) => `${m.entry_no}: ${m.reason}`).join('; '),
    })
  }

  // Entries sitting in a period that is not open. The ordinary case is none —
  // the gate refuses them — so anything here got in another way, and a period
  // being closed is exactly when someone should see it.
  const stranded = await db.execute<{ entry_no: string; period_name: string; period_status: string }>(sql`
    SELECT entry_no, period_name, period_status
      FROM check_entries_in_closed_periods(${ledgerId}::uuid) LIMIT 5`)
  if (stranded.length > 0) {
    found.push({
      severity: 'blocking',
      scope: 'ledger',
      what: `${stranded.length} entr${stranded.length === 1 ? 'y is' : 'ies are'} in a period that is not open`,
      detail: stranded.map((s) => `${s.entry_no} in ${s.period_name} (${s.period_status})`).join('; ')
            + ' — an entry cannot normally reach a closed period, so this got in another way.',
    })
  }

  // Accounts that reach no balance sheet or income statement line. (An
  // account tagged only with a cash-flow role is in this set too: the cash
  // flow statement reads it and nothing else does — 0075 says so in the
  // reason, and this wording says the same.)
  const invisible = await db.execute<{ code: string; name: string }>(sql`
    SELECT code, name FROM check_untagged_accounts(
      (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)) LIMIT 5`)
  if (invisible.length > 0) {
    found.push({
      severity: 'warning',
      scope: 'ledger',
      what: `${invisible.length} account${invisible.length === 1 ? '' : 's'} reach no balance sheet or income statement line`,
      detail: invisible.map((a) => `${a.code} ${a.name}`).join(', ')
            + ' — those statements will balance without them and still be incomplete.',
    })
  }

  // Earlier periods left open. Closing out of order is legal and confusing.
  const [earlier] = await db.execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM fiscal_period
     WHERE ledger_id = ${ledgerId}::uuid AND status = 'open'
       AND end_date < ${period.start_date}::date`)
  if (Number(earlier.n) > 0) {
    found.push({
      severity: 'warning',
      scope: 'ledger',
      what: `${earlier.n} earlier period${earlier.n === '1' ? ' is' : 's are'} still open`,
      detail: 'Periods are normally closed in order. Closing this one first is allowed.',
    })
  }

  return found
}

export async function closePeriod(
  ledgerId: string, periodId: string,
  opts: { lock?: boolean; actor?: string; overrideReason?: string } = {},
) {
  const actor = opts.actor ?? 'system'
  const status = opts.lock ? 'locked' : 'closed'

  // Refuse while the figures are known not to be the ledger's. This is checked
  // here rather than only on the screen: the screen's copy of the answer is a
  // moment old, and closing is the operation that makes a figure final.
  const blocking = (await periodReadiness(ledgerId, periodId))
    .filter((r) => r.severity === 'blocking')

  if (blocking.length > 0 && !opts.overrideReason?.trim()) {
    throw new PeriodError('NOT_READY',
      `${blocking.map((b) => b.what).join('; ')}. `
      + 'The figures this would freeze are not the ledger\'s. Fix it, or close with a reason.')
  }

  return db.transaction(async (tx) => {
    const [current] = await tx.execute<{ name: string; status: string }>(sql`
      SELECT name, status FROM fiscal_period
       WHERE id = ${periodId}::uuid AND ledger_id = ${ledgerId}::uuid FOR UPDATE`)
    if (!current) throw new PeriodError('NO_PERIOD', 'That period does not exist.')
    if (current.status === status) {
      throw new PeriodError('ALREADY', `${current.name} is already ${status}.`)
    }
    if (current.status === 'locked') {
      throw new PeriodError('LOCKED',
        `${current.name} is locked. A locked period is for figures that have been filed; `
        + 'reopen it only if the filing itself is being amended.')
    }

    // The audit row comes from the trigger in 0003, which reads closed_by.
    await tx.execute(sql`
      UPDATE fiscal_period SET status = ${status}, closed_at = now(), closed_by = ${actor}
       WHERE id = ${periodId}::uuid`)

    if (blocking.length > 0) {
      await tx.execute(sql`
        INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
        VALUES (${actor}, 'close_period_override', 'fiscal_period', ${periodId},
                ${JSON.stringify({ blocking: blocking.map((b) => b.what) })}::jsonb,
                ${JSON.stringify({ status })}::jsonb,
                ${JSON.stringify({ reason: opts.overrideReason!.trim(), name: current.name })}::jsonb)`)
    }

    return { name: current.name, status, overrode: blocking.map((b) => b.what) }
  })
}

export async function reopenPeriod(
  ledgerId: string, periodId: string, reason: string, actor = 'system',
) {
  if (!reason.trim()) {
    throw new PeriodError('NO_REASON',
      'Reopening a closed period changes figures that were treated as final. Say why.')
  }

  return db.transaction(async (tx) => {
    const [current] = await tx.execute<{ name: string; status: string; year_status: string }>(sql`
      SELECT fp.name, fp.status, fy.status AS year_status
        FROM fiscal_period fp JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
       WHERE fp.id = ${periodId}::uuid AND fp.ledger_id = ${ledgerId}::uuid FOR UPDATE`)
    if (!current) throw new PeriodError('NO_PERIOD', 'That period does not exist.')
    if (current.status === 'open') throw new PeriodError('ALREADY', `${current.name} is already open.`)
    if (current.year_status !== 'open') {
      throw new PeriodError('YEAR_CLOSED',
        `${current.name} is inside a fiscal year that is ${current.year_status}. Reopen the year first.`)
    }

    await tx.execute(sql`
      UPDATE fiscal_period SET status = 'open', closed_by = ${actor} WHERE id = ${periodId}::uuid`)

    // The trigger records the status change; the reason only exists here.
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
      VALUES (${actor}, 'reopen_period_reason', 'fiscal_period', ${periodId},
              ${JSON.stringify({ status: current.status })}::jsonb,
              ${JSON.stringify({ status: 'open' })}::jsonb,
              ${JSON.stringify({ reason: reason.trim(), name: current.name })}::jsonb)`)

    return { name: current.name, wasStatus: current.status }
  })
}

/**
 * Every period of a ledger, with what is in it — and the year it belongs to,
 * with the year's status, so the periods page can offer to reopen a closed
 * year where the year is named.
 *
 * `entries` counts everything on the record in the period, reversed entries
 * and their reversals included; `total` sums only what STANDS — posted
 * entries that are not themselves a reversal — because a reversed pair is
 * two entries about no money, and adding both made the period look twice
 * as busy as it was; `outside` counts what `entries` has and `total` has
 * not: the reversed originals AND the reversals, including a reversal posted
 * here of an entry that sits in an earlier period.
 */
export async function periodOverview(ledgerId: string) {
  return db.execute<{
    id: string; name: string; year_id: string; year_name: string; year_status: string; status: string
    start_date: string; end_date: string
    entries: string; outside: string; drafts: string; total: string
    closed_at: string | null; closed_by: string | null
  }>(sql`
    SELECT fp.id::text, fp.name, fy.id::text AS year_id, fy.name AS year_name, fy.status AS year_status, fp.status,
           fp.start_date::text, fp.end_date::text,
           (SELECT count(*)::text FROM journal_entry je
             WHERE je.period_id = fp.id AND je.status IN ('posted','reversed')) AS entries,
           (SELECT count(*)::text FROM journal_entry je
             WHERE je.period_id = fp.id
               AND (je.status = 'reversed' OR (je.status = 'posted' AND je.reverses_id IS NOT NULL))) AS outside,
           (SELECT count(*)::text FROM journal_entry je
             WHERE je.ledger_id = fp.ledger_id AND je.status = 'draft'
               AND je.entry_date BETWEEN fp.start_date AND fp.end_date) AS drafts,
           (SELECT COALESCE(SUM(je.total_debit), 0)::text FROM journal_entry je
             WHERE je.period_id = fp.id AND je.status = 'posted' AND je.reverses_id IS NULL) AS total,
           fp.closed_at::text, fp.closed_by
      FROM fiscal_period fp JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
     WHERE fp.ledger_id = ${ledgerId}::uuid
     ORDER BY fp.start_date`)
}

/** What has been done to a period, and by whom. */
export async function periodHistory(periodId: string) {
  return db.execute<{
    id: string; occurred_at: string; actor: string; action: string
    before_status: string | null; after_status: string | null; reason: string | null
  }>(sql`
    SELECT id::text, occurred_at::text, actor, action,
           before->>'status' AS before_status,
           after->>'status'  AS after_status,
           context->>'reason' AS reason
      FROM audit_log
     WHERE table_name = 'fiscal_period' AND record_id = ${periodId}
     -- id breaks the tie: the 0003 trigger and the explicit reason row are
     -- written in the same transaction and share occurred_at to the microsecond.
     ORDER BY occurred_at DESC, id DESC`)
}
