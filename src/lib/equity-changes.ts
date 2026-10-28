import 'server-only'
import { accountMovements, isPl, spanPeriod, total, type AccountMovement } from './movements'
import { driftProblem } from './drift'

/**
 * Statement of Changes in Equity (IAS 1.106), derived from the ledger's
 * movements. A matrix — rows are the reasons equity moved, columns are its
 * components — which is exactly what the linear template model could not
 * draw (02-roles-and-statements.md §六).
 *
 * The columns come from the equity classification roles: share capital,
 * contributed surplus, retained earnings, accumulated OCI. RETAINED EARNINGS
 * IS WIDER THAN THE ACCOUNT: it holds the retained_earnings accounts, the
 * dividends_declared contra, AND every revenue and expense account — because
 * an unclosed year's result is retained earnings that has not been moved yet
 * (the balance sheet's `current_earnings` line says the same thing). Drawn
 * that way, the year-end closing entry moves money between accounts of ONE
 * column and changes no figure on this statement, so a closed year and an
 * open year read the same, which is the whole point.
 *
 * The rows are the movements that are not shuffles: the profit (the P&L
 * accounts' movement), dividends declared, shares issued or redeemed,
 * contributions, other comprehensive income, and anything posted straight to
 * an equity account outside those (a prior-period adjustment), which is shown
 * as "Other movements" rather than hidden. Opening-balance entries dated
 * inside the span are shown as their own row for the same reason.
 *
 * The last row is a proof: the opening balance plus every row must equal what
 * the accounts hold at the end of the span, column by column. When it does
 * not, the statement says so.
 *
 * Figures are shown the way equity is read: a credit is positive. `raw` is
 * the ledger's sign; `shown` is −raw.
 */

export type EquityColumn = {
  code: string
  label: string
  /** Roles whose accounts feed this column. */
  roles: string[]
}

export const EQUITY_COLUMNS: EquityColumn[] = [
  { code: 'SC', label: 'Share capital', roles: ['share_capital'] },
  { code: 'CS', label: 'Contributed surplus', roles: ['contributed_surplus'] },
  { code: 'RE', label: 'Retained earnings', roles: ['retained_earnings', 'dividends_declared'] },
  { code: 'OCI', label: 'Accumulated OCI', roles: ['accumulated_oci'] },
]
const OTHER: EquityColumn = { code: 'OTHER', label: 'Other equity', roles: [] }

/** An account behind one cell, with what it contributed. Ledger sign. */
export type EquityCellAccount = { id: string; code: string; name: string; amount: bigint }

export type EquityRow = {
  code: string
  label: string
  lineType: 'opening' | 'movement' | 'closing'
  /** One figure per column, in column order, plus the total last. Ledger sign. */
  raw: bigint[]
  shown: bigint[]
  /**
   * The accounts behind each figure, in the same order — so every cell on this
   * matrix can be opened and shown to add up. The last entry is the Total
   * column's, which is every other column's put together.
   */
  accounts: EquityCellAccount[][]
}

export type EquityChanges = {
  period: { id: string; name: string; startDate: string; endDate: string; yearName: string }
  columns: EquityColumn[]
  rows: EquityRow[]
  problems: string[]
}


/** Which column an equity or P&L account feeds. */
export function columnOf(m: AccountMovement): EquityColumn {
  if (isPl(m)) return EQUITY_COLUMNS[2]
  for (const c of EQUITY_COLUMNS) if (m.roles.some((r) => c.roles.includes(r))) return c
  return OTHER
}

export async function renderEquityChanges(
  ledgerId: string, periodId: string, fromPeriodId: string = periodId,
): Promise<EquityChanges | null> {
  const period = await spanPeriod(ledgerId, fromPeriodId, periodId)
  if (!period) return null
  const all = await accountMovements(ledgerId, fromPeriodId, periodId)
  const problems: string[] = []
  // The same question the balance sheet asks first: is the cache these
  // figures come from still the journal's?
  const drift = await driftProblem(ledgerId)
  if (drift) problems.push(drift)

  const members = all.filter((m) => m.accountType === 'equity' || isPl(m))
  const inColumn = new Map<string, AccountMovement[]>()
  for (const m of members) {
    const c = columnOf(m)
    inColumn.set(c.code, [...(inColumn.get(c.code) ?? []), m])
  }
  const stray = (inColumn.get('OTHER') ?? []).filter((m) => m.opening !== 0n || m.movement !== 0n || m.openingEntries !== 0n || m.closing !== 0n)
  if (stray.length > 0) {
    problems.push(
      `${stray.length} equity account${stray.length === 1 ? '' : 's'} carr${stray.length === 1 ? 'ies' : 'y'} none of ` +
      `share_capital, contributed_surplus, retained_earnings, dividends_declared or accumulated_oci and ` +
      `${stray.length === 1 ? 'is' : 'are'} shown under "Other equity": ` + stray.map((m) => `${m.code} ${m.name}`).join(', '))
  }

  // Columns with anything in them, in the fixed order; retained earnings always.
  const live = [...EQUITY_COLUMNS, OTHER].filter((c) =>
    c.code === 'RE' || (inColumn.get(c.code) ?? []).some((m) =>
      m.opening !== 0n || m.openingEntries !== 0n || m.movement !== 0n || m.closingEntries !== 0n || m.closing !== 0n))

  /**
   * One row's figures AND the accounts behind each of them.
   *
   * The accounts are picked with the same `pick` and the same `only` that
   * produce the figure, in one pass — a cell whose rows were gathered by a
   * second, similar-looking filter is a trace that can disagree with the
   * number above it, which is the one thing a breakdown must never do.
   */
  const per = (pick: (m: AccountMovement) => bigint, only?: (m: AccountMovement) => boolean) => {
    const chosen = live.map((c) => (inColumn.get(c.code) ?? []).filter(only ?? (() => true)))
    return {
      raw: chosen.map((ms) => total(ms, pick)),
      accounts: chosen.map((ms) => ms
        .map((m) => ({ id: m.id, code: m.code, name: m.name, amount: pick(m) }))
        .filter((a) => a.amount !== 0n)),
    }
  }
  type Cells = ReturnType<typeof per>
  const withTotal = (xs: bigint[]) => [...xs, xs.reduce((a, b) => a + b, 0n)]
  const row = (code: string, label: string, lineType: EquityRow['lineType'], cells: Cells): EquityRow => {
    const full = withTotal(cells.raw)
    // The Total column is every other column's accounts together, which is
    // what makes its own breakdown add to the figure beside it.
    return {
      code, label, lineType, raw: full, shown: full.map((v) => -v),
      accounts: [...cells.accounts, cells.accounts.flat()],
    }
  }
  const nonZero = (r: EquityRow) => r.raw.some((v) => v !== 0n)

  const rows: EquityRow[] = []
  rows.push(row('OPEN', `Balance at start`, 'opening', per((m) => m.opening)))
  const entered = row('ENTERED', 'Opening balances entered', 'movement', per((m) => m.openingEntries))
  if (nonZero(entered)) rows.push(entered)

  const hasRole = (role: string) => (m: AccountMovement) => m.roles.includes(role)
  rows.push(row('PROFIT', 'Profit for the period', 'movement', per((m) => m.movement, isPl)))
  const dividends = row('DIV', 'Dividends declared', 'movement', per((m) => m.movement, hasRole('dividends_declared')))
  if (nonZero(dividends)) rows.push(dividends)
  const shares = per((m) => m.movement, (m) => !isPl(m) && hasRole('share_capital')(m))
  const sharesRow = row('SHARES', shares.raw.some((v) => v > 0n) && !shares.raw.some((v) => v < 0n) ? 'Shares redeemed' : 'Shares issued', 'movement', shares)
  if (nonZero(sharesRow)) rows.push(sharesRow)
  const contributions = row('CONTRIB', 'Contributions', 'movement', per((m) => m.movement, hasRole('contributed_surplus')))
  if (nonZero(contributions)) rows.push(contributions)
  const oci = row('OCI', 'Other comprehensive income', 'movement', per((m) => m.movement, hasRole('accumulated_oci')))
  if (nonZero(oci)) rows.push(oci)
  // Everything else that moved inside equity: retained earnings itself
  // (a prior-period adjustment), and any account in "Other equity".
  const named = (m: AccountMovement) => isPl(m)
    || ['dividends_declared', 'share_capital', 'contributed_surplus', 'accumulated_oci'].some((r) => m.roles.includes(r))
  const other = row('OTHER_MOVES', 'Other movements', 'movement', per((m) => m.movement, (m) => !named(m)))
  if (nonZero(other)) rows.push(other)

  const closing = row('CLOSE', `Balance at end`, 'closing', per((m) => m.closing))
  rows.push(closing)

  // The proof, column by column: opening plus every row shown equals closing.
  // Closing entries are absent from the rows on purpose — inside a column
  // they net to zero — so a closing entry that reached another column shows
  // up here as a difference.
  const summed = live.map((_, i) => rows.filter((r) => r.lineType !== 'closing').reduce((a, r) => a + r.raw[i], 0n))
  const off = live.map((c, i) => ({ c, off: closing.raw[i] - summed[i] })).filter((x) => x.off !== 0n)
  if (off.length > 0) {
    problems.push(
      `The statement does not reconcile: ` +
      off.map((x) => `${x.c.label} is off by ${(Number(x.off < 0n ? -x.off : x.off) / 100).toFixed(2)}`).join('; ') +
      `. A year-end closing entry that touched an account outside its column, or a balance the ledger's ` +
      `checks would refuse. Run the balance checks on the company page.`)
  }

  return { period, columns: live, rows, problems }
}
