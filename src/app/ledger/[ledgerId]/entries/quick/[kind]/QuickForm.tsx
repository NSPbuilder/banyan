'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { FormError, useActionForm, type FormAction } from '@/components/ActionForm'
import { ATTACH_FIELD, QUICK_FIELDS as F, READING_FIELD, bankPartyOptions, lineAccount, lineAmount, lineDescription, lineTaxCode, type TransactingPartyRoleChoice } from '@/lib/forms'
import type { QuickInitial } from '@/lib/prefill'
import { TAX_CODES, computeEnteredTax, parseTaxOverride, type TaxCode } from '@/lib/tax-rates'
import { moneyInput, parseMoney } from '@/lib/money'
import { LineTaxes, TAX_FIELDS_GRID } from '@/components/LineTaxes'
import { DateInput } from '@/components/DateInput'
import { Picker, type PickerCreate } from '@/components/Picker'
import { partyOptions } from '@/lib/forms'
import { IconButton } from '@/components/IconButton'
import { LineDragHandle, LineDragStatus, useLineDrag } from '@/components/LineDrag'
import { moveLineTo } from '@/lib/line-order'
import { BUTTON, FIELD, LABEL, QUIET } from '@/lib/ui'

type Option = { id: string; code: string; name: string; account_type?: string; shareholder_loan?: boolean; prepaid_expense?: boolean; cash_account?: boolean }
type PartyChoices = {
  customers: Array<{ id: string; label: string }>
  suppliers: Array<{ id: string; label: string }>
}

/**
 * A field WITHOUT a width, and the full-width one built from it.
 *
 * They were one class carrying `w-full`, and every line-row field used it
 * beside its own `w-28` or `flex-[2]`. Two width utilities of equal
 * specificity: the stylesheet's order decides, `w-full` is emitted after
 * `w-28`, and so the amount box and the tax select took the whole row while
 * the account and the description collapsed to nothing — which is what the
 * owner was looking at (2026-09-07). A field that sets its own width must
 * not also be told it is 100% wide.
 */
const field =
  FIELD
const input = `mt-1 w-full ${field}`
/** One template for the header and every row, so the labels sit over their fields. */
const ROW = 'grid grid-cols-[2rem_12rem_minmax(6rem,1fr)_7rem_8rem_14.5rem_2rem] items-start gap-2'
const label = LABEL
/** What each account type is called over a group of options. */
const TYPE_HEADING: Record<string, string> = {
  expense: 'Expenses',
  revenue: 'Income',
  asset: 'Things owned',
  liability: 'Owed',
  equity: 'Equity',
}

export function QuickForm({
  ledgerId, kind, today, plAccounts, bankAccounts, gstAccount, pstAccount, initial, action,
  newAccount, parties = { customers: [], suppliers: [] }, fundingParties = [], newParty,
}: {
  ledgerId: string
  kind: 'expense' | 'income'
  /**
   * The door that makes an account, for the pickers below (owner, 2026-09-07):
   * the account you wanted should be creatable from the list that does not
   * have it, without leaving a half-typed receipt behind. A prop, like every
   * action here, so a check can render this outside a server runtime.
   */
  newAccount?: { action: FormAction; hidden: Record<string, string> }
  /**
   * Who the money was with. A quick entry could never name anybody — the
   * owner asked whether it had been taken away (2026-09-07); it had never
   * been there. It is what puts a receipt under its supplier on the Expenses
   * screen, which reads the line's own party.
   */
  parties?: PartyChoices
  fundingParties?: TransactingPartyRoleChoice[]
  newParty?: { action: FormAction; hidden: Record<string, string> }
  /**
   * The door. A prop rather than an import, so a check can render this screen
   * without a server runtime — importing `@/app/actions` pulls in
   * `server-only`, and a component that cannot be rendered is a component
   * whose markup nothing watches (the ActionForm rule, `components/ActionForm.tsx`).
   */
  action: FormAction
  today: string
  plAccounts: Option[]
  bankAccounts: Option[]
  gstAccount: Option | null
  /** Income only; PST paid on an expense is cost and needs no account. */
  pstAccount: Option | null
  /**
   * What the form opens with when a reading is being entered (0064, 0077):
   * the date, the wording, the reference and the rows the proposal named.
   * Values only — the same fields, the same reader, the same door. The
   * reading's id rides along hidden, so a picture is filed against the entry
   * once it posts, and the reading is closed.
   */
  initial?: QuickInitial
}) {
  const expense = kind === 'expense'

  /**
   * An account as the picker shows it, under a heading for its type.
   *
   * Both lists are the whole chart now, or nearly — so the heading is what
   * keeps them readable, and the ordinary answer is first because the query
   * sorts it there. `usual` is the type this form is mostly about; it gets a
   * heading that says so rather than the bare word.
   */
  const asOptions = (list: Option[], usual: string) => list.map((a) => ({
    id: a.id,
    label: `${a.code} — ${a.name}`,
    group: a.account_type === usual ? TYPE_HEADING[usual] : (TYPE_HEADING[a.account_type ?? ''] ?? 'Other'),
  }))

  /**
   * Making the account a line needs, from the line. The TYPE is not asked
   * for — every line on this form is expense on an expense and revenue on
   * income, so the screen already knows the answer and typing it could only
   * introduce a wrong one.
   */
  const lineCreate: PickerCreate | undefined = newAccount && {
    title: expense ? 'New expense account' : 'New income account',
    action: newAccount.action,
    hidden: { ...newAccount.hidden, accountType: expense ? 'expense' : 'revenue' },
    fields: [
      { name: 'code', label: 'Code', width: '6rem' },
      { name: 'name', label: 'Name', width: '15rem', takesTyped: true },
    ],

  }

  // Which tags this form can honour: GST needs its account either way; PST on
  // income needs the payable account (on an expense it folds into cost).
  const codes = TAX_CODES.filter((t) => {
    const wantsGst = t.code === 'GST' || t.code === 'GST_PST'
    const wantsPst = t.code === 'PST' || t.code === 'GST_PST'
    if (wantsGst && !gstAccount) return false
    if (wantsPst && !expense && !pstAccount) return false
    return true
  })

  // Rows — a receipt is often several items (owner, 2026-09-02). Amount and
  // tag are controlled so the preview can add the rows up with the SAME
  // computeTax the server posts with. Account and description travel with
  // the stable row key; field names follow the visible position on submit.
  // A proposal's rows arrive keyed by position, once, at the start; a tag the
  // form cannot honour (no GST account yet) opens as no tag rather than as a
  // value the select does not offer.
  type Row = {
    key: number; amount: string; tax: TaxCode; account?: string; description?: string; gst?: string; pst?: string
    /** Filled from where this supplier went last time, not read off the bill. */
    fromMemory?: boolean
  }
  const opening: Row[] = initial && initial.rows.length > 0
    ? initial.rows.map((r, i) => ({
        key: i, amount: r.amount, account: r.accountId, description: r.description,
        fromMemory: r.fromMemory,
        tax: codes.some((t) => t.code === r.tax) ? r.tax : 'OUT_OF_SCOPE',
      }))
    : [{ key: 0, amount: '', tax: 'OUT_OF_SCOPE' }]
  const nextKey = useRef(opening.length)
  const [rows, setRows] = useState<Row[]>(opening)
  const [inclusive, setInclusive] = useState(false)
  // CONTROLLED, so the preview and the posting use the same day. The rates are
  // chosen by the document's date now, and an uncontrolled field would have let
  // the preview quote one day's rate while the server posted another's.
  const [date, setDate] = useState(initial?.entryDate ?? today)
  const [paidFromAccountId, setPaidFromAccountId] = useState(initial?.bankAccountId ?? '')
  const { state, pending, formProps } = useActionForm(action, { onSucceeded: () => {
    if (initial) return
    setRows([{ key: nextKey.current++, amount: '', tax: 'OUT_OF_SCOPE' }])
    setInclusive(false); setDate(today); setPaidFromAccountId('')
  } })
  const shareholderLoan = expense && bankAccounts.some((a) => a.id === paidFromAccountId && a.shareholder_loan)
  const setRow = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const { containerRef: orderRef, helpId, message, rowProps, handleProps } = useLineDrag({ keys: rows.map((r) => String(r.key)), disabled: pending,
    onReorder: (key, to) => setRows((rs) => moveLineTo(rs, rs.findIndex((r) => String(r.key) === key), to)) })

  // The summed preview: base, gst, pst across every row that reads as money.
  let preview: { base: bigint; gst: bigint; pst: bigint; total: bigint } | null = null
  try {
    const parts = rows.filter((r) => r.amount.trim())
      .map((r) => computeEnteredTax(parseMoney(r.amount), r.tax, inclusive, date,
        { gst: parseTaxOverride(r.gst), pst: parseTaxOverride(r.pst) }))
    if (parts.length > 0) {
      preview = parts.reduce((s, t) => ({
        base: s.base + t.base, gst: s.gst + t.gst, pst: s.pst + t.pst, total: s.total + t.total,
      }), { base: 0n, gst: 0n, pst: 0n, total: 0n })
    }
  } catch { /* not money yet */ }

  const money = moneyInput

  // Posted from a reading: done, not cleared. A cleared form would come back
  // filled in from the same bill, and a second Post would enter it twice
  // before the reading could refuse.
  if (state.ok && initial) {
    return (
      <p role="status" className="mt-4 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
        {state.ok}{' '}
        {state.entryId && (
          <Link href={`/ledger/${ledgerId}/entries/${state.entryId}`} className="font-medium underline">
            view the entry
          </Link>
        )}{' '}
        <Link href={initial.readingId ? `/ledger/${ledgerId}/readings` : `/ledger/${ledgerId}/entries`}
              className="font-medium underline">{initial.readingId ? 'Back to AI' : 'Back to Journal'}</Link>
      </p>
    )
  }

  return (
    <div className="min-w-0">
      <FormError state={state} />
      {state.ok && (
        <p role="status" className="mt-4 rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          {state.ok}{' '}
          {state.entryId && (
            <Link href={`/ledger/${ledgerId}/entries/${state.entryId}`}
                  className="font-medium underline">
              view the entry
            </Link>
          )}{' '}
          The form is clear for the next one.
        </p>
      )}
      {/* Basic fields reflow; only the item columns keep their width. */}
      <form {...formProps} className="mt-6 space-y-4">
        <input type="hidden" name={F.ledgerId} value={ledgerId} />
        <input type="hidden" name={F.kind} value={kind} />
        {initial?.readingId && <input type="hidden" name={READING_FIELD} value={initial.readingId} />}

        <div className="form-grid quick-header">
          <div className="max-w-full">
            <label htmlFor="q-date" className={label}>Date</label>
            <DateInput id="q-date" name={F.entryDate} required
                   value={date} onChange={(e) => setDate(e.target.value)}
                   className={input} />
          </div>
          <div className="flex-1">
            <label htmlFor="q-desc" className={label}>Description</label>
            <input id="q-desc" name={F.description} type="text"
                   defaultValue={initial?.description ?? ''}
                   className={input} />
          </div>
          <div className="w-56">
            <span className={label}>{expense ? 'Supplier' : 'Customer'}</span>
            {/* The same box as the invoice's, from the same list and under the
                same headings — it was a second shape of one thing (owner,
                2026-09-07). Optional here, which the placeholder says. */}
            <Picker name={F.partyId} className="mt-1" defaultValue={initial?.partyId ?? ''}
                    ariaLabel={expense ? 'Supplier' : 'Customer'}
                    options={partyOptions(parties, expense ? 'suppliers' : 'customers')}
                    create={newParty && {
                      presentation: 'party',
                      title: expense ? 'New supplier' : 'New customer',
                      action: newParty.action,
                      hidden: {
                        ...newParty.hidden,
                        kind: 'organisation',
                        role: expense ? 'supplier' : 'customer',
                      },
                      fields: [{ name: 'name', label: 'Name', width: '15rem', takesTyped: true }],

                    }} />
          </div>
          {/* The number on THEIR paper. Optional, like the receipt itself —
              but the expenses browse has a column for it, and a receipt you
              can find again is worth ten seconds now (owner, 2026-09-03). */}
          <div className="w-48">
            <label htmlFor="q-ref" className={label}>
              {expense ? 'Their invoice #' : 'Their reference'}
            </label>
            <input id="q-ref" name={F.documentRef} type="text"
                   defaultValue={initial?.documentRef ?? ''}
                   className={input} />
          </div>
        </div>

        <div>
          <span className={label}>{expense ? 'Paid from' : 'Deposited to'}</span>
          <Picker name={F.bankAccountId} required className="mt-1"
                  value={paidFromAccountId} onChange={setPaidFromAccountId}
                  ariaLabel={expense ? 'Paid from' : 'Deposited to'}
                  options={bankAccounts.map((a) => ({
                    id: a.id,
                    label: `${a.code} — ${a.name}`,
                    group: a.account_type === 'liability' ? 'Credit cards and loans'
                      : a.cash_account ? 'Bank and cash'
                      : a.prepaid_expense ? 'Prepaid expenses' : 'Other assets',
                  }))}
                  create={newAccount && {
                    title: 'New bank account',
                    action: newAccount.action,
                    // A new bank account gets the cash role so it can be
                    // reconciled and offered on both quick-entry forms.
                    hidden: {
                      ...newAccount.hidden,
                      accountType: 'asset',
                      role_classification: 'cash_and_cash_equivalents',
                    },
                    fields: [
                      { name: 'code', label: 'Code', width: '6rem' },
                      { name: 'name', label: 'Name', width: '15rem', takesTyped: true },
                    ],

                  }} />
        </div>

        {shareholderLoan && (
          <div className="w-80 max-w-full">
            <span className={label}>Owed to shareholder / director</span>
            <Picker name={F.fundingPartyId} className="mt-1"
                    defaultValue={initial?.fundingPartyId ?? ''}
                    ariaLabel="Owed to shareholder or director"
                    options={bankPartyOptions(fundingParties, date, false)}
                    create={newParty && {
                      presentation: 'party',
                      title: 'New shareholder or director',
                      action: newParty.action,
                      hidden: { ...newParty.hidden, kind: 'person' },
                      fields: [
                        { name: 'name', label: 'Name', width: '15rem', takesTyped: true },
                        { name: 'role', label: 'Role', options: [
                          { value: 'shareholder', label: 'Shareholder' },
                          { value: 'director', label: 'Director' },
                        ] },
                      ],
                    }} />
          </div>
        )}

        {/* The items. One row is the coffee receipt; several are the store
            run that hit three accounts. Same line.{i}.* names the invoice
            form writes — one reader (lineIndicesIn) serves both. */}
        <div className="space-y-2">
          <div ref={orderRef} className="table-scroll" data-table-scroll tabIndex={0} role="region" aria-label="Entry line items"><div className="min-w-[60rem] space-y-2">
          <LineDragStatus id={helpId} message={message} />
          <div className={`${ROW} text-xs font-medium uppercase tracking-wide text-neutral-500`}>
            <span><span className="sr-only">Reorder</span></span>
            <span>{expense ? 'Expense account' : 'Income account'}</span>
            <span>Line description</span>
            <span className="text-right">Amount</span>
            <span>Tax</span>
            <span className={TAX_FIELDS_GRID}><span className="text-right">GST</span><span className="text-right">PST</span><span /></span>
            <span />
          </div>
          {rows.map((r, i) => (
            <div key={r.key} className={`${ROW} line-order-row`} data-line-row={r.key} {...rowProps(String(r.key))}
                 data-from-memory={r.fromMemory ? 'yes' : undefined}>
              <LineDragHandle index={i} {...handleProps(String(r.key))} />
              {/* Not `required`: the browser would then block the blank extra
                  row the server tolerates by design; every half-filled shape
                  is refused server-side, by name. */}
              <Picker name={lineAccount(i)} value={r.account ?? ''}
                      onChange={(account) => setRow(r.key, { account })}
                      ariaLabel="Account"
                      options={asOptions(plAccounts, expense ? 'expense' : 'revenue')}
                      create={lineCreate} />
              <input name={lineDescription(i)} type="text" aria-label="Line description"
                     value={r.description ?? ''}
                     onChange={(e) => setRow(r.key, { description: e.target.value })}
                     className={`${field} w-full`} />
              <input name={lineAmount(i)} type="text" inputMode="decimal"
                     aria-label="Amount" value={r.amount}
                     onChange={(e) => setRow(r.key, { amount: e.target.value })}
                     className={`${field} w-full text-right tabular-nums`} />
              <select name={lineTaxCode(i)} value={r.tax} aria-label="Tax"
                      onChange={(e) => setRow(r.key, { tax: e.target.value as TaxCode, gst: undefined, pst: undefined })}
                      className={`${field} w-full`}>
                {codes.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
              </select>
              <LineTaxes index={i} lineNumber={i + 1} amount={r.amount} code={r.tax}
                         inclusive={inclusive} on={date} gst={r.gst} pst={r.pst}
                         fieldClass={field} onChange={(tax, value) => setRow(r.key, { [tax]: value })}
                         onReset={() => setRow(r.key, { gst: undefined, pst: undefined })} />
              {/* A box filled from the books must not look like a box a
                  person chose (critic, 2026-09-07). */}
              <IconButton icon="delete" label={`Remove line ${i + 1}`} disabled={rows.length === 1 || pending}
                onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} />
            </div>
          ))}
          </div></div>
          <div className="flex flex-wrap items-end gap-4">
            <button type="button"
                    onClick={() => setRows((rs) => [...rs, { key: nextKey.current++, amount: '', tax: rs[rs.length - 1]?.tax ?? 'OUT_OF_SCOPE' }])}
                    className={QUIET}>
              Add line
            </button>
            <div className="w-40">
              <label htmlFor="q-amounts" className={label}>Amounts are</label>
              <select id="q-amounts" name={F.amounts} value={inclusive ? 'inclusive' : 'exclusive'}
                      onChange={(e) => setInclusive(e.target.value === 'inclusive')} className={input}>
                <option value="exclusive">before tax</option>
                <option value="inclusive">tax included</option>
              </select>
            </div>
          </div>
        </div>
        {rows.some((r) => r.fromMemory) && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            An account marked below was not read off the document — it is where this party&apos;s money
            went last time. Check it before posting.
          </p>
        )}
        {preview && (
          <p className="text-xs text-neutral-500" data-tax-preview>
            {expense ? 'Expense' : 'Revenue'} {money(expense ? preview.base + preview.pst : preview.base)}
            {preview.gst > 0n && <> · GST {money(preview.gst)}</>}
            {preview.pst > 0n && !expense && <> · PST {money(preview.pst)}</>}
            {preview.pst > 0n && expense && <> (includes PST {money(preview.pst)} — not claimable, part of the cost)</>}
            {' '}· bank moves {money(preview.total)}
          </p>
        )}
        {/* Only what the screen cannot show (owner, 2026-09-07). Where the
            GST lands is derived from this company's own roles and is visible
            in the entry a moment later; that a tag is MISSING, and why, is
            not visible anywhere. */}
        {(!gstAccount || (!expense && !pstAccount)) && (
          <p className="text-xs text-neutral-500">
            {!gstAccount && 'No GST tags: no account carries the GST role — register in the sales tax module first.'}
            {!expense && !pstAccount && ' No PST tags: register for PST first.'}
          </p>
        )}

        {/* The receipt, filed with the entry rather than on a second visit to
            a second screen (owner, 2026-09-07). It is filed AFTER the
            posting, so a store that refuses cannot lose the entry. */}
        <div>
          <label htmlFor="q-file" className={label}>Attachment</label>
          <input id="q-file" type="file" name={ATTACH_FIELD}
                 accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.gif,.tiff,application/pdf,image/*"
                 className="mt-1 block max-w-full text-xs text-neutral-600 file:mr-3 file:rounded file:border file:border-neutral-300 file:bg-transparent file:px-2 file:py-1 file:text-xs dark:text-neutral-400 dark:file:border-neutral-700" />
        </div>

        <div className="form-actions">
        <button type="submit" disabled={pending}
                className={BUTTON}>
          {pending ? 'Posting…' : expense ? 'Post expense' : 'Post income'}
        </button>
        </div>
      </form>
    </div>
  )
}
