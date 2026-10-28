'use client'

import { ActionForm, type FormAction } from '@/components/ActionForm'
import { DateInput } from '@/components/DateInput'
import { RECORD_FIELDS as F } from '@/lib/forms'
import { BUTTON, FIELD } from '@/lib/ui'

export type Choice = { id: string; label: string }

/**
 * The company as the registry knows it — the one record here that is edited
 * rather than added to, in the overlay its Edit button opens (2026-09-16). It
 * used to be five boxes sitting at the top of Basic Info.
 */
export function ProfileForm({ ledgerId, entityId, profile, isCcpc, companyTypes, action }: {
  ledgerId: string
  entityId: string
  profile: { incorporation_number: string | null; business_number: string | null
             recognition_date: string | null; company_type: string | null } | null
  /** Three-state: true, false, or nobody has said — see RECORD_FIELDS.isCcpc. */
  isCcpc: boolean | null
  companyTypes: Choice[]
  action: FormAction
}) {
  return (
    <div className="mt-4">
      <ActionForm action={action} submit="Save" working="Saving…" className="" buttonClassName={BUTTON} stickyActions>
        <input type="hidden" name={F.ledgerId} value={ledgerId} />
        <input type="hidden" name={F.entityId} value={entityId} />
        <div className="form-grid">
          <label className="flex flex-col gap-1 text-xs text-neutral-500">Incorporation no.
            <input name={F.incorporationNumber} defaultValue={profile?.incorporation_number ?? ''} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">Business no.
            <input name={F.businessNumber} defaultValue={profile?.business_number ?? ''} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">Recognition date
            <DateInput name={F.recognitionDate} defaultValue={profile?.recognition_date ?? ''} className={FIELD} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">Type
            <select name={F.companyType} defaultValue={profile?.company_type ?? 'limited'} className={FIELD}>
              {companyTypes.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-neutral-500">CCPC
            <select name={F.isCcpc} defaultValue={isCcpc === null ? '' : isCcpc ? 'yes' : 'no'}
                    className={FIELD}>
              <option value="">Nobody has said</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
        </div>
      </ActionForm>
    </div>
  )
}
