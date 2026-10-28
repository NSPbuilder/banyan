'use client'

import { DataTable } from '@/components/Table'

import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { OPENING_FIELDS as F, amountFor } from '@/lib/forms'
import type { OpeningRecord } from '@/lib/opening'
import { DateInput } from '@/components/DateInput'
import { Picker } from '@/components/Picker'
import { BUTTON_WIDE, FIELD } from '@/lib/ui'

export type OpeningAccount = {
  id: string
  code: string
  name: string
  account_type: string
  normal_balance: string
}

/**
 * Entering the closing figures from whatever came before.
 *
 * Signed, in one column, with the normal side named against each account — not
 * a debit column and a credit column. The rest of this system stores one signed
 * amount and shows debit and credit as generated views of it, and a screen that
 * asked for two columns here would be a second convention for the same thing,
 * in the one place where getting it backwards is least recoverable.
 */
export function OpeningScreen({
  ledgerId, entityName, accounts, existing, defaultDate, action, newAccount,
}: {
  ledgerId: string
  entityName: string
  accounts: OpeningAccount[]
  existing: OpeningRecord | null
  defaultDate: string
  action: FormAction
  /**
   * The door that makes an account, for the balancing picker. Opening figures
   * usually need an equity account that no chart starts with — "Opening
   * balance equity" — and sending the person to the chart mid-way through
   * typing a trial balance loses the figures they have typed.
   */
  newAccount?: FormAction
}) {
  if (existing) {
    return (
      <section className="mt-6 rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <p>
          These books opened on <strong>{existing.entry_date}</strong> with{' '}
          <Link href={`/ledger/${ledgerId}/entries/${existing.id}`} className="underline">
            {existing.entry_no}
          </Link>{' '}
          — {existing.lines} lines.
        </p>
        <p className="mt-2 text-neutral-500">
          There is only ever one. To change it, reverse that entry and enter the figures again —
          the same way anything posted is corrected here.
        </p>
      </section>
    )
  }

  if (accounts.length === 0) {
    return (
      <p className="mt-6 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
        {entityName} has no accounts to open yet. Build the chart of accounts first.
      </p>
    )
  }

  return (
    <ActionForm
      action={action}
      submit="Enter the opening balances"
      working="Entering…"
      className="mt-6"
      buttonClassName={`mt-4 ${BUTTON_WIDE}`}
    >
      <input type="hidden" name={F.ledgerId} value={ledgerId} />

      <div className="flex flex-wrap items-end gap-4">
        <label className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          <span className="block">The day the books start</span>
          <DateInput name={F.entryDate} required defaultValue={defaultDate}
                 className={`mt-1 ${FIELD}`} />
        </label>
        <label className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          <span className="block">Describe it</span>
          <input name={F.description} defaultValue="Opening balances"
                 className={`mt-1 w-64 ${FIELD}`} />
        </label>
      </div>

      <DataTable density="reading" className="mt-5 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
            <th className="py-2 pr-3 font-medium">Account</th>
            <th className="py-2 pr-3 font-medium">Normally</th>
            <th className="py-2 font-medium">Balance</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id} className="border-b border-neutral-100 dark:border-neutral-800">
              <td className="py-1.5 pr-3">
                <span className="font-mono text-xs text-neutral-500">{a.code}</span>{' '}
                {a.name}
              </td>
              <td className="py-1.5 pr-3 text-xs text-neutral-500">
                {a.normal_balance === 'debit' ? 'positive' : 'negative'}
              </td>
              <td className="py-1.5">
                <label className="sr-only" htmlFor={amountFor(a.id)}>
                  Opening balance for {a.code} {a.name}
                </label>
                <input id={amountFor(a.id)} name={amountFor(a.id)} inputMode="decimal"
                       className={`w-36 text-right font-mono ${FIELD}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>

      <div className="mt-5 rounded border border-neutral-200 p-4 dark:border-neutral-800">
        <label className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          <span className="block">If the figures do not balance, the difference goes here</span>
          <Picker name={F.balancingAccountId} className="mt-1"
                  ariaLabel="Where the difference goes"
                  options={accounts.map((a) => ({ id: a.id, label: `${a.code} — ${a.name}` }))}
                  create={newAccount ? {
                    title: 'New account',
                    action: newAccount,
                    hidden: { ledgerId },
                    fields: [
                      { name: 'code', label: 'Code', width: '6rem' },
                      { name: 'name', label: 'Name', width: '14rem', takesTyped: true },
                      { name: 'accountType', label: 'Type', width: '9rem', options: [
                        { value: 'equity', label: 'Equity' },
                        { value: 'asset', label: 'Asset' },
                        { value: 'liability', label: 'Liability' },
                        { value: 'revenue', label: 'Revenue' },
                        { value: 'expense', label: 'Expense' },
                      ] },
                    ],

                  } : undefined} />
        </label>

      </div>

      {/* The sign convention is the one thing here that cannot be guessed. */}

    </ActionForm>
  )
}
