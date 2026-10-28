'use client'

import { useState } from 'react'
import { AccountForm, type ParentChoice } from '../AccountForm'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import type { TaggableRole } from '@/lib/forms'
import { QUIET } from '@/lib/ui'
import {MasterEdit,MasterProof} from '@/components/MasterEdit'

/**
 * Renaming an account, and the rest of what can still be changed about it.
 *
 * `AccountForm` has taken an `existing` account since it was written — it
 * switches to `updateAccountAction`, freezes the type once anything is posted,
 * and keeps the roles. NOTHING EVER PASSED IT. The chart offered the role
 * editor and no other way in, so an account's name was final from the moment
 * it was made (owner, 2026-09-07: 「account创建之后就不能改名字了」).
 *
 * It belongs here rather than on the chart: this is the page about one
 * account, and the chart is a list of many.
 */
export function EditAccount({
  ledgerId, entityId, roles, accounts, account, setActive, remove, version,
}: {
  ledgerId: string
  version:string
  entityId: string
  roles: TaggableRole[]
  /** The company's chart, for the "sits under" list (0078). */
  accounts: ParentChoice[]
  account: {
    id: string; code: string; name: string; accountType: string
    normalBalance: string; isPostable: boolean; roles: string[]; lineCount: number
    parentCode: string | null
    isActive: boolean
    /** What deleting would run into; an account in use offers Deactivate only. */
    inUse: boolean
  }
  /** Retire it or bring it back, and delete one nothing has used (0084). */
  setActive: FormAction
  remove: FormAction
}) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={QUIET}>
        Edit this account
      </button>
    )
  }
  return (
    <MasterEdit resource={{ledgerId,type:'account',id:account.id}} version={version}>
    <div className="mt-2 w-full">
      <AccountForm ledgerId={ledgerId} entityId={entityId} roles={roles} accounts={accounts}
                   existing={account} onDone={() => setOpen(false)} />
      {/* Retiring and removing, beside the edit they belong with (owner,
          2026-09-16: 「所有的紀錄儘量都可以編輯刪除」). An account with history
          is deactivated — 0008 keeps it — and only one nothing points at is
          offered Delete. */}
      <div className="mt-4 flex flex-wrap items-center gap-4" data-account-retire={account.id}>
        <ActionForm action={setActive} submit={account.isActive ? 'Deactivate' : 'Reactivate'} working="…"
                    onSucceeded={() => setOpen(false)} className="inline" buttonClassName={QUIET}>
          <input type="hidden" name="ledgerId" value={ledgerId} />
          <input type="hidden" name="accountId" value={account.id} />
          <MasterProof/>
          <input type="hidden" name="active" value={account.isActive ? 'no' : 'yes'} />
        </ActionForm>
        {!account.inUse && (
          <ActionForm action={remove} submit="Delete this account" working="Deleting…"
                      className="inline" buttonClassName={`${QUIET} text-red-700 dark:text-red-400`}>
            <input type="hidden" name="ledgerId" value={ledgerId} />
            <input type="hidden" name="accountId" value={account.id} />
            <MasterProof/>
          </ActionForm>
        )}
        <button type="button" onClick={() => setOpen(false)}
                className="text-xs text-neutral-500 hover:underline">
          Cancel
        </button>
      </div>
    </div>
    </MasterEdit>
  )
}
