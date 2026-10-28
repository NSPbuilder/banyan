'use client'

import type { CustomerStatement } from '@/lib/customer-docs'
import { formatMoney } from '@/lib/money'
import { DocHeader } from '@/components/DocHeader'

/**
 * The statement a customer receives: what they owe, document by document, with
 * the aging report's own bucket line underneath. Draws whatever
 * `renderCustomerStatement` built — no query, no arithmetic of its own; even
 * the total arrived computed. The PDF exit is the generated file (same
 * derivation, `customerStatementPdf`); printing this page remains for paper.
 */
export function StatementView({ statement, pdfHref }: {
  statement: CustomerStatement
  pdfHref?: string
}) {
  const s = statement
  return (
    <div data-customer-statement={s.asOf}>
      <DocHeader pdfHref={pdfHref} />

      <div className="flex items-start justify-between">
        <div>
          <p className="text-lg font-semibold">{s.company.name}</p>
          {s.company.addressLines.map((l, i) => (
            <p key={i} className="text-sm text-neutral-600 dark:text-neutral-400">{l}</p>
          ))}
          {s.company.taxNumbers.map((t) => (
            <p key={t} className="text-xs text-neutral-500">{t}</p>
          ))}
        </div>
        <div className="text-right">
          <h1 className="text-2xl font-semibold tracking-tight">Statement</h1>
          <p className="mt-1 text-xs text-neutral-500">As at {s.asOf}</p>
        </div>
      </div>

      <div className="mt-8">
        <p className="text-xs uppercase tracking-wide text-neutral-500">For</p>
        <p className="mt-1 font-medium">{s.party.name}</p>
        {s.party.addressLines.map((l, i) => (
          <p key={i} className="text-sm text-neutral-600 dark:text-neutral-400">{l}</p>
        ))}
      </div>

      <table className="mt-8 w-full text-sm">
        <tbody>
          <tr className="border-b border-neutral-300 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <td className="py-1">Document</td>
            <td className="py-1">Issued</td>
            <td className="py-1">Due</td>
            <td className="py-1 text-right">Original</td>
            <td className="py-1 text-right">Settled</td>
            <td className="py-1 text-right">Open</td>
          </tr>
          {s.items.map((d, i) => (
            <tr key={i} className="border-b border-neutral-200 last:border-0 dark:border-neutral-800">
              <td className="py-2">
                <span className="font-mono text-xs">{d.number ?? 'unnumbered'}</span>
                {d.kind === 'credit_note' && (
                  <span className="ml-2 text-xs text-neutral-500">credit note</span>
                )}
                {d.kind === 'on_account' && (
                  <span className="ml-2 text-xs text-neutral-500">payment on account</span>
                )}
              </td>
              <td className="py-2 text-neutral-600 dark:text-neutral-400">{d.issuedOn}</td>
              <td className="py-2 text-neutral-600 dark:text-neutral-400">{d.dueOn}</td>
              <td className="py-2 text-right font-mono tabular-nums">{formatMoney(d.original)}</td>
              <td className="py-2 text-right font-mono tabular-nums">{formatMoney(d.applied)}</td>
              <td className="py-2 text-right font-mono tabular-nums">{formatMoney(d.balance)}</td>
            </tr>
          ))}
          {s.items.length === 0 && (
            <tr><td colSpan={6} className="py-4 text-neutral-500">
              Nothing owing as at {s.asOf}. Thank you.
            </td></tr>
          )}
          <tr>
            <td colSpan={5} className="py-2 text-right text-xs uppercase tracking-wide text-neutral-500">
              Total owing
            </td>
            <td className="py-2 text-right font-mono text-base font-semibold tabular-nums" data-total-owed>
              {formatMoney(s.totalOwed)}
            </td>
          </tr>
        </tbody>
      </table>

      {s.agingLine && (
        <table className="mt-6 w-full text-sm" data-aging-line>
          <tbody>
            <tr className="border-b border-neutral-300 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              {s.agingLine.labels.map((l) => <td key={l} className="py-1 text-right first:text-left">{l}</td>)}
            </tr>
            <tr>
              {s.agingLine.amounts.map((a, i) => (
                <td key={i} className="py-2 text-right font-mono tabular-nums first:text-left">
                  {formatMoney(a)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      )}
    </div>
  )
}
