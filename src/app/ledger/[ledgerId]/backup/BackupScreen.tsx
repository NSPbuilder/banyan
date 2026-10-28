'use client'

import { formatNumber } from '@/lib/numbers'
import { BACKUP_ACCEPT, BACKUP_EXT } from '@/lib/backup-name'
import { useState } from 'react'
import { useActionForm, type FormAction } from '@/components/ActionForm'
import { BACKUP_FIELDS as F } from '@/lib/forms'
import { BUTTON, FIELD, REFUSAL } from '@/lib/ui'
import { Floating } from '@/components/Floating'

/**
 * Saving this company, and reading one back.
 *
 * TWO DIFFERENT THINGS ON ONE SCREEN, and the difference is the whole point:
 * saving is a download and touches nothing; restoring MAKES A NEW COMPANY and
 * never writes over one that exists. The second half says so before the
 * button, because "restore" is a word people press quickly.
 *
 * The doors arrive as props, so a check can render this outside a server
 * runtime (the ActionForm rule).
 */

const LABEL = 'block text-xs font-medium uppercase tracking-wide text-neutral-500'

export function BackupScreen({
  ledgerId, code, name, paperCount, paperBytes, restoreAction, restoreAvailable,
}: {
  ledgerId: string
  code: string
  name: string
  /** What the receipts weigh, so the choice to carry them is an informed one. */
  paperCount: number
  paperBytes: number
  restoreAction: FormAction
  restoreAvailable: boolean
}) {
  const [withPaper, setWithPaper] = useState(true)
  const { state, pending, formProps } = useActionForm(restoreAction)
  const mb = (n: number) => `${formatNumber((n / 1024 / 1024).toFixed(1))} MB`

  return (
    <>
      <section className="mt-8 rounded border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Save {name}</h2>
        <p className="mt-1 text-xs text-neutral-500">
          {/* Which of the two backups this is — the one thing a person cannot
              tell from the screen. The other one is the whole database. */}
          This company only, including its company-scoped audit history. Shared, system and
          unresolved audit events stay in the whole-database backup.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={withPaper} onChange={(e) => setWithPaper(e.target.checked)} />
          Include the paper — {paperCount} receipt{paperCount === 1 ? '' : 's'}, {mb(paperBytes)}
        </label>
        <a href={`/ledger/${ledgerId}/backup/file${withPaper ? '?paper=yes' : ''}`}
           className={`mt-4 inline-block ${BUTTON}`}>
          Save {code}{BACKUP_EXT}
        </a>
      </section>

      <section className="mt-6 rounded border border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-sm font-medium">Restore a company from a file</h2>

        {/* The form floats (owner, 2026-09-16): a file box and two names
            sitting open under "restore" was the kind of page they asked to
            be rid of — and a floating form is one more deliberate step before
            a button people press quickly. */}
        {restoreAvailable ? <div className="mt-4">
          <Floating label="Restore from a file" title="Restore a company from a file" buttonClassName={BUTTON}>

            <form {...formProps} className="mt-4 space-y-3">
              <input type="hidden" name={F.ledgerId} value={ledgerId} />
              <div>
                <span className={LABEL}>The file</span>
                <input type="file" name={F.file} accept={BACKUP_ACCEPT} required
                       className="mt-1 block text-xs text-neutral-600 file:mr-3 file:rounded file:border file:border-neutral-300 file:bg-transparent file:px-2 file:py-1 file:text-xs dark:text-neutral-400 dark:file:border-neutral-700" />
              </div>
              <div className="flex gap-3">
                <label className="text-xs text-neutral-500">
                  <span className="block">Code for the restored company</span>
                  <input name={F.code} className={`mt-1 ${FIELD}`} />
                </label>
                <label className="text-xs text-neutral-500">
                  <span className="block">Name</span>
                  <input name={F.name} className={`mt-1 w-64 ${FIELD}`} />
                </label>
              </div>
              {state.error && (
                <p role="alert" className={REFUSAL}>
                  {state.error}
                </p>
              )}
              {state.ok && (
                <p role="status" className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                  {state.ok}
                </p>
              )}
              <button type="submit" disabled={pending} className={BUTTON}>
                {pending ? 'Restoring…' : 'Restore as a new company'}
              </button>
            </form>
          </Floating>
        </div> : (
          <p className="mt-3 text-xs text-neutral-500">
            Saving is available here; restoring a company requires the superadmin account.
          </p>
        )}
      </section>
    </>
  )
}
