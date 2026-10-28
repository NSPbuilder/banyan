import './env'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import { sql as query } from 'drizzle-orm'
import { db, sql } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty } from '../src/lib/parties'
import { postEntry, saveDraft } from '../src/lib/posting'
import { postQuickEntry } from '../src/lib/quick'
import { createInvoice, postInvoice } from '../src/lib/invoices'
import { accountLedger, generalLedger } from '../src/lib/reports'
import { accountLedgerCsv } from '../src/lib/exports'
import { csvMoney } from '../src/lib/csv'
import { rowsXlsx } from '../src/lib/excel'

const actor = 'history-party@example.test'
let checks = 0
const check = (value: unknown, label: string) => { assert(value, label); checks++; console.log(`PASS  ${label}`) }
const CHART = `1000,Cash,asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
2000,Payables,liability,,trade_payables
3000,Capital,equity,,share_capital
4000,Revenue,revenue,,revenue_from_contracts
5000,Fees,expense,,professional_fees fn_administrative_expenses`

async function main() {
  const [{ name }] = await db.execute<{ name: string }>(query`SELECT current_database() AS name`)
  assert(name.startsWith('figtree_') && name.endsWith('_test') && name === new URL(process.env.TEST_DATABASE_URL!).pathname.slice(1) && name !== new URL(process.env.APP_DATABASE_URL!).pathname.slice(1) && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.TEST_DATABASE_URL!).hostname), 'Use a fresh isolated account-history test database')
  const company = await createCompanyWithYear({ code: 'HP', name: 'History Party Test' }, actor)
  const ledgerId = company.ledger.id, year = new Date().getUTCFullYear(), from = `${year}-01-01`, to = `${year}-12-31`
  const accounts = await importAccounts(company.company.id, parseAccountsCsv(CHART).map(a => ({ ...a, entityId: company.company.id })), actor)
  const id = Object.fromEntries(accounts.map(a => [a.code, a.id]))
  const party = (name: string, role: 'customer' | 'supplier') => createParty({ kind: 'organisation', name, actor, roles: [{ entityId: company.company.id, role, heldFrom: from }] })
  const customer = await party('Client, "North"', 'customer'), supplier = await party('Supplier West', 'supplier')
  const numeric = await party('1000.00', 'customer'), formula = await party('=1+1', 'customer')
  const post = (description: string, lines: Parameters<typeof postEntry>[0]['lines']) => postEntry({ ledgerId, entryDate: `${year}-01-10`, description, actor, lines })
  const single = await post('Single customer', [{ accountId: id['1000'], amount: 10000n }, { accountId: id['1200'], amount: -10000n, partyId: customer.id }])
  const missing = await post('No party', [{ accountId: id['1000'], amount: -1000n }, { accountId: id['5000'], amount: 1000n }])
  const mixed = await post('Mixed parties', [
    { accountId: id['1000'], amount: -7000n },
    { accountId: id['5000'], amount: 4000n, partyId: supplier.id },
    { accountId: id['5000'], amount: 3000n, partyId: customer.id },
  ])
  const repeated = await post('Repeated same party', [
    { accountId: id['1000'], amount: -2000n },
    { accountId: id['5000'], amount: 1000n, partyId: supplier.id },
    { accountId: id['5000'], amount: 1000n, partyId: supplier.id },
  ])
  const num = await post('Numeric party name', [{ accountId: id['1000'], amount: 4000n }, { accountId: id['4000'], amount: -4000n, partyId: numeric.id }])
  await post('Formula party name', [{ accountId: id['1000'], amount: 2000n }, { accountId: id['4000'], amount: -2000n, partyId: formula.id }])
  await postQuickEntry({ ledgerId, kind: 'expense', entryDate: `${year}-01-11`, description: 'Quick supplier', actor, bankAccountId: id['1000'], partyId: supplier.id, items: [{ accountId: id['5000'], amount: 1500n }] })
  const sales = await createInvoice({ ledgerId, direction: 'sales', partyId: customer.id, controlAccountId: id['1200'], issuedOn: `${year}-01-12`, dueOn: `${year}-02-12`, number: 'HP-001', actor, lines: [{ accountId: id['4000'], amount: -5000n }] })
  await postInvoice(sales.id, actor)
  const purchase = await createInvoice({ ledgerId, direction: 'purchase', partyId: supplier.id, controlAccountId: id['2000'], issuedOn: `${year}-01-13`, dueOn: `${year}-02-13`, theirRef: 'BILL-001', actor, lines: [{ accountId: id['5000'], amount: 2500n }] })
  await postInvoice(purchase.id, actor)
  await saveDraft({ ledgerId, entryDate: `${year}-01-14`, description: 'Draft party', actor, lines: [{ accountId: id['1000'], amount: 100n, partyId: customer.id }] })
  const cash = await accountLedger(id['1000'], ledgerId), fees = await accountLedger(id['5000'], ledgerId), revenue = await accountLedger(id['4000'], ledgerId)
  check(cash.find(l => l.entry_id === single.entry.id)?.party_id === customer.id, 'Untagged cash line inherits the entry sole party')
  check(cash.find(l => l.entry_id === missing.entry.id)?.party_name === null, 'Entry without party stays unassigned')
  check(cash.find(l => l.entry_id === mixed.entry.id)?.party_id === null, 'Mixed-party untagged line is never arbitrarily assigned')
  check(fees.filter(l => l.entry_id === mixed.entry.id).map(l => l.party_id).join(',') === `${supplier.id},${customer.id}`, 'Explicit line parties win even on a mixed-party entry')
  check(cash.filter(l => l.entry_id === repeated.entry.id).length === 1 && cash.find(l => l.entry_id === repeated.entry.id)?.party_id === supplier.id, 'Repeated same-party lines remain one cash row with one party')
  check(fees.find(l => l.description === 'Quick supplier')?.party_id === supplier.id && cash.find(l => l.description === 'Quick supplier')?.party_id === supplier.id, 'Quick expense item and bank histories show supplier')
  check(revenue.find(l => l.description === 'Invoice HP-001')?.party_id === customer.id, 'Invoice revenue history shows customer from control line')
  check(fees.find(l => l.description === 'Bill BILL-001')?.party_id === supplier.id, 'Bill expense history shows supplier from control line')
  check(!cash.some(l => l.description === 'Draft party'), 'Drafts still excluded')
  const rawRows = await db.execute<{ entry_id: string; party_id: string | null; amount: string }>(query`
    SELECT jl.entry_id::text, jl.party_id::text, jl.amount::text FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
     WHERE je.ledger_id = ${ledgerId}::uuid AND jl.account_id = ${id['1000']}::uuid AND je.status IN ('posted','reversed')
     ORDER BY je.entry_date, je.entry_no, jl.line_no`)
  let running = 0n
  check(cash.length === rawRows.length && cash.every((l, i) => { running += BigInt(rawRows[i].amount); return l.entry_id === rawRows[i].entry_id && l.running === running.toString() }), 'Party joins preserve row count, amounts, order and running balance')
  check(rawRows.find(l => l.entry_id === single.entry.id)?.party_id === null, 'Display fallback does not rewrite journal party data')
  const ranged = await accountLedger(id['1000'], ledgerId, { from: `${year}-01-11`, to: `${year}-01-11` })
  check(ranged.length === 1 && ranged[0].party_id === supplier.id && ranged[0].running === cash.find(l => l.description === 'Quick supplier')?.running, 'Date filtering preserves party and earlier running balance')
  const other = await createCompanyWithYear({ code: 'HP-B', name: 'History Party Other' }, actor)
  check((await accountLedger(id['1000'], other.ledger.id)).length === 0, 'Another ledger cannot read account rows or parties')
  const exported = await accountLedgerCsv(ledgerId, id['1000'])
  check(exported.rows[2].join(',') === 'Date,Entry,Period,Description,Party,Against,Debit,Credit,Balance', 'CSV and workbook row source include Party column')
  check(exported.rows.slice(3).every((r, i) => r[4] === (cash[i].party_name ?? '') && r[6] === (cash[i].debit === '0' ? '' : csvMoney(cash[i].debit)) && r[7] === (cash[i].credit === '0' ? '' : csvMoney(cash[i].credit)) && r[8] === csvMoney(cash[i].running)), 'Export party and financial columns match history')
  check(exported.csv.includes('"Client, ""North"""') && exported.csv.includes('"\t=1+1"'), 'CSV quotes party names and neutralizes formula-looking names')
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(await rowsXlsx('account', exported.rows) as unknown as ArrayBuffer)
  const ws = wb.worksheets[0]
  check(ws.getCell(3, 5).value === 'Party' && ws.getCell(4, 5).value === customer.name && typeof ws.getCell(4, 7).value === 'number' && ws.getCell(4, 9).value === 100, 'XLSX keeps party text alongside numeric financial columns')
  const numberOnly = await accountLedgerCsv(ledgerId, id['1000'], { from: `${year}-01-10`, to: `${year}-01-10` })
  const only = { rows: [numberOnly.rows[0], [], numberOnly.rows[2], numberOnly.rows.slice(3).find(r => r[1] === num.entry.entryNo)!] }
  const wbNumber = new ExcelJS.Workbook(); await wbNumber.xlsx.load(await rowsXlsx('account', only.rows) as unknown as ArrayBuffer)
  check(wbNumber.worksheets[0].getCell(4, 5).value === '1000.00', 'Numeric-looking party name remains text in a single-row workbook')
  const periods = await db.execute<{ id: string }>(query`SELECT id::text FROM fiscal_period WHERE ledger_id = ${ledgerId}::uuid ORDER BY start_date`)
  const gl = await generalLedger(ledgerId, { fromDate: from, toDate: to, fromPeriodId: periods[0].id, toPeriodId: periods.at(-1)!.id })
  check(JSON.stringify(gl.find(a => a.account.id === id['1000'])?.rows) === JSON.stringify(cash), 'General ledger and account history share party and financial data')
  console.log(JSON.stringify({ checks, failures: 0, isolatedDatabase: true }))
  console.log('=== ALL CHECKS PASSED ===')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => sql.end())
