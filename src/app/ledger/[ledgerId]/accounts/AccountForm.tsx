'use client'

import { formatNumber } from '@/lib/numbers'
import { useMemo, useState } from 'react'
import { FormError, useActionForm } from '@/components/ActionForm'
import { createAccountAction, updateAccountAction } from '@/app/actions'
import { editableRoles, type TaggableRole } from '@/lib/forms'
import { chartTree, descendantCodes } from '@/lib/chart-tree'
import { BUTTON, FIELD } from '@/lib/ui'
import {MasterProof} from '@/components/MasterEdit'

const field = `mt-1 w-full ${FIELD}`
const label = 'block text-xs font-medium uppercase tracking-wide text-neutral-500'

const TYPES = [
  ['asset', 'Asset', 'debit'], ['liability', 'Liability', 'credit'],
  ['equity', 'Equity', 'credit'], ['revenue', 'Income', 'credit'],
  ['expense', 'Expense', 'debit'],
] as const

/** What the parent list needs to know about each account in the chart. */
export type ParentChoice = {
  id: string; code: string; name: string; account_type: string
  parent_code: string | null; is_active: boolean
}
type AccountInitial = {
  name: string; accountType: string; normalBalance: string; isPostable: boolean
  roles: string[]; parentCode: string | null
}

const FAMILY_LABEL: Record<string, string> = {
  classification: 'Statement line',
  nature: 'Expense by nature',
  function: 'Expense by function',
  cash_flow: 'Cash flow activity',
}

export function AccountForm({
  ledgerId, entityId, roles, accounts = [], existing, initial, onDone,
}: {
  ledgerId: string
  entityId: string
  roles: TaggableRole[]
  /**
   * The company's chart, for the one question this form could not ask before
   * 0078: which account does this one sit under? Defaulted to empty so the
   * screens that render this form with no chart in hand — the first account a
   * company ever has — keep working and simply offer no parent.
   */
  accounts?: ParentChoice[]
  existing?: {
    id: string; code: string; name: string; accountType: string
    normalBalance: string; isPostable: boolean; roles: string[]; lineCount: number
    parentCode: string | null
  }
  initial?: AccountInitial
  onDone?: () => void
}) {
  const source = existing ?? initial
  const [type, setType] = useState(source?.accountType ?? 'asset')
  const [showAll, setShowAll] = useState(Boolean(initial?.roles.some((code) => roles.some((r) => r.code === code && !r.isCore))))
  const { state: state, pending: pending, formProps: actionProps } = useActionForm(existing ? updateAccountAction : createAccountAction)

  const normal = TYPES.find(([t]) => t === type)?.[2] ?? 'debit'
  const isContra = source ? source.normalBalance !== normal : false
  const { eligible, families } = editableRoles(roles, type)
  const frozen = (existing?.lineCount ?? 0) > 0

  /**
   * Which accounts this one may sit under, drawn as the tree they form.
   *
   * Same type only, because a sub-account is the same kind of thing as its
   * parent (0078), and the list follows the TYPE SELECT above rather than the
   * saved type — changing the type re-asks the question honestly instead of
   * leaving a parent behind that the save would refuse. Itself and everything
   * already under it are left out: 0078 refuses both, and a choice that will be
   * refused should not be offered.
   */
  const parentChoices = useMemo(() => {
    const sameType = accounts.filter((a) => a.account_type === type)
    if (!existing) return chartTree(sameType)
    const banned = new Set([existing.code, ...descendantCodes(accounts, existing.code)])
    return chartTree(sameType.filter((a) => !banned.has(a.code)))
  }, [accounts, type, existing])

  return (
    <form {...actionProps} className="rounded border border-neutral-300 p-4 dark:border-neutral-700">
      <input type="hidden" name="ledgerId" value={ledgerId} />
      {existing&&<MasterProof/>}
      <input type="hidden" name="entityId" value={entityId} />
      {existing && <input type="hidden" name="accountId" value={existing.id} />}

      <FormError state={state} />
      {state.ok && (
        <p role="status" className="mb-3 rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          {state.ok}
        </p>
      )}

      <div className="form-grid">
        <div>
          <label className={label} htmlFor="code">Code</label>
          <input id="code" name="code" required defaultValue={existing?.code} autoComplete="off" className={`${field} font-mono`} />
        </div>
        <div>
          <label className={label} htmlFor="name">Name</label>
          <input id="name" name="name" required defaultValue={source?.name} className={field} />
        </div>
      </div>

      <div className="mt-3 form-grid">
        <div>
          <label className={label} htmlFor="accountType">Type</label>
          <select id="accountType" name="accountType" value={type} disabled={frozen}
                  onChange={(e) => setType(e.target.value)} className={field}>
            {TYPES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="side">Normal balance</label>
          <select id="side" name="side" defaultValue={isContra ? 'contra' : 'normal'}
                  disabled={frozen} className={field}>
            <option value="normal">{normal === 'debit' ? 'Debit' : 'Credit'} — usual for {type}</option>
            <option value="contra">{normal === 'debit' ? 'Credit' : 'Debit'} — contra account</option>
          </select>
        </div>
      </div>

      {frozen && (
        <p className="mt-2 text-xs text-neutral-500">
          Type and normal balance are fixed: this account has {existing!.lineCount} posted line
          {existing!.lineCount === 1 ? '' : 's'}, and changing what it means would rewrite reports
          already filed. Create a new account instead.
        </p>
      )}

      {/*
        * WHERE IT SITS ON THE CHART.
        *
        * Rendered whenever there is a chart to sit in — and always for an
        * existing account, so that `parentCode` is POSTED even when the list
        * is empty. The action reads the field's presence, not its emptiness:
        * a door that skipped it would silently lift an account out of its
        * group (actions.ts).
        */}
      {(parentChoices.length > 0 || existing) && (
        <div className="mt-3">
          <label className={label} htmlFor="parentCode">Sits under</label>
          <select id="parentCode" name="parentCode" defaultValue={source?.parentCode ?? ''}
                  key={type} className={field}>
            <option value="">Nothing — a top-level account</option>
            {parentChoices.map(({ row, depth }) => (
              <option key={row.id} value={row.code}>
                {'\u00a0\u00a0'.repeat(depth)}{row.code} {row.name}
                {!row.is_active ? ' (inactive)' : ''}
              </option>
            ))}
          </select>

        </div>
      )}

      {/* A list and not a tick (owner, 2026-09-16: 「选项统一为下拉菜单」).
          Both answers are then written down: a tick says what it turns ON and
          leaves the usual case unnamed, which is the case almost every account
          is. */}
      <div className="mt-3">
        <label className={label} htmlFor="isPostable">What it holds</label>
        <select id="isPostable" name="isPostable"
                defaultValue={source && !source.isPostable ? 'no' : 'yes'} className={field}>
          <option value="yes">Entries can be posted to it</option>
          <option value="no">Heading only — a total line, nothing posts to it</option>
        </select>
      </div>


      {!existing && (
        <div className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
            Roles — which statement line this lands on
          </p>
          {families.map((family) => {
            const inFamily = eligible.filter((r) => r.family === family && (showAll || r.isCore))
            if (inFamily.length === 0) return null
            return (
              <fieldset key={family} className="mt-3">
                <legend className="text-[10px] uppercase tracking-wide text-neutral-500">
                  {FAMILY_LABEL[family] ?? family}
                </legend>
                {/* One list per family, not a row of radios. Fifty-seven
                    classification roles wrapped across six lines and the
                    chosen one was wherever it happened to land. */}
                <select name={`role_${family}`} defaultValue={initial?.roles.find((code) => eligible.some((r) => r.code === code && r.family === family)) ?? ''} className={field}>
                  <option value="">none</option>
                  {inFamily.map((r) => (
                    <option key={r.code} value={r.code}>{r.label}</option>
                  ))}
                </select>
              </fieldset>
            )
          })}
          <button type="button" onClick={() => setShowAll((v) => !v)}
                  className="mt-2 text-xs text-neutral-500 hover:underline">
            {showAll ? 'Common roles only' : `Show all ${formatNumber(eligible.length)} roles`}
          </button>
        </div>
      )}

      <div className="form-actions flex-wrap items-center">
        <button type="submit" disabled={pending}
                className={BUTTON}>
          {pending ? 'Saving…' : existing ? 'Save' : 'Add account'}
        </button>
        {onDone && (
          <button type="button" onClick={onDone} className="text-sm text-neutral-500 hover:underline">
            Close
          </button>
        )}
      </div>
    </form>
  )
}
