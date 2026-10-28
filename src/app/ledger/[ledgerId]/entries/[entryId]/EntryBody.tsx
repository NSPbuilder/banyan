import { FxEntryDetail } from '../../fx/FxDetail'

import { PageHeader } from '@/components/PageHeader'
import { SourcePapers,MigrationSources } from '@/components/SourcePapers'
import { EditLease } from '@/components/EditLease'
import { moneyInput } from '@/lib/money'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ActionForm } from '@/components/ActionForm'
import { deleteEntryAction } from '@/app/actions'
import { OPEN_EDIT_SOURCES } from '@/lib/posting'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { transactingParties } from '@/lib/parties'
import { EntryForm, type AccountOption, type LineDraft } from '../EntryForm'
import { DiscardButton } from './DiscardButton'
import { CorrectEntry } from './CorrectEntry'
import { Attachments } from './Attachments'
import { DANGER, QUIET, FIELD } from '@/lib/ui'
import { chequeSource } from '@/lib/cheques'
import { moduleFinanceView } from '@/lib/module-extensions'
import { requireUser } from '@/lib/gate'
import { paymentReceiptAvailable } from '@/lib/receipts'
import { ReceiptLinks } from '@/components/ReceiptLinks'

/**
 * One journal entry, body only — the full page and the overlay the
 * intercepting route floats over whatever screen linked here both render
 * exactly this (the one-renderer rule applied to screens).
 */
export async function EntryBody({
  ledgerId, entryId,
}: { ledgerId: string; entryId: string }) {

  const [entry] = await db.execute<{
    version: string; id: string; entity_id: string; entity: string; entry_no: string | null
    entry_date: string; description: string
    document_ref: string | null; status: string
    source_type: string; period_name: string | null; period_status: string | null
    reversed_by: string | null; replaced_by: string | null
    reverses: string | null
  }>(sql`
    SELECT je.version::text, je.id::text, e.id::text AS entity_id, e.name AS entity, je.entry_no,
           je.entry_date::text, je.description, je.document_ref,
           je.status, je.source_type,
           fp.name AS period_name, fp.status AS period_status,
           (SELECT r.entry_no FROM journal_entry r WHERE r.id = je.reversed_by_id) AS reversed_by,
           (SELECT r.entry_no FROM journal_entry r WHERE r.replaces_id = je.id AND r.status <> 'draft' LIMIT 1) AS replaced_by,
           (SELECT r.entry_no FROM journal_entry r WHERE r.id = je.reverses_id) AS reverses
      FROM journal_entry je
      JOIN ledger l ON l.id = je.ledger_id
      JOIN entity e ON e.id = l.entity_id
      LEFT JOIN fiscal_period fp ON fp.id = je.period_id
     WHERE je.id = ${entryId}::uuid AND je.ledger_id = ${ledgerId}::uuid`)
  if (!entry) notFound()
  if ((await db.execute(sql`SELECT 1 FROM journal_line WHERE entry_id=${entryId}::uuid AND original_currency IS NOT NULL LIMIT 1`)).length) {
    return <FxEntryDetail ledgerId={ledgerId} entryId={entryId} number={entry.entry_no} date={entry.entry_date} description={entry.description} status={entry.status}/>
  }
  const hasReceipt = ['payment', 'quick_income', 'quick_expense'].includes(entry.source_type)
    && await paymentReceiptAvailable(ledgerId, entryId)
  const chequeCandidate = entry.status === 'posted' && ['quick_expense', 'payment'].includes(entry.source_type)
  const [existingCheque] = chequeCandidate ? await db.execute<{ id: string }>(sql`
    SELECT id::text FROM cheque WHERE ledger_id = ${ledgerId}::uuid
      AND entry_id = ${entryId}::uuid AND status = 'issued' LIMIT 1`) : []
  const canIssueCheque = chequeCandidate && !existingCheque
    && !!(await chequeSource(ledgerId, { entryId }))

  const [accounts, rows] = await Promise.all([
    db.execute<AccountOption>(sql`
      SELECT id::text, code, name FROM account
       WHERE entity_id = ${entry.entity_id}::uuid AND is_postable AND is_active ORDER BY code`),
    db.execute<{ account_id: string; debit: string; credit: string; description: string | null
      party_id: string | null }>(sql`
      SELECT account_id::text, debit::text, credit::text, description, party_id::text
        FROM journal_line WHERE entry_id = ${entryId}::uuid ORDER BY line_no`),
  ])
  const parties = await transactingParties(entry.entity_id)

  const initialLines: LineDraft[] = rows.map((r) => ({
    accountId: r.account_id,
    debit: r.debit === '0' ? '' : moneyInput(BigInt(r.debit)),
    credit: r.credit === '0' ? '' : moneyInput(BigInt(r.credit)),
    description: r.description ?? '',
    partyId: r.party_id ?? '',
  }))

  const sourceView = await moduleFinanceView({type:'entry',id:entryId,ledgerId,entityId:entry.entity_id,sourceType:entry.source_type,user:await requireUser()})
  const isDraft = entry.status === 'draft'
  // The open-books door: a live entry from an in-here source, in an open
  // period, not half of a correction pair, is edited and deleted right here.
  // Everything else keeps the read-only view and the reverse-and-replace
  // correction. The lib re-checks every one of these gates with sentences.
  const openEditable = !sourceView.managed && entry.status === 'posted'
    && OPEN_EDIT_SOURCES.includes(entry.source_type as (typeof OPEN_EDIT_SOURCES)[number])
    && entry.period_status === 'open'
    && !entry.reverses && !entry.reversed_by

  return (
    <>
      <PageHeader title={isDraft ? 'Draft' : entry.entry_no}>
        {hasReceipt && <ReceiptLinks href={`/ledger/${ledgerId}/entries/${entryId}/receipt`} />}

        {!sourceView.blocksCopy&&<Link href={entry.source_type === 'quick_expense' || entry.source_type === 'quick_income'
          ? `/ledger/${ledgerId}/entries/quick/${entry.source_type === 'quick_expense' ? 'expense' : 'income'}?copy=${entryId}`
          : `/ledger/${ledgerId}/entries/new?copy=${entryId}`}
              className={QUIET}>
          Copy
        </Link>}
        {isDraft && <DiscardButton ledgerId={ledgerId} entryId={entryId} version={entry.version} />}
        {openEditable && (
          <ActionForm action={deleteEntryAction} submit="Delete it" working="…"
                      className="flex flex-wrap items-center gap-2" buttonClassName={DANGER}>
            <input type="hidden" name="ledgerId" value={ledgerId} />
            <input type="hidden" name="entryId" value={entryId} />
            <EditLease passive resource={{ledgerId,type:'entry',id:entryId}} version={entry.version} />
            <label className="text-xs text-neutral-500">
              Reason
              <input name="reason" required maxLength={500}
                     className={`${FIELD} ml-2 w-field-short`} />
            </label>
          </ActionForm>
        )}
      </PageHeader>
      <p className="mt-1 text-sm text-neutral-500">
        {isDraft
          ? 'Not in any balance or statement until it is posted.'
          : openEditable
            ? `In ${entry.period_name}, which is open — editable and deletable here until the month closes.`
            : `Posted in ${entry.period_name}.`}
        {entry.reverses && (
          <> This entry reverses <span className="font-mono">{entry.reverses}</span>.</>
        )}
      </p>
      {sourceView.panels}
      {(canIssueCheque || existingCheque) && (
        <p className="mt-3 text-sm"><Link className="inline-block rounded border border-neutral-300 px-3 py-2 font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900" href={existingCheque
          ? `/ledger/${ledgerId}/cheques/${existingCheque.id}`
          : `/ledger/${ledgerId}/cheques/new?entry=${entryId}`}>
          {existingCheque ? 'Open cheque' : 'Make cheque from this transaction'}
        </Link></p>
      )}

      <EntryForm ledgerId={ledgerId} entryId={entryId} version={entry.version} accounts={accounts} parties={parties}
                 initialDate={entry.entry_date} initialDescription={entry.description}
                 initialDocumentRef={entry.document_ref ?? undefined} initialLines={initialLines}
                 posted={!isDraft && !openEditable}
                 mode={openEditable ? 'edit' : 'draft'} />

      {!isDraft && !openEditable && !sourceView.managed && !sourceView.blocksCopy && (
        <CorrectEntry ledgerId={ledgerId} entryId={entryId} version={entry.version} entryNo={entry.entry_no ?? ''}
                      accounts={accounts} parties={parties} entryDate={entry.entry_date}
                      description={entry.description} documentRef={entry.document_ref ?? undefined}
                      lines={initialLines}
                      reversedBy={entry.reversed_by} replacedBy={entry.replaced_by}
                      amendable={entry.source_type !== 'payroll'} />
      )}

      <Attachments ledgerId={ledgerId} entryId={entryId} />
      <SourcePapers ledgerId={ledgerId} type="entry" id={entryId}/>
      <MigrationSources ledgerId={ledgerId} type="entry" id={entryId}/>
    </>
  )
}
