import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db/client'
import { belongsToLedger } from './bank'
import { moduleOwns } from './module-extensions'

/**
 * Does this thing belong to the company whose books this ledger is?
 *
 * Every form carries the ledger it was posted from, and `requireLedger` judges
 * THAT. The ids beside it — an invoice, an entry, a party, a directorship, a
 * project — were judged by nothing outside the bank module: a person with the
 * Invoices seat on company A could post A's ledger id with B's invoice id and
 * delete B's document (audit, 2026-09-13). The bank doors closed this as a
 * class on 2026-09-04 ("one function, every handler calls it"); this is that
 * function for the rest of the books, and the bank kinds still answer from
 * where they were written.
 *
 * Two kinds are about the company rather than a row in it: `entity` asks
 * whether a form's entity id IS this ledger's company, and `fiscal_year`
 * whether a year is this ledger's.
 */
export type Owned =
  | 'account' | 'party' | 'party_role' | 'invoice' | 'entry' | 'application'
  | 'registration' | 'directorship' | 'share_class' | 'significant_individual'
  | 'minute_book_entry' | 'minute_book_attachment' | 'corporate_office' | 'share_transaction'
  | 'sred_project' | 'sred_claim' | 'sred_time' | 'sred_evidence' | 'sred_allocation'
  | 'employee' | 'pay_stub' | 'journal_line'
  | 'crm_account' | 'crm_lead' | 'crm_contact' | 'crm_opportunity'
  | 'crm_activity' | 'crm_task' | 'crm_handoff' | 'crm_attachment'
  | 'fiscal_year' | 'entity'
  | 'row' | 'match' | 'statement'

/** The sentence every door says — the bank doors' own, kept as one spelling. */
export const NOT_OURS = "That is not in this company's books."

const UUID = /^[0-9a-fA-F-]{36}$/

export async function ours(kind: Owned, id: string, ledgerId: string): Promise<boolean> {
  // The five kinds the bank module wrote first answer from where they were
  // written — one spelling of each rule, one block that can mutate it.
  if (kind === 'row' || kind === 'match' || kind === 'statement' || kind === 'account' || kind === 'party') {
    return belongsToLedger(kind, id, ledgerId)
  }
  if (!UUID.test(id) || !UUID.test(ledgerId)) return false
  const L = sql`JOIN ledger l ON l.entity_id`
  const queries: Partial<Record<Owned, SQL>> = {
    party_role: sql`SELECT 1 AS ok FROM party_role pr ${L} = pr.entity_id WHERE pr.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    invoice: sql`SELECT 1 AS ok FROM invoice i WHERE i.id = ${id}::uuid AND i.ledger_id = ${ledgerId}::uuid`,
    entry: sql`SELECT 1 AS ok FROM journal_entry je WHERE je.id = ${id}::uuid AND je.ledger_id = ${ledgerId}::uuid`,
    application: sql`SELECT 1 AS ok FROM invoice_application ia JOIN invoice i ON i.id = ia.invoice_id
                      WHERE ia.id = ${id}::uuid AND i.ledger_id = ${ledgerId}::uuid`,
    registration: sql`SELECT 1 AS ok FROM entity_tax_registration r ${L} = r.entity_id WHERE r.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    journal_line: sql`SELECT 1 AS ok FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
                       WHERE jl.id = ${id}::uuid AND je.ledger_id = ${ledgerId}::uuid`,
    fiscal_year: sql`SELECT 1 AS ok FROM fiscal_year y WHERE y.id = ${id}::uuid AND y.ledger_id = ${ledgerId}::uuid`,
    entity: sql`SELECT 1 AS ok FROM ledger l WHERE l.id = ${ledgerId}::uuid AND l.entity_id = ${id}::uuid`
  }
  const query = queries[kind]
  if (!query) return moduleOwns(kind, id, ledgerId)
  const rows = await db.execute<{ ok: number }>(query)
  return rows.length > 0
}

/**
 * A form door's first question: every id the form carries, against the ledger
 * it was posted from. An empty id is not an answer — the door's own validation
 * says what is missing — so only ids that are there are judged.
 */
export async function refuseUnlessOurs(
  pairs: Array<[Owned, string | null | undefined]>, ledgerId: string,
): Promise<{ error: string } | null> {
  for (const [kind, id] of pairs) {
    if (id && !(await ours(kind, id, ledgerId))) return { error: NOT_OURS }
  }
  return null
}

/**
 * The same question inside a library door that a screen reaches with the
 * ledger in hand: refused with the module's own error class, so the door's
 * caller reads one kind of refusal. Without a ledger (a script, a fixture)
 * there is nothing to judge against and the door behaves as before.
 */
export async function mustBeOurs(
  kind: Owned, id: string, ledgerId: string | undefined, refuse: (message: string) => Error,
): Promise<void> {
  if (ledgerId !== undefined && !(await ours(kind, id, ledgerId))) throw refuse(NOT_OURS)
}
