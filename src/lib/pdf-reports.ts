import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { reportPdf, type PdfBlock } from './pdf'
import { renderCashFlow, type CashFlow } from './cash-flow'
import { renderEquityChanges, type EquityChanges } from './equity-changes'
import { DERIVED_STATEMENTS, isDerived, type DerivedCode } from './derived-statements'
import { reportXlsx } from './excel'
import { formatMoney } from './money'
import { accountReference } from './account-reference'
import { filename } from './csv'
import { spanLabel } from './date-range'
import { renderComparative, type CompareMode } from './compare'
import { renderColumned, type Grouping } from './columns'
import { resolvePeriodSpan, trialBalanceSpan } from './balances'
import { generalLedger } from './reports'
import { aging, BUCKETS } from './aging'
import { gstHstReturn, pstReturn, type TaxLineEntry } from './tax'
import { breakdown } from './breakdown'
import { reconcileView } from './bank'
import { reconciliationParts, reconciliationTotals, reportSummary, reportSections, type ReportSection } from './recon-display'
import { renderCustomerStatement, renderInvoiceDocument } from './customer-docs'
import type { InvoiceDocument } from './customer-docs'
import { renderInvoicePdf } from './invoice-pdf'
import { isEmptyRow } from './reporting-view'
import { ledgerHead } from './ledger-head'

/**
 * Every report's PDF, one function per report, all through `reportPdf`.
 *
 * The rule these functions live under: each one calls THE SAME derivation
 * function its screen calls, and lays out what came back. No query happens
 * here that does not happen on the page; a figure in the PDF that the screen
 * cannot show would be a second derivation wearing a file extension.
 *
 * Money: `formatMoney` throughout, blank for a zero debit/credit cell the way
 * the screens leave them blank, `(1,234.56)` never — the books show minus.
 */

type Pdf = { filename: string; buffer: Buffer; format?: ReportFormat }

/**
 * Which paper. Every report builder below takes it last and defaults to PDF;
 * the same blocks go to `reportPdf` or to `reportXlsx` (excel.ts), so the
 * spreadsheet the owner asked for (2026-09-04) is the PDF's figures in cells,
 * not a second reading of the books.
 */
export type ReportFormat = 'pdf' | 'xlsx'
const render = (format: ReportFormat, head: Parameters<typeof reportPdf>[0], blocks: PdfBlock[]) =>
  format === 'xlsx' ? reportXlsx(head, blocks) : reportPdf(head, blocks)

const money = (v: bigint) => formatMoney(v)
const moneyOrBlank = (v: bigint) => (v === 0n ? '' : formatMoney(v))

const entityName = async (ledgerId: string): Promise<string> =>
  (await ledgerHead(ledgerId))?.entity ?? 'Unknown company'

type Span = {
  fromPeriodId: string; toPeriodId: string
  fromDate: string; toDate: string; label: string
}

/**
 * The account numbers beside a statement line, for the printed page.
 *
 * Capped tighter than on screen: a PDF's label column is a fixed fraction of a
 * letter page, and a reference that wraps onto a second line reads as a second
 * statement line. The screen and the page use the SAME function so they cannot
 * come to different codes (src/lib/account-reference.ts).
 */
const reference = (accounts: Array<{ code: string }> | undefined) => {
  const codes = accountReference(accounts, 4)
  return codes ? `   ${codes}` : ''
}

// ------------------------------------------------------------- statements --

export async function statementPdf(
  ledgerId: string, templateCode: string, span: Span, compare: CompareMode | null = null,
  format: ReportFormat = 'pdf', by: Grouping | null = null,
): Promise<Pdf | null> {
  // The two statements that are not templates take the same door.
  if (isDerived(templateCode)) return derivedStatementPdf(ledgerId, templateCode, span, format)
  const resolved = await resolvePeriodSpan(ledgerId, span.fromDate, span.toDate)
  if (!resolved) return null
  // ONE OR THE OTHER, the way the screen offers them: a comparison and a
  // breakdown both put columns beside the figure, and the export must not show
  // a combination the page cannot.
  const [company, comparative, columned] = await Promise.all([
    entityName(ledgerId),
    by ? Promise.resolve(null) : renderComparative(ledgerId, templateCode, resolved, compare),
    by ? renderColumned(ledgerId, templateCode, resolved, by) : Promise.resolve(null),
  ])
  const statement = comparative?.current ?? columned?.whole
  if (!statement) return null
  const withCompare = comparative?.compare != null
  const compareName = comparative?.compareSpan
    ? spanLabel(comparative.compareSpan.fromPeriod.name, comparative.compareSpan.toPeriod.name) : ''

  // The same rows the page shows, flattened the same way: a label and then
  // however many figures this view has. The comparison is asked first, and
  // it is null precisely when a breakdown was asked for — the choice above is
  // the only place the two are told apart.
  // A breakdown that came back flat (one fiscal month, a column that would
  // not render) is the plain single column, with its reason as a note below —
  // not a lone Total heading over the same figure.
  const heads: string[] = comparative
    ? withCompare ? [span.label, compareName, 'Change'] : ['']
    : columned && columned.columns.length > 0
      ? [...columned.columns.map((c) => c.label), columned.totalLabel] : ['']
  const rows = comparative
    ? comparative.lines.map((l) => ({
        ...l,
        cells: (withCompare ? [l.current, l.compare ?? 0n, l.change] : [l.current]) as Array<bigint | null>,
      }))
    : (columned?.lines ?? []).map((l) => ({ ...l, cells: [...l.amounts, l.total] as Array<bigint | null> }))
  // TURNED WHEN IT HAS TO BE. Thirteen money columns on an upright letter page
  // give each about thirty points, which is not a figure anybody can read; five
  // are comfortable. So the sheet turns rather than the numbers shrinking
  // silently (owner, 2026-09-12).
  const landscape = heads.length > 5

  const blocks: PdfBlock[] = [{
    kind: 'table',
    columns: [
      { label: '', weight: heads.length > 1 ? 3 : 4 },
      ...heads.map((h) => ({ label: h, align: 'right' as const, weight: 1.1 })),
    ],
    rows: rows
      .filter((l) => l.lineType !== 'spacer')
      .map((l) => ({
        cells: l.lineType === 'header'
          ? [l.label, ...heads.map(() => '')]
          : [l.label + reference(l.accounts), ...l.cells.map((c) => (c === null ? '' : money(c)))],
        indent: l.indent,
        bold: l.lineType === 'header' || l.lineType === 'total',
        rule: l.lineType === 'total',
      })),
  }]
  if (compare && comparative?.reason) blocks.push({ kind: 'note', text: comparative.reason })
  if (by && columned?.reason) blocks.push({ kind: 'note', text: columned.reason })
  if (columned && columned.columns.length > 0 && !columned.totalIsSum) {
    blocks.push({ kind: 'note', text: 'Each column is the balance at that date, so they are not '
      + `added — ${columned.totalLabel.toLowerCase()} is the position at the end of the span.` })
  }
  for (const p of statement.problems) blocks.push({ kind: 'note', text: p })

  return {
    format,
    filename: filename([company, statement.template.code, span.fromDate, span.toDate], format),
    buffer: await render(format, {
      company,
      title: statement.template.name,
      subtitle: [span.label],
      landscape,
    }, blocks),
  }
}

// ------------------------------------------------------ derived statements --

/**
 * The two statements that are not templates (src/lib/derived-statements.ts),
 * on the same PdfBlock pipeline as everything else: the same blocks draw the
 * PDF and fill the workbook, so the spreadsheet is the PDF's figures in
 * cells and never a second reading of the books.
 */
export function cashFlowBlocks(cf: CashFlow): PdfBlock[] {
  const blocks: PdfBlock[] = [{
    kind: 'table',
    columns: [{ label: '', weight: 4 }, { label: '', align: 'right', weight: 1 }],
    rows: cf.lines
      .filter((l) => l.lineType !== 'spacer')
      .map((l) => ({
        cells: l.lineType === 'header'
          ? [l.label, '']
          : [l.label + reference(l.accounts), money(l.raw)],
        indent: l.indent,
        bold: l.lineType === 'header' || l.lineType === 'total',
        rule: l.lineType === 'total',
      })),
  }]
  for (const p of cf.problems) blocks.push({ kind: 'note', text: p })
  return blocks
}

export function equityChangesBlocks(eq: EquityChanges): PdfBlock[] {
  const blocks: PdfBlock[] = [{
    kind: 'table',
    columns: [
      { label: '', weight: 2.6 },
      ...eq.columns.map((c) => ({ label: c.label, align: 'right' as const, weight: 1.2 })),
      { label: 'Total', align: 'right', weight: 1.2 },
    ],
    rows: eq.rows.map((r) => ({
      // The Total column's accounts are every column's put together, which is
      // the reference for the row as a whole (equity-changes.ts).
      cells: [r.label + reference(r.accounts[r.accounts.length - 1]), ...r.shown.map(money)],
      bold: r.lineType !== 'movement',
      rule: r.lineType === 'closing',
    })),
  }]
  for (const p of eq.problems) blocks.push({ kind: 'note', text: p })
  return blocks
}

export async function derivedStatementPdf(
  ledgerId: string, code: DerivedCode, span: Span, format: ReportFormat = 'pdf',
): Promise<Pdf | null> {
  const resolved = await resolvePeriodSpan(ledgerId, span.fromDate, span.toDate)
  if (!resolved) return null
  const company = await entityName(ledgerId)
  const named = DERIVED_STATEMENTS.find((d) => d.code === code)!
  const blocks = code === 'CASH_FLOW'
    ? await renderCashFlow(ledgerId, resolved.toPeriod.id, resolved.fromPeriod.id).then((cf) => cf && cashFlowBlocks(cf))
    : await renderEquityChanges(ledgerId, resolved.toPeriod.id, resolved.fromPeriod.id).then((eq) => eq && equityChangesBlocks(eq))
  if (!blocks) return null
  return {
    format,
    filename: filename([company, code.toLowerCase().replace('_', '-'), span.fromDate, span.toDate], format),
    buffer: await render(format, { company, title: named.name, subtitle: [span.label] }, blocks),
  }
}

// ---------------------------------------------------------- trial balance --

export async function trialBalancePdf(
  ledgerId: string, span: Span, format: ReportFormat = 'pdf',
  /** The same reading the screen was on — see `trialBalanceCsv`. */
  opts: { hideZeros?: boolean } = {},
): Promise<Pdf> {
  const [company, rows] = await Promise.all([
    entityName(ledgerId),
    trialBalanceSpan(ledgerId, span.fromPeriodId, span.toPeriodId),
  ])
  const totals = rows.reduce(
    (t, r) => ({
      debit: t.debit + BigInt(r.debit),
      credit: t.credit + BigInt(r.credit),
      closing: t.closing + BigInt(r.balance),
    }),
    { debit: 0n, credit: 0n, closing: 0n })

  return {
    format,
    filename: filename([company, 'trial-balance', span.fromDate, span.toDate], format),
    buffer: await render(format, {
      company, title: 'Trial balance',
      subtitle: opts.hideZeros ? [span.label, 'accounts with a figure only'] : [span.label],
    }, [{
      kind: 'table',
      columns: [
        { label: 'Code', weight: 1 }, { label: 'Account', weight: 4 },
        { label: 'Debits', align: 'right', weight: 1.6 },
        { label: 'Credits', align: 'right', weight: 1.6 },
        { label: 'Closing', align: 'right', weight: 1.6 },
      ],
      rows: [
        // Totals above are of EVERYTHING; only the listing is shortened.
        ...rows.filter((r) => !(opts.hideZeros && isEmptyRow(r))).map((r) => ({
          cells: [r.code, r.name, moneyOrBlank(BigInt(r.debit)),
                  moneyOrBlank(BigInt(r.credit)), money(BigInt(r.balance))],
        })),
        { cells: ['', 'Total', money(totals.debit), money(totals.credit), money(totals.closing)],
          bold: true, rule: true },
      ],
    }]),
  }
}

// --------------------------------------------------------- general ledger --

export async function generalLedgerPdf(ledgerId: string, span: Span, format: ReportFormat = 'pdf'): Promise<Pdf> {
  const [company, accounts] = await Promise.all([
    entityName(ledgerId),
    generalLedger(ledgerId, span),
  ])

  const blocks: PdfBlock[] = []
  for (const a of accounts) {
    blocks.push({ kind: 'heading', text: `${a.account.code} — ${a.account.name}` })
    blocks.push({
      kind: 'table',
      columns: [
        { label: 'Date', weight: 1.1 }, { label: 'No', weight: 1.1 },
        { label: 'Description', weight: 3.2 }, { label: 'Against', weight: 1.2 },
        { label: 'Debit', align: 'right', weight: 1.4 },
        { label: 'Credit', align: 'right', weight: 1.4 },
        { label: 'Balance', align: 'right', weight: 1.5 },
      ],
      rows: [
        { cells: ['', '', 'Opening balance', '', '', '', money(a.opening)], bold: true },
        ...a.rows.map((r) => ({
          cells: [r.entry_date, r.entry_no, r.line_description || r.description,
                  r.contra_codes.join(' '),
                  moneyOrBlank(BigInt(r.debit)), moneyOrBlank(BigInt(r.credit)),
                  money(BigInt(r.running))],
        })),
        { cells: ['', '', 'Closing balance', '',
                  moneyOrBlank(a.debit), moneyOrBlank(a.credit), money(a.closing)],
          bold: true, rule: true },
      ],
    })
  }
  if (accounts.length === 0) {
    blocks.push({ kind: 'note', text: 'Nothing moved and nothing stood at a balance in this span.' })
  }

  return {
    format,
    filename: filename([company, 'general-ledger', span.fromDate, span.toDate], format),
    buffer: await render(format, {
      company, title: 'General ledger', subtitle: [span.label],
    }, blocks),
  }
}

// ------------------------------------------------------------------ aging --

export async function agingPdf(ledgerId: string, asOf: string, format: ReportFormat = 'pdf'): Promise<Pdf> {
  const [company, receivables, payables] = await Promise.all([
    entityName(ledgerId),
    aging(ledgerId, 'trade_receivables', asOf),
    aging(ledgerId, 'trade_payables', asOf),
  ])

  const section = (title: string, who: string, a: Awaited<ReturnType<typeof aging>>): PdfBlock[] => {
    const blocks: PdfBlock[] = [
      { kind: 'heading', text: title },
      {
        kind: 'table',
        columns: [
          { label: who, weight: 3 },
          ...BUCKETS.map((b) => ({ label: b.label, align: 'right' as const, weight: 1.2 })),
          { label: 'Total', align: 'right', weight: 1.4 },
        ],
        rows: [
          ...a.rows.map((r) => ({
            cells: [r.party_name, ...r.buckets.map(moneyOrBlank), money(r.total)],
          })),
          { cells: ['Total', ...a.totals.map(money),
                    money(a.totals.reduce((x, y) => x + y, 0n))],
            bold: true, rule: true },
        ],
      },
    ]
    if (a.unattributed !== 0n) {
      blocks.push({ kind: 'note', text:
        `${formatMoney(a.unattributed)} sits on the control accounts with no party named — it is owed, and invisible to the rows above.` })
    }
    return blocks
  }

  return {
    format,
    filename: filename([company, 'aging', asOf], format),
    buffer: await render(format, {
      company, title: 'Aging — receivables & payables', subtitle: [`As at ${asOf}, by open item`],
    }, [
      ...section('Receivables — who owes us', 'Customer', receivables),
      ...section('Payables — whom we owe', 'Supplier', payables),
    ]),
  }
}

// ------------------------------------------------------------ GST return --

export async function taxReturnPdf(
  ledgerId: string, from: string, to: string, tax: 'GST_HST' | 'PST' = 'GST_HST', late = false,
  format: ReportFormat = 'pdf',
): Promise<Pdf | null> {
  const company = await entityName(ledgerId)
  const ret = tax === 'PST' ? await pstReturn(ledgerId, from, to, { late }) : await gstHstReturn(ledgerId, from, to)
  if (!ret) return null
  const label = tax === 'PST' ? 'PST' : 'GST/HST'

  const subtitle = [
    `${from} to ${to}`,
    ret.registration
      ? `${label} ${ret.registration.number}`
      : 'Not registered for any part of this range — there is no return to file.',
  ]
  if (ret.coverage === 'part') {
    subtitle.push('Registered for only part of this range; the figures cover the registered part.')
  }

  // The boxes in the order the form has them; the last is the net line.
  const lines = Object.values(ret.lines)
  const blocks: PdfBlock[] = [{
    kind: 'table',
    columns: [
      { label: 'Line', weight: 0.8 }, { label: '', weight: 4 },
      { label: 'Amount', align: 'right', weight: 1.6 },
    ],
    rows: lines.map((l) => ({
      cells: [l.line, l.label, money(l.amount)],
      bold: l === ret.lines.net,
      rule: l === ret.lines.net,
    })),
  }]
  for (const line of lines) if (line.bookAmount !== undefined) blocks.push({kind:'note',text:
    `Line ${line.line}: books ${money(line.bookAmount)}, adjustment ${money(line.adjustment ?? 0n)}, return ${money(line.amount)}.`})
  // Every entry behind every figure, and the entries a review item names.
  // The CSV this paper replaced carried them, and a workbook thinner than
  // the CSV was not the ask (critic, 2026-09-04): the return has to be
  // defensible line by line at a desk, away from the screen.
  const entries = (list: TaxLineEntry[], total?: bigint): PdfBlock => ({
    kind: 'table',
    columns: [
      { label: 'Date', weight: 1 }, { label: 'Entry', weight: 0.9 },
      { label: 'Description', weight: 3 }, { label: 'Account', weight: 2.2 },
      { label: 'Amount', align: 'right', weight: 1.3 },
    ],
    rows: [
      ...list.map((e) => ({
        cells: [e.entryDate, e.entryNo, e.description, `${e.accountCode} ${e.accountName}`,
                money(e.contribution)],
      })),
      ...(total === undefined ? [] : [{ cells: ['', '', '', 'Total', money(total)], bold: true, rule: true }]),
    ],
  })
  for (const r of ret.review) {
    blocks.push({ kind: 'note', text: `Review: ${r.what} — ${r.detail}` })
    if (r.entries && r.entries.length > 0) blocks.push(entries(r.entries))
  }
  for (const l of lines.filter((x) => x !== ret.lines.net && x.entries.length > 0)) {
    blocks.push({ kind: 'heading', text: `Line ${l.line} — ${l.label}` })
    blocks.push(entries(l.entries, l.bookAmount ?? l.amount))
    if (l.adjustment !== undefined) blocks.push({ kind: 'note', text:
      `Manual adjustment ${money(l.adjustment)}; return amount ${money(l.amount)}. ${l.adjustmentReason}` })
  }

  return {
    format,
    filename: filename([company, tax === 'PST' ? 'pst-return' : 'gst-return', from, to], format),
    buffer: await render(format, { company, title: `${label} return figures`, subtitle }, blocks),
  }
}

// ------------------------------------------- bank reconciliation report --

export async function reconciliationPdf(
  ledgerId: string, accountId: string, statementDate: string, format: ReportFormat = 'pdf',
): Promise<Pdf | null> {
  const [head] = await db.execute<{ entity: string; code: string; name: string }>(sql`
    SELECT e.name AS entity, a.code, a.name
      FROM ledger l JOIN entity e ON e.id = l.entity_id
      JOIN account a ON a.entity_id = e.id
     WHERE l.id = ${ledgerId}::uuid AND a.id = ${accountId}::uuid`)
  if (!head) return null
  const report = await reconcileView(accountId, statementDate)
  if (!report) return null

  const twoCol = (rows: Array<{ cells: [string, string]; bold?: boolean; rule?: boolean }>): PdfBlock => ({
    kind: 'table',
    columns: [{ label: '', weight: 4 }, { label: '', align: 'right', weight: 1.4 }],
    rows,
  })
  // One section of the report: the five QuickBooks columns and a Total line.
  const section = (sec: ReportSection): PdfBlock[] => [
    { kind: 'note', text: sec.title },
    {
      kind: 'table',
      columns: [
        { label: 'Date', weight: 1.1 }, { label: 'Type', weight: 1.1 }, { label: 'Ref no.', weight: 0.9 },
        { label: 'Payee', weight: 3 }, { label: 'Amount (CAD)', align: 'right', weight: 1.3 },
      ],
      rows: [
        ...sec.rows.map((r) => ({ cells: [r.date, r.type, r.ref, r.payee, money(r.amount)] })),
        { cells: ['Total', '', '', '', money(sec.total)], bold: true, rule: true },
      ],
    },
  ]
  const { details, additional } = reportSections(report)

  // The same Summary, Details and Additional Information the print page
  // shows, from the same two functions — paper and screen cannot differ by a
  // line. The three-term explanation is appended only when there is a
  // difference to explain.
  const blocks: PdfBlock[] = [
    { kind: 'note', text: report.finished
      ? `Reconciled on: ${report.finished.at.slice(0, 10)} · Reconciled by: ${report.finished.by}`
      : `Not yet reconciled — the difference is ${formatMoney(report.difference)}.` },
    { kind: 'heading', text: 'Summary' },
    twoCol(reportSummary(report).map((l) => (
      { cells: [l.label, money(l.amount)] as [string, string], bold: l.rule === 'double', rule: !!l.rule }
    ))),
    // No prose beyond QuickBooks' own two lines — except the one warning
    // that changes what the person should do next (owner: 多余的字).
    ...(report.importGap !== 0n ? [{ kind: 'note' as const,
      text: `Import gap ${formatMoney(report.importGap)}: the rows on file do not reach the printed ending balance — a row is missing, doubled, or the balance was typed wrong.` }] : []),
    { kind: 'heading', text: 'Details' },
    ...details.flatMap(section),
  ]
  if (additional.length > 0) {
    blocks.push({ kind: 'heading', text: 'Additional Information' })
    blocks.push(...additional.flatMap(section))
  }
  if (report.difference !== 0n) {
    blocks.push({ kind: 'heading', text: 'Why the difference is what it is' })
    blocks.push(twoCol(reconciliationTotals(report.recon).map(([label, amount]) => (
      { cells: [label, money(amount)] as [string, string], bold: label === 'Difference', rule: label === 'Difference' }
    ))))
    blocks.push({ kind: 'note', text: 'Made up of:' })
    blocks.push(twoCol(reconciliationParts(report.recon).map(([label, amount, why]) => (
      { cells: [`${label} — ${why}`, money(amount)] as [string, string] }
    ))))
  }

  return {
    format,
    filename: filename([head.entity, 'bank-reconciliation', head.code, statementDate], format),
    buffer: await render(format, {
      company: head.entity,
      title: 'Reconciliation report',
      subtitle: [`${head.code} ${head.name}, Period Ending ${statementDate}`],
    }, blocks),
  }
}

// -------------------------------------------------------- customer papers --

export async function invoicePdf(invoiceId: string): Promise<Pdf> {
  const doc = await renderInvoiceDocument(invoiceId)
  return invoicePaperPdf(doc)
}

/** Actual invoices and template samples use one PDF rendering path. */
export async function invoicePaperPdf(doc: InvoiceDocument): Promise<Pdf> {
  return {
    filename: filename([doc.company.name, doc.title,
      doc.receipt ? doc.receipt.invoiceNumber ?? undefined : doc.number ?? 'unnumbered', doc.receipt?.paidOn], 'pdf'),
    buffer: await renderInvoicePdf(doc),
  }
}

export async function customerStatementPdf(
  ledgerId: string, partyId: string, asOf: string, format: ReportFormat = 'pdf',
): Promise<Pdf> {
  const st = await renderCustomerStatement(ledgerId, partyId, asOf)

  const blocks: PdfBlock[] = [
    { kind: 'note', text: [st.company.name, ...st.company.addressLines, ...st.company.taxNumbers].join('\n') },
    { kind: 'heading', text: 'To' },
    { kind: 'note', text: [st.party.name, ...st.party.addressLines].join('\n') },
    { kind: 'gap' },
    {
      kind: 'table',
      columns: [
        { label: 'Number', weight: 1.2 }, { label: 'What', weight: 1.4 },
        { label: 'Issued', weight: 1.1 }, { label: 'Due', weight: 1.1 },
        { label: 'Original', align: 'right', weight: 1.4 },
        { label: 'Applied', align: 'right', weight: 1.4 },
        { label: 'Open', align: 'right', weight: 1.4 },
      ],
      rows: [
        ...st.items.map((i) => ({
          cells: [i.number ?? '—', i.kind, i.issuedOn, i.dueOn,
                  money(i.original), moneyOrBlank(i.applied), money(i.balance)],
        })),
        { cells: ['', '', '', '', '', 'Total owed', money(st.totalOwed)], bold: true, rule: true },
      ],
    },
  ]
  if (st.agingLine) {
    blocks.push({ kind: 'heading', text: 'How long it has been owed' })
    blocks.push({
      kind: 'table',
      columns: st.agingLine.labels.map((l) => ({ label: l, align: 'right' as const, weight: 1 })),
      rows: [{ cells: st.agingLine.amounts.map(money) }],
    })
  }

  return {
    format,
    filename: filename([st.company.name, 'statement', st.party.name, asOf], format),
    buffer: await render(format, {
      company: st.company.name,
      title: 'Statement of account',
      subtitle: [`As at ${st.asOf}`],
    }, blocks),
  }
}
// ------------------------------------------------------- statutory registers --

// ------------------------------------------------------------- the exits --

/** Period-snapped span for the ranged reports, shaped for the builders. */
export async function spanFor(ledgerId: string, from: string, to: string): Promise<Span | null> {
  const span = await resolvePeriodSpan(ledgerId, from, to)
  if (!span) return null
  return {
    fromPeriodId: span.fromPeriod.id,
    toPeriodId: span.toPeriod.id,
    fromDate: span.fromPeriod.start_date,
    toDate: span.toPeriod.end_date,
    label: spanLabel(span.fromPeriod.name, span.toPeriod.name),
  }
}

/**
 * The one way a paper leaves. A PDF goes INLINE — it opens in the tab the
 * link targets, named for saving; a workbook is an attachment, because a
 * browser has nothing to open it with. The Excel node briefly sent both as
 * attachments and every "Download PDF" opened a blank tab and dropped a file —
 * eleven routes, invoices and customer statements included (critic).
 */
/** Which of a report's two files was asked for. */
export const formatOf = (q: URLSearchParams): ReportFormat => (q.get('format') === 'xlsx' ? 'xlsx' : 'pdf')

/** The span a ranged report was asked for, or the response saying what was missing. */
export async function spanFromQuery(ledgerId: string, q: URLSearchParams): Promise<Span | Response> {
  const from = q.get('from')
  const to = q.get('to')
  if (!from || !to) return new Response('from and to are needed', { status: 400 })
  const span = await spanFor(ledgerId, from, to)
  return span ?? new Response('No periods cover that range.', { status: 404 })
}

/** What a stored file may be shown AS: a document or a picture, nothing that runs. */
const SHOWABLE = /^(application\/pdf|image\/(png|jpe?g|webp|gif))$/

/**
 * A stored file shown in the browser under its own name, never cached — and
 * never as anything but a document or a picture. The type stored is the one
 * the uploader's browser sent, and the door admits a file on its extension
 * OR its type; so `receipt.pdf` sent as `text/html` was stored as HTML and
 * would have been served as HTML on this origin, as the signed-in person
 * (audit, 2026-09-13). Anything off the list goes out as bytes, and
 * `nosniff` stops the browser guessing its way back.
 */
export function fileResponse(file: { bytes: Uint8Array | Buffer; mime: string; filename: string }): Response {
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'Content-Type': SHOWABLE.test(file.mime) ? file.mime : 'application/octet-stream',
      'Content-Disposition': `inline; filename="${file.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export function pdfResponse(pdf: Pdf): Response {
  const xlsx = pdf.format === 'xlsx'
  const disposition = xlsx ? 'attachment' : 'inline'
  return new Response(new Uint8Array(pdf.buffer), {
    headers: {
      'Content-Type': xlsx
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${pdf.filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

// ------------------------------------------------------------- breakdown --

/**
 * A breakdown as its own paper. The rows are whatever `breakdown()` derived —
 * this function draws them and adds nothing, so the PDF cannot say more or
 * less than the overlay the person was just looking at.
 */
export async function breakdownPdf(
  ledgerId: string, params: Record<string, string | undefined>, format: ReportFormat = 'pdf',
): Promise<Pdf | null> {
  const b = await breakdown(ledgerId, params)
  if (!b) return null

  const blocks: PdfBlock[] = []
  if (b.note) blocks.push({ kind: 'note', text: b.note })
  blocks.push({
    kind: 'table',
    columns: b.columns.map((c) => ({ label: c.label, align: c.align, weight: c.weight })),
    rows: b.rows.map((r) => ({
      cells: r.cells.map((c) => ('money' in c ? money(c.money) : c.text)),
      bold: r.bold, rule: r.rule,
    })),
  })

  return {
    format,
    filename: filename([b.entity, ...b.slug], format),
    buffer: await render(format, { company: b.entity, title: b.title, subtitle: [b.subtitle] }, blocks),
  }
}
