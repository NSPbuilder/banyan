'use client'

import { FormError, useActionForm } from '@/components/ActionForm'
import { createPartyAction } from '@/app/actions'
import { saveEmployeeAction } from '@/app/ledger/[ledgerId]/payroll/actions'
import { PAYROLL_FIELDS as F } from '@/lib/forms'
import { FREQUENCY_LABEL } from '@/lib/payroll/labels'
import { DateInput } from '@/components/DateInput'
import { Picker } from '@/components/Picker'
import { formatMoney } from '@/lib/money'
import { BUTTON, FIELD } from '@/lib/ui'

type Party = { id: string; name: string }
type Editing = {
  id: string
  party_id: string
  party_name: string
  frequency: string
  federal_claim: string | null
  bc_claim: string | null
  additional_tax: string
  sin: string | null
  occupation: string | null
  hired_on: string | null
  is_active: boolean
  is_specified: boolean
  cpp_exempt: boolean
  ei_exempt: boolean
}

const input =
  `mt-1 w-full ${FIELD}`
const label = 'block text-xs font-medium uppercase tracking-wide text-neutral-500'

/** Cents as a plain editable number: no separators, blank when there is none. */
const amount = (cents: string | null | undefined) =>
  cents == null ? '' : formatMoney(BigInt(cents)).replace(/,/g, '')

export function EmployeeForm({
  ledgerId, parties, editing, initial,
}: {
  ledgerId: string
  /** Whom this company could add. Empty while editing — the person is settled. */
  parties: Party[]
  editing: Editing | null
  initial?: Editing
}) {
  const { state, pending, formProps } = useActionForm(saveEmployeeAction)
  const source = editing ?? initial

  return (
    <>
      <FormError state={state} />
      {state.ok && (
        <p role="status" className="mt-4 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          {state.ok}
        </p>
      )}

      <form {...formProps} key={editing?.id ?? 'new'} className="mt-4 max-w-4xl space-y-4">
        <input type="hidden" name={F.ledgerId} value={ledgerId} />
        {editing && <input type="hidden" name={F.employeeId} value={editing.id} />}

        <div className="form-grid">
          <div>
            <span className={label}>Person</span>
            {editing ? (
              <>
                <input type="hidden" name={F.partyId} value={editing.party_id} />
                <p id="pe-party" className="mt-1 px-3 py-2 text-sm">{editing.party_name}</p>
              </>
            ) : (
              <Picker name={F.partyId} required className="mt-1"
                      ariaLabel="Person"
                      options={parties.map((p) => ({ id: p.id, label: p.name }))}
                      create={{
                        presentation: 'party',
                        title: 'New person',
                        action: createPartyAction,
                        // Hiring belongs to the payroll record, not Party registration.
                        hidden: { ledgerId, kind: 'person', role: 'employee' },
                        fields: [
                          { name: 'name', label: 'Name', width: '15rem', takesTyped: true },
                        ],

                      }} />
            )}
          </div>
          <div>
            <label htmlFor="pe-freq" className={label}>Paid</label>
            <select id="pe-freq" name={F.frequency} required className={input}
                    defaultValue={source?.frequency ?? 'semi_monthly'}>
              {Object.entries(FREQUENCY_LABEL).map(([code, text]) =>
                <option key={code} value={code}>{text}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="pe-hired" className={label}>On payroll since</label>
            <DateInput id="pe-hired" name={F.hiredOn} className={input}
                       defaultValue={source?.hired_on ?? ''} />
          </div>
        </div>

        <div className="form-grid">
          <div>
            <label htmlFor="pe-fed" className={label}>Federal TD1</label>
            <input id="pe-fed" name={F.federalClaim} type="text" inputMode="decimal"
                   defaultValue={amount(source?.federal_claim)} className={input} />
          </div>
          <div>
            <label htmlFor="pe-bc" className={label}>BC TD1</label>
            <input id="pe-bc" name={F.bcClaim} type="text" inputMode="decimal"
                   defaultValue={amount(source?.bc_claim)} className={input} />
          </div>
          <div>
            <label htmlFor="pe-occupation" className={label}>Occupation</label>
            <input id="pe-occupation" name={F.occupation} type="text"
                   defaultValue={source?.occupation ?? ''} className={input} />
          </div>
          <div>
            <label htmlFor="pe-extra" className={label}>Extra tax a period</label>
            <input id="pe-extra" name={F.additionalTax} type="text" inputMode="decimal"
                   defaultValue={amount(source?.additional_tax)} className={input} />
          </div>
          <div>
            <label htmlFor="pe-sin" className={label}>SIN</label>
            <input id="pe-sin" name={F.sin} type="text" inputMode="numeric"
                   defaultValue={editing?.sin ?? ''} className={input} />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name={F.isActive} defaultChecked={source?.is_active ?? true} />
          On the active payroll
        </label>

        <label className="flex max-w-prose items-start gap-2 text-sm">
          <input type="checkbox" name={F.isSpecified} defaultChecked={source?.is_specified ?? false}
                 className="mt-1" />
          <span>
            Specified employee

          </span>
        </label>

        <label className="flex max-w-prose items-start gap-2 text-sm">
          <input type="checkbox" name={F.eiExempt} defaultChecked={source?.ei_exempt ?? false}
                 className="mt-1" />
          <span>
            Not insurable for EI

          </span>
        </label>

        <label className="flex max-w-prose items-start gap-2 text-sm">
          <input type="checkbox" name={F.cppExempt} defaultChecked={source?.cpp_exempt ?? false}
                 className="mt-1" />
          <span>
            Exempt from CPP

          </span>
        </label>

        <div className="form-actions">
        <button type="submit" disabled={pending}
                className={BUTTON}>
          {pending ? 'Saving…' : editing ? 'Save changes' : 'Add to payroll'}
        </button>
        </div>
      </form>
    </>
  )
}
