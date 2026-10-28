/** Numbered paper must agree with the posted money behind it. */
import './env'
import { sql } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { errorText, reporter } from './suite'
import { pdfText, pdfTextAt } from './pdf-text'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { postQuickEntry } from '../src/lib/quick'
import { createInvoice, postInvoice } from '../src/lib/invoices'
import { recordPayment, balanceOf } from '../src/lib/payments'
import { saveEmployee } from '../src/lib/payroll/employees'
import { runPayroll, payRunDetail } from '../src/lib/payroll/runs'
import { paychequePdf } from '../src/lib/payroll/paycheque'
import {
  chequeActionsForEntries, chequeById, chequeParties, chequeSource, createManualCheque, editCheque, issueCheque, voidCheque,
} from '../src/lib/cheques'
import { chequePdf } from '../src/lib/cheque-pdf'
import { parseMoney } from '../src/lib/money'
import { editEntryCore, postEntry } from '../src/lib/posting'
import { closePeriod } from '../src/lib/periods'
import { partyLedger } from '../src/lib/browse'

const r = reporter(66)
const actor = 'alicio@example.test'
const chart = `1000,Operating Bank,asset,,cash_and_cash_equivalents
1010,Reserve Bank,asset,,cash_and_cash_equivalents
2000,Accounts Payable,liability,,trade_payables
2627,Payroll liabilities,liability,,payroll_liabilities
5000,Office supplies,expense,,other_operating_expenses
5100,Travel supplies,expense,,other_operating_expenses
9060,Salaries and wages,expense,,employee_benefits_expense`

async function main() {
  const co = await createCompanyWithYear({ code: 'CHQ', name: 'Cheque Works Ltd.' }, actor)
  const L = co.ledger.id
  const accounts = await importAccounts(co.company.id,
    parseAccountsCsv(chart).map((x) => ({ ...x, entityId: co.company.id })), actor)
  const id = Object.fromEntries(accounts.map((a) => [a.code, a.id]))

  const manual = await createManualCheque({ ledgerId: L, bankAccountId: id['1000'],
    expenseAccountId: id['5000'], chequeDate: '2026-03-02', payee: 'Office Store',
    payeeAddress: '123 Main Street\nVancouver BC V6B 1A1',
    amount: 2500n, memo: 'Paper', actor, startingNumber: 1040n })
  let c = (await chequeById(L, manual))!
  const [line] = await db.execute<{ amount: bigint }>(sql`
    SELECT jl.amount FROM journal_line jl JOIN account a ON a.id = jl.account_id
     WHERE jl.entry_id = ${c.entry_id}::uuid AND a.account_type = 'expense'`)
  r.check(c.number === '1040' && c.source_kind === 'manual' && BigInt(line.amount) === 2500n,
    'CH1 manual cheque and expense are one posted outflow')
  r.check((await partyLedger(L, 'out', '2026-03-01', '2026-03-31'))
    .some((row) => row.kind === 'Expense' && row.href.kind === 'entry' && row.href.id === c.entry_id),
    'CH1a manual cheque appears in the Expenses list')

  await editCheque({ ledgerId: L, chequeId: manual, actor, number: 1042n,
    chequeDate: '2026-03-03', payee: 'Office Store', amount: 3500n, memo: 'More paper' })
  c = (await chequeById(L, manual))!
  const [afterEdit] = await db.execute<{ amount: bigint; entry_date: string }>(sql`
    SELECT jl.amount, je.entry_date::text FROM journal_line jl
    JOIN journal_entry je ON je.id = jl.entry_id JOIN account a ON a.id = jl.account_id
    WHERE jl.entry_id = ${c.entry_id}::uuid AND a.account_type = 'expense'`)
  r.check(c.number === '1042' && BigInt(c.amount) === 3500n
    && BigInt(afterEdit.amount) === 3500n && afterEdit.entry_date === '2026-03-03',
    'CH2 manual cheque edit also edits its expense')

  const paper = await chequePdf(L, manual)
  r.check(!!paper && paper.buffer.subarray(0, 5).toString() === '%PDF-'
    && pdfText(paper.buffer).includes('Office Store')
    && pdfText(paper.buffer).includes('123 Main Street')
    && pdfText(paper.buffer).includes('35.00'),
  'CH3 printable cheque has the stored payee and amount')
  const marks = pdfTextAt(paper!.buffer)
  const mark = (content: string) => marks.find((x) => x.text.includes(content))
  r.check(/\/MediaBox\s*\[0 0 612 792\]/.test(paper!.buffer.toString('latin1'))
    && !!mark('DATE') && mark('DATE')!.x > 470 && mark('DATE')!.y > 720
    && !!mark('Office Store') && mark('Office Store')!.x < 65 && mark('Office Store')!.y > 650
    && !!mark('**35.00') && mark('**35.00')!.x > 500 && mark('**35.00')!.y > 690
    && marks.filter((x) => x.y >= 540 && x.y <= 585).length === 0
    && marks.filter((x) => x.text.includes('Office Store')).length === 3
    && marks.filter((x) => x.text.includes('Operating Bank')).length === 2,
  'CH3a Letter top cheque matches the reference face and two stubs with a clear MICR band',
  marks.map((x) => `${x.text}@${x.x},${x.y}`).join(' | '))

  const expense = await postQuickEntry({ ledgerId: L, kind: 'expense',
    entryDate: '2026-03-04', description: 'Supplies', accountId: id['5000'],
    bankAccountId: id['1000'], amount: 4000n, actor })
  const expenseSource = await chequeSource(L, { entryId: expense.entry.id })
  r.check(Object.hasOwn(await chequeActionsForEntries(L, [expense.entry.id]), expense.entry.id),
    'CH4a recorded expense appears as a Make cheque action')
  const fromExpense = await issueCheque({ ledgerId: L, entryId: expense.entry.id, actor })
  const expenseCheque = (await chequeById(L, fromExpense))!
  r.check(expenseSource?.amount === '4000' && expenseCheque.number === '1043'
    && await issueCheque({ ledgerId: L, entryId: expense.entry.id, actor }) === fromExpense,
    'CH4 an expense pre-fills one cheque and the number follows the last issued')
  r.check((await chequeActionsForEntries(L, [expense.entry.id]))[expense.entry.id] === fromExpense,
    'CH4b recorded expense action opens its issued cheque')

  const supplier = await createParty({ kind: 'organisation', name: 'Parts Supplier',
    roles: [{ entityId: co.company.id, role: 'supplier', heldFrom: '2026-01-01' }], actor })
  const bill = await createInvoice({ ledgerId: L, direction: 'purchase', partyId: supplier.id,
    controlAccountId: id['2000'], issuedOn: '2026-03-05', dueOn: '2026-03-20',
    theirRef: 'PS-1', lines: [{ accountId: id['5000'], amount: 8500n }], actor })
  await postInvoice(bill.id, actor)
  const payment = await recordPayment({ invoiceId: bill.id, bankAccountId: id['1000'],
    amount: 8500n, paidOn: '2026-03-06', actor })
  const paymentChequeId = await issueCheque({ ledgerId: L, entryId: payment.entryId, actor })
  const paymentCheque = (await chequeById(L, paymentChequeId))!
  r.check(paymentCheque.payee === 'Parts Supplier' && paymentCheque.number === '1044'
    && paymentCheque.source_kind === 'payment' && paymentCheque.party_id === supplier.id,
    'CH5 purchase payment supplies its payee, amount and next number')
  r.check((await chequeActionsForEntries(L, [payment.entryId]))[payment.entryId] === paymentChequeId,
    'CH5a recorded purchase payment action opens its issued cheque')

  await voidCheque({ ledgerId: L, chequeId: paymentChequeId, reason: 'Misprinted', reversalDate: '2026-03-20', actor })
  const reopened = await balanceOf(bill.id)
  r.check((await chequeById(L, paymentChequeId))?.status === 'void'
    && reopened.balance === 8500n && !(await chequePdf(L, paymentChequeId)),
    'CH6 voided payment reopens its bill and cannot print')

  const person = await createParty({ kind: 'person', name: 'Dana Worker',
    roles: [{ entityId: co.company.id, role: 'employee', heldFrom: '2026-01-01' }], actor })
  const employee = await saveEmployee({ ledgerId: L, partyId: person.id,
    frequency: 'semi_monthly', actor })
  const run = await runPayroll({ ledgerId: L, payDate: '2026-03-15',
    periodStart: '2026-03-01', periodEnd: '2026-03-15', bankAccountId: id['1000'],
    lines: [{ employeeId: employee.id, gross: parseMoney('3000.00') }], actor })
  const detail = (await payRunDetail(L, run.runId))!
  const stub = detail.stubs[0]
  const payrollChequeId = await issueCheque({ ledgerId: L, stubId: stub.id, actor })
  const payrollCheque = (await chequeById(L, payrollChequeId))!
  const payStubPdf = await paychequePdf(L, run.runId, employee.id)
  r.check(payrollCheque.amount === stub.net_pay && payrollCheque.number === '1045'
    && payrollCheque.pay_stub_id === stub.id && payrollCheque.party_id === person.id && !!payStubPdf,
    'CH7 payroll cheque matches the existing employee pay stub')

  await voidCheque({ ledgerId: L, chequeId: payrollChequeId, reason: 'Pay run error', reversalDate: '2026-03-20', actor })
  const [payRun] = await db.execute<{ status: string }>(sql`
    SELECT je.status FROM pay_run pr JOIN journal_entry je ON je.id = pr.entry_id
     WHERE pr.id = ${run.runId}::uuid`)
  r.check(payRun.status === 'reversed' && (await chequeById(L, payrollChequeId))?.status === 'void',
    'CH8 voiding a payroll cheque reverses the pay run')

  await voidCheque({ ledgerId: L, chequeId: manual, reason: 'No longer needed', reversalDate: '2026-03-20', actor })
  const manualVoid = (await chequeById(L, manual))!
  r.check(manualVoid.status === 'void' && manualVoid.entry_id === null,
    'CH9 voiding a manual cheque removes the expense but reserves its number')

  const [nextA, nextB] = await Promise.all([1, 2].map((n) => createManualCheque({
    ledgerId: L, bankAccountId: id['1000'], expenseAccountId: id['5000'],
    chequeDate: '2026-03-20', payee: `Store ${n}`, amount: 100n, memo: '', actor,
  })))
  const numbers = await Promise.all([nextA, nextB].map(async (x) => (await chequeById(L, x))!.number))
  r.check(numbers.sort().join(',') === '1046,1047',
    'CH10 concurrent cheques reserve distinct consecutive numbers', numbers.join(', '))

  const other = await createCompanyWithYear({ code: 'CH2', name: 'Other Cheques Ltd.' }, actor)
  r.check((await chequeById(other.ledger.id, nextA)) === null,
    'CH11 a cheque is visible only in its own ledger')

  await db.transaction((tx) => editEntryCore(tx, expense.entry.id, {
    entryDate: '2026-03-04', description: 'Supplies corrected',
    lines: [
      { accountId: id['5000'], amount: 4500n },
      { accountId: id['1000'], amount: -4500n },
    ],
  }, actor, 'quick_expense', 'Corrected expense'))
  r.check((await chequeById(L, fromExpense))?.source_matches === false
    && !(await chequePdf(L, fromExpense)),
  'CH12 correcting the source amount disables a stale cheque PDF')
  await voidCheque({ ledgerId: L, chequeId: fromExpense, reason: 'Original paper is stale',
    reversalDate: '2026-03-21', actor })
  const [correctedExpense] = await db.execute<{ status: string; bank_amount: string }>(sql`
    SELECT je.status, jl.amount::text AS bank_amount FROM journal_entry je
    JOIN journal_line jl ON jl.entry_id = je.id AND jl.account_id = ${id['1000']}::uuid
    WHERE je.id = ${expense.entry.id}::uuid`)
  r.check((await chequeById(L, fromExpense))?.status === 'void'
    && correctedExpense.status === 'posted' && correctedExpense.bank_amount === '-4500',
  'CH12a voiding stale paper keeps the corrected expense in the books')
  const replacement = await issueCheque({ ledgerId: L, entryId: expense.entry.id, actor })
  r.check(replacement !== fromExpense && (await chequeById(L, replacement))?.amount === '4500',
    'CH12b a corrected outflow can receive a replacement after stale paper is voided')

  const laterBill = await createInvoice({ ledgerId: L, direction: 'purchase', partyId: supplier.id,
    controlAccountId: id['2000'], issuedOn: '2026-03-21', dueOn: '2026-04-15',
    theirRef: 'PS-2', lines: [{ accountId: id['5000'], amount: 5500n }], actor })
  await postInvoice(laterBill.id, actor)
  const laterPayment = await recordPayment({ invoiceId: laterBill.id, bankAccountId: id['1000'],
    amount: 5500n, paidOn: '2026-03-22', actor })
  const laterPaymentCheque = await issueCheque({ ledgerId: L, entryId: laterPayment.entryId, actor })

  const [march] = await db.execute<{ id: string }>(sql`
    SELECT id::text FROM fiscal_period
     WHERE ledger_id = ${L}::uuid AND '2026-03-20'::date BETWEEN start_date AND end_date`)
  await closePeriod(L, march.id, { actor })
  await voidCheque({ ledgerId: L, chequeId: nextA, reason: 'Lost paper',
    reversalDate: '2026-04-01', actor })
  const closedVoid = (await chequeById(L, nextA))!
  const [reversal] = await db.execute<{ status: string; reversal_date: string }>(sql`
    SELECT je.status, rev.entry_date::text AS reversal_date
      FROM journal_entry je JOIN journal_entry rev ON rev.id = je.reversed_by_id
     WHERE je.id = ${closedVoid.entry_id}::uuid`)
  r.check(closedVoid.status === 'void' && reversal.status === 'reversed'
    && reversal.reversal_date === '2026-04-01' && !(await chequePdf(L, nextA)),
  'CH13 a closed-period void reverses in an open period and reserves the paper')
  await voidCheque({ ledgerId: L, chequeId: laterPaymentCheque, reason: 'Cheque lost',
    reversalDate: '2026-04-02', actor })
  const laterBalance = await balanceOf(laterBill.id)
  r.check((await chequeById(L, laterPaymentCheque))?.status === 'void'
    && laterBalance.balance === 5500n && !(await chequePdf(L, laterPaymentCheque)),
  'CH14 a closed-period payment void reopens the supplier bill')

  const many = await postEntry({ ledgerId: L, entryDate: '2026-04-05',
    description: 'Ten line purchase', sourceType: 'quick_expense', actor,
    lines: [
      ...Array.from({ length: 10 }, (_, i) => ({ accountId: id['5000'], amount: 100n,
        description: `Expense line ${i + 1} with a description longer than one voucher column can hold` })),
      { accountId: id['1000'], amount: -1000n },
    ],
  })
  const manyCheque = await issueCheque({ ledgerId: L, entryId: many.entry.id, actor })
  const manyPdf = await chequePdf(L, manyCheque)
  r.check(!!manyPdf && pdfText(manyPdf.buffer).includes(`10 lines — see ${many.entry.entryNo}`)
    && pdfText(manyPdf.buffer).includes('10.00'),
    'CH15 a long transaction still prints a voucher pointing to the full entry')

  const chosen = await createParty({ kind: 'organisation', name: 'Cheque Party',
    roles: [{ entityId: co.company.id, role: 'supplier', heldFrom: '2026-01-01' }], actor })
  const foreign = await createParty({ kind: 'organisation', name: 'Other Company Supplier',
    roles: [{ entityId: other.company.id, role: 'supplier', heldFrom: '2026-01-01' }], actor })
  const choices = await chequeParties(L)
  r.check(choices.some((p) => p.id === chosen.id) && !choices.some((p) => p.id === foreign.id),
    'CH16a Party chooser offers this company’s parties only')
  try {
    await createManualCheque({ ledgerId: L, bankAccountId: id['1000'],
      expenseAccountId: id['5000'], chequeDate: '2026-04-06', payee: foreign.name,
      partyId: foreign.id, amount: 100n, memo: '', actor })
    r.fail('CH16b a cheque refuses another company’s Party')
  } catch (e) {
    r.check((e as { code?: string }).code === 'BAD_PARTY',
      'CH16b a cheque refuses another company’s Party', errorText(e).slice(0, 100))
  }
  const linked = await createManualCheque({ ledgerId: L, bankAccountId: id['1000'],
    expenseAccountId: id['5000'], chequeDate: '2026-04-06', payee: 'Cheque Party',
    partyId: chosen.id, amount: 1200n, memo: 'Paper', actor })
  let linkedRow = (await chequeById(L, linked))!
  const [linkedLine] = await db.execute<{ party_id: string | null }>(sql`
    SELECT party_id::text FROM journal_line WHERE entry_id = ${linkedRow.entry_id}::uuid AND amount > 0`)
  r.check(linkedRow.party_id === chosen.id && linkedLine.party_id === chosen.id,
    'CH16 choosing a Party links both the printed cheque and its expense')

  await editCheque({ ledgerId: L, chequeId: linked, actor, number: BigInt(linkedRow.number),
    chequeDate: '2026-04-06', payee: 'Cheque Party — Office', partyId: chosen.id,
    bankAccountId: id['1010'], expenseAccountId: id['5100'], amount: 1200n, memo: 'Paper' })
  linkedRow = (await chequeById(L, linked))!
  const correctedLines = await db.execute<{ account_id: string; amount: bigint }>(sql`
    SELECT account_id::text, amount FROM journal_line WHERE entry_id = ${linkedRow.entry_id}::uuid ORDER BY line_no`)
  r.check(linkedRow.bank_account_id === id['1010'] && linkedRow.expense_account_id === id['5100']
    && linkedRow.number === '1' && correctedLines[0].account_id === id['5100']
    && correctedLines[1].account_id === id['1010'] && linkedRow.source_matches
    && linkedRow.party_id === chosen.id && linkedRow.payee === 'Cheque Party — Office',
    'CH17 account correction assigns the new bank next number and keeps editable print text')

  await editCheque({ ledgerId: L, chequeId: linked, actor, number: 1n,
    chequeDate: '2026-04-06', payee: 'One-time payee', partyId: null,
    bankAccountId: id['1010'], expenseAccountId: id['5100'], amount: 1200n, memo: 'Paper' })
  linkedRow = (await chequeById(L, linked))!
  const [unlinkedLine] = await db.execute<{ party_id: string | null }>(sql`
    SELECT party_id::text FROM journal_line WHERE entry_id = ${linkedRow.entry_id}::uuid AND amount > 0`)
  r.check(linkedRow.party_id === null && linkedRow.payee === 'One-time payee' && unlinkedLine.party_id === null,
    'CH18 a one-time payee works without a Party')

  const sourceExpense = await postQuickEntry({ ledgerId: L, kind: 'expense',
    entryDate: '2026-04-07', description: 'Bank correction', accountId: id['5000'],
    bankAccountId: id['1000'], amount: 2300n, actor })
  const sourced = await issueCheque({ ledgerId: L, entryId: sourceExpense.entry.id, actor })
  const beforeSource = (await chequeById(L, sourced))!
  await editCheque({ ledgerId: L, chequeId: sourced, actor, number: BigInt(beforeSource.number),
    chequeDate: beforeSource.cheque_date, payee: beforeSource.payee,
    bankAccountId: id['1010'], amount: 2300n, memo: beforeSource.memo })
  const afterSource = (await chequeById(L, sourced))!
  const [sourceBank] = await db.execute<{ account_id: string }>(sql`
    SELECT account_id::text FROM journal_line
     WHERE entry_id = ${sourceExpense.entry.id}::uuid AND amount = -2300`)
  r.check(afterSource.bank_account_id === id['1010'] && afterSource.number === '2'
    && sourceBank.account_id === id['1010'] && afterSource.source_matches,
    'CH19 changing a recorded expense bank corrects its source and cheque together')
}

main().catch((e) => { r.fail('CH setup or assertion failed', errorText(e)) }).finally(async () => {
  await conn.end()
  console.log(r.summary())
  process.exit(r.failures === 0 ? 0 : 1)
})
