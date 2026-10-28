'use client'

import { ActionForm, type FormAction } from '@/components/ActionForm'
import { DateInput } from '@/components/DateInput'
import { SRED_FIELDS as F } from '@/lib/sred-fields'
import { EVIDENCE_KINDS, EVIDENCE_PASTE_FIELDS } from '@/lib/sred-kinds'
import { BUTTON, FIELD, LABEL } from '@/lib/ui'
import { PasteBox } from '../../ProjectBody'

/**
 * A piece of evidence on a project: one by hand, or a batch pasted — the add
 * form the Evidence section's button floats (2026-09-16).
 */
export function AddEvidenceForm({ ledgerId, projectId, today, actions, initial }: {
  ledgerId: string; projectId: string; today: string
  actions: { addEvidence: FormAction; addEvidenceBatch: FormAction }
  initial?: { kind: string; title: string; onDate: string; note: string }
}) {
  return (
    <>
      <ActionForm action={actions.addEvidence} submit="Add" working="…"
                  className="mt-4 form-grid items-end" buttonClassName={BUTTON} stickyActions>
        <input type="hidden" name={F.ledgerId} value={ledgerId} />
        <input type="hidden" name={F.projectId} value={projectId} />
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>Kind</span>
          <select name={F.kind} defaultValue={initial?.kind ?? EVIDENCE_KINDS[0]?.kind} className={`mt-1 ${FIELD}`}>
            {EVIDENCE_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>{k.label}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>What it is</span>
          <input name={F.title} required defaultValue={initial?.title ?? ''} className={`mt-1 w-80 ${FIELD}`} />
        </label>
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>Dated</span>
          <DateInput name={F.onDate} required defaultValue={initial?.onDate ?? today} className={`mt-1 ${FIELD}`} />
        </label>
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>Note</span>
          <input name={F.note} defaultValue={initial?.note ?? ''} className={`mt-1 w-80 ${FIELD}`} />
        </label>
      </ActionForm>

      <PasteBox ledgerId={ledgerId} projectId={projectId} action={actions.addEvidenceBatch}
                fields={EVIDENCE_PASTE_FIELDS}
                 />
    </>
  )
}
