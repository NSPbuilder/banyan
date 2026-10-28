import 'server-only'
import { nativeInput } from './fx-money'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { csvFile, csvMoney, filename } from './csv'
import { spanLabel } from './date-range'
import { accountLedger, accountSummary, journalEntries } from './reports'
import { trialBalanceSpan } from './balances'
import { renderStatement } from './statements'
import { gstHstReturn, pstReturn } from './tax'
import { moduleDataExport } from './module-extensions'
import { breakdown } from './breakdown'
import { isEmptyRow } from './reporting-view'

/**
 * Exports carry the same figures the screen shows, because they come from the
 * same functions. An export that queries separately is a second implementation
 * of the same report, and the two will differ eventually — in a way nobody
 * notices, because nobody compares a spreadsheet with a web page line by line.
 */

async function ledgerHeader(ledgerId: string) {
  const [row] = await db.execute<{ entity: string; ledger: string; currency: string }>(sql`
    SELECT e.name AS entity, l.name AS ledger, l.currency
      FROM ledger l JOIN entity e ON e.id = l.entity_id WHERE l.id = ${ledgerId}::uuid`)
  return row
}

export async function trialBalanceCsv(
  ledgerId: string, periodId: string, fromPeriodId: string = periodId,
  /**
   * The same reading the screen was on. A report that hides its empty rows
   * and a download of it that does not are two answers to one question, and
   * the person would be right to trust neither (owner, 2026-09-07).
   */
  opts: { hideZeros?: boolean } = {},
) {
  const [head, [period], [fromPeriod], lines] = await Promise.all([
    ledgerHeader(ledgerId),
    db.execute<{ name: string; end_date: string }>(sql`
      SELECT name, end_date::text FROM fiscal_period WHERE id = ${periodId}::uuid`),
    db.execute<{ name: string }>(sql`
      SELECT name FROM fiscal_period WHERE id = ${fromPeriodId}::uuid`),
    trialBalanceSpan(ledgerId, fromPeriodId, periodId),
  ])
  const spanName = spanLabel(fromPeriod.name, period.name)

  const rows: Array<Array<string | number>> = [
    [head.entity, 'Trial balance', spanName, head.currency],
    [],
    ['Code', 'Account', 'Debit', 'Credit', 'Closing balance'],
  ]
  let debit = 0n, credit = 0n, closing = 0n
  for (const l of lines) {
    // The TOTALS are of everything, whatever is shown. A trial balance whose
    // columns do not add up to the same figures as the full one would be a
    // different report wearing its name.
    debit += BigInt(l.debit); credit += BigInt(l.credit); closing += BigInt(l.balance)
    if (opts.hideZeros && isEmptyRow(l)) continue
    rows.push([l.code, l.name, csvMoney(l.debit), csvMoney(l.credit), csvMoney(l.balance)])
  }
  // The total row is the reader's own check that nothing was lost in transit.
  rows.push([], ['', 'Total', csvMoney(debit), csvMoney(credit), csvMoney(closing)])
  return { csv: csvFile(rows), rows, period: spanName, entity: head.entity }
}

export async function accountLedgerCsv(
  ledgerId: string, accountId: string, range: { from?: string; to?: string } = {},
) {
  const [head, account, lines] = await Promise.all([
    ledgerHeader(ledgerId),
    accountSummary(accountId),
    accountLedger(accountId, ledgerId, range),
  ])

  const rows: Array<Array<string | number>> = [
    [head.entity, 'Account history', `${account.code} ${account.name}`, head.currency],
    [],
    ['Date', 'Entry', 'Period', 'Description', 'Party', 'Against', 'Debit', 'Credit', 'Balance'],
  ]
  for (const l of lines) {
    rows.push([
      l.entry_date, l.entry_no, l.period_name,
      l.line_description || l.description,
      l.party_name ?? '',
      l.contra_codes.join(' '),
      l.debit === '0' ? '' : csvMoney(l.debit),
      l.credit === '0' ? '' : csvMoney(l.credit),
      csvMoney(l.running),
    ])
  }
  return { csv: csvFile(rows), rows, account: `${account.code}-${account.name}`, entity: head.entity }
}

export async function journalCsv(ledgerId: string) {
  const [head, posted] = await Promise.all([
    ledgerHeader(ledgerId),
    journalEntries(ledgerId, { status: 'posted', limit: 10_000 }),
  ])

  const rows: Array<Array<string | number>> = [
    [head.entity, 'Journal', head.currency],
    [],
    ['Date', 'Entry', 'Description', 'Status', 'Account', 'Debit', 'Credit', 'Original currency', 'Original amount', 'Saved exchange evidence'],
  ]
  // One row per LINE, not per entry: a journal export is for re-checking the
  // arithmetic, and a row that only carries a total cannot be re-checked.
  for (const e of posted) {
    e.accounts.forEach((code, i) => {
      rows.push([
        i === 0 ? e.entry_date : '', i === 0 ? (e.entry_no ?? '') : '',
        i === 0 ? e.description : '', i === 0 ? e.status : '',
        code,
        e.debits[i] !== '0' ? csvMoney(e.debits[i]) : '',
        e.credits[i] !== '0' ? csvMoney(e.credits[i]) : '',
        e.original_currencies[i],
        e.original_currencies[i] ? nativeInput(BigInt(e.original_amounts[i]),e.original_currencies[i]) : '',
        e.fx_snapshots[i],
      ])
    })
  }
  return { csv: csvFile(rows), rows, entity: head.entity }
}

export async function gstHstCsv(ledgerId: string, from: string, to: string) {
  return taxCsv(ledgerId, from, to, 'GST_HST')
}

/** Either return, as a spreadsheet: the boxes, then every figure's entries. */
export async function taxCsv(ledgerId: string, from: string, to: string, tax: 'GST_HST' | 'PST') {
  const gst = tax === 'PST' ? await pstReturn(ledgerId, from, to) : await gstHstReturn(ledgerId, from, to)
  if (!gst) return null
  const label = tax === 'PST' ? 'PST return' : 'GST/HST return'

  const rows: Array<Array<string | number>> = [
    [gst.entity, label, `${from} to ${to}`, gst.businessNumber ?? '', gst.currency],
  ]

  // What needs checking travels with the figures. A spreadsheet that drops the
  // warning is a return someone files without it.
  if (gst.review.length > 0) {
    rows.push([], ['CHECK BEFORE FILING'])
    for (const r of gst.review) rows.push(['', r.what, r.detail])
  }

  rows.push([], ['Line', 'Description', 'Amount'])
  for (const l of Object.values(gst.lines)) {
    rows.push([l.line, l.label, csvMoney(l.amount)])
    if (l.bookAmount !== undefined) rows.push(['', 'From books', csvMoney(l.bookAmount)],
      ['', 'Manual adjustment', csvMoney(l.adjustment ?? 0n), l.adjustmentReason ?? '105 minus 108'])
  }

  // Every figure with the entries behind it, so the file can be checked at a
  // desk without going back to the screen.
  for (const l of Object.values(gst.lines).filter((x) => x !== gst.lines.net)) {
    if (l.entries.length === 0) continue
    rows.push([], [`Line ${l.line} — ${l.label}`])
    rows.push(['', 'Date', 'Entry', 'Description', 'Account', 'Amount'])
    for (const e of l.entries) {
      // The contribution, signed, so the column adds up to the total below it.
      rows.push(['', e.entryDate, e.entryNo, e.description,
                 `${e.accountCode} ${e.accountName}`, csvMoney(e.contribution)])
    }
    if (l.adjustment !== undefined) rows.push(['', '', '', `Manual adjustment — ${l.adjustmentReason}`, '', csvMoney(l.adjustment)])
    rows.push(['', '', '', '', 'Total', csvMoney(l.amount)])
  }

  return { csv: csvFile(rows), rows, entity: gst.entity, from, to }
}

export async function statementCsv(
  ledgerId: string, templateCode: string, periodId: string, fromPeriodId: string = periodId,
) {
  const statement = await renderStatement(ledgerId, templateCode, periodId, fromPeriodId)
  if (!statement) return null
  const [head, [fromPeriod]] = await Promise.all([
    ledgerHeader(ledgerId),
    db.execute<{ name: string }>(sql`
      SELECT name FROM fiscal_period WHERE id = ${fromPeriodId}::uuid`),
  ])
  const spanName = spanLabel(fromPeriod.name, statement.period.name)

  const rows: Array<Array<string | number>> = [
    [head.entity, statement.template.name,
     statement.template.statementType === 'balance_sheet'
       ? `As at ${statement.period.endDate}` : `For ${spanName}`,
     statement.template.standard, head.currency],
  ]
  // Anything wrong with the statement travels with it. A spreadsheet that drops
  // the warning is a statement someone will act on without it.
  if (statement.problems.length > 0) {
    rows.push([], ['INCOMPLETE — see below'])
    for (const p of statement.problems) rows.push(['', p])
  }
  rows.push([], ['', 'Line', 'Amount', 'Accounts'])

  for (const l of statement.lines) {
    if (l.lineType === 'spacer') { rows.push([]); continue }
    if (l.lineType === 'header') { rows.push(['', '  '.repeat(l.indent) + l.label]); continue }
    if (l.lineType === 'detail' && l.raw === 0n) continue
    rows.push(['', '  '.repeat(l.indent) + l.label, csvMoney(l.shown),
               l.accounts?.map((a) => a.code).join(' ') ?? ''])
  }
  return {
    csv: csvFile(rows), rows, entity: head.entity,
    name: statement.template.name, period: spanName,
  }
}

export async function breakdownCsv(
  ledgerId: string, params: Record<string, string | undefined>,
) {
  const b = await breakdown(ledgerId, params)
  if (!b) return null

  const rows: Array<Array<string | number>> = [
    [b.entity, b.title, b.subtitle],
    ...(b.note ? [[], ['', b.note]] as Array<Array<string>> : []),
    [],
    b.columns.map((c) => c.label),
  ]
  for (const r of b.rows) {
    rows.push(r.cells.map((c) => ('money' in c ? csvMoney(c.money) : c.text)))
  }
  return { csv: csvFile(rows), rows, name: filename(b.slug.length ? [b.entity, ...b.slug] : [b.entity]) }
}

/** The PD7A worksheet — one row per month of paydays, the way the page shows it. */
/** Installed providers own specialized exports; absent providers have no export. */
export async function pd7aCsv(ledgerId: string, year: number) {
  return moduleDataExport('pd7a', ledgerId, { year: String(year) })
}
