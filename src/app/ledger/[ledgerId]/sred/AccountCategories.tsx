'use client'

import { DataTable } from '@/components/Table'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { SRED_FIELDS as F } from '@/lib/sred-fields'
import { CARD, FIELD, QUIET } from '@/lib/ui'

export type CategoryRow = { id: string; code: string; name: string; account_type: string; category: string | null }

/** The T661 lines an account can feed; salary is claimed through the pay stub. */
const LINES: Array<[string, string]> = [
  ['', 'Not an SR&ED account'],
  ['materials', 'Materials consumed — line 320'],
  ['contract', 'Contracts — line 340'],
  ['third_party', 'Third-party payments — line 345'],
  ['overhead', 'Overhead — line 360, traditional method only'],
  ['capital', 'Capital — listed, not claimed'],
]

/**
 * Which T661 line each account's costs feed. It was a box on the account form
 * (0071) and moved here with the tag itself (0156): SR&ED's question, asked on
 * SR&ED's screen, so the chart of accounts does not have to know about it.
 */
export function AccountCategories({ ledgerId, rows, action }: {
  ledgerId: string; rows: CategoryRow[]; action: FormAction
}) {
  const TD = 'py-1.5 pr-3 text-xs'
  return (
    <section className={`mt-10 ${CARD}`}>
      <h2 className="font-serif text-lg font-semibold">Account categories</h2>
      <p className="mt-1 max-w-2xl text-sm text-neutral-500">
        Which T661 line an account&rsquo;s costs feed. A hint for the allocation screen: tagged
        accounts sort first and arrive with their line chosen. Nothing is claimed by the tag.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500">No expense or asset accounts to tag yet.</p>
      ) : (
        <DataTable density="reading" className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-2 pr-3 font-medium">Account</th>
              <th className="py-2 pr-3 font-medium">Type</th>
              <th className="py-2 font-medium">T661 line</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} data-account={r.id} className="border-b border-neutral-100 dark:border-neutral-900">
                <td className={TD}><span className="font-mono">{r.code}</span> {r.name}</td>
                <td className={`${TD} text-neutral-500`}>{r.account_type}</td>
                <td className="py-1.5 text-xs">
                  <ActionForm action={action} submit="Save" working="…"
                              className="flex flex-wrap items-center gap-2" buttonClassName={QUIET}>
                    <input type="hidden" name={F.ledgerId} value={ledgerId} />
                    <input type="hidden" name={F.categoryAccountId} value={r.id} />
                    <select name={F.accountCategory} defaultValue={r.category ?? ''}
                            aria-label={`T661 line for ${r.code} ${r.name}`}
                            className={`${FIELD} py-1 text-xs`}>
                      {LINES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </section>
  )
}
