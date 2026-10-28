/**
 * Quick expense / income: money straight between bank and P&L.
 *   npm run db:verify-quick   (resets the database first)
 *
 * The lib is a SHAPE around postEntry, so the checks are about the shape: the
 * bank line carries amount plus GST, the GST lands on the account whose ROLE
 * matches the direction, and every wrong choice is refused with a sentence.
 * The failure mode worth money is Q5's: GST booked to the wrong side files a
 * wrong GST/HST return while every entry balances perfectly.
 */
import './env'
import { reporter } from './suite'
// The attachment store for this run is a scratch directory, set BEFORE the
// lib is ever called: Q12 files a receipt, and the dev store must never be
// touched by a suite.
import path from 'node:path'
import os from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
process.env.ATTACHMENTS_DIR = mkdtempSync(path.join(os.tmpdir(), 'erp-quick-'))
import { execFileSync } from 'node:child_process'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty, shareholderDirectorChoices } from '../src/lib/parties'
import { postQuickEntry, quickAccountsFor, QuickEntryError } from '../src/lib/quick'
import { partyLedger } from '../src/lib/browse'
import { quickEntryFromForm } from '../src/lib/quick-forms'
import { ATTACH_FIELD, QUICK_FIELDS as F } from '../src/lib/forms'
import { attachmentsOf } from '../src/lib/attachments'
import { computeTax } from '../src/lib/tax-rates'
import { gstHstReturn } from '../src/lib/tax'
import { parseMoney } from '../src/lib/money'

const r = reporter(52)
const { pass, fail } = r
const money = (c: bigint) => (Number(c) / 100).toFixed(2)

const CHART = `1000,Cash — Operating,asset,,cash_and_cash_equivalents
1300,GST/HST Recoverable,asset,,gst_hst_recoverable
1484,Prepaid expenses,asset,,prepaid_expenses
2100,GST/HST Payable,liability,,gst_hst_payable
2150,PST Payable,liability,,qst_pst_payable
2400,Credit Card,liability,,
2500,Shareholder Loan,liability,,due_to_shareholder
1500,Equipment,asset,,
4000,Consulting Revenue,revenue,,revenue_from_contracts
4100,Workshop Revenue,revenue,,
5150,Supplies,expense,,
5000,Professional Fees,expense,,professional_fees fn_administrative_expenses`

async function main() {
  const co = await createCompanyWithYear({ code: 'QCK', name: 'Quick Books Ltd.' }, 'alicio@example.test')
  const L = co.ledger.id
  const accts = await importAccounts(co.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  const yr = Number(co.year.endDate.slice(0, 4))

  /**
   * A post that throws marks its check red instead of killing the suite — a
   * mutated tree often unbalances the entry, postEntry refuses, and a suite
   * that dies mid-run records nothing (the P35 lesson, imported).
   */
  const tryPost = async (label: string, run: () => ReturnType<typeof postQuickEntry>) => {
    try { return await run() } catch (e) {
      fail(label, `it threw instead of posting: ${(e as Error).message.slice(0, 80)}`)
      return null
    }
  }

  /** The lines of one entry, as code -> signed cents. */
  const linesOf = async (entryId: string) => {
    const rows = await db.execute<{ code: string; amount: string }>(raw`
      SELECT a.code, jl.amount::text FROM journal_line jl
        JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${entryId}::uuid ORDER BY jl.line_no`)
    return Object.fromEntries(rows.map((r) => [r.code, BigInt(r.amount)]))
  }

  // Q1 — an expense with GST: the bank moves the whole payment, the P&L line
  //      is the pre-tax amount, and the GST is a DEBIT on the recoverable
  //      account — money the CRA owes back, not an expense.
  const exp = await tryPost('Q1 an expense: bank pays the total, GST is recoverable', () => postQuickEntry({
    ledgerId: L, kind: 'expense', entryDate: `${yr}-03-10`,
    description: 'Office chair', accountId: id['5000'], bankAccountId: id['1000'],
    amount: parseMoney('100.00'), gst: parseMoney('5.00'), actor: 'alicio@example.test',
  }))
  const expLines = exp ? await linesOf(exp.entry.id) : {}
  expLines['1000'] === -parseMoney('105.00')
    && expLines['5000'] === parseMoney('100.00')
    && expLines['1300'] === parseMoney('5.00')
    ? pass('Q1 an expense: bank pays the total, GST is recoverable',
           `bank ${money(expLines['1000'])}, expense ${money(expLines['5000'])}, GST ${money(expLines['1300'])}`)
    : fail('Q1 an expense: bank pays the total, GST is recoverable', JSON.stringify(
        Object.fromEntries(Object.entries(expLines).map(([k, v]) => [k, v.toString()]))))

  // Q1b — PST on an expense is COST, not a claim: it folds into the expense
  //       line, the bank pays it, and NO tax account is touched by it. BC has
  //       no input credit for PST; a "PST recoverable" line would be an asset
  //       that never comes back.
  const expPst = await tryPost('Q1b PST on an expense folds into the cost', () => postQuickEntry({
    ledgerId: L, kind: 'expense', entryDate: `${yr}-03-11`,
    description: 'Office chair with PST', accountId: id['5000'], bankAccountId: id['1000'],
    amount: parseMoney('100.00'), gst: parseMoney('5.00'), pst: parseMoney('7.00'),
    actor: 'alicio@example.test',
  }))
  const expPstLines = expPst ? await linesOf(expPst.entry.id) : {}
  expPstLines['1000'] === -parseMoney('112.00')
    && expPstLines['5000'] === parseMoney('107.00')
    && expPstLines['1300'] === parseMoney('5.00')
    && expPstLines['2150'] === undefined
    && Object.keys(expPstLines).length === 3
    ? pass('Q1b PST on an expense folds into the cost',
           `bank ${money(expPstLines['1000'])}, expense ${money(expPstLines['5000'])} (107 = 100 + 7 PST)`)
    : fail('Q1b PST on an expense folds into the cost', JSON.stringify(
        Object.fromEntries(Object.entries(expPstLines).map(([k, v]) => [k, v.toString()]))))

  // Q2 — income mirrors it: the bank receives the whole deposit, revenue is
  //      the pre-tax amount, and the GST is a CREDIT on the payable account.
  const inc = await tryPost('Q2 income: bank receives the total, GST is payable', () => postQuickEntry({
    ledgerId: L, kind: 'income', entryDate: `${yr}-03-12`,
    description: 'Consulting fee', accountId: id['4000'], bankAccountId: id['1000'],
    amount: parseMoney('200.00'), gst: parseMoney('10.00'), actor: 'alicio@example.test',
  }))
  const incLines = inc ? await linesOf(inc.entry.id) : {}
  incLines['1000'] === parseMoney('210.00')
    && incLines['4000'] === -parseMoney('200.00')
    && incLines['2100'] === -parseMoney('10.00')
    ? pass('Q2 income: bank receives the total, GST is payable',
           `bank ${money(incLines['1000'])}, revenue ${money(-incLines['4000'])}, GST ${money(-incLines['2100'])}`)
    : fail('Q2 income: bank receives the total, GST is payable', JSON.stringify(
        Object.fromEntries(Object.entries(incLines).map(([k, v]) => [k, v.toString()]))))

  // Q2b — PST collected is a debt to the province, on its own payable account.
  const incPst = await tryPost('Q2b PST collected lands on its own payable account', () => postQuickEntry({
    ledgerId: L, kind: 'income', entryDate: `${yr}-03-13`,
    description: 'Retail sale', accountId: id['4000'], bankAccountId: id['1000'],
    amount: parseMoney('200.00'), gst: parseMoney('10.00'), pst: parseMoney('14.00'),
    actor: 'alicio@example.test',
  }))
  const incPstLines = incPst ? await linesOf(incPst.entry.id) : {}
  incPstLines['1000'] === parseMoney('224.00')
    && incPstLines['4000'] === -parseMoney('200.00')
    && incPstLines['2100'] === -parseMoney('10.00')
    && incPstLines['2150'] === -parseMoney('14.00')
    ? pass('Q2b PST collected lands on its own payable account',
           `bank ${money(incPstLines['1000'])}, PST ${money(-incPstLines['2150'])} in 2150`)
    : fail('Q2b PST collected lands on its own payable account', JSON.stringify(
        Object.fromEntries(Object.entries(incPstLines).map(([k, v]) => [k, v.toString()]))))

  // Q2c — the number names the door: EXP for money out, INC for money in.
  exp?.entry.entryNo?.startsWith('EXP-') && inc?.entry.entryNo?.startsWith('INC-')
    ? pass('Q2c the entry number names the door', `${exp?.entry.entryNo} / ${inc?.entry.entryNo}`)
    : fail('Q2c the entry number names the door', `${exp?.entry.entryNo} / ${inc?.entry.entryNo}`)

  // Q3 — no GST, no GST line: two lines, not three with a zero.
  const plain = await tryPost('Q3 no GST means two lines, not a zero third', () => postQuickEntry({
    ledgerId: L, kind: 'expense', entryDate: `${yr}-03-14`,
    description: 'Bank fee', accountId: id['5000'], bankAccountId: id['1000'],
    amount: parseMoney('12.50'), actor: 'alicio@example.test',
  }))
  const plainKeys = plain ? Object.keys(await linesOf(plain.entry.id)) : []
  plainKeys.length === 2
    ? pass('Q3 no GST means two lines, not a zero third', 'bank and expense only')
    : fail('Q3 no GST means two lines, not a zero third', JSON.stringify(plainKeys))

  // Q4 — every wrong choice is refused with its own sentence, not posted.
  const refusals: Array<[string, () => Promise<unknown>, string]> = [
    ['a zero amount', () => postQuickEntry({
      ledgerId: L, kind: 'expense', entryDate: `${yr}-03-15`, description: 'x',
      accountId: id['5000'], bankAccountId: id['1000'], amount: 0n }), 'NOT_POSITIVE'],
    ['negative GST', () => postQuickEntry({
      ledgerId: L, kind: 'expense', entryDate: `${yr}-03-15`, description: 'x',
      accountId: id['5000'], bankAccountId: id['1000'],
      amount: parseMoney('10.00'), gst: -parseMoney('1.00') }), 'NEGATIVE_GST'],
    // An account of no company at all. What replaced "an expense into a
    // revenue account", which is DELIBERATELY allowed since 2026-09-07 —
    // Q4c and Q4d below are that case. The line check still runs, and this
    // is what it still refuses: an account that is not this company's.
    ['an account belonging to nobody', () => postQuickEntry({
      ledgerId: L, kind: 'expense', entryDate: `${yr}-03-15`, description: 'x',
      accountId: '00000000-0000-0000-0000-000000000000', bankAccountId: id['1000'],
      amount: parseMoney('10.00') }), 'WRONG_ACCOUNT'],
    ['a bank that is not a bank', () => postQuickEntry({
      ledgerId: L, kind: 'income', entryDate: `${yr}-03-15`, description: 'x',
      accountId: id['4000'], bankAccountId: id['5000'],
      amount: parseMoney('10.00') }), 'NOT_A_BANK_ACCOUNT'],
    ['an expense account as Paid from', () => postQuickEntry({
      ledgerId: L, kind: 'expense', entryDate: `${yr}-03-15`, description: 'x',
      accountId: id['5150'], bankAccountId: id['5000'],
      amount: parseMoney('10.00') }), 'NOT_A_BANK_ACCOUNT'],
    ['negative PST', () => postQuickEntry({
      ledgerId: L, kind: 'expense', entryDate: `${yr}-03-15`, description: 'x',
      accountId: id['5000'], bankAccountId: id['1000'],
      amount: parseMoney('10.00'), pst: -parseMoney('1.00') }), 'NEGATIVE_GST'],
  ]
  const wrong: string[] = []
  for (const [what, run, code] of refusals) {
    try { await run(); wrong.push(`${what}: POSTED`) }
    catch (e) {
      if (!(e instanceof QuickEntryError) || e.code !== code) {
        wrong.push(`${what}: ${(e as Error).message.slice(0, 40)}`)
      }
    }
  }
  wrong.length === 0
    ? pass('Q4 every wrong choice is refused by name', refusals.map(([w]) => w).join('; '))
    : fail('Q4 every wrong choice is refused by name', wrong.join(' | '))

  // Q4c — THE EXPENSE FORM IS NOT ONLY FOR EXPENSES. A laptop bought on the
  //        company card is an asset; the owner asked for the QuickBooks
  //        shape, where a line may be any account (2026-09-07). The type is
  //        the ORDINARY answer now, not the only one.
  const asset = await tryPost('Q4f a line may be any account, not only the type the form is named after',
    () => postQuickEntry({
      ledgerId: L, kind: 'expense', entryDate: `${yr}-03-16`,
      description: 'Laptop', accountId: id['1500'], bankAccountId: id['2400'],
      amount: parseMoney('900.00'), actor: 'alicio@example.test',
    }))
  const assetLines = asset ? await linesOf(asset.entry.id) : {}
  assetLines['1500'] === parseMoney('900.00') && assetLines['2400'] === -parseMoney('900.00')
    ? pass('Q4f a line may be any account, not only the type the form is named after',
           'an asset line paid from a liability')
    : fail('Q4f a line may be any account, not only the type the form is named after',
           JSON.stringify(Object.fromEntries(
             Object.entries(assetLines).map(([k, v]) => [k, v.toString()]))))

  // Q4d — and a NEGATIVE line, which is how money comes back on the same
  //       receipt: a deposit returned, a rebate, the financed half of a
  //       purchase. The bank line is the net, and the entry still balances
  //       because it is built that way.
  const netted = await tryPost('Q4g a negative line takes money back and the bank line is the net',
    () => postQuickEntry({
      ledgerId: L, kind: 'expense', entryDate: `${yr}-03-17`, description: 'Kit, less the trade-in',
      bankAccountId: id['1000'], actor: 'alicio@example.test',
      items: [
        { accountId: id['5150'], amount: parseMoney('300.00') },
        { accountId: id['5000'], amount: -parseMoney('50.00') },
      ],
    }))
  const nettedLines = netted ? await linesOf(netted.entry.id) : {}
  nettedLines['1000'] === -parseMoney('250.00')
    && nettedLines['5150'] === parseMoney('300.00')
    && nettedLines['5000'] === -parseMoney('50.00')
    ? pass('Q4g a negative line takes money back and the bank line is the net',
           `bank ${money(nettedLines['1000'])} against 300.00 out and 50.00 back`)
    : fail('Q4g a negative line takes money back and the bank line is the net',
           JSON.stringify(Object.fromEntries(
             Object.entries(nettedLines).map(([k, v]) => [k, v.toString()]))))

  // Q4e — The money side includes a credit card or shareholder loan, but an
  //       expense account is still refused: a mistyped row there would make
  //       a balanced entry nobody notices.
  const oncard = await tryPost('Q4h the money may come from a credit card or a loan',
    () => postQuickEntry({
      ledgerId: L, kind: 'expense', entryDate: `${yr}-03-18`,
      description: 'Fuel, on the card', accountId: id['5150'], bankAccountId: id['2500'],
      amount: parseMoney('60.00'), actor: 'alicio@example.test',
    }))
  const cardLines = oncard ? await linesOf(oncard.entry.id) : {}
  cardLines['2500'] === -parseMoney('60.00') && cardLines['5150'] === parseMoney('60.00')
    ? pass('Q4h the money may come from a credit card or a loan',
           'the liability grew by what was spent')
    : fail('Q4h the money may come from a credit card or a loan',
           JSON.stringify(Object.fromEntries(
             Object.entries(cardLines).map(([k, v]) => [k, v.toString()]))))

  // Q4n — Recognizing an expense already paid in an earlier period credits
  // the prepaid-expenses asset. This belongs in Expense Paid from, but an
  // Income deposit must not present or accept that asset as a destination.
  const prepaidOptions = await quickAccountsFor(L, 'expense')
  const incomeOptions = await quickAccountsFor(L, 'income')
  const prepaidEntry = await tryPost('Q4n expense may be paid from a prepaid asset', () => postQuickEntry({
    ledgerId: L, kind: 'expense', entryDate: `${yr}-03-18`,
    description: 'Recognize prepaid insurance', accountId: id['5150'], bankAccountId: id['1484'],
    amount: parseMoney('80.00'), actor: 'alicio@example.test',
  }))
  const prepaidLines = prepaidEntry ? await linesOf(prepaidEntry.entry.id) : {}
  let incomePrepaidRefusal = ''
  try {
    await postQuickEntry({ ledgerId: L, kind: 'income', entryDate: `${yr}-03-18`,
      description: 'Wrong deposit', accountId: id['4000'], bankAccountId: id['1484'],
      amount: parseMoney('1.00') })
  } catch (e) { incomePrepaidRefusal = (e as QuickEntryError).code }
  prepaidOptions.bankAccounts.some((a) => a.id === id['1484'] && a.prepaid_expense)
    && !incomeOptions.bankAccounts.some((a) => a.id === id['1484'])
    && prepaidLines['1484'] === -parseMoney('80.00')
    && prepaidLines['5150'] === parseMoney('80.00')
    && incomePrepaidRefusal === 'NOT_A_BANK_ACCOUNT'
    ? pass('Q4n expense may be paid from a prepaid asset', 'prepaid 80.00 credit, expense 80.00 debit')
    : fail('Q4n expense may be paid from a prepaid asset',
           JSON.stringify({ prepaidOptions: prepaidOptions.bankAccounts.map((a) => a.code),
             incomeOptions: incomeOptions.bankAccounts.map((a) => a.code),
             prepaidLines: Object.fromEntries(Object.entries(prepaidLines).map(([k, v]) => [k, v.toString()])),
             incomePrepaidRefusal }))

  // Q4o — An asset needs no prepaid-expenses role to be a valid Paid from
  // choice. The selector and posting gate both accept an untagged asset,
  // while the Income selector keeps its narrower destination rule.
  const otherAssetEntry = await tryPost('Q4o expense may be paid from any asset', () => postQuickEntry({
    ledgerId: L, kind: 'expense', entryDate: `${yr}-03-18`,
    description: 'Recognize asset-funded cost', accountId: id['5150'], bankAccountId: id['1500'],
    amount: parseMoney('35.00'), actor: 'alicio@example.test',
  }))
  const otherAssetLines = otherAssetEntry ? await linesOf(otherAssetEntry.entry.id) : {}
  prepaidOptions.bankAccounts.some((a) => a.id === id['1500'] && a.account_type === 'asset' && !a.prepaid_expense)
    && !incomeOptions.bankAccounts.some((a) => a.id === id['1500'])
    && otherAssetLines['1500'] === -parseMoney('35.00')
    && otherAssetLines['5150'] === parseMoney('35.00')
    ? pass('Q4o expense may be paid from any asset', 'untagged asset 35.00 credit, expense 35.00 debit')
    : fail('Q4o expense may be paid from any asset',
           JSON.stringify({ expenseOptions: prepaidOptions.bankAccounts.map((a) => a.code),
             incomeOptions: incomeOptions.bankAccounts.map((a) => a.code),
             lines: Object.fromEntries(Object.entries(otherAssetLines).map(([k, v]) => [k, v.toString()])) }))

  // Q4i — WHO THE MONEY WAS WITH. A quick entry could not name anybody at
  //        all until 2026-09-07; the owner asked whether the box had been
  //        taken away, and it had never been there. It goes on the ITEM
  //        lines, because that is what `browse.ts` reads to put a receipt
  //        under its supplier on the Expenses screen — and NOT on the bank
  //        line, which is about the bank, and which would show the same
  //        receipt twice under the same supplier if it carried them too.
  //        (The tax lines are not asked about here: this entry carries no
  //        tax, because `Q5` counts every tagged entry in this ledger and
  //        says in words which ones it is counting.)
  const supplier = await createParty({
    kind: 'organisation', name: 'Coastal Office Supply Co.',
    roles: [{ entityId: co.company.id, role: 'supplier', heldFrom: co.year.startDate }],
    actor: 'alicio@example.test',
  })
  const named = await tryPost('Q4i the party lands on the lines the browse screens read',
    () => postQuickEntry({
      ledgerId: L, kind: 'expense', entryDate: `${yr}-03-19`,
      description: 'Paper', accountId: id['5150'], bankAccountId: id['1000'],
      amount: parseMoney('40.00'),
      partyId: supplier.id, actor: 'alicio@example.test',
    }))
  const whose = named ? await db.execute<{ code: string; party: string | null }>(raw`
    SELECT a.code, jl.party_id::text AS party
      FROM journal_line jl JOIN account a ON a.id = jl.account_id
     WHERE jl.entry_id = ${named.entry.id}::uuid
     ORDER BY a.code`) : []
  const onItems = whose.filter((r) => r.party === supplier.id).map((r) => r.code)
  onItems.join(',') === '5150' && whose.length === 2
    ? pass('Q4i the party lands on the lines the browse screens read',
           'on the expense line, not on the bank line')
    : fail('Q4i the party lands on the lines the browse screens read',
           JSON.stringify(whose))

  // Q4k — the supplier of an expense and the director who advanced the money
  // are two different people on two different lines. The Expenses page groups
  // this receipt under its supplier even though the creditor is line one.
  const director = await createParty({
    kind: 'person', name: 'Pat Director',
    roles: [{ entityId: co.company.id, role: 'director', heldFrom: co.year.startDate }],
    actor: 'alicio@example.test',
  })
  const fundingChoices = await shareholderDirectorChoices(co.company.id, `${yr}-03-19`)
  const loanAccount = (await quickAccountsFor(L, 'expense')).bankAccounts.find((a) => a.id === id['2500'])
  const loanForm = new FormData()
  loanForm.set(F.ledgerId, L); loanForm.set(F.kind, 'expense'); loanForm.set(F.entryDate, `${yr}-03-19`)
  loanForm.set(F.description, 'Paper advanced by director'); loanForm.set(F.bankAccountId, id['2500'])
  loanForm.set(F.partyId, supplier.id); loanForm.set(F.fundingPartyId, director.id)
  loanForm.set('line.0.account', id['5150']); loanForm.set('line.0.amount', '36.00')
  const loanExpense = await quickEntryFromForm(loanForm, 'alicio@example.test')
  const loanLines = loanExpense.entryId ? await db.execute<{ code: string; party: string | null }>(raw`
    SELECT a.code, jl.party_id::text AS party
      FROM journal_line jl JOIN account a ON a.id = jl.account_id
     WHERE jl.entry_id = ${loanExpense.entryId}::uuid ORDER BY jl.line_no`) : []
  const expenseRows = await partyLedger(L, 'out', `${yr}-03-19`, `${yr}-03-19`)
  const loanRow = expenseRows.find((row) => row.href.id === loanExpense.entryId)
  loanAccount?.shareholder_loan === true
    && fundingChoices.some((p) => p.id === director.id)
    && loanLines[0]?.code === '2500' && loanLines[0].party === director.id
    && loanLines[1]?.code === '5150' && loanLines[1].party === supplier.id
    && loanRow?.party_id === supplier.id && loanRow.party_name === supplier.name
    ? pass('Q4k a director funds an expense, but Expenses groups it under the supplier',
           `${loanRow.party_name}; loan line names ${director.name}`)
    : fail('Q4k a director funds an expense, but Expenses groups it under the supplier',
           JSON.stringify({ posted: loanExpense, loanLines, loanRow, fundingChoices }))

  // The same distinction holds when the quick expense bought an asset, which
  // comes through capitalDocuments rather than the P&L query. With no supplier
  // named, it must not quietly become an expense under the director's name.
  const assetLoan = await tryPost('Q4l an asset funded by a director', () => postQuickEntry({
    ledgerId: L, kind: 'expense', entryDate: `${yr}-03-19`, description: 'Equipment advanced',
    bankAccountId: id['2500'], fundingPartyId: director.id,
    accountId: id['1500'], amount: parseMoney('75.00'), actor: 'alicio@example.test',
  }))
  const assetRows = await partyLedger(L, 'out', `${yr}-03-19`, `${yr}-03-19`)
  const assetRow = assetRows.find((row) => row.href.id === assetLoan?.entry.id)
  assetLoan && assetRow?.party_id === null && assetRow.kind === 'Expense'
    ? pass('Q4l a funded asset expense without a supplier stays unassigned', assetRow.description)
    : fail('Q4l a funded asset expense without a supplier stays unassigned', JSON.stringify(assetRow))

  let wrongFundingAccount = ''
  let wrongFundingParty = ''
  try {
    await postQuickEntry({ ledgerId: L, kind: 'expense', entryDate: `${yr}-03-19`,
      description: 'Wrong source', bankAccountId: id['1000'], fundingPartyId: director.id,
      accountId: id['5150'], amount: parseMoney('1.00') })
  } catch (e) { wrongFundingAccount = (e as QuickEntryError).code }
  try {
    await postQuickEntry({ ledgerId: L, kind: 'expense', entryDate: `${yr}-03-19`,
      description: 'Wrong creditor', bankAccountId: id['2500'], fundingPartyId: supplier.id,
      accountId: id['5150'], amount: parseMoney('1.00') })
  } catch (e) { wrongFundingParty = (e as QuickEntryError).code }
  wrongFundingAccount === 'WRONG_FUNDING_ACCOUNT' && wrongFundingParty === 'WRONG_FUNDING_PARTY'
    ? pass('Q4m a creditor requires the due-to account and shareholder/director role')
    : fail('Q4m a creditor requires the due-to account and shareholder/director role',
           `${wrongFundingAccount} / ${wrongFundingParty}`)

  // Q4j — WHAT THE FORM OFFERS AND WHAT THE DOOR ACCEPTS ARE ONE ANSWER.
  //        Two lists is this repository's oldest defect shape, and the money
  //        side has two spellings of "an account money can come out of" —
  //        one in the query the form is built from, one in the re-check the
  //        door does. So: try every account in the chart, and require the
  //        ones that go through to be exactly the ones on offer.
  //
  //        IN A COMPANY OF ITS OWN, because probing means posting: eleven
  //        little entries against every account in the chart, two of which
  //        are the tax accounts `Q5` counts the year's GST in.
  const probeCo = await createCompanyWithYear({ code: 'PRB', name: 'Probe Every Account Ltd.' }, 'alicio@example.test')
  const probeAccts = await importAccounts(probeCo.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: probeCo.company.id })), 'alicio@example.test')
  const probeId = Object.fromEntries(probeAccts.map((a) => [a.code, a.id]))
  const probeYr = Number(probeCo.year.endDate.slice(0, 4))
  const offered = new Set((await quickAccountsFor(probeCo.ledger.id, 'expense')).bankAccounts.map((a) => a.id))
  const disagreed: string[] = []
  for (const [code, acct] of Object.entries(probeId)) {
    let took = true
    try {
      await postQuickEntry({
        ledgerId: probeCo.ledger.id, kind: 'expense', entryDate: `${probeYr}-03-20`,
        description: `probe ${code}`,
        accountId: probeId['5150'], bankAccountId: acct, amount: parseMoney('1.00'),
        actor: 'alicio@example.test',
      })
    } catch { took = false }
    if (took !== offered.has(acct)) {
      disagreed.push(`${code}: door ${took ? 'took' : 'refused'} it, form ${offered.has(acct) ? 'offers' : 'does not offer'} it`)
    }
  }
  disagreed.length === 0
    ? pass('Q4j the accounts the door accepts are exactly the ones the form offers',
           `${Object.keys(probeId).length} accounts tried, ${offered.size} offered`)
    : fail('Q4j the accounts the door accepts are exactly the ones the form offers',
           disagreed.join(' | '))

  // Q4b — GST with nowhere to put it. A company whose chart has no account in
  //       the role gets a refusal naming the role, not a silent two-line post.
  const bare = await createCompanyWithYear({ code: 'BARE', name: 'No Tax Roles Inc.' }, 'alicio@example.test')
  const bareAccts = await importAccounts(bare.company.id, parseAccountsCsv(
    `1000,Cash,asset,,cash_and_cash_equivalents\n4000,Sales,revenue,,revenue_from_contracts\n5000,Fees,expense,,professional_fees`)
    .map((r) => ({ ...r, entityId: bare.company.id })), 'alicio@example.test')
  const bareId = Object.fromEntries(bareAccts.map((a) => [a.code, a.id]))
  try {
    await postQuickEntry({
      ledgerId: bare.ledger.id, kind: 'expense',
      entryDate: `${Number(bare.year.endDate.slice(0, 4))}-03-15`, description: 'x',
      accountId: bareId['5000'], bankAccountId: bareId['1000'],
      amount: parseMoney('10.00'), gst: parseMoney('0.50') })
    fail('Q4b GST with no account in the role is refused', 'it posted')
  } catch (e) {
    (e as QuickEntryError).code === 'NO_GST_ACCOUNT'
      && (e as Error).message.includes('gst_hst_recoverable')
      ? pass('Q4b GST with no account in the role is refused', (e as Error).message.slice(0, 58))
      : fail('Q4b GST with no account in the role is refused', (e as Error).message)
  }
  try {
    await postQuickEntry({
      ledgerId: bare.ledger.id, kind: 'income',
      entryDate: `${Number(bare.year.endDate.slice(0, 4))}-03-16`, description: 'x',
      accountId: bareId['4000'], bankAccountId: bareId['1000'],
      amount: parseMoney('10.00'), pst: parseMoney('0.70') })
    fail('Q4d PST collected with no account in the role is refused', 'it posted')
  } catch (e) {
    (e as QuickEntryError).code === 'NO_PST_ACCOUNT'
      && (e as Error).message.includes('qst_pst_payable')
      ? pass('Q4d PST collected with no account in the role is refused', (e as Error).message.slice(0, 58))
      : fail('Q4d PST collected with no account in the role is refused', (e as Error).message.slice(0, 80))
  }

  const bareOffer = await quickAccountsFor(bare.ledger.id, 'expense')
  bareOffer.gstAccount === null
    ? pass('Q4c and the form is told so before anything is typed', 'gstAccount: null')
    : fail('Q4c and the form is told so before anything is typed', JSON.stringify(bareOffer.gstAccount))

  // Q5 — THE ONE WORTH MONEY. The GST/HST return reads by ROLE: the two
  //      expenses' 5.00 + 5.00 must be ITCs, the incomes' 10.00 + 10.00
  //      collected — and the income-side PST must not drift into collected
  //      (mutation 202 makes it drift). The ITC box is a different guard:
  //      expense PST never touches a tax account at all, and that is Q1b's
  //      fold — this check cannot see a leak that has no path in a green
  //      tree, so it does not claim to.
  const ret = (await gstHstReturn(L, `${yr}-01-01`, `${yr}-12-31`))!
  ret.lines.itcs.amount === parseMoney('10.00')
    && ret.lines.collected.amount === parseMoney('20.00')
    ? pass('Q5 the return sees GST only; income PST stays out of collected',
           `ITCs ${money(ret.lines.itcs.amount)}, collected ${money(ret.lines.collected.amount)}`)
    : fail('Q5 the return sees GST only; income PST stays out of collected',
           JSON.stringify({ itcs: ret.lines.itcs.amount.toString(),
                            collected: ret.lines.collected.amount.toString() }))

  // Q6 — the form reader posts what the screen names. Same field names, same
  //      refusal sentences; the *-forms seam is where a green library and a
  //      broken screen can coexist.
  const f = new FormData()
  f.set(F.ledgerId, L); f.set(F.kind, 'expense'); f.set(F.entryDate, `${yr}-03-16`)
  f.set(F.description, 'Parking'); f.set(F.accountId, id['5000'])
  f.set(F.bankAccountId, id['1000']); f.set(F.amount, '20.00'); f.set(F.gst, '1.00')
  const ok = await quickEntryFromForm(f, 'alicio@example.test')
  const bad = new FormData()
  bad.set(F.ledgerId, L); bad.set(F.kind, 'expense'); bad.set(F.entryDate, `${yr}-03-16`)
  bad.set(F.description, 'Parking'); bad.set(F.accountId, id['5000'])
  bad.set(F.bankAccountId, id['1000']); bad.set(F.amount, 'twenty dollars')
  const refused = await quickEntryFromForm(bad, 'alicio@example.test')
  ok.ok?.includes('Posted as EXP-') && ok.entryId && refused.error?.includes('does not read as')
    ? pass('Q6 the form reader posts by its own name, and refuses in sentences',
           `${ok.ok} / ${refused.error}`)
    : fail('Q6 the form reader posts, and refuses, in sentences', JSON.stringify({ ok, refused }))

  // ---------------------------------------------------------------- tags ----
  // Q7+: the tag IS the tax. One arithmetic (computeTax) serves the preview
  // and the posting; these pin its corners and the reader's use of it.

  // Q7 — exclusive: 100.00 tagged GST+PST → 5 and 7 on top, bank 112.
  const ex = computeTax(parseMoney('100.00'), 'GST_PST', false, '2026-05-01')
  ex.base === parseMoney('100.00') && ex.gst === parseMoney('5.00')
    && ex.pst === parseMoney('7.00') && ex.total === parseMoney('112.00')
    ? pass('Q7 exclusive stacks the taxes on the typed base', '100 + 5 + 7 = 112')
    : fail('Q7 exclusive stacks the taxes on the typed base', JSON.stringify(
        Object.fromEntries(Object.entries(ex).map(([k, v]) => [k, v.toString()]))))

  // Q7b — inclusive: 112.00 tagged GST+PST backs out the same three figures,
  //       and an awkward total still reproduces itself to the cent.
  const incl = computeTax(parseMoney('112.00'), 'GST_PST', true, '2026-05-01')
  const awkward = computeTax(parseMoney('100.01'), 'GST_PST', true, '2026-05-01')
  incl.base === parseMoney('100.00') && incl.gst === parseMoney('5.00') && incl.pst === parseMoney('7.00')
    && awkward.base + awkward.gst + awkward.pst === parseMoney('100.01')
    ? pass('Q7b inclusive backs the base out and always re-adds to the total',
           `112 -> 100/5/7; 100.01 -> ${money(awkward.base)}+${money(awkward.gst)}+${money(awkward.pst)}`)
    : fail('Q7b inclusive backs the base out and always re-adds to the total', JSON.stringify(
        Object.fromEntries(Object.entries(awkward).map(([k, v]) => [k, v.toString()]))))

  // Q7c — the form reader posts from a TAG: inclusive 112 GST+PST expense
  //       lands as bank -112, expense 107 (PST folded), GST 5.
  const tf = new FormData()
  tf.set(F.ledgerId, L); tf.set(F.kind, 'expense'); tf.set(F.entryDate, `${yr}-03-18`)
  tf.set(F.description, 'Tagged supplies'); tf.set(F.accountId, id['5000'])
  tf.set(F.bankAccountId, id['1000']); tf.set(F.amount, '112.00')
  tf.set(F.taxCode, 'GST_PST'); tf.set(F.amounts, 'inclusive')
  const tagOk = await quickEntryFromForm(tf, 'alicio@example.test')
  const tagLines = tagOk.entryId ? await linesOf(tagOk.entryId) : {}
  tagOk.ok !== undefined
    && tagLines['1000'] === -parseMoney('112.00')
    && tagLines['5000'] === parseMoney('107.00')
    && tagLines['1300'] === parseMoney('5.00')
    ? pass('Q7c a tagged inclusive amount posts the derived figures',
           `bank ${money(tagLines['1000'])}, expense ${money(tagLines['5000'])}, GST ${money(tagLines['1300'])}`)
    : fail('Q7c a tagged inclusive amount posts the derived figures',
           JSON.stringify({ ok: tagOk.ok ?? tagOk.error,
             lines: Object.fromEntries(Object.entries(tagLines).map(([k, v]) => [k, v.toString()])) }))

  // Q7d — out of scope computes nothing, and a nonsense tag is refused.
  const oos = computeTax(parseMoney('50.00'), 'OUT_OF_SCOPE', true, '2026-05-01')
  const badTag = new FormData()
  badTag.set(F.ledgerId, L); badTag.set(F.kind, 'expense'); badTag.set(F.entryDate, `${yr}-03-18`)
  badTag.set(F.description, 'x'); badTag.set(F.accountId, id['5000'])
  badTag.set(F.bankAccountId, id['1000']); badTag.set(F.amount, '10.00')
  badTag.set(F.taxCode, 'HST_MAYBE')
  const refusedTag = await quickEntryFromForm(badTag, 'alicio@example.test')
  oos.base === parseMoney('50.00') && oos.gst === 0n && oos.pst === 0n
    && refusedTag.error?.includes('not a tax tag') === true
    ? pass('Q7d out of scope means nothing computed; nonsense is refused',
           refusedTag.error ?? '')
    : fail('Q7d out of scope means nothing computed; nonsense is refused',
           JSON.stringify({ oos: oos.base.toString(), err: refusedTag.error }))

  // Q8 — a receipt with several items is ONE entry (owner, 2026-09-02): each
  //      item its own P&L line with its own wording, GST summed to one line,
  //      PST paid folded into ITS item's cost, the bank carrying the lot.
  const multi = await tryPost('Q8 several items, one entry, the bank pays the lot', () => postQuickEntry({
    ledgerId: L, kind: 'expense', entryDate: `${yr}-03-21`,
    description: 'Store run', bankAccountId: id['1000'],
    items: [
      { accountId: id['5000'], description: 'Chair', amount: parseMoney('100.00'), gst: parseMoney('5.00') },
      { accountId: id['5150'], description: 'Paper', amount: parseMoney('40.00'), gst: parseMoney('2.00'), pst: parseMoney('2.80') },
    ],
    actor: 'alicio@example.test',
  }))
  if (multi) {
    const lines = await linesOf(multi.entry.id)
    const words = await db.execute<{ code: string; description: string | null }>(raw`
      SELECT a.code, jl.description FROM journal_line jl
        JOIN account a ON a.id = jl.account_id
       WHERE jl.entry_id = ${multi.entry.id}::uuid ORDER BY jl.line_no`)
    const byCode = Object.fromEntries(words.map((w) => [w.code, w.description]))
    // BOTH items carry GST and the raw row count is pinned: `linesOf` keys by
    // code, so two 1300 lines would collapse to one and a per-item-GST
    // regression would slip through a keyed comparison (critic, 2026-09-02).
    words.length === 4
      && lines['1000'] === -parseMoney('149.80')
      && lines['5000'] === parseMoney('100.00')
      && lines['5150'] === parseMoney('42.80')
      && lines['1300'] === parseMoney('7.00')
      && byCode['5000'] === 'Chair' && byCode['5150'] === 'Paper'
      ? pass('Q8 several items, one entry, the bank pays the lot',
             '4 rows; bank 149.80; GST 5 + 2 summed on ONE line; PST folded into Paper')
      : fail('Q8 several items, one entry, the bank pays the lot',
             JSON.stringify({ rows: words.length, lines: Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, v.toString()])), byCode }))
  }

  // Q8b — income: several revenue lines, PST collected is a summed debt line.
  const multiIn = await tryPost('Q8b income items: PST collected is one payable line', () => postQuickEntry({
    ledgerId: L, kind: 'income', entryDate: `${yr}-03-22`,
    description: 'Workshop day', bankAccountId: id['1000'],
    items: [
      { accountId: id['4000'], amount: parseMoney('200.00'), gst: parseMoney('10.00'), pst: parseMoney('14.00') },
      { accountId: id['4100'], amount: parseMoney('50.00') },
    ],
    actor: 'alicio@example.test',
  }))
  if (multiIn) {
    const lines = await linesOf(multiIn.entry.id)
    Object.keys(lines).length === 5
      && lines['1000'] === parseMoney('274.00')
      && lines['4000'] === -parseMoney('200.00')
      && lines['4100'] === -parseMoney('50.00')
      && lines['2100'] === -parseMoney('10.00')
      && lines['2150'] === -parseMoney('14.00')
      ? pass('Q8b income items: PST collected is one payable line', 'bank 274.00 in, taxes owed on their own lines')
      : fail('Q8b income items: PST collected is one payable line',
             JSON.stringify(Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, v.toString()]))))
  }

  // Q9 — the FORM path: line.{i}.* rows, the invoice form's own field names
  //      and index reader. Two rows with different tags, one blank extra row
  //      (an unused "+ Add a line" is not an error), amounts exclusive.
  const mf = new FormData()
  mf.set(F.ledgerId, L); mf.set(F.kind, 'expense'); mf.set(F.entryDate, `${yr}-03-23`)
  mf.set(F.description, 'Two-tag receipt'); mf.set(F.bankAccountId, id['1000'])
  mf.set(F.amounts, 'exclusive')
  mf.set('line.0.account', id['5000']); mf.set('line.0.description', 'Taxed thing')
  mf.set('line.0.amount', '100.00'); mf.set('line.0.taxCode', 'GST_PST')
  mf.set('line.1.account', id['5150']); mf.set('line.1.description', '')
  mf.set('line.1.amount', '30.00'); mf.set('line.1.taxCode', 'OUT_OF_SCOPE')
  mf.set('line.7.account', ''); mf.set('line.7.amount', '')
  const formMulti = await quickEntryFromForm(mf, 'alicio@example.test')
  if (!formMulti.entryId) {
    fail('Q9 the form posts rows through the one reader', formMulti.error ?? 'no entry')
  } else {
    const lines = await linesOf(formMulti.entryId)
    // GST_PST on 100.00 exclusive: GST 5.00, PST 7.00 folded into the item.
    Object.keys(lines).length === 4
      && lines['1000'] === -parseMoney('142.00')
      && lines['5000'] === parseMoney('107.00')
      && lines['5150'] === parseMoney('30.00')
      && lines['1300'] === parseMoney('5.00')
      ? pass('Q9 the form posts rows through the one reader',
             'bank 142.00 = (100 + 7 PST) + 5 GST + 30; the blank row cost nothing')
      : fail('Q9 the form posts rows through the one reader',
             JSON.stringify(Object.fromEntries(Object.entries(lines).map(([k, v]) => [k, v.toString()]))))
  }

  // Q9b — a row with money but no account is refused in a sentence, and
  //       nothing posts.
  const half = new FormData()
  half.set(F.ledgerId, L); half.set(F.kind, 'expense'); half.set(F.entryDate, `${yr}-03-23`)
  half.set(F.description, 'Half a row'); half.set(F.bankAccountId, id['1000'])
  half.set('line.0.account', id['5000']); half.set('line.0.amount', '10.00')
  half.set('line.1.account', ''); half.set('line.1.amount', '5.00')
  const refusedHalf = await quickEntryFromForm(half, 'alicio@example.test')
  refusedHalf.error?.includes('no account') === true
    ? pass('Q9b a half-filled row is refused by name', refusedHalf.error ?? '')
    : fail('Q9b a half-filled row is refused by name', JSON.stringify(refusedHalf))

  // Q9c — words with no figures are a row somebody MEANT. Dropping it
  //       silently loses the item; the refusal names what is missing.
  const wordy = new FormData()
  wordy.set(F.ledgerId, L); wordy.set(F.kind, 'expense'); wordy.set(F.entryDate, `${yr}-03-23`)
  wordy.set(F.description, 'Wordy row'); wordy.set(F.bankAccountId, id['1000'])
  wordy.set('line.0.account', id['5000']); wordy.set('line.0.amount', '10.00')
  wordy.set('line.1.account', ''); wordy.set('line.1.amount', '')
  wordy.set('line.1.description', 'The forgotten thing')
  const refusedWordy = await quickEntryFromForm(wordy, 'alicio@example.test')
  refusedWordy.error?.includes('no account') === true
    ? pass('Q9c a described row with no figures is refused, not dropped', refusedWordy.error ?? '')
    : fail('Q9c a described row with no figures is refused, not dropped', JSON.stringify(refusedWordy))

  // Q10 — the description is NOT required (owner, 2026-09-07: "expense和income
  //       的description不是必须的"). The journal still needs something to call
  //       the entry, so what it falls back to is stated: the first line that
  //       carried its own wording, then the plainest true sentence there is.
  {
    const post = async (typed: string, wording: string, kind = 'expense') => {
      const f = new FormData()
      f.set(F.ledgerId, L); f.set(F.kind, kind); f.set(F.entryDate, `${yr}-03-24`)
      f.set(F.description, typed); f.set(F.bankAccountId, id['1000'])
      f.set('line.0.account', id[kind === 'expense' ? '5000' : '4000']); f.set('line.0.amount', '11.00')
      if (wording) f.set('line.0.description', wording)
      const r = await quickEntryFromForm(f, 'alicio@example.test')
      if (!r.entryId) return `refused: ${r.error}`
      const [e] = await db.execute<{ description: string }>(raw`
        SELECT description FROM journal_entry WHERE id = ${r.entryId}::uuid`)
      return e.description
    }
    const typed = await post('Coffee for the office', 'beans')
    const fromLine = await post('', 'Printer paper')
    const bare = await post('', '')
    const bareIncome = await post('', '', 'income')
    typed === 'Coffee for the office' && fromLine === 'Printer paper'
      && bare === 'Expense' && bareIncome === 'Income'
      ? pass('Q10 the description is optional and says what it falls back to',
             `typed → "${typed}"; blank → "${fromLine}"; blank with nothing → "${bare}" / "${bareIncome}"`)
      : fail('Q10 the description is optional and says what it falls back to',
             `${typed} / ${fromLine} / ${bare} / ${bareIncome}`)
  }

  // Q11 — the screen, rendered. What this proves and what it does not:
  //
  //       PROVEN. The description input carries no `required`, so the browser
  //       will not block a blank one; the screen renders at all outside a
  //       server runtime, which is the door-as-a-prop rule and the reason
  //       this check can exist; and the party box is on it, offered rather
  //       than required — the one box on this form a person may leave alone.
  //
  //       It used to also require a sentence saying what a blank description
  //       becomes. `Q10` proves what it actually becomes, from the door; the
  //       sentence was the screen explaining itself, and the owner asked for
  //       less of that (2026-09-07).
  //
  //       NOT PROVEN. That a narrow window scrolls instead of squeezing. The
  //       width and the scroller are read back as class names that this same
  //       component sets, so the check can only say the classes are on the
  //       right elements — it cannot lay anything out, and no browser runs
  //       here (RISKS §16). Block 465 removes the class and this goes red;
  //       that a person with a 900px window is helped by it is something only
  //       the page pass saw (critic, 2026-09-07).
  {
    const accounts = (codes: string[]) => codes.map((c) => ({ id: id[c], code: c, name: `Account ${c}` }))
    const render = (kind: 'expense' | 'income') => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-quick-form.tsx', JSON.stringify({
        kind, plAccounts: accounts(kind === 'expense' ? ['5000', '5150'] : ['4000']),
        bankAccounts: accounts(['1000']),
        gstAccount: { id: id['1300'], code: '1300', name: 'GST recoverable' }, pstAccount: null,
      }),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const html = render('expense')
    // The line row and its headings on ONE grid template, and no field
    // carrying `w-full` beside its own width: two width utilities of equal
    // specificity let the stylesheet's order decide, and `w-full` won, so the
    // amount and tax boxes took the whole row while the account and the
    // description collapsed (owner's screenshot, 2026-09-07).
    const rowTag = html.match(/<div[^>]*data-line-row[^>]*>/)?.[0] ?? ''
    const gridded = /grid-cols-\[[^\]]+\]/.test(rowTag)
    // Tokenised, and scoped to the row's own fields. A regex over the whole
    // document matched inside `max-w-4xl` and only saw `w-full` written
    // FIRST — `class="w-28 … w-full"` is the same defect and slipped past
    // (critic, 2026-09-07). A width token is one that sizes the element: not
    // `max-w-*`, not `min-w-*`.
    const widths = (tag: string) => (tag.match(/class="([^"]*)"/)?.[1] ?? '')
      .split(/\s+/).filter((c) => /^w-/.test(c))
    const rowBlock = html.slice(html.indexOf('data-line-row'), html.indexOf('+ Add a line'))
    const fieldTags = rowBlock.match(/<(input|select)[^>]*>/g) ?? []
    const conflicted = fieldTags.some((t) => widths(t).length > 1)
    const descTag = html.match(/<input[^>]*id="q-desc"[^>]*>/)?.[0] ?? ''
    const formTag = html.match(/<form[^>]*>/)?.[0] ?? ''
    const localLines = /class="table-scroll"[^>]*data-table-scroll/.test(html)
      && /min-w-\[\d+rem\] space-y-2/.test(html)
    descTag && !descTag.includes('required')
      && !/min-w-\[\d+rem\]/.test(formTag) && html.includes('form-grid quick-header') && localLines
      && gridded && fieldTags.length >= 4 && !conflicted
      && html.includes('aria-label="GST on line 1"') && html.includes('aria-label="PST on line 1"')
      && render('income').includes('aria-label="Customer"')
      ? pass('Q11 the screen: no required description, one grid template for the rows, no width told twice',
             `${descTag.includes('required') ? 'still required' : 'optional'}; responsive header, local line scroller ${localLines}; `
             + `grid ${gridded}; ${fieldTags.length} field(s) in the row; a width told twice: ${conflicted}`)
      : fail('Q11 the screen: no required description, one grid template for the rows, no width told twice',
             `${descTag.slice(0, 80)} | ${formTag.slice(0, 80)}`)
  }

  // Q12 — the receipt goes WITH the entry, not on a second visit to a second
  //       screen (owner, 2026-09-07). Filed after the posting, renamed for
  //       the entry's date and amount, and a store that refuses does not turn
  //       a posted entry into a reported failure.
  {
    const f = new FormData()
    f.set(F.ledgerId, L); f.set(F.kind, 'expense'); f.set(F.entryDate, `${yr}-03-25`)
    f.set(F.description, 'With its receipt'); f.set(F.bankAccountId, id['1000'])
    f.set('line.0.account', id['5000']); f.set('line.0.amount', '60.00')
    f.set(ATTACH_FIELD, new File([Buffer.from('%PDF-1.4 a receipt')], 'IMG_9001.pdf', { type: 'application/pdf' }))
    const posted = await quickEntryFromForm(f, 'alicio@example.test')
    const filed = posted.entryId ? await attachmentsOf(posted.entryId) : []

    // And when the store refuses, the entry still reports as posted.
    // A FILE where the store should be, so the write genuinely cannot happen:
    // a directory that merely does not exist is created on the way.
    const store = process.env.ATTACHMENTS_DIR
    const blocked = path.join(store!, 'not-a-directory')
    writeFileSync(blocked, 'a file where the store should be')
    process.env.ATTACHMENTS_DIR = blocked
    const g2 = new FormData()
    g2.set(F.ledgerId, L); g2.set(F.kind, 'expense'); g2.set(F.entryDate, `${yr}-03-26`)
    g2.set(F.description, 'Store refuses'); g2.set(F.bankAccountId, id['1000'])
    g2.set('line.0.account', id['5000']); g2.set('line.0.amount', '10.00')
    g2.set(ATTACH_FIELD, new File([Buffer.from('%PDF-1.4 x')], 'x.pdf', { type: 'application/pdf' }))
    const refusedStore = await quickEntryFromForm(g2, 'alicio@example.test')
    process.env.ATTACHMENTS_DIR = store

    // A form with no file is unchanged.
    const g3 = new FormData()
    g3.set(F.ledgerId, L); g3.set(F.kind, 'expense'); g3.set(F.entryDate, `${yr}-03-27`)
    g3.set(F.description, 'No paper'); g3.set(F.bankAccountId, id['1000'])
    g3.set('line.0.account', id['5000']); g3.set('line.0.amount', '5.00')
    const bare = await quickEntryFromForm(g3, 'alicio@example.test')

    filed.length === 1 && filed[0].filename === `${yr}-03-25 60.00.pdf`
      && (posted.ok ?? '').includes('filed against it')
      && !!refusedStore.ok && refusedStore.ok.startsWith('Posted as') && !refusedStore.error
      && refusedStore.ok.includes('could not be filed')
      && !!bare.ok && !bare.ok.includes('filed')
      ? pass('Q12 a receipt posted with the entry is filed against it and renamed; a store that refuses does not unpost it',
             `${filed[0].filename}; store refused → ${refusedStore.ok?.slice(0, 40)}; no file → ${bare.ok}`)
      : fail('Q12 a receipt posted with the entry is filed against it and renamed; a store that refuses does not unpost it',
             `${filed.map((a) => a.filename).join(',') || 'nothing filed'}; ${refusedStore.ok ?? refusedStore.error}; ${bare.ok}`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })
