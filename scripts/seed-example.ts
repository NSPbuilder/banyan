/**
 * An EXAMPLE COMPANY in the development database, covering every kind of
 * transaction the system has — the owner's ask: 「做一个example公司,尽量
 * 所有种类的交易都覆盖」.
 *
 *   npm run db:example
 *
 * Everything goes through the application doors — createCompanyWithYear,
 * registerTax, postOpeningBalance, the invoice/quick FORM readers, the
 * payment and bank libs, the records module — never raw SQL, so the seed
 * exercises exactly the code the owner runs and the guards refuse exactly
 * what they would refuse. Refuses to run twice: the company is a fixture to
 * explore and delete pieces of, not something to mint repeatedly.
 *
 * What it leaves behind (all in 2026):
 *   registration      GST/HST and BC PST, effective Jan 1
 *   opening balance   Jan 1 — cash, equipment net of depreciation, equity
 *   parties           two customers, two suppliers, one person who is
 *                     director + shareholder + employee, with addresses
 *   sales             INV-1001 (GST+PST, paid in full), INV-1002 (GST, paid
 *                     in part), CN-1001 applied against INV-1002
 *   purchases         a bill paid in full, a bill still owing
 *   quick entries     expense with GST+PST typed inclusive (a till receipt),
 *                     an out-of-scope bank interest income
 *   journal           a rent accrual, and a wrong entry corrected by
 *                     reversal (the ADJ pair)
 *   bank              a CSV import on the operating account: one row matched
 *                     to the INV-1001 receipt, one fee posted from the row,
 *                     one row ignored (the bank's own error), one left open
 *   payroll           Dana on the payroll, one semi-monthly payday in July
 *   bank statement    July's, to reconcile against
 *   records           profile, registered office, the director appointed,
 *                     common shares issued, a minute book entry, and the
 *                     transparency register's one significant individual
 *   a waived receipt  one expense marked as needing no paper
 *   the freeze        January is CLOSED — try to edit anything dated there
 */
// './dotenv', NOT './env': env remaps every script to the TEST database so a
// suite can never touch the books. This seed is the one script that MUST
// touch the books — the example company is for the owner to open, edit and
// break in the real app. The run-once guard above main() is its safety.
import './dotenv'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { buildExampleCompany } from './example-company'

async function main() {
  const [already] = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM entity WHERE code = 'DEMO' OR name = 'Maple Demo Consulting Ltd.'`)
  if (already) {
    console.error('Maple Demo Consulting Ltd. already exists — this seed runs once.\n'
      + 'Explore it, edit it, delete pieces of it; that is what it is for.')
    process.exit(1)
  }

  console.log('Creating Maple Demo Consulting Ltd. …')
  const { ledgerId: L } = await buildExampleCompany({
    code: 'DEMO', name: 'Maple Demo Consulting Ltd.', actor: 'seed-example',
  })

  console.log(`
Maple Demo Consulting Ltd. is ready:
  open  http://localhost:3000/ledger/${L}
  January is CLOSED — try editing the opening balance to see the freeze.
  INV-1002 is partly settled by cash and a credit note; the office bill is paid;
  the legal bill is still owing. One bank row is left unmatched on purpose.`)
  await conn.end()
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })
