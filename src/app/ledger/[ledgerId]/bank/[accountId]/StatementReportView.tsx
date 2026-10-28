'use client'

import { nativeMoney } from '@/lib/fx-money'
import type { ReconcileView } from '@/lib/bank'
import { reportSections, reportSummary, type ReportSection } from '@/lib/recon-display'
import { Summary } from './Summary'

/**
 * The reconciliation report, in the shape the owner handed over (QuickBooks',
 * 2026-09-04): a centred header, a Summary with leaders, Details tables with a
 * Total line, Additional Information. Shared verbatim by the print page — and
 * the PDF prints the same lists from the same two functions in
 * `recon-display.ts`, so paper and screen cannot disagree by a line.
 *
 * It computes nothing. `reconcileView()` decided every figure; `reportSummary`
 * and `reportSections` decided what to print and in what order; this lays it
 * out. The three-term explanation of the difference (07 §4) is appended only
 * when there is a difference to explain.
 */
export function StatementReportView({ report, company, account }: {
  report: ReconcileView
  company: string
  account: string
}) {
  const currency=report.currency??report.recon.currency??'CAD',formatMoney=nativeMoney(currency)
  const summary = reportSummary(report)
  const { details, additional } = reportSections(report)

  return (
    <div className="mt-6 text-sm">
      <div className="text-center">
        <p>{company}</p>
        <p className="mt-1 font-semibold">{account}, Period Ending {report.statementDate}</p>
        <p className="font-semibold uppercase tracking-wide">Reconciliation report</p>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          {report.finished
            ? <>Reconciled on: {report.finished.at.slice(0, 10)} · Reconciled by: {report.finished.by}</>
            : <>Not yet reconciled — the difference is {formatMoney(report.difference)}</>}
        </p>
      </div>
      <hr className="mt-3 border-neutral-400" />

      <div className="mt-5 flex items-baseline justify-between">
        <p className="font-semibold">Summary</p>
        <p className="text-xs text-neutral-500">{currency}</p>
      </div>
      <table className="mt-1 w-full">
        <tbody>
          {summary.map((l) => (
            <tr key={l.label}>
              <td className={`py-0.5 ${l.gapBefore ? 'pt-4' : ''}`}>
                <span className="flex items-baseline">
                  <span>{l.label}</span>
                  <span className="mx-1 flex-1 border-b border-dotted border-neutral-400" aria-hidden />
                </span>
              </td>
              <td className={`whitespace-nowrap py-0.5 text-right font-mono tabular-nums ${l.gapBefore ? 'pt-4' : ''} ${
                l.rule === 'double' ? 'border-b-4 border-double border-neutral-700 dark:border-neutral-300'
                : l.rule === 'single' ? 'border-b border-neutral-700 dark:border-neutral-300' : ''}`}>
                {formatMoney(l.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {report.importGap !== 0n && (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
          Import gap {formatMoney(report.importGap)}: the rows on file do not reach the printed
          ending balance — a row is missing, doubled, or the balance was typed wrong.
        </p>
      )}

      <p className="mt-6 font-semibold">Details</p>
      {details.map((s) => <Section currency={currency} key={s.title} section={s} />)}

      {additional.length > 0 && (
        <>
          <p className="mt-6 font-semibold">Additional Information</p>
          {additional.map((s) => <Section currency={currency} key={s.title} section={s} />)}
        </>
      )}

      {report.difference !== 0n && (
        <>
          <p className="mt-6 font-semibold">Why the difference is what it is</p>
          <Summary recon={report.recon} />
        </>
      )}
    </div>
  )
}

const TH = 'py-1 pr-3 text-left text-xs font-medium uppercase tracking-wide text-neutral-500'

function Section({ section,currency='CAD' }: { section: ReportSection;currency?:string }) {
  const formatMoney=nativeMoney(currency)
  return (
    <div className="mt-4">
      <p className="text-neutral-700 dark:text-neutral-300">{section.title}</p>
      <table className="mt-1 w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-24" /><col className="w-24" /><col className="w-20" /><col /><col className="w-28" />
        </colgroup>
        <thead>
          <tr className="border-b border-neutral-400">
            <th className={TH}>Date</th><th className={TH}>Type</th><th className={TH}>Ref no.</th>
            <th className={TH}>Payee</th><th className={`${TH} text-right`}>Amount (CAD)</th>
          </tr>
        </thead>
        <tbody>
          {section.rows.length === 0 ? (
            <tr><td colSpan={5} className="py-1 text-xs italic text-neutral-400">none</td></tr>
          ) : section.rows.map((r, i) => (
            <tr key={i} className="border-b border-neutral-100 dark:border-neutral-900">
              <td className="py-1 pr-3 font-mono text-xs">{r.date}</td>
              <td className="py-1 pr-3 text-xs">{r.type}</td>
              <td className="py-1 pr-3 font-mono text-xs">{r.ref}</td>
              <td className="truncate py-1 pr-3">{r.payee}</td>
              <td className="whitespace-nowrap py-1 text-right font-mono tabular-nums">{formatMoney(r.amount)}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-neutral-700 dark:border-neutral-300">
            <td colSpan={4} className="py-1 pr-3 font-medium">Total</td>
            <td className="whitespace-nowrap py-1 text-right font-mono font-medium tabular-nums">{formatMoney(section.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
