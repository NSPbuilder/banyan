'use client'

import { formatNumber } from '@/lib/numbers'
import { useState } from 'react'
import { useActionForm, useFades } from '@/components/ActionForm'
import { setAccountRolesAction } from '@/app/actions'
import { editableRoles, type TaggableRole } from '@/lib/forms'
import { BUTTON, REFUSAL_QUIET } from '@/lib/ui'
import {MasterEdit,MasterProof} from '@/components/MasterEdit'

const FAMILY_LABEL: Record<string, string> = {
  classification: 'Statement line',
  nature: 'Expense by nature',
  function: 'Expense by function',
  cash_flow: 'Cash flow activity',
}

export function RoleEditor({
  ledgerId, accountId, accountType, current, currentLabels, roles,version,
}: {
  ledgerId: string; accountId: string; accountType: string
  current: string[]; currentLabels: string[]; roles: TaggableRole[]
  version?:string
}) {
  const [open, setOpen] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const { state: state, pending: pending, formProps: actionProps } = useActionForm(setAccountRolesAction)

  // Only what this account type can legitimately carry. The database refuses the
  // rest, so offering them would just teach the owner to expect a rejection.
  // Every family must be rendered: saving replaces an account's roles wholesale,
  // so a family the form does not show is a family the form deletes.
  const { eligible, families } = editableRoles(roles, accountType)
  // "saved" for a moment, not for the rest of the visit.
  const savedShown = useFades(state.ok ? state : null)

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="w-full text-left text-xs hover:underline">
        {currentLabels.length > 0
          ? <span className="text-neutral-600 dark:text-neutral-400">{currentLabels.join(' · ')}</span>
          : <span className="text-amber-700 dark:text-amber-400">No role — appears on no statement</span>}
        {savedShown && <span className="ml-2 text-emerald-700 dark:text-emerald-400">saved</span>}
      </button>
    )
  }

  return (
    <MasterEdit resource={{ledgerId,type:'account',id:accountId}} version={version??''}>
    <form {...actionProps} className="rounded border border-neutral-300 p-3 dark:border-neutral-700">
      <MasterProof/>
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="ledgerId" value={ledgerId} />

      {state.error && (
        <p role="alert" className={`mb-2 ${REFUSAL_QUIET}`}>
          {state.error}
        </p>
      )}

      {families.map((family) => {
        const inFamily = eligible.filter(
          (r) => r.family === family && (showAll || r.isCore || current.includes(r.code)))
        if (inFamily.length === 0) return null
        const selected = current.find((c) => eligible.find((r) => r.code === c)?.family === family)
        return (
          <fieldset key={family} className="mb-3">
            <legend className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
              {FAMILY_LABEL[family] ?? family}
            </legend>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              <label className="text-xs text-neutral-500">
                <input type="radio" name={`role_${family}`} value="" defaultChecked={!selected}
                       className="mr-1 align-middle" />
                none
              </label>
              {inFamily.map((r) => (
                <label key={r.code} className="text-xs">
                  <input type="radio" name={`role_${family}`} value={r.code}
                         defaultChecked={selected === r.code} className="mr-1 align-middle" />
                  {r.label}
                </label>
              ))}
            </div>
          </fieldset>
        )
      })}

      <div className="mt-2 flex items-center gap-3">
        <button type="submit" disabled={pending}
                className={BUTTON}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-neutral-500 hover:underline">
          Close
        </button>
        <button type="button" onClick={() => setShowAll((v) => !v)} className="text-xs text-neutral-500 hover:underline">
          {showAll ? 'Common roles only' : `Show all ${formatNumber(eligible.length)} roles`}
        </button>
      </div>
    </form>
    </MasterEdit>
  )
}
