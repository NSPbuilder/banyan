'use client'

import { DataTable } from '@/components/Table'

import { formatNumber } from '@/lib/numbers'
import {
  DELIMITER_NAME, ROLES, ROLE_LABEL,
  type ColumnProfile, type ColumnRole, type Delimiter, type Mapping,
} from '@/lib/bank-csv'
import { ORDERS, ORDER_EXAMPLE, orderLabel, type DateOrder } from '@/lib/dates'
import { FIELD } from '@/lib/ui'

/**
 * The mapping screen: every column the file actually has, the first few values
 * in it, and what it means.
 *
 * The values are shown beside the choice on purpose. A dropdown listing
 * "Column 3" and nothing else asks the user to remember their bank's layout;
 * showing "1/15/2024, 1/16/2024, 2/01/2024" asks them to read.
 */
export function ColumnMapper({
  fileName, rowCount, delimiter, headerRow, profiles, mapping, onRole, onOrder, onFlip,
}: {
  fileName: string
  rowCount: number
  delimiter: Delimiter
  headerRow: number | null
  profiles: ColumnProfile[]
  mapping: Mapping
  onRole: (index: number, role: ColumnRole) => void
  onOrder: (order: DateOrder | null) => void
  onFlip: (flip: boolean) => void
}) {
  const dateColumn = profiles.find((p) => mapping.roles[p.index] === 'date')
  const verdict = dateColumn?.dates
  const signed = mapping.roles.includes('amount')

  return (
    <section className="mt-6">
      <p className="text-sm text-neutral-500">
        <strong className="font-medium text-neutral-900 dark:text-neutral-100">{fileName}</strong>
        {' — '}{formatNumber(rowCount)} row{rowCount === 1 ? '' : 's'}, {formatNumber(profiles.length)} columns,
        {' '}{DELIMITER_NAME[delimiter].toLowerCase()} separated,{' '}
        {headerRow === null
          ? 'no header row, so the columns have no names'
          : `column names taken from row ${headerRow + 1}`}.
      </p>

      <DataTable density="reading" className="mt-4 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-3 font-medium">Column</th>
            <th className="py-2 pr-3 font-medium">First values</th>
            <th className="py-2 font-medium">Means</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((p) => (
            <tr key={p.index} className="border-b border-neutral-100 align-top dark:border-neutral-800">
              <td className="py-2 pr-3">
                <span className="font-medium">{p.header || `Column ${p.index + 1}`}</span>
              </td>
              <td className="py-2 pr-3 font-mono text-xs text-neutral-600 dark:text-neutral-400">
                {p.samples.length === 0
                  ? <span className="italic text-neutral-400">nothing</span>
                  : p.samples.map((s, i) => <span key={i} className="block truncate">{s}</span>)}
              </td>
              <td className="py-2">
                <label className="sr-only" htmlFor={`role-${p.index}`}>
                  What column {p.index + 1} means
                </label>
                <select
                  id={`role-${p.index}`}
                  name={`role-${p.index}`}
                  value={mapping.roles[p.index]}
                  onChange={(e) => onRole(p.index, e.target.value as ColumnRole)}
                  className={FIELD}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      {dateColumn && (
        <div className="mt-5 rounded border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Date format</p>
          {verdict && verdict.kind !== 'certain' &&
            <p className="mt-1 text-sm text-amber-700 dark:text-amber-400">{verdict.because}</p>}
          <label className="sr-only" htmlFor="date-order">How the dates are written</label>
          <select
            id="date-order"
            name="date-order"
            value={mapping.order ?? ''}
            onChange={(e) => onOrder(e.target.value === '' ? null : (e.target.value as DateOrder))}
            className={`mt-3 ${FIELD}`}
          >
            <option value="">Choose…</option>
            {ORDERS.map((o) => (
              <option key={o} value={o}>{orderLabel(o)} — {ORDER_EXAMPLE[o]}</option>
            ))}
          </select>
        </div>
      )}

      {signed && (
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="flip"
            checked={mapping.flip}
            onChange={(e) => onFlip(e.target.checked)}
            className="h-4 w-4"
          />
          This file writes withdrawals as positive numbers
        </label>
      )}
    </section>
  )
}
