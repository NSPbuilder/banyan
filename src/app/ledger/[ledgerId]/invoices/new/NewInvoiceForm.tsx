'use client'

import { EditLease } from '@/components/EditLease'
import { useState } from 'react'
import Link from 'next/link'
import { ActionForm, type FormAction } from '@/components/ActionForm'
import { Picker } from '@/components/Picker'
import { partyOptions } from '@/lib/forms'
import { ATTACH_FIELD, INVOICE_FIELDS as F, READING_FIELD } from '@/lib/forms'
import { initialRows, type RowState } from '@/lib/invoice-rows'
import { rowStateFrom, type InvoiceInitial } from '@/lib/prefill'
import { InvoiceLines } from '../InvoiceLines'
import type { Choice } from '@/lib/forms'
import { DateInput } from '@/components/DateInput'
import { BUTTON, FIELD, LABEL } from '@/lib/ui'
import type { AvailableInvoiceTemplate, InvoiceTemplateAssignment, InvoiceTemplateSnapshot } from '@/lib/invoice-template-types'
import { invoiceHref, type InvoiceDirection } from '@/lib/invoice-routes'

/**
 * The form that makes a new invoice — extracted from the list screen so it can
 * float as an overlay, carrying its whole design with it.
 *
 * The line rows come from `InvoiceLines`, which owns the two-numbers problem
 * that starts once rows can be added and removed. Every field of a line
 * carries the same number as its neighbours in that row, so re-ordering moves
 * a whole row. The sales tax screen was burned by the other shape, where the
 * number was a key into a list rendered somewhere else. `src/lib/forms.ts`
 * states the rule.
 *
 * Amounts are typed as what the line ADDS to the invoice. Which way that moves
 * the ledger is decided by the direction, not by the typist — see
 * `ledgerAmount` in `invoice-forms.ts`.
 */
export function NewInvoiceForm({
  ledgerId, parties, controlAccounts, lineAccounts, today, action, openWith,
  edit, start, newParty, newAccount, templateData, documentDirection = 'sales',
}: {
  ledgerId: string
  parties: { sales: Choice[]; purchase: Choice[] }
  controlAccounts: { sales: Choice[]; purchase: Choice[] }
  lineAccounts: Choice[]
  today: string
  action: FormAction
  documentDirection?: InvoiceDirection
  templateData?: { templates: AvailableInvoiceTemplate[]; assignments: InvoiceTemplateAssignment[] }
  /**
   * Editing an existing live document: its id, its frozen identity (the
   * direction and kind cannot change — delete and reissue), and the header
   * values to open with. Line rows arrive through `openWith`, as always.
   */
  edit?: {
    invoiceId: string
    version?: string
    direction: 'sales' | 'purchase'
    kind: 'invoice' | 'credit_note'
    kindLabel: string
    templateSelection?: string
    templateSnapshot?: InvoiceTemplateSnapshot | null
    templateLocked?: boolean
    isDraft?: boolean
    header: { partyId: string; controlAccountId: string; issuedOn: string; dueOn: string
              number: string; theirRef: string; note: string }
  }
  /**
   * The line rows to open with. Six blank ones unless something says otherwise.
   *
   * It exists so the form can be shown in a state it only reaches after being
   * edited — one where a row's key is no longer its position, because a row has
   * been removed or moved. That is the only state in which the screen's two
   * numbers are distinguishable, and every way this screen can go wrong is a
   * confusion between them. On a form nobody has touched yet, key 3 sits in
   * position 3 and a button wired to the wrong one of them looks perfect.
   *
   * `V88` and `V89` render it that way for exactly that reason.
   */
  openWith?: RowState
  /**
   * A NEW purchase bill or sales invoice, opening filled in from a reading
   * (0064, 0077): the direction, the header values and the line rows the
   * proposal named. Values only — the same fields, the same reader, the same
   * door as one typed by hand; the reading's id rides along hidden so a picture
   * is filed against the entry once it posts. Not with `edit`.
   */
  start?: InvoiceInitial
  /** The door that creates a party, for the picker's own creating row. */
  newParty?: { action: FormAction; hidden: Record<string, string> }
  /** And the one that creates an account. */
  newAccount?: { action: FormAction; hidden: Record<string, string> }
}) {
  const [lineRows, setLineRows] = useState(openWith ?? (start ? rowStateFrom(start.rows) : initialRows()))
  const [inclusive, setInclusive] = useState(openWith?.inclusive ?? false)
  // Controlled so the tax assist can offer the RIGHT accounts for the chosen
  // direction — a sale collects tax, a purchase claims it back. In edit mode
  // the direction is identity and does not move.
  const direction = edit?.direction ?? start?.direction ?? documentDirection
  const salesInvoice = direction === 'sales' && (edit?.kind ?? start?.kind ?? 'invoice') === 'invoice'
  // Saved from a reading: done, not cleared. A cleared form would keep the
  // header the proposal filled in and the reading's id, and a second save
  // would be a second bill. What is shown is the sentence the action
  // returned — "filed" or "could not be filed, and why" — not a guess.
  const [done, setDone] = useState<string | null>(null)
  const header = edit?.header ?? start?.header
  /** The document date is independent of when its party was registered. */
  const [issuedOn, setIssuedOn] = useState(header?.issuedOn ?? today)
  const [partyId, setPartyId] = useState(header?.partyId ?? '')
  const [template, setTemplate] = useState(edit?.templateSelection ?? 'auto')
  const automatic = templateData?.assignments.find(a => a.party_id === partyId)
    ?? templateData?.assignments.find(a => a.party_id === null)

  if (done !== null) {
    return (
      <p role="status" className="mt-6 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
        {done}{' '}
        <Link href={invoiceHref(ledgerId, direction)} className="font-medium underline">{direction === 'purchase' ? 'See the bills' : 'See the invoices'}</Link>{' '}
        {start?.readingId && <Link href={`/ledger/${ledgerId}/readings`} className="font-medium underline">Back to AI</Link>}
      </p>
    )
  }

  return (
    <section className="mt-6">
      <ActionForm action={action} submit={edit ? 'Save changes' : 'Save to the books'}
                  working="Saving…"
                  className="mt-3 invoice-form" buttonClassName={BUTTON} stickyActions
                  onSucceeded={edit ? undefined : start ? (s) => setDone(s.ok ?? 'Saved to the books.') : () => {
                    setLineRows(initialRows()); setInclusive(false); setPartyId(''); setTemplate('auto')
                  }}>
{edit && <EditLease resource={{ledgerId,type:'invoice',id:edit.invoiceId}} version={edit.version ?? ''} />}
        <input type="hidden" name={F.ledgerId} value={ledgerId} />
        {edit && <input type="hidden" name={F.invoiceId} value={edit.invoiceId} />}
        {start?.readingId && <input type="hidden" name={READING_FIELD} value={start.readingId} />}
        {/* The document's kind, declared by the form itself: this form mints
            invoices and bills; the edit door carries the document's own. */}
        <input type="hidden" name={F.kind} value={edit?.kind ?? start?.kind ?? 'invoice'} />

        {/* A grid rather than a wrapping flex row: the labels sit over their
            own fields at every width, instead of drifting apart as the panel
            changes size (owner, 2026-09-07). */}
        <div className="form-grid invoice-parties items-end">
            <label className={LABEL}>
              <span className="block">Document type</span>
              <span className="mt-1 block py-1.5 text-sm">{edit?.kindLabel ?? (start?.kind === 'credit_note'
                ? direction === 'sales' ? 'Sales credit note' : 'Supplier credit note'
                : direction === 'sales' ? 'Sales invoice' : 'Supplier bill')}</span>
              <input type="hidden" name={F.direction} value={direction} />
            </label>
          <label className={LABEL}>
            <span className="block">{direction === 'sales' ? 'Customer' : 'Supplier'}</span>
            {/* Type to narrow, and create the one you were looking for from
                inside the list (owner, 2026-09-07). It posts the same id the
                select posted, so the reader is untouched. */}
            <Picker name={F.partyId} required ariaLabel="Party"
                    className="mt-1 w-full"
                    value={partyId} onChange={setPartyId}
                    options={partyOptions(
                      { customers: parties.sales, suppliers: parties.purchase },
                      direction === 'sales' ? 'customers' : 'suppliers',
                    )}
                    create={newParty && {
                      presentation: 'party',
                      title: direction === 'sales' ? 'New customer' : 'New supplier',
                      action: newParty.action,
                      hidden: {
                        ...newParty.hidden,
                        role: direction === 'sales' ? 'customer' : 'supplier',
                      },
                      fields: [{ name: 'name', label: 'Name', width: '16rem', takesTyped: true }],

                    }} />
          </label>
          <label className={LABEL}>
            <span className="block">{direction === 'sales' ? 'Receivables account' : 'Payables account'}</span>
            <Picker name={F.controlAccountId} required ariaLabel="Control account"
                    className="mt-1 w-full"
                    defaultValue={header?.controlAccountId ?? controlAccounts[direction][0]?.id ?? ''}
                    options={controlAccounts[direction]} />
          </label>
        </div>

        <div className="form-grid invoice-header mt-3 items-end">
          <label className={LABEL}>
            <span className="block">Issued</span>
            <DateInput name={F.issuedOn} required value={issuedOn}
                   onChange={(e) => setIssuedOn(e.target.value)}
                   className={`mt-1 w-full ${FIELD}`} />
          </label>
          <label className={LABEL}>
            <span className="block">Due</span>
            <DateInput name={F.dueOn} required defaultValue={header?.dueOn ?? today}
                   className={`mt-1 w-full ${FIELD}`} />
          </label>
          <label className={LABEL}>
            <span className="block">{direction === 'sales' ? 'Invoice #' : 'Supplier invoice #'}</span>
            <input name={F.number} defaultValue={header?.number ?? ''} className={`mt-1 w-full ${FIELD}`} />
          </label>
          <label className={LABEL}>
            <span className="block">Other party reference</span>
            <input name={F.theirRef} defaultValue={header?.theirRef ?? ''} className={`mt-1 w-full ${FIELD}`} />
          </label>
          <label className={LABEL}>
            <span className="block">Note</span>
            <textarea name={F.note} defaultValue={header?.note ?? ''} rows={3}
                      placeholder={salesInvoice ? 'Deposit: ...\nProgress payment: ...\nFinal payment: ...' : undefined}
                      className={`mt-1 w-full ${FIELD}`} />
            {salesInvoice && <span className="mt-1 block text-caption text-ink-muted">For staged payments, note the deposit, progress payment and final payment here.</span>}
          </label>
          {direction === 'sales' && <label className={LABEL}><span className="block">Invoice template</span>
            {edit?.templateLocked ? <><input type="hidden" name={F.template} value={edit.templateSelection ?? 'auto'} /><span className="mt-1 flex min-h-control items-center text-body" title="This invoice keeps its saved template version.">{edit.templateSnapshot?.name ?? 'System standard'}{edit.templateSnapshot?.version ? ` · v${edit.templateSnapshot.version}` : ''}</span></>
              : <select name={F.template} aria-label="Invoice template" value={template} onChange={e => setTemplate(e.target.value)} className={`mt-1 w-full ${FIELD}`}>
                <option value="auto">Automatic: {automatic?.template_name ?? 'System standard'}</option><option value="system">System standard</option>
                {templateData?.templates.map(t => <option key={t.id} value={t.id}>{t.name} (v{t.current_version})</option>)}
              </select>}
          </label>}
        </div>

        <p className="form-section-heading mt-5 text-sm font-semibold">
          Line items
        </p>
        <InvoiceLines state={lineRows} setState={setLineRows}
                      inclusive={inclusive} issuedOn={issuedOn}
                      lineAccounts={lineAccounts} fieldClass={FIELD}
                      newAccount={newAccount && {
                        title: direction === 'sales' ? 'New revenue account' : 'New expense account',
                        action: newAccount.action,
                        // The TYPE is not asked for. A line on a sales invoice
                        // is revenue and a line on a purchase invoice is cost;
                        // the screen knows which, so making the person type
                        // the word — and get it right — was work for nothing.
                        hidden: {
                          ...newAccount.hidden,
                          accountType: direction === 'sales' ? 'revenue' : 'expense',
                        },
                        fields: [
                          { name: 'code', label: 'Code', width: '6rem' },
                          { name: 'name', label: 'Name', width: '15rem', takesTyped: true },
                        ],

                      }} />

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className={LABEL}>
            <span className="block">Line amounts are</span>
            <select name={F.amounts} value={inclusive ? 'inclusive' : 'exclusive'}
                    onChange={(e) => setInclusive(e.target.value === 'inclusive')} className={`mt-1 ${FIELD}`}>
              <option value="exclusive">before tax</option>
              <option value="inclusive">tax included</option>
            </select>
          </label>

        </div>

        {/* The supplier's own bill, filed against the entry this raises. */}
        {!edit?.isDraft && <div className="mt-4">
          <label className={LABEL}>
            <span className="block">Attachment</span>
            <input type="file" name={ATTACH_FIELD}
                   accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.gif,.tiff,application/pdf,image/*"
                   className="mt-1 block max-w-full text-xs text-neutral-600 file:mr-3 file:rounded file:border file:border-neutral-300 file:bg-transparent file:px-2 file:py-1 file:text-xs dark:text-neutral-400 dark:file:border-neutral-700" />
          </label>

        </div>}

      </ActionForm>
    </section>
  )
}
