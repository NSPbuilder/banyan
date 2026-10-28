import { FxCopyRefusal } from '../../fx/FxDetail'
import { PageHeader } from '@/components/PageHeader'
import { notFound } from 'next/navigation'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { transactingParties } from '@/lib/parties'
import { EntryForm, type AccountOption } from '../EntryForm'
import { localToday } from '@/lib/today'
import { ours } from '@/lib/ours'
import type { LineDraft } from '../EntryForm'
import { moneyInput } from '@/lib/money'

/**
 * A new journal entry, body only — the full page and the overlay both render
 * exactly this (the one-renderer rule applied to screens).
 */
export async function NewEntryBody({ ledgerId, copyId }: { ledgerId: string; copyId?: string }) {
  const [head] = await db.execute<{ entity: string; entity_id: string; suggested: string | null }>(sql`
    SELECT e.name AS entity, e.id::text AS entity_id,
           (SELECT max(fp.end_date)::text FROM fiscal_period fp
             WHERE fp.ledger_id = l.id AND fp.status = 'open') AS suggested
      FROM ledger l JOIN entity e ON e.id = l.entity_id WHERE l.id = ${ledgerId}::uuid`)
  if (!head) notFound()

  const accounts = await db.execute<AccountOption>(sql`
    SELECT id::text, code, name FROM account
     WHERE entity_id = ${head.entity_id}::uuid AND is_postable AND is_active
     ORDER BY code`)

  const parties = await transactingParties(head.entity_id)

  const today = localToday()
  // Default to today unless every open period ends earlier, in which case the
  // last open day is the only date that could be posted.
  const initialDate = head.suggested && head.suggested < today ? head.suggested : today
  if (copyId && !(await ours('entry', copyId, ledgerId))) notFound()
  if (copyId && (await db.execute(sql`SELECT 1 FROM journal_line WHERE entry_id=${copyId}::uuid AND original_currency IS NOT NULL LIMIT 1`)).length) return <FxCopyRefusal ledgerId={ledgerId} />
  const [source] = copyId ? await db.execute<{
    entry_date: string; description: string; document_ref: string | null
  }>(sql`SELECT entry_date::text, description, document_ref FROM journal_entry
         WHERE id = ${copyId}::uuid AND ledger_id = ${ledgerId}::uuid`) : []
  const sourceLines = copyId ? await db.execute<{
    account_id: string; debit: string; credit: string; description: string | null; party_id: string | null
  }>(sql`SELECT account_id::text, debit::text, credit::text, description, party_id::text
         FROM journal_line WHERE entry_id = ${copyId}::uuid ORDER BY line_no`) : []
  const initialLines: LineDraft[] = sourceLines.map((line) => ({
    accountId: line.account_id,
    debit: line.debit === '0' ? '' : moneyInput(BigInt(line.debit)),
    credit: line.credit === '0' ? '' : moneyInput(BigInt(line.credit)),
    description: line.description ?? '', partyId: line.party_id ?? '',
  }))

  return (
    <>
      <PageHeader title={source ? 'Copy entry' : 'New entry'} />

      <EntryForm key={copyId ?? 'new'} ledgerId={ledgerId} accounts={accounts} parties={parties}
                 initialDate={source?.entry_date ?? initialDate}
                 initialDescription={source?.description}
                 initialDocumentRef={source?.document_ref ?? undefined}
                 initialLines={initialLines.length ? initialLines : undefined} />
    </>
  )
}
