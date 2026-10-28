'use client'
import type { ReactNode } from 'react'
import { useActionForm,FormError,type FormAction } from './ActionForm'
import { SUCCESS } from '@/lib/ui'

/** P2 forms supply their own submitters; the established form hook owns the
 * dispatch, refusal preservation and document-version event. */
export function AutomationForm({action,children,className}:{action:FormAction;children:ReactNode;className?:string}) {
  const {state,pending,formProps}=useActionForm(action,{requestError:'Connection lost. Your input is preserved. Check the recorded result before submitting again.'})
  return <form {...formProps} className={className}>
    <FormError state={state}/>{state.ok&&<p role="status" className={`${SUCCESS} mb-3`}>{state.ok}</p>}
    <fieldset disabled={pending} className="min-w-0 border-0 p-0">{children}</fieldset>
    {pending&&<p role="status" className="mt-2 text-sm">Saving…</p>}
  </form>
}
