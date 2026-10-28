/** Copied by verify-assembly into the assembled application and run there. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { sql as raw } from 'drizzle-orm'
import { db, sql as connection } from '../src/db/client'
import { createCompany, createFiscalYear, createCompanyReady } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { postEntry } from '../src/lib/posting'
import { createParty } from '../src/lib/parties'
import { createInvoice, postInvoice } from '../src/lib/invoices'
import { balanceOf, recordPayment } from '../src/lib/payments'
import { bankRows, importBankRows, matchEntry } from '../src/lib/bank'
import { trialBalance } from '../src/lib/balances'
import { exportCompany, packFigtree, readFigtree, restoreCompany } from '../src/lib/backup'
import { createFirstOwner, signIn } from '../src/lib/users'
import { assertModuleCompatibility, assertDeploymentModules } from '../src/lib/module-compatibility'
import { excludedModules } from '../src/assembly/excluded'
import { selectedAddons } from '../src/assembly/selection'
import { MODULE_PATHS } from '../src/lib/nav'
import { toolList } from '../src/lib/inquiry-tools'
import { REPORTS } from '../src/lib/report-catalogue'

async function main() {
  const name = new URL(process.env.TEST_DATABASE_URL ?? '').pathname.slice(1)
  assert.match(name, /^[a-z][a-z0-9_]*_test$/)
  assert.equal(process.env.TEST_DATABASE_CONFIRMATION, name)
  assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL)
  assert.equal((await db.execute<{ name: string }>(raw`SELECT current_database() AS name`))[0].name, name)
  assert.equal(selectedAddons.length, 0)
  await assertDeploymentModules()
  const actor = 'assembly@example.test', password = 'synthetic assembly password only'
  const owner = await createFirstOwner({ email: actor, firstName: 'Assembly', password })
  const co = await createCompany({ code: 'ASSEMBLY', name: 'Base Assembly Test' }, actor)
  await createFiscalYear(co.ledger.id, '2026-12-31', actor)
  await createCompanyReady({ code: 'READY', name: 'Base Onboarding Test' }, actor)
  const accounts = await importAccounts(co.company.id, parseAccountsCsv(`1000,Cash,asset,,cash_and_cash_equivalents
1200,Accounts Receivable,asset,,trade_receivables
3000,Share Capital,equity,,share_capital
4000,Consulting Revenue,revenue,,revenue_from_contracts`).map(row => ({ ...row, entityId: co.company.id })), actor)
  const at = (code: string) => accounts.find(account => account.code === code)!.id
  const lines = [{ accountId: at('1000'), amount: 100000n }, { accountId: at('3000'), amount: -100000n }]
  const entry = await postEntry({ ledgerId: co.ledger.id, entryDate: '2026-03-01', description: 'Capital', actor, lines })
  assert.match(entry.entry.entryNo!, /^JE/)
  await assert.rejects(postEntry({ ledgerId: co.ledger.id, entryDate: '2026-03-01', description: 'Unavailable source', sourceType: 'payroll', actor, lines }), { code: 'SOURCE_UNAVAILABLE' })
  const customer = await createParty({ kind: 'organisation', name: 'Assembly Customer', roles: [{ entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' }], actor })
  const invoice = await createInvoice({ ledgerId: co.ledger.id, direction: 'sales', partyId: customer.id, controlAccountId: at('1200'), issuedOn: '2026-03-02', dueOn: '2026-03-30', number: 'ASM-1', lines: [{ accountId: at('4000'), amount: -25000n }], actor })
  await postInvoice(invoice.id, actor)
  const paid = await recordPayment({ invoiceId: invoice.id, bankAccountId: at('1000'), amount: 25000n, paidOn: '2026-03-03', actor })
  assert.equal((await balanceOf(invoice.id)).balance, 0n)
  await importBankRows({ accountId: at('1000'), rows: [{ date: '2026-03-03', amount: 25000n, description: 'Assembly receipt' }], actor })
  const [bank] = await bankRows(at('1000'))
  await matchEntry({ bankTransactionId: bank.id, entryId: paid.entryId, actor })
  assert.equal((await bankRows(at('1000')))[0].state, 'matched')
  const [period] = await db.execute<{ id: string }>(raw`SELECT id::text FROM fiscal_period WHERE ledger_id=${co.ledger.id}::uuid AND start_date='2026-03-01'`)
  const balance = await trialBalance(co.ledger.id, period.id)
  assert.ok(balance.length >= 4)
  assert.equal(balance.reduce((sum, row) => sum + BigInt(row.debit) - BigInt(row.credit), 0n), 0n)
  const [initialized] = await db.execute<{ crm: number; ops: number }>(raw`SELECT (SELECT count(*)::int FROM crm_pipeline) AS crm, (SELECT count(*)::int FROM operations_finance_setting) AS ops`)
  assert.deepEqual({ ...initialized }, { crm: 0, ops: 0 })
  for (const path of ['/payroll', '/records', '/crm', '/documents', '/projects', '/assets', '/inventory', '/sred']) assert.ok(!MODULE_PATHS.includes(path))
  assert.ok(!('pd7a' in REPORTS) && !('t4' in REPORTS))
  const tools = await toolList({ ledgerId: co.ledger.id, entityId: co.company.id, entityName: co.company.name, user: owner })
  for (const tool of ['employees', 'pay_runs', 'pay_stubs', 'remittances', 't4', 'register', 'crm_workspace']) assert.ok(!tools.some(item => item.name === tool))
  const document = readFigtree(await packFigtree(await exportCompany(co.company.id)))
  const restored = await restoreCompany(document, actor, { code: 'COPY', name: 'Base Restored Test' })
  assert.equal((await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM journal_entry WHERE ledger_id=${restored.ledgerId}::uuid`))[0].n, 3)
  const count = async () => (await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM entity`))[0].n
  const before = await count()
  await assert.rejects(restoreCompany({ ...document, rows: { ...document.rows, pay_run: [{ id: 'unavailable' }] } }, actor, { code: 'BAD' }), { code: 'MISSING_MODULE' })
  await assert.rejects(restoreCompany({ ...document, files: [{ sha256: '0'.repeat(64), bytes: '', mime: 'application/pdf', size: 0, storageDomain: 'project' }] }, actor, { code: 'BAD2' }), { code: 'MISSING_MODULE' })
  assert.equal(await count(), before)
  await db.execute(raw`INSERT INTO crm_pipeline(entity_id,name,created_by,updated_by) VALUES(${co.company.id}::uuid,'Retained synthetic data',${actor},${actor})`)
  await assert.rejects(assertModuleCompatibility(excludedModules), { code: 'MODULE_DATA_PRESENT' })
  assert.equal((await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM crm_pipeline`))[0].n, 1)
  await db.execute(raw`DELETE FROM crm_pipeline WHERE entity_id=${co.company.id}::uuid`)
  await assertModuleCompatibility(excludedModules)
  const { token } = await signIn({ email: actor, password })
  await writeFile('.assembly-smoke.json', JSON.stringify({ ledgerId: co.ledger.id, token, invoiceId: invoice.id }))
  console.log('PASS  ASR base onboarding, journal, invoice, payment, bank match, balance, backup round trip, absent tools, source refusal and lossless compatibility guards')
}

main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => connection.end())
