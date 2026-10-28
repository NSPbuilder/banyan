'use client'

import { useState, useSyncExternalStore } from 'react'
import { useActionForm } from '@/components/ActionForm'
import { BUTTON, CARD, DANGER, QUIET, REFUSAL } from '@/lib/ui'

type State = { active: boolean; secret?: string; error?: string }
type Action = (previous: State, formData: FormData) => Promise<State>
type Company = { id: string; name: string; active: boolean }
const noOriginChange = () => () => {}

function CompanyAccess({ company, email, origin, action }: {
  company: Company; email: string; origin: string; action: Action
}) {
  const { state, pending, formProps } = useActionForm(action, {
    initialState: { active: company.active },
  })
  const [copied, setCopied] = useState<'link' | 'password' | null>(null)
  const url = `${origin}/dav/${company.id}/`
  const copy = async (value: string, which: 'link' | 'password') => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(which)
    } catch { setCopied(null) }
  }

  return (
    <div className="border-t border-neutral-200 py-3 first:border-t-0 dark:border-neutral-800">
      <h3 className="font-medium">{company.name}</h3>
      <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-neutral-500"
             htmlFor={`dav-${company.id}`}>WebDAV address</label>
      <div className="mt-1 flex flex-wrap gap-2">
        <input id={`dav-${company.id}`} value={url} readOnly
               className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950" />
        <button type="button" className={QUIET} onClick={() => copy(url, 'link')}>Copy link</button>
      </div>
      {copied === 'link' && <p role="status" className="mt-1 text-xs text-emerald-700">Link copied.</p>}
      <p className="mt-2 text-xs text-neutral-500">Username: <span className="font-mono">{email}</span></p>

      <form {...formProps} className="mt-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="entityId" value={company.id} />
        <button type="submit" name="intent" value="rotate" disabled={pending}
                className={state.active ? QUIET : BUTTON}>
          {pending ? 'Working…' : state.active ? 'Replace access password' : 'Create access password'}
        </button>
        {state.active && (
          <button type="submit" name="intent" value="revoke" disabled={pending} className={DANGER}>
            Revoke access
          </button>
        )}
      </form>
      {state.error && <p role="alert" className={`mt-3 ${REFUSAL}`}>{state.error}</p>}
      {state.secret && (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
          <p className="font-medium">Save this password now. It is shown only once.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input aria-label={`${company.name} WebDAV password`} value={state.secret} readOnly
                   className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-2 py-1.5 font-mono text-xs dark:border-amber-900 dark:bg-neutral-900" />
            <button type="button" className={QUIET}
                    onClick={() => copy(state.secret!, 'password')}>Copy password</button>
          </div>
          {copied === 'password' && <p role="status" className="mt-1 text-xs text-emerald-700">Password copied.</p>}
        </div>
      )}
    </div>
  )
}

export function WebDavSettings({ companies, email, action }: {
  companies: Company[]; email: string; action: Action
}) {
  const origin = useSyncExternalStore(noOriginChange, () => window.location.origin, () => '')

  return (
    <section className={`mt-4 ${CARD}`}>
      <h2 className="text-base font-semibold">WebDAV access</h2>

      <div className="mt-3">
        {companies.length ? companies.map((company) => (
          <CompanyAccess key={company.id} company={company} email={email}
                         origin={origin} action={action} />
        )) : <p className="text-sm text-neutral-500">No companies with attachment access.</p>}
      </div>
    </section>
  )
}
