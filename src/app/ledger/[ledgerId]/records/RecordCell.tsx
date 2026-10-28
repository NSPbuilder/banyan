'use client'

import { DateInput } from '@/components/DateInput'
import { nameKey, type RowColumn } from '@/lib/record-rows'
import { FIELD } from '@/lib/ui'

/**
 * ONE BOX OF A CORPORATE-RECORD ROW — drawn the same whether the row is being
 * added (`RowsForm`) or put right on the register (`RowEditor`, 0083), so a
 * person corrects a row in the boxes they entered it in.
 *
 * A name is marked the way the add form always marked it: new to the list, or
 * found only on another company's list and used here (owner, 2026-09-16:
 * 可以用，但必须写出来).
 */
export function RecordCell({
  column: c, name, value, onChange, label, minuteKinds, known, local, arriving, namesList, classesList,
}: {
  column: RowColumn
  /** The field's name on the wire — `row.<i>.<column>`. */
  name: string
  value: string
  onChange: (v: string) => void
  label: string
  minuteKinds: string[]
  /** Every name on any company's list, this company's, and names another row of the same form brings. */
  known: Set<string>
  local: Set<string>
  arriving?: Set<string>
  namesList: string
  classesList: string
}) {
  const cls = `${FIELD} ${c.width ?? ''} py-1 text-xs`
  if (c.type === 'date') {
    return <DateInput name={name} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={cls} />
  }
  if (c.type === 'choice') {
    const options = c.options ?? minuteKinds.map((k) => ({ value: k, label: k.replaceAll('_', ' ') }))
    return (
      <select name={name} required={c.required && ['citizenOrPr', 'taxResidentCa', 'citizenships'].includes(c.key)} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} className={cls}>
        {value === '' && <option value="">—</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  }
  const key = nameKey(value)
  const named = c.type === 'name' && key !== ''
  const isNew = named && !known.has(key) && !(c.key === 'from' && arriving?.has(key))
  const isElsewhere = named && known.has(key) && !local.has(key)
  return (
    <span className="flex flex-col gap-0.5">
      <input name={name} required={c.required && ['citizenOrPr', 'taxResidentCa', 'citizenships'].includes(c.key)} value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} inputMode={c.type === 'count' ? 'numeric' : undefined}
             list={c.type === 'name' ? namesList : c.key === 'shareClass' ? classesList : undefined}
             className={`${cls} ${c.type === 'count' ? 'text-right font-mono' : ''}`} />
      {isNew && (
        <span data-new-name className="text-[11px] text-clay-700 dark:text-clay-300">
          {c.key === 'from' ? 'not on the list' : 'new — added to the list'}
        </span>
      )}
      {isElsewhere && (
        <span data-elsewhere-name className="text-[11px] text-amber-700 dark:text-amber-400">
          on another company&apos;s list — used here
        </span>
      )}
    </span>
  )
}
