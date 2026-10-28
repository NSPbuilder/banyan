import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { resolvePeriodSpan } from './balances'
import { renderStatement, type Statement, type StatementLine } from './statements'

/**
 * A statement beside the same statement for an earlier span — the comparative
 * column (owner, 2026-09-04: 报表对比).
 *
 * Two ways to choose the earlier span, both by DATE and then snapped to fiscal
 * months the way every span here is:
 *
 *   year   the same dates one year earlier — March 2026 beside March 2025,
 *          Q2 beside last Q2, the year beside last year
 *   prior  the span immediately before, as many fiscal months long —
 *          March beside February, Q2 beside Q1
 *
 * Both statements come from `renderStatement` with the same template, so the
 * lines are the same lines in the same order; the join is by position, and a
 * mismatch is reported rather than papered over, because a comparative column
 * whose rows have drifted is worse than none.
 */
export type CompareMode = 'year' | 'prior'

export const COMPARE_LABEL: Record<CompareMode, string> = {
  year: 'Same span last year',
  prior: 'The span before',
}

type Span = NonNullable<Awaited<ReturnType<typeof resolvePeriodSpan>>>

export async function compareDates(
  ledgerId: string, span: Span, mode: CompareMode,
): Promise<{ from: string; to: string } | null> {
  if (mode === 'year') {
    const [r] = await db.execute<{ from: string; to: string }>(sql`
      SELECT (${span.fromPeriod.start_date}::date - interval '1 year')::date::text AS "from",
             (${span.toPeriod.end_date}::date - interval '1 year')::date::text AS "to"`)
    return r ?? null
  }
  // As many fiscal months as the span has, ending just before it starts.
  const n = span.periods.length
  const before = await db.execute<{ start_date: string; end_date: string }>(sql`
    SELECT start_date::text, end_date::text FROM fiscal_period
     WHERE ledger_id = ${ledgerId}::uuid AND end_date < ${span.fromPeriod.start_date}::date
     ORDER BY start_date DESC LIMIT ${n}`)
  if (before.length === 0) return null
  return { from: before[before.length - 1].start_date, to: before[0].end_date }
}

export type ComparativeLine = Pick<StatementLine, 'label' | 'lineType' | 'indent' | 'accounts'> & {
  current: bigint
  compare: bigint | null
  change: bigint | null
}

export type Comparative = {
  current: Statement
  compare: Statement | null
  /** Why there is no comparison, when there is none. */
  reason: string | null
  compareSpan: Span | null
  lines: ComparativeLine[]
}

export async function renderComparative(
  ledgerId: string, templateCode: string, span: Span, mode: CompareMode | null,
): Promise<Comparative | null> {
  const current = await renderStatement(ledgerId, templateCode, span.toPeriod.id, span.fromPeriod.id)
  if (!current) return null
  const plain = (): Comparative => ({
    current, compare: null, reason: null, compareSpan: null,
    lines: current.lines.map((l) => ({
      label: l.label, lineType: l.lineType, indent: l.indent, accounts: l.accounts,
      current: l.shown, compare: null, change: null,
    })),
  })
  if (!mode) return plain()

  const dates = await compareDates(ledgerId, span, mode)
  const compareSpan = dates ? await resolvePeriodSpan(ledgerId, dates.from, dates.to) : null
  if (!compareSpan) {
    return { ...plain(), reason: mode === 'year'
      ? 'The books have no fiscal months a year earlier.'
      : 'The books have no fiscal months before this span.' }
  }
  // The earlier span must be AS LONG as this one and must not overlap it. The
  // first version refused only when nothing came back: three fiscal months
  // before a twelve-month span were rendered as a full year and subtracted
  // from it, and the Change column said so with a straight face (critic,
  // 2026-09-04). A comparison of unequal spans is not a comparison.
  if (compareSpan.periods.length !== span.periods.length
      || compareSpan.toPeriod.end_date >= span.fromPeriod.start_date) {
    return { ...plain(), reason: mode === 'year'
      ? `The books cover only ${compareSpan.periods.length} of the ${span.periods.length} fiscal months a year earlier.`
      : `Only ${compareSpan.periods.length} fiscal month${compareSpan.periods.length === 1 ? '' : 's'} come before this span, and it is ${span.periods.length} long.` }
  }
  const compare = await renderStatement(ledgerId, templateCode, compareSpan.toPeriod.id, compareSpan.fromPeriod.id)
  if (!compare) return plain()

  // Same template, same lines: join by position and refuse silently drifting.
  if (compare.lines.length !== current.lines.length
      || compare.lines.some((l, i) => l.label !== current.lines[i].label)) {
    return { ...plain(), reason: 'The two renders did not produce the same lines, so they cannot sit side by side.' }
  }
  return {
    current, compare, reason: null, compareSpan,
    lines: current.lines.map((l, i) => ({
      label: l.label, lineType: l.lineType, indent: l.indent, accounts: l.accounts,
      current: l.shown, compare: compare.lines[i].shown,
      change: l.lineType === 'header' || l.lineType === 'spacer' ? null : l.shown - compare.lines[i].shown,
    })),
  }
}
