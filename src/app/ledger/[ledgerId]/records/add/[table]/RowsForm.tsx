'use client'

import { DataTable } from '@/components/Table'

import { formatNumber } from '@/lib/numbers'
import { useState } from 'react'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { RECORD_FIELDS as F, rowField } from '@/lib/forms'
import {
  RECORD_COLUMNS, TABLE_WORDS, addFormRow, editFormRow, nameKey, removeFormRow, rowIsBlank, rowsStateOf,
  type FormRow, type RecordTable, type RowColumn,
} from '@/lib/record-rows'
import { BUTTON, QUIET } from '@/lib/ui'
import { RecordCell } from '../../RecordCell'

/**
 * AN ADD FORM OF ROWS — one register's, floated over the register.
 *
 * The owner's two words for it (2026-09-16): each register its own table, and
 * every add a form in a floating page rather than boxes sitting on the screen.
 * So the register page is read-only, its Add button opens this, and a reading
 * of a minute book opens this with the rows it read already in it.
 *
 * The columns are `RECORD_COLUMNS[table]` and nothing else — the same arrays
 * the model is told to answer in and the door reads back — so a column cannot
 * be on the form and missing from the prompt, or the other way round.
 *
 * The values live in state, keyed by row, as the invoice line editor keeps
 * them: a refused form keeps every row as typed, and taking row 2 out takes
 * row 2's values with it. The field names carry the row's POSITION, which is
 * safe because everything a row means is in that row (`rowField`).
 */
export function RowsForm({
  ledgerId, table, readingId, initial, today, names, localNames, classes, minuteKinds, action,
}: {
  ledgerId: string
  table: RecordTable
  /** The reading these rows were read from, until they have been entered. */
  readingId: string | null
  initial: FormRow[]
  today: string
  /** Everybody on ANY company's list — one list of names (0026) — for the suggestions and the "new" mark. */
  names: string[]
  /**
   * Who is on THIS company's list. A name only another company has is used as
   * that party, and the form says so before anything is entered — the door says
   * so again after (owner, 2026-09-16: 可以用，但必须写出来).
   */
  localNames: string[]
  /** This company's share classes as the screens print them. */
  classes: string[]
  /** The minute book's kinds, from its CHECK constraint. */
  minuteKinds: string[]
  action: FormAction
}) {
  const [state, setState] = useState(() => rowsStateOf(initial))
  const [reading, setReading] = useState(readingId)
  const known = new Set(names.map(nameKey))
  const local = new Set(localNames.map(nameKey))
  const columns = RECORD_COLUMNS[table]
  const words = TABLE_WORDS[table]
  const filled = state.rows.filter((r) => !rowIsBlank(table, r.values)).length
  // Names another row of THIS form brings onto the list: somebody issued shares
  // in row 1 can give some up in row 2, because rows go in by date.
  const arriving = new Set(state.rows.flatMap((r) => columns
    .filter((c) => c.type === 'name' && c.key !== 'from')
    .map((c) => nameKey(r.values[c.key] ?? ''))).filter(Boolean))
  const listId = (what: string) => `${table}-${what}`

  const cell = (row: FormRow, position: number, c: RowColumn) => (
    <RecordCell column={table === 'transparency' ? { ...c, required: c.required || (!!row.values.becameOn && (['citizenOrPr', 'taxResidentCa'].includes(c.key) || (c.key === 'citizenships' && row.values.citizenOrPr === 'no'))) } : c} name={rowField(position, c.key)} value={row.values[c.key] ?? ''}
                onChange={(v) => setState((s) => editFormRow(s, row.key, c.key, v))}
                label={`${c.label}, row ${position + 1}`} minuteKinds={minuteKinds}
                known={known} local={local} arriving={arriving}
                namesList={listId('names')} classesList={listId('classes')} />
  )

  return (
    <ActionForm action={action} submit={filled === 0 ? 'Enter' : `Enter ${formatNumber(filled)} ${filled === 1 ? words.one : words.many}`} working="Entering…"
                className="mt-4" buttonClassName={BUTTON} stickyActions
                onSucceeded={() => {
                  // Entered: the form starts again empty, and no longer speaks
                  // for the reading — the door has marked it, and a row typed
                  // now is a row typed by hand.
                  setReading(null)
                  setState((s) => addFormRow({ rows: [], nextKey: s.nextKey }, table, today))
                }}>
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      <input type="hidden" name={F.table} value={table} />
      {reading && <input type="hidden" name={F.readingId} value={reading} />}
      <datalist id={listId('names')}>{names.map((n) => <option key={n} value={n} />)}</datalist>
      <datalist id={listId('classes')}>{classes.map((n) => <option key={n} value={n} />)}</datalist>

      <div className="table-scroll" data-table-scroll tabIndex={0} role="region" aria-label="Corporate record rows">
        <DataTable density="reading" className="text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-neutral-500">
              <th className="py-1 pr-2 font-medium">#</th>
              {columns.map((c) => (
                <th key={c.key} className="py-1 pr-2 font-medium" data-required={c.required ? '' : undefined}>
                  {c.label}{c.required ? ' *' : ''}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row, position) => (
              <RowWithNotes key={row.key} row={row} span={columns.length + 2}>
                <td className="py-1 pr-2 align-top font-mono text-xs text-neutral-400">{position + 1}</td>
                {columns.map((c) => <td key={c.key} className="py-1 pr-2 align-top">{cell(row, position, c)}</td>)}
                <td className="py-1 align-top">
                  <button type="button" data-acts-on={row.key} aria-label={`Remove row ${position + 1}`}
                          onClick={() => setState((s) => removeFormRow(s, row.key, table, today))}
                          className="rounded px-1.5 py-1 text-xs text-neutral-400 hover:bg-neutral-100 hover:text-red-700 dark:hover:bg-neutral-800">
                    ✕
                  </button>
                </td>
              </RowWithNotes>
            ))}
          </tbody>
        </DataTable>
      </div>
      <button type="button" onClick={() => setState((s) => addFormRow(s, table, today))} className={`mt-3 ${QUIET}`}>
        + Add a row
      </button>
    </ActionForm>
  )
}

/** A row, and under it what was read but could not be put in a box as it stood. */
function RowWithNotes({ row, span, children }: { row: FormRow; span: number; children: React.ReactNode }) {
  return (
    <>
      <tr data-row={row.key} className="border-t border-neutral-100 dark:border-neutral-800">{children}</tr>
      {row.unplaced.length > 0 && (
        <tr>
          <td />
          <td colSpan={span - 1} className="pb-2 text-xs text-amber-700 dark:text-amber-400">
            Read, but not put in a box — check it: {row.unplaced.join(' · ')}
          </td>
        </tr>
      )}
    </>
  )
}
