'use client'

import { DataTable } from '@/components/Table'

import { nativeMoney } from '@/lib/fx-money'
import type { Reconciliation } from '@/lib/bank'
import { reconciliationParts, reconciliationTotals } from '@/lib/recon-display'

/**
 * What the statement says, what the books say, and what makes up the gap.
 *
 * There are THREE explanations and they add up to the difference exactly —
 * `reconciliation()` computes them that way and `07` section 4 names them.
 * Timing differences get their own line rather than being absorbed into
 * "unaccounted", which is the usual way a reconciliation stops being one.
 *
 * FOUR rows are printed, because the third is split. An opening balance is
 * where the account started, not money that moved, so it would otherwise sit
 * inside "book movement no row claims" for ever, explaining nothing. The split
 * is display only — `openingPosition` is part of `booksUnclaimed`, not a fourth
 * term — so the two printed halves are shown net of each other, or the four
 * rows stop summing. `M66` asserts the printed four sum to the printed
 * difference; `M63` cannot, because it only ever looks at the three.
 *
 * Its own file since 19: the feed screen it used to live in is gone, and this
 * is the book-side explanation the REPORT prints. The reconcile screen shows
 * the QuickBooks figures instead; this is why the difference is what it is.
 */
export function Summary({ recon }: { recon: Reconciliation }) {
  const formatMoney=nativeMoney(recon.currency??'CAD')
  // The rows and their four-way split live in recon-display.ts — the PDF
  // report prints the same arrays, so the split cannot fork between exits.
  const rows = reconciliationTotals(recon)
  const parts = reconciliationParts(recon)

  return (
    <section className="mt-6 rounded border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        As at {recon.asOf}
      </p>
      <DataTable density="reading" className="mt-2 w-full text-sm">
        <tbody>
          {rows.map(([label, amount]) => (
            <tr key={label} className={label === 'Difference' ? 'border-t border-neutral-300 dark:border-neutral-700' : ''}>
              <td className="py-1">{label}</td>
              <td className="py-1 text-right font-mono tabular-nums">{formatMoney(amount)}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-neutral-500">
        Made up of
      </p>
      <DataTable density="reading" className="mt-1 w-full text-sm">
        <tbody>
          {parts.map(([label, amount, why]) => (
            <tr key={label}>
              <td className="py-1">
                {label}
                <span className="block text-xs text-neutral-500">{why}</span>
              </td>
              <td className="py-1 text-right align-top font-mono tabular-nums">{formatMoney(amount)}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </section>
  )
}
