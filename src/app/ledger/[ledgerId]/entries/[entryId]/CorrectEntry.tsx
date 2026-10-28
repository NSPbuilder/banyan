'use client'

import { EditLease } from '@/components/EditLease'
import { useState } from 'react'
import { useActionForm } from '@/components/ActionForm'
import { reverseEntryAction } from '@/app/actions'
import { EntryForm, type AccountOption, type LineDraft, type PartyOption } from '../EntryForm'
import { DateInput } from '@/components/DateInput'
import { BUTTON, FIELD, REFUSAL } from '@/lib/ui'

/**
 * A posted entry is never edited. Correcting one reverses it and posts a
 * replacement, in a single transaction — if the replacement is refused, the
 * reversal goes with it, so the books are never left with an entry cancelled
 * and nothing standing in its place.
 */
export function CorrectEntry({
  ledgerId, entryId, entryNo, accounts, parties, entryDate, description, documentRef,
  lines, reversedBy, replacedBy, amendable = true, version,
}: {
  ledgerId: string; entryId: string; entryNo: string; version?: string
  accounts: AccountOption[]
  parties?: PartyOption[]; entryDate: string; description: string
  documentRef?: string; lines: LineDraft[]
  reversedBy?: string | null; replacedBy?: string | null
  /**
   * False for a pay run's entry: its stubs are the record and `amendEntry`
   * refuses it (PAYROLL_ENTRY), so the door is not offered. Reversing stays —
   * that IS how a run is corrected: reverse it, run it again.
   */
  amendable?: boolean
}) {
  const [mode, setMode] = useState<'none' | 'amend' | 'reverse'>('none')
  const { state: rev, pending: reversing, formProps: reverseActionProps } = useActionForm(reverseEntryAction)

  if (reversedBy) {
    return (
      <p className="mt-4 rounded border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900">
        This entry was reversed by <span className="font-mono">{reversedBy}</span>
        {replacedBy && <> and replaced by <span className="font-mono">{replacedBy}</span></>}.
        Both remain in the ledger — nothing is ever removed.
      </p>
    )
  }

  if (mode === 'none') {
    return (
      <div className="mt-4 flex items-center gap-4 text-sm">
        {amendable ? (
          <button onClick={() => setMode('amend')} className="text-neutral-700 hover:underline dark:text-neutral-300">
            Correct this entry
          </button>
        ) : (
          <span className="text-xs text-neutral-500">
            A pay run is corrected by reversing it and running it again — its stubs follow the run.
          </span>
        )}
        <button onClick={() => setMode('reverse')} className="text-neutral-500 hover:underline">
          Reverse it without replacing
        </button>
      </div>
    )
  }

  if (mode === 'reverse') {
    return (
      <form {...reverseActionProps} className="mt-4 rounded border border-neutral-300 p-4 dark:border-neutral-700">
        <input type="hidden" name="ledgerId" value={ledgerId} />
        <input type="hidden" name="entryId" value={entryId} />
        <EditLease passive resource={{ledgerId,type:'entry',id:entryId}} version={version ?? ''} />
        <h2 className="text-sm font-medium">Reverse {entryNo}</h2>

        {rev.error && (
          <p role="alert" className={`mt-3 ${REFUSAL}`}>
            {rev.error}
          </p>
        )}
        {rev.ok && (
          <p role="status" className="mt-3 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
            {rev.ok}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="reversalDate" className="block text-xs font-medium uppercase tracking-wide text-neutral-500">
              Reversal date
            </label>
            <DateInput id="reversalDate" name="reversalDate" required defaultValue={entryDate}
                   className={`mt-1 ${FIELD}`} />
          </div>
          <div className="flex-1">
            <label htmlFor="reason" className="block text-xs font-medium uppercase tracking-wide text-neutral-500">
              Reason
            </label>
            <input id="reason" name="reason" required
                   className={`mt-1 w-full ${FIELD}`} />
          </div>
          <button type="submit" disabled={reversing}
                  className={BUTTON}>
            {reversing ? 'Reversing…' : 'Reverse'}
          </button>
          <button type="button" onClick={() => setMode('none')} className="text-sm text-neutral-500 hover:underline">
            Cancel
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="mt-4 rounded border border-neutral-300 p-4 dark:border-neutral-700">
      <h2 className="text-sm font-medium">Correct {entryNo}</h2>
      <p className="mt-1 text-sm text-neutral-500">
        Change what is wrong and save. {entryNo} will be reversed and a new entry posted in its
        place — all three stay in the ledger, and the reversal only happens if the replacement is
        accepted.
      </p>
      <div className="mt-3">
        <EntryForm ledgerId={ledgerId} entryId={entryId} version={version} accounts={accounts} parties={parties}
                   initialDate={entryDate} initialDescription={description}
                   initialDocumentRef={documentRef}
                   initialLines={lines} mode="amend" onCancel={() => setMode('none')} />
      </div>
    </div>
  )
}
