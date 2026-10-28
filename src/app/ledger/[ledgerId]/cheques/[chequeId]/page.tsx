
import { PageHeading } from '@/components/DialogHeading'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActionForm } from '@/components/ActionForm'
import { DateInput } from '@/components/DateInput'
import { ChequePayeeFields } from '@/components/ChequePayeeFields'
import { Picker } from '@/components/Picker'
import { createAccountAction, createPartyAction } from '@/app/actions'
import { chequeById, chequeChoices, chequeParties } from '@/lib/cheques'
import { requireUser } from '@/lib/gate'
import { formatMoney } from '@/lib/money'
import { localToday } from '@/lib/today'
import { BUTTON, FIELD } from '@/lib/ui'
import { editChequeAction, voidChequeAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function ChequePage({ params, searchParams }: {
  params: Promise<{ ledgerId: string; chequeId: string }>
  searchParams: Promise<{ reading?: string }>
}) {
  await requireUser()
  const { ledgerId, chequeId } = await params
  const { reading } = await searchParams
  const c = await chequeById(ledgerId, chequeId)
  if (!c) notFound()
  const [[banks, expenses], parties] = await Promise.all([
    chequeChoices(ledgerId),
    c.source_kind === 'manual' ? chequeParties(ledgerId, c.party_id ?? undefined) : Promise.resolve([]),
  ])
  const live = c.status === 'issued' && c.source_status === 'posted' && c.source_matches
  const label = 'flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-neutral-500'
  return <main className="mx-auto max-w-3xl px-8 py-10 font-sans">
    <Link href={`/ledger/${ledgerId}/cheques`} className={TOOL_BUTTON} title="Back"><ToolAction kind="back">Back to Cheques</ToolAction></Link>
    <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
      <PageHeading title={<>Cheque {c.number}</>} />
      <Link href={`/ledger/${ledgerId}/cheques/new?copy=${c.id}`}
            className="text-xs text-neutral-500 underline">Copy</Link>
      {live && <a className={TOOL_BUTTON} href={`/ledger/${ledgerId}/cheques/${c.id}/pdf`} target="_blank" rel="noopener noreferrer" title="Download PDF"><ToolAction kind="pdf">Print cheque PDF</ToolAction></a>}
    </div>
    <p className="mt-1 text-sm text-neutral-500">
      {c.source_kind} · {c.source_entry_no} · {c.bank_code} — {c.bank_name}
      {c.status === 'void' ? ' · Void' : c.source_status !== 'posted' ? ' · Source cancelled' : !c.source_matches ? ' · Source changed' : ' · Issued'}
    </p>
    {reading === 'unfiled' && <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      The cheque and expense were posted, but the AI reading could not be filed against the entry.
      Check whether the reading was already entered, and <Link href={`/ledger/${ledgerId}/entries/${c.entry_id}`} className="underline">attach its document to the journal entry</Link> if needed.
    </p>}
    {live && <div className="mt-4 rounded-md border border-neutral-300 p-3 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">
      <p>Print at 100% / Actual size on Letter paper with bank-approved top-position 8.5 × 3.5 in preprinted cheque stock and its magnetic MICR line. Check alignment and match the cheque number to the stock before issuing.</p>

    </div>}
    {c.pay_run_id && c.employee_id && <p className="mt-3 text-sm">
      <a className={TOOL_BUTTON} target="_blank" rel="noopener noreferrer"
         href={`/ledger/${ledgerId}/payroll/runs/${c.pay_run_id}/${c.employee_id}/pdf`} title="Download PDF"><ToolAction kind="pdf">Pay stub PDF</ToolAction></a>
    </p>}
    {live ? <>
      <h2 id="edit-cheque" className="mt-9 font-semibold">Edit cheque</h2>
      {c.source_kind === 'manual'
        ? <p className="mt-1 text-xs text-neutral-500">Changing the bank, expense account, amount or date updates the linked expense while its period is open. A different bank uses that account&apos;s next cheque number.</p>
        : c.source_kind === 'expense'
          ? <p className="mt-1 text-xs text-neutral-500">The bank account can be corrected here while the expense period is open. To change the expense account or amount, <Link className="underline" href={`/ledger/${ledgerId}/entries/${c.entry_id}`}>edit the source expense</Link>. If its amount changes, void this stale cheque and issue a replacement.</p>
          : <p className="mt-1 text-xs text-neutral-500">The bank account and amount belong to the {c.source_kind === 'payment' ? 'invoice payment' : 'pay run'}. Void this cheque and correct the source transaction to change them.</p>}
      <ActionForm action={editChequeAction} submit="Save changes" working="Saving…" className="mt-5 space-y-5" buttonClassName={BUTTON}>
        <input type="hidden" name="ledgerId" value={ledgerId} />
        <input type="hidden" name="chequeId" value={c.id} />
        <div className="grid gap-4 sm:grid-cols-2">
          {(c.source_kind === 'manual' || c.source_kind === 'expense') && <label className={label}>Bank account
            <Picker name="bankAccountId" required defaultValue={c.bank_account_id} ariaLabel="Bank account"
              options={[
                ...(!banks.some((b) => b.id === c.bank_account_id)
                  ? [{ id: c.bank_account_id, label: `${c.bank_code} — ${c.bank_name}`, hint: 'current' }] : []),
                ...banks.map((b) => ({ id: b.id, label: `${b.code} — ${b.name}`, hint: `last #${b.last_number}` })),
              ]}
              create={{ title: 'New bank account', action: createAccountAction,
                hidden: { ledgerId, accountType: 'asset', role_classification: 'cash_and_cash_equivalents' },
                fields: [{ name: 'code', label: 'Code', width: '6rem' },
                  { name: 'name', label: 'Name', width: '15rem', takesTyped: true }],
                 }} />
          </label>}
          {c.source_kind === 'manual' && <label className={label}>Expense account
            <Picker name="expenseAccountId" required defaultValue={c.expense_account_id ?? ''}
              ariaLabel="Expense account"
              options={[
                ...(c.expense_account_id && !expenses.some((a) => a.id === c.expense_account_id)
                  ? [{ id: c.expense_account_id, label: c.expense_account_label ?? 'Current expense account', hint: 'current' }] : []),
                ...expenses.map((a) => ({ id: a.id, label: `${a.code} — ${a.name}` })),
              ]}
              create={{ title: 'New expense account', action: createAccountAction,
                hidden: { ledgerId, accountType: 'expense' },
                fields: [{ name: 'code', label: 'Code', width: '6rem' },
                  { name: 'name', label: 'Name', width: '15rem', takesTyped: true }],
                 }} />
          </label>}
          {c.source_kind === 'manual' && <ChequePayeeFields parties={parties} ledgerId={ledgerId}
            initialDate={c.cheque_date} newParty={createPartyAction} initialPartyId={c.party_id ?? ''}
            initialPayee={c.payee} initialAddress={c.payee_address} />}
          <label className={label}>Cheque number<input name="number" required inputMode="numeric" defaultValue={c.number} className={FIELD} /></label>
          {c.source_kind !== 'manual' && <label className={label}>Date<DateInput name="chequeDate" required defaultValue={c.cheque_date} className={FIELD} /></label>}
          {c.source_kind !== 'manual' && <label className={label}>Payee name on cheque<input name="payee" required maxLength={200} defaultValue={c.payee} className={FIELD} /></label>}
          <label className={label}>Amount
            <input name="amount" required inputMode="decimal" defaultValue={formatMoney(BigInt(c.amount))}
                   readOnly={c.source_kind !== 'manual'} className={FIELD} />
          </label>
        </div>
        {c.source_kind !== 'manual' && <label className={label}>Payee address (on cheque)<textarea name="payeeAddress" maxLength={300} rows={3} defaultValue={c.payee_address} className={FIELD} /></label>}
        <label className={label}>Memo<input name="memo" maxLength={500} defaultValue={c.memo} className={FIELD} /></label>
      </ActionForm>
    </> : <p className="mt-8 text-sm text-neutral-500">This cheque cannot be printed or edited. {c.void_reason}</p>}
    {c.status === 'issued' && <>
      <h2 className="mt-12 font-semibold text-red-800 dark:text-red-300">Void cheque</h2>
      <p className="mt-1 text-xs text-neutral-500">
        {!c.source_matches || c.source_status !== 'posted'
          ? 'The source transaction changed or was cancelled. Voiding reserves this cheque number and leaves the current books as they are.'
          : c.source_kind === 'payroll'
          ? 'Voiding this cheque reverses the entire pay run and all cheques from that run.'
          : 'Voiding this cheque cancels its payment in the books and reserves the number. A closed period is corrected by a reversal.'}
        {' '}If the paper cheque may leave your control, ask your bank about stop payment as well.
      </p>
      <ActionForm action={voidChequeAction} submit="Void cheque" working="Voiding…"
                  className="mt-4 space-y-3" buttonClassName="rounded bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800">
        <input type="hidden" name="ledgerId" value={ledgerId} />
        <input type="hidden" name="chequeId" value={c.id} />
        <label className={label}>Reason<input name="reason" required maxLength={500} className={FIELD} /></label>
        <label className={label}>Reversal date (if the original period is closed)
          <DateInput name="reversalDate" defaultValue={localToday()} required className={FIELD} />
        </label>
      </ActionForm>
    </>}
  </main>
}
