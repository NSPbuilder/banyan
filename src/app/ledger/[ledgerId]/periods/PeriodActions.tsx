'use client'

import Link from 'next/link'
import { useActionForm, type FormAction } from '@/components/ActionForm'
import type { Readiness } from '@/lib/periods'
import { BUTTON, FIELD, FIELD_ALERT, REFUSAL_QUIET } from '@/lib/ui'

/**
 * Closing and reopening a period, on the periods screen.
 *
 * ONE PRESS, not two. The page already chose this period — `?period=<id>` is
 * how it knows which one to run the readiness checks for, and those checks
 * read the whole ledger, which is why they are not run for every row. These
 * components used to start collapsed on top of that, so the person pressed
 * "Close…", got a button that said "Close January", and had to press that
 * before anything appeared (owner, 2026-09-07). The selection IS the first
 * press; there is nothing for a second one to reveal.
 *
 * Backing out is a link rather than local state, for the same reason: the
 * period is chosen in the URL, so un-choosing it belongs there too, and the
 * browser's back button does it as well.
 *
 * The doors arrive as props rather than by import, so `P30` can render these
 * outside a server runtime and read back what one press shows — importing
 * `@/app/actions` pulls in `server-only` (the ActionForm rule).
 */

export function CloseControls({
  ledgerId, periodId, periodName, readiness, action,
}: {
  ledgerId: string; periodId: string; periodName: string; readiness: Readiness[]
  action: FormAction
}) {
  const { state: state, pending: pending, formProps: actionProps } = useActionForm(action)

  if (state.ok) return <span className="text-xs text-emerald-700 dark:text-emerald-400">{state.ok}</span>

  const blocking = readiness.filter((r) => r.severity === 'blocking')
  const warnings = readiness.filter((r) => r.severity === 'warning')

  return (
    <form {...actionProps} className="mt-2 rounded border border-neutral-300 p-3 text-left dark:border-neutral-700">
      <input type="hidden" name="ledgerId" value={ledgerId} />
      <input type="hidden" name="periodId" value={periodId} />

      <p className="text-sm font-medium">Close {periodName}</p>
      <p className="mt-1 text-xs text-neutral-500">
        Nothing can be posted into a closed period, and its dates can no longer be changed.
        It can be reopened, with a reason.
      </p>

      {blocking.length > 0 && (
        <div className={`mt-2 ${REFUSAL_QUIET}`}>
          <p className="font-medium text-red-900 dark:text-red-200">
            This period cannot be closed as things stand.
          </p>
          {blocking.map((r, i) => (
            <p key={i} className="mt-1 text-red-800 dark:text-red-300">
              <span className="font-medium">{r.what}</span>
              {r.scope === 'ledger' && <span className="text-red-700 dark:text-red-400"> (whole ledger)</span>}
              . {r.detail}
            </p>
          ))}
          <label className="mt-2 block text-red-800 dark:text-red-300">
            Close anyway? Say why, and it goes on the record:
            <input name="overrideReason"
                   className={`mt-1 w-full ${FIELD_ALERT}`} />
          </label>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="mt-2 rounded bg-amber-50 p-2 text-xs dark:bg-amber-950">
          {warnings.map((r, i) => (
            <p key={i} className="text-amber-800 dark:text-amber-300">
              <span className="font-medium">{r.what}</span>
              {r.scope === 'ledger' && <span className="text-amber-700 dark:text-amber-400"> (whole ledger)</span>}
              . {r.detail}
            </p>
          ))}
        </div>
      )}
      {readiness.length === 0 && (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
          Nothing outstanding — in this period or anywhere in the ledger.
        </p>
      )}

      {state.error && (
        <p role="alert" className={`mt-2 ${REFUSAL_QUIET}`}>
          {state.error}
        </p>
      )}

      <label className="mt-3 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
        <input type="checkbox" name="lock" value="yes" />
        Lock it — for figures that have been filed with the CRA
      </label>

      <div className="mt-3 flex items-center gap-3">
        <button type="submit" disabled={pending}
                className={BUTTON}>
          {pending ? 'Closing…' : blocking.length > 0 ? 'Close with the reason above' : 'Close'}
        </button>
        <Link href={`/ledger/${ledgerId}/periods`} className="text-xs text-neutral-500 hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  )
}

export function ReopenControls({
  ledgerId, periodId, periodName, status, action,
}: {
  ledgerId: string; periodId: string; periodName: string; status: string
  action: FormAction
}) {
  const { state: state, pending: pending, formProps: actionProps } = useActionForm(action)

  if (state.ok) return <span className="text-xs text-emerald-700 dark:text-emerald-400">{state.ok}</span>

  return (
    <form {...actionProps} className="mt-2 rounded border border-neutral-300 p-3 text-left dark:border-neutral-700">
      <input type="hidden" name="ledgerId" value={ledgerId} />
      <input type="hidden" name="periodId" value={periodId} />
      <p className="text-sm font-medium">Reopen {periodName}</p>
      <p className="mt-1 text-xs text-neutral-500">
        {status === 'locked'
          ? 'This period was locked, which means its figures were filed. Reopen it only if the '
            + 'filing itself is being amended.'
          : 'Figures treated as final become changeable again. The reason is kept on the record.'}
      </p>
      {state.error && (
        <p role="alert" className={`mt-2 ${REFUSAL_QUIET}`}>
          {state.error}
        </p>
      )}
      <input name="reason" aria-label="Reason for reopening" required
             className={`mt-2 w-full ${FIELD}`} />
      <div className="mt-3 flex items-center gap-3">
        <button type="submit" disabled={pending}
                className={BUTTON}>
          {pending ? 'Reopening…' : 'Reopen'}
        </button>
        <Link href={`/ledger/${ledgerId}/periods`} className="text-xs text-neutral-500 hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  )
}

/**
 * Reopening a closed YEAR, from its heading on the periods page. The year's
 * closing entry is reversed — its result goes back into the revenue and
 * expense accounts it came from — and its periods can be closed again. Both
 * entries stay on the record, and so does the reason.
 */
export function ReopenYearControls({
  ledgerId, fiscalYearId, yearName, action,
}: {
  ledgerId: string; fiscalYearId: string; yearName: string
  action: FormAction
}) {
  const { state, pending, formProps: actionProps } = useActionForm(action)

  if (state.ok) return <p role="status" className="mb-3 text-xs text-emerald-700 dark:text-emerald-400">{state.ok}</p>

  return (
    <form {...actionProps} className="mb-3 rounded border border-neutral-300 p-3 text-left dark:border-neutral-700">
      <input type="hidden" name="ledgerId" value={ledgerId} />
      <input type="hidden" name="fiscalYearId" value={fiscalYearId} />
      <p className="text-sm font-medium">Reopen {yearName}</p>
      <p className="mt-1 text-xs text-neutral-500">
        Reopening reverses the closing entry and changes later balance sheets until the year is
        closed again. The entries and reason stay on record.
      </p>
      {state.error && (
        <p role="alert" className={`mt-2 ${REFUSAL_QUIET}`}>
          {state.error}
        </p>
      )}
      <input name="reason" aria-label="Reason for reopening year" required
             className={`mt-2 w-full ${FIELD}`} />
      <div className="mt-3 flex items-center gap-3">
        <button type="submit" disabled={pending} className={BUTTON}>
          {pending ? 'Reopening…' : `Reopen ${yearName}`}
        </button>
        <Link href={`/ledger/${ledgerId}/periods`} className="text-xs text-neutral-500 hover:underline">
          Cancel
        </Link>
      </div>
    </form>
  )
}
