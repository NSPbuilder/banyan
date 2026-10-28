import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { reportPdf, type PdfBlock } from '@/lib/pdf'
import { reportXlsx } from '@/lib/excel'
import { filename } from '@/lib/csv'
import { nativeMoney } from '@/lib/fx-money'
import { reconcileView } from '@/lib/bank'
import { reconciliationParts, reconciliationTotals, reportSummary, reportSections, type ReportSection } from '@/lib/recon-display'
import type { ReportFormat } from '@/lib/pdf-reports'
const render=(format:ReportFormat,head:Parameters<typeof reportPdf>[0],blocks:PdfBlock[])=>format==='xlsx'?reportXlsx(head,blocks):reportPdf(head,blocks)
export async function nativeReconciliationExport(
  ledgerId: string, accountId: string, statementDate: string, format: ReportFormat = 'pdf',
): Promise<{filename:string;buffer:Buffer;format:ReportFormat} | null> {
  const [head] = await db.execute<{ entity: string; code: string; name: string }>(sql`
    SELECT e.name AS entity, a.code, a.name
      FROM ledger l JOIN entity e ON e.id = l.entity_id
      JOIN account a ON a.entity_id = e.id
     WHERE l.id = ${ledgerId}::uuid AND a.id = ${accountId}::uuid`)
  if (!head) return null
  const report = await reconcileView(accountId, statementDate)
  if (!report) return null

  const money = nativeMoney(report.currency)
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
        { label: 'Payee', weight: 3 }, { label: `Amount (${report.currency})`, align: 'right', weight: 1.3 },
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
      : `Not yet reconciled — the difference is ${money(report.difference)}.` },
    { kind: 'heading', text: 'Summary' },
    twoCol(reportSummary(report).map((l) => (
      { cells: [l.label, money(l.amount)] as [string, string], bold: l.rule === 'double', rule: !!l.rule }
    ))),
    // No prose beyond QuickBooks' own two lines — except the one warning
    // that changes what the person should do next (owner: 多余的字).
    ...(report.importGap !== 0n ? [{ kind: 'note' as const,
      text: `Import gap ${money(report.importGap)}: the rows on file do not reach the printed ending balance — a row is missing, doubled, or the balance was typed wrong.` }] : []),
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
      subtitle: [`${head.code} ${head.name}, Period Ending ${statementDate} · ${report.currency}`],
    }, blocks),
  }
}

