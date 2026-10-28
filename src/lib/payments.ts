import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, actingAs, type Runner } from './acting'
import { deleteEntryCore, postEntryCore } from './posting'
import { lockFinanceResource, beforeModuleFinanceDelete } from './module-extensions'

/**
 * Payments, and which invoice each one settles.
 *
 * A payment has no table. A receipt is a journal entry — bank debited, the
 * control account credited with the party on that line — and `source_type`
 * 'payment' has had its seat reserved since 0001. What is new is the LINK:
 * `invoice_application` says entry E settles amount A of invoice I. It hangs
 * off the entry, not off a payment document, so a credit note's entry applies
 * through the same table with no special case.
 *
 * Nothing here stores a balance. What an invoice still owes is
 * |control movement| − Σ applications, computed where it is asked —
 * `docs/design/11-payments.md` §5, resting on `03-parties.md` §3.
 */

export class PaymentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PaymentError'
  }
}

/** One posted document with its derived balance. */
export type OpenItem = {
  currency?: string
  native_debt?: bigint
  native_applied?: bigint
  native_balance?: bigint
  invoice_id: string
  number: string | null
  document_kind: string
  direction: string
  party_id: string
  party_name: string
  issued_on: string
  due_on: string
  /** |what the entry put on the control account|, cents. */
  debt: bigint
  /** Σ applications on it — plus, for a credit note, Σ applications its own
   *  entry has made. A note that settled an invoice is spent either way. */
  applied: bigint
  /** debt − applied. */
  balance: bigint
  /** The document's own entry — what a credit note settles WITH. */
  entry_id: string
}

/** A payment entry naming the party, recorded against no invoice, with money still unapplied. */
export type UnappliedReceipt = {
  entry_id: string
  entry_no: string | null
  entry_date: string
  description: string
  amount: bigint
  unapplied: bigint
}

/**
 * Receipts (or payments made) that settle nothing yet: a `payment` entry
 * that moves the party's receivable (payable) the settling way, belongs to
 * no invoice, and has more on it than its applications TOWARD THIS PARTY
 * spend — a receipt split across two customers is offered to each for its
 * own share, the way the trigger caps applications per party (0036). Until
 * 2026-09-13 such an entry could be applied by the library and by nothing on
 * any screen — an invoice's page offered only new money.
 */
export async function unappliedReceipts(
  ledgerId: string, partyId: string, direction: 'sales' | 'purchase',
): Promise<UnappliedReceipt[]> {
  const role = direction === 'sales' ? 'trade_receivables' : 'trade_payables'
  // A receipt credits the receivable; a payment made debits the payable. An
  // entry moving the other way (a refund) settles nothing and is not offered.
  const settling = direction === 'sales' ? sql`sum(jl.amount) < 0` : sql`sum(jl.amount) > 0`
  const rows = await db.execute<{
    entry_id: string; entry_no: string | null; entry_date: string; description: string
    amount: string; unapplied: string
  }>(sql`
    SELECT je.id::text AS entry_id, je.entry_no, je.entry_date::text, je.description,
           abs(sum(jl.amount))::text AS amount,
           (abs(sum(jl.amount)) - coalesce((SELECT sum(a.amount) FROM invoice_application a
                                               JOIN invoice i ON i.id = a.invoice_id AND i.party_id = ${partyId}::uuid
                                              WHERE a.entry_id = je.id), 0))::text AS unapplied
      FROM journal_entry je
      JOIN journal_line jl ON jl.entry_id = je.id AND jl.party_id = ${partyId}::uuid
      JOIN account_role ar ON ar.account_id = jl.account_id AND ar.role = ${role}
     WHERE je.ledger_id = ${ledgerId}::uuid
       AND je.status = 'posted'
       AND je.source_type = 'payment'
       AND NOT EXISTS (SELECT 1 FROM invoice i WHERE i.entry_id = je.id)
     GROUP BY je.id
    HAVING ${settling}
       AND abs(sum(jl.amount)) - coalesce((SELECT sum(a.amount) FROM invoice_application a
                                              JOIN invoice i ON i.id = a.invoice_id AND i.party_id = ${partyId}::uuid
                                             WHERE a.entry_id = je.id), 0) > 0
     ORDER BY je.entry_date, je.entry_no`)
  return rows.map((r) => ({
    entry_id: r.entry_id, entry_no: r.entry_no, entry_date: r.entry_date, description: r.description,
    amount: BigInt(r.amount), unapplied: BigInt(r.unapplied),
  }))
}

/**
 * Exported so the by-party browse can JOIN this rather than write its own
 * "how much is still owed": that arithmetic belongs to this module, and a
 * second copy of it inside a screen's query is the two-spellings defect
 * wearing a balance's clothes (owner, 2026-09-03 — the browse now shows an
 * unpaid column beside every document).
 */
export const openItemsQuery = (extra: ReturnType<typeof sql>) => OPEN_ITEMS(extra)

const OPEN_ITEMS = (extra: ReturnType<typeof sql>) => sql`
  SELECT i.id::text AS invoice_id, i.entry_id::text AS entry_id, i.number, i.document_kind, i.direction,
         i.party_id::text AS party_id, p.name AS party_name,
         i.issued_on::text, i.due_on::text,
         abs(mov.amount) AS debt,
         COALESCE(app_on.total, 0) + COALESCE(app_by.total, 0) AS applied,
         CASE WHEN i.fx_currency IS NOT NULL THEN abs(fx_position.carrying_balance)
           ELSE abs(mov.amount)-COALESCE(app_on.total,0)-COALESCE(app_by.total,0) END AS balance,
         COALESCE(i.fx_currency,base_ledger.currency) AS currency,
         abs(COALESCE((SELECT sum(COALESCE(il.original_amount,il.amount)) FROM invoice_line il WHERE il.invoice_id=i.id),0)) AS native_debt,
         COALESCE((SELECT sum(COALESCE(ia.original_amount,ia.amount)) FROM invoice_application ia WHERE ia.invoice_id=i.id OR ia.entry_id=i.entry_id),0) AS native_applied,
         CASE WHEN i.fx_currency IS NOT NULL THEN abs(fx_position.native_balance)
           ELSE abs(mov.amount)-COALESCE(app_on.total,0)-COALESCE(app_by.total,0) END AS native_balance
    FROM invoice i
    JOIN party p ON p.id = i.party_id
    JOIN ledger base_ledger ON base_ledger.id=i.ledger_id
    CROSS JOIN LATERAL fx_invoice_at(i.id) fx_position
    JOIN LATERAL (
      SELECT COALESCE(SUM(jl.amount), 0) AS amount
        FROM journal_line jl
       WHERE jl.entry_id = i.entry_id
         AND jl.account_id = i.control_account_id
         AND jl.party_id = i.party_id) mov ON true
    -- Applications ON the document: what has been paid against it.
    LEFT JOIN LATERAL (
      SELECT SUM(a.amount) AS total
        FROM invoice_application a WHERE a.invoice_id = i.id) app_on ON true
    -- Applications BY the document's entry: how much of a credit note has been
    -- spent settling invoices. The first version had only the join above, so a
    -- fully-spent note went on reporting its whole value as available —
    -- PM09 caught it on the suite's first run.
    LEFT JOIN LATERAL (
      SELECT SUM(a.amount) AS total
        FROM invoice_application a WHERE a.entry_id = i.entry_id) app_by ON true
   WHERE i.status = 'posted' ${extra}
   ORDER BY i.due_on, i.issued_on, i.number`

/** Every posted document in a ledger with its balance, settled ones included. */
export async function documentsWithBalances(ledgerId: string): Promise<OpenItem[]> {
  const rows = await db.execute<Record<string, unknown>>(
    OPEN_ITEMS(sql`AND i.ledger_id = ${ledgerId}::uuid`))
  return rows.map(parseItem)
}

/** Only what still carries a balance. */
export async function openItemsFor(ledgerId: string): Promise<OpenItem[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT * FROM (${OPEN_ITEMS(sql`AND i.ledger_id = ${ledgerId}::uuid`)}) items
     WHERE balance <> 0
     ORDER BY due_on, issued_on, number`)
  return rows.map(parseItem)
}

/**
 * A document's balance as it counts toward what is owed. `balance` is a size
 * on both kinds of document — a credit note is offered by how much of it is
 * left — and an unspent credit note reduces what the other side owes.
 */
export const owedAmount = (i: Pick<OpenItem, 'document_kind' | 'balance'>): bigint =>
  i.document_kind === 'credit_note' ? -i.balance : i.balance

/** How a party's page words one direction's total: below zero it is credit held, not a negative debt. */
export function owedSummary(direction: 'sales' | 'purchase', total: bigint): { label: string; amount: bigint } {
  if (direction === 'sales') {
    return total < 0n ? { label: 'They have credit with us', amount: -total } : { label: 'They owe us', amount: total }
  }
  return total < 0n ? { label: 'We have credit with them', amount: -total } : { label: 'We owe them', amount: total }
}

function parseItem(r: Record<string, unknown>): OpenItem {
  return {
    currency: String(r.currency),
    native_debt: BigInt(r.native_debt as string),
    native_applied: BigInt(r.native_applied as string),
    native_balance: BigInt(r.native_balance as string),
    invoice_id: String(r.invoice_id),
    entry_id: String(r.entry_id),
    number: r.number === null ? null : String(r.number),
    document_kind: String(r.document_kind),
    direction: String(r.direction),
    party_id: String(r.party_id),
    party_name: String(r.party_name),
    issued_on: String(r.issued_on),
    due_on: String(r.due_on),
    debt: BigInt(r.debt as string),
    applied: BigInt(r.applied as string),
    balance: BigInt(r.balance as string),
  }
}

/** One invoice's derived balance; throws if it does not exist or is not posted. */
export async function balanceOf(invoiceId: string): Promise<OpenItem> {
  const rows = await db.execute<Record<string, unknown>>(
    OPEN_ITEMS(sql`AND i.id = ${invoiceId}::uuid`))
  if (rows.length === 0) {
    throw new PaymentError('NO_INVOICE', 'That invoice does not exist or is not posted.')
  }
  return parseItem(rows[0])
}

/**
 * Record money against one invoice: post the payment entry and the application
 * in one transaction, so there is no moment where the money exists unlinked.
 *
 * The direction falls out of the invoice: a sales invoice takes a receipt
 * (debit bank, credit receivables), a purchase bill takes a payment
 * (debit payables, credit bank). A credit note is refused by name — applying a
 * credit note IS `applyEntryToInvoice` with the note's own entry, not a
 * payment.
 */
export async function recordPayment(input: {
  invoiceId: string
  bankAccountId: string
  amount: bigint
  paidOn: string
  actor: string
  reference?: string
}, on:Runner=db) {
  const { invoiceId, bankAccountId, amount, paidOn, actor } = input
  if (amount <= 0n) {
    throw new PaymentError('NOT_POSITIVE', 'A payment is a positive amount of money.')
  }

  return on.transaction(async (tx) => {
    await lockFinanceResource(tx,'invoice',invoiceId)
    const [inv] = await tx.execute<{
      id: string; number: string | null; direction: string; document_kind: string
      status: string; ledger_id: string; party_id: string; party_name: string
      control_account_id: string; entry_id: string; fx_currency:string|null
    }>(sql`
      SELECT i.id::text, i.number, i.direction, i.document_kind, i.status,
             i.ledger_id::text, i.party_id::text, p.name AS party_name,
             i.control_account_id::text, i.entry_id::text,i.fx_currency
        FROM invoice i JOIN party p ON p.id = i.party_id
       WHERE i.id = ${invoiceId}::uuid FOR UPDATE`)
    if (!inv) throw new PaymentError('NO_INVOICE', 'That invoice does not exist.')
    if (inv.fx_currency) throw new PaymentError('FX_SETTLEMENT',`Use the FX workspace to settle this ${inv.fx_currency} document with its actual cash and carrying amount.`)
    if (inv.status !== 'posted') {
      throw new PaymentError('NOT_POSTED',
        `${inv.number ?? 'That invoice'} is ${inv.status}; only a posted invoice can be paid.`)
    }
    if (inv.document_kind !== 'invoice') {
      throw new PaymentError('IS_CREDIT_NOTE',
        `${inv.number ?? 'That document'} is a credit note. Apply it to an invoice instead of paying it.`)
    }

    // The debt and what is left of it, read inside the same transaction. The
    // trigger would refuse an over-application anyway; refusing here as well
    // turns a constraint violation into a sentence with the numbers in it.
    const [state] = await tx.execute<{ mov: bigint; applied: bigint }>(sql`
      SELECT (SELECT COALESCE(SUM(jl.amount), 0) FROM journal_line jl
               WHERE jl.entry_id = ${inv.entry_id}::uuid
                 AND jl.account_id = ${inv.control_account_id}::uuid
                 AND jl.party_id = ${inv.party_id}::uuid) AS mov,
             (SELECT COALESCE(SUM(a.amount), 0) FROM invoice_application a
               WHERE a.invoice_id = ${invoiceId}::uuid) AS applied`)
    const mov = BigInt(state.mov)
    const balance = (mov < 0n ? -mov : mov) - BigInt(state.applied)

    if (amount > balance) {
      throw new PaymentError('OVERPAYS',
        `That is more than ${inv.number ?? 'the invoice'} still owes.`)
    }

    // Sales: the debt is a debit on the control account, so settling credits
    // it and the bank line takes the debit. Purchase: mirrored.
    const settle = mov > 0n ? -amount : amount
    const description = (inv.direction === 'sales'
      ? `Payment received — ${inv.number ?? inv.party_name}`
      : `Payment — ${inv.number ?? inv.party_name}`)
      + (input.reference ? ` (${input.reference})` : '')

    const posted = await postEntryCore(tx, {
      ledgerId: inv.ledger_id,
      entryDate: paidOn,
      description,
      sourceType: 'payment',
      actor,
      lines: [
        // The only line that names the party, same rule as everywhere else.
        { accountId: inv.control_account_id, amount: settle, partyId: inv.party_id, description },
        { accountId: bankAccountId, amount: -settle, description },
      ],
    })

    await tx.execute(sql`
      INSERT INTO invoice_application (invoice_id, entry_id, amount, applied_by)
      VALUES (${invoiceId}::uuid, ${posted.entry.id}::uuid, ${amount}, ${actor})`)

    return { entryId: posted.entry.id as string, entryNo: posted.entry.entryNo as string }
  })
}

/**
 * Apply an EXISTING entry to an invoice — a credit note's entry, or a payment
 * recorded earlier and left unapplied. The triggers hold the rules; this is
 * the door.
 */
export async function applyEntryToInvoice(input: {
  invoiceId: string; entryId: string; amount: bigint; actor: string
}, on:Runner=db) {
  if (input.amount <= 0n) {
    throw new PaymentError('NOT_POSITIVE', 'An application settles a positive amount.')
  }
  return actingAs(input.actor, async tx=>{
    if ((await tx.execute(sql`SELECT 1 FROM invoice WHERE id=${input.invoiceId}::uuid AND fx_currency IS NOT NULL
      UNION ALL SELECT 1 FROM journal_line WHERE entry_id=${input.entryId}::uuid AND original_currency IS NOT NULL LIMIT 1`)).length)
      throw new PaymentError('FX_SETTLEMENT','Apply foreign credit through the FX workspace so both carrying values are preserved.')
    await lockFinanceResource(tx,'payment',input.entryId)
    await lockFinanceResource(tx,'invoice',input.invoiceId)
    const [application]=await tx.execute<{id:string}>(sql`INSERT INTO invoice_application (invoice_id, entry_id, amount, applied_by)
      VALUES (${input.invoiceId}::uuid, ${input.entryId}::uuid, ${input.amount}, ${input.actor}) RETURNING id::text`)
    return application
  },on)
}

/** Undo one application. A delete, not a reversal: the ledger never moved. */
export async function unapply(applicationId: string, actor = 'system', on:Runner=db) {
  const deleted = await actingAs(actor, async tx=>{
    if ((await tx.execute(sql`SELECT 1 FROM invoice_application WHERE id=${applicationId}::uuid AND original_amount IS NOT NULL`)).length)
      throw new PaymentError('FX_CORRECTION','Reverse or delete the foreign settlement as a whole through its correction workflow.')
    const [app]=await tx.execute<{invoice_id:string;entry_id:string}>(sql`SELECT invoice_id::text,entry_id::text FROM invoice_application WHERE id=${applicationId}::uuid`)
    if(app){await lockFinanceResource(tx,'payment',app.entry_id);await lockFinanceResource(tx,'invoice',app.invoice_id)}
    return tx.execute<{id:string}>(sql`DELETE FROM invoice_application WHERE id=${applicationId}::uuid RETURNING id::text`)
  },on)
  if (deleted.length === 0) {
    throw new PaymentError('NO_APPLICATION', 'That application does not exist.')
  }
}

/** The applications on one invoice, oldest first, with what each entry was. */
/**
 * Delete a payment — the entry AND every application it settles, in one
 * transaction (the owner's cascade rule, docs/design/14-open-books.md). The
 * released debt reappears on the invoices it was settling; the audit row
 * keeps the entry's lines. Only payment-sourced entries come through here:
 * every other source has its own door and deleteEntry names it.
 */
export async function deletePayment(entryId: string, actor = 'system', on:Runner=db) {
  return on.transaction(async (tx) => {
    await acting(tx, actor)
    await lockFinanceResource(tx,'payment',entryId)
    const [e] = await tx.execute<{ source_type: string; entry_no: string | null }>(sql`
      SELECT source_type, entry_no FROM journal_entry WHERE id = ${entryId}::uuid FOR UPDATE`)
    if (!e) throw new PaymentError('NO_ENTRY', 'That payment does not exist.')
    if (e.source_type !== 'payment') {
      throw new PaymentError('NOT_A_PAYMENT',
        `${e.entry_no ?? 'That entry'} is not a payment — its own screen deletes it.`)
    }
    await beforeModuleFinanceDelete(tx, { type: 'payment', id: entryId })
    const gone = await deleteEntryCore(tx, entryId, actor, 'payment')
    return { entryNo: gone.entryNo, releasedApplications: gone.releasedApplications,
             releasedMatches: gone.releasedMatches }
  })
}

export async function applicationsOn(invoiceId: string) {
  return db.execute<{
    id: string; entry_id: string; entry_no: string; entry_date: string
    description: string | null; amount: bigint; original_amount: bigint | null; carrying_amount: bigint | null; applied_by: string; source_type: string
    bank_account_id: string | null
  }>(sql`
    SELECT a.id::text, a.entry_id::text, je.entry_no, je.entry_date::text,
           je.description, a.amount, a.original_amount,a.carrying_amount,a.applied_by, je.source_type,
           (SELECT jl.account_id::text FROM journal_line jl
             WHERE jl.entry_id = je.id AND EXISTS (
               SELECT 1 FROM account_role ar WHERE ar.account_id = jl.account_id
                 AND ar.role = 'cash_and_cash_equivalents')
             ORDER BY jl.line_no DESC LIMIT 1) AS bank_account_id
      FROM invoice_application a
      JOIN journal_entry je ON je.id = a.entry_id
     WHERE a.invoice_id = ${invoiceId}::uuid
     ORDER BY a.applied_at`)
}
