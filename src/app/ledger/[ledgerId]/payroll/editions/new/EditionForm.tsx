'use client'

import { ActionForm, type FormAction } from '@/components/ActionForm'
import { DateInput } from '@/components/DateInput'
import { EDITION_FIGURES, EDITION_HEAD, PDOC_FIELDS } from '@/lib/payroll/edition-fields'
import { PAYROLL_FIELDS } from '@/lib/forms'
import { BUTTON, FIELD, LABEL } from '@/lib/ui'

/**
 * A new T4127 edition, typed from the PDF, and one PDOC example to prove it
 * (0082). Opened on the last edition's figures, so only what moved is typed;
 * every figure says which T4127 table it is on.
 */
export function EditionForm({ ledgerId, startsOn, figures, frequencies, pdocDefaults, action }: {
  ledgerId: string
  startsOn: string
  /** The last edition's figures, by path, as the tables write them. */
  figures: Record<string, string>
  frequencies: Array<{ value: string; label: string }>
  pdocDefaults: { payDate: string; federalClaim: string; bcClaim: string }
  action: FormAction
}) {
  const box = `mt-1 ${FIELD} py-1 font-mono text-xs`
  return (
    <ActionForm action={action} submit="Check and add the edition" working="Checking…"
                className="mt-4 space-y-6" buttonClassName={BUTTON}>
      <input type="hidden" name={PAYROLL_FIELDS.ledgerId} value={ledgerId} />

      <fieldset className="flex flex-wrap items-end gap-4">
        <label className="text-xs text-neutral-500">
          <span className={LABEL}>Takes effect on</span>
          <DateInput name={EDITION_HEAD.startsOn} required defaultValue={startsOn} className={`mt-1 ${FIELD}`} />
        </label>
        <label className="flex-1 text-xs text-neutral-500">
          <span className={LABEL}>Which edition, and what moved</span>
          <input name={EDITION_HEAD.authority} required className={`mt-1 w-full ${FIELD}`} />
        </label>
      </fieldset>

      {EDITION_FIGURES.map((group) => (
        <fieldset key={group.title}>
          <legend className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{group.title}</legend>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
            {group.figures.map((f) => (
              <label key={f.path} className={`text-xs text-neutral-500 ${f.kind === 'list' ? 'col-span-2' : ''}`}>
                {f.label} <span className="text-neutral-400">· table {f.table}</span>
                <input name={f.path} required defaultValue={figures[f.path] ?? ''}
                       className={`${box} w-full`} />
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <fieldset className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
          One PDOC example
        </legend>

        <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2">
          <label className="text-xs text-neutral-500">
            <span className={LABEL}>Pay date</span>
            <DateInput name={PDOC_FIELDS.payDate} required defaultValue={pdocDefaults.payDate} className={`mt-1 ${FIELD}`} />
          </label>
          <label className="text-xs text-neutral-500">
            <span className={LABEL}>Paid</span>
            <select name={PDOC_FIELDS.frequency} defaultValue="semi_monthly" className={`mt-1 ${FIELD}`}>
              {frequencies.map((fr) => <option key={fr.value} value={fr.value}>{fr.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-neutral-500">
            <span className={LABEL}>Gross pay</span>
            <input name={PDOC_FIELDS.gross} required inputMode="decimal" defaultValue="3000.00" className={box} />
          </label>
          <label className="text-xs text-neutral-500">
            <span className={LABEL}>Federal claim</span>
            <input name={PDOC_FIELDS.federalClaim} required inputMode="decimal" defaultValue={pdocDefaults.federalClaim} className={box} />
          </label>
          <label className="text-xs text-neutral-500">
            <span className={LABEL}>BC claim</span>
            <input name={PDOC_FIELDS.bcClaim} required inputMode="decimal" defaultValue={pdocDefaults.bcClaim} className={box} />
          </label>
          <span />
          {([['cpp', 'CPP'], ['cpp2', 'CPP2'], ['ei', 'EI'], ['federalTax', 'Federal tax'], ['provincialTax', 'BC tax']] as const)
            .map(([key, label]) => (
              <label key={key} className="text-xs text-neutral-500">
                <span className={LABEL}>PDOC {label}</span>
                <input name={PDOC_FIELDS[key]} required inputMode="decimal" className={box} />
              </label>
            ))}
        </div>
      </fieldset>
    </ActionForm>
  )
}
