'use client'

import Link from 'next/link'
import { useActionForm } from '@/components/ActionForm'
import { importAccountsAction } from '@/app/actions'
import { BUTTON, REFUSAL } from '@/lib/ui'

export function ImportForm({ ledgerId, entityId, prefill }: {
  ledgerId: string; entityId: string
  /** The starter chart less whatever this company already has (see the page). */
  prefill: string
}) {
  const { state: state, pending: pending, formProps: actionProps } = useActionForm(importAccountsAction)

  return (
    <form {...actionProps} className="mt-6">
      <input type="hidden" name="entityId" value={entityId} />
      <input type="hidden" name="ledgerId" value={ledgerId} />

      {state.error && (
        <p role="alert" className={`mb-3 ${REFUSAL}`}>
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="mb-3 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          {state.ok}{' '}
          <Link href={`/ledger/${ledgerId}/accounts`} className="underline">View the chart</Link>
        </p>
      )}

      <label htmlFor="csv" className="block text-xs font-medium uppercase tracking-wide text-neutral-500">
        Rows
      </label>
      <textarea id="csv" name="csv" rows={14} required defaultValue={prefill}
                spellCheck={false}
                className="mt-1 w-full rounded border border-neutral-300 bg-transparent p-3 font-mono text-xs dark:border-neutral-700" />

      <div className="mt-3 flex items-center gap-3">
        <button type="submit" disabled={pending}
                className={BUTTON}>
          {pending ? 'Importing…' : 'Import'}
        </button>
        <Link href={`/ledger/${ledgerId}/accounts`} className="text-sm text-neutral-500 hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  )
}
