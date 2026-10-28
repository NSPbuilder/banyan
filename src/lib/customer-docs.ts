import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { BUCKETS, aging, openControlEntries } from './aging'
import { applicationsOn, balanceOf } from './payments'
import { asEnteredAmount, type DocumentKind } from './invoices'
import { standardInvoiceSnapshot, type InvoiceTemplateSnapshot } from './invoice-template-types'

/**
 * The documents a CUSTOMER sees: an invoice to send, a statement to chase
 * with. One renderer per document, two exits each (preview and print), the
 * registers' pattern — because a customer-facing money document that drifts
 * from the books is the most expensive lie this system could tell.
 *
 * Everything on these pages is read from the books at render time. The GST
 * number comes from `entity_tax_registration` AS AT THE DOCUMENT DATE — the
 * column's own comment says it is "the number that goes on an invoice", and a
 * number typed onto a template would be the second copy that outlives a
 * deregistration. The statement's aging line comes from `aging()` itself, not
 * from arithmetic of its own: one derivation, two reports, no drift to have.
 */

export class DocumentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'DocumentError'
  }
}

/** Who this company is, as at a date — the letterhead, from the records. */
export type CompanyBlock = {
  name: string
  addressLines: string[]
  /** e.g. "GST/HST 123456789RT0001" — only registrations live on the date. */
  taxNumbers: string[]
}

export async function companyBlock(entityId: string, asOf: string): Promise<CompanyBlock> {
  const [entity] = await db.execute<{ name: string }>(sql`
    SELECT name FROM entity WHERE id = ${entityId}::uuid`)

  const [office] = await db.execute<{
    delivery_address: string; delivery_city: string; delivery_postal: string | null
  }>(sql`
    SELECT delivery_address, delivery_city, delivery_postal
      FROM corporate_office
     WHERE entity_id = ${entityId}::uuid AND office = 'registered'
       AND effective_from <= ${asOf}::date
       AND (effective_to IS NULL OR effective_to >= ${asOf}::date)`)

  const regs = await db.execute<{ tax: string; number: string }>(sql`
    SELECT tax, number FROM entity_tax_registration
     WHERE entity_id = ${entityId}::uuid
       AND registered_on <= ${asOf}::date
       AND (ceased_on IS NULL OR ceased_on >= ${asOf}::date)
     ORDER BY tax`)

  return {
    name: entity?.name ?? 'Unknown company',
    addressLines: office
      ? [office.delivery_address, `${office.delivery_city} BC ${office.delivery_postal ?? ''}`.trim()]
      : [],
    taxNumbers: regs.map((r) =>
      `${r.tax === 'GST_HST' ? 'GST/HST' : r.tax} ${r.number}`),
  }
}

export async function partyBlock(partyId: string) {
  const [party] = await db.execute<{ name: string }>(sql`
    SELECT name FROM party WHERE id = ${partyId}::uuid`)
  const [addr] = await db.execute<{
    line1: string; line2: string | null; city: string | null
    region: string | null; postal_code: string | null; country: string
  }>(sql`
    SELECT line1, line2, city, region, postal_code, country
      FROM party_address WHERE party_id = ${partyId}::uuid
     ORDER BY CASE purpose WHEN 'mailing' THEN 0 WHEN 'delivery' THEN 1 ELSE 2 END
     LIMIT 1`)
  const [contact] = await db.execute<{ name: string | null; email: string | null; phone: string | null }>(sql`
    SELECT name, email, phone FROM party_contact
     WHERE party_id = ${partyId}::uuid AND is_primary LIMIT 1`)
  return {
    name: party?.name ?? 'Unknown party',
    addressLines: addr
      ? [addr.line1, addr.line2, [addr.city, addr.region, addr.postal_code].filter(Boolean).join(' '),
          addr.country.toUpperCase() !== 'CA' ? addr.country : null]
          .filter((l): l is string => !!l && l.length > 0)
      : [],
    contactLines: contact
      ? [contact.name ? `Attn: ${contact.name}` : null, contact.email, contact.phone ? `Phone: ${contact.phone}` : null]
          .filter((line): line is string => !!line)
      : [],
  }
}

export type InvoiceDocument = {
  template?: InvoiceTemplateSnapshot
  /** A payment confirmation drawn with the same invoice paper and template. */
  receipt?: { number: string; paidOn: string; amountPaid: bigint; direction: 'received' | 'paid'; invoiceNumber?: string | null }
  kind: 'invoice' | 'credit_note'
  title: string
  number: string | null
  currency?: string
  issuedOn: string
  dueOn: string
  company: CompanyBlock
  billTo: { name: string; addressLines: string[]; contactLines?: string[] }
  /** As the person entered them: positive is what the line adds. */
  lines: Array<{ description: string; amount: bigint; generatedFor?: string | null }>
  total: bigint
  payments: Array<{ on: string; what: string; amount: bigint }>
  balance: bigint
}

/**
 * One invoice (or credit note), as its customer should receive it.
 *
 * Sales side only: a purchase bill is the SUPPLIER'S document — printing our
 * record of it as if it were the paper would be manufacturing someone else's
 * invoice, so it is refused by name rather than rendered wrong.
 */
async function invoiceDocument(invoiceId: string, receiptSource = false): Promise<InvoiceDocument> {
  const [inv] = await db.execute<{
    id: string; entity_id: string; direction: string; document_kind: string
    status: string; number: string | null; issued_on: string; due_on: string
    party_id: string; currency: string
    print_template_snapshot: InvoiceTemplateSnapshot | null
  }>(sql`
    SELECT i.id::text, i.entity_id::text, i.direction, i.document_kind, i.status,
           i.number, i.issued_on::text, i.due_on::text, i.party_id::text, i.print_template_snapshot,
           COALESCE(i.fx_currency,l.currency) AS currency
      FROM invoice i JOIN ledger l ON l.id = i.ledger_id WHERE i.id = ${invoiceId}::uuid`)
  if (!inv) throw new DocumentError('NO_INVOICE', 'That invoice does not exist.')
  if (inv.direction !== 'sales' && !receiptSource) {
    throw new DocumentError('NOT_OURS',
      "A purchase bill is the supplier's document; there is nothing of ours to print.")
  }
  if (inv.status !== 'posted') {
    throw new DocumentError('NOT_POSTED',
      `Only a posted document goes to a customer; this one is ${inv.status}.`)
  }

  const lines = await db.execute<{ description: string | null; amount: bigint; generated_for: string | null }>(sql`
    SELECT description, COALESCE(original_amount,amount) AS amount, generated_for FROM invoice_line
     WHERE invoice_id = ${invoiceId}::uuid ORDER BY line_no`)

  const [company, billTo, item, apps] = await Promise.all([
    companyBlock(inv.entity_id, inv.issued_on),
    partyBlock(inv.party_id),
    balanceOf(invoiceId),
    applicationsOn(invoiceId),
  ])

  const isNote = inv.document_kind === 'credit_note'
  return {
    template: inv.print_template_snapshot ?? standardInvoiceSnapshot(),
    kind: isNote ? 'credit_note' : 'invoice',
    title: isNote ? 'Credit note' : 'Invoice',
    number: inv.number,
    currency: inv.currency.trim(),
    issuedOn: inv.issued_on,
    dueOn: inv.due_on,
    company,
    billTo,
    // As the person entered them — keyed on (direction, kind) through the one
    // shared helper, because keying on direction alone printed a credit note
    // whose lines were the negation of its own total.
    lines: lines.map((l) => ({
      description: l.description ?? '',
      amount: asEnteredAmount(inv.direction as 'sales' | 'purchase', inv.document_kind as DocumentKind, BigInt(l.amount)),
      generatedFor: l.generated_for,
    })),
    total: item.native_debt ?? item.debt,
    payments: apps.map((a) => ({
      on: a.entry_date, what: a.description ?? a.entry_no, amount: BigInt(a.original_amount ?? a.amount),
    })),
    balance: item.native_balance ?? item.balance,
  }
}

export async function renderInvoiceDocument(invoiceId: string): Promise<InvoiceDocument> {
  return invoiceDocument(invoiceId)
}

/** Read the original items for our payment confirmation, never reissue a supplier invoice. */
export async function invoiceDocumentForReceipt(invoiceId: string): Promise<InvoiceDocument> {
  const doc = await invoiceDocument(invoiceId, true)
  if(doc.currency !== 'CAD') throw new DocumentError('FX_RECEIPT','Review the original-currency settlement in the FX workspace; this receipt form currently supports CAD only.')
  if (doc.kind !== 'invoice') throw new DocumentError('NOT_AN_INVOICE', 'A credit note is not a cash payment.')
  return doc
}

export type CustomerStatement = {
  asOf: string
  company: CompanyBlock
  party: { name: string; addressLines: string[] }
  items: Array<{
    number: string | null; kind: string; issuedOn: string; dueOn: string
    original: bigint; applied: bigint; balance: bigint
  }>
  totalOwed: bigint
  /** Straight from `aging()` for this party — the same figures that report shows. */
  agingLine: { labels: string[]; amounts: bigint[] } | null
}

/**
 * What one customer owes, document by document, with the aging report's own
 * bucket line under it. The bucket figures are `aging()`'s for this party —
 * called, not recomputed — so this letter and that report cannot disagree.
 */
export async function renderCustomerStatement(
  ledgerId: string, partyId: string, asOf: string,
): Promise<CustomerStatement> {
  const [entityRow] = await db.execute<{ entity_id: string }>(sql`
    SELECT entity_id::text FROM ledger WHERE id = ${ledgerId}::uuid`)
  if (!entityRow) throw new DocumentError('NO_LEDGER', 'No such ledger.')

  const [company, party, ar, openEntries] = await Promise.all([
    companyBlock(entityRow.entity_id, asOf),
    partyBlock(partyId),
    aging(ledgerId, 'trade_receivables', asOf),
    openControlEntries(ledgerId, 'trade_receivables', asOf, partyId),
  ])

  // EVERYTHING on the statement comes from the one as-at derivation the aging
  // report uses. The first version listed documents from the CURRENT balances
  // and only the aging line as-at, so a statement backdated to March showed
  // rows already shrunk by April's payments under an aging line that had not
  // heard of them — 160,000 of rows beneath a 300,000 line, both defensible
  // alone. One derivation, one date, or two answers.
  //
  // A document entry appears as its document (number, kind, terms); an open
  // entry belonging to NO document is money on account — an unapplied receipt,
  // which a statement must show or it asks for more than the books say.
  const items = openEntries
    .map((e) => {
      if (e.invoice_id !== null) {
        const kind = e.document_kind ?? 'invoice'
        const open = BigInt(e.open_amount)
        // The document's face value is its entry's full movement; as at this
        // date, applied = face − |open|. Signs for the reader: a credit note
        // REDUCES what is owed, so its rows print negative.
        return {
          number: e.number, kind, issuedOn: e.entry_date, dueOn: e.due_on ?? e.entry_date,
          original: open, applied: 0n, balance: open, entryId: e.entry_id,
        }
      }
      return {
        number: e.entry_no, kind: 'on_account', issuedOn: e.entry_date,
        dueOn: e.entry_date, original: BigInt(e.open_amount), applied: 0n,
        balance: BigInt(e.open_amount), entryId: e.entry_id,
      }
    })

  // Fill in each document's face value and settled-as-at figure, so the reader
  // sees original / settled / open and the three agree by arithmetic.
  const docIds = openEntries
    .filter((e) => e.invoice_id !== null)
    .map((e) => e.entry_id)
  if (docIds.length > 0) {
    const faces = await db.execute<{ entry_id: string; face: bigint }>(sql`
      SELECT jl.entry_id::text, SUM(jl.amount) AS face
        FROM journal_line jl
        JOIN invoice i ON i.entry_id = jl.entry_id
       WHERE jl.entry_id IN (${sql.join(docIds.map((d) => sql`${d}::uuid`), sql`, `)})
         AND jl.account_id = i.control_account_id
         AND jl.party_id = i.party_id
       GROUP BY jl.entry_id`)
    const faceOf = new Map(faces.map((f) => [f.entry_id, BigInt(f.face)]))
    for (const it of items) {
      if (it.kind === 'on_account') continue
      const face = faceOf.get(it.entryId)
      if (face === undefined) continue
      // Face value keeps the ledger's sign — positive debt for an invoice,
      // negative for a credit note — so the note's rows read as reductions
      // without a special case. Settled is ORIGINAL − OPEN, signed: one
      // arithmetic for every row, so a reader's subtraction always lands on
      // the Open column. The magnitude version printed a partially spent note
      // as −400 | 250 | −150, whose subtraction gives −650.
      it.original = face
      it.applied = face - it.balance
    }
  }
  items.sort((a, b) => a.issuedOn.localeCompare(b.issuedOn))

  const agingRow = ar.rows.find((r) => r.party_id === partyId) ?? null

  return {
    asOf,
    company,
    party,
    items,
    totalOwed: items.reduce((s, i) => s + i.balance, 0n),
    // A party whose open items net to zero drops off the aging report (its
    // HAVING clause) while their offsetting rows still print above — so the
    // line is rendered as explicit zeroes rather than omitted, and the reader
    // sees the letter and the report agreeing on nothing owed.
    agingLine: agingRow
      ? { labels: BUCKETS.map((b) => b.label), amounts: agingRow.buckets }
      : items.length > 0
        ? { labels: BUCKETS.map((b) => b.label), amounts: BUCKETS.map(() => 0n) }
        : null,
  }
}
