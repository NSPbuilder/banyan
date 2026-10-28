'use client'

import { formatNumber } from '@/lib/numbers'
import { useState } from 'react'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { COMPANY_FIELDS as F } from '@/lib/forms'
import { FIELD, QUIET } from '@/lib/ui'
import { CANADIAN_PROVINCES } from '@/lib/provinces'

/**
 * Putting a company away, bringing it back, and removing one that was a
 * mistake (0065).
 *
 * The two doors look different on purpose. ARCHIVE asks for a reason and
 * says what stays; DELETE asks the person to type the company's code, and is
 * offered ONLY where the books hold nothing and nobody asked the assistant
 * about the company — otherwise the screen says which, and offers archive,
 * from the same two counts `deleteCompany` refuses on.
 *
 * The actions arrive as props so a check can render this without a server
 * runtime (the ActionForm rule).
 */


export function CompanyState({
  entityId, code, name, province = null, books, aiRecords, archivedAt, archivedReason, archiveAction, unarchiveAction, deleteAction,
  renameAction,
}: {
  entityId: string
  code: string
  name: string
  /** `CompanyRecord.entries`: every entry, invoice and imported bank row. */
  books: string
  /** `CompanyRecord.ai_records`: questions put to the assistant and bills it read. */
  aiRecords: string
  archivedAt: string | null
  archivedReason: string | null
  archiveAction: FormAction
  unarchiveAction: FormAction
  deleteAction: FormAction
  /** The province the sales tax rules read, for the rename form's default. */
  province?: string | null
  /** A name or province entered wrong, put right (0084). Absent: not offered. */
  renameAction?: FormAction
}) {
  const [mode, setMode] = useState<'none' | 'archive' | 'delete' | 'rename'>('none')
  const removable = books === '0' && aiRecords === '0'

  if (archivedAt !== null) {
    return (
      <div className="flex flex-wrap items-baseline gap-3 text-xs" data-company-state="archived">
        <span className="text-amber-700 dark:text-amber-400">
          Archived {archivedAt.slice(0, 10)}
          {archivedReason && <> — {archivedReason}</>}
        </span>
        <ActionForm action={unarchiveAction} submit="Bring it back" working="…" buttonClassName={QUIET}>
          <input type="hidden" name={F.entityId} value={entityId} />
        </ActionForm>
      </div>
    )
  }

  if (mode === 'archive') {
    return (
      <ActionForm action={archiveAction} submit="Archive it" working="Archiving…"
                  className="flex flex-wrap items-end gap-2 text-xs" buttonClassName={QUIET}>
        <input type="hidden" name={F.entityId} value={entityId} />
        <label className="text-neutral-500">
          <span className="block">Why is {name} being put away?</span>
          <input name={F.reason} required className={`mt-1 w-72 ${FIELD}`} />
        </label>
        <button type="button" onClick={() => setMode('none')} className="pb-1 text-neutral-500 hover:underline">
          Cancel
        </button>
      </ActionForm>
    )
  }

  if (mode === 'rename' && renameAction) {
    return (
      <ActionForm action={renameAction} submit="Save" working="Saving…" onSucceeded={() => setMode('none')}
                  className="flex flex-wrap items-end gap-2 text-xs" buttonClassName={QUIET}>
        <input type="hidden" name={F.entityId} value={entityId} />
        <label className="text-neutral-500">
          <span className="block">Name</span>
          <input name={F.name} required defaultValue={name} className={`mt-1 w-64 ${FIELD}`} />
        </label>
        <label className="text-neutral-500">
          <span className="block">Province</span>
          <select name={F.province} defaultValue={province ?? ''} className={`mt-1 ${FIELD}`}>
            <option value="">—</option>
            {CANADIAN_PROVINCES.map(([c, label]) => <option key={c} value={c}>{label}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => setMode('none')} className="pb-1 text-neutral-500 hover:underline">
          Cancel
        </button>
      </ActionForm>
    )
  }

  if (mode === 'delete') {
    return (
      <ActionForm action={deleteAction} submit="Remove it for good" working="Removing…"
                  className="flex flex-wrap items-end gap-2 text-xs" buttonClassName={QUIET}>
        <input type="hidden" name={F.entityId} value={entityId} />
        <input type="hidden" name={F.code} value={code} />
        <label className="text-neutral-500">
          <span className="block">
            {name} has nothing in its books. Type <span className="font-mono">{code}</span> to remove it.
          </span>
          <input name={F.confirm} required className={`mt-1 w-40 ${FIELD}`} />
        </label>
        <button type="button" onClick={() => setMode('none')} className="pb-1 text-neutral-500 hover:underline">
          Cancel
        </button>
      </ActionForm>
    )
  }

  return (
    <div className="flex flex-wrap items-baseline gap-3 text-xs" data-company-state="live">
      {renameAction && (
        <button onClick={() => setMode('rename')} className="text-neutral-500 hover:underline">
          Rename…
        </button>
      )}
      <button onClick={() => setMode('archive')} className="text-neutral-500 hover:underline">
        Archive…
      </button>
      {removable ? (
        <button onClick={() => setMode('delete')} className="text-neutral-500 hover:underline" data-delete-offered>
          Remove…
        </button>
      ) : (
        <span className="text-neutral-400">
          {books !== '0'
            ? `${formatNumber(books)} ${books === '1' ? 'thing' : 'things'} in its books — kept, so this one can only be archived`
            : 'asked the assistant, which is kept for good — so this one can only be archived'}
        </span>
      )}
    </div>
  )
}
