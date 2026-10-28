/**
 * The GST/HST return.
 *   npm run db:verify-tax   (resets the TEST database first)
 *
 * These figures go on a government form. The failure that matters is a total
 * that cannot be traced to the entries behind it, or one that quietly disagrees
 * with the ledger — so every check compares the return against the journal, and
 * every line against its own drill-down.
 */
import './env'
import { reporter } from './suite'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv, setAccountRoles } from '../src/lib/accounts'
import { amendEntry, postEntry, saveDraft } from '../src/lib/posting'
import { filingPeriods, gstHstReturn, pstReturn } from '../src/lib/tax'
import {
  PST_COMMISSION_SCALE, RE_READ_AFTER_DAYS, SALES_TAX, TaxFigureError, commissionScaleOn,
  computeTax, daysSinceRead, pstCommission, salesTaxOn,
} from '../src/lib/tax-rates'
import { registerTax } from '../src/lib/registrations'
import { postOpeningBalance } from '../src/lib/opening'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatMoney, parseMoney } from '../src/lib/money'

const r = reporter(52)
const { pass, fail, check } = r
const $ = (cents: bigint) => formatMoney(cents)
const money = (c: bigint) => (Number(c) / 100).toFixed(2)

const CHART = `1000,Cash,asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
1300,GST/HST Recoverable,asset,,gst_hst_recoverable
2000,Payables,liability,,trade_payables
2100,GST/HST Payable,liability,,gst_hst_payable
2200,PST Payable,liability,,qst_pst_payable
3000,Share Capital,equity,,share_capital
3100,Retained Earnings,equity,,retained_earnings
4000,Consulting Revenue,revenue,,revenue_from_contracts
4100,Export Revenue,revenue,,revenue_from_contracts
5000,Supplies,expense,,office_and_administrative fn_administrative_expenses`

async function main() {
  const co = await createCompanyWithYear(
    { code: 'ACME', name: 'Acme Consulting Inc.', province: 'ON',
      businessNumber: '123456789RT0001' }, 'alicio@example.test')
  const L = co.ledger.id
  const accts = await importAccounts(co.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  const yr = Number(co.year.endDate.slice(0, 4))
  const Q1 = { from: `${yr}-01-01`, to: `${yr}-03-31` }

  // A return only exists for a registered company. Registered from well before
  // this fixture's first invoice, so nothing here is tax charged too early —
  // that case has its own checks in verify-registrations.
  await registerTax({
    entityId: co.company.id, tax: 'GST_HST',
    number: '123456789RT0001', registeredOn: `${yr - 2}-01-01`, actor: 'alicio@example.test' })

  // A quarter of ordinary business: two taxed sales, one purchase with ITCs,
  // and one zero-rated export.
  await postEntry({
    ledgerId: L, entryDate: `${yr}-01-15`, description: 'Invoice 1001', actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('11300.00') },
      { accountId: id['4000'], amount: -parseMoney('10000.00') },
      { accountId: id['2100'], amount: -parseMoney('1300.00') },   // HST 13%
    ],
  })
  await postEntry({
    ledgerId: L, entryDate: `${yr}-02-20`, description: 'Invoice 1002', actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('5650.00') },
      { accountId: id['4000'], amount: -parseMoney('5000.00') },
      { accountId: id['2100'], amount: -parseMoney('650.00') },
    ],
  })
  await postEntry({
    ledgerId: L, entryDate: `${yr}-02-28`, description: 'Office supplies', actor: 'alicio@example.test',
    lines: [
      { accountId: id['5000'], amount: parseMoney('1000.00') },
      { accountId: id['1300'], amount: parseMoney('130.00') },     // ITC
      { accountId: id['2000'], amount: -parseMoney('1130.00') },
    ],
  })
  await postEntry({
    ledgerId: L, entryDate: `${yr}-03-10`, description: 'Export sale — zero rated', actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('4000.00') },
      { accountId: id['4100'], amount: -parseMoney('4000.00') },
    ],
  })
  // Outside the quarter: must not appear.
  await postEntry({
    ledgerId: L, entryDate: `${yr}-04-05`, description: 'Invoice 1003 — next quarter', actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('2260.00') },
      { accountId: id['4000'], amount: -parseMoney('2000.00') },
      { accountId: id['2100'], amount: -parseMoney('260.00') },
    ],
  })
  // A draft: in no return, as it is in no balance.
  await saveDraft({
    ledgerId: L, entryDate: `${yr}-03-15`, description: 'Not posted', actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('9999.00') },
      { accountId: id['4000'], amount: -parseMoney('9999.00') },
    ],
  })

  const q1 = (await gstHstReturn(L, Q1.from, Q1.to))!

  // G1 — the four figures CRA asks for
  q1.lines.sales.amount === parseMoney('19000.00')      // 10,000 + 5,000 + 4,000
    && q1.lines.collected.amount === parseMoney('1950.00')  // 1,300 + 650
    && q1.lines.itcs.amount === parseMoney('130.00')
    && q1.lines.net.amount === parseMoney('1820.00')        // 1,950 − 130
    ? pass('G1 the four lines of the return',
           `101 ${money(q1.lines.sales.amount)}, 105 ${money(q1.lines.collected.amount)}, ` +
           `108 ${money(q1.lines.itcs.amount)}, 109 ${money(q1.lines.net.amount)}`)
    : fail('G1 the four lines of the return',
           JSON.stringify(Object.fromEntries(
             Object.entries(q1.lines).map(([k, v]) => [k, money(v.amount)]))))

  // G2 — THE ONE THAT MATTERS AT A CRA DESK. The column shown must add up to
  //      the total shown — as printed, with no sign gymnastics by the reader.
  //      Before this, a reversal displayed as its magnitude, so a corrected
  //      invoice's drill-down read 3,640 against a line of 2,340.
  const addsUp = (l: typeof q1.lines.sales) =>
    l.entries.reduce((s, e) => s + e.contribution, 0n) === l.amount

  addsUp(q1.lines.sales) && addsUp(q1.lines.collected) && addsUp(q1.lines.itcs)
    ? pass('G2 the entries shown add up to the line shown',
           `${q1.lines.sales.entries.length} + ${q1.lines.collected.entries.length} + ` +
           `${q1.lines.itcs.entries.length} entries, each column sums to its total`)
    : fail('G2 the entries shown add up to the line shown',
           JSON.stringify({
             sales: `${money(q1.lines.sales.entries.reduce((s, e) => s + e.contribution, 0n))} vs ${money(q1.lines.sales.amount)}`,
             collected: `${money(q1.lines.collected.entries.reduce((s, e) => s + e.contribution, 0n))} vs ${money(q1.lines.collected.amount)}`,
             itcs: `${money(q1.lines.itcs.entries.reduce((s, e) => s + e.contribution, 0n))} vs ${money(q1.lines.itcs.amount)}`,
           }))

  // G3 — and against the journal itself, not against the report's own arithmetic
  const [ledgerFigures] = await db.execute<{ sales: string; collected: string; itcs: string }>(raw`
    SELECT
      (SELECT COALESCE(-SUM(jl.amount), 0)::text FROM journal_line jl
         JOIN journal_entry je ON je.id = jl.entry_id JOIN account a ON a.id = jl.account_id
        WHERE je.ledger_id = ${L} AND je.status IN ('posted','reversed')
          AND je.entry_date BETWEEN ${Q1.from}::date AND ${Q1.to}::date
          AND a.account_type = 'revenue')                                        AS sales,
      (SELECT COALESCE(-SUM(jl.amount), 0)::text FROM journal_line jl
         JOIN journal_entry je ON je.id = jl.entry_id
        WHERE je.ledger_id = ${L} AND je.status IN ('posted','reversed')
          AND je.entry_date BETWEEN ${Q1.from}::date AND ${Q1.to}::date
          AND jl.account_id = ${id['2100']}::uuid)                               AS collected,
      (SELECT COALESCE(SUM(jl.amount), 0)::text FROM journal_line jl
         JOIN journal_entry je ON je.id = jl.entry_id
        WHERE je.ledger_id = ${L} AND je.status IN ('posted','reversed')
          AND je.entry_date BETWEEN ${Q1.from}::date AND ${Q1.to}::date
          AND jl.account_id = ${id['1300']}::uuid)                               AS itcs`)
  q1.lines.sales.amount === BigInt(ledgerFigures.sales)
    && q1.lines.collected.amount === BigInt(ledgerFigures.collected)
    && q1.lines.itcs.amount === BigInt(ledgerFigures.itcs)
    ? pass('G3 the return equals the journal', 'not just its own arithmetic')
    : fail('G3 the return equals the journal', JSON.stringify(ledgerFigures))

  // G4 — the next quarter's invoice is not in this quarter
  q1.lines.collected.entries.every((e) => e.entryDate <= Q1.to)
    && !q1.lines.sales.entries.some((e) => e.description.includes('1003'))
    ? pass('G4 the filing period is respected', 'April invoice absent')
    : fail('G4 the filing period is respected', 'an out-of-range entry appeared')

  // G5 — drafts are not tax
  !q1.lines.sales.entries.some((e) => e.description === 'Not posted')
    ? pass('G5 a draft is in no return', 'as it is in no balance')
    : fail('G5 a draft is in no return', 'a draft was counted')

  // G6 — the export sale is flagged for review, not judged. It is legitimately
  //      zero-rated, and it is also what a forgotten tax line looks like.
  const untaxed = q1.review.find((r) => r.what.includes('no GST/HST'))
  untaxed?.entries?.length === 1 && untaxed.entries[0].accountCode === '4100'
    ? pass('G6 a sale with no tax is raised, not decided', untaxed.what)
    : fail('G6 a sale with no tax is raised, not decided', JSON.stringify(q1.review.map((r) => r.what)))

  // G7 — an open period means the figures can still move
  q1.review.some((r) => r.what.includes('still open'))
    ? pass('G7 open periods are named before filing', 'the figures can still change')
    : fail('G7 open periods are named before filing', JSON.stringify(q1.review.map((r) => r.what)))

  // G8 — CORRECTING AN INVOICE. The mistake, its reversal and the replacement
  //      must net to the corrected tax, not to the mistake and not to both.
  const [inv1002] = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM journal_entry WHERE ledger_id = ${L} AND description = 'Invoice 1002'`)
  await amendEntry(inv1002.id, {
    entryDate: `${yr}-02-20`, description: 'Invoice 1002 — corrected', actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('9040.00') },
      { accountId: id['4000'], amount: -parseMoney('8000.00') },
      { accountId: id['2100'], amount: -parseMoney('1040.00') },
    ],
  }, 'alicio@example.test')

  const corrected = (await gstHstReturn(L, Q1.from, Q1.to))!
  corrected.lines.collected.amount === parseMoney('2340.00')   // 1,300 + 1,040
    && corrected.lines.sales.amount === parseMoney('22000.00') // 10,000 + 8,000 + 4,000
    ? pass('G8 a corrected invoice reports the correction',
           `105 is ${money(corrected.lines.collected.amount)}, not 1,950 and not 3,640`)
    : fail('G8 a corrected invoice reports the correction',
           `105 ${money(corrected.lines.collected.amount)}, 101 ${money(corrected.lines.sales.amount)}`)

  // G9 — the correction is visible as three entries AND the column still adds
  //      up on the page. The reversal must show as a reduction; displaying its
  //      magnitude made the column read 3,640 against a line of 2,340.
  const shown = corrected.lines.collected.entries
  const columnSums = shown.reduce((s, e) => s + e.contribution, 0n)
  const reversal = shown.find((e) => e.description.startsWith('Reversal'))
  columnSums === corrected.lines.collected.amount
    && shown.length === 4                     // 1001, 1002, its reversal, its replacement
    && reversal !== undefined && reversal.contribution < 0n
    ? pass('G9 the reversal shows as a reduction and the column adds up',
           `${shown.length} entries: 1,300 + 650 − 650 + 1,040 = ${money(columnSums)}`)
    : fail('G9 the reversal shows as a reduction and the column adds up',
           `${shown.length} entries summing ${money(columnSums)} against ${money(corrected.lines.collected.amount)}, ` +
           `reversal contribution ${reversal ? money(reversal.contribution) : 'missing'}`)

  // G10 — an untagged tax account reports zero for a reason the person must know
  const [taxAccount] = await db.execute<{ id: string }>(raw`
    SELECT id::text FROM account WHERE entity_id = ${co.company.id} AND code = '2100'`)
  await setAccountRoles(taxAccount.id, [], 'alicio@example.test')
  const untagged = (await gstHstReturn(L, Q1.from, Q1.to))!
  untagged.lines.collected.amount === 0n
    && untagged.review.some((r) => r.what.includes('No account carries the "GST/HST payable" role'))
    ? pass('G10 zero with nothing tagged says why', 'not "no tax was collected"')
    : fail('G10 zero with nothing tagged says why', JSON.stringify(untagged.review.map((r) => r.what)))
  await setAccountRoles(taxAccount.id, ['gst_hst_payable'], 'alicio@example.test')

  // G11 — the quarters offered are the ones a person files for
  const periods = filingPeriods(new Date('2026-08-21T00:00:00Z'))
  const lastQ4 = periods.find((p) => p.name === 'Q4 2025')
  periods[0].from === '2026-01-01' && periods[0].to === '2026-03-31'
    && periods[3].to === '2026-12-31' && periods.some((p) => p.name === '2025')
    && lastQ4?.from === '2025-10-01' && lastQ4?.to === '2025-12-31'
    ? pass('G11 the filing periods offered are real quarters, last year\'s too', periods.map((p) => p.name).join(' '))
    : fail('G11 the filing periods offered are real quarters, last year\'s too', JSON.stringify(periods))

  // G13 — the quarters offered on the EVENING of 31 December are still this
  //       year's. Every instant G11 uses is UTC midnight, which in this
  //       timezone is the previous afternoon — local year and UTC year agree,
  //       so G11 passed with `filingPeriods` reading the UTC clock and offering
  //       the quarters of a year that had not started, without the Q4 being
  //       filed.
  const offsetMinutes = -new Date('2026-12-31T12:00:00Z').getTimezoneOffset()
  if (offsetMinutes === 0) {
    pass('G13 the quarters on New Year\'s Eve are the year being filed',
         'skipped: this machine runs on UTC, where the two never differ')
  } else {
    // An instant that is 31 December here and 1 January in UTC, or the reverse.
    const nye = offsetMinutes < 0
      ? new Date('2027-01-01T01:00:00Z')   // west: 31 Dec, evening
      : new Date('2026-12-31T23:30:00Z')   // east: already 1 Jan
    const expected = offsetMinutes < 0 ? '2026' : '2027'
    const late = filingPeriods(nye)
    late[3].to === `${expected}-12-31` && late.some((p) => p.name === expected)
      ? pass('G13 the quarters on New Year\'s Eve are the year being filed',
             `${nye.toISOString()} -> ${late.map((p) => p.name).join(' ')}`)
      : fail('G13 the quarters on New Year\'s Eve are the year being filed',
             `wanted ${expected}, got ${late.map((p) => p.name).join(' ')}`)
  }

  // G12 — an empty quarter is zero everywhere, not an error
  const empty = (await gstHstReturn(L, `${yr - 1}-01-01`, `${yr - 1}-03-31`))!
  empty.lines.sales.amount === 0n && empty.lines.net.amount === 0n
    && empty.lines.collected.entries.length === 0
    ? pass('G12 a quarter with nothing in it reports zero', 'and does not fail')
    : fail('G12 a quarter with nothing in it reports zero', JSON.stringify(empty.lines.net))

  // G14 — an opening balance is a position, not this quarter's trading
  {
    // A conversion done mid-year carries the tax already remitted and the
    // revenue already reported, as balances. Counted here they would be filed a
    // second time: revenue reported twice and tax remitted twice, on a return
    // that says they happened this quarter.
    const conv = await createCompanyWithYear(
      { code: 'CONV', name: 'Converted Mid-Year Ltd.', province: 'BC' }, 'alicio@example.test')
    const accounts = await importAccounts(conv.company.id,
      parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: conv.company.id })), 'alicio@example.test')
    const acc = (code: string) => accounts.find((a) => a.code === code)!
    await registerTax({
      entityId: conv.company.id, tax: 'GST_HST', number: '000000000RT0001',
      registeredOn: `${yr}-01-01`, actor: 'alicio@example.test',
    })

    await postOpeningBalance({
      ledgerId: conv.ledger.id, entryDate: `${yr}-07-01`, actor: 'alicio@example.test',
      description: 'Opening balances — mid-year conversion',
      lines: [
        { accountId: acc('1000').id, amount: 5000000n },
        { accountId: acc('4000').id, amount: -4000000n },
        { accountId: acc('2100').id, amount: -520000n },
        { accountId: acc('3100').id, amount: -480000n },
      ],
    })

    const q3 = (await gstHstReturn(conv.ledger.id, `${yr}-07-01`, `${yr}-09-30`))!
    q3.lines.sales.amount === 0n && q3.lines.collected.amount === 0n
      ? pass('G14 an opening balance is not this quarter\'s sales or tax',
             `sales ${q3.lines.sales.amount}, collected ${q3.lines.collected.amount}`)
      : fail('G14 an opening balance is not this quarter\'s sales or tax',
             `sales ${q3.lines.sales.amount}, collected ${q3.lines.collected.amount}`)

    // Left off, so said out loud: absent without a word looks the same as not
    // existing, and someone converting mid-year needs to know the figures went
    // somewhere.
    const named = q3.review.find((r) => r.what.includes('opening balance'))
    named && (named.entries?.length ?? 0) >= 2
      ? pass('G15 and it is named in the review rather than silently absent',
             `${named.entries?.length} lines shown`)
      : fail('G15 and it is named in the review rather than silently absent',
             q3.review.map((r) => r.what).join(' | ').slice(0, 90))
  }

  // ------------------------------------------------------------- PST ----

  // BC's return, the same shape — on a BC company, because registrations.ts
  // knows an Ontario company does not register for PST and refuses it (the
  // first version tried, and the suite died there). One sale with both taxes
  // on it, beside one with neither.
  const bc = await createCompanyWithYear(
    { code: 'WEST', name: 'Westcoast Design Ltd.', province: 'BC',
      businessNumber: '987654321RT0001' }, 'alicio@example.test')
  const W = bc.ledger.id
  const wAccts = await importAccounts(bc.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: bc.company.id })), 'alicio@example.test')
  const w = Object.fromEntries(wAccts.map((a) => [a.code, a.id]))
  await registerTax({
    entityId: bc.company.id, tax: 'GST_HST',
    number: '987654321RT0001', registeredOn: `${yr - 1}-01-01`, actor: 'alicio@example.test' })
  await registerTax({
    entityId: bc.company.id, tax: 'PST',
    number: 'PST-1234-5678', registeredOn: `${yr - 1}-01-01`, actor: 'alicio@example.test' })
  await postEntry({
    ledgerId: W, entryDate: `${yr}-04-05`, description: 'Invoice 2001 — consulting', actor: 'alicio@example.test',
    lines: [
      { accountId: w['1200'], amount: parseMoney('2100.00') },
      { accountId: w['4000'], amount: -parseMoney('2000.00') },
      { accountId: w['2100'], amount: -parseMoney('100.00') },   // GST 5%, no PST on a service
    ],
  })
  await postEntry({
    ledgerId: W, entryDate: `${yr}-05-10`, description: 'Invoice 2002 — software licence', actor: 'alicio@example.test',
    lines: [
      { accountId: w['1200'], amount: parseMoney('3360.00') },
      { accountId: w['4000'], amount: -parseMoney('3000.00') },
      { accountId: w['2100'], amount: -parseMoney('150.00') },   // GST 5%
      { accountId: w['2200'], amount: -parseMoney('210.00') },   // PST 7%
    ],
  })
  const Q2 = { from: `${yr}-04-01`, to: `${yr}-06-30` }
  const p2 = (await pstReturn(W, Q2.from, Q2.to))!
  const g2 = (await gstHstReturn(W, Q2.from, Q2.to))!

  // G16 — the boxes: A is every sale (the PST-free one too), B is only the PST
  // account, C is BC's commission on B, D is B less C.
  p2.lines.sales.amount === parseMoney('5000.00')        // 2,000 (2001) + 3,000 (2002)
    && p2.lines.collected.amount === parseMoney('210.00')
    && p2.lines.commission.amount === parseMoney('22.00')  // 210 is between 22.01 and 333.33
    && p2.lines.net.amount === parseMoney('188.00')
    ? pass('G16 the PST return: sales, PST collectable, commission, net',
        `A ${money(p2.lines.sales.amount)} B ${money(p2.lines.collected.amount)} C ${money(p2.lines.commission.amount)} D ${money(p2.lines.net.amount)}`)
    : fail('G16 the PST return: sales, PST collectable, commission, net',
        `A ${money(p2.lines.sales.amount)} B ${money(p2.lines.collected.amount)} C ${money(p2.lines.commission.amount)} D ${money(p2.lines.net.amount)}`)

  // G17 — the GST on the same sale is on the GST return and NOT on the PST one,
  // and the other way round: two taxes, two accounts, two returns.
  g2.lines.collected.amount === parseMoney('250.00')       // 100 (2001) + 150 (2002)
    && !p2.lines.collected.entries.some((e) => e.accountCode === '2100')
    && !g2.lines.collected.entries.some((e) => e.accountCode === '2200')
    ? pass('G17 each return reads its own tax account and not the other\'s',
        `GST line 105 ${money(g2.lines.collected.amount)}; PST box B from ${p2.lines.collected.entries.map((e) => e.accountCode).join(',')}`)
    : fail('G17 each return reads its own tax account and not the other\'s',
        `GST ${money(g2.lines.collected.amount)}, PST entries ${p2.lines.collected.entries.map((e) => e.accountCode).join(',')}`)

  // G18 — BC's commission tiers, at their edges (tax-rates.ts, as read 2026-09-04).
  const tiers: Array<[bigint, bigint]> = [
    [1500n, 1500n],        // $15.00 → the whole amount
    [2200n, 2200n],        // $22.00 → the whole amount
    [2201n, 2200n],        // $22.01 → $22.00
    [33333n, 2200n],       // $333.33 → $22.00
    [33334n, 2200n],       // $333.34 → 6.6% = $22.00 (rounds to the flat)
    [100000n, 6600n],      // $1,000.00 → $66.00
    [300000n, 19800n],     // $3,000.00 → 6.6% = $198.00, the cap
    [1000000n, 19800n],    // $10,000.00 → capped at $198.00
    [0n, 0n], [-500n, 0n], // nothing, or a net refund → no commission
  ]
  const wrong = tiers.filter(([c, want]) => pstCommission(c, '2026-05-01') !== want)
  wrong.length === 0
    ? pass('G18 the commission follows BC\'s tiers at every edge', `${tiers.length} amounts, the cap at $198.00`)
    : fail('G18 the commission follows BC\'s tiers at every edge',
        wrong.map(([c, want]) => `${c} → ${pstCommission(c, '2026-05-01')} not ${want}`).join('; '))

  // G19 — a company not registered for PST gets no return, in words, and the
  // PST-only sale does not disturb the GST review.
  // Acme is in Ontario and has no PST registration at all.
  const unregistered = (await pstReturn(L, Q2.from, Q2.to))!
  unregistered.coverage === 'none'
    && unregistered.review.some((r) => r.what.includes('not registered for PST'))
    && p2.review.some((r) => r.what.startsWith('The commission'))
    ? pass('G19 no PST registration means no return to file, said in words; the commission caveat is on the return',
        unregistered.review[0]?.what ?? '')
    : fail('G19 no PST registration means no return to file, said in words; the commission caveat is on the return',
        `coverage ${unregistered.coverage}: ${unregistered.review.map((r) => r.what).join(' | ').slice(0, 100)}`)

  // G20 — every figure on the PST worksheet drills down. The first version
  // linked boxes A and B to a breakdown that knew only lines 101/105/108 and
  // answered "nothing to break down" (critic).
  const { breakdown } = await import('../src/lib/breakdown')
  const boxA = await breakdown(W, { kind: 'tax', tax: 'pst', line: 'A', from: Q2.from, to: Q2.to })
  const boxB = await breakdown(W, { kind: 'tax', tax: 'pst', line: 'B', from: Q2.from, to: Q2.to })
  boxA !== null && boxB !== null && boxB.total?.amount === parseMoney('210.00')
    && boxA.rows.length === 3   // two sales and the total line
    ? pass('G20 boxes A and B open their breakdowns', `A ${boxA.rows.length - 1} entries, B ${money(boxB.total!.amount)}`)
    : fail('G20 boxes A and B open their breakdowns', `A ${boxA ? 'ok' : 'null'}, B ${boxB ? money(boxB.total?.amount ?? 0n) : 'null'}`)

  // G21 — a remittance paid inside the window is named, with its amount, on
  // both returns: it debits the payable and moves the bank, and would
  // otherwise silently lower the collected line (critic).
  await postEntry({
    ledgerId: W, entryDate: `${yr}-05-20`, description: 'PST remitted for Q1', actor: 'alicio@example.test',
    lines: [{ accountId: w['2200'], amount: parseMoney('400.00') }, { accountId: w['1000'], amount: -parseMoney('400.00') }],
  })
  await postEntry({
    ledgerId: W, entryDate: `${yr}-05-21`, description: 'GST remitted for Q1', actor: 'alicio@example.test',
    lines: [{ accountId: w['2100'], amount: parseMoney('900.00') }, { accountId: w['1000'], amount: -parseMoney('900.00') }],
  })
  const p2r = (await pstReturn(W, Q2.from, Q2.to))!
  const g2r = (await gstHstReturn(W, Q2.from, Q2.to))!
  const pNote = p2r.review.find((r) => r.what.includes('payment') && r.what.includes('government'))
  const gNote = g2r.review.find((r) => r.what.includes('payment') && r.what.includes('government'))
  pNote?.detail.includes('400.00') && gNote?.detail.includes('900.00')
    && p2r.lines.collected.amount === parseMoney('210.00') - parseMoney('400.00')
    ? pass('G21 a remittance inside the window is named with its amount on both returns',
        `PST: ${pNote?.what}; GST: ${gNote?.what}`)
    : fail('G21 a remittance inside the window is named with its amount on both returns',
        `PST note ${pNote?.detail.slice(0, 60) ?? 'none'}; GST note ${gNote?.detail.slice(0, 60) ?? 'none'}`)

  // G22 — filed late, the commission is zero and box D is box B in full.
  const lateRet = (await pstReturn(W, Q2.from, Q2.to, { late: true }))!
  lateRet.lines.commission.amount === 0n && lateRet.lines.net.amount === lateRet.lines.collected.amount
    && lateRet.review.some((r) => r.what === 'Marked as filed late')
    ? pass('G22 marked late, the commission is zero and box D is box B', money(lateRet.lines.net.amount))
    : fail('G22 marked late, the commission is zero and box D is box B', `C ${money(lateRet.lines.commission.amount)} D ${money(lateRet.lines.net.amount)}`)

  // G30-G31 — THE FIGURES NOBODY CAN CHECK.
  //
  //       The CRA payroll tables vet themselves; 5, 7 and BC's four commission
  //       numbers cannot — they are what two governments say. So what is held
  //       here is the two things that CAN be: that the figures are chosen by the
  //       DOCUMENT'S date rather than today's, and that each carries where and
  //       when it was read so a screen can say how old it is
  //       (owner, 2026-09-12).
  {
    const refusedBy = (run: () => unknown) => {
      try { run(); return '' } catch (e) { return e instanceof TaxFigureError ? e.code : String(e) }
    }
    const first = SALES_TAX[0]!
    // A day before anything on file is REFUSED, not quietly given the earliest.
    const early = refusedBy(() => salesTaxOn('2001-01-01'))
    const earlyScale = refusedBy(() => commissionScaleOn('2001-01-01'))
    // The boundary, from BOTH sides and through the catcher: the day before is
    // refused and the day itself is not. Comparing `salesTaxOn(first.from).from`
    // to `first.from` could only ever be true or throw, and a throw here aborts
    // the suite instead of printing a FAIL (independent critic, 2026-09-12).
    const dayBefore = (() => {
      const d = new Date(`${first.from}T00:00:00Z`)
      d.setUTCDate(d.getUTCDate() - 1)
      return d.toISOString().slice(0, 10)
    })()
    const beforeIt = refusedBy(() => salesTaxOn(dayBefore))
    const onIt = refusedBy(() => salesTaxOn(first.from))
    const onTheDay = beforeIt === 'NO_FIGURES' && onIt === ''
    // Every entry says where it came from and when somebody looked.
    const sourced = [...SALES_TAX, ...PST_COMMISSION_SCALE]
      .filter((e) => !e.source.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(e.readOn))
    const age = daysSinceRead(first.readOn, '2027-09-04')
    // AND THE TWO CALLERS THAT MUST PASS THE DOCUMENT'S OWN DATE. This reads
    // TEXT, and says so: with one set of figures on file every date gives the
    // same answer, so nothing can tell by computing whether the caller passed
    // the right one. `G31` holds the arithmetic; these two lines are the wiring
    // into it, and they are what a second set of figures would expose.
    const wired: Array<[string, boolean]> = [
      ['`pstCommission(collected, to)`',
       readFileSync(join('src', 'lib', 'tax.ts'), 'utf8').includes('pstCommission(collected, to)')],
      ['`computeEnteredTax(p.typed, p.taxCode, inclusive, issuedOn, p.overrides)`',
       readFileSync(join('src', 'lib', 'invoice-forms.ts'), 'utf8')
         .includes('computeEnteredTax(p.typed, p.taxCode, inclusive, issuedOn, p.overrides)')],
    ]
    check(early === 'NO_FIGURES' && earlyScale === 'NO_FIGURES' && onTheDay
      && sourced.length === 0 && age === 365 && RE_READ_AFTER_DAYS === 365
      && wired.every(([, ok]) => ok),
      'G30 the tax figures are dated both ways — in force from, and last read on',
      `a 2001 date: rates ${early || 'ACCEPTED'}, commission ${earlyScale || 'ACCEPTED'}; `
        + `${dayBefore} ${beforeIt || 'ACCEPTED'} and ${first.from} itself `
        + `${onIt === '' ? 'is in force' : `REFUSED: ${onIt}`}; `
        + `${SALES_TAX.length + PST_COMMISSION_SCALE.length} entr(ies), `
        + `${sourced.length} without a source or a read date; a year later reads as ${age} days, `
        + `and ${RE_READ_AFTER_DAYS} is the age the screen is told to colour at `
        + '(nothing here renders it); the callers: '
        + `${wired.map(([w, ok]) => `${ok ? 'has' : 'NO LONGER has'} ${w}`).join(', ')}`)
  }

  {
    // THE DOCUMENT'S DATE, NOT TODAY'S. Proved by putting a second, different
    // set of figures in front of the same function rather than by reading the
    // one on file: with one entry, "chosen by date" cannot fail.
    const later = { ...SALES_TAX[0]!, from: '2099-01-01', gst: 9n, pst: 11n }
    const laterScale = { ...PST_COMMISSION_SCALE[0]!, from: '2099-01-01', max: 50000n }
    SALES_TAX.push(later)
    PST_COMMISSION_SCALE.push(laterScale)
    // PUT BACK WHATEVER HAPPENS. These are module-level arrays every other
    // caller shares; a throw between the push and the pop would leave a 2099
    // entry standing for the rest of the process
    // (independent critic, 2026-09-12).
    let before, after, commissionBefore, commissionAfter
    try {
      before = computeTax(parseMoney('100.00'), 'GST_PST', false, '2026-05-01')
      after = computeTax(parseMoney('100.00'), 'GST_PST', false, '2099-05-01')
      commissionBefore = pstCommission(parseMoney('10000.00'), '2026-05-01')
      commissionAfter = pstCommission(parseMoney('10000.00'), '2099-05-01')
    } finally {
      SALES_TAX.pop()
      PST_COMMISSION_SCALE.pop()
    }
    check(before.gst === parseMoney('5.00') && before.pst === parseMoney('7.00')
      && after.gst === parseMoney('9.00') && after.pst === parseMoney('11.00')
      && commissionBefore === parseMoney('198.00') && commissionAfter === parseMoney('500.00'),
      'G31 a back-dated document is taxed at the rate of its own day',
      `on 2026-05-01: GST ${$(before.gst)}, PST ${$(before.pst)}, commission `
        + `${$(commissionBefore)}; with a 2099 entry in front of it, the same $100 on 2099-05-01: `
        + `GST ${$(after.gst)}, PST ${$(after.pst)}, commission ${$(commissionAfter)}`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })
