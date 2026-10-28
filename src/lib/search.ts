import 'server-only'
import { sql } from 'drizzle-orm'
import { invoicePath } from '@/lib/invoice-routes'
import { db } from '@/db/client'
import { like, readQuery, type Query } from './query'
import { journalEntries } from './reports'
import { moduleSearchGroups } from './module-extensions'

/**
 * Search: one box, everything the books know (owner, 2026-09-03).
 *
 * DERIVED ON THE SPOT. There is no search index and no `search_document`
 * table, and that is a decision rather than a shortcut. A maintained index
 * would be a third CACHE beside `period_balance` and the attachment tree,
 * and every cache in this repository has needed an integrity sweep and a
 * rebuild button to stay honest. At this size it buys nothing: a decade of
 * a busy small company is tens of thousands of rows, and scanning them for
 * a substring is milliseconds. If that ever stops being true the answer is
 * an index on the columns below — still not a copy of them.
 *
 * TWO RULES CARRY THE WHOLE FEATURE.
 *
 * 1. What a query MEANS is decided ONCE, in `query.ts`, and the journal
 *    page's own search box reads it from there too. "1498" is a word to look
 *    for, and it is also $1,498.00, and it is also 1,498 cents — money lives
 *    here as integer cents, so the reader who types the figure they saw on
 *    screen and the reader who types the number they remember must both find
 *    it. Every section below is handed the same parsed query; none of them
 *    re-decides. The ENTRY section is not even here: it is `journalEntries`,
 *    the same reader the journal page renders, so the two pages cannot
 *    disagree about WHICH entries match. How MANY they show is each page's
 *    own business — a search page shows a top handful, a journal shows a
 *    hundred — and `SR7` compares them at the same limit for that reason.
 *
 * 2. It NEVER LEAVES THE LEDGER. Companies never mix — that is a frozen
 *    decision, and this is the one screen whose job is to reach everywhere,
 *    so it is the one screen that could break it. Every read below is bound
 *    to the ledger, or to the entity that ledger belongs to; `SR9` searches
 *    two companies for a word they share and refuses any crossing.
 */

export type HitKind =
  | 'Entry' | 'Account' | 'Party' | 'Document'
  | 'Bank line' | 'Shares' | 'Minute book' | 'Attachment'
  | 'Employee' | 'Pay run' | 'SR&ED' | 'Registration' | 'Reading'

export type Hit = {
  kind: HitKind
  /** What it is, in the words the books use. */
  title: string
  /** Where and when — the line under the title. */
  detail: string
  date: string | null
  /** Signed cents, when the thing has an amount. */
  amount: string | null
  /** Relative to /ledger/[ledgerId]. */
  href: string
}

/** Everything the books know that answers to this query. */
export async function search(
  ledgerId: string, raw: string, limit = 25,
): Promise<{ query: Query; hits: Hit[] }> {
  const query = readQuery(raw)
  if (!query.text) return { query, hits: [] }

  // Five kinds were unfindable until 2026-09-13 (whole-project audit): a
  // person, a pay run, an SR&ED project, a tax registration, a bill reading.
  const [entries, accounts, parties, documents, bank, attachments, registrations, readings, extensions] =
    await Promise.all([
      journalEntries(ledgerId, { q: query, status: 'posted', limit }),
      matchingAccounts(ledgerId, query, limit),
      matchingParties(ledgerId, query, limit),
      matchingDocuments(ledgerId, query, limit),
      matchingBankLines(ledgerId, query, limit),
      matchingAttachments(ledgerId, query, limit),
      matchingRegistrations(ledgerId, query, limit),
      matchingReadings(ledgerId, query, limit),
      moduleSearchGroups(ledgerId, query, limit),
    ])
  const drafts = await journalEntries(ledgerId, { q: query, status: 'draft', limit })

  const hits: Hit[] = []
  for (const e of [...drafts, ...entries]) {
    hits.push({
      kind: 'Entry',
      title: e.description,
      detail: [e.entry_no ?? 'draft', e.status, ...e.accounts].filter(Boolean).join(' · '),
      date: e.entry_date,
      amount: e.total,
      href: `/entries/${e.id}`,
    })
  }
  const groups = [
    { order: 10, hits: accounts }, { order: 20, hits: parties },
    { order: 30, hits: documents }, { order: 40, hits: bank },
    { order: 70, hits: attachments }, { order: 110, hits: registrations },
    { order: 120, hits: readings }, ...extensions,
  ]
  hits.push(...groups.sort((a, b) => a.order - b.order).flatMap(group => group.hits))
  return { query, hits }
}

/** The chart. Entity-scoped through the ledger, like every account read. */
async function matchingAccounts(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const rows = await db.execute<{ id: string; code: string; name: string; type: string }>(sql`
    SELECT a.id::text, a.code, a.name, a.account_type::text AS type
      FROM account a
     WHERE a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
       AND (a.code ILIKE ${like(q)} ESCAPE '\\' OR a.name ILIKE ${like(q)} ESCAPE '\\')
     ORDER BY a.code
     LIMIT ${limit}`)
  return rows.map((a) => ({
    kind: 'Account' as const,
    title: `${a.code} — ${a.name}`,
    detail: a.type,
    date: null,
    amount: null,
    href: `/accounts/${a.id}`,
  }))
}

/** Parties are global; only those with a role in THIS company are ours. */
async function matchingParties(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const rows = await db.execute<{ id: string; name: string; kind: string; roles: string[] }>(sql`
    SELECT p.id::text, p.name, p.kind,
           array_remove(array_agg(DISTINCT pr.role), NULL) AS roles
      FROM party p
      JOIN party_role pr ON pr.party_id = p.id
       AND pr.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
     WHERE p.name ILIKE ${like(q)} ESCAPE '\\'
     GROUP BY p.id, p.name, p.kind
     ORDER BY p.name
     LIMIT ${limit}`)
  return rows.map((p) => ({
    kind: 'Party' as const,
    title: p.name,
    detail: [p.kind, ...p.roles].join(' · '),
    date: null,
    amount: null,
    href: `/parties/${p.id}`,
  }))
}

/** Invoices and credit notes, by either side's number or by their note. */
async function matchingDocuments(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const rows = await db.execute<{
    id: string; number: string | null; their_ref: string | null; direction: string
    document_kind: string; issued_on: string; party: string; note: string | null
    total: string
  }>(sql`
    SELECT i.id::text, i.number, i.their_ref, i.direction, i.document_kind,
           i.issued_on::text, p.name AS party, i.note,
           (CASE WHEN (i.direction = 'sales') = (i.document_kind = 'invoice')
                 THEN -1 ELSE 1 END
            * COALESCE((SELECT sum(il.amount) FROM invoice_line il
                         WHERE il.invoice_id = i.id), 0))::text AS total
      FROM invoice i JOIN party p ON p.id = i.party_id
     WHERE i.ledger_id = ${ledgerId}::uuid
       AND (i.number ILIKE ${like(q)} ESCAPE '\\'
            OR i.their_ref ILIKE ${like(q)} ESCAPE '\\'
            OR i.note ILIKE ${like(q)} ESCAPE '\\'
            OR p.name ILIKE ${like(q)} ESCAPE '\\'
            OR ${q.date ? sql`i.issued_on = ${q.date}::date` : sql`false`}
            OR ${q.cents.length > 0
                  ? sql`abs(COALESCE((SELECT sum(il.amount) FROM invoice_line il
                                       WHERE il.invoice_id = i.id), 0)) IN ${q.cents}`
                  : sql`false`})
     ORDER BY i.issued_on DESC
     LIMIT ${limit}`)
  return rows.map((i) => ({
    kind: 'Document' as const,
    title: `${i.number ?? i.their_ref ?? 'unnumbered'} — ${i.party}`,
    detail: [i.direction === 'sales' ? 'sales' : 'purchase',
             i.document_kind.replace('_', ' '), i.note ?? null].filter(Boolean).join(' · '),
    date: i.issued_on,
    amount: i.total,
    href: invoicePath(i.direction === 'purchase' ? 'purchase' : 'sales', i.id),
  }))
}

/** What the bank said, in the bank's own words. */
async function matchingBankLines(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const rows = await db.execute<{
    id: string; account_id: string; code: string; txn_date: string
    description: string; amount: string
  }>(sql`
    SELECT b.id::text, b.account_id::text, a.code, b.txn_date::text, b.description,
           b.amount::text
      FROM bank_transaction b
      JOIN account a ON a.id = b.account_id
     WHERE a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
       AND (b.description ILIKE ${like(q)} ESCAPE '\\'
            OR b.source_file ILIKE ${like(q)} ESCAPE '\\'
            OR ${q.date ? sql`b.txn_date = ${q.date}::date` : sql`false`}
            OR ${q.cents.length > 0 ? sql`abs(b.amount) IN ${q.cents}` : sql`false`})
     ORDER BY b.txn_date DESC
     LIMIT ${limit}`)
  return rows.map((b) => ({
    kind: 'Bank line' as const,
    title: b.description,
    detail: `bank ${b.code}`,
    date: b.txn_date,
    amount: b.amount,
    href: `/bank/${b.account_id}`,
  }))
}

/** Paper, by the name of the file it arrived as. */
async function matchingAttachments(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const rows = await db.execute<{
    id: string; entry_id: string; filename: string; note: string | null
    entry_no: string | null; entry_date: string
  }>(sql`
    SELECT at.id::text, at.entry_id::text, at.filename, at.note,
           je.entry_no, je.entry_date::text
      FROM attachment at
      JOIN journal_entry je ON je.id = at.entry_id
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND (at.filename ILIKE ${like(q)} ESCAPE '\\'
            OR at.note ILIKE ${like(q)} ESCAPE '\\')
     ORDER BY je.entry_date DESC
     LIMIT ${limit}`)
  return rows.map((a) => ({
    kind: 'Attachment' as const,
    title: a.filename,
    detail: [`on ${a.entry_no ?? 'a draft'}`, a.note ?? null].filter(Boolean).join(' · '),
    date: a.entry_date,
    amount: null,
    href: `/entries/${a.entry_id}`,
  }))
}

async function matchingRegistrations(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const rows = await db.execute<{
    tax: string; number: string; registered_on: string; ceased_on: string | null
  }>(sql`
    SELECT r.tax, r.number, r.registered_on::text, r.ceased_on::text
      FROM entity_tax_registration r
     WHERE r.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
       AND (r.number ILIKE ${like(q)} ESCAPE '\\' OR r.tax ILIKE ${like(q)} ESCAPE '\\')
     ORDER BY r.registered_on DESC
     LIMIT ${limit}`)
  return rows.map((r) => ({
    kind: 'Registration' as const,
    title: `${r.tax.replaceAll('_', '/')} — ${r.number}`,
    detail: r.ceased_on ? `registered ${r.registered_on}, ceased ${r.ceased_on}` : `registered ${r.registered_on}`,
    date: r.registered_on,
    amount: null,
    href: '/tax/registration',
  }))
}

async function matchingReadings(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const inSentence = sql`r.sentence ILIKE ${like(q)} ESCAPE '\\'`
  const rows = await db.execute<{
    id: string; filename: string | null; sentence: string | null; read_at: string; used_entry_id: string | null; error: string | null
  }>(sql`
    SELECT r.id::text, r.filename, r.sentence, r.read_at::date::text AS read_at, r.used_entry_id::text, r.error
      FROM ai_bill_reading r
     WHERE r.ledger_id = ${ledgerId}::uuid
       AND (r.filename ILIKE ${like(q)} ESCAPE '\\'
         OR ${inSentence})
     ORDER BY r.read_at DESC
     LIMIT ${limit}`)
  return rows.map((r) => ({
    kind: 'Reading' as const,
    // A reading from a sentence alone (0077) has no file name; its words are its name.
    title: r.filename ?? (r.sentence ?? '').slice(0, 60),
    detail: r.error ? 'failed' : r.used_entry_id ? 'used' : 'waiting to be entered',
    date: r.read_at,
    amount: null,
    href: '/readings',
  }))
}
