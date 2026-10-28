/** Run only in a newly created, explicitly confirmed Receipt TEST database. */
import './env'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { sql as q } from 'drizzle-orm'
import { db, sql } from '../src/db/client'
import { createFirstOwner, createUser, signIn } from '../src/lib/users'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { MODULE_PATHS } from '../src/lib/nav'
import { setCompanyModules } from '../src/lib/company-modules'
import { setGrants } from '../src/lib/access'
import { createInvoice, postInvoice } from '../src/lib/invoices'
import { recordPayment, applyEntryToInvoice, balanceOf, deletePayment } from '../src/lib/payments'
import { postEntry, reverseEntry } from '../src/lib/posting'
import { createProject, saveProjectRecord, createProjectPayment, voidProjectItem, updateProject } from '../src/lib/project'
import { saveProjectFinanceRecord, saveProjectFinancePayment, projectFinanceLinks } from '../src/lib/project-finance'
import { createInvoiceTemplate, reviseInvoiceTemplate, setInvoiceTemplateAssignment } from '../src/lib/invoice-templates'
import { renderInvoiceDocument, DocumentError } from '../src/lib/customer-docs'
import { renderPaymentReceipt, renderProjectPaymentReceipt, paymentReceiptAvailable } from '../src/lib/receipts'
import { invoicePaperPdf } from '../src/lib/pdf-reports'
import { invoicePaper } from '../src/lib/invoice-paper'
import { receiptResponse } from '../src/lib/receipt-http'

const evidence = 'docs/evidence/payment-receipts-2026-10-14'
let checks = 0
function check(value: unknown, label: string) { assert(value, label); console.log(`PASS RC${++checks} ${label}`) }
async function refuse(fn: () => Promise<unknown>, label: string) {
  await assert.rejects(fn, error => error instanceof DocumentError); check(true, label)
}
async function main() {
  const proof = JSON.parse(readFileSync(evidence + '/isolation.json', 'utf8'))
  const [identity] = await db.execute<{ name: string }>(q`SELECT current_database() AS name`)
  assert(proof.createdNew && !proof.productionTouched && identity.name === proof.testDatabase && process.env.TEST_DATABASE_CONFIRMATION === identity.name)
  assert((await db.execute(q`SELECT id FROM entity`)).length === 0, 'Fixture requires a fresh isolated database')
  const password = 'Receipt-Test-Only-123!', me = await createFirstOwner({ email: 'receipt@example.test', firstName: 'Receipt tester', password })
  const co = await createCompanyWithYear({ code: 'RCPT', name: 'Receipt Sample Ltd.' }, me.email)
  const foreign = await createCompanyWithYear({ code: 'RCPTB', name: 'Other Receipt Company' }, me.email)
  await setCompanyModules(me, { entityId: co.company.id, modules: MODULE_PATHS })
  const chart = '1000,Bank,asset,,cash_and_cash_equivalents\n1010,Other bank,asset,,cash_and_cash_equivalents\n1200,Receivables,asset,,trade_receivables\n2100,Payables,liability,,trade_payables\n2200,GST payable,liability,,gst_hst_payable\n2300,PST payable,liability,,qst_pst_payable\n4000,Revenue,revenue,,revenue_from_contracts\n5100,Materials,expense,,'
  const accounts = await importAccounts(co.company.id, parseAccountsCsv(chart).map(row => ({ ...row, entityId: co.company.id })), me.email)
  const at = (code: string) => accounts.find(a => a.code === code)!.id
  const customer = await createParty({ kind: 'organisation', name: 'Receipt Customer', actor: me.email,
    notes: 'PRIVATE PARTY NOTE', primaryContact: { name: 'Pat Client', email: 'client@example.test', phone: '604-555-0123' },
    mailingAddress: { line1: '125 Customer Street', city: 'Vancouver', region: 'BC', postalCode: 'V6B 1A1', country: 'CA' }, roles: [{ entityId: co.company.id, role: 'customer' }] })
  const supplier = await createParty({ kind: 'organisation', name: 'Receipt Supplier', actor: me.email, roles: [{ entityId: co.company.id, role: 'supplier' }] })
  const template = await createInvoiceTemplate(me, { entityId: co.company.id, name: 'Receipt shared template',
    settings: { layout: 'standard', paymentInstructions: '', footer: 'Thank you for your payment.',
      contact: { address: '456 Company Street', city: 'Vancouver', province: 'BC', postalCode: 'V5Z 3M7', officePhone: '604-555-0100', cellPhone: '', email: 'accounts@example.test' } } })
  await setInvoiceTemplateAssignment(me, { ledgerId: co.ledger.id, templateId: template })
  const invoice = await createInvoice({ ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id, number: 'RC-001', issuedOn: '2026-01-01', dueOn: '2026-02-01', controlAccountId: at('1200'), actor: me.email,
    lines: [{ accountId: at('4000'), amount: -100000n, description: 'Design and installation' }, { accountId: at('2200'), amount: -5000n, description: 'GST/HST', generatedFor: 'GST' }, { accountId: at('2300'), amount: -7000n, description: 'PST', generatedFor: 'PST' }] })
  await postInvoice(invoice.id, me.email)
  const first = await recordPayment({ invoiceId: invoice.id, bankAccountId: at('1000'), amount: 20000n, paidOn: '2026-01-10', actor: me.email })
  const second = await recordPayment({ invoiceId: invoice.id, bankAccountId: at('1000'), amount: 30000n, paidOn: '2026-01-20', actor: me.email })
  const later = await recordPayment({ invoiceId: invoice.id, bankAccountId: at('1000'), amount: 10000n, paidOn: '2026-02-10', actor: me.email })
  const sameDayLater = await recordPayment({ invoiceId: invoice.id, bankAccountId: at('1000'), amount: 1000n, paidOn: '2026-01-20', actor: me.email })
  const credit = await createInvoice({ ledgerId: co.ledger.id, direction: 'sales', kind: 'credit_note', partyId: customer.id, number: 'RC-CN', issuedOn: '2026-01-15', dueOn: '2026-01-15', controlAccountId: at('1200'), actor: me.email, lines: [{ accountId: at('4000'), amount: 5000n }] })
  await postInvoice(credit.id, me.email)
  const [creditEntry] = await db.execute<{ entry_id: string }>(q`SELECT entry_id::text FROM invoice WHERE id = ${credit.id}::uuid`)
  await applyEntryToInvoice({ invoiceId: invoice.id, entryId: creditEntry.entry_id, amount: 5000n, actor: me.email })
  const before = await balanceOf(invoice.id)
  const doc = await renderPaymentReceipt(co.ledger.id, second.entryId, invoice.id)
  check(doc.title === 'Receipt' && doc.receipt?.amountPaid === 30000n && doc.total === 112000n, 'receipt confirms this payment and retains original invoice total')
  check(doc.payments.length === 2 && doc.payments[0].amount === 20000n && doc.payments[1].amount === 30000n, 'history excludes later dates, later same-day payments and credit notes')
  check(doc.receipt?.invoiceNumber === 'RC-001' && doc.receipt.paidOn === '2026-01-20', 'receipt retains invoice reference and actual payment date')
  check(invoicePaper(doc).summary.map(row => row.label).join('|') === 'Subtotal|GST/HST|PST|Total', 'receipt preserves actual tax lines without recalculating rates')
  check(invoicePaper(doc).headline === '$300.00 CAD paid on January 20, 2026', 'headline confirms the selected payment, rather than future or cumulative cash')
  check(doc.billTo.contactLines?.includes('client@example.test') && doc.billTo.addressLines.includes('125 Customer Street'), 'shared Party contact and address appear on receipt')
  const normal = await renderInvoiceDocument(invoice.id)
  check(normal.title === 'Invoice' && !normal.receipt && invoicePaper(normal).summary.some(row => row.label === 'Amount due'), 'normal invoice behavior remains intact')
  await reviseInvoiceTemplate(me, { templateId: template, version: 1, name: 'Receipt shared template', isActive: true, settings: { ...doc.template!.settings, footer: 'Revised footer' } })
  check((await renderPaymentReceipt(co.ledger.id, first.entryId)).template?.settings.footer === 'Thank you for your payment.', 'receipt uses the original invoice template snapshot')
  await refuse(() => renderPaymentReceipt(foreign.ledger.id, second.entryId, invoice.id), 'wrong company payment is refused')
  await refuse(() => renderPaymentReceipt(co.ledger.id, second.entryId, credit.id), 'unrelated document and credit-note receipt are refused')
  await refuse(() => renderPaymentReceipt(co.ledger.id, 'bad-id'), 'malformed IDs are refused without database casts')
  check((await balanceOf(invoice.id)).balance === before.balance, 'receipt generation leaves invoice applications and ledger balance unchanged')

  const bill = await createInvoice({ ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id, number: 'SUP-01', issuedOn: '2026-01-01', dueOn: '2026-02-01', controlAccountId: at('2100'), actor: me.email, lines: [{ accountId: at('5100'), amount: 50000n, description: 'Materials supplied' }] })
  await postInvoice(bill.id, me.email)
  const paid = await recordPayment({ invoiceId: bill.id, bankAccountId: at('1000'), amount: 15000n, paidOn: '2026-01-20', actor: me.email })
  const supplierDoc = await renderPaymentReceipt(co.ledger.id, paid.entryId, bill.id)
  check(supplierDoc.receipt?.direction === 'paid' && supplierDoc.total === 50000n && supplierDoc.receipt.amountPaid === 15000n, 'outgoing supplier payment has our payment confirmation with original positive items')
  await refuse(() => renderInvoiceDocument(bill.id), 'supplier invoice still cannot be reissued as our invoice')
  const advance = await postEntry({ ledgerId: co.ledger.id, entryDate: '2026-01-09', description: 'PRIVATE ENTRY NOTE', sourceType: 'payment', actor: me.email,
    lines: [{ accountId: at('1000'), amount: 75000n }, { accountId: at('1200'), amount: -75000n, partyId: customer.id }] })
  const advanceDoc = await renderPaymentReceipt(co.ledger.id, advance.entry.id)
  check(advanceDoc.total === 75000n && advanceDoc.payments.length === 1 && !advanceDoc.receipt?.invoiceNumber, 'unallocated advance can issue a receipt without inventing an invoice')
  check(advanceDoc.template?.settings.footer === 'Revised footer', 'unlinked payments use the current assigned Invoice template')
  const extra = await createInvoice({ ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id, number: 'RC-002', issuedOn: '2026-01-01', dueOn: '2026-02-01', controlAccountId: at('1200'), actor: me.email, lines: [{ accountId: at('4000'), amount: -40000n }] })
  await postInvoice(extra.id, me.email)
  await applyEntryToInvoice({ invoiceId: invoice.id, entryId: advance.entry.id, amount: 5000n, actor: me.email })
  await applyEntryToInvoice({ invoiceId: extra.id, entryId: advance.entry.id, amount: 15000n, actor: me.email })
  const split = await renderPaymentReceipt(co.ledger.id, advance.entry.id)
  check(split.total === 75000n && split.lines.reduce((n, line) => n + line.amount, 0n) === 75000n && split.lines.length === 3, 'split and partly unapplied payment confirms full cash once')
  check((await renderPaymentReceipt(co.ledger.id, advance.entry.id, extra.id)).receipt?.amountPaid === 15000n, 'invoice-specific receipt confirms only its share of split cash')
  const quick = await postEntry({ ledgerId: co.ledger.id, entryDate: '2026-01-12', description: 'Income payment', sourceType: 'quick_income', actor: me.email,
    lines: [{ accountId: at('1000'), amount: 1000n }, { accountId: at('4000'), amount: -1000n }] })
  check(await paymentReceiptAvailable(co.ledger.id, quick.entry.id), 'quick cash income also has a receipt')
  const manual = await postEntry({ ledgerId: co.ledger.id, entryDate: '2026-01-12', description: 'Manual journal', actor: me.email, lines: [{ accountId: at('1000'), amount: 1000n }, { accountId: at('4000'), amount: -1000n }] })
  check(!await paymentReceiptAvailable(co.ledger.id, manual.entry.id), 'ordinary manual journals are not presented as payments')
  const transfer = await postEntry({ ledgerId: co.ledger.id, entryDate: '2026-01-12', description: 'Bank transfer', sourceType: 'payment', actor: me.email, lines: [{ accountId: at('1000'), amount: 1000n }, { accountId: at('1010'), amount: -1000n }] })
  check(!await paymentReceiptAvailable(co.ledger.id, transfer.entry.id), 'cash transfers with zero net payment have no receipt')
  const invalid = await postEntry({ ledgerId: co.ledger.id, entryDate: '2026-01-12', description: 'Reversed payment', sourceType: 'payment', actor: me.email, lines: [{ accountId: at('1000'), amount: 1000n }, { accountId: at('1200'), amount: -1000n, partyId: customer.id }] })
  const reversal = await reverseEntry(invalid.entry.id, '2026-01-13', 'Correction', me.email)
  check(!await paymentReceiptAvailable(co.ledger.id, invalid.entry.id), 'reversed original payment has no valid receipt')
  await refuse(() => renderPaymentReceipt(co.ledger.id, reversal.reversal.id), 'reversal is not a new receipt')
  const deleted = await recordPayment({ invoiceId: extra.id, bankAccountId: at('1000'), amount: 1000n, paidOn: '2026-01-14', actor: me.email })
  await deletePayment(deleted.entryId, me.email)
  await refuse(() => renderPaymentReceipt(co.ledger.id, deleted.entryId), 'deleted payments have no receipt')

  const projectId = await createProject({ entityId: co.company.id, code: 'RC-PROJECT', name: 'Receipt project', currency: 'CAD', customerPartyId: customer.id, actor: me.email })
  const recordId = await saveProjectRecord({ entityId: co.company.id, projectId, kind: 'revenue', partyId: customer.id, date: '2026-01-01', description: 'Project installation', actor: me.email,
    lines: [{ kind: 'revenue', description: 'Project installation', base: 100000n, gst: 5000n, pst: 7000n, gstRecoverable: null, pstRecoverable: null }] })
  const projectBase = { entityId: co.company.id, projectId, partyId: customer.id, direction: 'received' as const, actor: me.email, recordId }
  await createProjectPayment({ ...projectBase, date: '2026-01-10', amount: 20000n, key: randomUUID() })
  const projectPayment = await createProjectPayment({ ...projectBase, date: '2026-01-20', amount: 30000n, note: 'PRIVATE PROJECT NOTE', key: randomUUID() })
  await createProjectPayment({ ...projectBase, date: '2026-02-10', amount: 10000n, key: randomUUID() })
  const cancelled = await createProjectPayment({ ...projectBase, date: '2026-01-15', amount: 1000n, key: randomUUID() })
  await voidProjectItem({ entityId: co.company.id, projectId, id: cancelled, kind: 'payment', version: 1, reason: 'Test cancel', actor: me.email })
  const projectDoc = await renderProjectPaymentReceipt(co.ledger.id, projectId, projectPayment)
  check(projectDoc.total === 112000n && projectDoc.receipt?.amountPaid === 30000n && projectDoc.payments.length === 2, 'operational Project receipt retains items, exact tax and prior payments')
  check(projectDoc.payments.reduce((n, row) => n + row.amount, 0n) === 50000n, 'Project history excludes future and cancelled payments')
  await refuse(() => renderProjectPaymentReceipt(foreign.ledger.id, projectId, projectPayment), 'cross-company Project receipt is refused')
  await refuse(() => renderProjectPaymentReceipt(co.ledger.id, projectId, cancelled), 'cancelled Project payment receipt is refused')
  const projectAdvance = await createProjectPayment({ ...projectBase, recordId: undefined, date: '2026-01-09', amount: 10000n, key: randomUUID() })
  check((await renderProjectPaymentReceipt(co.ledger.id, projectId, projectAdvance)).total === 10000n, 'Project advance has a receipt without an invoice')
  const financeProject = await createProject({ entityId: co.company.id, code: 'RC-FINANCE', name: 'Accounting receipt', currency: 'CAD', customerPartyId: customer.id, actor: me.email })
  const financeRecord = await saveProjectFinanceRecord(me, { entityId: co.company.id, ledgerId: co.ledger.id, projectId: financeProject, kind: 'revenue', partyId: customer.id, date: '2026-01-01', dueDate: '2026-02-01', description: 'Managed project service', actor: me.email, key: randomUUID(), accountIds: [at('4000')], controlAccountId: at('1200'),
    lines: [{ kind: 'revenue', description: 'Managed project service', base: 100000n, gst: 0n, pst: 0n, gstRecoverable: null, pstRecoverable: null }] })
  const financePayment = await saveProjectFinancePayment(me, { entityId: co.company.id, ledgerId: co.ledger.id, projectId: financeProject, partyId: customer.id, direction: 'received', date: '2026-01-20', amount: 30000n, recordId: financeRecord, bankAccountId: at('1000'), actor: me.email, key: randomUUID() })
  const linked = await renderProjectPaymentReceipt(co.ledger.id, financeProject, financePayment)
  check(linked.receipt?.invoiceNumber === 'RC-FINANCE' && linked.receipt.amountPaid === 30000n && linked.total === 100000n, 'accounting-linked Project payment uses its actual Invoice template and items')
  await refuse(() => renderProjectPaymentReceipt(co.ledger.id, financeProject, projectPayment), 'wrong project payment ID is refused')
  await updateProject({ entityId: co.company.id, projectId, version: 1, name: 'Receipt project', status: 'archived', actor: me.email })
  check((await renderProjectPaymentReceipt(co.ledger.id, projectId, projectPayment)).receipt?.amountPaid === 30000n, 'archived read-only projects retain valid receipts')
  const noncash = await postEntry({ ledgerId: co.ledger.id, entryDate: '2026-01-12', description: 'Noncash settlement', sourceType: 'payment', actor: me.email,
    lines: [{ accountId: at('4000'), amount: 2000n }, { accountId: at('1200'), amount: -2000n, partyId: customer.id }] })
  await applyEntryToInvoice({ invoiceId: invoice.id, entryId: noncash.entry.id, amount: 2000n, actor: me.email })
  check(!await paymentReceiptAvailable(co.ledger.id, noncash.entry.id), 'noncash settlement cannot issue a cash receipt')
  check((await renderPaymentReceipt(co.ledger.id, second.entryId, invoice.id)).payments.every(row => row.amount !== 2000n), 'noncash settlement never appears as money paid in Receipt history')

  const denied = await createUser({ email: 'receipt-denied@example.test', firstName: 'No grants', password, actor: me.email })
  await setGrants({ userId: denied.id, entityIds: [foreign.company.id], modules: ['/entries', '/invoices', '/projects'], actor: me.email })
  const projectOnly = await createUser({ email: 'receipt-project@example.test', firstName: 'Project only', password, actor: me.email })
  await setGrants({ userId: projectOnly.id, entityIds: [co.company.id], modules: ['/projects'], actor: me.email })
  const ownerSession = await signIn({ email: me.email, password }), deniedSession = await signIn({ email: denied.email, password }), projectSession = await signIn({ email: projectOnly.email, password })
  writeFileSync(process.env.RECEIPT_TEST_FIXTURE_PATH ?? proof.fixturePath, JSON.stringify({ token: ownerSession.token, deniedToken: deniedSession.token, projectToken: projectSession.token, ledgerId: co.ledger.id, foreignLedgerId: foreign.ledger.id, invoiceId: invoice.id, entryId: second.entryId, supplierEntryId: paid.entryId, billId: bill.id, projectId, projectPaymentId: projectPayment, financeProjectId: financeProject, financePaymentId: financePayment, advanceEntryId: advance.entry.id, invalidEntryId: invalid.entry.id, invalidProjectPaymentId: cancelled, financeInvoiceId: (await projectFinanceLinks(co.company.id, financeProject))[0].invoice_id }, null, 2), { mode: 0o600 })
  const accountingBefore = await db.execute(q`SELECT id, status, total_debit, total_credit FROM journal_entry ORDER BY id`)
  const samples = { invoice: doc, project: projectDoc, supplier: supplierDoc, advance: advanceDoc }
  mkdirSync('output/pdf', { recursive: true })
  for (const [name, sample] of Object.entries(samples)) {
    const pdf = await invoicePaperPdf(sample), path = `output/pdf/receipt-${name}-sample.pdf`
    writeFileSync(path, pdf.buffer)
    const text = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' })
    check(text.includes('Receipt') && text.includes('Payment history') && text.includes('Amount paid') && !text.includes('PRIVATE'), `${name} real PDF has two-column history and excludes internal notes`)
    check(!text.includes('Payment method') && !text.includes('Date due') && text.includes(name === 'supplier' ? 'Paid to' : 'Bill to'), `${name} real PDF has appropriate receipt metadata and recipient`)
    check(!text.includes('Receipt number') && !text.includes(sample.receipt!.number) && !pdf.filename.includes(sample.receipt!.number), `${name} customer paper and filename omit the internal receipt number`)
  }
  assert.deepEqual(await db.execute(q`SELECT id, status, total_debit, total_credit FROM journal_entry ORDER BY id`), accountingBefore)
  check(true, 'PDF generation does not modify any journal entry')
  const inline = await receiptResponse(new Request('http://local/receipt'), async () => doc)
  const download = await receiptResponse(new Request('http://local/receipt?download=1'), async () => doc)
  check(inline.headers.get('Content-Disposition')?.startsWith('inline;') && download.headers.get('Content-Disposition')?.startsWith('attachment;') && download.headers.get('Cache-Control') === 'no-store', 'view and download return correctly named noncached PDFs')
  const long = { ...doc, payments: Array.from({ length: 90 }, (_, i) => ({ on: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`, what: '', amount: 123456789012345n })) }
  writeFileSync(evidence + '/receipt-long-history.pdf', (await invoicePaperPdf(long)).buffer)
  check(Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [evidence + '/receipt-long-history.pdf'], { encoding: 'utf8' }))?.[1]) > 1, 'long payment histories paginate using the shared Invoice table renderer')
  writeFileSync(evidence + '/service-result.json', JSON.stringify({ checks, passed: true, isolatedDatabase: identity.name, realBusinessTouched: false }, null, 2) + '\n')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => sql.end())
