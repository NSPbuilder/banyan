'use client'

import { EditLease } from '@/components/EditLease'
import { useActionForm } from '@/components/ActionForm'
import { discardDraftAction } from '@/app/actions'

export function DiscardButton({ ledgerId, entryId, version }: { ledgerId: string; entryId: string; version?:string }) {
  const { state: state, pending: pending, formProps: actionProps } = useActionForm(discardDraftAction)
  return (
    <form {...actionProps}>
      <input type="hidden" name="ledgerId" value={ledgerId} />
      <input type="hidden" name="entryId" value={entryId} />
      <EditLease passive resource={{ledgerId,type:'entry',id:entryId}} version={version ?? ''}/>
      <button type="submit" disabled={pending}
              className="text-sm text-neutral-500 hover:text-red-700 hover:underline disabled:opacity-50 dark:hover:text-red-400">
        {pending ? 'Discarding…' : 'Discard draft'}
      </button>
      {state.error && <span className="ml-2 text-xs text-red-700 dark:text-red-400">{state.error}</span>}
    </form>
  )
}
