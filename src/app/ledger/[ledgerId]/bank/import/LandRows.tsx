'use client'

import { formatNumber } from '@/lib/numbers'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { BANK_FIELDS as F, rowsToField, type WireRow } from '@/lib/bank-wire'
import { Picker } from '@/components/Picker'
import { BUTTON_WIDE } from '@/lib/ui'

export type ImportableAccount = {
  currency?:string
  id: string
  code: string
  name: string
  account_type: string
  /** How many bank rows this account already holds. */
  landed: string
}

/**
 * Saving the read rows against an account.
 *
 * The rows travel as a hidden field rather than the file: the file is never
 * uploaded, and what crosses is what was on screen — the dates and amounts the
 * mapping produced, which is the thing that was actually checked.
 *
 * Nothing about which rows are duplicates is decided here. The same statement
 * can be sent twice and the second time saves nothing, because that rule lives
 * in a unique constraint in the database and not in a screen that could forget
 * to apply it.
 */
export function LandRows({
  ledgerId, accounts, rows, fileName, action, newAccount,currency='CAD',
}: {
  currency?:string
  ledgerId: string
  accounts: ImportableAccount[]
  rows: WireRow[]
  fileName: string
  action: FormAction
  /** The door that makes the bank account this statement belongs to. */
  newAccount?: FormAction
}) {
  if (accounts.length === 0) {
    return (
      <p className="mt-6 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
        This company has no account a statement could belong to yet. Add the bank account to
        the chart first.
      </p>
    )
  }

  return (
    <section className="mt-8 border-t border-neutral-200 pt-6 dark:border-neutral-800">
      <h2 className="text-sm font-medium">Save these rows</h2>

      <ActionForm
        action={action}
        submit={`Save ${formatNumber(rows.length)} row${rows.length === 1 ? '' : 's'}`}
        working="Saving…"
        className="mt-4 flex flex-wrap items-end gap-3"
        buttonClassName={BUTTON_WIDE}
      >
        <input type="hidden" name={F.ledgerId} value={ledgerId} />
        <input type="hidden" name="bankCurrency" value={currency} />
        <input type="hidden" name={F.sourceFile} value={fileName} />
        <input type="hidden" name={F.rows} value={rowsToField(rows)} />

        <div>
          <span className="block text-xs font-medium uppercase tracking-wide text-neutral-500">
            Which account
          </span>
          <Picker name={F.accountId} required className="mt-1 w-96"
                  ariaLabel="Which account"
                  options={accounts.map((a) => ({
                    id: a.id,
                    label: `${a.code} — ${a.name}`,
                    hint: a.landed !== '0' ? `${a.landed} already` : undefined,
                  }))}
                  create={newAccount ? {
                    title: 'New bank account',
                    action: newAccount,
                    hidden: {
                      ledgerId,
                      accountType: 'asset',
                      role_classification: 'cash_and_cash_equivalents',
                    },
                    fields: [
                      { name: 'code', label: 'Code', width: '6rem' },
                      { name: 'name', label: 'Name', width: '15rem', takesTyped: true },
                    ],

                  } : undefined} />
        </div>
      </ActionForm>
    </section>
  )
}
