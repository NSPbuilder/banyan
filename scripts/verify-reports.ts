/**
 * The journal list, the chart search, and the account history.
 *   npm run db:verify-reports   (resets the database first)
 */
import './env'
import { reporter } from './suite'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { readFileSync } from 'fs'
import { HIDE_ZEROS, isEmptyRow } from '../src/lib/reporting-view'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { amendEntry, postEntry, saveDraft } from '../src/lib/posting'
import { accountLedger, accountSummary, journalEntries } from '../src/lib/reports'
import { matchesAccountSearch } from '../src/lib/forms'
import { parseMoney } from '../src/lib/money'

const r = reporter(50)
const { pass, fail } = r

const CHART = `1000,Cash — Operating,asset,,cash_and_cash_equivalents
1200,Accounts Receivable,asset,,trade_receivables
1210,Allowance for credit losses,asset,,allowance_for_credit_losses,contra
2100,GST/HST Payable,liability,,gst_hst_payable
4000,Consulting Revenue,revenue,,revenue_from_contracts
5100,Professional Fees,expense,,professional_fees fn_administrative_expenses`

async function main() {
  const acme = await createCompanyWithYear(
    { code: 'ACME', name: 'Acme Consulting Inc.', province: 'ON' }, 'alicio@example.test')
  const L = acme.ledger.id
  const accts = await importAccounts(acme.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: acme.company.id })), 'alicio@example.test')
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  const year = new Date().getUTCFullYear()

  // R1 — the fiscal year came with the company
  acme.periodCount === 12
    ? pass('R1 a company arrives with its fiscal year', `${acme.year.name}, ${acme.periodCount} periods`)
    : fail('R1 a company arrives with its fiscal year', JSON.stringify(acme.year))

  // Three entries against 1200 so the history has something to run through.
  const inv1 = await postEntry({
    ledgerId: L, entryDate: `${year}-03-10`, description: 'Invoice 1001 — Client X',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('5650.00'), description: 'Client X' },
      { accountId: id['4000'], amount: -parseMoney('5000.00'), description: 'Consulting' },
      { accountId: id['2100'], amount: -parseMoney('650.00'), description: 'HST 13%' },
    ],
  })
  await postEntry({
    ledgerId: L, entryDate: `${year}-03-20`, description: 'Payment received',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['1000'], amount: parseMoney('5650.00') },
      { accountId: id['1200'], amount: -parseMoney('5650.00'), description: 'Client X paid' },
    ],
  })
  const inv2 = await postEntry({
    ledgerId: L, entryDate: `${year}-04-05`, description: 'Invoice 1002',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('1130.00') },
      { accountId: id['4000'], amount: -parseMoney('1000.00') },
      { accountId: id['2100'], amount: -parseMoney('130.00') },
    ],
  })

  // R2 — the journal list carries a line summary, in one query
  const posted = await journalEntries(L, { status: 'posted' })
  const first = posted.find((e) => e.description === 'Invoice 1001 — Client X')!
  first.accounts.length === 3 && first.line_count === '3'
    && first.accounts.join(',') === '1200,4000,2100'
    ? pass('R2 the journal list shows each entry\'s lines', first.accounts.join(' · '))
    : fail('R2 the journal list shows each entry\'s lines', JSON.stringify(first))

  // R3 — and knows which side each line is on
  const sides = first.accounts.map((c, i) => `${c}:${Number(first.debits[i]) !== 0 ? 'Dr' : 'Cr'}`)
  sides.join(' ') === '1200:Dr 4000:Cr 2100:Cr'
    ? pass('R3 each line carries its side', sides.join(' '))
    : fail('R3 each line carries its side', sides.join(' '))

  // R4 — a draft appears with its lines too, and separately from posted entries
  await saveDraft({
    ledgerId: L, entryDate: `${year}-05-01`, description: 'Half-written',
    actor: 'alicio@example.test',
    lines: [{ accountId: id['5100'], amount: parseMoney('40.00') }],
  })
  const drafts = await journalEntries(L, { status: 'draft' })
  const postedIds = new Set(posted.map((p) => p.id))
  drafts.length === 1 && drafts[0].accounts.join('') === '5100'
    && !drafts.some((d) => postedIds.has(d.id))
    ? pass('R4 drafts are listed apart, with their lines', `${drafts.length} draft, 5100`)
    : fail('R4 drafts are listed apart, with their lines', JSON.stringify(drafts.map((d) => d.description)))

  // R5 — the history reads the journal; period_balance is a cache of it. They
  //      are different sources, and a stale cache makes them disagree — which
  //      is what check_balance_integrity reports. On a ledger with no drift
  //      they must agree exactly, and this asserts it.
  const history = await accountLedger(id['1200'], L)
  const lastRunning = BigInt(history[history.length - 1].running)
  const [cached] = await db.execute<{ balance: string }>(raw`
    SELECT pb.closing_balance::text AS balance
      FROM period_balance pb JOIN fiscal_period fp ON fp.id = pb.period_id
     WHERE pb.ledger_id = ${L} AND pb.account_id = ${id['1200']}::uuid
     ORDER BY fp.start_date DESC LIMIT 1`)
  lastRunning === BigInt(cached.balance)
    ? pass('R5 history running balance == the cached balance',
           `${history.length} lines end at ${(Number(lastRunning) / 100).toFixed(2)}`)
    : fail('R5 history running balance == the cached balance',
           `history ${lastRunning} vs period_balance ${cached.balance}`)

  // R6 — every step of the running balance is the sum of what came before it
  let walk = 0n
  const drifted = history.find((l) => { walk += BigInt(l.amount); return BigInt(l.running) !== walk })
  !drifted
    ? pass('R6 the running balance adds up line by line', `${history.length} lines, no step out of place`)
    : fail('R6 the running balance adds up line by line', JSON.stringify(drifted))

  // R7 — the other side of each line is shown
  const invLine = history.find((l) => l.entry_no === inv1.entry.entryNo)!
  invLine.contra_codes.join(',') === '2100,4000'
    ? pass('R7 each line shows what it was posted against', invLine.contra_codes.join(' + '))
    : fail('R7 each line shows what it was posted against', JSON.stringify(invLine.contra_codes))

  // R8 — filtering to one period keeps the running balance continuous, so a
  //      period view does not restart from zero and mislead
  // By id, keyed off the fiscal year too: period_no repeats in every year, so
  // a fixture that grew a second year would silently pick an arbitrary April.
  const [aprilId] = await db.execute<{ id: string }>(raw`
    SELECT fp.id::text FROM fiscal_period fp
      JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
     WHERE fp.ledger_id = ${L} AND fp.period_no = 4 AND fy.name = ${acme.year.name}`)
  const april = await accountLedger(id['1200'], L, { periodId: aprilId.id })
  const aprilLine = april[0]
  april.length === 1 && BigInt(aprilLine.running) === BigInt(cached.balance)
    ? pass('R8 a period view continues the running balance',
           `April alone, balance ${(Number(aprilLine.running) / 100).toFixed(2)} — not restarted`)
    : fail('R8 a period view continues the running balance', JSON.stringify(april.map((l) => l.running)))

  // R9 — drafts stay out of the history, as they stay out of every balance
  const expenses = await accountLedger(id['5100'], L)
  expenses.length === 0
    ? pass('R9 drafts do not appear in an account history', 'the 5100 draft is absent')
    : fail('R9 drafts do not appear in an account history', JSON.stringify(expenses))

  // R10 — a correction shows all three entries, and they net to the right figure
  await amendEntry(inv2.entry.id, {
    entryDate: `${year}-04-05`, description: 'Invoice 1002 — corrected',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('1695.00') },
      { accountId: id['4000'], amount: -parseMoney('1500.00') },
      { accountId: id['2100'], amount: -parseMoney('195.00') },
    ],
  }, 'alicio@example.test')
  const afterAmend = await accountLedger(id['1200'], L)
  const summary = await accountSummary(id['1200'])
  const three = afterAmend.filter((l) => l.entry_date === `${year}-04-05`)
  three.length === 3
    && three.reduce((s, l) => s + BigInt(l.amount), 0n) === parseMoney('1695.00')
    && BigInt(afterAmend[afterAmend.length - 1].running) === BigInt(summary.balance)
    ? pass('R10 a correction shows as three lines netting to the fix',
           '1,130 + (1,130) + 1,695 = 1,695')
    : fail('R10 a correction shows as three lines netting to the fix',
           JSON.stringify({ lines: three.length, net: three.reduce((s, l) => s + BigInt(l.amount), 0n).toString() }))

  // R11-R14 — the chart search
  const chart = accts.map((a) => ({
    code: a.code, name: a.name, account_type: a.accountType,
    role_labels: null as string[] | null,
  }))
  const bySubstring = chart.filter((a) => matchesAccountSearch(a, 'cash'))
  bySubstring.length === 1 && bySubstring[0].code === '1000'
    ? pass('R11 search matches a name', 'cash -> 1000')
    : fail('R11 search matches a name', JSON.stringify(bySubstring.map((a) => a.code)))

  const byCode = chart.filter((a) => matchesAccountSearch(a, '12'))
  byCode.map((a) => a.code).join(',') === '1200,1210'
    ? pass('R12 search matches a code prefix', '12 -> 1200, 1210')
    : fail('R12 search matches a code prefix', JSON.stringify(byCode.map((a) => a.code)))

  const byType = chart.filter((a) => matchesAccountSearch(a, 'expense'))
  byType.length === 1 && byType[0].code === '5100'
    ? pass('R13 search matches the account type', 'expense -> 5100')
    : fail('R13 search matches the account type', JSON.stringify(byType.map((a) => a.code)))

  // every term must match, which is how a long list gets narrowed
  const narrowed = chart.filter((a) => matchesAccountSearch(a, 'asset credit'))
  const roleAware = [{ code: '9999', name: 'X', account_type: 'asset', role_labels: ['Trade receivables'] }]
  narrowed.length === 1 && narrowed[0].code === '1210'
    && matchesAccountSearch(roleAware[0], 'receivable')
    && chart.filter((a) => matchesAccountSearch(a, '')).length === chart.length
    ? pass('R14 every term must match; roles are searchable', 'asset credit -> 1210; empty -> everything')
    : fail('R14 every term must match; roles are searchable',
           JSON.stringify({ narrowed: narrowed.map((a) => a.code) }))

  // R40 — HIDING THE EMPTY ROWS IS A READING CHOICE, NOT A DIFFERENT REPORT.
  //
  //        A chart holds accounts nobody posted to this year and each takes a
  //        line (owner, 2026-09-07). What matters about the switch is what it
  //        must NOT do: change a figure. So the rule is checked directly —
  //        empty means nothing moved AND nothing stood — and then the totals
  //        are compared with the rows hidden and shown.
  {
    const moved = { debit: '1000', credit: '0', balance: '0' }
    const stood = { debit: '0', credit: '0', balance: '2500' }
    const nothing = { debit: '0', credit: '0', balance: '0' }
    const blank = { debit: '', credit: undefined, balance: '' }
    const label = 'R40 a row is empty only when nothing moved and nothing stood'
    !isEmptyRow(moved) && !isEmptyRow(stood) && isEmptyRow(nothing) && isEmptyRow(blank)
      ? pass(label, 'moved: kept; stood at a figure: kept; zero every way: hidden')
      : fail(label, `${isEmptyRow(moved)}/${isEmptyRow(stood)}/${isEmptyRow(nothing)}`)

    const rows = [moved, stood, nothing]
    const sum = (rs: typeof rows) => rs.reduce((n, r) => n + BigInt(r.debit || '0'), 0n)
    const l2 = 'R40b hiding rows does not change what the report adds up to'
    sum(rows) === sum(rows.filter((r) => !isEmptyRow(r)))
      ? pass(l2, `${sum(rows)} either way`)
      : fail(l2, `${sum(rows)} vs ${sum(rows.filter((r) => !isEmptyRow(r)))}`)

    // …and the screen, the PDF and the spreadsheet read the same parameter.
    const readers: Array<[string, RegExp]> = [
      ['src/app/ledger/[ledgerId]/reports/trial-balance/page.tsx', /hidesZeros\(/],
      ['src/app/ledger/[ledgerId]/reports/trial-balance/pdf/route.ts', /hideZeros: q\.get\(HIDE_ZEROS\)/],
      ['src/app/ledger/[ledgerId]/export/route.ts', /hideZeros: q\.get\(HIDE_ZEROS\)/],
    ]
    const missing = readers.filter(([f, re]) => !re.test(readFileSync(f, 'utf8'))).map(([f]) => f)
    const l3 = 'R40c the screen and both downloads read the same switch'
    missing.length === 0
      ? pass(l3, `${readers.length} readers, one name (${HIDE_ZEROS})`)
      : fail(l3, `not read by: ${missing.join(', ')}`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })
