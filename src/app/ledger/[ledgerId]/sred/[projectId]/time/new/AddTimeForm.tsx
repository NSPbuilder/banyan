'use client'

import { ActionForm, type FormAction } from '@/components/ActionForm'
import { DateInput } from '@/components/DateInput'
import { Picker } from '@/components/Picker'
import { SRED_FIELDS as F } from '@/lib/sred-fields'
import { TIME_PASTE_FIELDS } from '@/lib/sred-kinds'
import { BUTTON, FIELD, LABEL } from '@/lib/ui'
import { PasteBox } from '../../ProjectBody'

/**
 * Hours on a project: one day by hand, or a batch pasted — the add form the
 * Time tab's button floats (2026-09-16). It used to sit open on the tab.
 */
export function AddTimeForm({ ledgerId, projectId, employees, today, actions, initial }: {
  ledgerId: string; projectId: string
  employees: Array<{ id: string; name: string; is_specified: boolean }>
  today: string
  actions: { logTime: FormAction; logTimeBatch: FormAction }
  initial?: { employeeId: string; onDate: string; hours: string; activity: string }
}) {
  return (
    <>
      <ActionForm action={actions.logTime} submit="Record" working="…"
                  className="mt-4 form-grid items-end" buttonClassName={BUTTON} stickyActions>
        <input type="hidden" name={F.ledgerId} value={ledgerId} />
        <input type="hidden" name={F.projectId} value={projectId} />
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>Who</span>
          <Picker name={F.employeeId} required className="mt-1"
                  defaultValue={initial?.employeeId ?? ''}
                  ariaLabel="Who did the work"
                  options={employees.map((e) => ({
                    id: e.id, label: e.name,
                    hint: e.is_specified ? 'specified employee' : undefined,
                  }))} />
        </label>
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>Day</span>
          <DateInput name={F.onDate} required defaultValue={initial?.onDate ?? today} className={`mt-1 ${FIELD}`} />
        </label>
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>Hours</span>
          <input name={F.hours} required inputMode="decimal" defaultValue={initial?.hours ?? ''} className={`mt-1 w-20 ${FIELD}`} />
        </label>
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>What was done</span>
          <input name={F.activity} required defaultValue={initial?.activity ?? ''} className={`mt-1 w-[30rem] ${FIELD}`} />
        </label>
      </ActionForm>

      <PasteBox ledgerId={ledgerId} projectId={projectId} action={actions.logTimeBatch}
                fields={TIME_PASTE_FIELDS}
                 />
    </>
  )
}
