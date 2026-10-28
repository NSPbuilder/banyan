'use client'

import { DataTable } from '@/components/Table'

import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { MATCH_FIELDS as F, STATEMENT_FILE_FIELDS as S, STATEMENT_FILE_ACCEPT } from '@/lib/forms'
import { nativeMoney,nativeInput } from '@/lib/fx-money'
import type { StatementRecord } from '@/lib/bank'
import { DateInput } from '@/components/DateInput'
import { Floating } from '@/components/Floating'
import { BUTTON, FIELD, QUIET } from '@/lib/ui'

/**
 * The statements the bank has asserted, and the report against the chosen one.
 *
 * Only the assertion is typed in — a date and the printed ending balance.
 * Everything on the report is derived at render time from imported rows and
 * the books, so the report cannot go stale and cannot be edited into
 * agreement. A statement typed wrong is deleted and re-entered; there is
 * deliberately no edit.
 */
export function StatementSection({
  ledgerId, accountId, statements, shown, saveAction, deleteAction,currency='CAD',
}: {
  currency?:string
  ledgerId: string
  accountId: string
  statements: StatementRecord[]
  /** The statement date the panel below is showing, if any. */
  shown: string | null
  saveAction: FormAction
  deleteAction: FormAction
}) {
  const formatMoney=nativeMoney(currency),moneyInput=(n:bigint)=>nativeInput(n,currency)
  return (
    <section className="mt-6 rounded border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        Bank statements
      </p>

      {/* A floating form, not two boxes on the page (owner, 2026-09-16). */}
      <div className="mt-3">
        <Floating label="Record a statement" title="Record a bank statement" buttonClassName={BUTTON}>

          <ActionForm action={saveAction} submit="Start reconciling" working="Recording…"
                      className="mt-3 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
            <input type="hidden" name={F.ledgerId} value={ledgerId} />
            <input type="hidden" name={F.accountId} value={accountId} />
            <label className="text-xs text-neutral-500">
              <span className="block">Statement date</span>
              <DateInput name={F.statementDate} required
                     className={`mt-1 ${FIELD}`} />
            </label>
            <label className="text-xs text-neutral-500">
              <span className="block">Ending balance, as printed</span>
              <input type="text" inputMode="decimal" name={F.endingBalance} required className={`mt-1 w-36 ${FIELD}`} />
            </label>
            <label className="min-w-0 text-xs text-neutral-500">
              <span className="block">Statement file (optional)</span>
              <input type="file" name={S.file} accept={STATEMENT_FILE_ACCEPT}
                     className={`mt-1 w-full max-w-64 ${FIELD}`} />
              <span className="mt-1 block">PDF or image · up to 25 MB</span>
            </label>
          </ActionForm>
        </Floating>
      </div>

      {statements.length > 0 && (
        <DataTable density="reading" className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
              <th className="py-1.5 pr-3 font-medium">Date</th>
              <th className="py-1.5 pr-3 text-right font-medium">Ending balance</th>
              <th className="py-1.5 pr-3 font-medium">Status</th>
              <th className="py-1.5 font-medium" />
            </tr>
          </thead>
          <tbody>
            {statements.map((st) => (
              <tr key={st.id} className="border-b border-neutral-100 dark:border-neutral-900">
                <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-xs">
                  {st.statement_date}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono tabular-nums">
                  {formatMoney(st.ending_balance)}
                </td>
                <td className="whitespace-nowrap py-1.5 pr-3 text-xs">
                  {st.reconciled_at
                    ? <span className="rounded bg-emerald-100 px-2 py-0.5 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">finished</span>
                    : <span className="text-neutral-500">open</span>}
                </td>
                <td className="py-1.5">
                  <span className="flex items-center justify-end gap-3">
                    <Floating label="Copy" title={`Copy statement ${st.statement_date}`} buttonClassName={QUIET}>
                      <p className="text-xs text-neutral-500">Enter the new statement date before saving.</p>
                      <ActionForm action={saveAction} submit="Record the copy" working="Recording…"
                                  className="mt-3 flex flex-wrap items-end gap-3" buttonClassName={BUTTON}>
                        <input type="hidden" name={F.ledgerId} value={ledgerId} />
                        <input type="hidden" name={F.accountId} value={accountId} />
                        <label className="text-xs text-neutral-500">Statement date
                          <DateInput name={F.statementDate} required className={`mt-1 ${FIELD}`} />
                        </label>
                        <label className="text-xs text-neutral-500">Ending balance
                          <input type="text" inputMode="decimal" name={F.endingBalance} required
                                 defaultValue={moneyInput(BigInt(st.ending_balance))}
                                 className={`mt-1 w-36 ${FIELD}`} />
                        </label>
                      </ActionForm>
                    </Floating>
                    {shown === st.statement_date ? (
                      <span className="text-xs text-neutral-400">shown below</span>
                    ) : (
                      <Link href={`/ledger/${ledgerId}/bank/${accountId}/reconcile?st=${st.statement_date}`}
                            className="text-xs text-neutral-500 hover:underline">
                        Open
                      </Link>
                    )}
                    {/* A finished statement is frozen (0055); the button would
                        only be refused, so it is not offered. */}
                    {!st.reconciled_at && (
                      <ActionForm action={deleteAction} submit="Delete" working="…" buttonClassName={QUIET}>
                        <input type="hidden" name={F.ledgerId} value={ledgerId} />
                        <input type="hidden" name={F.accountId} value={accountId} />
                        <input type="hidden" name={F.statementId} value={st.id} />
                      </ActionForm>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

    </section>
  )
}
