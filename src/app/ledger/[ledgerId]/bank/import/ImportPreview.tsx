'use client'

import { DataTable } from '@/components/Table'

import { formatNumber } from '@/lib/numbers'
import { type Applied, type Problem } from '@/lib/bank-csv'
import { nativeMoney } from '@/lib/fx-money'

const SHOWN = 20

function Note({ level, children }: { level: 'error' | 'warning' | 'ok'; children: React.ReactNode }) {
  const tone =
    level === 'error'
      ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
      : level === 'warning'
      ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300'
      : 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
  return (
    <p role={level === 'error' ? 'alert' : 'status'}
       className={`mb-2 rounded border px-3 py-2 text-sm ${tone}`}>
      {children}
    </p>
  )
}

/**
 * What the mapping produces, or what is stopping it.
 *
 * The blocking errors and the rows are mutually exclusive by construction: if
 * anything is wrong, nothing is shown that could be mistaken for a result. A
 * preview rendered beside an unresolved date format is how a file gets imported
 * in the wrong month.
 */
export function ImportPreview({
  problems, applied,currency='CAD',
}: {
  currency?:string
  problems: Problem[]
  applied: Applied | null
}) {
  const formatMoney=nativeMoney(currency)
  const errors = problems.filter((p) => p.level === 'error')
  const warnings = problems.filter((p) => p.level === 'warning')

  if (errors.length > 0) {
    return (
      <section className="mt-6">
        {errors.map((p) => <Note key={p.code} level="error">{p.message}</Note>)}
        <p className="mt-3 text-sm text-neutral-500">
          Nothing is read until these are settled.
        </p>
      </section>
    )
  }

  if (!applied) return null

  const total = applied.rows.reduce((a, r) => a + r.amount, 0n)
  const inbound = applied.rows.filter((r) => r.amount > 0n).reduce((a, r) => a + r.amount, 0n)
  const outbound = total - inbound
  const dates = applied.rows.map((r) => r.date).sort()

  return (
    <section className="mt-6">
      {warnings.map((p) => <Note key={p.code} level="warning">{p.message}</Note>)}

      {applied.problems.length > 0 && (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium text-amber-900 dark:text-amber-300">
            {formatNumber(applied.problems.length)} row{applied.problems.length === 1 ? '' : 's'} could not be read
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-amber-900 dark:text-amber-300">
            {applied.problems.slice(0, 8).map((p) => <li key={`${p.row}-${p.code}`}>{p.message}</li>)}
            {applied.problems.length > 8 && (
              <li className="italic">…and {applied.problems.length - 8} more</li>
            )}
          </ul>
        </div>
      )}

      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        <strong className="font-medium text-neutral-900 dark:text-neutral-100">
          {formatNumber(applied.rows.length)} row{applied.rows.length === 1 ? '' : 's'}
        </strong>
        {applied.rows.length > 0 && <> from {dates[0]} to {dates[dates.length - 1]}. </>}
        {' '}In {formatMoney(inbound)}, out {formatMoney(-outbound)}, net {formatMoney(total)}.
      </p>

      {applied.rows.length > 0 && (
        <DataTable density="reading" className="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-3 font-medium">Date</th>
              <th className="py-2 pr-3 font-medium">Description</th>
              <th className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {applied.rows.slice(0, SHOWN).map((r) => (
              <tr key={r.row} className="border-b border-neutral-100 dark:border-neutral-800">
                <td className="py-1.5 pr-3 font-mono text-xs">{r.date}</td>
                <td className="py-1.5 pr-3">{r.description || <span className="italic text-neutral-400">no description</span>}</td>
                <td className={`py-1.5 text-right font-mono text-xs tabular-nums ${
                  r.amount < 0n ? 'text-red-700 dark:text-red-400' : ''}`}>
                  {formatMoney(r.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {applied.rows.length > SHOWN && (
        <p className="mt-2 text-xs text-neutral-500">
          Showing the first {formatNumber(SHOWN)} of {formatNumber(applied.rows.length)}.
        </p>
      )}
    </section>
  )
}
