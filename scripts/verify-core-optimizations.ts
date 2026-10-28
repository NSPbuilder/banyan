/** Regression and bounded measurements for the four approved core optimizations. */
import './env'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { db, sql as connection } from '../src/db/client'
import { createCompany, createFiscalYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { parseCsvRows } from '../src/lib/csv'
import { parseCsv } from '../src/lib/bank-csv'
import { postEntry } from '../src/lib/posting'
import { bankRows, candidateEntries, feed, importBankRows, matchesFor, rememberedContra,
  matchEntry, ignoreBankRow, postFromBankRow, reconcileView, saveStatement } from '../src/lib/bank'
import { suggestionFor } from '../src/lib/bank-feed'
import { createParty } from '../src/lib/parties'
import { createInvoice, postInvoice } from '../src/lib/invoices'
import { documentsWithBalances, openItemsFor, recordPayment } from '../src/lib/payments'
import { exportCompany, packFigtree, readFigtree } from '../src/lib/backup'
import { bindFxBankAccount, setFxCurrency } from '../src/lib/fx'
import { sql } from 'drizzle-orm'
import { reporter, errorText } from './suite'

const r = reporter(66)
const baseline = process.env.OPTIMIZATION_BASELINE === '1'
const actor = 'core-optimization@example.test'
const measurements: unknown[] = []
const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x)

async function measure<T>(fn: () => Promise<T>) {
  let queries = 0
  const previous = connection.options.debug
  connection.options.debug = () => { queries++ }
  const start = performance.now()
  try { return { result: await fn(), queries, ms: Math.round((performance.now() - start) * 100) / 100 } }
  finally { connection.options.debug = previous }
}

async function main() {
  const csv = '\uFEFF  # comment with an unmatched "\r\n\r\ncode,name,type,parent,roles,balance\r\n1000,"Cash, \"\"USD\"\"\r\n# still the name",asset,,,contra\r\n2000\tPayables\tliability'
  const parsed = parseAccountsCsv(csv)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].name, 'Cash, "USD"\r\n# still the name')
  assert.equal(parsed[0].normalBalance, 'credit')
  assert.equal(parsed[1].accountType, 'liability')
  assert.deepEqual(parseCsvRows('a,"b\r\nc"\r\nbad\r\n', [',']).map(row => row.line), [1, 3])
  assert.throws(() => parseAccountsCsv(csv + '\r\n3000,Bad,unknown'), /Line 7: "unknown"/)
  assert.throws(() => parseAccountsCsv('code,name,type\n1000,"Cash\nOperating",asset\nbad'), /Line 4 has 1 column/)
  assert.deepEqual(parseCsv('# data,"a\tb"\n', ','), [['# data', 'a\tb']])
  assert.equal(parseAccountsCsv('1000,"Quoted\tname",asset')[0].name, 'Quoted\tname')
  assert.throws(() => parseAccountsCsv(','), /Line 1 has 2 columns/)
  assert.throws(() => parseAccountsCsv('""'), /Line 1 has 1 column/)
  assert.equal(parseAccountsCsv('\u00a0# comment with "\n\t\n1000,Cash,asset').length, 1)
  assert.equal(parseAccountsCsv('\tcode\tname\ttype\t\r\n \t1000\tCash\tasset\t')[0].code, '1000')
  assert.throws(() => parseAccountsCsv('bad\t\t'), /Line 1 has 1 column/)
  assert.throws(() => parseAccountsCsv('1000,Cash\t'), /Line 1 has 2 columns/)
  r.pass('CO0 shared CSV handles multiline names, comments and physical error lines')
  const co = await createCompany({ code: 'OPT', name: 'Core Optimization Verification Ltd.' }, actor)
  await createFiscalYear(co.ledger.id, '2026-12-31', actor)
  const accounts = await importAccounts(co.company.id, parseAccountsCsv(`1000,Cash,asset,,cash_and_cash_equivalents
1010,Spare cash,asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
2000,Payables,liability,,trade_payables
3000,Capital,equity,,share_capital
4000,Revenue,revenue,,revenue_from_contracts
5000,Expense,expense,,other_operating_expenses`).map(x => ({ ...x, entityId: co.company.id })), actor)
  const at = (code: string) => accounts.find(a => a.code === code)!.id
  assert.deepEqual(await feed(at('1010')), { pending: [], posted: [], excluded: [] })
  r.pass('CO1 empty bank account stays empty')
  for (let n = 1; n <= 20; n++) await postEntry({ ledgerId: co.ledger.id,
    entryDate: `2026-03-${String(n).padStart(2, '0')}`, description: `Candidate ${n}`, actor,
    lines: [{ accountId: at('1000'), amount: BigInt(1000 + n) }, { accountId: at('3000'), amount: -BigInt(1000 + n) }] })
  let previousCount = 0
  for (const count of [50, 500, 5000]) {
    await importBankRows({ accountId: at('1000'), actor,
      rows: Array.from({ length: count - previousCount }, (_, n) => ({ date: '2026-03-31', amount: 1020n,
        description: `Payee ${previousCount + n}` })) })
    const m = await measure(() => feed(at('1000')))
    assert.equal(m.result.pending.length, count)
    // Independently retain the old single-row doors as the result oracle.
    // All 20 candidate dates differ, so neither ranking nor LIMIT has tie ambiguity.
    const oracle = await measure(async () => {
      const rows = await bankRows(at('1000'))
      const out = []
      for (const row of rows) {
        const candidates = await candidateEntries(row.id, 8)
        const remembered = await rememberedContra(at('1000'), row.description)
        out.push({ currency: 'CAD', row, matches: row.matched_amount === 0n ? [] : await matchesFor(row.id),
          candidates, suggestion: suggestionFor(row, candidates, remembered) })
      }
      return out.reverse()
    })
    assert.equal(json(m.result.pending), json(oracle.result))
    if (!baseline) assert(m.queries <= 5, `feed made ${m.queries} queries for ${count} rows`)
    measurements.push({ bankRows: count, postedCandidateEntries: 20, feedQueries: m.queries, feedMs: m.ms,
      singleRowQueries: oracle.queries, singleRowMs: oracle.ms })
    r.pass(`CO2.${count} feed equals single-row results; bounded queries`, `${m.queries} queries / ${m.ms} ms`)
    previousCount = count
  }
  const rows = await bankRows(at('1000'))
  const [candidate] = await candidateEntries(rows[0].id)
  await matchEntry({ bankTransactionId: rows[0].id, entryId: candidate.entry_id, amount: 500n, actor })
  await ignoreBankRow(rows[1].id, 'test exclusion', actor)
  await postFromBankRow({ bankTransactionId: rows[2].id, contraAccountId: at('3000'), actor })
  await importBankRows({ accountId: at('1000'), actor, rows: [
    { date: '2026-03-15', amount: -300n, description: 'Boundary' },
    { date: '2026-03-31', amount: -500n, description: 'Utilities 123' },
    { date: '2026-03-31', amount: -500n, description: 'Utilities 999' },
  ] })
  const utility = (await bankRows(at('1000'))).find(row => row.description === 'Utilities 123')!
  await postFromBankRow({ bankTransactionId: utility.id, contraAccountId: at('5000'), actor })
  const mixed = await measure(() => feed(at('1000')))
  assert.equal(mixed.queries, 5)
  assert.equal(mixed.result.excluded.length, 1)
  const sample = [...mixed.result.posted, ...mixed.result.excluded,
    mixed.result.pending.find(view => view.row.id === rows[0].id)!,
    mixed.result.pending.find(view => view.row.description === 'Utilities 999')!]
  for (const view of sample) {
    const open = ['unmatched', 'part'].includes(view.row.state)
    assert.equal(json(view.matches), json(await matchesFor(view.row.id)))
    const candidates = open ? await candidateEntries(view.row.id, 8) : []
    assert.equal(json(view.candidates), json(candidates))
    assert.equal(json(view.suggestion), json(open ? suggestionFor(view.row, candidates,
      await rememberedContra(at('1000'), view.row.description)) : { kind: 'none' }))
  }
  const utilityAgain = sample.at(-1)!
  assert.equal(utilityAgain.suggestion.kind, 'add')
  r.pass('CO3 batch matches, partial/ignored rows and remembered payees equal single reads')
  await saveStatement({ accountId: at('1000'), statementDate: '2026-03-15', endingBalance: 0n, actor })
  await saveStatement({ accountId: at('1000'), statementDate: '2026-03-31', endingBalance: 0n, actor })
  const view = await reconcileView(at('1000'), '2026-03-31')
  assert(view)
  assert(view.pendingRows.every(row => row.txn_date > '2026-03-15' && row.txn_date <= '2026-03-31'))
  assert.equal(view.clearedRows.length, mixed.result.posted.length + 1)
  for (const row of view.clearedRows) assert.equal(json(row.entries), json((await matchesFor(row.id)).map(m => ({
    entry_no: m.entry_no, description: m.entry_description, amount: m.amount, source_type: m.source_type,
  }))))
  r.pass('CO4 reconcile dates exclude the prior boundary; cleared matches equal single reads')

  await setFxCurrency(co.ledger.id, 'USD', true, actor)
  await bindFxBankAccount(co.ledger.id, at('1010'), 'USD', actor)
  const rate = { currency: 'USD', rate: '1.350000000000', observedOn: '2026-01-01', source: 'manual' as const, reference: 'Verification funding advice' }
  await postEntry({ ledgerId: co.ledger.id, entryDate: '2026-03-31', description: 'Foreign funding', actor,
    lines: [{ accountId: at('1010'), amount: 1350n, originalCurrency: 'USD', originalAmount: 1000n, fxSnapshot: rate },
      { accountId: at('3000'), amount: -1350n }] })
  await importBankRows({ accountId: at('1010'), actor, rows: [{ date: '2026-03-31', amount: 1000n, description: 'Foreign deposit' }] })
  const foreign = (await feed(at('1010'))).pending[0]
  assert.equal(foreign.currency, 'USD')
  assert.equal(foreign.candidates[0].room, 1000n)
  assert.equal(json(foreign.candidates), json(await candidateEntries(foreign.row.id, 8)))
  r.pass('CO5 foreign feed ranks native amounts and remains account scoped')

  const party = await createParty({ kind: 'organisation', name: 'Core Optimization Customer', actor,
    roles: [{ entityId: co.company.id, role: 'customer', heldFrom: '2026-01-01' },
      { entityId: co.company.id, role: 'supplier', heldFrom: '2026-01-01' }] })
  for (let n = 0; n < 30; n++) {
    const purchase = n === 29, credit = n === 28
    const inv = await createInvoice({ ledgerId: co.ledger.id, direction: purchase ? 'purchase' : 'sales',
      kind: credit ? 'credit_note' : 'invoice', partyId: party.id,
      controlAccountId: at(purchase ? '2000' : '1200'), issuedOn: '2026-04-01', dueOn: '2026-04-30',
      number: `OPT-${String(n).padStart(2, '0')}`, actor,
      lines: [{ accountId: at(purchase ? '5000' : '4000'), amount: purchase || credit ? 1000n : -1000n }] })
    await postInvoice(inv.id, actor)
    if (n < 25) await recordPayment({ invoiceId: inv.id, bankAccountId: at('1000'), amount: 1000n, paidOn: '2026-04-02', actor })
  }
  const all = await documentsWithBalances(co.ledger.id)
  const open = await openItemsFor(co.ledger.id)
  assert.equal(all.length, 30); assert.equal(open.length, 5)
  assert.equal(json(open), json(all.filter(item => item.balance !== 0n)))
  measurements.push({ postedDocuments: all.length, returnedOpenItems: open.length })
  r.pass('CO6 SQL returns only 5 open documents from 30, including credit and payable')

  const queries: string[] = []
  const previousDebug = connection.options.debug
  connection.options.debug = (_, query) => { queries.push(query) }
  let doc
  try { doc = await exportCompany(co.company.id, { withFiles: true }) }
  finally { connection.options.debug = previousDebug }
  assert(!queries.some(query => /^\s*SELECT sha256, mime FROM attachment_blob\s*$/i.test(query)))
  const bytes = await packFigtree(doc)
  const legacy = gzipSync(Buffer.from(json(doc)))
  assert.deepEqual(gunzipSync(bytes), gunzipSync(legacy))
  assert.equal(readFigtree(bytes).checksum, doc.checksum)
  r.pass('CO7 asynchronous archive preserves v4 payload/checksum without global MIME scan')
  // A large incompressible paper payload makes synchronous compression observable.
  const large = { ...doc, files: [{ sha256: 'test', bytes: randomBytes(4 * 1024 * 1024).toString('base64'),
    mime: 'application/octet-stream', size: 4 * 1024 * 1024, storageDomain: 'accounting' as const }] }
  let advanced = false
  const tick = new Promise<void>(resolve => setImmediate(() => { advanced = true; resolve() }))
  const packed = packFigtree(large)
  assert.equal(advanced, false)
  await packed
  assert.equal(advanced, true)
  await tick
  // Confirm SQL filtering preserves the result for a foreign document as well.
  const foreignInvoice = await createInvoice({ ledgerId: co.ledger.id, direction: 'sales', currency: 'USD', rate,
    partyId: party.id, controlAccountId: at('1200'), issuedOn: '2026-04-03', dueOn: '2026-04-30',
    lines: [{ accountId: at('4000'), amount: -1000n }], actor })
  await postInvoice(foreignInvoice.id, actor)
  assert.equal(json(await openItemsFor(co.ledger.id)), json((await documentsWithBalances(co.ledger.id)).filter(i => i.balance !== 0n)))
  const [application] = await db.execute<{ name: string }>(sql`SELECT current_database() AS name`)
  assert.equal(application.name, process.env.TEST_DATABASE_CONFIRMATION)
  r.pass('CO8 compression yields to event loop; FX open items retain existing balance predicate')
}

main().catch(e => { r.fail('core optimization suite', errorText(e)) }).finally(async () => {
  mkdirSync('docs/evidence/core-optimizations', { recursive: true })
  writeFileSync(`docs/evidence/core-optimizations/${baseline ? 'before' : 'after'}.json`, JSON.stringify({
    capturedAt: new Date().toISOString(), baseline, measurements, failures: r.failures,
    caveat: 'Local isolated PostgreSQL; fixed 20 posted candidate entries. Timings are observations, not production guarantees.',
  }, null, 2) + '\n')
  console.log(r.summary())
  await connection.end()
  process.exitCode = r.failures === 0 ? 0 : 1
})
