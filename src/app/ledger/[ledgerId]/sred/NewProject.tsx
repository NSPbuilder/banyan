'use client'

import Link from 'next/link'
import { useActionForm, type FormAction } from '@/components/ActionForm'
import { SRED_FIELDS as F } from '@/lib/sred-fields'
import { DateInput } from '@/components/DateInput'
import { BUTTON, FIELD, LABEL, REFUSAL_QUIET } from '@/lib/ui'

/**
 * Opening a project: one uncertainty, one code, one start date — in the form
 * the list's button floats (2026-09-16). It used to unfold inside the list.
 */
export function NewProject({ ledgerId, action, initial }: {
  ledgerId: string; action: FormAction
  initial?: { title: string; startedOn: string; fieldOfScience: string | null }
}) {
  const { state, pending, formProps } = useActionForm(action)
  return (
    <form {...formProps} className="mt-4">
      <input type="hidden" name={F.ledgerId} value={ledgerId} />
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>Code</span>
          <input name={F.code} required className={`mt-1 w-24 ${FIELD}`} />
        </label>
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>What was uncertain</span>
          <input name={F.title} required defaultValue={initial?.title ?? ''} className={`mt-1 w-96 ${FIELD}`} />
        </label>
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>Started</span>
          <DateInput name={F.startedOn} required defaultValue={initial?.startedOn ?? ''} className={`mt-1 ${FIELD}`} />
        </label>
        {initial && <label className="text-xs text-neutral-500">
          <span className={LABEL}>Field of science</span>
          <input name={F.fieldOfScience} defaultValue={initial.fieldOfScience ?? ''} className={`mt-1 w-64 ${FIELD}`} />
        </label>}
      </div>
      {state.error && (
        <p role="alert" className={`mt-3 ${REFUSAL_QUIET}`}>
          {state.error}
        </p>
      )}
      {state.ok && state.madeId && (
        <p role="status" className="mt-3 text-sm text-emerald-800 dark:text-emerald-300">
          {state.ok}{' '}
          <Link href={`/ledger/${ledgerId}/sred/${state.madeId}`} className="underline underline-offset-2">Open it</Link>
        </p>
      )}
      <button type="submit" disabled={pending} className={`mt-4 ${BUTTON}`}>{pending ? 'Opening…' : 'Open'}</button>
    </form>
  )
}
