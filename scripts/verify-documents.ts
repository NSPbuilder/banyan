/**
 * Customer documents: the invoice a customer receives, the statement that
 * chases them.
 *   npm run db:verify-documents   (resets the database first)
 *
 * The claims this suite exists to make earned:
 *
 *   the document shows the books' figures, not a template's
 *   the GST number appears exactly when the registration says it should
 *   a purchase bill is refused by name — it is the supplier's paper
 *   the statement's items are the open items, and its aging line is the
 *     aging report's own, so the letter and the report cannot disagree
 *   both print pages draw from one renderer and run no query of their own
 */
import './env'
import { errorText as chainText, expectSaying, reporter } from './suite'
import { sql as raw } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { db, sql as conn } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty, setAddress } from '../src/lib/parties'
import { registerTax } from '../src/lib/registrations'
import { setOffice } from '../src/lib/records'
import { createInvoice, postInvoice } from '../src/lib/invoices'
import { applyEntryToInvoice, recordPayment } from '../src/lib/payments'
import { postEntry } from '../src/lib/posting'
import { aging } from '../src/lib/aging'
import { customerStatementPdf, invoicePdf } from '../src/lib/pdf-reports'
import { pdfText } from './pdf-text'
import { formatMoney } from '../src/lib/money'
import {
  renderCustomerStatement, renderInvoiceDocument,
} from '../src/lib/customer-docs'

const CHART = `1000,Cash,asset,,cash_and_cash_equivalents
1200,Accounts Receivable,asset,,trade_receivables
2000,Accounts Payable,liability,,trade_payables
2300,GST/HST Payable,liability,,gst_hst_payable
3000,Share Capital,equity,,share_capital
4000,Consulting Revenue,revenue,,revenue_from_contracts
5000,Subcontractors,expense,,other_operating_expenses`

const r = reporter(62)
const { fail, check } = r

const errorText = (e: unknown) => chainText(e, ' <- ')

const expectError = expectSaying(r, errorText, 86)

async function main() {
  const co = await createCompany({ code: 'DOC', name: 'Documents Ltd.' }, 'alicio@example.test')
  await createFiscalYear(co.ledger.id, '2026-12-31', 'alicio@example.test')
  const accounts = await importAccounts(co.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  const at = (code: string) => accounts.find((a) => a.code === code)!

  await setOffice({ entityId: co.company.id, office: 'registered',
    deliveryAddress: '400 Burrard St', deliveryCity: 'Vancouver',
    deliveryPostal: 'V6C 3A6', effectiveFrom: '2026-01-01', actor: 'alicio@example.test' })
  // Registered for GST from March. An invoice issued in February must NOT
  // carry the number; one from March must.
  await registerTax({ entityId: co.company.id, tax: 'GST_HST',
    number: '123456789RT0001', registeredOn: '2026-03-01', actor: 'alicio@example.test' })

  const customer = await createParty({
    kind: 'organisation', name: 'Faithful Client Inc.',
    roles: [{ entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' }],
    actor: 'alicio@example.test',
  })
  await setAddress({ partyId: customer.id, purpose: 'mailing',
    line1: '77 Water St', city: 'Vancouver', region: 'BC', postalCode: 'V6B 1A1' })

  const invoice = async (number: string, on: string, amount: bigint,
                         kind?: 'credit_note', due?: string) => {
    const inv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', kind, partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: on, dueOn: due ?? on, number,
      lines: [{ accountId: at('4000').id,
                amount: kind === 'credit_note' ? amount : -amount,
                description: `Work billed on ${number}` }],
      actor: 'alicio@example.test',
    })
    await postInvoice(inv.id, 'alicio@example.test')
    return inv.id
  }

  // ------------------------------------------------------------ the invoice --
  let invMarch = ''
  {
    invMarch = await invoice('INV-301', '2026-03-10', 250000n)
    await recordPayment({ invoiceId: invMarch, bankAccountId: at('1000').id,
      amount: 100000n, paidOn: '2026-04-01', actor: 'alicio@example.test' })

    const doc = await renderInvoiceDocument(invMarch)
    check(doc.title === 'Invoice' && doc.number === 'INV-301'
          && doc.company.name === 'Documents Ltd.'
          && doc.company.addressLines[0] === '400 Burrard St'
          && doc.billTo.name === 'Faithful Client Inc.'
          && doc.billTo.addressLines[0] === '77 Water St',
      'DC01 the document carries the books\' company, customer and number',
      `${doc.number} from ${doc.company.name} to ${doc.billTo.name}`)

    check(doc.lines.length === 1 && doc.lines[0].amount === 250000n
          && doc.total === 250000n
          && doc.payments.length === 1 && doc.payments[0].amount === 100000n
          && doc.balance === 150000n,
      'DC02 lines read as entered, and the balance is the applications\' answer',
      `total ${doc.total}, paid ${doc.payments[0]?.amount}, due ${doc.balance}`)

    check(doc.company.taxNumbers.some((t) => t.includes('123456789RT0001')),
      'DC03 the GST number is on an invoice issued while registered',
      doc.company.taxNumbers.join('; '))

    // The pair: issued BEFORE the registration, the number is absent — the
    // letterhead is as-at the ISSUE date, not as-at today.
    const invFeb = await invoice('INV-300', '2026-02-10', 50000n, undefined, '2026-03-12')
    const feb = await renderInvoiceDocument(invFeb)
    check(feb.company.taxNumbers.length === 0,
      'DC03b and absent from one issued before the registration began',
      feb.company.taxNumbers.join('; ') || 'no numbers, as it should be')
  }

  // ----------------------------------------------------------- what refuses --
  {
    // A supplier of its own — 0030 rightly refuses a purchase bill naming a
    // party who is only a customer.
    const supplier = await createParty({
      kind: 'organisation', name: 'Paper Supply Co.',
      roles: [{ entityId: co.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
      actor: 'alicio@example.test',
    })
    const bill = await createInvoice({
      ledgerId: co.ledger.id, direction: 'purchase', partyId: supplier.id,
      controlAccountId: at('2000').id, issuedOn: '2026-03-15', dueOn: '2026-04-15',
      theirRef: 'SUP-9', lines: [{ accountId: at('5000').id, amount: 30000n }],
      actor: 'alicio@example.test',
    })
    await postInvoice(bill.id, 'alicio@example.test')
    await expectError('DC04 a purchase bill is refused — it is the supplier\'s paper',
      "the supplier's document", () => renderInvoiceDocument(bill.id))

    const draft = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id,
      controlAccountId: at('1200').id, issuedOn: '2026-03-20', dueOn: '2026-03-20',
      number: 'INV-DRAFT', lines: [{ accountId: at('4000').id, amount: -10000n }],
      actor: 'alicio@example.test',
    })
    await expectError('DC04b and a draft is not yet a document to send',
      'Only a posted document', () => renderInvoiceDocument(draft.id))
  }

  // -------------------------------------------------------- the credit note --
  {
    const cn = await invoice('CN-301', '2026-04-05', 40000n, 'credit_note')
    const [cnEntry] = await db.execute<{ entry_id: string }>(raw`
      SELECT entry_id::text FROM invoice WHERE id = ${cn}::uuid`)
    await applyEntryToInvoice({ invoiceId: invMarch, entryId: cnEntry.entry_id,
      amount: 40000n, actor: 'alicio@example.test' })

    const doc = await renderInvoiceDocument(cn)
    const lineSum = doc.lines.reduce((a, l) => a + l.amount, 0n)
    check(doc.kind === 'credit_note' && doc.title === 'Credit note'
          && doc.total === 40000n && doc.balance === 0n
          && doc.lines[0].amount === 40000n && lineSum === doc.total,
      'DC05 a credit note prints as one, its lines summing to its own total',
      `${doc.title} ${doc.number}: line ${doc.lines[0]?.amount}, total ${doc.total}, left ${doc.balance}`)
    // The paper never calls a credit note an invoice — the applied row on the
    // INVOICE's paper introduces the note by its kind.
    const invDoc = await renderInvoiceDocument(invMarch)
    check(invDoc.payments.some((p) => p.what.startsWith('Credit note CN-301')),
      'DC05b and the invoice\'s applied table introduces it by its kind',
      invDoc.payments.map((p) => p.what).join('; '))
  }

  // ----------------------------------------------------------- the statement --
  {
    // An UNSPENT credit note, so the statement has one to show — and so the
    // mutation that filters credit notes out of the letter has something to
    // lose. Without this, block 186 would have recorded a green run over a
    // fixture that could not see it.
    await invoice('CN-302', '2026-04-10', 20000n, 'credit_note')
    // And money ON ACCOUNT: an unapplied receipt. It belongs to no document,
    // yet the customer has paid it — a statement that leaves it off asks for
    // more than the books say. It is also what makes the aging-line agreement
    // a real test: report and letter only add up alike when both see it.
    await postEntry({
      ledgerId: co.ledger.id, entryDate: '2026-04-20',
      description: 'Payment received on account', sourceType: 'payment', actor: 'alicio@example.test',
      lines: [
        { accountId: at('1000').id, amount: 15000n },
        { accountId: at('1200').id, amount: -15000n, partyId: customer.id },
      ],
    })

    const s = await renderCustomerStatement(co.ledger.id, customer.id, '2026-04-30')
    // Open as at 2026-04-30: INV-301 (250000 - 100000 paid - 40000 note = 110000),
    // INV-300 (50000), CN-302 (-20000 unspent), the receipt (-15000 on account).
    // CN-301 is fully spent and gone.
    const docNumbers = s.items.filter((i) => i.kind !== 'on_account')
      .map((i) => i.number).sort().join(',')
    const onAccount = s.items.filter((i) => i.kind === 'on_account')
    check(docNumbers === 'CN-302,INV-300,INV-301'
          && onAccount.length === 1 && onAccount[0].balance === -15000n
          && s.totalOwed === 125000n,
      'DC06 the statement lists the open documents AND the money on account',
      `${docNumbers} + ${onAccount.length} on account = ${s.totalOwed}`)

    const note = s.items.find((i) => i.number === 'CN-302')
    check(note?.original === -20000n && note?.balance === -20000n,
      'DC06c an unspent credit note appears, and it REDUCES what is owed',
      `${note?.original} -> ${note?.balance}`)

    const item301 = s.items.find((i) => i.number === 'INV-301')
    check(item301?.original === 250000n && item301?.applied === 140000n
          && item301?.balance === 110000n,
      'DC06b with each document\'s original, settled and open figures',
      `${item301?.original} - ${item301?.applied} = ${item301?.balance}`)

    // The aging line is the aging report's, by construction AND by comparison:
    // the same party's row from aging() must be these figures exactly.
    const ar = await aging(co.ledger.id, 'trade_receivables', '2026-04-30')
    const row = ar.rows.find((r) => r.party_id === customer.id)
    check(s.agingLine !== null && row !== undefined
          && s.agingLine.amounts.join(',') === row.buckets.join(',')
          && s.agingLine.amounts.reduce((a, b) => a + b, 0n) === s.totalOwed,
      'DC07 and its aging line IS the aging report\'s row, adding to the total',
      s.agingLine ? s.agingLine.amounts.join(' | ') : 'no line')

    // BACKDATED: as at March 31 the April payments and notes have not
    // happened. The first statement listed documents at their CURRENT
    // balances under a fully as-at aging line — 160,000 of rows beneath a
    // 300,000 line — which this check would have caught had it existed, so
    // now it does. Every figure must be the as-at figure, and the total must
    // still equal the aging row's sum.
    // Partially spend CN-302 (5,000 of 20,000 against INV-300), so the
    // statement renders the row whose Settled arithmetic the magnitude
    // version got wrong: original − settled must land on Open for EVERY row,
    // notes included.
    const [cn302] = await db.execute<{ id: string; entry_id: string }>(raw`
      SELECT id::text, entry_id::text FROM invoice WHERE number = 'CN-302'`)
    await applyEntryToInvoice({ invoiceId: invMarch, entryId: cn302.entry_id,
      amount: 5000n, actor: 'alicio@example.test' })
    const withPartial = await renderCustomerStatement(co.ledger.id, customer.id, '2026-04-30')
    const noteRow = withPartial.items.find((i) => i.number === 'CN-302')
    const badArithmetic = withPartial.items.filter((i) =>
      i.original - i.applied !== i.balance)
    check(noteRow?.original === -20000n && noteRow?.applied === -5000n
          && noteRow?.balance === -15000n && badArithmetic.length === 0,
      'DC06d a partially spent note keeps one arithmetic: original − settled = open',
      `${noteRow?.original} − ${noteRow?.applied} = ${noteRow?.balance}; ${badArithmetic.length} rows break it`)

    const march = await renderCustomerStatement(co.ledger.id, customer.id, '2026-03-31')
    const m301 = march.items.find((i) => i.number === 'INV-301')
    const marchAging = await aging(co.ledger.id, 'trade_receivables', '2026-03-31')
    const marchRow = marchAging.rows.find((r) => r.party_id === customer.id)
    check(m301?.balance === 250000n && m301?.applied === 0n
          && march.totalOwed === 300000n
          && marchRow !== undefined
          && marchRow.buckets.reduce((a, b) => a + b, 0n) === march.totalOwed,
      'DC08b a backdated statement is as-at all the way down, not just its aging line',
      `INV-301 open ${m301?.balance}, total ${march.totalOwed}`)

    // As at an earlier date the later documents are not there.
    const early = await renderCustomerStatement(co.ledger.id, customer.id, '2026-02-28')
    check(early.items.length === 1 && early.items[0].number === 'INV-300'
          && early.items[0].original === 50000n && early.items[0].applied === 0n
          && early.items[0].balance === 50000n
          && early.company.taxNumbers.length === 0,
      'DC08 as at February: one document, real figures, no tax number yet',
      `${early.items.map((i) => `${i.number}:${i.original}/${i.applied}/${i.balance}`).join(',')}`)
  }

  // ------------------------------------------- one renderer, two exits each --
  {
    const checks: string[] = []
    const files = [
      ['src/app/ledger/[ledgerId]/invoices/[invoiceId]/pdf/route.ts', 'invoicePdf('],
      ['src/app/ledger/[ledgerId]/invoices/[invoiceId]/print/InvoiceDocView.tsx', null],
      ['src/app/ledger/[ledgerId]/parties/[partyId]/statement/page.tsx', 'renderCustomerStatement('],
      ['src/app/ledger/[ledgerId]/parties/[partyId]/statement/StatementView.tsx', null],
    ] as const
    for (const [f, mustCall] of files) {
      const src = readFileSync(f, 'utf8')
      if (mustCall && !src.includes(mustCall)) checks.push(`${f} does not draw from the renderer`)
      if (/\bsql`|db\.execute|SELECT /.test(src)) checks.push(`${f} queries on its own`)
    }
    // The print exit is the shared DocHeader since 2026-09-13; when a view
    // renders it, the exit is read where it lives rather than taken on trust.
    for (const f of [files[1][0], files[3][0]]) {
      const src = readFileSync(f, 'utf8')
      const header = src.includes('<DocHeader') ? readFileSync('src/components/DocHeader.tsx', 'utf8') : ''
      if (!src.includes('@media print') && !header.includes('@media print')) checks.push(`${f} has no print exit`)
    }
    check(checks.length === 0,
      'DC09 invoice download and customer statement use shared document renderers',
      checks.join('; ') || 'one path each')
  }

  // ----------------------------------------- the generated PDFs, third exit --
  // The owner replaced print-the-page with generated files (2026-09-02). The
  // PDF functions eat from the SAME renderers; these read the files back
  // (independently — pdf-text decodes the page's own TJ arrays) and hold
  // them to the renderer's figures.
  {
    const doc = await renderInvoiceDocument(invMarch)
    const pdf = pdfText((await invoicePdf(invMarch)).buffer)
    const missing = [
      doc.number ?? '', doc.billTo.name,
      formatMoney(doc.total), formatMoney(doc.balance),
      ...doc.company.taxNumbers,
    ].filter((needle) => needle && !pdf.includes(needle))
    check(missing.length === 0,
      'DC10 the invoice PDF carries the renderer, total to balance to tax number',
      missing.length === 0 ? `${doc.number}: total ${formatMoney(doc.total)}, balance ${formatMoney(doc.balance)}`
        : `missing: ${missing.join(', ')}`)

    const st = await renderCustomerStatement(co.ledger.id, customer.id, '2026-04-30')
    const stPdf = pdfText((await customerStatementPdf(co.ledger.id, customer.id, '2026-04-30')).buffer)
    const stMissing = [
      st.party.name, formatMoney(st.totalOwed),
      ...st.items.map((i) => formatMoney(i.balance)),
    ].filter((needle) => !stPdf.includes(needle))
    check(stMissing.length === 0 && stPdf.includes('Statement of account'),
      'DC11 the customer statement PDF owes what the renderer says, item by item',
      stMissing.length === 0 ? `${st.items.length} items, total ${formatMoney(st.totalOwed)}`
        : `missing: ${stMissing.join(', ')}`)
  }

  // DC12 — a statement holds only its own party's items. The read used to
  //        fetch every open control entry of the ledger and filter in JS;
  //        the filter now lives in the SQL (whole-project audit, 2026-09-13),
  //        so dropping it must show.
  {
    const other = await createParty({ kind: 'organisation', name: 'Bystander Ltd.',
      roles: [{ entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' }], actor: 'alicio@example.test' })
    const inv = await createInvoice({
      ledgerId: co.ledger.id, direction: 'sales', partyId: other.id, controlAccountId: at('1200').id,
      issuedOn: '2026-04-10', dueOn: '2026-05-10', number: 'INV-BYS',
      lines: [{ accountId: at('4000').id, amount: -30000n }], actor: 'alicio@example.test',
    })
    await postInvoice(inv.id, 'alicio@example.test')
    const bys = await renderCustomerStatement(co.ledger.id, other.id, '2026-04-30')
    const again = await renderCustomerStatement(co.ledger.id, customer.id, '2026-04-30')
    check(bys.items.length === 1 && bys.items[0]!.number === 'INV-BYS'
      && again.items.length > 0 && !again.items.some((i) => i.number === 'INV-BYS'),
      "DC12 a statement holds only its own party's items",
      `Bystander's: ${bys.items.map((i) => i.number).join(', ') || 'nothing'}; `
        + `the customer's ${again.items.length} item(s), INV-BYS among them: ${again.items.some((i) => i.number === 'INV-BYS')}`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => {
  fail('the suite threw before it finished', errorText(e).slice(0, 110))
  console.log(`\n=== ${r.failures} CHECK(S) FAILED ===`)
  await conn.end()
  process.exit(1)
})
