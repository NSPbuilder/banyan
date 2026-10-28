import './env'
import { errorText } from './suite'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseBocCatalog, parseBocObservations, fxRateFor } from '../src/lib/fx-rates'
import { acting } from '../src/lib/acting'
import { postForeignBankRowFromForm } from '../src/lib/bank-forms'
import { MATCH_FIELDS as MF } from '../src/lib/forms'
import { sql } from 'drizzle-orm'
import { db, sql as connection } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { setFxCurrency, fxCurrencies, bindFxBankAccount, fxDocumentPosition } from '../src/lib/fx'
import { parseNative, toFunctional, releaseCarrying, roundRatio, formatNative } from '../src/lib/fx-money'
import { postEntry, reverseEntry, saveDraft } from '../src/lib/posting'
import { createInvoice, postInvoice, invoiceDetail, voidInvoice } from '../src/lib/invoices'
import { recordFxPayment, revalueFx, reverseFxEntry, transferFxCash, applyFxCredit } from '../src/lib/fx-accounting'
import { importBankRows, bankRows, matchEntry, reconciliation, saveStatement, finishReconciliation, candidateEntries } from '../src/lib/bank'
import { aging } from '../src/lib/aging'
import { balanceOf, recordPayment, unapply } from '../src/lib/payments'
import { renderInvoiceDocument } from '../src/lib/customer-docs'
import { exportCompany, restoreCompany, readFigtree, packFigtree } from '../src/lib/backup'

const actor = 'fx-verifier@example.test'
let checks = 0
const pass = (label: string) => { checks++; console.log(`PASS  FX${checks} ${label}`) }

async function main() {
  assert.equal(parseNative('1000', 'JPY'), 1000n)
  assert.equal(parseNative('1000.25', 'IDR'), 100025n)
  assert.throws(() => parseNative('1.01', 'JPY'))
  assert.equal(toFunctional(100000n, 'USD', '1.35'), 135000n)
  assert.equal(toFunctional(1000n, 'JPY', '0.008930'), 893n)
  assert.equal(roundRatio(-5n, 2n), -3n)
  assert.equal(formatNative(-1n, 'USD'), '-0.01')
  assert.equal(releaseCarrying(10001n, 1n, 3n), 3334n)
  assert.equal(releaseCarrying(6667n, 2n, 2n), 6667n)
  pass('native precision, signed rounding and exact final residue')

  const company = await createCompany({ code: 'FX', name: 'FX Verification Ltd.' }, actor)
  const ledgerId = company.ledger.id
  await createFiscalYear(ledgerId, '2026-12-31', actor)
  const accounts = await importAccounts(company.company.id, parseAccountsCsv(`1000,CAD cash,asset,,cash_and_cash_equivalents
1010,USD cash,asset,,cash_and_cash_equivalents
1020,JPY cash,asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
2000,Payables,liability,,trade_payables
3000,Capital,equity,,share_capital
4000,Revenue,revenue,,revenue_from_contracts
5000,Expense,expense,,other_operating_expenses
5100,FX gain loss,revenue,,foreign_exchange_gain_loss
5200,Bank fees,expense,,other_operating_expenses`).map(row => ({ ...row, entityId: company.company.id })), actor)
  const account = (code: string) => accounts.find(a => a.code === code)!.id
  const customer = await createParty({ kind: 'organisation', name: 'Foreign Customer',
    roles: [{ entityId: company.company.id, role: 'customer', heldFrom: '2026-01-01' }], actor })
  const supplier = await createParty({ kind: 'organisation', name: 'Foreign Supplier',
    roles: [{ entityId: company.company.id, role: 'supplier', heldFrom: '2026-01-01' }], actor })
  assert(customer.id && supplier.id)
  assert.equal((await fxCurrencies(ledgerId)).find(c => c.code === 'USD')!.enabled, false)
  await setFxCurrency(ledgerId, 'USD', true, actor)
  assert.equal((await fxCurrencies(ledgerId)).find(c => c.code === 'USD')!.enabled, true)
  await setFxCurrency(ledgerId, 'USD', false, actor)
  assert.equal((await fxCurrencies(ledgerId)).find(c => c.code === 'USD')!.enabled, false)
  await setFxCurrency(ledgerId, 'USD', true, actor)
  await assert.rejects(setFxCurrency(ledgerId, 'CAD', false, actor), /always available/)
  await assert.rejects(setFxCurrency(ledgerId, 'ZZZ', true, actor), /provided by BOC/)
  pass('company defaults, enable, stop, re-enable and functional currency protection')
  await bindFxBankAccount(ledgerId, account('1010'), 'USD', actor)
  const [bank] = await db.execute<{ foreign_currency: string }>(sql`SELECT foreign_currency FROM account WHERE id=${account('1010')}::uuid`)
  assert.equal(bank.foreign_currency, 'USD')
  await assert.rejects(bindFxBankAccount(ledgerId, account('4000'), 'USD', actor), /cash\/bank/)
  pass('foreign bank binding verifies company and cash role')

  const quote = { currency: 'USD', rate: '1.350000000000', observedOn: '2026-01-01', source: 'manual' as const, reference: 'Verified bank funding advice' }
  await assert.rejects(postEntry({ ledgerId, entryDate: '2026-01-01', description: 'Missing native amount', actor,
    lines: [{ accountId: account('1010'), amount: 135000n }, { accountId: account('3000'), amount: -135000n }] }), /native amount/)
  const funded = await postEntry({ ledgerId, entryDate: '2026-01-01', description: 'USD funding', actor,
    lines: [{ accountId: account('1010'), amount: 135000n, originalCurrency: 'USD', originalAmount: 100000n, fxSnapshot: quote },
      { accountId: account('3000'), amount: -135000n }] })
  const [native] = await db.execute<{ original_amount: bigint; amount: bigint }>(sql`SELECT original_amount,amount FROM journal_line WHERE entry_id=${funded.entry.id}::uuid AND account_id=${account('1010')}::uuid`)
  assert.equal(native.original_amount, 100000n); assert.equal(native.amount, 135000n)
  await assert.rejects(bindFxBankAccount(ledgerId, account('1010'), 'CAD', actor), error => /currency cannot change/.test(errorText(error)))
  await setFxCurrency(ledgerId, 'USD', false, actor)
  await assert.rejects(postEntry({ ledgerId, entryDate: '2026-01-02', description: 'Stopped funding', actor,
    lines: [{ accountId: account('1010'), amount: 135000n, originalCurrency: 'USD', originalAmount: 100000n, fxSnapshot: quote },
      { accountId: account('3000'), amount: -135000n }] }), /not enabled/)
  await reverseEntry(funded.entry.id, '2026-01-02', 'Funding correction', actor)
  const [position] = await db.execute<{ native: string; base: string }>(sql`SELECT sum(original_amount)::text AS native,sum(amount)::text AS base FROM journal_line WHERE account_id=${account('1010')}::uuid`)
  assert.equal(position.native, '0'); assert.equal(position.base, '0')
  await setFxCurrency(ledgerId, 'USD', true, actor)
  pass('dual-money posting, immutable account currency, stop-new refusal and preserved native reversal')

  const invoice = await createInvoice({ ledgerId, direction: 'sales', currency: 'USD', rate: quote,
    partyId: customer.id, controlAccountId: account('1200'), issuedOn: '2026-03-01', dueOn: '2026-03-31',
    number: 'FX-USD-1', lines: [{ accountId: account('4000'), amount: -100000n }], actor })
  await postInvoice(invoice.id, actor)
  const detail = await invoiceDetail(invoice.id)
  assert.equal(detail!.lines[0].amount, -135000n)
  assert.equal(detail!.lines[0].original_amount, -100000n)
  let debt = await fxDocumentPosition(db, invoice.id)
  assert.equal(debt.native_balance, 100000n); assert.equal(debt.carrying_balance, 135000n)
  const bill = await createInvoice({ ledgerId, direction: 'purchase', currency: 'USD', rate: quote,
    partyId: supplier.id, controlAccountId: account('2000'), issuedOn: '2026-03-01', dueOn: '2026-03-31',
    number: 'FX-BILL-1', lines: [{ accountId: account('5000'), amount: 100000n }], actor })
  await postInvoice(bill.id, actor)
  debt = await fxDocumentPosition(db, bill.id)
  assert.equal(debt.native_balance, -100000n); assert.equal(debt.carrying_balance, -135000n)
  const draft = await createInvoice({ ledgerId, direction: 'sales', currency: 'USD', rate: quote,
    partyId: customer.id, controlAccountId: account('1200'), issuedOn: '2026-03-02', dueOn: '2026-03-31',
    number: 'FX-DRAFT', lines: [{ accountId: account('4000'), amount: -10000n }], actor })
  await setFxCurrency(ledgerId, 'USD', false, actor)
  await assert.rejects(postInvoice(draft.id, actor), /not enabled/)
  assert.equal((await invoiceDetail(draft.id))!.invoice.status, 'draft')
  await setFxCurrency(ledgerId, 'USD', true, actor)
  pass('foreign AR/AP retain original quantity, functional amount and saved draft after stop-new')

  const closing = { ...quote, rate: '1.400000000000', observedOn: '2026-03-31', reference: 'March closing rate evidence' }
  const revaluation = await revalueFx({ ledgerId, date: '2026-03-31', actor, requestKey: 'march-close', rates: { USD: closing } })
  assert(revaluation.entryId)
  debt = await fxDocumentPosition(db, invoice.id)
  assert.equal(debt.native_balance, 100000n); assert.equal(debt.carrying_balance, 140000n)
  assert.equal((await invoiceDetail(invoice.id))!.invoice.fx_snapshot!.rate, quote.rate)
  const replay = await revalueFx({ ledgerId, date: '2026-03-31', actor, requestKey: 'march-close', rates: { USD: closing } })
  assert.equal(replay.entryId, revaluation.entryId); assert.equal(replay.replayed, true)
  const noChange = await revalueFx({ ledgerId, date: '2026-03-31', actor, requestKey: 'march-no-change', rates: { USD: closing } })
  assert.equal(noChange.entryId, null)
  assert.equal((await revalueFx({ ledgerId, date: '2026-03-31', actor, requestKey: 'march-no-change', rates: { USD: closing } })).replayed, true)
  pass('monetary revaluation preserves native quantity and original issue rate; entry and no-op retries are repeat-safe')

  await setFxCurrency(ledgerId, 'USD', false, actor)
  const paid = await recordFxPayment({ ledgerId, invoiceId: invoice.id, bankAccountId: account('1000'), nativeAmount: 40000n,
    bankAmount: 56800n, fee: 200n, feeAccountId: account('5200'), paidOn: '2026-04-15', actor, requestKey: 'usd-partial' })
  debt = await fxDocumentPosition(db, invoice.id)
  assert.equal(debt.native_balance, 60000n); assert.equal(debt.carrying_balance, 84000n)
  const paymentLines = await db.execute<{ code: string; amount: bigint }>(sql`SELECT a.code,j.amount FROM journal_line j JOIN account a ON a.id=j.account_id WHERE j.entry_id=${paid.entryId}::uuid`)
  assert.equal(paymentLines.find(l => l.code === '1000')!.amount, 56600n)
  assert.equal(paymentLines.find(l => l.code === '1200')!.amount, -56000n)
  assert.equal(paymentLines.find(l => l.code === '5100')!.amount, -800n)
  assert.equal(paymentLines.find(l => l.code === '5200')!.amount, 200n)
  assert.equal((await recordFxPayment({ ledgerId, invoiceId: invoice.id, bankAccountId: account('1000'), nativeAmount: 40000n,
    bankAmount: 56800n, fee: 200n, feeAccountId: account('5200'), paidOn: '2026-04-15', actor, requestKey: 'usd-partial' })).entryId, paid.entryId)
  await recordFxPayment({ ledgerId, invoiceId: invoice.id, bankAccountId: account('1000'), nativeAmount: 60000n,
    bankAmount: 85200n, paidOn: '2026-04-20', actor, requestKey: 'usd-final' })
  debt = await fxDocumentPosition(db, invoice.id)
  assert.equal(debt.native_balance, 0n); assert.equal(debt.carrying_balance, 0n)
  await assert.rejects(reverseFxEntry({ ledgerId, entryId: revaluation.entryId!, date: '2026-04-21', reason: 'Unsafe old correction', actor }), /later activity/)
  await setFxCurrency(ledgerId, 'USD', true, actor)
  pass('stopped-currency partial and final settlement use revalued carrying, actual cash and fees without duplicated FX gain')

  await setFxCurrency(ledgerId, 'KRW', true, actor)
  const won = await createInvoice({ ledgerId, direction: 'sales', currency: 'KRW', rate: { ...quote, currency: 'KRW', rate: '0.001', reference: 'KRW test advice' },
    partyId: customer.id, controlAccountId: account('1200'), issuedOn: '2026-05-01', dueOn: '2026-05-31',
    number: 'FX-KRW', lines: [{ accountId: account('4000'), amount: -1000n }], actor })
  await postInvoice(won.id, actor)
  await recordFxPayment({ ledgerId, invoiceId: won.id, bankAccountId: account('1000'), nativeAmount: 999n,
    bankAmount: 100n, paidOn: '2026-05-02', actor, requestKey: 'won-partial' })
  debt = await fxDocumentPosition(db, won.id)
  assert.equal(debt.native_balance, 1n); assert.equal(debt.carrying_balance, 0n)
  await recordFxPayment({ ledgerId, invoiceId: won.id, bankAccountId: account('1000'), nativeAmount: 1n,
    bankAmount: 0n, paidOn: '2026-05-03', actor, requestKey: 'won-rounding' })
  debt = await fxDocumentPosition(db, won.id)
  assert.equal(debt.native_balance, 0n); assert.equal(debt.carrying_balance, 0n)
  pass('zero-decimal native rounding residue can settle without inventing a functional cent')

  const funding = await transferFxCash({ ledgerId, fromAccountId: account('1000'), toAccountId: account('1010'),
    fromAmount: 140000n, toAmount: 100000n, date: '2026-04-01', actor, requestKey: 'bank-funding', reference: 'CAD 1400 bought USD 1000' })
  const cashClose = await revalueFx({ ledgerId, date: '2026-04-30', actor, requestKey: 'april-cash-close',
    rates: { USD: { ...closing, rate: '1.42', observedOn: '2026-04-30' } } })
  assert(cashClose.entryId)
  const beforeBankPay = (await db.execute<{ native: string; base: string }>(sql`SELECT sum(original_amount)::text AS native,sum(amount)::text AS base
    FROM journal_line WHERE account_id=${account('1010')}::uuid`))[0]
  assert.equal(beforeBankPay.native, '100000'); assert.equal(beforeBankPay.base, '142000')
  const bankPayment = await recordFxPayment({ ledgerId, invoiceId: bill.id, bankAccountId: account('1010'), nativeAmount: 100000n,
    paidOn: '2026-04-30', actor, requestKey: 'usd-bank-ap' })
  debt = await fxDocumentPosition(db, bill.id)
  assert.equal(debt.native_balance, 0n); assert.equal(debt.carrying_balance, 0n)
  await importBankRows({ accountId: account('1010'), rows: [{ date: '2026-04-01', amount: 100000n, description: 'USD funding' },
    { date: '2026-04-30', amount: -100000n, description: 'Foreign bill paid' }], actor })
  const rows = await bankRows(account('1010'))
  await matchEntry({ bankTransactionId: rows.find(r => r.amount > 0n)!.id, entryId: funding.entryId, actor })
  await matchEntry({ bankTransactionId: rows.find(r => r.amount < 0n)!.id, entryId: bankPayment.entryId, actor })
  const rec = await reconciliation(account('1010'), '2026-04-30')
  assert.equal(rec.books, 0n); assert.equal(rec.difference, 0n); assert.equal(rec.booksUnclaimed, 0n)
  const statement = await saveStatement({ accountId: account('1010'), statementDate: '2026-04-30', endingBalance: 0n, actor })
  await finishReconciliation(statement.id, actor)
  pass('foreign cash carries actual conversion cost; cash/AP revaluation and native matching reconcile without matching valuation-only lines')

  await transferFxCash({ ledgerId, fromAccountId: account('1000'), toAccountId: account('1010'), fromAmount: 14000n, toAmount: 10000n,
    date: '2026-05-05', actor, requestKey: 'expense-funding', reference: 'USD expense funding' })
  await importBankRows({ accountId: account('1010'), rows: [{ date: '2026-05-10', amount: -1000n, description: 'USD expense' }], actor })
  const expenseRow = (await bankRows(account('1010'))).find(r => r.txn_date === '2026-05-10')!
  assert(!(await candidateEntries(expenseRow.id)).some(e => e.entry_id === cashClose.entryId))
  const expenseForm=new FormData()
  for(const [name,value] of [[MF.ledgerId,ledgerId],[MF.accountId,account('1010')],[MF.rowId,expenseRow.id],[MF.contraAccountId,account('5000')],['fxRate','1.45'],['fxRateDate','2026-05-10'],['fxRateEvidence','Expense conversion evidence']])expenseForm.set(name,value)
  const expenseResult=await postForeignBankRowFromForm(expenseForm,actor)
  assert(expenseResult?.ok,!expenseResult?.error ? 'No foreign form result' : expenseResult.error)
  const [expenseMatch]=await db.execute<{entryId:string}>(sql`SELECT entry_id::text AS "entryId" FROM bank_match WHERE bank_transaction_id=${expenseRow.id}::uuid`)
  const expense=expenseMatch
  const expenseLines = await db.execute<{ code: string; amount: bigint; original_amount: bigint | null }>(sql`SELECT a.code,j.amount,j.original_amount
    FROM journal_line j JOIN account a ON a.id=j.account_id WHERE j.entry_id=${expense.entryId}::uuid`)
  assert.equal(expenseLines.find(l => l.code === '1010')!.amount, -1400n)
  assert.equal(expenseLines.find(l => l.code === '5000')!.amount, 1450n)
  assert.equal(expenseLines.find(l => l.code === '5100')!.amount, -50n)
  pass('posting a native bank expense releases cash carrying cost and recognizes the exchange difference')

  const target = await createInvoice({ ledgerId, direction: 'sales', currency: 'USD', rate: quote,
    partyId: customer.id, controlAccountId: account('1200'), issuedOn: '2026-06-01', dueOn: '2026-06-30',
    number: 'FX-CREDIT-TARGET', lines: [{ accountId: account('4000'), amount: -20000n }], actor })
  const credit = await createInvoice({ ledgerId, direction: 'sales', kind: 'credit_note', currency: 'USD', rate: closing,
    partyId: customer.id, controlAccountId: account('1200'), issuedOn: '2026-06-02', dueOn: '2026-06-30',
    number: 'FX-CREDIT', lines: [{ accountId: account('4000'), amount: 5000n }], actor })
  await postInvoice(target.id, actor); await postInvoice(credit.id, actor)
  await applyFxCredit({ ledgerId, invoiceId: target.id, creditId: credit.id, nativeAmount: 5000n, date: '2026-06-03', actor, requestKey: 'credit-application' })
  assert.equal((await fxDocumentPosition(db, target.id)).native_balance, 15000n)
  assert.equal((await fxDocumentPosition(db, target.id)).carrying_balance, 20250n)
  assert.equal((await fxDocumentPosition(db, credit.id)).native_balance, 0n)
  const refund = await createInvoice({ ledgerId, direction: 'sales', kind: 'credit_note', currency: 'USD', rate: closing,
    partyId: customer.id, controlAccountId: account('1200'), issuedOn: '2026-06-04', dueOn: '2026-06-30',
    number: 'FX-REFUND', lines: [{ accountId: account('4000'), amount: 3000n }], actor })
  await postInvoice(refund.id, actor)
  const refunded = await recordFxPayment({ ledgerId, invoiceId: refund.id, bankAccountId: account('1000'), nativeAmount: 3000n, bankAmount: 4500n,
    paidOn: '2026-06-05', actor, requestKey: 'credit-refund' })
  assert.equal((await fxDocumentPosition(db, refund.id)).native_balance, 0n)
  const [application] = await db.execute<{ id: string }>(sql`SELECT id::text FROM invoice_application WHERE entry_id=${refunded.entryId}::uuid`)
  await assert.rejects(unapply(application.id, actor), /whole/)
  await assert.rejects(recordPayment({ invoiceId: target.id, bankAccountId: account('1000'), amount: 15000n, paidOn: '2026-06-06', actor }), /FX workspace/)
  const item = await balanceOf(target.id)
  assert.equal(item.native_balance, 15000n); assert.equal(item.balance, 20250n); assert.equal(item.currency, 'USD')
  const aged = await aging(ledgerId, 'trade_receivables', '2026-06-30')
  assert.equal(aged.totals.reduce((sum, value) => sum + value, 0n), 20250n); assert.equal(aged.controlBalance, 20250n)
  const paper = await renderInvoiceDocument(target.id)
  assert.equal(paper.currency, 'USD'); assert.equal(paper.total, 20000n); assert.equal(paper.balance, 15000n)
  pass('credit applications and refunds release independent carrying values; native paper and functional aging agree with the ledger')

  const portable=readFigtree(await packFigtree(await exportCompany(company.company.id)))
  assert(portable.fxCurrencies?.some(c=>c.code==='USD'&&c.minor_digits===2))
  const restored=await restoreCompany(portable,actor,{code:'FX-COPY',name:'FX Restored Test'})
  const [copied]=await db.execute<{id:string}>(sql`SELECT id::text FROM invoice WHERE ledger_id=${restored.ledgerId}::uuid AND number='FX-CREDIT-TARGET'`)
  const copiedPosition=await fxDocumentPosition(db,copied.id)
  assert.equal(copiedPosition.native_balance,15000n);assert.equal(copiedPosition.carrying_balance,20250n)
  const broken=structuredClone(portable)
  const brokenLine=broken.rows.journal_line.find(r=>r.fx_invoice_id===target.id)!
  brokenLine.fx_invoice_id=refund.id
  await assert.rejects(restoreCompany(broken,actor,{code:'FX-BAD',name:'Invalid FX Test'}),e=>/scope|disagree|TRUTH/.test(errorText(e)))
  assert.equal((await db.execute(sql`SELECT 1 FROM entity WHERE code='FX-BAD'`)).length,0)
  const brokenMirror=structuredClone(portable)
  const reversalHeader=brokenMirror.rows.journal_entry.find(r=>r.reverses_id===funded.entry.id)!
  const nativeMirror=brokenMirror.rows.journal_line.find(r=>r.entry_id===reversalHeader.id&&r.original_currency==='USD')!
  nativeMirror.original_amount='-1'
  await assert.rejects(restoreCompany(brokenMirror,actor,{code:'FX-MIRROR',name:'Invalid Native Mirror Test'}),e=>/FX_REVERSAL|exact mirror/.test(errorText(e)))
  assert.equal((await db.execute(sql`SELECT 1 FROM entity WHERE code='FX-MIRROR'`)).length,0)
  const wrongPrecision=structuredClone(portable);wrongPrecision.fxCurrencies![0].minor_digits=3
  await assert.rejects(restoreCompany(wrongPrecision,actor,{code:'FX-PRECISION',name:'Invalid Precision Test'}),/precision/)
  pass('portable FX restore retains remapped native positions and rejects changed precision or document ownership atomically')

  await assert.rejects(reverseEntry((await invoiceDetail(target.id))!.invoice.entry_id!,'2026-06-06','Unsafe ordinary reversal',actor,ledgerId),/later activity/)
  const voided=await createInvoice({ledgerId,direction:'sales',currency:'USD',rate:quote,partyId:customer.id,
    controlAccountId:account('1200'),issuedOn:'2026-07-01',dueOn:'2026-07-30',number:'FX-VOID',lines:[{accountId:account('4000'),amount:-10000n}],actor})
  await postInvoice(voided.id,actor)
  await assert.rejects(voidInvoice(voided.id,{reason:'Backdated void',reversedOn:'2026-06-30',actor}),/cannot precede/)
  await voidInvoice(voided.id,{reason:'Cancelled before settlement',reversedOn:'2026-07-02',actor})
  const afterVoid=await aging(ledgerId,'trade_receivables','2026-07-30')
  assert.equal(afterVoid.rows.flatMap(r=>r.buckets).reduce((n,v)=>n+v,0n),afterVoid.controlBalance)
  assert.equal((await fxDocumentPosition(db,voided.id)).native_balance,0n)
  await assert.rejects(postEntry({ledgerId,entryDate:'2026-07-03',actor,description:'Wrong native cash binding',lines:[
    {accountId:account('1000'),amount:135n,originalCurrency:'USD',originalAmount:100n,fxSnapshot:quote},
    {accountId:account('3000'),amount:-135n}]}),e=>/FX_BANK_NATIVE/.test(errorText(e)))
  pass('generic reversal and document void preserve chronology; voided aging nets to zero and unbound cash refuses foreign metadata')

  {
  const catalog=parseBocCatalog(JSON.parse(readFileSync('scripts/fixtures/fx-valet-catalog.json','utf8')))
  assert.equal(catalog.length,27);assert.equal(catalog.find(c=>c.currency==='IDR')!.digits,2)
  assert(catalog.some(c=>c.currency==='RUB'&&c.historical));assert(catalog.some(c=>c.currency==='VND'&&c.digits===0))
  const observations=JSON.parse(readFileSync('scripts/fixtures/fx-valet-observations.json','utf8'))
  const quotes=parseBocObservations(observations,new Set(catalog.map(c=>c.series)),'2026-10-15','2026-10-22')
  assert(quotes.some(q=>q.currency==='USD'&&q.rate==='1.402100000000'))
  assert.throws(()=>parseBocCatalog({groupDetail:{name:'OTHER',groupSeries:{}}}))
  assert.throws(()=>parseBocObservations({observations:[{d:'2026-10-22',FXUSDCAD:{v:'0'}}]},new Set(['FXUSDCAD']),'2026-10-15','2026-10-22'))
  assert.throws(()=>parseBocObservations(observations,new Set(['FXFAKECAD']),'2026-10-15','2026-10-22'))
  assert.throws(()=>parseBocObservations(observations,new Set(catalog.map(c=>c.series)),'2026-10-20','2026-10-22'))
  await assert.rejects(fxRateFor('EUR','2026-01-01'),/No EUR\/CAD quote/)
  await assert.rejects(fxRateFor('JPY','2026-01-01',db,quote),/must name this currency/)
  pass('captured official Valet metadata and rates, historical currencies, ISO precision, invalid responses and missing-quote refusal')

  await setFxCurrency(ledgerId,'USD',true,actor)
  const concurrent=await createInvoice({ledgerId,direction:'sales',currency:'USD',rate:quote,partyId:customer.id,
    controlAccountId:account('1200'),issuedOn:'2026-09-01',dueOn:'2026-09-30',number:'FX-CONCURRENT',lines:[{accountId:account('4000'),amount:-1000n}],actor})
  await postInvoice(concurrent.id,actor)
  const payment={ledgerId,invoiceId:concurrent.id,bankAccountId:account('1000'),nativeAmount:500n,bankAmount:700n,paidOn:'2026-09-02',actor,requestKey:'concurrent-same-key'}
  const duplicate=await Promise.all([recordFxPayment(payment),recordFxPayment(payment)])
  assert.equal(duplicate[0].entryId,duplicate[1].entryId);assert.equal((await fxDocumentPosition(db,concurrent.id)).native_balance,500n)
  const competing=await Promise.allSettled([recordFxPayment({...payment,requestKey:'compete-one'}),recordFxPayment({...payment,requestKey:'compete-two'})])
  assert.equal(competing.filter(p=>p.status==='fulfilled').length,1);assert.equal((await fxDocumentPosition(db,concurrent.id)).native_balance,0n)
  pass('concurrent duplicate settlement is repeat-safe and competing native settlements cannot overpay')

  const draft=await saveDraft({ledgerId,entryDate:'2026-09-20',description:'Raw FX draft transition guard',actor,
    lines:[{accountId:account('1010'),amount:1350n},{accountId:account('3000'),amount:-1350n}]})
  await db.transaction(async tx=>{await acting(tx,actor);await tx.execute(sql`UPDATE journal_line SET original_currency='USD',original_amount=1000,fx_snapshot=${JSON.stringify(quote)}::jsonb WHERE entry_id=${draft.id}::uuid AND line_no=1`)})
  await setFxCurrency(ledgerId,'USD',false,actor)
  await assert.rejects(db.transaction(async tx=>{await acting(tx,actor);await tx.execute(sql`UPDATE journal_entry SET status='posted',entry_no='JE-FX-BYPASS',
    period_id=(SELECT id FROM fiscal_period WHERE ledger_id=${ledgerId}::uuid AND '2026-09-20'::date BETWEEN start_date AND end_date),posted_at=now(),posted_by=${actor},total_debit=1350,total_credit=1350 WHERE id=${draft.id}::uuid`)}),e=>/FX_STOPPED/.test(errorText(e)))
  await setFxCurrency(ledgerId,'USD',true,actor)
  pass('database validation covers later draft-to-posted transitions and refuses stopped-currency raw SQL bypass')

  const raceDocument=await createInvoice({ledgerId,direction:'sales',currency:'USD',rate:quote,partyId:customer.id,
    controlAccountId:account('1200'),issuedOn:'2026-10-01',dueOn:'2026-10-31',number:'FX-VOID-RACE',lines:[{accountId:account('4000'),amount:-100n}],actor})
  await postInvoice(raceDocument.id,actor)
  const race=await Promise.allSettled([
    voidInvoice(raceDocument.id,{reason:'Concurrent cancellation',reversedOn:'2026-10-02',actor}),
    recordFxPayment({ledgerId,invoiceId:raceDocument.id,bankAccountId:account('1000'),nativeAmount:100n,bankAmount:135n,paidOn:'2026-10-02',actor,requestKey:'void-payment-race'})
  ])
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1)
  assert(!race.some(r=>r.status==='rejected'&&/deadlock|40P01/i.test(errorText(r.reason))))
  assert.equal((await fxDocumentPosition(db,raceDocument.id)).native_balance,0n)
  pass('concurrent foreign document void and settlement serialize without invoice/ledger deadlock')
  const residueBanks=await importAccounts(company.company.id,parseAccountsCsv('1030,KRW source,asset,,cash_and_cash_equivalents\n1040,KRW destination,asset,,cash_and_cash_equivalents').map(r=>({...r,entityId:company.company.id})),actor)
  const firstBank=residueBanks.find(a=>a.code==='1030')!.id,secondBank=residueBanks.find(a=>a.code==='1040')!.id
  await setFxCurrency(ledgerId,'KRW',true,actor);await bindFxBankAccount(ledgerId,firstBank,'KRW',actor);await bindFxBankAccount(ledgerId,secondBank,'KRW',actor)
  const tinyQuote={currency:'KRW',rate:'0.003',observedOn:'2026-10-05',source:'manual' as const,reference:'Synthetic sub-cent bank residue'}
  await postEntry({ledgerId,entryDate:'2026-10-05',description:'KRW cost rounding funding',actor,lines:[
    {accountId:firstBank,amount:1n,originalAmount:2n,originalCurrency:'KRW',fxSnapshot:tinyQuote},{accountId:account('3000'),amount:-1n}]})
  await transferFxCash({ledgerId,fromAccountId:firstBank,toAccountId:secondBank,fromAmount:1n,toAmount:1n,date:'2026-10-06',actor,requestKey:'residue-part-one',reference:'First KRW unit'})
  await transferFxCash({ledgerId,fromAccountId:firstBank,toAccountId:secondBank,fromAmount:1n,toAmount:1n,date:'2026-10-07',actor,requestKey:'residue-part-two',reference:'Zero-CAD residue KRW unit'})
  const [nativeCash]=await db.execute<{native:bigint;carrying:bigint}>(sql`SELECT sum(j.original_amount)::bigint AS native,sum(j.amount)::bigint AS carrying FROM journal_line j JOIN journal_entry e ON e.id=j.entry_id WHERE j.account_id=${secondBank}::uuid AND e.status IN ('posted','reversed')`)
  assert.equal(nativeCash.native,2n);assert.equal(nativeCash.carrying,1n)
  pass('same-currency bank transfers preserve native residues with zero CAD carrying value')
  await assert.rejects(postEntry({ledgerId,entryDate:'2026-10-06',description:'Unsafe retrospective KRW cost',actor,lines:[
    {accountId:firstBank,amount:1n,originalAmount:2n,originalCurrency:'KRW',fxSnapshot:tinyQuote},{accountId:account('3000'),amount:-1n}]}),/Later foreign-currency activity/)
  pass('ordinary native posting cannot backdate new funding across later carrying releases')
  }
  console.log(`=== ALL CHECKS PASSED (${checks} FX checks) ===`)
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => connection.end())
