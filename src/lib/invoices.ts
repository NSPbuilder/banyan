import 'server-only'
import { lockFinanceResource } from './module-extensions'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, type Runner, type Tx } from './acting'
import { deleteEntryCore, editEntryCore, postEntryCore, reverseEntryCore } from './posting'
import { formatMoney } from './money'
import { causesOf } from './db-errors'
import { assertCurrencyOpen, lockFxLedger } from './fx'
import { fxRateFor } from './fx-rates'
import { toFunctional, type FxSnapshot } from './fx-money'
import { invoiceFilterError, isInvoiceFilterDate, type InvoiceFilters } from './invoice-filters'
import { like, readQuery } from './query'
import { InvoiceTemplateError, resolveInvoiceTemplate } from './invoice-templates'
import type { InvoiceTemplateSnapshot } from './invoice-template-types'

/**
 * Sales invoices and purchase bills.
 *
 * One document type with a direction, for the reason `03` gives about parties:
 * two tables for one concept eventually give two answers. An invoice is not a
 * journal entry — it is a document that produces one, the way a bank row does.
 * `journal_entry.source_type` is 'ar_invoice' or 'ap_bill' and `source_id` is
 * the invoice, so the ledger can always say which document a figure came from.
 *
 * Nothing here holds a balance. What is still owed on an invoice is a question
 * about the ledger, and `docs/design/03-parties.md` explains why it stays that
 * way. There is no `invoice.paid` and no `invoice.outstanding`.
 */

export class InvoiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'InvoiceError'
  }
}

export type Direction = 'sales' | 'purchase'

/**
 * The second axis. A credit note is the same document pointing the other way —
 * two axes, four combinations, and the sign falls out of the pair rather than
 * out of a rule written twice.
 */
export type DocumentKind = 'invoice' | 'credit_note'

export type InvoiceLineInput = {
  accountId: string
  /** Signed cents, the ledger's convention: what this does to `accountId`. */
  amount: bigint
  description?: string
  dimensions?: Record<string, string>
  /** What the person said about the line (14-open-books §4); provenance, not arithmetic. */
  taxCode?: string
  /** Set on the derived tax lines the save generates, so an edit can drop and recompute exactly them. */
  generatedFor?: 'GST' | 'PST'
  /** Optional source values; accounting still reads the stored signed amount. */
  inputAmount?: bigint
  inputInclusive?: boolean
  gstOverride?: bigint
  pstOverride?: bigint
}

export type InvoiceRecord = {
  fx_currency: string | null
  fx_snapshot: FxSnapshot | null
  version?: string
  id: string
  entity_id: string
  ledger_id: string
  direction: Direction
  document_kind: DocumentKind
  party_id: string
  number: string | null
  their_ref: string | null
  issued_on: string
  due_on: string
  control_account_id: string
  status: 'draft' | 'posted' | 'void'
  entry_id: string | null
  note: string | null
  print_template_selection: string
  print_template_snapshot: InvoiceTemplateSnapshot | null
}


/**
 * What the control account does, signed the way the ledger signs everything.
 *
 * A sales invoice's lines credit revenue, so the receivable is DEBITED: the
 * movement is the opposite of their sum, and positive. A purchase bill's lines
 * debit an expense, so the payable is CREDITED and the movement is negative.
 * Both are `-sum(lines)`; the sign is what says which document it is.
 *
 * Computed rather than stored, for the reason everything here is: a stored
 * total is a second answer to a question the lines already answer.
 */
export function controlMovementOf(lines: InvoiceLineInput[]): bigint {
  return -lines.reduce((sum, l) => sum + l.amount, 0n)
}

/**
 * Which way the control account must move for this document.
 *
 *                    invoice            credit_note
 *   sales       debit receivables    credit receivables
 *   purchase    credit payables       debit payables
 *
 * One expression rather than four branches, because the two axes are
 * independent: the direction says which way an invoice goes, and the kind flips
 * it. Written as four cases, the fourth is the one that gets copied wrong.
 */
export function movesTheRightWay(
  direction: Direction, movement: bigint, kind: DocumentKind = 'invoice',
): boolean {
  const debitsControl = (direction === 'sales') === (kind === 'invoice')
  return debitsControl ? movement > 0n : movement < 0n
}

/**
 * What the document says, as a person reads it.
 *
 * Positive **whenever `movesTheRightWay` holds** — which is every invoice that
 * gets as far as being stored, because `createInvoice` refuses the others. It is
 * not unconditionally positive, and saying so would be a claim the function does
 * not keep: on lines that fail the direction rule it returns the negative, which
 * is the only moment anything calls it on such lines.
 *
 * The sign lives on `controlMovementOf`, where it means something. A bill for
 * "minus four hundred dollars" is not what anybody was sent.
 */
export function totalOf(
  lines: InvoiceLineInput[], direction: Direction, kind: DocumentKind = 'invoice',
): bigint {
  const m = controlMovementOf(lines)
  const debitsControl = (direction === 'sales') === (kind === 'invoice')
  return debitsControl ? m : -m
}

/**
 * A stored line amount as the person ENTERED it — which is also how a customer
 * reads it. Keyed on (direction, kind), exactly as `totalOf` is: a sales
 * invoice stores the revenue credit (negative) for a line entered positive,
 * while a sales CREDIT NOTE stores it positive already. A review caught the
 * customer paper keying this on direction alone: a credit note went out with
 * every line at −400.00 under a printed total of +400.00 — the lines summing
 * to the negation of the document's own total. The detail screen had the same
 * blanket negation. One expression now, used by both and by the paper.
 */
export function asEnteredAmount(
  direction: Direction, kind: DocumentKind, stored: bigint,
): bigint {
  const debitsControl = (direction === 'sales') === (kind === 'invoice')
  return debitsControl ? -stored : stored
}

export async function createInvoice(input: {
  /** Foreign lines are native minor units; stored amount remains functional. */
  currency?: string
  rate?: FxSnapshot
  requestKey?: string
  ledgerId: string
  direction: Direction
  /** Defaults to an invoice; a credit note moves the control account the other way. */
  kind?: DocumentKind
  partyId: string
  controlAccountId: string
  issuedOn: string
  dueOn: string
  number?: string
  theirRef?: string
  note?: string
  template?: string
  lines: InvoiceLineInput[]
  actor?: string
}, on: Runner = db): Promise<InvoiceRecord> {
  if (input.lines.length === 0) {
    throw new InvoiceError('NO_LINES',
      'An invoice with no lines is a piece of paper, not a document. Add what it is for.')
  }
  if (input.dueOn < input.issuedOn) {
    throw new InvoiceError('DUE_BEFORE_ISSUE',
      `Due ${input.dueOn} but issued ${input.issuedOn} — the due date cannot come first.`)
  }
  const kind: DocumentKind = input.kind ?? 'invoice'
  const movement = controlMovementOf(input.lines)
  if (movement === 0n) {
    throw new InvoiceError('ZERO_TOTAL',
      'The lines come to nothing. An invoice for zero has nobody to send it to.')
  }
  // The wrong way for THIS kind of document. A sales invoice whose lines net to
  // a debit is a credit note; a purchase bill whose lines net to a credit is a
  // supplier credit. Both are real documents with different rules, and neither
  // is built — posting one through here would put the money on the wrong side
  // of the control account and read as an ordinary invoice afterwards.
  if (!movesTheRightWay(input.direction, movement, kind)) {
    const shouldDebit = (input.direction === 'sales') === (kind === 'invoice')
    const other: DocumentKind = kind === 'invoice' ? 'credit_note' : 'invoice'
    throw new InvoiceError('WRONG_WAY',
      `These lines ${movement > 0n ? 'debit' : 'credit'} the control account by `
      + `${formatMoney(movement > 0n ? movement : -movement)}, and a ${input.direction} `
      + `${kind === 'invoice' ? 'invoice' : 'credit note'} has to `
      + `${shouldDebit ? 'debit' : 'credit'} it. What you have is a `
      + `${other === 'credit_note' ? 'credit note' : 'invoice'}; issue one of those instead.`)
  }

  const actor = input.actor ?? 'system'

  return on.transaction(async (tx) => {
    await acting(tx, actor)
    const currency = input.currency && input.currency !== 'CAD' ? input.currency : null
    if (currency) await lockFxLedger(tx,input.ledgerId)
    if (currency && input.requestKey) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestKey)) throw new InvoiceError('REQUEST_KEY','Reload this form before saving.')
      const [previous] = await tx.execute<InvoiceRecord>(sql`SELECT id::text,entity_id::text,ledger_id::text,direction,document_kind,
        party_id::text,number,their_ref,issued_on::text,due_on::text,control_account_id::text,status,entry_id::text,note,
        print_template_selection,print_template_snapshot,fx_currency,fx_snapshot FROM invoice
        WHERE ledger_id=${input.ledgerId}::uuid AND fx_request_key=${input.requestKey}`)
      if (previous) return previous
    }
    const quote = currency ? await fxRateFor(currency,input.issuedOn,tx,input.rate) : null
    if (currency) await assertCurrencyOpen(tx,input.ledgerId,currency)
    const storedLines = input.lines.map(line => ({ ...line,
      originalAmount: quote ? line.amount : null,
      amount: quote ? toFunctional(line.amount,currency!,quote.rate) : line.amount,
      inputAmount: quote && line.inputAmount !== undefined ? toFunctional(line.inputAmount,currency!,quote.rate) : line.inputAmount,
      gstOverride: quote && line.gstOverride !== undefined ? toFunctional(line.gstOverride,currency!,quote.rate) : line.gstOverride,
      pstOverride: quote && line.pstOverride !== undefined ? toFunctional(line.pstOverride,currency!,quote.rate) : line.pstOverride,
    }))
    if (storedLines.some(l=>l.amount===0n)) throw new InvoiceError('BELOW_CENT','A converted line is below one CAD cent. Combine small lines before posting.')

    const [led] = await tx.execute<{ entity_id: string }>(sql`
      SELECT entity_id::text FROM ledger WHERE id = ${input.ledgerId}::uuid`)
    if (!led) throw new InvoiceError('NO_LEDGER', 'Those books do not exist.')
    const template = input.template ?? 'auto'
    if (input.direction === 'purchase' && !['auto', 'system'].includes(template)) throw new InvoiceTemplateError('SALES_ONLY', 'Templates apply to sales invoices and credit notes.')
    if (input.direction === 'sales' && template !== 'auto') await resolveInvoiceTemplate(tx, led.entity_id, input.partyId, template)

    let inv: InvoiceRecord
    try {
      ;[inv] = await tx.execute<InvoiceRecord>(sql`
        INSERT INTO invoice (entity_id, ledger_id, direction, document_kind, party_id,
                             number, their_ref, issued_on, due_on, control_account_id,
                             note, created_by, print_template_selection, fx_currency, fx_snapshot, fx_request_key)
        VALUES (${led.entity_id}::uuid, ${input.ledgerId}::uuid, ${input.direction}, ${kind},
                ${input.partyId}::uuid, ${input.number?.trim() || null},
                ${input.theirRef?.trim() || null}, ${input.issuedOn}::date,
                ${input.dueOn}::date, ${input.controlAccountId}::uuid,
                ${input.note?.trim() || null}, ${actor}, ${template}, ${currency}, ${quote ? JSON.stringify(quote) : null}::jsonb, ${currency ? input.requestKey ?? null : null})
        RETURNING id::text, entity_id::text, ledger_id::text, direction, document_kind,
                  party_id::text, number, their_ref, issued_on::text, due_on::text,
                  control_account_id::text, status, entry_id::text, note, print_template_selection, print_template_snapshot, fx_currency, fx_snapshot`)
    } catch (e) {
      const text = causesOf(e)
      if (text.includes('invoice_number_unique')) {
        // Naming the KIND as well, now that there is more than one. "already
        // used by another sales invoice" in front of somebody numbering a
        // credit note sends them looking through the wrong list.
        throw new InvoiceError('DUPLICATE_NUMBER',
          `${input.number} is already used by another ${input.direction} `
          + `${kind === 'credit_note' ? 'credit note' : 'invoice'} here.`)
      }
      throw e
    }

    for (const [i, l] of storedLines.entries()) {
      await tx.execute(sql`
        INSERT INTO invoice_line (invoice_id, line_no, account_id, description, amount,
                                  dimensions, tax_code, generated_for,
                                  input_amount, input_inclusive, gst_override, pst_override, original_amount)
        VALUES (${inv.id}::uuid, ${i + 1}, ${l.accountId}::uuid,
                ${l.description?.trim() || null}, ${l.amount},
                ${JSON.stringify(l.dimensions ?? {})}::jsonb,
                ${l.taxCode ?? null}, ${l.generatedFor ?? null},
                ${l.inputAmount ?? null}, ${l.inputInclusive ?? null},
                ${l.gstOverride ?? null}, ${l.pstOverride ?? null}, ${l.originalAmount})`)
    }

    return inv
  })
}

/**
 * The accounts an invoice line can name, with the tax ones marked.
 *
 * Tax on an invoice is an ordinary line — there is no tax field. Amounts
 * arrive computed from the line's tag (14-open-books §4) or typed by hand;
 * either way the LINE is the truth and the return reads roles. What
 * this does is stop the screen from making the tax account hard to find, and
 * mark which side of the return each one is: 0031 refuses a sale's tax in a
 * recoverable account, and a list that did not say which was which would make
 * that refusal feel arbitrary.
 */
export async function lineAccountsFor(entityId: string, direction: Direction) {
  return db.execute<{
    id: string; code: string; name: string; tax_role: string | null; is_control: boolean
  }>(sql`
    SELECT a.id::text, a.code, a.name,
           (SELECT ar.role FROM account_role ar
             WHERE ar.account_id = a.id
               AND (ar.role LIKE 'gst%' OR ar.role LIKE 'qst%')
               AND ar.role LIKE ${direction === 'sales' ? '%_payable' : '%_recoverable'}
             LIMIT 1) AS tax_role,
           EXISTS (SELECT 1 FROM account_role ar
                    WHERE ar.account_id = a.id
                      AND ar.role IN ('trade_receivables', 'trade_payables')) AS is_control
      FROM account a
     WHERE a.entity_id = ${entityId}::uuid AND a.is_postable AND a.is_active
     ORDER BY a.code`)
}

export async function invoiceDetail(invoiceId: string) {
  const [inv] = await db.execute<InvoiceRecord & { party_name: string; control_code: string }>(sql`
    SELECT i.id::text, COALESCE(to_jsonb(i)->>'version','1') AS version, i.entity_id::text, i.ledger_id::text, i.direction, i.document_kind,
           i.party_id::text, i.number, i.their_ref, i.issued_on::text, i.due_on::text,
           i.control_account_id::text, i.status, i.entry_id::text, i.note, i.print_template_selection, i.print_template_snapshot, i.fx_currency, i.fx_snapshot,
           p.name AS party_name, a.code AS control_code
      FROM invoice i
      JOIN party p ON p.id = i.party_id
      JOIN account a ON a.id = i.control_account_id
     WHERE i.id = ${invoiceId}::uuid`)
  if (!inv) return null

  const lines = await db.execute<{
    line_no: number; account_id: string; code: string; name: string
    description: string | null; amount: bigint; original_amount: bigint | null
    tax_code: string | null; generated_for: string | null
    input_amount: bigint | null; input_inclusive: boolean | null
    gst_override: bigint | null; pst_override: bigint | null
  }>(sql`
    SELECT il.line_no, il.account_id::text, a.code, a.name, il.description, il.amount, il.original_amount,
           il.tax_code, il.generated_for,
           (to_jsonb(il)->>'input_amount')::bigint AS input_amount,
           (to_jsonb(il)->>'input_inclusive')::boolean AS input_inclusive,
           (to_jsonb(il)->>'gst_override')::bigint AS gst_override,
           (to_jsonb(il)->>'pst_override')::bigint AS pst_override
      FROM invoice_line il JOIN account a ON a.id = il.account_id
     WHERE il.invoice_id = ${invoiceId}::uuid
     ORDER BY il.line_no`)

  const movement = -lines.reduce((s, l) => s + l.amount, 0n)
  return {
    invoice: inv, lines, movement,
    // Through `totalOf`, not a fourth copy of the rule. It used to be spelled
    // out here and in `postInvoice` and in `invoicesFor`'s SQL, which left
    // `totalOf` called by nothing but the checks — a function the page never
    // runs, checked as though it were the page.
    total: totalOf(lines.map((l) => ({ accountId: l.account_id, amount: l.amount })),
                   inv.direction, inv.document_kind),
  }
}

/** Accept the original direction argument as well as the list's combined filters. */
export async function invoicesFor(ledgerId: string, wanted?: Direction | Partial<InvoiceFilters>) {
  const filters = typeof wanted === 'string' ? { direction: wanted } : wanted ?? {}
  const error = invoiceFilterError(filters)
  if (error) throw new InvoiceError('BAD_FILTER', error)
  const query = readQuery(filters.q ?? '')
  return db.execute<InvoiceRecord & { party_name: string; total: bigint }>(sql`
    SELECT i.id::text, COALESCE(to_jsonb(i)->>'version','1') AS version, i.entity_id::text, i.ledger_id::text, i.direction, i.document_kind,
           i.party_id::text, i.number, i.their_ref, i.issued_on::text, i.due_on::text,
           i.control_account_id::text, i.status, i.entry_id::text, i.note, i.print_template_selection, i.print_template_snapshot, i.fx_currency, i.fx_snapshot,
           p.name AS party_name,
           -- Positive on every one of the four combinations. totalOf is the
           -- same rule in TypeScript, and this is a second copy of it — not
           -- because the function cannot be imported (it is in this very file)
           -- but because the total is computed inside the aggregate, where SQL
           -- cannot call TypeScript at all. V76 checks the two against each
           -- other rather than trusting them.
           -- (No backticks in here: this is a template literal and one would
           -- close it. tsc catches that, loudly, three times so far this round.)
           (CASE WHEN (i.direction = 'sales') = (i.document_kind = 'invoice')
                 THEN -1 ELSE 1 END
            * COALESCE((SELECT sum(il.amount) FROM invoice_line il
                         WHERE il.invoice_id = i.id), 0))::bigint AS total
      FROM invoice i JOIN party p ON p.id = i.party_id
     WHERE i.ledger_id = ${ledgerId}::uuid
       ${filters.direction ? sql`AND i.direction = ${filters.direction}` : sql``}
       ${filters.from ? sql`AND i.issued_on >= ${filters.from}::date` : sql``}
       ${filters.to ? sql`AND i.issued_on <= ${filters.to}::date` : sql``}
       ${filters.partyId ? sql`AND i.party_id = ${filters.partyId}::uuid` : sql``}
       ${query.text ? sql`AND (
         i.number ILIKE ${like(query)} ESCAPE '\\'
         OR i.their_ref ILIKE ${like(query)} ESCAPE '\\'
         OR i.note ILIKE ${like(query)} ESCAPE '\\'
         OR p.name ILIKE ${like(query)} ESCAPE '\\'
         OR EXISTS (SELECT 1 FROM invoice_line il WHERE il.invoice_id = i.id
                    AND il.description ILIKE ${like(query)} ESCAPE '\\')
         OR ${query.date && isInvoiceFilterDate(query.date) ? sql`i.issued_on = ${query.date}::date` : sql`false`}
         OR ${query.cents.length > 0
           ? sql`abs(COALESCE((SELECT sum(il.amount) FROM invoice_line il WHERE il.invoice_id = i.id), 0)) IN ${query.cents}`
           : sql`false`}
       )` : sql``}
     ORDER BY i.issued_on DESC, i.number, i.id`)
}

/** Include historical parties with documents here, regardless of the active filters. */
export async function invoicePartiesFor(ledgerId: string, direction?: Direction) {
  return db.execute<{ id: string; label: string }>(sql`
    SELECT DISTINCT p.id::text, p.name AS label
      FROM invoice i JOIN party p ON p.id = i.party_id
     WHERE i.ledger_id = ${ledgerId}::uuid
       ${direction ? sql`AND i.direction = ${direction}` : sql``}
     ORDER BY label, id`)
}

/**
 * Post an invoice: one journal entry, through the same door as everything else.
 *
 * The control account takes the total; each line takes its own amount against
 * its own account. `party_id` goes on the CONTROL line only — that line is the
 * debt, and it is the one the aging reads. Putting it on the revenue lines too
 * would double every figure any per-party query returns.
 */
/**
 * Void an invoice, and take its entry out of the ledger in the same breath.
 *
 * Every guard added in 0029 says "void it and issue another", and until this
 * function existed that sentence named an operation nobody could perform: no
 * code set `status = 'void'`, so the only route was raw SQL — and raw SQL that
 * released `entry_id` left the entry standing, posted, named by nothing, with
 * the debt still on the party for ever. A remedy that is only reachable by hand
 * is a remedy that gets done wrong.
 *
 * The order matters and is the whole of it: release the invoice's claim FIRST,
 * then reverse. `trg_reversed_holds_no_invoice` is deferred, so it judges the
 * pair at commit — the invoice no longer names the entry, and the entry no
 * longer stands. Neither half is possible alone.
 */
/** FX transactions always take the ledger mutex before invoice/domain row locks. */
async function lockForeignInvoice(tx:Tx,invoiceId:string) {
  const [foreign]=await tx.execute<{ledger_id:string}>(sql`SELECT ledger_id::text FROM invoice WHERE id=${invoiceId}::uuid AND fx_currency IS NOT NULL`)
  if(foreign)await lockFxLedger(tx,foreign.ledger_id)
}

export async function voidInvoice(invoiceId: string, input: {
  reason: string
  /** When the reversal lands. Defaults to the invoice's own date. */
  reversedOn?: string
  actor?: string
}, on: Runner = db) {
  const reason = input.reason?.trim()
  if (!reason) {
    throw new InvoiceError('NO_REASON',
      'Say why it is being voided. The reversal carries it, and in six months it '
      + 'is the only thing that explains a credit sitting in the ledger.')
  }
  const actor = input.actor ?? 'system'

  return on.transaction(async (tx) => {
    await acting(tx, actor)
    await lockForeignInvoice(tx,invoiceId)
    await lockFinanceResource(tx,'invoice',invoiceId)
    const [inv] = await tx.execute<InvoiceRecord>(sql`
      SELECT id::text, entity_id::text, ledger_id::text, direction, document_kind,
             party_id::text, number, their_ref, issued_on::text, due_on::text,
             control_account_id::text, status, entry_id::text, note, print_template_selection, print_template_snapshot, fx_currency, fx_snapshot
        FROM invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`)
    if (!inv) throw new InvoiceError('NO_INVOICE', 'That invoice does not exist.')
    if (inv.status === 'void') {
      throw new InvoiceError('ALREADY_VOID', `${inv.number ?? 'That invoice'} is already void.`)
    }

    // A draft has produced nothing, so there is nothing to reverse.
    if (inv.status === 'draft') {
      await tx.execute(sql`
        UPDATE invoice SET status = 'void' WHERE id = ${invoiceId}::uuid`)
      return { invoiceId: inv.id, reversalId: null as string | null }
    }

    await tx.execute(sql`
      UPDATE invoice SET status = 'void', entry_id = NULL WHERE id = ${invoiceId}::uuid`)

    const reversal = await reverseEntryCore(
      tx, inv.entry_id!, input.reversedOn ?? inv.issued_on, reason, actor)

    return { invoiceId: inv.id, reversalId: reversal.reversal.id as string | null }
  })
}

/**
 * The journal payload an invoice's document rows imply — ONE construction,
 * used by the posting that creates the entry and the edit that regenerates
 * it. Two constructions would eventually describe two different entries.
 */
function invoiceEntryPayload(
  inv: Pick<InvoiceRecord, 'id' | 'fx_currency' | 'fx_snapshot' | 'direction' | 'document_kind' | 'number' | 'their_ref'
    | 'control_account_id' | 'party_id'>,
  lines: Array<{ original_amount?: bigint | null; account_id: string; amount: bigint | string; description: string | null
    dimensions: Record<string, string> }>,
) {
  const movement = -lines.reduce((s, l) => s + BigInt(l.amount), 0n)
  // The kind matters here: this description surfaces on customer paper (the
  // Received/Applied table), and a review found a credit note's entry
  // introducing itself as "Invoice CN-301".
  const description = (inv.direction === 'sales'
    ? `${inv.document_kind === 'credit_note' ? 'Credit note' : 'Invoice'} ${inv.number ?? ''}`.trim()
    : `Bill ${inv.their_ref ?? inv.number ?? ''}`.trim()) || 'Invoice'
  return {
    description,
    lines: [
      // The debt, and the only line that names the party.
      {
        accountId: inv.control_account_id,
        amount: movement,
        ...(inv.fx_currency && inv.fx_snapshot ? {originalCurrency:inv.fx_currency,
          originalAmount:-lines.reduce((sum,l)=>sum+BigInt(l.original_amount ?? 0n),0n),
          fxSnapshot:inv.fx_snapshot,fxInvoiceId:inv.id}:{}),
        partyId: inv.party_id,
        description,
      },
      ...lines.map((l) => ({
        accountId: l.account_id,
        amount: BigInt(l.amount),
        ...(inv.fx_currency && inv.fx_snapshot ? {originalCurrency:inv.fx_currency,
          originalAmount:BigInt(l.original_amount ?? 0n),fxSnapshot:inv.fx_snapshot}:{}),
        description: l.description ?? undefined,
        dimensions: l.dimensions,
      })),
    ],
  }
}

/**
 * The document-shape refusals createInvoice makes, for the edit path too —
 * one spelling of what a well-formed invoice is.
 */
function assertInvoiceShape(direction: Direction, kind: DocumentKind, input: {
  issuedOn: string; dueOn: string; lines: InvoiceLineInput[]
}) {
  if (input.lines.length === 0) {
    throw new InvoiceError('NO_LINES',
      'An invoice with no lines is a piece of paper, not a document. Add what it is for.')
  }
  if (input.dueOn < input.issuedOn) {
    throw new InvoiceError('DUE_BEFORE_ISSUE',
      `Due ${input.dueOn} but issued ${input.issuedOn} — the due date cannot come first.`)
  }
  const movement = controlMovementOf(input.lines)
  if (movement === 0n) {
    throw new InvoiceError('ZERO_TOTAL',
      'The lines come to nothing. An invoice for zero has nobody to send it to.')
  }
  if (!movesTheRightWay(direction, movement, kind)) {
    const shouldDebit = (direction === 'sales') === (kind === 'invoice')
    const other: DocumentKind = kind === 'invoice' ? 'credit_note' : 'invoice'
    throw new InvoiceError('WRONG_WAY',
      `These lines ${movement > 0n ? 'debit' : 'credit'} the control account by `
      + `${formatMoney(movement > 0n ? movement : -movement)}, and a ${direction} `
      + `${kind === 'invoice' ? 'invoice' : 'credit note'} has to `
      + `${shouldDebit ? 'debit' : 'credit'} it. What you have is a `
      + `${other === 'credit_note' ? 'credit note' : 'invoice'}; issue one of those instead.`)
  }
}

/**
 * The readable half of the period wall: the 0040 triggers refuse a closed
 * period regardless, but they speak after rows have been touched and in the
 * database's voice. This speaks first, in a sentence, before anything moves.
 */
async function assertInvoicePeriodOpen(tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
                                       inv: Pick<InvoiceRecord, 'entry_id' | 'number'>) {
  if (!inv.entry_id) return
  const [p] = await tx.execute<{ status: string; name: string }>(sql`
    SELECT fp.status, fp.name FROM journal_entry je
      JOIN fiscal_period fp ON fp.id = je.period_id
     WHERE je.id = ${inv.entry_id}::uuid`)
  if (p && p.status !== 'open') {
    throw new InvoiceError('PERIOD_CLOSED',
      `${inv.number ?? 'That invoice'} sits in ${p.name}, which is ${p.status}. ` +
      'Reopen the period, or issue a correcting document — a closed period is the freeze.')
  }
}

/**
 * Edit a live invoice — open books (docs/design/14-open-books.md). The
 * document changes and its entry is regenerated IN THE SAME TRANSACTION, so
 * the paper and the ledger never tell different stories. Applications on the
 * document are cascade-deleted first (the owner's decision: the settling
 * money returns to on-account), and the return value names how many.
 */
export async function editInvoice(invoiceId: string, input: {
  partyId: string
  controlAccountId: string
  issuedOn: string
  dueOn: string
  number?: string
  theirRef?: string
  note?: string
  template?: string
  lines: InvoiceLineInput[]
  actor?: string
}, on: Runner = db) {
  const actor = input.actor ?? 'system'
  return on.transaction(async (tx) => {
    await acting(tx, actor)
    await lockFinanceResource(tx,'invoice',invoiceId)
    const [inv] = await tx.execute<InvoiceRecord>(sql`
      SELECT id::text, entity_id::text, ledger_id::text, direction, document_kind,
             party_id::text, number, their_ref, issued_on::text, due_on::text,
             control_account_id::text, status, entry_id::text, note, print_template_selection, print_template_snapshot, fx_currency, fx_snapshot
        FROM invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`)
    if (!inv) throw new InvoiceError('NO_INVOICE', 'That invoice does not exist.')
    if (inv.fx_currency) throw new InvoiceError('FX_CORRECTION','Correct this foreign document through the FX workspace; its original currency and rate are preserved.')
    if (inv.status === 'void') {
      throw new InvoiceError('VOID', `${inv.number ?? 'That invoice'} was voided; issue another.`)
    }
    if (inv.status !== 'draft' && input.template !== undefined && input.template !== inv.print_template_selection) throw new InvoiceTemplateError('TEMPLATE_LOCKED', 'This invoice keeps its saved template version. Copy it to use a different template.')
    const selection = input.template ?? inv.print_template_selection
    if (inv.direction === 'purchase' && !['auto', 'system'].includes(selection)) throw new InvoiceTemplateError('SALES_ONLY', 'Templates apply to sales invoices and credit notes.')
    if (inv.status === 'draft' && inv.direction === 'sales' && selection !== 'auto') await resolveInvoiceTemplate(tx, inv.entity_id, input.partyId, selection)
    await assertInvoicePeriodOpen(tx, inv)
    assertInvoiceShape(inv.direction, inv.document_kind as DocumentKind, input)

    // The owner's cascade: applications touching this document — settling it,
    // or spending it (a credit note's own entry) — are released, not defended.
    const cascaded = await tx.execute<{ id: string }>(sql`
      DELETE FROM invoice_application
       WHERE invoice_id = ${invoiceId}::uuid
          OR (${inv.entry_id}::uuid IS NOT NULL AND entry_id = ${inv.entry_id}::uuid)
      RETURNING id::text`)

    await tx.execute(sql`SELECT set_config('erp.open_edit', 'on', true)`)

    const before = await tx.execute<{ account_id: string; amount: bigint
      description: string | null; dimensions: Record<string, string> }>(sql`
      SELECT account_id::text, amount, description, dimensions
        FROM invoice_line WHERE invoice_id = ${invoiceId}::uuid ORDER BY line_no`)

    try {
      await tx.execute(sql`
        UPDATE invoice
           SET party_id = ${input.partyId}::uuid,
               control_account_id = ${input.controlAccountId}::uuid,
               issued_on = ${input.issuedOn}::date, due_on = ${input.dueOn}::date,
               number = ${input.number?.trim() || null},
               their_ref = ${input.theirRef?.trim() || null},
               note = ${input.note?.trim() || null},
               print_template_selection = ${selection}
         WHERE id = ${invoiceId}::uuid`)
    } catch (e) {
      const text = causesOf(e)
      if (text.includes('invoice_number_unique')) {
        throw new InvoiceError('DUPLICATE_NUMBER',
          `${input.number} is already used by another ${inv.direction} `
          + `${inv.document_kind === 'credit_note' ? 'credit note' : 'invoice'} here.`)
      }
      throw e
    }

    await tx.execute(sql`DELETE FROM invoice_line WHERE invoice_id = ${invoiceId}::uuid`)
    for (const [i, l] of input.lines.entries()) {
      await tx.execute(sql`
        INSERT INTO invoice_line (invoice_id, line_no, account_id, description, amount,
                                  dimensions, tax_code, generated_for,
                                  input_amount, input_inclusive, gst_override, pst_override)
        VALUES (${invoiceId}::uuid, ${i + 1}, ${l.accountId}::uuid,
                ${l.description?.trim() || null}, ${l.amount},
                ${JSON.stringify(l.dimensions ?? {})}::jsonb,
                ${l.taxCode ?? null}, ${l.generatedFor ?? null},
                ${l.inputAmount ?? null}, ${l.inputInclusive ?? null},
                ${l.gstOverride ?? null}, ${l.pstOverride ?? null})`)
    }

    if (inv.status === 'posted' && inv.entry_id) {
      const after = { ...inv, party_id: input.partyId, number: input.number?.trim() || null,
                      their_ref: input.theirRef?.trim() || null,
                      control_account_id: input.controlAccountId }
      const payload = invoiceEntryPayload(after, input.lines.map((l) => ({
        account_id: l.accountId, amount: l.amount,
        description: l.description ?? null, dimensions: l.dimensions ?? {},
      })))
      await editEntryCore(tx, inv.entry_id, {
        entryDate: input.issuedOn,
        description: payload.description,
        lines: payload.lines,
      }, actor, inv.direction === 'sales' ? 'ar_invoice' : 'ap_bill')
    }

    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after)
      VALUES (${actor}, 'edit', 'invoice', ${invoiceId},
              ${JSON.stringify({ header: inv, lines: before.map((l) => ({ accountId: l.account_id, amount: String(l.amount) })) })}::jsonb,
              ${JSON.stringify({ header: { ...input, lines: undefined }, lines: input.lines.map((l) => ({ accountId: l.accountId, amount: l.amount.toString() })) })}::jsonb)`)

    // The entry it moved with, so a caller filing paper has somewhere to
    // put it (invoice-forms; the edit door offers a file box like the others).
    return { invoiceId, entryId: inv.entry_id, cascadedApplications: cascaded.length }
  })
}

/**
 * Delete a live invoice and the entry it produced, in one transaction. The
 * number is not reissued; the audit row keeps the whole document. The same
 * cascade as editInvoice releases anything applied to or by it.
 */
export async function deleteInvoice(invoiceId: string, actor = 'system', on: Runner = db) {
  return on.transaction(async (tx) => {
    await acting(tx, actor)
    await lockFinanceResource(tx,'invoice',invoiceId)
    const [inv] = await tx.execute<InvoiceRecord>(sql`
      SELECT id::text, entity_id::text, ledger_id::text, direction, document_kind,
             party_id::text, number, their_ref, issued_on::text, due_on::text,
             control_account_id::text, status, entry_id::text, note, print_template_selection, print_template_snapshot, fx_currency, fx_snapshot
        FROM invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`)
    if (!inv) throw new InvoiceError('NO_INVOICE', 'That invoice does not exist.')
    if (inv.fx_currency && inv.status !== 'draft') throw new InvoiceError('FX_CORRECTION','Void a foreign document through its correction workflow to preserve the original rate.')
    await assertInvoicePeriodOpen(tx, inv)

    const lines = await tx.execute<{ account_id: string; amount: bigint }>(sql`
      SELECT account_id::text, amount FROM invoice_line
       WHERE invoice_id = ${invoiceId}::uuid ORDER BY line_no`)

    const cascaded = await tx.execute<{ id: string }>(sql`
      DELETE FROM invoice_application
       WHERE invoice_id = ${invoiceId}::uuid
          OR (${inv.entry_id}::uuid IS NOT NULL AND entry_id = ${inv.entry_id}::uuid)
      RETURNING id::text`)

    await tx.execute(sql`SELECT set_config('erp.open_edit', 'on', true)`)
    await tx.execute(sql`DELETE FROM invoice_line WHERE invoice_id = ${invoiceId}::uuid`)
    await tx.execute(sql`DELETE FROM invoice WHERE id = ${invoiceId}::uuid`)
    if (inv.status === 'posted' && inv.entry_id) {
      await deleteEntryCore(tx, inv.entry_id, actor,
        inv.direction === 'sales' ? 'ar_invoice' : 'ap_bill')
    }

    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before)
      VALUES (${actor}, 'delete', 'invoice', ${invoiceId},
              ${JSON.stringify({ header: inv, lines: lines.map((l) => ({ accountId: l.account_id, amount: String(l.amount) })) })}::jsonb)`)

    return { number: inv.number, cascadedApplications: cascaded.length }
  })
}

export async function postInvoice(invoiceId: string, actor = 'system', on: Runner = db, paper?: { paymentStages?: string }) {
  if (paper?.paymentStages !== undefined && (typeof paper.paymentStages !== 'string' || paper.paymentStages.length > 4000)) {
    throw new InvoiceError('PAYMENT_STAGES', 'Payment stages allow up to 4,000 characters.')
  }
  const paymentStages = paper?.paymentStages?.trim()
  return on.transaction(async (tx) => {
    await acting(tx, actor)
    await lockForeignInvoice(tx,invoiceId)
    await lockFinanceResource(tx,'invoice',invoiceId)
    const [inv] = await tx.execute<InvoiceRecord>(sql`
      SELECT id::text, entity_id::text, ledger_id::text, direction, document_kind,
             party_id::text, number, their_ref, issued_on::text, due_on::text,
             control_account_id::text, status, entry_id::text, note, print_template_selection, print_template_snapshot, fx_currency, fx_snapshot
        FROM invoice WHERE id = ${invoiceId}::uuid FOR UPDATE`)
    if (!inv) throw new InvoiceError('NO_INVOICE', 'That invoice does not exist.')
    if (inv.status === 'posted') {
      throw new InvoiceError('ALREADY_POSTED',
        `${inv.number ?? 'That invoice'} is already posted.`)
    }
    if (inv.status === 'void') {
      throw new InvoiceError('VOID', `${inv.number ?? 'That invoice'} was voided.`)
    }

    if (inv.fx_currency) { await lockFxLedger(tx,inv.ledger_id); await assertCurrencyOpen(tx,inv.ledger_id,inv.fx_currency) }
    const lines = await tx.execute<{ original_amount: bigint | null; account_id: string; amount: bigint; description: string | null
      dimensions: Record<string, string> }>(sql`
      SELECT account_id::text, amount, original_amount, description, dimensions
        FROM invoice_line WHERE invoice_id = ${invoiceId}::uuid ORDER BY line_no`)
    if (lines.length === 0) {
      throw new InvoiceError('NO_LINES', 'That invoice has no lines to post.')
    }
    const template = inv.direction === 'sales'
      ? await resolveInvoiceTemplate(tx, inv.entity_id, inv.party_id, inv.print_template_selection) : null
    if (paymentStages && (inv.direction !== 'sales' || inv.document_kind !== 'invoice')) {
      throw new InvoiceError('PAYMENT_STAGES', 'Payment stages apply to sales invoices only.')
    }
    const paperSnapshot = template && paymentStages ? { ...template, paymentStages } : template

    const payload = invoiceEntryPayload(inv, lines)

    const posted = await postEntryCore(tx, {
      ledgerId: inv.ledger_id,
      entryDate: inv.issued_on,
      description: payload.description,
      sourceType: inv.direction === 'sales' ? 'ar_invoice' : 'ap_bill',
      sourceId: inv.id,
      actor,
      lines: payload.lines,
    })

    await tx.execute(sql`
      UPDATE invoice SET status = 'posted', entry_id = ${posted.entry.id}::uuid,
                         posted_at = now(), posted_by = ${actor},
                         print_template_snapshot = ${paperSnapshot ? JSON.stringify(paperSnapshot) : null}::jsonb
       WHERE id = ${invoiceId}::uuid`)

    return {
      invoiceId: inv.id, entryId: posted.entry.id, entryNo: posted.entry.entryNo,
      /** Signed: what the control account did — the first line of the payload. */
      movement: payload.lines[0].amount,
      /** What the document says. Same helper as everywhere else. */
      total: totalOf(lines.map((l) => ({ accountId: l.account_id, amount: BigInt(l.amount) })),
                     inv.direction, inv.document_kind),
    }
  })
}
