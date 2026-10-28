import { FxCopyRefusal } from '../../../fx/FxDetail'

import { PageHeading } from '@/components/DialogHeading'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { quickAccountsFor, type QuickKind } from '@/lib/quick'
import { localToday } from '@/lib/today'
import { readingById, readingLabel, rememberedAccount } from '@/lib/bill-reading'
import { quickInitialFrom, type QuickInitial } from '@/lib/prefill'
import { ReadingAside } from '@/components/ReadingAside'
import { createAccountAction, createPartyAction, quickEntryAction } from '@/app/actions'
import { partyChoices, transactingPartyRoles } from '@/lib/parties'
import { entityOfLedger } from '@/lib/access'
import { QuickForm } from './QuickForm'
import { ours } from '@/lib/ours'
import { db } from '@/db/client'
import { sql } from 'drizzle-orm'
import { moneyInput } from '@/lib/money'

/**
 * Quick expense/income, body only — the full page and the overlay both render
 * exactly this (the one-renderer rule applied to screens).
 */
export async function QuickBody({
  ledgerId, kind, readingId, copyId,
}: { ledgerId: string; kind: string; readingId?: string; copyId?: string }) {
  if (kind !== 'expense' && kind !== 'income') notFound()
  const expense = kind === 'expense'

  const { plAccounts, bankAccounts, gstAccount, pstAccount } =
    await quickAccountsFor(ledgerId, kind as QuickKind)
  const today = localToday()
  // Who this company transacts with, for the Party box. Asked AS AT TODAY,
  // which is the date the form opens on; 0025 still has the last word on
  // whether the one chosen may transact on the date finally typed.
  const entityId = await entityOfLedger(ledgerId)
  const parties = entityId
    ? await partyChoices(entityId, today)
    : { customers: [], suppliers: [] }
  const fundingParties = expense && entityId
    ? (await transactingPartyRoles(entityId)).filter((p) => p.role === 'shareholder' || p.role === 'director')
    : []

  // A reading (0064; a sentence alone since 0077), opening this form filled
  // in — an expense, or since 2026-09-15 income. The reading must be this
  // company's and not yet entered; otherwise the form opens blank and says why.
  const reading = readingId ? await readingById(ledgerId, readingId) : null
  let initial: QuickInitial | undefined
  let readingNote: string | null = null
  if (readingId) {
    if (!reading) readingNote = 'That reading is not in these books; the form opened blank.'
    else if (reading.used_entry_id !== null) readingNote = 'That reading has already been entered; the form opened blank.'
    else if (!reading.proposal) readingNote = `${readingLabel(reading)} could not be read; enter it by hand${reading.filename ? ' from the picture' : ''}.`
    else {
      // Where this party's money went last time, for a line the model could
      // not place — of this form's own type (bill-reading.ts, `rememberedAccount`).
      const remembered = await rememberedAccount(
        ledgerId, reading.proposal.party, expense ? 'expense' : 'revenue', plAccounts.map((a) => a.id))
      initial = quickInitialFrom(kind as QuickKind, reading.id, reading.proposal, plAccounts, today, remembered,
                                 expense ? parties.suppliers : parties.customers)
    }
  }
  if (copyId) {
    if (!(await ours('entry', copyId, ledgerId))) notFound()
    if ((await db.execute(sql`SELECT 1 FROM journal_line WHERE entry_id=${copyId}::uuid AND original_currency IS NOT NULL LIMIT 1`)).length) return <FxCopyRefusal ledgerId={ledgerId} />
    const [source] = await db.execute<{
      entry_date: string; description: string; document_ref: string | null; source_type: string
    }>(sql`SELECT entry_date::text, description, document_ref, source_type
           FROM journal_entry WHERE id = ${copyId}::uuid AND ledger_id = ${ledgerId}::uuid`)
    if (!source || source.source_type !== `quick_${kind}`) notFound()
    const lines = await db.execute<{
      account_id: string; amount: string; description: string | null; party_id: string | null
    }>(sql`SELECT account_id::text, amount::text, description, party_id::text
           FROM journal_line WHERE entry_id = ${copyId}::uuid ORDER BY line_no`)
    const funding = lines[0]
    if (!funding || lines.length < 2) notFound()
    initial = {
      entryDate: source.entry_date, description: source.description,
      documentRef: source.document_ref ?? '',
      bankAccountId: funding.account_id,
      fundingPartyId: expense ? funding.party_id ?? '' : '',
      partyId: lines.slice(1).find((line) => line.party_id)?.party_id ?? '',
      rows: lines.slice(1).map((line) => ({
        accountId: line.account_id, description: line.description ?? '',
        amount: moneyInput(BigInt(line.amount) * (expense ? 1n : -1n)),
        tax: 'OUT_OF_SCOPE' as const, fromMemory: false,
      })),
      inclusive: false, readingId: '',
    }
  }

  return (
    <>
      <PageHeading className="mt-2" title={<>
        {copyId ? (expense ? 'Copy expense' : 'Copy income') : (expense ? 'New expense' : 'New income')}
      </>} />

      {plAccounts.length === 0 ? (
        <p className="mt-6 rounded border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          This company has no postable account yet.{' '}
          <Link href={`/ledger/${ledgerId}/accounts`} className="underline">Build the chart of accounts</Link> first.
        </p>
      ) : bankAccounts.length === 0 ? (
        <p className="mt-6 rounded border border-dashed border-neutral-300 p-6 text-sm text-neutral-500 dark:border-neutral-700">
          {expense
            ? 'Nothing here for Paid from — no active asset or liability account.'
            : 'Nothing here for the deposit — no bank account, credit card or loan.'}{' '}
          <Link href={`/ledger/${ledgerId}/accounts`} className="underline">Add one to the chart of accounts</Link> first.
        </p>
      ) : (
        <>
          {readingNote && (
            <p className="mt-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {readingNote}
            </p>
          )}
          {reading && (initial || readingNote?.startsWith(readingLabel(reading))) && (
            <ReadingAside ledgerId={ledgerId} reading={reading} />
          )}
          <QuickForm key={copyId ?? readingId ?? 'new'}
            ledgerId={ledgerId}
            kind={kind}
            today={today}
            plAccounts={plAccounts}
            bankAccounts={bankAccounts}
            gstAccount={gstAccount}
            pstAccount={pstAccount}
            initial={initial}
            action={quickEntryAction}
            newAccount={{ action: createAccountAction, hidden: { ledgerId } }}
            parties={parties}
            fundingParties={fundingParties}
            newParty={{ action: createPartyAction, hidden: { ledgerId } }}
          />
        </>
      )}
    </>
  )
}
