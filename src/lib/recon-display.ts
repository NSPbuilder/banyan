import type { ClearedRow, Reconciliation, ReconcileView, UnclearedEntry } from './bank'

/**
 * The display split of a reconciliation — three totals, and the FOUR parts
 * that add up to the printed difference. Extracted from the screen's Summary
 * so the PDF report shows the same rows from the same spelling; the shape's
 * reasoning (why four rows for three explanations, why the two halves are
 * shown net of each other) lives on the Summary component, which renders
 * exactly this. `M66` proves the four printed parts sum to the printed
 * difference; `M75` proves the report carries the block.
 *
 * No `server-only` here: the client Summary imports these, the server PDF
 * does too. Pure arithmetic on an already-derived Reconciliation.
 */
export function reconciliationTotals(recon: Reconciliation): Array<[string, bigint]> {
  return [
    ['The statement says', recon.statement],
    ['The books say', recon.books],
    ['Difference', recon.difference],
  ]
}

export function reconciliationParts(recon: Reconciliation): Array<[string, bigint, string]> {
  return [
    ['Statement rows nothing accounts for', recon.statementUnaccounted, 'rows still to reconcile'],
    ['Where the account started', -recon.openingPosition,
      'the opening balance — a position, not something the statement can show'],
    ['Book movement no row claims', -(recon.booksUnclaimed - recon.openingPosition),
      'entries the statement has not shown yet'],
    ['Timing differences', recon.straddling, 'matched, but the two sides fall on opposite days'],
  ]
}

/**
 * The four figures of a reconciliation, the QuickBooks way — label, amount,
 * and the note under it. The panel, the print page and the PDF all print
 * these from here, so "Cleared balance" cannot be computed one way on the
 * screen and another on paper.
 */
export function reconcileFigures(view: ReconcileView): Array<[string, bigint, string]> {
  return [
    ['Beginning balance', view.beginningBalance,
      view.beginningDate ? `statement of ${view.beginningDate}` : 'no earlier statement'],
    ['Cleared balance', view.cleared,
      `${view.clearedRows.length} row${view.clearedRows.length === 1 ? '' : 's'} matched to the books`],
    ['Statement ending balance', view.endingBalance, 'as printed'],
    ['Difference', view.difference,
      view.difference === 0n ? 'nothing left to explain' : 'must be zero to finish'],
  ]
}

/** What kind of entry this is, the way a report names it. */
export function entryTypeLabel(sourceType: string | null): string {
  switch (sourceType) {
    case null: case undefined: case 'manual': return 'Journal'
    case 'bank': return 'Bank feed'
    case 'opening_balance': return 'Opening balance'
    case 'payroll': return 'Payroll'
    default: return sourceType.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  }
}

export type ReportLine = { label: string; amount: bigint; rule?: 'single' | 'double'; gapBefore?: boolean }

/**
 * The reconciliation report's Summary, in the shape the owner handed over
 * (QuickBooks', 2026-09-04) — printed by the page and by the PDF from this one
 * list, so the two cannot differ by a line.
 *
 *   Statement beginning balance
 *   Cheques and payments cleared (n)      Σ matched on rows paying out, in the period
 *   Deposits and other credits cleared (n)
 *   Statement ending balance              printed — and if the three above do
 *                                         not reach it, the Difference line says by how much
 *   Uncleared transactions as of DATE     book entries no row claims, opening balance included
 *   Register balance as of DATE           the books, as everywhere else
 *
 * Each figure comes from its own definition. QuickBooks' identity "register =
 * ending + uncleared" holds here only when the difference is zero and nothing
 * straddles the date, so it is not asserted — the lines are printed, and the
 * three-term explanation is appended when the difference is not zero.
 */
export function reportSummary(view: ReconcileView): ReportLine[] {
  const payments = view.clearedRows.filter((r) => r.amount < 0n)
  const deposits = view.clearedRows.filter((r) => r.amount > 0n)
  const sum = (rows: ClearedRow[]) => rows.reduce((a, r) => a + r.amount, 0n)
  const uncleared = view.unclearedEntries.reduce((a, e) => a + e.amount, 0n)
  const lines: ReportLine[] = [
    { label: 'Statement beginning balance', amount: view.beginningBalance },
    { label: `Cheques and payments cleared (${payments.length})`, amount: sum(payments) },
    { label: `Deposits and other credits cleared (${deposits.length})`, amount: sum(deposits) },
  ]
  if (view.difference !== 0n) {
    lines.push({ label: 'Difference — not yet reconciled', amount: view.difference, rule: 'single' })
  }
  lines.push({ label: 'Statement ending balance', amount: view.endingBalance, rule: 'double' })
  lines.push({ label: `Uncleared transactions as of ${view.statementDate}`, amount: uncleared, gapBefore: true })
  lines.push({ label: `Register balance as of ${view.statementDate}`, amount: view.recon.books })
  return lines
}

export type ReportRow = { date: string; type: string; ref: string; payee: string; amount: bigint }
export type ReportSection = { title: string; rows: ReportRow[]; total: bigint }

/**
 * The Details and Additional Information sections: every cleared payment,
 * every cleared deposit, every uncleared book entry, and — this model's own
 * addition — every statement row the books have not met yet, because that is
 * what the person has to go and do. One list per section, each with its total.
 */
export function reportSections(view: ReconcileView): { details: ReportSection[]; additional: ReportSection[] } {
  const rowOf = (r: ClearedRow): ReportRow[] => r.entries.map((e) => ({
    date: r.txn_date, type: entryTypeLabel(e.source_type), ref: e.entry_no ?? '',
    payee: r.description || e.description, amount: e.amount,
  }))
  const payments = view.clearedRows.filter((r) => r.amount < 0n).flatMap(rowOf)
  const deposits = view.clearedRows.filter((r) => r.amount > 0n).flatMap(rowOf)
  const total = (rows: ReportRow[]) => rows.reduce((a, r) => a + r.amount, 0n)
  const entryRow = (e: UnclearedEntry): ReportRow => ({
    date: e.entry_date, type: entryTypeLabel(e.source_type), ref: e.entry_no ?? '',
    payee: e.description, amount: e.amount,
  })
  const unclearedOut = view.unclearedEntries.filter((e) => e.amount < 0n).map(entryRow)
  const unclearedIn = view.unclearedEntries.filter((e) => e.amount > 0n).map(entryRow)
  // The payee is the bank's own description and nothing else — the reason a
  // row was set aside is on the feed, not on paper (owner: 多余的字, 2026-09-04).
  const pending = view.pendingRows.map((r): ReportRow => ({
    date: r.txn_date, type: r.state === 'ignored' ? 'Set aside' : 'Statement row',
    ref: '', payee: r.description, amount: r.unmatched_amount,
  }))
  const details: ReportSection[] = [
    { title: `Cheques and payments cleared (${payments.length})`, rows: payments, total: total(payments) },
    { title: `Deposits and other credits cleared (${deposits.length})`, rows: deposits, total: total(deposits) },
  ]
  // Short titles, no notes: the reference report has none.
  const additional: ReportSection[] = []
  if (unclearedOut.length > 0) additional.push({
    title: `Uncleared payments (${unclearedOut.length})`, rows: unclearedOut, total: total(unclearedOut) })
  if (unclearedIn.length > 0) additional.push({
    title: `Uncleared deposits (${unclearedIn.length})`, rows: unclearedIn, total: total(unclearedIn) })
  if (pending.length > 0) additional.push({
    title: `Statement rows not in the books (${pending.length})`, rows: pending, total: total(pending) })
  return { details, additional }
}
