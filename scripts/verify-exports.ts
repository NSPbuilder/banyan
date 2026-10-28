/**
 * Exports and the backup status.
 *   npm run db:verify-exports   (resets the TEST database first)
 *
 * The failure that matters here is quiet: a spreadsheet whose figures differ
 * from the screen. Nobody compares a CSV with a web page line by line, so every
 * check below compares the export against the SAME function the page renders.
 */
import './env'
import { reporter } from './suite'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { amendEntry, postEntry, saveDraft } from '../src/lib/posting'
import { trialBalance, trialBalanceSpan } from '../src/lib/balances'
import { renderStatement } from '../src/lib/statements'
import { accountLedgerCsv, breakdownCsv, journalCsv, pd7aCsv, statementCsv, trialBalanceCsv } from '../src/lib/exports'
import { breakdown } from '../src/lib/breakdown'
import { renderCashFlow } from '../src/lib/cash-flow'
import { renderEquityChanges } from '../src/lib/equity-changes'
import { accountReference } from '../src/lib/account-reference'
import { entriesByParty } from '../src/lib/browse'
import { createParty } from '../src/lib/parties'
import { aging, BUCKETS } from '../src/lib/aging'
import { gstHstReturn } from '../src/lib/tax'
import { availableStatements } from '../src/lib/statements'
import { generalLedger } from '../src/lib/reports'
import {
  agingPdf, breakdownPdf, cashFlowBlocks, customerStatementPdf, equityChangesBlocks,
  generalLedgerPdf, pdfResponse, spanFor, statementPdf, taxReturnPdf, trialBalancePdf,
 } from '../src/lib/pdf-reports'
import { pdfText, pdfTextAt } from './pdf-text'
import { formatMoney } from '../src/lib/money'
import { reportPdf } from '../src/lib/pdf'
import { accountLedger, journalEntries } from '../src/lib/reports'
import { csvCell, csvFile, csvMoney, filename } from '../src/lib/csv'
import { entryHeaderFrom } from '../src/lib/forms'
import { parseMoney } from '../src/lib/money'
import { auditCsv, auditFilterFrom, type AuditRow } from '../src/lib/audit'

const r = reporter(50)
const { pass, fail, check } = r

/** Parse CSV back, so a check reads what a spreadsheet would read. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false
  const body = text.replace(/^﻿/, '')
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quoted) {
      if (c === '"') { if (body[i + 1] === '"') { cell += '"'; i++ } else quoted = false }
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

/** What `groupLabel` in columns.ts calls a run of fiscal months — spelled
 *  here on its own, so the check does not ask the code what it should say. */
const groupLabels = (periods: Array<{ name: string }>, size: number): string[] => {
  const out: string[] = []
  for (let i = 0; i < periods.length; i += size) {
    const g = periods.slice(i, i + size)
    out.push(g.length === 1 ? g[0]!.name : `${g[0]!.name} – ${g[g.length - 1]!.name}`)
  }
  return out
}

const CHART = `1000,"Cash — Operating, main",asset,,cash_and_cash_equivalents
1200,Receivables,asset,,trade_receivables
2100,GST/HST Payable,liability,,gst_hst_payable
3000,Share Capital,equity,,share_capital
3100,Retained Earnings,equity,,retained_earnings
4000,Revenue,revenue,,revenue_from_contracts
5000,"Fees, professional",expense,,professional_fees fn_administrative_expenses`

async function main() {
  // ------------------------------------------------------------------ csv --
  csvCell('Cash — Operating, main') === '"Cash — Operating, main"'
    && csvCell('He said "hi"') === '"He said ""hi"""'
    && csvCell('plain') === 'plain'
    && csvCell(null) === ''
    && csvCell('line\nbreak') === '"line\nbreak"'
    ? pass('X1 a cell is quoted when it has to be', 'commas, quotes, newlines')
    : fail('X1 a cell is quoted when it has to be',
           [csvCell('Cash — Operating, main'), csvCell('He said "hi"')].join(' | '))

  // A cell beginning =, +, - or @ is run as a formula when Excel opens the file.
  // The guard must catch a formula and leave a negative amount alone: an
  // export whose credits read "\t-1500.00" cannot be added up, which is the
  // one thing an export is for.
  csvCell('=1+1').startsWith('"\t') && csvCell('@SUM(A1)').startsWith('"\t')
    && csvCell('-1500.00') === '-1500.00' && csvCell('-5') === '-5'
    && csvCell('-not a number').startsWith('"\t')
    ? pass('X2 formulas are neutralised, negative amounts are not',
           `=1+1 -> quoted, -1500.00 -> ${csvCell('-1500.00')}`)
    : fail('X2 formulas are neutralised, negative amounts are not',
           [csvCell('=1+1'), csvCell('-1500.00'), csvCell('-not a number')].join(' | '))

  csvMoney(150000n) === '1500.00' && csvMoney(-650n) === '-6.50' && csvMoney(0n) === '0.00'
    && csvMoney(5n) === '0.05'
    ? pass('X3 money is a plain decimal a spreadsheet can add', '150000 -> 1500.00')
    : fail('X3 money is a plain decimal a spreadsheet can add',
           [csvMoney(150000n), csvMoney(-650n), csvMoney(5n)].join(' '))

  const file = csvFile([['a', 'b'], ['c,d', 'e']])
  file.startsWith('﻿') && file.includes('\r\n') && parseCsv(file)[1][0] === 'c,d'
    ? pass('X4 a file survives the round trip', 'BOM, CRLF, quoted comma')
    : fail('X4 a file survives the round trip', JSON.stringify(file))

  filename(['Acme Consulting Inc.', 'trial-balance', '2026-03']) === 'Acme-Consulting-Inc._trial-balance_2026-03.csv'
    ? pass('X5 the filename is usable', filename(['Acme Consulting Inc.', 'trial-balance', '2026-03']))
    : fail('X5 the filename is usable', filename(['Acme Consulting Inc.', 'trial-balance', '2026-03']))

  const sampleAudit: AuditRow = {
    id: '1', occurred_at: '2026-09-21 12:00:00+00', actor: '=HYPERLINK("bad")',
    action: 'update', table_name: 'journal_entry', record_id: 'record-1',
    before: { description: 'Before, with comma' }, after: { description: 'After' },
    context: { request: '@SUM(A1:A2)' }, entity_id: 'entity-1', ledger_id: 'ledger-1',
    scope: 'company', reason: 'Correction', target_label: 'JE-1',
    entity_name: 'Acme, Inc.', ledger_name: 'General',
  }
  const auditRows = parseCsv(auditCsv([sampleAudit]))
  const safeActor = auditRows[1]?.[2] ?? ''
  const safeJson = auditRows[1]?.[15] ?? ''
  const parsedFilter = auditFilterFrom({
    scope: 'company', from: '2026-02-29', to: '2026-09-21', action: 'update',
  })
  check(auditRows[0]?.[0] === 'Audit id' && auditRows[0]?.[15] === 'Context'
      && safeActor.startsWith('\t=') && safeJson.includes('@SUM(A1:A2)')
      && parsedFilter.scope === 'company' && parsedFilter.from === undefined
      && parsedFilter.to === '2026-09-21' && parsedFilter.action === 'update',
    'X5b the audit CSV is filterable, quoted, and cannot execute spreadsheet formulas',
    `${auditRows[0]?.length ?? 0} columns; actor ${JSON.stringify(safeActor)}; invalid day ${parsedFilter.from ?? 'rejected'}`)

  // --------------------------------------------------------------- ledger --
  const co = await createCompanyWithYear({ code: 'ACME', name: 'Acme Consulting Inc.' }, 'alicio@example.test')
  const L = co.ledger.id
  const accts = await importAccounts(co.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  const yr = Number(co.year.endDate.slice(0, 4))

  await postEntry({
    ledgerId: L, entryDate: `${yr}-03-10`, description: 'Invoice 1001', actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('5650.00') },
      { accountId: id['4000'], amount: -parseMoney('5000.00') },
      { accountId: id['2100'], amount: -parseMoney('650.00') },
    ],
  })
  await postEntry({
    ledgerId: L, entryDate: `${yr}-03-20`, description: 'Accountant, = fees', actor: 'alicio@example.test',
    lines: [
      { accountId: id['5000'], amount: parseMoney('1200.00') },
      { accountId: id['1000'], amount: -parseMoney('1200.00') },
    ],
  })
  await saveDraft({
    ledgerId: L, entryDate: `${yr}-04-01`, description: 'Not posted', actor: 'alicio@example.test',
    lines: [{ accountId: id['5000'], amount: parseMoney('9.00') }],
  })

  const [march] = await db.execute<{ id: string }>(raw`
    SELECT fp.id::text FROM fiscal_period fp
     WHERE fp.ledger_id = ${L} AND fp.period_no = 3`)

  // X6 — THE ONE THAT MATTERS, and the one that did not work. It compared
  //      columns 0, 2 and 4 — so the account NAME and the CREDIT column were
  //      never checked, and a mutation test proved the whole suite stayed green
  //      with every credit wrong by $7.77 and every name replaced. Build the
  //      row the screen implies and compare it whole.
  const onScreen = await trialBalance(L, march.id)
  const exported = parseCsv((await trialBalanceCsv(L, march.id)).csv)
  const dataRows = exported.slice(3).filter((r) => r[0] && r[0] !== '')

  const expectedRows = onScreen.map((l) =>
    [l.code, l.name, csvMoney(l.debit), csvMoney(l.credit), csvMoney(l.balance)])
  const actualRows = dataRows.map((r) => r.slice(0, 5))

  JSON.stringify(actualRows) === JSON.stringify(expectedRows)
    ? pass('X6 the exported trial balance equals the screen',
           `${onScreen.length} accounts, every column identical`)
    : fail('X6 the exported trial balance equals the screen',
           `\n  screen:   ${JSON.stringify(expectedRows)}\n  exported: ${JSON.stringify(actualRows)}`)

  // X8 — the total row lets the reader check nothing was lost in transit
  const totalRow = exported.find((r) => r[1] === 'Total')
  const screenDebit = onScreen.reduce((s, l) => s + BigInt(l.debit), 0n)
  totalRow?.[2] === csvMoney(screenDebit)
    ? pass('X8 the export carries its own total', `debits ${totalRow[2]}`)
    : fail('X8 the export carries its own total', JSON.stringify(totalRow))

  // X9 — every line of the statement, not one of them. Comparing only TOTAL
  //      ASSETS let a mutation put every other line out by a dollar and still
  //      pass.
  const rendered = (await renderStatement(L, 'IFRS_SFP_EN', march.id))!
  const stmtCsv = parseCsv((await statementCsv(L, 'IFRS_SFP_EN', march.id))!.csv)

  // The CSV suppresses zero detail lines, exactly as the page does.
  const expectedStatement = rendered.lines
    .filter((l) => l.lineType !== 'spacer' && !(l.lineType === 'detail' && l.raw === 0n))
    .map((l) => l.lineType === 'header'
      ? ['  '.repeat(l.indent) + l.label]
      : ['  '.repeat(l.indent) + l.label, csvMoney(l.shown),
         l.accounts?.map((a) => a.code).join(' ') ?? ''])

  // Start after the "Line, Amount, Accounts" header: everything above it is
  // the title block and any warnings, which X10 covers.
  const startAt = stmtCsv.findIndex((r) => r[1] === 'Line') + 1
  const actualStatement = stmtCsv.slice(startAt)
    .filter((r) => r[1] !== undefined && r[1] !== '')
    .map((r) => (r[2] === undefined || r[2] === '') && r[3] === undefined
      ? [r[1]] : [r[1], r[2], r[3] ?? ''])

  JSON.stringify(actualStatement) === JSON.stringify(expectedStatement)
    ? pass('X9 the exported statement equals the rendered one',
           `${expectedStatement.length} lines, every figure identical`)
    : fail('X9 the exported statement equals the rendered one',
           `\n  rendered: ${JSON.stringify(expectedStatement.slice(0, 5))}\n  exported: ${JSON.stringify(actualStatement.slice(0, 5))}`)

  // X10 — a statement's problems travel with it. A spreadsheet that drops the
  //       warning is a statement someone acts on without it.
  await importAccounts(co.company.id, [{
    entityId: co.company.id, code: '1900', name: 'Suspense', accountType: 'asset',
  }], 'alicio@example.test')
  await postEntry({
    ledgerId: L, entryDate: `${yr}-03-25`, description: 'Into suspense', actor: 'alicio@example.test',
    lines: [
      { accountId: (await db.execute<{ id: string }>(raw`SELECT id::text FROM account WHERE code='1900'`))[0].id,
        amount: parseMoney('300.00') },
      { accountId: id['1000'], amount: -parseMoney('300.00') },
    ],
  })
  const flawed = parseCsv((await statementCsv(L, 'IFRS_SFP_EN', march.id))!.csv)
  const warned = flawed.some((r) => r.some((c) => c.includes('INCOMPLETE')))
    && flawed.some((r) => r.some((c) => c.includes('1900')))
  warned
    ? pass('X10 an incomplete statement says so in the CSV', 'the warning is in the file')
    : fail('X10 an incomplete statement says so in the CSV', JSON.stringify(flawed.slice(0, 6)))

  // X11 — the journal exports one row per LINE, so the arithmetic can be redone
  const journal = parseCsv((await journalCsv(L)).csv)
  const journalLines = journal.slice(3).filter((r) => r[4])
  const [dbLines] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
     WHERE je.ledger_id = ${L} AND je.status IN ('posted','reversed')`)
  journalLines.length === Number(dbLines.n)
    ? pass('X11 the journal exports every line, not just totals', `${journalLines.length} lines`)
    : fail('X11 the journal exports every line, not just totals',
           `csv ${journalLines.length} vs ledger ${dbLines.n}`)

  // X12 — and drafts stay out of it, as they stay out of everything else
  journal.every((r) => !r.some((c) => c === 'Not posted'))
    ? pass('X12 drafts do not appear in an export', 'the draft is absent')
    : fail('X12 drafts do not appear in an export', 'a draft was exported')

  // X13 — a description that starts with = cannot execute in Excel
  const fees = journal.find((r) => r[2]?.includes('Accountant'))
  fees && !fees[2].startsWith('=')
    ? pass('X13 a description cannot execute in a spreadsheet', JSON.stringify(fees[2]))
    : fail('X13 a description cannot execute in a spreadsheet', JSON.stringify(fees?.[2]))

  // X14 — it never called accountLedger. It compared a row count and a final
  //        balance against a raw SUM, which the running balance equals by
  //        construction — so every date, entry number, description and contra
  //        account could be wrong and it still passed.
  const historyOnScreen = await accountLedger(id['1000'], L)
  const historyCsv = parseCsv((await accountLedgerCsv(L, id['1000'], undefined)).csv)
  const historyRows = historyCsv.slice(3).filter((r) => r[0]).map((r) => r.slice(0, 9))

  const expectedHistory = historyOnScreen.map((l) => [
    l.entry_date, l.entry_no, l.period_name,
    l.line_description || l.description,
    l.party_name ?? '',
    l.contra_codes.join(' '),
    l.debit === '0' ? '' : csvMoney(l.debit),
    l.credit === '0' ? '' : csvMoney(l.credit),
    csvMoney(l.running),
  ])

  JSON.stringify(historyRows) === JSON.stringify(expectedHistory)
    ? pass('X14 the account history export equals the screen',
           `${expectedHistory.length} lines, every column identical`)
    : fail('X14 the account history export equals the screen',
           `\n  screen:   ${JSON.stringify(expectedHistory)}\n  exported: ${JSON.stringify(historyRows)}`)

  // X15 — the journal's money went through a float round trip while every
  //       other export used integer cents, and nothing compared a single
  //       journal figure to the journal page.
  const journalOnScreen = await journalEntries(L, { status: 'posted', limit: 10_000 })
  const journalRows = parseCsv((await journalCsv(L)).csv).slice(3).filter((r) => r[4])

  const expectedJournal = journalOnScreen.flatMap((e) =>
    e.accounts.map((code, i) => [
      i === 0 ? e.entry_date : '', i === 0 ? (e.entry_no ?? '') : '',
      i === 0 ? e.description : '', i === 0 ? e.status : '',
      code,
      e.debits[i] !== '0' ? csvMoney(e.debits[i]) : '',
      e.credits[i] !== '0' ? csvMoney(e.credits[i]) : '',
    ]))

  JSON.stringify(journalRows.map((r) => r.slice(0, 7))) === JSON.stringify(expectedJournal)
    ? pass('X15 the journal export equals the journal page',
           `${expectedJournal.length} lines, every column identical`)
    : fail('X15 the journal export equals the journal page',
           `\n  screen:   ${JSON.stringify(expectedJournal.slice(0, 3))}\n  exported: ${JSON.stringify(journalRows.slice(0, 3))}`)

  // ------------------------------------------------------------- the PDFs --
  // Same rule as the CSVs: every PDF is compared against the SAME function
  // its page renders, read back independently (`pdf-text.ts` decodes the
  // TJ arrays; nothing here asks the builder what it meant to write).

  const span = await spanFor(L, `${yr}-01-01`, `${yr}-03-31`)
  if (!span) {
    fail('X16 the general ledger ties its two readers together', 'no span resolved')
  } else {
    // X16 — the load-bearing identity. Opening comes from period_balance
    // (the trial balance's own sums); the rows come from journal_line
    // (the register's reader). If either reader drifts, the account whose
    // opening + shown rows misses its closing names the drift.
    const gl = await generalLedger(L, span)
    const broken = gl.filter((a) =>
      a.opening + a.rows.reduce((t, r) => t + BigInt(r.amount), 0n) !== a.closing
      || (a.rows.length > 0 && BigInt(a.rows[a.rows.length - 1].running) !== a.closing))
    check(broken.length === 0 && gl.length > 0,
      'X16 the general ledger ties the balance cache to the journal, per account',
      broken.length === 0
        ? `${gl.length} accounts, opening + rows = closing in every one`
        : broken.map((a) => `${a.account.code}: ${a.opening} + rows != ${a.closing}`).join('; '))

    // X17 — the trial balance PDF shows the same rows and carries its total.
    const tbRows = await trialBalanceSpan(L, span.fromPeriodId, span.toPeriodId)
    const tbPdf = pdfText((await trialBalancePdf(L, span)).buffer)
    const tbDebits = tbRows.reduce((t, r) => t + BigInt(r.debit), 0n)
    const missingTb = tbRows.filter((r) =>
      !tbPdf.includes(r.name) || !tbPdf.includes(formatMoney(BigInt(r.balance))))
    check(tbPdf.includes('Trial balance') && missingTb.length === 0
          && tbPdf.includes(formatMoney(tbDebits)),
      'X17 the trial balance PDF shows every account and its own total',
      missingTb.length === 0 ? `${tbRows.length} accounts, total ${formatMoney(tbDebits)}`
        : `missing: ${missingTb.map((r) => r.name).join(', ')}`)

    // X18 — a statement PDF shows what renderStatement decided, down to the
    // profit line. The P&L because its figures move when anything does.
    const pl = await renderStatement(L, 'IFRS_PL_NATURE_EN', span.toPeriodId, span.fromPeriodId)
    const plPdfBuilt = await statementPdf(L, 'IFRS_PL_NATURE_EN', span)
    const plPdf = plPdfBuilt ? pdfText(plPdfBuilt.buffer) : ''
    const plTotals = (pl?.lines ?? []).filter((l) => l.lineType === 'total')
    check(plPdfBuilt !== null && plTotals.length > 0
          && plTotals.every((l) => plPdf.includes(formatMoney(l.shown)))
          && plPdf.includes('Statement of Profit or Loss (by nature)'),
      'X18 the statement PDF carries every total line the screen shows',
      plTotals.map((l) => `${l.label} ${formatMoney(l.shown)}`).join('; ').slice(0, 70))

    // X19 — the general ledger PDF opens every account where it stood.
    const glPdf = pdfText((await generalLedgerPdf(L, span)).buffer)
    // Headings are set in small caps by the builder — compare the way the
    // page shows them, not the way the source spells them.
    const missingGl = gl.filter((a) =>
      !glPdf.toUpperCase().includes(`${a.account.code} — ${a.account.name}`.toUpperCase())
      || !glPdf.includes(formatMoney(a.closing)))
    check(glPdf.includes('General ledger') && glPdf.includes('Opening balance')
          && missingGl.length === 0,
      'X19 the general ledger PDF has every account, opened and closed',
      missingGl.length === 0 ? `${gl.length} accounts on paper`
        : missingGl.map((a) => a.account.code).join(', '))

    // X20 — the aging PDF admits what it cannot attribute. This fixture has
    // receivables and no parties, which is exactly the case the note exists
    // for: money owed that no row above can show.
    const agPdf = pdfText((await agingPdf(L, `${yr}-03-31`)).buffer)
    check(agPdf.includes('sits on the control accounts with no party named')
          && agPdf.includes(formatMoney(parseMoney('5650.00'))),
      'X20 the aging PDF carries the unattributed warning with its figure',
      agPdf.split('\n').find((l) => l.includes('no party named'))?.slice(0, 70) ?? 'no warning line')

    // X21 — an unregistered company's GST PDF says there is no return to
    // file, rather than printing a page of confident zeroes.
    const taxPdfBuilt = await taxReturnPdf(L, `${yr}-01-01`, `${yr}-03-31`)
    const taxText = taxPdfBuilt ? pdfText(taxPdfBuilt.buffer) : ''
    check(taxPdfBuilt !== null && taxText.includes('GST/HST return figures')
          && taxText.includes('Not registered for any part of this range'),
      'X21 the GST PDF says not-registered instead of zeroes',
      taxText.split('\n').find((l) => l.includes('registered'))?.slice(0, 70) ?? 'no such line')
  }

  // X24 — ONE P&L. The owner decided (2026-09-02): by nature. The listing is
  // the interface; a second income statement offered anywhere reopens it.
  const offered = await availableStatements('IFRS')
  const incomeStatements = offered.filter((t) => t.statement_type === 'income_statement')
  check(incomeStatements.length === 1 && incomeStatements[0].code === 'IFRS_PL_NATURE_EN',
    'X24 one profit and loss is offered, and it is the by-nature one',
    incomeStatements.map((t) => t.code).join(', ') || 'none offered')

  // ---------------------------------------------------------- breakdowns --
  // Every report figure opens a breakdown, and every breakdown must account
  // for the figure that was clicked. The checks below compare each kind's
  // total against the SAME derivation the report printed — and where the
  // breakdown assigns rows by a second path (the aging buckets in TS against
  // the matrix's SQL CASE), agreeing is a genuine cross-check.

  const from = `${yr}-01-01`
  const to = `${yr}-03-31`
  const asOf = `${yr}-03-31`

  // A customer whose receivables age into two different buckets: 75 days and
  // 11 days as at 31 March. The ORIGINAL receivable (X20) keeps no party, so
  // the unattributed figure stays what that check pinned.
  const customer = await createParty({
    kind: 'organisation', name: 'Drill Down Ltd.',
    roles: [{ entityId: co.company.id, role: 'customer', heldFrom: from }],
    actor: 'alicio@example.test',
  })
  await postEntry({
    ledgerId: L, entryDate: `${yr}-01-15`, description: 'January invoice', actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('800.00'), partyId: customer.id },
      { accountId: id['4000'], amount: -parseMoney('800.00') },
    ],
  })
  await postEntry({
    ledgerId: L, entryDate: `${yr}-03-20`, description: 'March invoice', actor: 'alicio@example.test',
    lines: [
      { accountId: id['1200'], amount: parseMoney('300.00'), partyId: customer.id },
      { accountId: id['4000'], amount: -parseMoney('300.00') },
    ],
  })

  /** The money in a breakdown's LAST column, added the way a reader would:
   *  every row above the bold total line. */
  const lastColumnSum = (b: NonNullable<Awaited<ReturnType<typeof breakdown>>>) =>
    b.rows.filter((r) => !r.bold).reduce((s, r) => {
      const last = r.cells[r.cells.length - 1]
      return 'money' in last ? s + last.money : s
    }, 0n)

  const span2 = await spanFor(L, from, to)
  if (!span2) {
    fail('X25 statement-line breakdowns', 'no span resolved')
  } else {
    // X25 — EVERY line of BOTH statements: the breakdown's total is the figure
    // on the statement, and its own column adds up to that total. One wrong
    // sign, one dropped account, one mis-mapped formula term names itself.
    for (const tpl of ['IFRS_SFP_EN', 'IFRS_PL_NATURE_EN']) {
      const st = (await renderStatement(L, tpl, span2.toPeriodId, span2.fromPeriodId))!
      let checked = 0
      const wrong: string[] = []
      for (let i = 0; i < st.lines.length; i++) {
        const l = st.lines[i]
        if (l.lineType !== 'detail' && l.lineType !== 'total' && l.lineType !== 'current_earnings') continue
        const b = await breakdown(L, { kind: 'statement-line', template: tpl, line: String(i), from, to })
        if (!b) { wrong.push(`${l.label}: no breakdown`); continue }
        checked++
        if (b.total.amount !== l.shown) wrong.push(`${l.label}: total ${b.total.amount} != shown ${l.shown}`)
        else if (lastColumnSum(b) !== l.shown) wrong.push(`${l.label}: rows sum ${lastColumnSum(b)} != ${l.shown}`)
      }
      check(checked > 0 && wrong.length === 0,
        `X25 every ${tpl} line's breakdown adds to the line`,
        wrong.length === 0 ? `${checked} lines, column sums to the figure in every one` : wrong.join('; ').slice(0, 120))
    }

    // X25b — one detail figure against a DIFFERENT reader: the cash account's
    // row in the SFP breakdown must equal the trial balance's closing for it.
    const sfp = (await renderStatement(L, 'IFRS_SFP_EN', span2.toPeriodId, span2.fromPeriodId))!
    const cashLineIndex = sfp.lines.findIndex((l) => l.accounts?.some((a) => a.code === '1000'))
    const cashLine = sfp.lines[cashLineIndex]
    const bCash = await breakdown(L, {
      kind: 'statement-line', template: 'IFRS_SFP_EN', line: String(cashLineIndex), from, to })
    const tb2 = await trialBalanceSpan(L, span2.fromPeriodId, span2.toPeriodId)
    const cashTb = BigInt(tb2.find((r) => r.code === '1000')!.balance)
    const cashCell = bCash?.rows.find((r) => r.cells.some((c) => 'text' in c && c.text === '1000'))
      ?.cells.find((c) => 'money' in c)
    const cashShown = cashCell && 'money' in cashCell ? cashCell.money : null
    const flip = cashLine?.signFlip ? -1n : 1n
    check(cashShown !== null && cashShown === flip * cashTb,
      'X25b a statement-line account row equals the trial balance',
      cashShown !== null ? `1000 shows ${formatMoney(cashShown)} on both` : 'no cash row found')

    // ------------------- the two statements that are not templates (2026-09-15) --
    //
    // "cash flow里的数字无法点击看明细，要改，changes in equity也是" — neither was
    // clickable at all: the template statements have had a breakdown behind
    // every figure since they were written, and the two DERIVED ones had none.
    // These are X25 for them, and they are the checks that matter most, because
    // a cash flow line is the one figure on any report that a reader cannot
    // verify by looking a balance up.

    // X25c — every cash flow line a reader can click opens, its total is the
    //        figure on the statement, and its own column adds to that total.
    const cfX = (await renderCashFlow(L, span2.toPeriodId, span2.fromPeriodId))!
    {
      let checked = 0
      const wrong: string[] = []
      for (let i = 0; i < cfX.lines.length; i++) {
        const l = cfX.lines[i]
        if (l.lineType !== 'detail' && l.lineType !== 'total') continue
        const b = await breakdown(L, { kind: 'cash-flow-line', line: String(i), from, to })
        if (!b) { wrong.push(`${l.label}: no breakdown`); continue }
        checked++
        if (b.total.amount !== l.raw) wrong.push(`${l.label}: total ${b.total.amount} != ${l.raw}`)
        else if (lastColumnSum(b) !== l.raw) wrong.push(`${l.label}: rows sum ${lastColumnSum(b)} != ${l.raw}`)
      }
      check(checked > 0 && wrong.length === 0,
        "X25c every cash flow figure opens, and its breakdown adds to it",
        wrong.length === 0 ? `${checked} lines, column sums to the figure in every one` : wrong.join('; ').slice(0, 130))
    }

    // X25d — every CELL of the equity matrix, the Total column included.
    const eqX = (await renderEquityChanges(L, span2.toPeriodId, span2.fromPeriodId))!
    {
      let checked = 0
      const wrong: string[] = []
      for (const row of eqX.rows) {
        for (let c = 0; c < row.shown.length; c++) {
          const b = await breakdown(L, { kind: 'equity-cell', row: row.code, col: String(c), from, to })
          if (!b) { wrong.push(`${row.code}/${c}: no breakdown`); continue }
          checked++
          if (b.total.amount !== row.shown[c]) wrong.push(`${row.code}/${c}: total ${b.total.amount} != ${row.shown[c]}`)
          else if (lastColumnSum(b) !== row.shown[c]) wrong.push(`${row.code}/${c}: rows sum ${lastColumnSum(b)} != ${row.shown[c]}`)
        }
      }
      check(checked > 0 && wrong.length === 0,
        'X25d every changes-in-equity cell opens, and its breakdown adds to it',
        wrong.length === 0 ? `${checked} cells across ${eqX.rows.length} rows` : wrong.join('; ').slice(0, 130))
    }

    // X25e — a row code that names no row must answer NOTHING rather than the
    //        first row that happens to be there. Rows worth nothing are left
    //        out of the render, which is why cells are addressed by code.
    const bGone = await breakdown(L, { kind: 'equity-cell', row: 'NOT_A_ROW', col: '0', from, to })
    const bWideCol = await breakdown(L, {
      kind: 'equity-cell', row: eqX.rows[0].code, col: String(eqX.rows[0].shown.length), from, to })
    check(bGone === null && bWideCol === null,
      'X25e a cell that is not on the statement has no breakdown',
      `unknown row -> ${bGone === null ? 'null' : 'a page'}; column past the last -> ${bWideCol === null ? 'null' : 'a page'}`)

    // ---------------------------- account numbers on the printed page (2026-09-15) --
    //
    // "所有report都没有account number给读者做reference，这个要改". The trial
    // balance and the general ledger have printed a code column all along; the
    // statements printed none at all, so a reader holding a PDF had no way
    // back to the chart. The screen and the page share one function, and this
    // is the check that they have not come apart.
    {
      const blocks = cashFlowBlocks(cfX)
      const table = blocks.find((b) => b.kind === 'table')!
      const printed = table.kind === 'table' ? table.rows : []
      const wrong: string[] = []
      let named = 0
      for (const l of cfX.lines) {
        if (l.lineType === 'header' || l.lineType === 'spacer') continue
        const wanted = accountReference(l.accounts, 4)
        if (!wanted) continue
        named++
        const cell = printed.find((row) => String(row.cells[0]).startsWith(l.label))
        if (!cell) { wrong.push(`${l.label}: not printed`); continue }
        if (!String(cell.cells[0]).includes(wanted)) {
          wrong.push(`${l.label}: printed "${String(cell.cells[0])}" without "${wanted}"`)
        }
      }
      check(named > 0 && wrong.length === 0,
        'X25f the printed cash flow names the accounts behind every figure',
        wrong.length === 0 ? `${named} lines carry their codes, the same ones the screen shows` : wrong.join('; ').slice(0, 130))
    }
    {
      const blocks = equityChangesBlocks(eqX)
      const table = blocks.find((b) => b.kind === 'table')!
      const printed = table.kind === 'table' ? table.rows : []
      const wrong: string[] = []
      let named = 0
      for (const [i, row] of eqX.rows.entries()) {
        const wanted = accountReference(row.accounts[row.accounts.length - 1], 4)
        if (!wanted) continue
        named++
        if (!String(printed[i]?.cells[0] ?? '').includes(wanted)) {
          wrong.push(`${row.label}: printed "${String(printed[i]?.cells[0] ?? '')}" without "${wanted}"`)
        }
      }
      check(named > 0 && wrong.length === 0,
        'X25g the printed changes in equity names the accounts behind every row',
        wrong.length === 0 ? `${named} rows carry their codes` : wrong.join('; ').slice(0, 130))
    }

    // X26 — the account breakdown behind every trial balance figure IS the
    // general ledger's account: same closing, and its own opening row plus
    // the entry rows reach it (the reader's arithmetic re-done from the cells).
    const wrongAccounts: string[] = []
    for (const r of tb2) {
      const b = await breakdown(L, { kind: 'account', account: r.id, from, to })
      if (!b) { wrongAccounts.push(`${r.code}: no breakdown`); continue }
      if (b.total.amount !== BigInt(r.balance)) {
        wrongAccounts.push(`${r.code}: total ${b.total.amount} != ${r.balance}`); continue
      }
      const opening = b.rows[0].cells.find((c) => 'money' in c)
      const walked = b.rows.slice(1).filter((row) => !row.bold).reduce((s, row) => {
        const debit = row.cells[4], credit = row.cells[5]
        return s + ('money' in debit ? debit.money : 0n) - ('money' in credit ? credit.money : 0n)
      }, opening && 'money' in opening ? opening.money : 0n)
      if (walked !== b.total.amount) wrongAccounts.push(`${r.code}: opening+rows ${walked} != ${b.total.amount}`)
    }
    check(tb2.length > 0 && wrongAccounts.length === 0,
      'X26 every trial balance figure opens into opening + rows = closing',
      wrongAccounts.length === 0 ? `${tb2.length} accounts` : wrongAccounts.join('; ').slice(0, 120))

    // An account the range never touched still answers, with an explained zero.
    const bZero = await breakdown(L, { kind: 'account', account: id['3100'], from, to })
    check(!!bZero && bZero.total.amount === 0n && bZero.rows.length === 2,
      'X26b an untouched account breaks down to an explained zero',
      bZero ? `${bZero.rows.length} rows, closing ${formatMoney(bZero.total.amount)}` : 'no breakdown')

    // X27 — every aging cell, both axes, against the matrix: the breakdown
    // filters entries in TypeScript (bucketOf/ageOf) while the matrix buckets
    // in SQL. The boundaries agreeing cell by cell is the point.
    const ag = await aging(L, 'trade_receivables', asOf)
    const wrongCells: string[] = []
    for (const row of ag.rows) {
      for (let i = 0; i < BUCKETS.length; i++) {
        if (row.buckets[i] === 0n) continue
        const b = await breakdown(L, {
          kind: 'aging', role: 'trade_receivables', asOf, party: row.party_id, bucket: String(i) })
        if (!b || b.total.amount !== row.buckets[i]) {
          wrongCells.push(`${row.party_name}/${BUCKETS[i].label}: ${b?.total.amount} != ${row.buckets[i]}`)
        }
      }
      const bRow = await breakdown(L, { kind: 'aging', role: 'trade_receivables', asOf, party: row.party_id })
      if (!bRow || bRow.total.amount !== row.total) wrongCells.push(`${row.party_name}/total`)
    }
    for (let i = 0; i < BUCKETS.length; i++) {
      if (ag.totals[i] === 0n) continue
      const b = await breakdown(L, { kind: 'aging', role: 'trade_receivables', asOf, bucket: String(i) })
      if (!b || b.total.amount !== ag.totals[i]) wrongCells.push(`column ${BUCKETS[i].label}`)
    }
    // The two figures this fixture pins: 75 days old lands in 61–90, 11 days
    // in 0–30. A boundary shifted one day moves one of them next door.
    const b6190 = await breakdown(L, {
      kind: 'aging', role: 'trade_receivables', asOf, party: customer.id, bucket: '3' })
    const b030 = await breakdown(L, {
      kind: 'aging', role: 'trade_receivables', asOf, party: customer.id, bucket: '1' })
    check(ag.rows.length > 0 && wrongCells.length === 0
          && b6190?.total.amount === parseMoney('800.00') && b030?.total.amount === parseMoney('300.00'),
      'X27 every aging cell opens into rows that sum to it',
      wrongCells.length === 0
        ? `${ag.rows.length} parties, 61–90 ${formatMoney(b6190?.total.amount ?? 0n)}, 0–30 ${formatMoney(b030?.total.amount ?? 0n)}`
        : wrongCells.join('; ').slice(0, 120))

    // X27b — the figure owed by NOBODY has its own door, and it opens.
    const bNone = await breakdown(L, { kind: 'aging', role: 'trade_receivables', asOf, party: 'none' })
    check(!!bNone && bNone.total.amount === ag.unattributed && ag.unattributed === parseMoney('5650.00'),
      'X27b the unattributed figure breaks down to its entries',
      `${formatMoney(bNone?.total.amount ?? 0n)} with no party named`)

    // X28 — the GST/HST lines: the breakdown total is the figure on the
    // return, and the contribution column adds to it.
    const gst = (await gstHstReturn(L, from, to))!
    const wrongTax: string[] = []
    for (const [lineNo, taxLine] of [['101', gst.lines.sales], ['105', gst.lines.collected], ['108', gst.lines.itcs]] as const) {
      const b = await breakdown(L, { kind: 'tax', line: lineNo, from, to })
      if (!b || b.total.amount !== taxLine.amount || lastColumnSum(b) !== taxLine.amount) {
        wrongTax.push(`line ${lineNo}: ${b?.total.amount} vs ${taxLine.amount}`)
      }
    }
    check(wrongTax.length === 0 && gst.lines.collected.amount === parseMoney('650.00'),
      'X28 every GST line breaks down to entries that sum to it',
      wrongTax.length === 0 ? `line 105 ${formatMoney(gst.lines.collected.amount)} traced` : wrongTax.join('; '))

    // X29 — the CSV exit carries the same rows, read back the way a
    // spreadsheet would read them, and the reader can redo the arithmetic.
    const cashCsv = await breakdownCsv(L, { kind: 'account', account: id['1000'], from, to })
    const cashRows = cashCsv ? parseCsv(cashCsv.csv) : []
    const glCash = (await generalLedger(L, span2, { accountId: id['1000'] }))[0]
    const closingRow = cashRows.find((r) => r[2] === 'Closing balance')
    const openingRow = cashRows.find((r) => r[2] === 'Opening balance')
    const walkedCsv = cashRows
      .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0] ?? ''))
      .reduce((s, r) => s + parseMoney(r[4] || '0') - parseMoney(r[5] || '0'),
              parseMoney(openingRow?.[6] || '0'))
    check(!!closingRow && closingRow[6] === csvMoney(glCash.closing)
          && walkedCsv === glCash.closing && cashRows[0][1].startsWith('1000 —'),
      'X29 the breakdown CSV re-adds to the figure that was clicked',
      closingRow ? `opening + rows = ${closingRow[6]}` : 'no closing row in the file')

    // X32 — the by-party browse pages tie to the trial balance: the sum of
    //        every browse row equals the movement of every account of that
    //        type over the same range. Two readers (journal grouped by entry
    //        vs the balance cache), one answer — a browse that quietly
    //        dropped an entry or double-counted a line would still LOOK
    //        perfectly grouped.
    for (const [t, label] of [['expense', 'expenses'], ['revenue', 'income']] as const) {
      const browse = await entriesByParty(L, t, from, to)
      const browseSum = browse.reduce((s2, r) => s2 + BigInt(r.amount), 0n)
      // The expected side reads the JOURNAL flat, with the browse's own
      // exclusions. It was period_balance movement first — and a year-end
      // close zeroes the P&L inside period_balance while the browse rightly
      // hides the closing entry, so any span crossing a close made the two
      // readers disagree with CORRECT code (critic, 2026-09-03). Flat sum vs
      // per-entry grouping is still two shapes of one question.
      const [movement] = await db.execute<{ m: string }>(raw`
        SELECT COALESCE(SUM(jl.amount), 0)::text AS m
          FROM journal_entry je
          JOIN journal_line jl ON jl.entry_id = je.id
          JOIN account a ON a.id = jl.account_id
         WHERE je.ledger_id = ${L}
           AND je.status IN ('posted', 'reversed')
           AND je.source_type NOT IN ('opening_balance', 'period_close')
           AND je.entry_date BETWEEN ${from} AND ${to}
           AND a.account_type = ${t}::account_type`)
      check(browse.length > 0 && browseSum === BigInt(movement.m),
        `X32 the ${label} browse adds to the journal's own sum`,
        `${browse.length} entries, ${formatMoney(browseSum)} both ways`)
    }

    // X30 — the PDF exit, read back independently: the title, a pinned row,
    // the total. The 61–90 cell because its rows crossed the bucket logic.
    const agingPdfBuilt = await breakdownPdf(L, {
      kind: 'aging', role: 'trade_receivables', asOf, party: customer.id, bucket: '3' })
    const agingPdfText = agingPdfBuilt ? pdfText(agingPdfBuilt.buffer) : ''
    const cashPdfBuilt = await breakdownPdf(L, { kind: 'account', account: id['1000'], from, to })
    const cashPdfText = cashPdfBuilt ? pdfText(cashPdfBuilt.buffer) : ''
    check(agingPdfText.includes('Drill Down Ltd.') && agingPdfText.includes(formatMoney(parseMoney('800.00')))
          && agingPdfText.includes('January invoice')
          && cashPdfText.includes('Opening balance') && cashPdfText.includes('Closing balance')
          && cashPdfText.includes(formatMoney(glCash.closing)),
      'X30 the breakdown PDFs carry the rows and the figure',
      `aging cell ${formatMoney(parseMoney('800.00'))}; cash closing ${formatMoney(glCash.closing)}`)

    // X31 — a POSITION explains itself from the start of the books. With no
    // `from`, the account breakdown must open at ZERO and list every posted
    // line up to `to` — "today's balance is 20,000; show me how it got there"
    // — and its closing must still be the trial balance's own figure.
    const bAll = await breakdown(L, { kind: 'account', account: id['1200'], to })
    const bAllOpening = bAll?.rows[0].cells.find((c) => 'money' in c)
    const bAllDates = bAll?.rows.filter((r) => r.cells.some((c) => 'text' in c && /^\d{4}-\d{2}-\d{2}$/.test(c.text))).length ?? 0
    const arClosing = BigInt(tb2.find((r) => r.code === '1200')!.balance)
    // The detail prints the OBSERVED opening: a FAIL line that says
    // "opening 0.00" while asserting the opening was zero is a diagnostic
    // that lies about the very thing it failed on (critic, 2026-09-02).
    const bAllOpeningShown = bAllOpening && 'money' in bAllOpening ? formatMoney(bAllOpening.money) : '?'
    check(!!bAll && bAllOpening !== undefined && 'money' in bAllOpening! && bAllOpening!.money === 0n
          && bAllDates === 3 && bAll!.total.amount === arClosing,
      'X31 a balance with no from opens at zero and shows its whole history',
      bAll ? `opening ${bAllOpeningShown}, ${bAllDates} rows, closing ${formatMoney(bAll.total.amount)}` : 'no breakdown')

    // X31b — the closed loop, over a MID-year window so range-from and
    // books-from actually differ: render the SFP over Feb–Mar, take the
    // receivables account row's own drill address, feed it back into
    // breakdown(), and the result must open at zero — not at February's
    // opening, which would silently hide January's 800.00.
    const midFrom = `${yr}-02-01`
    const midSpan = await spanFor(L, midFrom, to)
    const midSfp = (await renderStatement(L, 'IFRS_SFP_EN', midSpan!.toPeriodId, midSpan!.fromPeriodId))!
    const arLineIndex = midSfp.lines.findIndex((l) => l.accounts?.some((a) => a.code === '1200'))
    const bArLine = await breakdown(L, {
      kind: 'statement-line', template: 'IFRS_SFP_EN', line: String(arLineIndex), from: midFrom, to })
    const arHref = bArLine?.rows.find((r) => r.cells.some((c) => 'text' in c && c.text === '1200'))?.href
    const arParams = arHref ? Object.fromEntries(new URL('http://x' + arHref).searchParams) : null
    const bViaHref = arParams ? await breakdown(L, arParams) : null
    const viaOpening = bViaHref?.rows[0].cells.find((c) => 'money' in c)
    const viaOpeningShown = viaOpening && 'money' in viaOpening ? formatMoney(viaOpening.money) : '?'
    check(!!bViaHref && viaOpening !== undefined && 'money' in viaOpening! && viaOpening!.money === 0n
          && bViaHref!.total.amount === arClosing,
      'X31b a statement position row drills to a zero opening, not a window',
      arHref ? `${arHref.split('?')[1]} -> opening ${viaOpeningShown}, closing ${formatMoney(bViaHref?.total.amount ?? 0n)}` : 'no href found')
  }

  // X33 — the other side's number. An entry with no invoice behind it IS the
  //       document, so it carries the number itself and the browse shows it.
  //       And it has exactly one home: the database refuses a second copy on
  //       an entry an invoice raised, where `invoice.their_ref` already holds
  //       it. Last in the file, after X32 has added up the browse — a new
  //       entry inside that range would move both sides of that sum at once
  //       and prove nothing while looking fine.
  //
  //       What the second half is and is not: NO application door can reach
  //       that refusal today — every writer of documentRef posts under a
  //       source the CHECK permits, and amendEntry can only inherit a NULL
  //       from an invoice-raised original. It is an invariant test, kept
  //       because the day a door DOES set both, this is what stops the
  //       second copy rather than discovering it later in a disagreement
  //       (critic, 2026-09-03: say which of the two it is).
  {
    const day = `${yr}-03-22`
    const receipt = await postEntry({
      ledgerId: L, entryDate: day, description: 'Toner, paid in cash', actor: 'alicio@example.test',
      documentRef: 'R-4021',
      lines: [
        { accountId: id['5000'], amount: parseMoney('40.00') },
        { accountId: id['1000'], amount: -parseMoney('40.00') },
      ],
    })
    const browsed = await entriesByParty(L, 'expense', day, day)

    // Guarded: a check that throws kills the run and records nothing, so the
    // refusal is caught and read rather than allowed to escape.
    let refusal = 'nothing was refused'
    try {
      await postEntry({
        ledgerId: L, entryDate: day, description: 'A bill that also keeps its own number',
        actor: 'alicio@example.test', sourceType: 'ap_bill', documentRef: 'DOUBLE-HOME',
        lines: [
          { accountId: id['5000'], amount: parseMoney('10.00') },
          { accountId: id['1000'], amount: -parseMoney('10.00') },
        ],
      })
    } catch (e) {
      // The constraint's name is in the CAUSE, not in the message drizzle
      // throws: its outer line is "Failed query: insert into …", which names
      // no rule and would let this check pass on any refusal at all.
      const chain: string[] = []
      for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
        const err = cur as { message?: string; constraint_name?: string; cause?: unknown }
        if (err.constraint_name) chain.push(err.constraint_name)
        if (err.message) chain.push(err.message)
        cur = err.cause
      }
      // And the detail prints the line that carries the RULE, so a failure
      // here names what was actually refused instead of the query text.
      // Not just "mentions the column": the failed query text names every
      // column of the insert, this one included, so matching on that would
      // report the SQL as the rule and pass on any refusal at all.
      refusal = chain.find((m) => !m.startsWith('Failed query') && m.includes('document_ref'))
        ?? chain[chain.length - 1] ?? 'nothing was refused'
    }
    check(browsed.length === 1 && browsed[0].doc_ref === 'R-4021'
          && refusal.includes('document_ref_has_one_home'),
      'X33 an entry that is its own document carries its own number, once',
      `browse doc_ref ${browsed[0]?.doc_ref ?? 'none'}; second home refused by ${refusal.split('\n')[0].slice(0, 60)}`)

    // X33b — and a blank is not a number. `documentRefFrom` trims it away at
    // every door, so this asks the DATABASE the question the doors are
    // trusted to have already answered: the shape CHECK, by name.
    let blankRefusal = 'nothing was refused'
    try {
      await postEntry({
        ledgerId: L, entryDate: day, description: 'A number made of spaces',
        actor: 'alicio@example.test', documentRef: '   ',
        lines: [
          { accountId: id['5000'], amount: parseMoney('1.00') },
          { accountId: id['1000'], amount: -parseMoney('1.00') },
        ],
      })
    } catch (e) {
      const chain: string[] = []
      for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
        const err = cur as { message?: string; constraint_name?: string; cause?: unknown }
        if (err.constraint_name) chain.push(err.constraint_name)
        if (err.message) chain.push(err.message)
        cur = err.cause
      }
      blankRefusal = chain.find((m) => !m.startsWith('Failed query') && m.includes('document_ref'))
        ?? chain[chain.length - 1] ?? 'nothing was refused'
    }
    check(blankRefusal.includes('document_ref_shape'),
      'X33b a number made of spaces is refused by the shape rule',
      blankRefusal.split('\n')[0].slice(0, 70))

    // X34 — correcting an entry can correct the number on its paper. The
    //       amend door INHERITS the original's ref (a corrected receipt is
    //       still that receipt), and the header the person submitted
    //       overrides it — the form shows an editable box on the Correct
    //       panel, and a box whose value is thrown away is worse than no box
    //       (critic, 2026-09-03: it accepted the edit and re-posted the old
    //       number in silence). Read through `entryHeaderFrom`, which is the
    //       reader the action itself uses — a check cannot call the action.
    {
      const typed = new FormData()
      typed.set('entryDate', day)
      typed.set('description', 'Toner, paid in cash')
      typed.set('documentRef', '  R-4022  ')
      const amended = await amendEntry(receipt.entry.id, {
        ...entryHeaderFrom(typed),
        actor: 'alicio@example.test',
        lines: [
          { accountId: id['5000'], amount: parseMoney('40.00') },
          { accountId: id['1000'], amount: -parseMoney('40.00') },
        ],
      }, 'alicio@example.test')
      const [after] = await db.execute<{ ref: string | null }>(raw`
        SELECT document_ref AS ref FROM journal_entry WHERE id = ${amended.replacement.id}::uuid`)
      // And the reversal carries the ORIGINAL's number: the two halves of one
      // receipt must not read as one numbered and one anonymous.
      const [rev] = await db.execute<{ ref: string | null }>(raw`
        SELECT document_ref AS ref FROM journal_entry WHERE id = ${amended.reversal.id}::uuid`)
      check(after?.ref === 'R-4022' && rev?.ref === 'R-4021',
        'X34 correcting an entry corrects the number on its paper',
        `replacement ${after?.ref ?? 'null'}, reversal ${rev?.ref ?? 'null'}`)
    }
  }

  // ------------------------------------------------------------ Excel ----

  // The owner asked for a formatted workbook instead of a CSV (2026-09-04).
  // Same blocks as the PDF, read back with the library that wrote them: the
  // figures must be NUMBERS in an accounting format, the header bold, the
  // total bold and ruled, and the total the model's total — a sheet that
  // holds "1,234.56" as text is a picture of the PDF, not a spreadsheet.
  {
    const ExcelJS = (await import('exceljs')).default
    const built = await trialBalancePdf(L, span!, 'xlsx')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(built.buffer as unknown as ArrayBuffer)
    const ws = wb.worksheets[0]
    const rowsOf = () => { const out: Array<ReturnType<typeof ws.getRow>> = []; ws.eachRow((r) => out.push(r)); return out }
    const header = rowsOf().find((r) => String(r.getCell(1).value) === 'Code' && String(r.getCell(2).value) === 'Account')
    const totalRow = rowsOf().find((r) => String(r.getCell(2).value) === 'Total')
    const model = await trialBalanceSpan(L, span!.fromPeriodId, span!.toPeriodId)
    const debit = model.reduce((t, r) => t + BigInt(r.debit), 0n)
    const debitCell = totalRow?.getCell(3)
    const shown = typeof debitCell?.value === 'number' ? Math.round(debitCell.value * 100) : null
    built.format === 'xlsx' && built.filename.endsWith('.xlsx')
      && header?.getCell(1).font?.bold === true && header.getCell(1).border?.bottom?.style === 'thin'
      && shown === Number(debit) && debitCell?.numFmt === '#,##0.00;(#,##0.00);"-"'
      && totalRow?.getCell(2).font?.bold === true && totalRow.getCell(3).border?.top?.style === 'thin'
      && ws.views?.[0]?.state === 'frozen'
      ? pass('X40 the trial-balance workbook: numbers in accounting format, bold header, ruled total, frozen header',
          `total debit ${debitCell?.value} = model ${Number(debit) / 100}; ${ws.rowCount} rows`)
      : fail('X40 the trial-balance workbook: numbers in accounting format, bold header, ruled total, frozen header',
          `format ${built.format}, header bold ${header?.getCell(1).font?.bold}, total cell ${JSON.stringify(debitCell?.value)} fmt ${debitCell?.numFmt}, model ${debit}, ruled ${totalRow?.getCell(3).border?.top?.style}`)

    // A statement's workbook carries its lines with their indent, and the
    // total line's number equals what the render shows.
    const stBuilt = (await statementPdf(L, 'IFRS_PL_NATURE_EN', span!, null, 'xlsx'))!
    const st = (await renderStatement(L, 'IFRS_PL_NATURE_EN', span!.toPeriodId, span!.fromPeriodId))!
    const wb2 = new ExcelJS.Workbook(); await wb2.xlsx.load(stBuilt.buffer as unknown as ArrayBuffer)
    const ws2 = wb2.worksheets[0]
    const lastTotal = [...st.lines].reverse().find((l) => l.lineType === 'total')!
    let found: ReturnType<typeof ws2.getRow> | undefined
    ws2.eachRow((r) => { if (String(r.getCell(1).value) === lastTotal.label) found = r })
    const v = found?.getCell(2).value
    typeof v === 'number' && Math.round(v * 100) === Number(lastTotal.shown) && found?.getCell(2).font?.bold === true
      ? pass('X41 the statement workbook prints each total as the number the render shows', `${lastTotal.label} = ${v}`)
      : fail('X41 the statement workbook prints each total as the number the render shows', `${lastTotal.label}: ${JSON.stringify(v)} vs ${lastTotal.shown}`)

    // The row-grid exit: the journal's header row is recognised and bold,
    // the sheet is frozen under it, and a money cell is a number.
    const { rowsXlsx } = await import('../src/lib/excel')
    const journal = await journalCsv(L)
    const wb3 = new ExcelJS.Workbook(); await wb3.xlsx.load((await rowsXlsx('journal', journal.rows)) as unknown as ArrayBuffer)
    const ws3 = wb3.worksheets[0]
    const hdr = ws3.getRow(3)
    const firstMoney = (() => { for (let i = 4; i <= ws3.rowCount; i++) for (let c = 1; c <= 10; c++) { const x = ws3.getRow(i).getCell(c); if (typeof x.value === 'number') return x } return null })()
    String(hdr.getCell(1).value) === 'Date' && hdr.getCell(1).font?.bold === true
      && ws3.views?.[0]?.state === 'frozen' && (ws3.views?.[0] as { ySplit?: number } | undefined)?.ySplit === 3
      && firstMoney !== null && firstMoney.numFmt === '#,##0.00;(#,##0.00);"-"'
      ? pass('X42 the journal workbook: header found, bold and frozen; money as numbers', `${ws3.rowCount} rows`)
      : fail('X42 the journal workbook: header found, bold and frozen; money as numbers',
          `header ${hdr.getCell(1).value} bold ${hdr.getCell(1).font?.bold}, frozen ${JSON.stringify(ws3.views?.[0])}, money ${firstMoney?.numFmt}`)
  }

  // ------------------------------------------------------------ X43 ----
  // The response itself: a PDF leaves INLINE (every Download PDF link targets
  // a tab) and a workbook as an attachment, each with its own type and
  // extension. The Excel node shipped both as attachments for a day and every
  // Download PDF — eleven routes — opened a blank tab and dropped a file
  // (critic, 2026-09-04). No check had ever called pdfResponse.
  {
    const a = pdfResponse(await trialBalancePdf(L, span!))
    const b = pdfResponse(await trialBalancePdf(L, span!, 'xlsx'))
    const disp = (r: Response) => r.headers.get('content-disposition') ?? ''
    const ok = a.headers.get('content-type') === 'application/pdf'
      && disp(a).startsWith('inline;') && disp(a).includes('.pdf"')
      && b.headers.get('content-type') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      && disp(b).startsWith('attachment;') && disp(b).includes('.xlsx"')
    ;(ok ? pass : fail)('X43 a PDF leaves inline and a workbook as an attachment, each with its own type and extension',
      `${disp(a)} · ${disp(b)}`)
  }

  // ------------------------------------------------------------ X44 ----
  // EVERY Excel exit builds a real workbook — not only the two X40/X41 read.
  // Each is opened with the library that wrote it and must hold a sheet with
  // rows in it; an exit that throws or writes an empty sheet is named.
  {
    const ExcelJS = (await import('exceljs')).default
    const { rowsXlsx } = await import('../src/lib/excel')
    const from = `${yr}-01-01`, to = `${yr}-03-31`
    // Parties are not per company; any one will do — a statement with nothing
    // on it is still a workbook with its heading, its header and its total.
    const [party] = await db.execute<{ id: string }>(raw`
      SELECT id::text FROM party ORDER BY created_at LIMIT 1`)
    const exits: Array<[string, () => Promise<Buffer | null>]> = [
      ['aging', async () => (await agingPdf(L, to, 'xlsx')).buffer],
      ['general-ledger', async () => (await generalLedgerPdf(L, span!, 'xlsx')).buffer],
      ['gst-hst', async () => (await taxReturnPdf(L, from, to, 'GST_HST', false, 'xlsx'))?.buffer ?? null],
      ['pst', async () => (await taxReturnPdf(L, from, to, 'PST', false, 'xlsx'))?.buffer ?? null],
      ['breakdown', async () => (await breakdownPdf(L, { kind: 'account', account: id['1000'], from, to }, 'xlsx'))?.buffer ?? null],
      ['customer-statement', async () => party ? (await customerStatementPdf(L, party.id, to, 'xlsx')).buffer : null],
      ['account-history', async () => rowsXlsx('account', (await accountLedgerCsv(L, id['1000'], { from, to })).rows)],
      ['pd7a', async () => rowsXlsx('pd7a', (await pd7aCsv(L, yr))!.rows)],
    ]
    const wrong: string[] = []
    for (const [name, build] of exits) {
      try {
        const buffer = await build()
        if (!buffer) { wrong.push(`${name}: nothing built`); continue }
        const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as unknown as ArrayBuffer)
        const ws = wb.worksheets[0]
        if (!ws || ws.rowCount < 3) wrong.push(`${name}: ${ws ? `${ws.rowCount} rows` : 'no sheet'}`)
      } catch (e) { wrong.push(`${name}: ${String(e).slice(0, 90)}`) }
    }
    ;(wrong.length === 0 ? pass : fail)('X44 every Excel exit builds a workbook with a sheet and rows in it',
      wrong.join('; ') || `${exits.length} exits: ${exits.map(([n]) => n).join(', ')}`)
  }

  // ------------------------------------------------------------ X45 ----
  // The tax workbook carries what the CSV it replaced carried: every line's
  // entries under a "Line NNN — …" heading with a Total under each. And the
  // row grid tells a count from a figure BY COLUMN: the PD7A's runs are not
  // "2.00", and an entry number shaped like money stays text (critic).
  {
    const ExcelJS = (await import('exceljs')).default
    const { rowsXlsx, MONEY_FORMAT } = await import('../src/lib/excel')
    const from = `${yr}-01-01`, to = `${yr}-03-31`
    const ret = (await gstHstReturn(L, from, to))!
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await taxReturnPdf(L, from, to, 'GST_HST', false, 'xlsx'))!.buffer as unknown as ArrayBuffer)
    const ws = wb.worksheets[0]
    const column = (n: number) => { const out: string[] = []; ws.eachRow((r) => out.push(String(r.getCell(n).value ?? ''))); return out }
    const withEntries = Object.values(ret.lines).filter((l) => l !== ret.lines.net && l.entries.length > 0)
    const headings = column(1).filter((v) => /^Line \d+ — /.test(v))
    const totals = column(4).filter((v) => v === 'Total').length
    // Entry rows under the lines AND under the review items that name entries
    // — the CSV carried both; the same entry can appear in each.
    const reviewEntries = ret.review.flatMap((r) => r.entries ?? [])
    const entryNos = new Set([...withEntries.flatMap((l) => l.entries), ...reviewEntries].map((e) => e.entryNo))
    const entryRows = column(2).filter((v) => entryNos.has(v)).length
    const expectedRows = withEntries.reduce((n, l) => n + l.entries.length, 0) + reviewEntries.length

    const wb2 = new ExcelJS.Workbook()
    await wb2.xlsx.load((await rowsXlsx('t', [
      ['Co', 'Test'], [],
      ['Entry', 'Runs', 'Amount'],
      ['JE-1', 2, '1,000.00'],
      ['1000.00', 0, '(12.50)'],
      [], ['Total', '', '987.50'],
    ])) as unknown as ArrayBuffer)
    const s = wb2.worksheets[0]
    const runs = s.getRow(4).getCell(2), code = s.getRow(5).getCell(1), amt = s.getRow(5).getCell(3)
    const countsOk = runs.value === 2 && runs.numFmt !== MONEY_FORMAT
      && code.value === '1000.00' && amt.value === -12.5 && amt.numFmt === MONEY_FORMAT
    const ok = withEntries.length > 0 && headings.length === withEntries.length
      && totals === withEntries.length && entryRows === expectedRows && countsOk
    ;(ok ? pass : fail)('X45 the tax workbook carries every line\'s entries with a total; a count stays a count, a code stays text',
      ok ? `${headings.length} lines, ${entryRows} entry rows; runs=${runs.value} (${runs.numFmt ?? 'plain'}), code "${code.value}", amount ${amt.value}`
         : `lines with entries ${withEntries.length}, headings ${headings.length}, totals ${totals}, entry rows ${entryRows}/${expectedRows}; `
           + `runs=${JSON.stringify(runs.value)} fmt ${runs.numFmt}, code ${JSON.stringify(code.value)}, amount ${JSON.stringify(amt.value)} fmt ${amt.numFmt}`)
  }

  // ------------------------------------------------------------ X46 ----
  // The two statements that are not templates leave by the same door as the
  // templates: `statementPdf` branches on the code and hands the same blocks
  // to the PDF and the workbook.
  {
    const wrong: string[] = []
    for (const code of ['CASH_FLOW', 'EQUITY_CHANGES'] as const) {
      const pdf = await statementPdf(L, code, span!, null, 'pdf')
      const xl = await statementPdf(L, code, span!, null, 'xlsx')
      if (!pdf || pdf.buffer.subarray(0, 4).toString() !== '%PDF') wrong.push(`${code} pdf: ${pdf ? 'not a PDF' : 'null'}`)
      if (!xl || xl.buffer.subarray(0, 2).toString() !== 'PK') wrong.push(`${code} xlsx: ${xl ? 'not a workbook' : 'null'}`)
      if (pdf && !pdf.filename.includes(code.toLowerCase().replace('_', '-'))) wrong.push(`${code} filename ${pdf.filename}`)
      if (xl && !xl.filename.endsWith('.xlsx')) wrong.push(`${code} workbook filename ${xl.filename}`)
      if (xl) {
        const ExcelJS = (await import('exceljs')).default
        const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xl.buffer as never)
        const ws = wb.worksheets[0]
        if (!ws || ws.rowCount < 5) wrong.push(`${code} workbook has ${ws?.rowCount ?? 0} rows`)
      }
    }
    ;(wrong.length === 0 ? pass : fail)('X46 the cash flow and equity statements leave as a PDF and as a workbook through the statement door',
      wrong.join('; ') || 'CASH_FLOW and EQUITY_CHANGES: a PDF and a workbook each, named after the statement')
  }

  // ------------------------------------------------------- X47-X49 ----
  // THE STATEMENT CUT INTO COLUMNS LEAVES THE SAME WAY (owner, 2026-09-12:
  // 「屏幕 + 导出一起」). The export takes `by` and lays out one column per
  // group and then the whole span, from `renderColumned` — the function the
  // screen calls — and nothing here adds a figure up on its own.
  //
  // What can go wrong is specific to the file: thirteen money columns on an
  // upright letter page are thirty points each, so the sheet TURNS at more
  // than five; and a turned sheet is shorter, so the page break must be
  // measured against the sheet in hand and not the upright one. Both are read
  // off the PDF itself — the page box, and where the text was drawn.
  {
    const ExcelJS = (await import('exceljs')).default
    const year = await spanFor(L, `${yr}-01-01`, `${yr}-12-31`)
    const quarter = await spanFor(L, `${yr}-01-01`, `${yr}-03-31`)
    // The fixture's year is the calendar year, and a fiscal month is named
    // YYYY-MM — spelled here, not read back from the period rows.
    const monthNames = Array.from({ length: 12 }, (_, i) => `${yr}-${String(i + 1).padStart(2, '0')}`)
    // The shape `formatMoney` writes into a statement export: a leading minus,
    // never parentheses (those are the screen's accounting sign).
    const asMoney = (t: string) => /^-?[\d,]+\.\d\d$/.test(t)
    const cents = (t: string) => {
      const [whole, frac] = t.replace(/[-,]/g, '').split('.')
      const v = BigInt(whole!) * 100n + BigInt(frac!)
      return t.startsWith('-') ? -v : v
    }
    /** The run of money cells drawn right after a label — a row of the table. */
    const rowAfter = (text: string, label: string) => {
      const lines = text.split('\n')
      const at = lines.lastIndexOf(label)
      if (at < 0) return null
      const run: string[] = []
      for (let i = at + 1; i < lines.length && asMoney(lines[i]!); i++) run.push(lines[i]!)
      return run
    }
    const box = (buf: Buffer) => [...new Set([...buf.toString('latin1').matchAll(/\/MediaBox \[([^\]]+)\]/g)].map((m) => m[1]))]
    const pagesOf = (buf: Buffer) => (buf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length
    /** How far above the bottom edge the lowest line of the TABLE was drawn —
     *  the footer lives in the margin by design and is left out. */
    const deepestText = (buf: Buffer) =>
      Math.min(...pdfTextAt(buf).filter((t) => !/^Generated |^Page \d+ of \d+$/.test(t.text)).map((t) => t.y))

    if (!year || !quarter) {
      fail('X47 a year by month leaves as a turned sheet with twelve columns and a total', 'no span resolved')
    } else {
      // X47 — twelve months and a total on a P&L, the total being the sum of
      // the twelve, on a page that has turned; three months by month, upright.
      const pl = await renderStatement(L, 'IFRS_PL_NATURE_EN', year.toPeriodId, year.fromPeriodId)
      const lastTotal = [...(pl?.lines ?? [])].reverse().find((l) => l.lineType === 'total')
      const wide = await statementPdf(L, 'IFRS_PL_NATURE_EN', year, null, 'pdf', 'month')
      const narrow = await statementPdf(L, 'IFRS_PL_NATURE_EN', quarter, null, 'pdf', 'month')
      const wideText = wide ? pdfText(wide.buffer) : ''
      const months = monthNames.map((m) => m.toUpperCase())
      const heads = months.filter((m) => wideText.split('\n').includes(m))
      const run = lastTotal ? rowAfter(wideText, lastTotal.label) : null
      const twelve = run && run.length === 13 ? run.slice(0, 12).reduce((t, c) => t + cents(c), 0n) : null
      const adds = run !== null && run.length === 13
        && twelve === cents(run[12]!) && cents(run[12]!) === lastTotal!.shown
      const bothBoxes = box(wide?.buffer ?? Buffer.alloc(0)).join() === '0 0 792 612'
        && box(narrow?.buffer ?? Buffer.alloc(0)).join() === '0 0 612 792'
      // And asked to break one fiscal month into months: the plain single
      // column, its total line followed by ONE figure, no heading over it,
      // and the sentence saying why on the sheet.
      const oneMonth = await spanFor(L, `${yr}-03-01`, `${yr}-03-31`)
      const flat = oneMonth ? await statementPdf(L, 'IFRS_PL_NATURE_EN', oneMonth, null, 'pdf', 'month') : null
      const flatText = flat ? pdfText(flat.buffer) : ''
      const flatRun = lastTotal ? rowAfter(flatText, lastTotal.label) : null
      const flatSaysWhy = flatText.includes('one fiscal month')
      const flatHeadings = flatText.split('\n').filter((l) => l === 'TOTAL' || l === 'CLOSING').length
      check(heads.length === 12 && wideText.split('\n').includes('TOTAL') && adds && bothBoxes
        && flatRun !== null && flatRun.length === 1 && flatHeadings === 0 && flatSaysWhy,
        'X47 a year by month leaves as a turned sheet with twelve columns and a total',
        `${heads.length} month heading(s) and ${wideText.split('\n').includes('TOTAL') ? 'TOTAL' : 'no TOTAL'}; `
          + `“${lastTotal?.label}” is followed by ${run?.length ?? 'no'} figure(s)`
          + `${run && run.length === 13 ? `, the twelve summing to ${formatMoney(twelve!)} against a thirteenth of ${run[12]} and the render's ${formatMoney(lastTotal!.shown)}` : ''}; `
          + `page box ${box(wide?.buffer ?? Buffer.alloc(0)).join(' / ') || 'none'} for thirteen columns, `
          + `${box(narrow?.buffer ?? Buffer.alloc(0)).join(' / ') || 'none'} for four; one month by month: `
          + `${flatRun?.length ?? 'no'} figure(s) after the total line, ${flatHeadings} TOTAL/CLOSING heading(s), `
          + `${flatSaysWhy ? 'and it says why' : 'and NO reason on the sheet'}`)

      // X48 — AND THE TURNED SHEET IS SHORTER. A balance sheet by month runs
      // past one page, and every line of it must be drawn above the turned
      // sheet's bottom margin: a break measured against the upright height
      // puts rows a hundred points below the paper's edge, and nothing
      // reports it because the writer does not know where the paper ends.
      const sfp = await statementPdf(L, 'IFRS_SFP_EN', year, null, 'pdf', 'month')
      const sfpText = sfp ? pdfText(sfp.buffer) : ''
      const deepest = sfp ? deepestText(sfp.buffer) : NaN
      const pages = sfp ? pagesOf(sfp.buffer) : 0
      const closing = sfpText.split('\n').includes('CLOSING')
      const noted = sfpText.includes('Each column is the balance at that date')
      // The sheet's own box is read here too: the height the bottom margin is
      // measured from is only meaningful on the sheet this file actually has.
      const sfpBox = box(sfp?.buffer ?? Buffer.alloc(0)).join()
      check(pages >= 2 && sfpBox === '0 0 792 612' && deepest >= 72 && closing && noted,
        'X48 a turned balance sheet breaks pages against its own shorter edge and says why the columns do not add',
        `${pages} page(s) boxed ${sfpBox || 'nowhere'}; the lowest table line sits ${Number.isFinite(deepest) ? deepest.toFixed(1) : 'nowhere'}pt `
          + `above the bottom edge, against a 72pt margin; last column ${closing ? 'CLOSING' : 'NOT called closing'}; `
          + `the note ${noted ? 'is on the sheet' : 'is MISSING'}`)

      // X49 — the workbook: a quarter head per quarter and the total in the
      // sixth cell being the sum of the four, as numbers; the sheet upright
      // at five columns and turned at thirteen; and when both a comparison
      // and a breakdown are asked for, the breakdown alone is what leaves —
      // exactly the three months and their total after the total line, not
      // the comparison's three figures and not seven.
      const xq = await statementPdf(L, 'IFRS_PL_NATURE_EN', year, null, 'xlsx', 'quarter')
      const xm = await statementPdf(L, 'IFRS_PL_NATURE_EN', year, null, 'xlsx', 'month')
      const wq = new ExcelJS.Workbook(); if (xq) await wq.xlsx.load(xq.buffer as never)
      const wm = new ExcelJS.Workbook(); if (xm) await wm.xlsx.load(xm.buffer as never)
      const wsq = wq.worksheets[0], wsm = wm.worksheets[0]
      let header: string[] = []
      let summed = 0, unsummed = 0
      wsq?.eachRow((r) => {
        const vals = [1, 2, 3, 4, 5, 6].map((c) => r.getCell(c).value)
        if (vals[5] === 'Total' && header.length === 0) header = vals.slice(1).map(String)
        if (vals.slice(1).every((v) => typeof v === 'number')) {
          const nums = vals.slice(1) as number[]
          Math.round(nums.slice(0, 4).reduce((t, n) => t + n, 0) * 100) === Math.round(nums[4]! * 100) ? summed++ : unsummed++
        }
      })
      const quarters = groupLabels(monthNames.map((name) => ({ name })), 3)
      const headRight = header.join('|') === [...quarters, 'Total'].join('|')
      const orient = `${wsq?.pageSetup.orientation ?? '?'}/${wsm?.pageSetup.orientation ?? '?'}`
      const both = await statementPdf(L, 'IFRS_PL_NATURE_EN', quarter, 'prior', 'pdf', 'month')
      const bothRun = both && lastTotal ? rowAfter(pdfText(both.buffer), lastTotal.label) : null
      check(headRight && summed > 0 && unsummed === 0 && orient === 'portrait/landscape'
        && bothRun !== null && bothRun.length === 4,
        'X49 the workbook carries the quarters and their total as numbers, turns when wide, and a breakdown beats a comparison',
        `header ${header.join(' | ') || '(none)'}; ${summed} row(s) whose total is the sum of four, ${unsummed} not; `
          + `orientation by quarter/by month ${orient}; asked for both, the total line is followed by `
          + `${bothRun?.length ?? 'no'} figure(s)`)
    }
  }

  // ------------------------------------------------------------ X50 ----
  // THE TABLE ITSELF, with no ledger under it: a fourteen-column sheet holding
  // the widest things a statement column can hold. PDFKit wraps anything
  // given a width, by character once a word is too long, and X48 first failed
  // on exactly that — "CLOSING" left as "CLOSIN" and a "G" under it. A figure
  // treated that way is a different figure, so a money cell is placed by hand
  // and never broken; a heading wraps at its spaces and the rows start below
  // the tallest one. Read off where each string was DRAWN, not just that it
  // was.
  {
    const heads = ['', ...Array.from({ length: 12 }, (_, i) => `${yr}-${String(i + 1).padStart(2, '0')}`), 'Closing']
    const columns = heads.map((label, i) => (i === 0 ? { label, weight: 3 } : { label, align: 'right' as const, weight: 1.1 }))
    const big = '-1,234,567.89'
    const wide = await reportPdf({ company: 'Co', title: 'Probe', landscape: true }, [{
      kind: 'table', columns,
      rows: [{ cells: ['Cash and cash equivalents', ...columns.slice(1).map(() => big)] }],
    }])
    const narrow = await reportPdf({ company: 'Co', title: 'Probe' }, [{
      kind: 'table',
      columns: [{ label: '', weight: 3 }, ...groupLabels(Array.from({ length: 12 }, (_, i) => ({ name: `${yr}-${String(i + 1).padStart(2, '0')}` })), 3)
        .map((label) => ({ label, align: 'right' as const, weight: 1.1 })), { label: 'Total', align: 'right' as const, weight: 1.1 }],
      rows: [{ cells: ['Revenue', '1.00', '2.00', '3.00', '4.00', '10.00'] }],
    }])
    const wideAt = pdfTextAt(wide)
    const drawn = wideAt.filter((t) => t.text === big)
    const figures = drawn.length
    // Set small enough to fit: fourteen columns leave a money column under
    // forty points, and a six-figure amount at the ordinary 8.5pt (42pt for
    // 123,456.78) is wider than that — whole but lying across its neighbour.
    // At 7pt it is not, so the size the figures were drawn at is read as well.
    // The probe figure is the shape the export writes, a leading minus.
    const small = drawn.every((t) => t.size <= 7)
    const closingWhole = wideAt.some((t) => t.text === 'CLOSING')
    const narrowAt = pdfTextAt(narrow)
    // The quarter heading has a space to wrap at, so it becomes two lines —
    // and the data row is drawn below the second of them, not through it.
    const secondLine = narrowAt.find((t) => t.text === `${yr}-03`)
    const firstLine = narrowAt.find((t) => t.text.trim() === `${yr}-01 –`)
    const revenue = narrowAt.find((t) => t.text === 'Revenue')
    // `y` is measured up from the bottom edge: lower on the page is smaller.
    // The row must clear the second heading line by a whole line of 7pt
    // type (6.5pt), not merely start under its baseline — a header row given
    // its one-line height puts the row 4pt under the wrapped line, through it.
    const gap = secondLine && revenue ? secondLine.y - revenue.y : NaN
    const below = !!firstLine && !!secondLine && !!revenue
      && secondLine.y < firstLine.y && gap >= 8
    check(figures === 13 && small && closingWhole && below,
      'X50 a figure is never broken across lines, and a heading that wraps pushes the rows down',
      `${figures} of 13 wide figures drawn whole at ${[...new Set(drawn.map((t) => t.size))].join('/') || '?'}pt; `
        + `the last heading is ${closingWhole ? 'CLOSING, whole' : 'NOT drawn whole'}; `
        + `a quarter heading drawn as “${firstLine?.text.trim() ?? '?'}” ${firstLine?.y.toFixed(1) ?? '?'}pt up over `
        + `“${secondLine?.text ?? '?'}” at ${secondLine?.y.toFixed(1) ?? '?'}, and the row ${Number.isFinite(gap) ? gap.toFixed(1) : '?'}pt under that`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })
