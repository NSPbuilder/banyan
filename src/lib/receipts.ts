import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { companyBlock, partyBlock, invoiceDocumentForReceipt, DocumentError, type InvoiceDocument } from './customer-docs'
import { resolveInvoiceTemplate } from './invoice-templates'
import { projectReceiptNumber } from './receipt-number'

type Payment = {
  id: string; entity_id: string; ledger_id: string; currency: string; entry_no: string | null
  paid_on: string; created_at: string; cash: string; parties: string[]
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function ids(...values: string[]) {
  if (values.some(value => !UUID.test(value))) throw new DocumentError('NO_RECEIPT', 'That payment does not exist.')
}
const magnitude = (value: string | bigint) => { const n = BigInt(value); return n < 0n ? -n : n }
const validEntry = sql`j.status = 'posted' AND j.reverses_id IS NULL AND j.reversed_by_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM journal_entry replacement WHERE replacement.replaces_id = j.id AND replacement.status <> 'draft')`

async function payment(ledgerId: string, entryId: string): Promise<Payment> {
  ids(ledgerId, entryId)
  const [row] = await db.execute<Payment>(sql`
    SELECT j.id::text, l.entity_id::text, j.ledger_id::text, l.currency, j.entry_no,
      j.entry_date::text AS paid_on, j.created_at::text,
      coalesce((SELECT sum(line.amount) FROM journal_line line WHERE line.entry_id = j.id AND EXISTS
        (SELECT 1 FROM account_role ar WHERE ar.account_id = line.account_id AND ar.role = 'cash_and_cash_equivalents')), 0)::text AS cash,
      ARRAY(SELECT DISTINCT line.party_id::text FROM journal_line line WHERE line.entry_id = j.id AND line.party_id IS NOT NULL) AS parties
    FROM journal_entry j JOIN ledger l ON l.id = j.ledger_id
    WHERE j.id = ${entryId}::uuid AND j.ledger_id = ${ledgerId}::uuid
      AND j.source_type IN ('payment', 'quick_income', 'quick_expense') AND ${validEntry}`)
  if (!row || BigInt(row.cash) === 0n) throw new DocumentError('NO_RECEIPT', 'Only a current posted cash payment has a receipt.')
  return row
}

export async function paymentReceiptAvailable(ledgerId: string, entryId: string): Promise<boolean> {
  try { await payment(ledgerId, entryId); return true }
  catch (error) { if (error instanceof DocumentError) return false; throw error }
}

function confirm(doc: InvoiceDocument, number: string, paidOn: string, amountPaid: bigint,
  direction: 'received' | 'paid', history: InvoiceDocument['payments']): InvoiceDocument {
  return { ...doc, title: 'Receipt', receipt: { number, paidOn, amountPaid, direction, invoiceNumber: doc.number },
    payments: history, balance: 0n }
}

async function plain(entityId: string, partyId: string | null, currency: string, paidOn: string,
  lines: InvoiceDocument['lines'], total: bigint): Promise<InvoiceDocument> {
  const [company, billTo, template] = await Promise.all([
    companyBlock(entityId, paidOn),
    partyId ? partyBlock(partyId) : Promise.resolve({ name: 'Unspecified party', addressLines: [] }),
    db.transaction(tx => resolveInvoiceTemplate(tx, entityId, partyId)),
  ])
  return { kind: 'invoice', title: 'Receipt', number: null, currency: currency.trim(), issuedOn: paidOn, dueOn: paidOn,
    company, billTo, template, lines, total, payments: [], balance: 0n }
}

async function invoiceReceipt(head: Payment, invoiceId: string): Promise<InvoiceDocument> {
  ids(invoiceId)
  const [current] = await db.execute<{ amount: string; direction: string }>(sql`
    SELECT sum(a.amount)::text AS amount, i.direction
    FROM invoice_application a JOIN invoice i ON i.id = a.invoice_id
    WHERE a.entry_id = ${head.id}::uuid AND i.id = ${invoiceId}::uuid AND i.ledger_id = ${head.ledger_id}::uuid
      AND i.status = 'posted' AND i.document_kind = 'invoice'
    GROUP BY i.id`)
  if (!current || (current.direction === 'sales') !== (BigInt(head.cash) > 0n))
    throw new DocumentError('NO_RECEIPT', 'That payment does not settle this invoice.')
  const doc = await invoiceDocumentForReceipt(invoiceId)
  const history = await db.execute<{ on: string; amount: string }>(sql`
    SELECT j.entry_date::text AS "on", sum(a.amount)::text AS amount
    FROM invoice_application a JOIN journal_entry j ON j.id = a.entry_id
    WHERE a.invoice_id = ${invoiceId}::uuid AND j.ledger_id = ${head.ledger_id}::uuid
      AND j.source_type = 'payment' AND ${validEntry}
      AND coalesce((SELECT sum(line.amount) FROM journal_line line WHERE line.entry_id = j.id
        AND EXISTS (SELECT 1 FROM account_role ar WHERE ar.account_id = line.account_id AND ar.role = 'cash_and_cash_equivalents')), 0) <> 0
      AND (j.entry_date < ${head.paid_on}::date OR (j.entry_date = ${head.paid_on}::date AND j.created_at <= ${head.created_at}::timestamptz))
    GROUP BY j.id ORDER BY j.entry_date, j.created_at, j.id`)
  return confirm(doc, `R-${head.entry_no}`, head.paid_on, BigInt(current.amount), BigInt(head.cash) > 0n ? 'received' : 'paid',
    history.map(row => ({ on: row.on, what: '', amount: BigInt(row.amount) })))
}

/** The invoice-specific route confirms that invoice's share of a split payment. */
export async function renderPaymentReceipt(ledgerId: string, entryId: string, invoiceId?: string): Promise<InvoiceDocument> {
  const head = await payment(ledgerId, entryId)
  if (invoiceId) return invoiceReceipt(head, invoiceId)
  const applications = await db.execute<{ invoice_id: string; number: string | null; amount: string }>(sql`
    SELECT i.id::text AS invoice_id, i.number, sum(a.amount)::text AS amount
    FROM invoice_application a JOIN invoice i ON i.id = a.invoice_id
    WHERE a.entry_id = ${entryId}::uuid AND i.ledger_id = ${ledgerId}::uuid AND i.status = 'posted' AND i.document_kind = 'invoice'
    GROUP BY i.id ORDER BY i.number, i.id`)
  const amount = magnitude(head.cash), applied = applications.reduce((n, row) => n + BigInt(row.amount), 0n)
  if (applications.length === 1 && applied === amount && head.parties.length === 1) return invoiceReceipt(head, applications[0].invoice_id)
  const direction = BigInt(head.cash) > 0n ? 'received' : 'paid'
  const lines = applications.map(row => ({ description: `Payment - ${row.number ?? 'Invoice'}`, amount: BigInt(row.amount) }))
  if (amount > applied) lines.push({ description: applications.length ? 'Payment on account' : direction === 'received' ? 'Payment received' : 'Payment made', amount: amount - applied })
  if (applied > amount) throw new DocumentError('PAYMENT_SHAPE', 'The payment allocations exceed its cash amount. Review the original payment.')
  const doc = await plain(head.entity_id, head.parties.length === 1 ? head.parties[0] : null, head.currency, head.paid_on, lines, amount)
  if (head.parties.length > 1) doc.billTo = { name: 'Multiple parties', addressLines: [] }
  return confirm(doc, `R-${head.entry_no}`, head.paid_on, amount, direction, [{ on: head.paid_on, what: '', amount }])
}

/** Project-only operational payments and their accounting mirrors share the same receipt door. */
export async function renderProjectPaymentReceipt(ledgerId: string, projectId: string, paymentId: string): Promise<InvoiceDocument> {
  ids(ledgerId, projectId, paymentId)
  const [pay] = await db.execute<{
    entity_id: string; party_id: string | null; currency: string; code: string; direction: 'received' | 'paid'
    payment_date: string; created_at: string; amount: string; entry_id: string | null; entry_ledger_id: string | null; linked: boolean
  }>(sql`
    SELECT p.entity_id::text, pay.party_id::text, p.currency, p.code, pay.direction, pay.payment_date::text,
      pay.created_at::text, pay.amount_cents::text AS amount, h.entry_id::text, j.ledger_id::text AS entry_ledger_id, h.payment_id IS NOT NULL AS linked
    FROM project_payment pay JOIN project p ON p.id = pay.project_id
    JOIN ledger l ON l.entity_id = p.entity_id AND l.id = ${ledgerId}::uuid
    LEFT JOIN project_accounting_payment h ON h.payment_id = pay.id LEFT JOIN journal_entry j ON j.id = h.entry_id
    WHERE pay.id = ${paymentId}::uuid AND pay.project_id = ${projectId}::uuid AND pay.state = 'active' AND p.deleted_at IS NULL`)
  if (!pay) throw new DocumentError('NO_RECEIPT', 'That project payment does not exist.')
  if (pay.linked && !pay.entry_id) throw new DocumentError('NO_RECEIPT', 'The original accounting payment was removed.')
  let number = projectReceiptNumber(paymentId)
  if (pay.entry_id) {
    if (pay.entry_ledger_id !== ledgerId) throw new DocumentError('NO_RECEIPT', 'Open this payment in its original accounting book.')
    const head = await payment(ledgerId, pay.entry_id)
    if ((pay.direction === 'received') !== (BigInt(head.cash) > 0n) || BigInt(pay.amount) > magnitude(head.cash))
      throw new DocumentError('PAYMENT_SHAPE', 'The project payment differs from its accounting cash amount.')
    number = projectReceiptNumber(paymentId, head.entry_no)
  }
  const records = await db.execute<{ id: string; description: string; amount: string; invoice_id: string | null }>(sql`
    SELECT r.id::text, r.description, sum(a.amount_cents)::text AS amount,
      coalesce((SELECT h.invoice_id::text FROM project_accounting_link h WHERE h.record_id = r.id AND h.state = 'active'),
        (SELECT h.invoice_id::text FROM project_invoice_handoff h WHERE h.record_id = r.id)) AS invoice_id
    FROM project_payment_allocation a JOIN project_record r ON r.id = a.record_id
    WHERE a.payment_id = ${paymentId}::uuid AND a.state = 'active' AND r.state = 'active'
    GROUP BY r.id ORDER BY r.record_date, r.id`)
  const amount = BigInt(pay.amount), allocated = records.reduce((n, row) => n + BigInt(row.amount), 0n)
  if (allocated > amount) throw new DocumentError('PAYMENT_SHAPE', 'The project allocations exceed this payment.')
  if (records.length === 1 && allocated === amount) {
    const record = records[0]
    let doc: InvoiceDocument | undefined
    if (record.invoice_id) {
      const [posted] = await db.execute(sql`SELECT id FROM invoice WHERE id = ${record.invoice_id}::uuid AND entity_id = ${pay.entity_id}::uuid AND status = 'posted' AND document_kind = 'invoice'`)
      if (posted) doc = await invoiceDocumentForReceipt(record.invoice_id)
    }
    if (!doc) {
      const lines = await db.execute<{ description: string; base: string; gst: string; pst: string }>(sql`
        SELECT description, base_cents::text AS base, gst_cents::text AS gst, pst_cents::text AS pst
        FROM project_record_line WHERE record_id = ${record.id}::uuid ORDER BY position`)
      const items: InvoiceDocument['lines'] = lines.map(row => ({ description: row.description || record.description, amount: BigInt(row.base) }))
      for (const [key, label] of [['gst', 'GST/HST'], ['pst', 'PST/QST']] as const) {
        const tax = lines.reduce((n, row) => n + BigInt(row[key]), 0n)
        if (tax) items.push({ description: label, amount: tax, generatedFor: key.toUpperCase() })
      }
      doc = await plain(pay.entity_id, pay.party_id, pay.currency, pay.payment_date, items, items.reduce((n, row) => n + row.amount, 0n))
    }
    const history = await db.execute<{ on: string; amount: string }>(sql`
      SELECT other.payment_date::text AS "on", sum(a.amount_cents)::text AS amount
      FROM project_payment_allocation a JOIN project_payment other ON other.id = a.payment_id
      LEFT JOIN project_accounting_payment h ON h.payment_id = other.id LEFT JOIN journal_entry j ON j.id = h.entry_id
      WHERE a.record_id = ${record.id}::uuid AND a.state = 'active' AND other.state = 'active'
        AND other.project_id = ${projectId}::uuid AND other.direction = ${pay.direction}
        AND (h.payment_id IS NULL OR (h.entry_id IS NOT NULL AND ${validEntry}))
        AND (other.payment_date < ${pay.payment_date}::date OR (other.payment_date = ${pay.payment_date}::date AND other.created_at <= ${pay.created_at}::timestamptz))
      GROUP BY other.id ORDER BY other.payment_date, other.created_at, other.id`)
    return confirm(doc, number, pay.payment_date, amount, pay.direction, history.map(row => ({ on: row.on, what: '', amount: BigInt(row.amount) })))
  }
  const lines = records.map(row => ({ description: row.description || `Project ${pay.code}`, amount: BigInt(row.amount) }))
  if (amount > allocated) lines.push({ description: `Project ${pay.code} - payment on account`, amount: amount - allocated })
  const doc = await plain(pay.entity_id, pay.party_id, pay.currency, pay.payment_date, lines, amount)
  return confirm(doc, number, pay.payment_date, amount, pay.direction, [{ on: pay.payment_date, what: '', amount }])
}
