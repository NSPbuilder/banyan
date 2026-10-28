'use client'

import { EditLease } from '@/components/EditLease'
import Link from 'next/link'
import { useId, useRef, useState } from 'react'
import { FormError, useActionForm } from '@/components/ActionForm'
import {
  amendEntryAction, createAccountAction, createPartyAction, editEntryAction, saveDraftAction,
  postDraftAction, } from '@/app/actions'
import { formatMoney } from '@/lib/money'
import { focusLineCell, lineKeyboard } from '@/components/LineNavigation'
import { journalSummary } from '@/lib/amount-input'
import { AmountInput } from '@/components/AmountInput'
import { TAX_CODES } from '@/lib/tax-rates'
import { ATTACH_FIELD } from '@/lib/forms'
import { DateInput } from '@/components/DateInput'
import { Picker, type PickerCreate } from '@/components/Picker'
import { BUTTON, FIELD, QUIET, GHOST, LABEL, SUCCESS } from '@/lib/ui'
import { DataTable, TableViewport } from '@/components/Table'
import { IconButton } from '@/components/IconButton'
import { LineDragHandle, LineDragStatus, useLineDrag } from '@/components/LineDrag'
import { moveLineTo } from '@/lib/line-order'
import { FormSection } from '@/components/FormLayout'
import { Money } from '@/components/AccountingData'

export type AccountOption = { id: string; code: string; name: string }
export type LineDraft = {
  accountId: string; debit: string; credit: string; description: string
  /** Optional: who the line is about. 0025 refuses a party with no transacting role here. */
  partyId: string
  /**
   * Optional: the tax this line's amount already INCLUDES. Typed the way the
   * paper reads, so 113.44 tagged GST+PST posts 101.29 here, 5.06 on the GST
   * account and 7.09 on the PST account — or, on a debit line, 108.38 here
   * and 5.06 recoverable, because PST paid is part of what the thing cost.
   * The entry's totals do not move either way, which is what lets a tag exist
   * on a form with no side nominated to absorb it. The split is
   * `splitTaggedLine`, the same arithmetic every other door uses.
   */
  taxCode?: string
}
export type PartyOption = { id: string; name: string; roles?: string }

type GridLine = LineDraft & { rowKey: string }

const BLANK: LineDraft = { accountId: '', debit: '', credit: '', description: '', partyId: '', taxCode: '' }
const cell = `w-full ${FIELD}`

export function EntryForm({
  ledgerId, entryId, accounts, parties = [], initialDate, initialDescription,
  initialDocumentRef, initialLines, posted, mode = 'draft', onCancel, version,
}: {
  ledgerId: string
  entryId?: string
  version?: string
  accounts: AccountOption[]
  /** For the per-line party column; empty list hides nothing, the column just offers only "—". */
  parties?: PartyOption[]
  initialDate: string
  initialDescription?: string
  /** The other side's own number for the paper behind this entry. */
  initialDocumentRef?: string
  initialLines?: LineDraft[]
  posted?: boolean
  /** 'draft' saves and posts; 'amend' reverses and replaces; 'edit' rewrites a
   *  live entry in place — the open-books door, period permitting. */
  mode?: 'draft' | 'amend' | 'edit'
  onCancel?: () => void
}) {
  // One prefix per mounted form. The entry page can show TWO of these at
  // once — the entry itself and the Correct panel under it — and a fixed id
  // meant every label in the second form pointed at the first form's field
  // (critic, 2026-09-03).
  const uid = useId()

  /**
   * Making an account or a party from the line that wanted one (owner,
   * 2026-09-07). A journal line can be ANY account and its party can be on
   * either side of the books, so unlike the invoice and the quick forms this
   * screen genuinely cannot decide the type or the role — those are asked,
   * as short lists rather than as words to spell.
   *
   * The company is not named here: `createAccountAction` and
   * `createPartyAction` read it off the ledger, which has already been
   * checked by the time they do.
   */
  const newAccount: PickerCreate = {
    title: 'New account',
    action: createAccountAction,
    hidden: { ledgerId },
    fields: [
      { name: 'code', label: 'Code', width: '6rem' },
      { name: 'name', label: 'Name', width: '14rem', takesTyped: true },
      { name: 'accountType', label: 'Type', width: '9rem', options: [
        { value: 'expense', label: 'Expense' },
        { value: 'revenue', label: 'Revenue' },
        { value: 'asset', label: 'Asset' },
        { value: 'liability', label: 'Liability' },
        { value: 'equity', label: 'Equity' },
      ] },
    ],

  }
  const newParty: PickerCreate = {
    presentation: 'party',
    title: 'New party',
    action: createPartyAction,
    hidden: { ledgerId, kind: 'organisation' },
    fields: [
      { name: 'name', label: 'Name', width: '14rem', takesTyped: true },
      { name: 'role', label: 'As a', width: '9rem', options: [
        { value: 'supplier', label: 'Supplier' },
        { value: 'customer', label: 'Customer' },
      ] },
    ],
  }

  const initialRows = initialLines?.length ? [...initialLines, { ...BLANK }] : [{ ...BLANK }, { ...BLANK }, { ...BLANK }]
  const rowNumber = useRef(initialRows.length)
  const gridRef = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState<GridLine[]>(() => initialRows.map((line, i) => ({ ...line, rowKey: `${uid}-${i}` })))
  const [showContext, setShowContext] = useState(() => !!initialLines?.some(line => line.partyId || (line.taxCode && line.taxCode !== 'OUT_OF_SCOPE')))
  const blankRow = (): GridLine => ({ ...BLANK, rowKey: `${uid}-${rowNumber.current++}` })
  const payload = lines.map(({ accountId, debit, credit, description, partyId, taxCode }) =>
    ({ accountId, debit, credit, description, partyId, taxCode }))
  const { state: save, pending: saving, submitWith: saveWith } = useActionForm(saveDraftAction)
  const { state: post, pending: posting, submitWith: postWith } = useActionForm(postDraftAction)
  const { state: amend, pending: amending, submitWith: amendWith } = useActionForm(amendEntryAction)
  const { state: edit, pending: editing, submitWith: editWith } = useActionForm(editEntryAction)
  // Explicit buttons alone submit. Enter within the grid moves to the next
  // row, while native picker/select keyboard behavior keeps priority.
  const via = (run: (f: HTMLFormElement) => void) =>
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.preventDefault()
      const f = e.currentTarget.form
      if (f && f.reportValidity()) run(f)
    }
  const state = mode === 'amend' ? amend
    : mode === 'edit' ? edit
    : (post.error || post.ok ? post : save)

  // Both actions save first, so a failed post still leaves a draft. Carry its id
  // back into the form: without this, a second attempt at a rejected post writes
  // a SECOND draft, and every retry leaves another one behind.
  const currentId = post.entryId ?? save.entryId ?? entryId

  const summary = journalSummary(lines)
  const { debit: totalDebit, credit: totalCredit, difference, filled, balanced } = summary
  const validityMessage = summary.invalid ? `${summary.invalid} line(s) contain an invalid amount. Totals are partial.`
    : summary.dual ? 'Use either Debit or Credit on each line.'
    : summary.incomplete ? 'Complete the account and amount on every started line.' : ''

  const update = (i: number, patch: Partial<LineDraft>) => {
    const spare = blankRow()
    setLines((prev) => {
      const next = prev.map((l, j) => (j === i ? { ...l, ...patch } : l))
      // Keep one spare row at the bottom so there is always somewhere to type.
      if (i === next.length - 1 && (patch.accountId || patch.debit || patch.credit)) next.push(spare)
      return next
    })
  }

  const focusCell = (rowKey: string, column: string) => focusLineCell(gridRef, rowKey, column)

  const addRow = () => {
    const row = blankRow()
    setLines((prev) => [...prev, row])
    focusCell(row.rowKey, 'account')
  }
  const duplicateRow = (i: number) => {
    const row = { ...lines[i], rowKey: blankRow().rowKey }
    setLines((prev) => [...prev.slice(0, i + 1), row, ...prev.slice(i + 1)])
    focusCell(row.rowKey, 'description')
  }
  const deleteRow = (i: number) => {
    const spare = blankRow()
    const next = lines.filter((_, j) => i !== j)
    if (next.length < 2) next.push(spare)
    setLines(next)
    focusCell(next[Math.min(i, next.length - 1)].rowKey, 'description')
  }
  const { containerRef: orderRef, helpId, message, rowProps, handleProps } = useLineDrag({ keys: lines.map((line) => line.rowKey), disabled: posted || saving || posting || amending || editing,
    onReorder: (key, to) => setLines((prev) => moveLineTo(prev, prev.findIndex((line) => line.rowKey === key), to)) })
  const moveInGrid = (event: React.KeyboardEvent) => lineKeyboard({ ref: gridRef, keys: lines.map(line => line.rowKey),
    disabled: posted || saving || posting || amending || editing,
    duplicate: key => duplicateRow(lines.findIndex(line => line.rowKey === key)),
    append: () => { const row = blankRow(); setLines(prev => [...prev, row]); return row.rowKey },
  })(event)

  return (
    <div className="min-w-0">
    <form data-pending={saving || posting || amending || editing ? 'true' : undefined} className="mt-4" onSubmit={(e) => e.preventDefault()}>
      <input type="hidden" name="ledgerId" value={ledgerId} />
      {currentId && <input type="hidden" name="entryId" value={currentId} />}
      {currentId && !posted && <EditLease key={currentId} resource={{ledgerId,type:'entry',id:currentId}} version={state.version ?? version ?? ''} />}
      <input type="hidden" name="lines" value={JSON.stringify(payload)} />

      <FormError state={state} />
      {state.ok && (
        <p role="status" className={`mb-3 ${SUCCESS}`}>
          {state.ok}
        </p>
      )}

      <FormSection title="Entry details" className="entry-details">
        <div>
          <label htmlFor={`${uid}-entryDate`} className={`block ${LABEL}`}>Date</label>
          <DateInput id={`${uid}-entryDate`} name="entryDate" required defaultValue={initialDate}
                 disabled={posted} className={`mt-1 ${cell}`} />
        </div>
        <div className="entry-description">
          <label htmlFor={`${uid}-description`} className={`block ${LABEL}`}>Description</label>
          <input id={`${uid}-description`} name="description" required defaultValue={initialDescription} disabled={posted} className={`mt-1 ${cell}`} />
        </div>
        {/* The other side's own number. Not ours — ours is the entry number
            beside it. A bill entered as an invoice keeps this on the invoice
            instead, and the database refuses the second copy (0049). */}
        <div>
          <label htmlFor={`${uid}-documentRef`} className={`block ${LABEL}`}>Document reference</label>
          <input id={`${uid}-documentRef`} name="documentRef" defaultValue={initialDocumentRef} disabled={posted} className={`mt-1 ${cell}`} />
        </div>
      </FormSection>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-section-title font-semibold">Journal lines</h2>
        {!posted && <div className="flex items-center gap-3">
          <span className="hidden text-metadata text-ink-muted lg:inline">Tab: next cell · Enter: next row · Ctrl/⌘ D: duplicate</span>
          <button type="button" className={GHOST} aria-pressed={showContext} onClick={() => setShowContext(value => !value)}>Party & tax</button>
          <button type="button" className={QUIET} onClick={addRow}>Add row</button>
        </div>}
      </div>
      <div ref={gridRef} onKeyDown={moveInGrid}><div ref={orderRef}>
      <LineDragStatus id={helpId} message={message} />
      <TableViewport label="Journal lines" className="journal-grid mt-2">
      <DataTable className="min-w-[60rem]">
        <thead className="border-b border-neutral-300 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-700">
          <tr>
            {!posted && <th className="w-14"><span className="sr-only">Reorder</span></th>}
            <th className="w-[22%] py-2 font-medium">Account</th>
            <th className="font-medium">Line description</th>
            {showContext && <th className="w-36 font-medium">Party</th>}
            {showContext && <th className="w-32 font-medium">Tax included</th>}
            <th className="w-28 text-right font-medium">Debit</th>
            <th className="w-28 text-right font-medium">Credit</th>
            {!posted && <th className="w-20"><span className="sr-only">Row actions</span></th>}
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={line.rowKey} data-line={line.rowKey} {...rowProps(line.rowKey)} className="line-order-row border-b border-neutral-100 dark:border-neutral-900">
              {!posted && <td className="py-1 pr-2"><LineDragHandle index={i} {...handleProps(line.rowKey)} /></td>}
              <td data-cell="account" className="py-1 pr-2">
                {/* No `name`: this form posts every line as one JSON field,
                    so the picker reports the choice and posts nothing. */}
                <Picker value={line.accountId} disabled={posted}
                        ariaLabel={`Account on line ${i + 1}`}
                        options={accounts.map((a) => ({ id: a.id, label: `${a.code}  ${a.name}` }))}
                        create={posted ? undefined : newAccount}
                        onChange={(id) => update(i, { accountId: id })} />
              </td>
              <td data-cell="description" className="py-1 pr-2">
                <input aria-label={`Description on line ${i + 1}`} value={line.description} disabled={posted} className={cell}
                       onChange={(e) => update(i, { description: e.target.value })} />
              </td>
              {showContext && <td data-cell="party" className="py-1 pr-2">
                <Picker value={line.partyId} disabled={posted}
                        ariaLabel={`Party on line ${i + 1}`}
                        options={parties.map((p) => ({ id: p.id, label: p.name, hint: p.roles }))}
                        create={posted ? undefined : newParty}
                        onChange={(id) => update(i, { partyId: id })} />
              </td>}
              {showContext && <td data-cell="tax" className="py-1 pr-2">
                <select value={line.taxCode ?? ''} disabled={posted} className={cell}
                        aria-label={`Tax on line ${i + 1}`}
                        onChange={(e) => update(i, { taxCode: e.target.value })}>
                  {TAX_CODES.map((t) => (
                    <option key={t.code} value={t.code === 'OUT_OF_SCOPE' ? '' : t.code}>
                      {t.code === 'OUT_OF_SCOPE' ? '—' : t.label}
                    </option>
                  ))}
                </select>
              </td>}
              <td data-cell="debit" className="py-1 pr-2">
                <AmountInput error={summary.amounts[i].debit.error} aria-label={`Debit on line ${i + 1}`} value={line.debit} disabled={posted} inputMode="decimal"
                       className={`${cell} text-right tabular-nums`}
                       onChange={(e) => update(i, { debit: e.target.value, credit: '' })} />
              </td>
              <td data-cell="credit" className="py-1">
                <AmountInput error={summary.amounts[i].credit.error} aria-label={`Credit on line ${i + 1}`} value={line.credit} disabled={posted} inputMode="decimal"
                       className={`${cell} text-right tabular-nums`}
                       onChange={(e) => update(i, { credit: e.target.value, debit: '' })} />
              </td>
              {!posted && <td className="py-1">
                <div className="flex gap-1">
                  <IconButton icon="duplicate" label={`Duplicate line ${i + 1}`} onClick={() => duplicateRow(i)} />
                  <IconButton icon="delete" label={`Delete line ${i + 1}`} onClick={() => deleteRow(i)} />
                </div>
              </td>}
            </tr>
          ))}
        </tbody>
      </DataTable>
      </TableViewport>
      </div></div>
      <div className="journal-totals" role="status" aria-live="polite" aria-atomic="true">
        <span className={validityMessage || difference !== 0n ? 'text-danger-ink' : 'text-ink-secondary'}>
          {validityMessage || (difference !== 0n ? `${difference > 0n ? 'Credits' : 'Debits'} short by ${formatMoney(difference < 0n ? -difference : difference)}`
            : filled < 2 ? 'Needs at least two lines' : 'Balanced')}
        </span>
        <div className="flex flex-wrap gap-4">
          <span>Debit <strong className="ml-2 font-semibold"><Money cents={totalDebit} sign="minus" /></strong></span>
          <span>Credit <strong className="ml-2 font-semibold"><Money cents={totalCredit} sign="minus" /></strong></span>
        </div>
      </div>

      {mode === 'edit' && (
        <label className={`mt-4 block max-w-xl ${LABEL}`}>
          Reason (optional)
          <input name="reason" maxLength={500}
                 className={`mt-1 block w-full ${cell}`} />
        </label>
      )}

      {mode === 'edit' ? (
        <div className="form-actions flex-wrap items-center">
          <button onClick={via(editWith)} disabled={!balanced || editing}
                  title={balanced ? undefined : 'The entry must keep at least two lines and balance'}
                  className={BUTTON}>
            {editing ? 'Saving…' : 'Save changes'}
          </button>
          <span className="ml-auto text-xs text-neutral-500">
            {validityMessage || (balanced ? 'Balanced — the books move with the save' : filled < 2 ? 'Needs at least two lines' : 'Does not balance yet')}
          </span>
        </div>
      ) : mode === 'amend' ? (
        <div className="form-actions flex-wrap items-center">
          <button onClick={via(amendWith)} disabled={!balanced || amending}
                  title={balanced ? undefined : 'The replacement must have at least two lines and balance'}
                  className={BUTTON}>
            {amending ? 'Correcting…' : 'Reverse and replace'}
          </button>
          {onCancel && (
            <button type="button" onClick={onCancel} className={GHOST}>
              Cancel
            </button>
          )}
          <span className="ml-auto text-xs text-neutral-500">
            {validityMessage || (balanced ? 'Balanced — ready to replace' : filled < 2 ? 'Needs at least two lines' : 'Does not balance yet')}
          </span>
        </div>
      ) : !posted && (
        <>
        {/* The paper, filed against the entry once it posts — a draft has no
            entry to hang it on yet, and saying so beats a control that
            silently does nothing (owner, 2026-09-07). */}
        <div className="mt-5">
          <label className={LABEL}>
            <span className="block">Attachment</span>
            <input type="file" name={ATTACH_FIELD}
                   accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.gif,.tiff,application/pdf,image/*"
                   className="mt-1 block max-w-full text-xs normal-case text-neutral-600 file:mr-3 file:rounded file:border file:border-neutral-300 file:bg-transparent file:px-2 file:py-1 file:text-xs dark:text-neutral-400 dark:file:border-neutral-700" />
          </label>

        </div>
        <div className="form-actions flex-wrap items-center">
          <button onClick={via(saveWith)} disabled={saving || posting}
                  className={QUIET}>
            {saving ? 'Saving…' : 'Save draft'}
          </button>
          <button onClick={via(postWith)} disabled={!balanced || saving || posting}
                  title={balanced ? undefined : 'An entry must have at least two lines and balance before it can be posted'}
                  className={BUTTON}>
            {posting ? 'Posting…' : 'Post'}
          </button>
          <Link href={`/ledger/${ledgerId}/entries`} className={GHOST}>Cancel</Link>
        </div>
        </>
      )}
    </form>
    </div>
  )
}
