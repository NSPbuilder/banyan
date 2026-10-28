'use client'

import { useState } from 'react'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { RECORD_FIELDS as F, rowField } from '@/lib/forms'
import { RECORD_COLUMNS, nameKey, type RecordTable, type RowColumn } from '@/lib/record-rows'
import { QUIET } from '@/lib/ui'
import { RecordCell } from './RecordCell'

/** Who and what the boxes can suggest — the add form's own lists. */
export type RecordChoices = {
  names: string[]
  localNames: string[]
  classes: string[]
  minuteKinds: string[]
}

/**
 * The columns a row of this kind has. A share issue has nobody it came FROM and
 * a cancellation nobody it went TO, so their boxes are not drawn — the door
 * would refuse them anyway (`rowProblems`).
 */
const SHOWN: Partial<Record<string, readonly string[]>> = {
  issue: ['shareClass', 'onDate', 'to', 'quantity', 'consideration', 'certificateNo', 'details'],
  cancellation: ['shareClass', 'onDate', 'from', 'quantity', 'consideration', 'surrenderedNo', 'balanceNo', 'details'],
}

/** What a row keeps whatever the edit: a share movement's kind and an address's office. */
const FIXED = new Set(['kind', 'office'])

/**
 * PUTTING ONE REGISTER ROW RIGHT, ON THE ROW (0083).
 *
 * The owner: 「minute book不能修改編輯或者刪除欸。所有的紀錄儘量都可以編輯刪除」. The
 * row's Edit opens its own boxes in place — the add form's columns, holding
 * what is on file — with Save, Delete and Cancel; nothing is a box until Edit
 * is pressed (the rule `CR43` counts).
 *
 * `blankMeansKeep` names columns the screen is never sent — a significant
 * individual's birth date and address — so an empty box leaves them as they are.
 */
export function RowEditor({
  ledgerId, table, recordId, initial, choices, correct, remove, onClose, blankMeansKeep = [], removeNote,
}: {
  ledgerId: string
  table: RecordTable
  recordId: string
  initial: Record<string, string>
  choices: RecordChoices
  correct: FormAction
  remove: FormAction
  onClose: () => void
  blankMeansKeep?: string[]
  /** What deleting this row also does, said beside the button. */
  removeNote?: string
}) {
  const [values, setValues] = useState(initial)
  const known = new Set(choices.names.map(nameKey))
  const local = new Set(choices.localNames.map(nameKey))
  const shown = SHOWN[initial.kind ?? '']
  const columns = RECORD_COLUMNS[table].filter((c) => !shown || c.key === 'kind' || shown.includes(c.key))
  const listId = (what: string) => `edit-${recordId}-${what}`
  const which = (
    <>
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      <input type="hidden" name={F.table} value={table} />
      <input type="hidden" name={F.recordId} value={recordId} />
    </>
  )
  const box = (c: RowColumn) => {
    if (FIXED.has(c.key)) {
      const label = c.options?.find((o) => o.value === values[c.key])?.label ?? values[c.key]
      return (
        <>
          <span className="py-1 text-xs text-neutral-600 dark:text-neutral-300">{label}</span>
          <input type="hidden" name={rowField(0, c.key)} value={values[c.key] ?? ''} />
        </>
      )
    }
    const cell = (
      <RecordCell column={table === 'transparency' ? { ...c, required: c.required || ['citizenOrPr', 'taxResidentCa'].includes(c.key) || (c.key === 'citizenships' && values.citizenOrPr === 'no') } : c} name={rowField(0, c.key)} value={values[c.key] ?? ''}
                  onChange={(v) => setValues((s) => ({ ...s, [c.key]: v }))}
                  label={c.label} minuteKinds={choices.minuteKinds} known={known} local={local}
                  namesList={listId('names')} classesList={listId('classes')} />
    )
    return blankMeansKeep.includes(c.key)
      ? <span className="flex flex-col gap-0.5">{cell}<span className="text-[11px] text-neutral-400">blank keeps what is on file</span></span>
      : cell
  }

  return (
    <div data-editing={recordId} className="flex flex-col gap-2">
      <ActionForm action={correct} submit="Save" working="Saving…" onSucceeded={onClose}
                  className="flex flex-wrap items-end gap-x-3 gap-y-2" buttonClassName={QUIET}>
        {which}
        <datalist id={listId('names')}>{choices.names.map((n) => <option key={n} value={n} />)}</datalist>
        <datalist id={listId('classes')}>{choices.classes.map((n) => <option key={n} value={n} />)}</datalist>
        {columns.map((c) => (
          <label key={c.key} className="flex flex-col gap-0.5 text-[11px] text-neutral-500">
            {c.label}{c.required && !FIXED.has(c.key) ? ' *' : ''}
            {box(c)}
          </label>
        ))}
      </ActionForm>
      <div className="flex flex-wrap items-center gap-3">
        <ActionForm action={remove} submit="Delete" working="Deleting…" onSucceeded={onClose}
                    className="inline" buttonClassName={`${QUIET} text-red-700 dark:text-red-400`}>
          {which}
        </ActionForm>
        {removeNote && <span className="text-xs text-neutral-500">{removeNote}</span>}
        <button type="button" onClick={onClose} className="text-xs text-neutral-500 hover:underline">Cancel</button>
      </div>
    </div>
  )
}
