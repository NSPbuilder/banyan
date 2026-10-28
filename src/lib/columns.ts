import 'server-only'
import { resolvePeriodSpan } from './balances'
import { renderStatement, type Statement, type StatementLine } from './statements'
import { driftProblem } from './drift'

/**
 * One statement across a span, cut into columns — by month or by quarter, with
 * the whole span at the end (owner, 2026-09-12: 「我选了一年的时间段，我需要他
 * 能 by month，by quarter 按列呈现报表，最后要有 total」).
 *
 * NOTHING NEW COMPUTES A FIGURE HERE. Every column is `renderStatement` over a
 * shorter span, which is what makes this safe on both kinds of statement at
 * once: that function's own rule is that a flow line sums the movement across
 * the span while a POSITION line reads the end period, "because a position is a
 * fact about a moment and a range only chooses which moment ends it". So a
 * month's column is that month's activity on a profit and loss, and that month
 * END's balance on a balance sheet, with no branch here to get wrong.
 *
 * WHICH IS WHY THE LAST COLUMN IS NOT ALWAYS CALLED TOTAL. On a profit and loss
 * the whole span is the sum of the columns and Total is the word. On a balance
 * sheet the whole span is the closing position — it EQUALS the last column and
 * summing the columns would be nonsense — so it is called Closing and
 * `totalIsSum` says which of the two arithmetics holds. `T42` checks both.
 *
 * The join is by position and drift is refused rather than papered over, for
 * the reason `compare.ts` gives: columns whose rows have slipped against each
 * other are worse than no columns.
 */
export type Grouping = 'month' | 'quarter'

export const GROUPING_LABEL: Record<Grouping, string> = {
  month: 'By month',
  quarter: 'By quarter',
}

type Span = NonNullable<Awaited<ReturnType<typeof resolvePeriodSpan>>>
type Period = Span['periods'][number]

export type ColumnHead = {
  label: string
  from: string
  to: string
  /** How many fiscal months it covers — a short last group says so. */
  months: number
}

export type ColumnedLine = Pick<StatementLine, 'label' | 'lineType' | 'indent' | 'accounts'> & {
  /** One per column, in order; the whole-span figure is `total`, not in here. */
  amounts: bigint[]
  total: bigint
}

export type Columned = {
  whole: Statement
  columns: ColumnHead[]
  lines: ColumnedLine[]
  /** `Total` on a flow statement, `Closing` on a position one. */
  totalLabel: string
  /** Whether the columns are supposed to add up to that last figure. */
  totalIsSum: boolean
  /** Why there are no columns, when there are none. */
  reason: string | null
}

/** The span's fiscal months in groups of one or three, in order. */
export function groupPeriods(periods: Period[], by: Grouping): Period[][] {
  const size = by === 'quarter' ? 3 : 1
  const out: Period[][] = []
  for (let i = 0; i < periods.length; i += size) out.push(periods.slice(i, i + size))
  return out
}

/**
 * What a group is called. A full quarter is named by its ends; a group cut
 * short because the span did not divide by three is named the same way rather
 * than being called a quarter it is not.
 */
export const groupLabel = (group: Period[]): string => {
  const first = group[0]
  const last = group[group.length - 1]
  if (!first || !last) return '—'
  const range = `${first.name} – ${last.name}`
  return first.id === last.id ? first.name : range
}

export async function renderColumned(
  ledgerId: string, templateCode: string, span: Span, by: Grouping | null,
): Promise<Columned | null> {
  // The drift question once, for every column: each render reads the same cache.
  const drift = await driftProblem(ledgerId)
  const whole = await renderStatement(ledgerId, templateCode, span.toPeriod.id, span.fromPeriod.id, { drift })
  if (!whole) return null
  const position = whole.template.statementType === 'balance_sheet'
  const totalLabel = position ? 'Closing' : 'Total'
  const totalIsSum = !position
  const flat = (reason: string | null): Columned => ({
    whole, columns: [], lines: whole.lines.map((l) => ({
      label: l.label, lineType: l.lineType, indent: l.indent, accounts: l.accounts,
      amounts: [], total: l.shown,
    })),
    totalLabel, totalIsSum, reason,
  })
  if (!by) return flat(null)
  // One column and a total beside it would be the same figure twice.
  if (span.periods.length < 2) {
    return flat('The span is one fiscal month, so there is nothing to break it into.')
  }

  const groups = groupPeriods(span.periods, by)
  const rendered: Statement[] = []
  for (const group of groups) {
    const first = group[0]
    const last = group[group.length - 1]
    if (!first || !last) return flat('A group of fiscal months came back empty.')
    const st = await renderStatement(ledgerId, templateCode, last.id, first.id, { drift })
    if (!st) return flat('One of the columns would not render.')
    // Same template, same lines, joined by position — and a drift refused, not
    // papered over (`compare.ts` has the same rule for the same reason).
    if (st.lines.length !== whole.lines.length
        || st.lines.some((l, i) => l.label !== whole.lines[i]!.label)) {
      return flat(`${groupLabel(group)} did not produce the same lines as the span, `
        + 'so the columns cannot sit beside each other.')
    }
    rendered.push(st)
  }

  return {
    whole,
    columns: groups.map((g) => ({
      label: groupLabel(g),
      from: g[0]!.start_date,
      to: g[g.length - 1]!.end_date,
      months: g.length,
    })),
    lines: whole.lines.map((l, i) => ({
      label: l.label, lineType: l.lineType, indent: l.indent, accounts: l.accounts,
      amounts: rendered.map((st) => st.lines[i]!.shown),
      total: l.shown,
    })),
    totalLabel,
    totalIsSum,
    reason: null,
  }
}
