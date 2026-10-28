'use client'

import { useActionForm } from '@/components/ActionForm'
import { createFiscalYearAction } from '@/app/actions'
import { DateInput } from '@/components/DateInput'
import { BUTTON, FIELD, REFUSAL } from '@/lib/ui'

export function FiscalYearForm({ ledgerId, defaultEnd }: { ledgerId: string; defaultEnd: string }) {
  const { state: state, pending: pending, formProps: actionProps } = useActionForm(createFiscalYearAction)

  return (
    <>
      {state.error && (
        <p role="alert" className={`mt-3 ${REFUSAL}`}>
          {state.error}
        </p>
      )}
      <form {...actionProps} className="mt-4 flex flex-wrap items-end gap-3">
        <input type="hidden" name="ledgerId" value={ledgerId} />
        <div>
          <label htmlFor="endDate" className="block text-xs font-medium uppercase tracking-wide text-neutral-500">
            Year ends on
          </label>
          <DateInput id="endDate" name="endDate" required defaultValue={defaultEnd}
                 className={`mt-1 ${FIELD}`} />
        </div>
        <button type="submit" disabled={pending}
                className={BUTTON}>
          {pending ? 'Creating…' : 'Create fiscal year'}
        </button>
      </form>
    </>
  )
}
