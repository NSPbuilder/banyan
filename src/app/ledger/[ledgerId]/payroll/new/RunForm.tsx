'use client'

import { DataTable } from '@/components/Table'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { FormError, useActionForm } from '@/components/ActionForm'
import { createAccountAction } from '@/app/actions'
import { runPayrollAction } from '@/app/ledger/[ledgerId]/payroll/actions'
import {
  PAYROLL_FIELDS as F, payBonus, payEmployee, payGross, payHours, payInsurable, payPensionable,
} from '@/lib/forms'
import { DateInput } from '@/components/DateInput'
import { Picker } from '@/components/Picker'
import { BUTTON, FIELD } from '@/lib/ui'

type Employee = { id: string; name: string; frequency: string }
type Bank = { id: string; code: string; name: string }
export type RunInitial = {
  payDate: string; periodStart: string; periodEnd: string; bankAccountId: string
  rows: Array<{ employeeId: string; gross: string; hours: string; pensionable: string; insurable: string; bonus: string }>
}

const input =
  `mt-1 w-full ${FIELD}`
const label = 'block text-xs font-medium uppercase tracking-wide text-neutral-500'

export function RunForm({
  ledgerId, today, formKey, employees, banks, initial,
}: {
  ledgerId: string
  today: string
  /**
   * The key a double-click is caught by. Minted on the SERVER, once per load
   * of this page: the same payday submitted twice is then one pay run and one
   * entry. Minting it here instead would be a random value computed during
   * render, which React is entitled to run more than once.
   */
  formKey: string
  employees: Employee[]
  banks: Bank[]
  initial?: RunInitial
}) {
  const { state, pending, formProps } = useActionForm(runPayrollAction)

  // One row per person, everybody on it to begin with — the ordinary payday
  // pays everybody, and taking somebody off is quicker than adding them back.
  const nextKey = useRef(initial ? initial.rows.length : employees.length)
  const [rows, setRows] = useState(
    (initial ? initial.rows : employees.map((e) => ({ employeeId: e.id })))
      .map((e, i) => ({ key: i, employeeId: e.employeeId })))
  const [detail, setDetail] = useState(Boolean(initial?.rows.some((r) =>
    r.pensionable !== r.gross || r.insurable !== r.gross || Number(r.bonus) !== 0)))

  const chosen = new Set(rows.map((r) => r.employeeId))

  return (
    <>
      <FormError state={state} />
      {state.ok && (
        <p role="status" className="mt-4 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          {state.ok}{' '}
          {state.entryId && (
            <Link href={`/ledger/${ledgerId}/entries/${state.entryId}`}
                  className="font-medium underline">view the entry</Link>
          )}
        </p>
      )}

      <form {...formProps} className="mt-6 space-y-5">
        <input type="hidden" name={F.ledgerId} value={ledgerId} />
        <input type="hidden" name={F.idempotencyKey} value={formKey} />

        <div className="form-grid">
          <div>
            <label htmlFor="pr-date" className={label}>Pay date</label>
            <DateInput id="pr-date" name={F.payDate} required defaultValue={initial?.payDate ?? today}
                       className={input} />
          </div>
          <div>
            <label htmlFor="pr-from" className={label}>Period from</label>
            <DateInput id="pr-from" name={F.periodStart} defaultValue={initial?.periodStart ?? ''} className={input} />
          </div>
          <div>
            <label htmlFor="pr-to" className={label}>Period to</label>
            <DateInput id="pr-to" name={F.periodEnd} defaultValue={initial?.periodEnd ?? ''} className={input} />
          </div>
          <div>
            <label className={label}>Net pay comes out of</label>
            <Picker name={F.bankAccountId} required className="mt-1"
                    defaultValue={initial?.bankAccountId ?? ''}
                    ariaLabel="Paid from"
                    options={banks.map((b) => ({ id: b.id, label: `${b.code} — ${b.name}` }))}
                    create={{
                      title: 'New bank account',
                      action: createAccountAction,
                      hidden: {
                        ledgerId,
                        accountType: 'asset',
                        role_classification: 'cash_and_cash_equivalents',
                      },
                      fields: [
                        { name: 'code', label: 'Code', width: '6rem' },
                        { name: 'name', label: 'Name', width: '15rem', takesTyped: true },
                      ],

                    }} />
          </div>
        </div>

        <div className="table-scroll" data-table-scroll tabIndex={0} role="region" aria-label="Pay run employees">
        <DataTable density="reading" className={`w-full border-collapse text-sm ${detail ? 'min-w-[60rem]' : 'min-w-[36rem]'}`}>
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-4 font-medium">Employee</th>
              <th className="py-2 pr-4 font-medium">Gross this period</th>
              <th className="py-2 pr-4 font-medium">Hours</th>
              {detail && <th className="py-2 pr-4 font-medium">Pensionable</th>}
              {detail && <th className="py-2 pr-4 font-medium">Insurable</th>}
              {detail && <th className="py-2 pr-4 font-medium">Of which bonus</th>}
              <th className="py-2 pr-4 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const person = employees.find((e) => e.id === row.employeeId)
              return (
                <tr key={row.key} className="border-b border-neutral-200 dark:border-neutral-800">
                  <td className="py-2 pr-4">
                    <Picker name={payEmployee(i)} value={row.employeeId} className="mt-1"
                            ariaLabel={`Person on row ${i + 1}`}
                            options={employees
                              .filter((e) => e.id === row.employeeId || !chosen.has(e.id))
                              .map((e) => ({ id: e.id, label: e.name }))}
                            onChange={(id) => setRows((rs) => rs.map((r) =>
                              r.key === row.key ? { ...r, employeeId: id } : r))} />
                    {person && (
                      <span className="mt-1 block text-xs text-neutral-500">{person.frequency}</span>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <input key={`gross-${row.employeeId}`} name={payGross(i)} aria-label={`Gross on row ${i + 1}`} type="text" inputMode="decimal"
                           defaultValue={initial?.rows.find((r) => r.employeeId === row.employeeId)?.gross ?? ''} className={input} />
                  </td>
                  <td className="py-2 pr-4">
                    <input key={`hours-${row.employeeId}`} name={payHours(i)} aria-label={`Hours on row ${i + 1}`} type="text" inputMode="decimal"
                           defaultValue={initial?.rows.find((r) => r.employeeId === row.employeeId)?.hours ?? ''} className={input} />
                  </td>
                  {detail && (
                    <td className="py-2 pr-4">
                      <input key={`pensionable-${row.employeeId}`} name={payPensionable(i)} aria-label={`Pensionable earnings on row ${i + 1}`} type="text" inputMode="decimal"
                             defaultValue={initial?.rows.find((r) => r.employeeId === row.employeeId)?.pensionable ?? ''} className={input} />
                    </td>
                  )}
                  {detail && (
                    <td className="py-2 pr-4">
                      <input key={`insurable-${row.employeeId}`} name={payInsurable(i)} aria-label={`Insurable earnings on row ${i + 1}`} type="text" inputMode="decimal"
                             defaultValue={initial?.rows.find((r) => r.employeeId === row.employeeId)?.insurable ?? ''} className={input} />
                    </td>
                  )}
                  {detail && (
                    <td className="py-2 pr-4">
                      <input key={`bonus-${row.employeeId}`} name={payBonus(i)} aria-label={`Bonus on row ${i + 1}`} type="text" inputMode="decimal"
                             defaultValue={initial?.rows.find((r) => r.employeeId === row.employeeId)?.bonus ?? ''} className={input} />
                    </td>
                  )}
                  <td className="py-2 pr-4 text-right">
                    <button type="button" className="text-xs text-neutral-500 hover:underline"
                            onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}>
                      remove
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </DataTable>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          <button type="button" className="text-neutral-500 hover:underline"
                  onClick={() => setRows((rs) => [...rs, { key: nextKey.current++, employeeId: '' }])}>
            + another row
          </button>
          <label className="flex items-center gap-2 text-neutral-500">
            <input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} />
            Set pensionable, insurable and bonus separately
          </label>
        </div>

        <div className="form-actions">
        <button type="submit" disabled={pending}
                className={BUTTON}>
          {pending ? 'Posting…' : 'Compute and post'}
        </button>
        </div>
      </form>
    </>
  )
}
