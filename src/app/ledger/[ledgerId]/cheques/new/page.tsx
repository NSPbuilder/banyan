
import { PageHeading } from '@/components/DialogHeading'

import { ToolAction } from '@/components/ToolAction'
import { TOOL_BUTTON } from '@/lib/ui'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ActionForm } from '@/components/ActionForm'
import { ChequePayeeFields } from '@/components/ChequePayeeFields'
import { ReadingAside } from '@/components/ReadingAside'
import { Picker } from '@/components/Picker'
import { createAccountAction, createPartyAction } from '@/app/actions'
import { createChequeAction } from '../actions'
import { chequeById, chequeChoices, chequeParties, chequeSource } from '@/lib/cheques'
import { readingById, readingLabel } from '@/lib/bill-reading'
import { chequeInitialFrom } from '@/lib/prefill'
import { requireUser } from '@/lib/gate'
import { ledgerHead } from '@/lib/ledger-head'
import { localToday } from '@/lib/today'
import { formatMoney, moneyInput } from '@/lib/money'
import { BUTTON, FIELD } from '@/lib/ui'

export const dynamic = 'force-dynamic'

export default async function NewChequePage({ params, searchParams }: {
  params: Promise<{ ledgerId: string }>
  searchParams: Promise<{ entry?: string; stub?: string; reading?: string; copy?: string }>
}) {
  await requireUser()
  const { ledgerId } = await params
  const { entry, stub, reading: readingId, copy } = await searchParams
  const head = await ledgerHead(ledgerId)
  if (!head) notFound()
  const [[banks, expenses], source] = await Promise.all([
    chequeChoices(ledgerId),
    entry || stub ? chequeSource(ledgerId, { entryId: entry, stubId: stub }) : Promise.resolve(null),
  ])
  if ((entry || stub) && !source) notFound()
  const copied = copy ? await chequeById(ledgerId, copy) : null
  if (copy && !copied) notFound()
  const parties = source ? [] : await chequeParties(ledgerId, copied?.party_id ?? undefined)
  const today = localToday()
  const reading = !source && readingId ? await readingById(ledgerId, readingId) : null
  const readingNote = !source && readingId
    ? !reading ? 'That reading is not in these books; the form opened blank.'
      : reading.used_entry_id ? 'That reading has already been entered; the form opened blank.'
        : !reading.proposal ? `${readingLabel(reading)} could not be read; enter it by hand.` : null
    : null
  const initial = copied ? {
    chequeDate: copied.cheque_date,
    payee: copied.payee,
    payeeAddress: copied.payee_address,
    expenseAccountId: copied.expense_account_id ?? '',
    amount: moneyInput(BigInt(copied.amount)),
    memo: copied.memo,
    readingId: '',
    warning: copied.source_kind === 'manual' ? null
      : 'Saving this copy creates a new manual expense and cheque. Review the expense account before saving.',
  } : reading && !readingNote && reading.proposal
    ? chequeInitialFrom(reading.id, reading.proposal, expenses, today) : null
  const label = 'flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-neutral-500'
  return <main className="mx-auto max-w-3xl px-8 py-10 font-sans">
    <Link href={readingId ? `/ledger/${ledgerId}/readings` : `/ledger/${ledgerId}/cheques`}
      className={TOOL_BUTTON} title="Back"><ToolAction kind="back">{readingId ? 'Back to AI' : 'Back to Cheques'}</ToolAction></Link>
    <PageHeading className="mt-2" title={<>{source ? 'Issue cheque from transaction' : copied ? 'Copy cheque' : 'New cheque'}</>} />
    <p className="mt-1 text-sm text-neutral-500">{head.entity}</p>
    <p className="mt-1 text-sm text-neutral-500">The next cheque number is reserved when you issue a cheque from the selected bank account.</p>
    {source ? <>
      <div className="mt-6 rounded-lg border border-neutral-300 p-5 text-sm dark:border-neutral-700">
        <p className="font-medium">{source.payee}</p>
        <p className="mt-1 text-neutral-500">{source.source_entry_no} · {source.cheque_date} · {source.source_kind} · {formatMoney(BigInt(source.amount))}</p>
        <p className="mt-1 text-neutral-500">Bank account: {banks.find((b) => b.id === source.bank_account_id)?.name ?? source.bank_account_id}</p>
      </div>
      <ActionForm action={createChequeAction} submit="Issue cheque" working="Issuing…" className="mt-6 space-y-4" buttonClassName={BUTTON}>
        <input type="hidden" name="ledgerId" value={ledgerId} />
        <input type="hidden" name="source" value="transaction" />
        <input type="hidden" name="entryId" value={source.source_kind === 'payroll' ? '' : source.entry_id} />
        <input type="hidden" name="stubId" value={source.pay_stub_id ?? ''} />
        <label className={label}>First cheque number (only when this account has no previous cheque)
          <input name="firstNumber" inputMode="numeric" className={`${FIELD} max-w-40`} />
        </label>
      </ActionForm>
    </> : <>
      <p className="mt-5 text-sm text-neutral-500">A manual cheque posts an expense and a bank outflow together in the books when you create it.</p>
      {readingNote && <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">{readingNote}</p>}
      {reading && (initial || !reading.proposal) && <ReadingAside ledgerId={ledgerId} reading={reading} />}
      {initial?.warning && <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">{initial.warning}</p>}
      <ActionForm key={copy ?? readingId ?? 'manual'} action={createChequeAction} submit="Create expense and cheque" working="Creating…" className="mt-6 space-y-5" buttonClassName={BUTTON}>
        <input type="hidden" name="ledgerId" value={ledgerId} />
        <input type="hidden" name="source" value="manual" />
        {initial?.readingId && <input type="hidden" name="readingId" value={initial.readingId} />}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={label}>Bank account
            <Picker name="bankAccountId" required defaultValue={copied?.bank_account_id ?? ''} ariaLabel="Bank account"
              options={banks.map((b) => ({ id: b.id, label: `${b.code} — ${b.name}`, hint: `last #${b.last_number}` }))}
              create={{ title: 'New bank account', action: createAccountAction,
                hidden: { ledgerId, accountType: 'asset', role_classification: 'cash_and_cash_equivalents' },
                fields: [{ name: 'code', label: 'Code', width: '6rem' },
                  { name: 'name', label: 'Name', width: '15rem', takesTyped: true }],
                 }} />
          </label>
          <label className={label}>Expense account
            <Picker name="expenseAccountId" required defaultValue={initial?.expenseAccountId ?? ''}
              ariaLabel="Expense account"
              options={expenses.map((a) => ({ id: a.id, label: `${a.code} — ${a.name}` }))}
              create={{ title: 'New expense account', action: createAccountAction,
                hidden: { ledgerId, accountType: 'expense' },
                fields: [{ name: 'code', label: 'Code', width: '6rem' },
                  { name: 'name', label: 'Name', width: '15rem', takesTyped: true }],
                 }} />
          </label>
          <ChequePayeeFields parties={parties} ledgerId={ledgerId} initialDate={initial?.chequeDate ?? today}
            initialPayee={initial?.payee ?? ''} initialAddress={initial?.payeeAddress ?? ''}
            initialPartyId={copied?.party_id ?? ''}
            newParty={createPartyAction} />
          <label className={label}>Amount<input name="amount" inputMode="decimal" required
            defaultValue={initial?.amount ?? ''} className={FIELD} /></label>
          <label className={label}>First cheque number
            <input name="firstNumber" inputMode="numeric" className={FIELD} />
          </label>
        </div>
        <label className={label}>Memo<input name="memo" maxLength={500} defaultValue={initial?.memo ?? ''} className={FIELD} /></label>
      </ActionForm>
    </>}
  </main>
}
