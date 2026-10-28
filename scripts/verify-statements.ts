/**
 * Financial statements: the balance sheet and the two income statement formats.
 *   npm run db:verify-statements   (resets the database first)
 *
 * The failure mode here is a statement that is WRONG and still BALANCES: a
 * figure reaching no statement line is absent from both sides. Every check
 * below therefore compares the statement against the ledger, not against
 * itself.
 */
import './env'
import { reporter } from './suite'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear, createFiscalYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv, setAccountRoles } from '../src/lib/accounts'
import { closeFiscalYear, postEntry, PostingError, reopenFiscalYear, reverseEntry, unclosedYears } from '../src/lib/posting'
import { CASH_ROLES, CF_DEFAULT, renderCashFlow } from '../src/lib/cash-flow'
import { renderEquityChanges } from '../src/lib/equity-changes'
import { evaluateFormula, renderStatement } from '../src/lib/statements'
import { rebuildLedgerBalances, resolvePeriodSpan, trialBalanceSpan } from '../src/lib/balances'
import { renderColumned } from '../src/lib/columns'
import { parseMoney } from '../src/lib/money'

const r = reporter(52)
const { pass, fail, check } = r
const money = (c: bigint) => (Number(c) / 100).toFixed(2)

const CHART = `1000,Cash — Operating,asset,,cash_and_cash_equivalents
1200,Accounts Receivable,asset,,trade_receivables
1500,Equipment,asset,,property_plant_equipment
1510,Accumulated depreciation,asset,,accumulated_depreciation_ppe,contra
2000,Accounts Payable,liability,,trade_payables
2100,GST/HST Payable,liability,,gst_hst_payable
3000,Share Capital,equity,,share_capital
3100,Retained Earnings,equity,,retained_earnings
4000,Consulting Revenue,revenue,,revenue_from_contracts
5000,Salaries,expense,,employee_benefits_expense fn_administrative_expenses
5100,Professional Fees,expense,,professional_fees fn_administrative_expenses
5200,Depreciation,expense,,depreciation_expense fn_administrative_expenses`

async function main() {
  const co = await createCompanyWithYear({ code: 'ACME', name: 'Acme Consulting Inc.' }, 'alicio@example.test')
  const L = co.ledger.id
  const accts = await importAccounts(co.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))
  const yr = Number(co.year.endDate.slice(0, 4))

  const post = (date: string, description: string, lines: Array<[string, string, boolean]>) =>
    postEntry({
      ledgerId: L, entryDate: date, description, actor: 'alicio@example.test',
      lines: lines.map(([code, amount, isDebit]) => ({
        accountId: id[code],
        amount: isDebit ? parseMoney(amount) : -parseMoney(amount),
      })),
    })

  await post(`${yr}-01-15`, 'Share capital', [['1000', '50000.00', true], ['3000', '50000.00', false]])
  await post(`${yr}-02-01`, 'Bought equipment', [['1500', '12000.00', true], ['1000', '12000.00', false]])
  await post(`${yr}-03-10`, 'Invoice 1001', [
    ['1200', '22600.00', true], ['4000', '20000.00', false], ['2100', '2600.00', false]])
  await post(`${yr}-03-31`, 'Salaries', [['5000', '8000.00', true], ['1000', '8000.00', false]])
  await post(`${yr}-03-31`, 'Accountant', [['5100', '1500.00', true], ['2000', '1500.00', false]])
  await post(`${yr}-03-31`, 'Depreciation', [['5200', '1000.00', true], ['1510', '1000.00', false]])

  // By id and by year: period_no repeats, and this fixture grows a second year.
  const [march] = await db.execute<{ id: string }>(raw`
    SELECT fp.id::text FROM fiscal_period fp
      JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
     WHERE fp.ledger_id = ${L} AND fp.period_no = 3 AND fy.id = ${co.year.id}`)

  // ---------------------------------------------------------------- balance --
  const bs = (await renderStatement(L, 'IFRS_SFP_EN', march.id))!
  const line = (code: string) => bs.lines.find((l) => l.code === code)

  bs.problems.length === 0
    ? pass('T1 the balance sheet reports no problems', `${bs.lines.length} lines`)
    : fail('T1 the balance sheet reports no problems', bs.problems.join(' | '))

  const ta = line('TA')!.raw
  const tle = line('TLE')!.raw
  ta + tle === 0n
    ? pass('T2 assets equal liabilities and equity',
           `assets ${money(ta)}, other side ${money(-tle)}`)
    : fail('T2 assets equal liabilities and equity', `off by ${money(ta + tle)}`)

  // T3 — the figures are the ledger's, not something the statement invented
  const [cashLedger] = await db.execute<{ balance: string }>(raw`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS balance
      FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
     WHERE je.ledger_id = ${L} AND je.status IN ('posted','reversed')
       AND jl.account_id = ${id['1000']}::uuid`)
  line('A_CASH')!.raw === BigInt(cashLedger.balance)
    ? pass('T3 a detail line equals the ledger', `cash ${money(line('A_CASH')!.raw)}`)
    : fail('T3 a detail line equals the ledger',
           `statement ${line('A_CASH')!.raw} vs ledger ${cashLedger.balance}`)

  // T4 — a contra account nets against its parent rather than being added
  const ppe = line('A_PPE')!.raw
  ppe === parseMoney('11000.00')
    ? pass('T4 a contra account nets against its line', `12,000 cost less 1,000 depreciation = ${money(ppe)}`)
    : fail('T4 a contra account nets against its line', money(ppe))

  // T5 — THE ONE THE DESIGN EXISTS FOR. Mid-year, the profit has not been closed
  //      into retained earnings, so without the current-earnings line the sheet
  //      cannot balance.
  const earnings = line('E_CYE')!.raw
  const [plLedger] = await db.execute<{ amount: string }>(raw`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS amount
      FROM journal_line jl
      JOIN journal_entry je ON je.id = jl.entry_id
      JOIN account a ON a.id = jl.account_id
     WHERE je.ledger_id = ${L} AND je.status IN ('posted','reversed')
       AND a.account_type IN ('revenue','expense')`)
  earnings === BigInt(plLedger.amount) && earnings !== 0n
    ? pass('T5 the current-earnings line carries the year\'s result',
           `${money(-earnings)} profit, not yet in retained earnings`)
    : fail('T5 the current-earnings line carries the year\'s result',
           `statement ${earnings} vs ledger ${plLedger.amount}`)

  // T6 — remove it and the sheet stops balancing. Proof that T2 depends on it.
  const withoutEarnings = ta + (tle - earnings)
  withoutEarnings !== 0n
    ? pass('T6 without that line the sheet would not balance', `it would be out by ${money(withoutEarnings)}`)
    : fail('T6 without that line the sheet would not balance', 'removing it changed nothing')

  // ----------------------------------------------------------------- income --
  const pl = (await renderStatement(L, 'IFRS_PL_NATURE_EN', march.id))!
  const plLine = (code: string) => pl.lines.find((l) => l.code === code)

  // T7 — a P&L reports the period's movement, not a balance carried forward
  const revenue = plLine('P_REV')!.raw
  const [marchRevenue] = await db.execute<{ amount: string }>(raw`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS amount
      FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
     WHERE je.ledger_id = ${L} AND je.status IN ('posted','reversed')
       AND jl.account_id = ${id['4000']}::uuid AND je.period_id = ${march.id}::uuid`)
  revenue === BigInt(marchRevenue.amount)
    ? pass('T7 the income statement shows the period, not the total', `March revenue ${money(-revenue)}`)
    : fail('T7 the income statement shows the period, not the total',
           `statement ${revenue} vs March ${marchRevenue.amount}`)

  // T8 — profit for the period agrees with the ledger for that period
  const profit = plLine('PFY')!.raw
  const [marchProfit] = await db.execute<{ amount: string }>(raw`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS amount
      FROM journal_line jl
      JOIN journal_entry je ON je.id = jl.entry_id
      JOIN account a ON a.id = jl.account_id
     WHERE je.ledger_id = ${L} AND je.status IN ('posted','reversed')
       AND a.account_type IN ('revenue','expense') AND je.period_id = ${march.id}::uuid`)
  profit === BigInt(marchProfit.amount)
    ? pass('T8 profit for the period equals the ledger', `${money(-profit)}`)
    : fail('T8 profit for the period equals the ledger', `statement ${profit} vs ledger ${marchProfit.amount}`)

  // T9 — the same ledger read two ways reaches the same profit
  const byFunction = (await renderStatement(L, 'IFRS_PL_FUNCTION_EN', march.id))!
  byFunction.lines.find((l) => l.code === 'FPFY')!.raw === profit
    ? pass('T9 by nature and by function agree', `both ${money(-profit)}`)
    : fail('T9 by nature and by function agree',
           `nature ${profit} vs function ${byFunction.lines.find((l) => l.code === 'FPFY')!.raw}`)

  // T10 — sign_flip changes what is shown and never what is computed
  const revLine = plLine('P_REV')!
  revLine.raw < 0n && revLine.shown > 0n && revLine.shown === -revLine.raw
    ? pass('T10 sign_flip is presentation only', `raw ${revLine.raw}, shown ${money(revLine.shown)}`)
    : fail('T10 sign_flip is presentation only', JSON.stringify({ raw: revLine.raw, shown: revLine.shown }))

  // --------------------------------------------------------------- silence ---
  // T11 — one untagged account, posted against a tagged one. The sheet goes out
  //        of balance by exactly that amount, and BOTH facts are reported.
  const orphan = await importAccounts(co.company.id, [{
    entityId: co.company.id, code: '1900', name: 'Suspense', accountType: 'asset',
  }], 'alicio@example.test')
  id['1900'] = orphan[0].id
  await post(`${yr}-03-31`, 'Into suspense', [['1900', '250.00', true], ['1000', '250.00', false]])

  const oneSided = (await renderStatement(L, 'IFRS_SFP_EN', march.id))!
  const off = oneSided.lines.find((l) => l.code === 'TA')!.raw
            + oneSided.lines.find((l) => l.code === 'TLE')!.raw
  oneSided.problems.some((p) => p.includes('1900'))
    && oneSided.problems.some((p) => p.includes('does not balance'))
    && (off < 0n ? -off : off) === parseMoney('250.00')
    ? pass('T11 one untagged side puts the sheet out by that amount',
           `named 1900, and out by ${money(off < 0n ? -off : off)}`)
    : fail('T11 one untagged side puts the sheet out by that amount',
           JSON.stringify({ off: off.toString(), problems: oneSided.problems }))

  // T12 — THE DANGEROUS ONE. Both sides untagged: the sheet balances perfectly
  //       and the figures are still missing. Nothing about the totals can show
  //       this, which is why the untagged report has to exist at all.
  const pair = await importAccounts(co.company.id, [
    { entityId: co.company.id, code: '1910', name: 'Holding A', accountType: 'asset' },
    { entityId: co.company.id, code: '2910', name: 'Holding B', accountType: 'liability' },
  ], 'alicio@example.test')
  id['1910'] = pair[0].id
  id['2910'] = pair[1].id
  await setAccountRoles(orphan[0].id, ['other_receivables'], 'alicio@example.test')   // clear T11's imbalance
  await post(`${yr}-03-31`, 'Both sides untagged', [['1910', '9999.00', true], ['2910', '9999.00', false]])

  const bothSides = (await renderStatement(L, 'IFRS_SFP_EN', march.id))!
  const stillOff = bothSides.lines.find((l) => l.code === 'TA')!.raw
                 + bothSides.lines.find((l) => l.code === 'TLE')!.raw
  stillOff === 0n
    && bothSides.problems.some((p) => p.includes('1910') && p.includes('2910'))
    && !bothSides.problems.some((p) => p.includes('does not balance'))
    ? pass('T12 both sides untagged: balanced AND wrong, reported anyway',
           '9,999.00 missing from a sheet that balances perfectly')
    : fail('T12 both sides untagged: balanced AND wrong, reported anyway',
           JSON.stringify({ off: stillOff.toString(), problems: bothSides.problems }))

  // T13 — tagging them clears it, so T12 was the tags and not something else
  await setAccountRoles(pair[0].id, ['other_receivables'], 'alicio@example.test')
  await setAccountRoles(pair[1].id, ['other_current_liabilities'], 'alicio@example.test')
  const fixed = (await renderStatement(L, 'IFRS_SFP_EN', march.id))!
  const fixedAssets = fixed.lines.find((l) => l.code === 'A_AR')!.raw
  fixed.problems.length === 0 && fixedAssets > oneSided.lines.find((l) => l.code === 'A_AR')!.raw
    ? pass('T13 tagging them brings the figures onto the sheet',
           `receivables now ${money(fixedAssets)}, no problems reported`)
    : fail('T13 tagging them brings the figures onto the sheet',
           JSON.stringify({ problems: fixed.problems, receivables: fixedAssets.toString() }))

  // ---------------------------------------------------------------- formula --
  const vals = new Map<string, bigint>([['A', 100n], ['B', 30n], ['C', 7n]])
  const cases: Array<[string, string]> = [
    ['A+B', '130'], ['A-B', '70'], ['A+B-C', '123'], ['A', '100'],
  ]
  const wrong = cases.find(([f, want]) => {
    const r = evaluateFormula(f, vals)
    return 'error' in r || r.value.toString() !== want
  })
  !wrong
    ? pass('T14 formulas add and subtract line codes', cases.map(([f, v]) => `${f}=${v}`).join(' '))
    : fail('T14 formulas add and subtract line codes', JSON.stringify(wrong))

  // T14 — an unknown code is an ERROR, never zero: treating it as zero would
  //       drop a subtotal out of a statement that still balanced.
  const bad = [
    evaluateFormula('A+MISSING', vals),
    evaluateFormula('A++B', vals),
    evaluateFormula('A+', vals),
    evaluateFormula('', vals),
    evaluateFormula('A*B', vals),
  ]
  bad.every((r) => 'error' in r)
    ? pass('T15 a formula that cannot be computed is an error',
           'unknown code, double operator, trailing operator, empty, unsupported symbol')
    : fail('T15 a formula that cannot be computed is an error',
           JSON.stringify(bad.map((r) => ('error' in r ? r.error : r.value.toString()))))

  // T15 — and the renderer surfaces it rather than showing a wrong figure
  await db.execute(raw`
    UPDATE statement_line SET formula = 'CA+NOT_A_LINE'
     WHERE code = 'TA' AND template_id = (SELECT id FROM statement_template WHERE code='IFRS_SFP_EN')`)
  const broken = (await renderStatement(L, 'IFRS_SFP_EN', march.id))!
  broken.problems.some((p) => p.includes('NOT_A_LINE'))
    ? pass('T16 a broken template is reported to the reader', broken.problems[0].slice(0, 70))
    : fail('T16 a broken template is reported to the reader', JSON.stringify(broken.problems))
  await db.execute(raw`
    UPDATE statement_line SET formula = 'CA+NCA'
     WHERE code = 'TA' AND template_id = (SELECT id FROM statement_template WHERE code='IFRS_SFP_EN')`)

  // =========================================================== second year ==
  // T17-T22 cover what a second fiscal year does. Every one of these was found
  // by review, not by me: the balance sheet for a second year showed a fraction
  // of the ledger, balanced perfectly, and reported nothing wrong.

  const y2 = await createFiscalYear(L, `${yr + 1}-12-31`, 'alicio@example.test')
  const [feb2] = await db.execute<{ id: string }>(raw`
    SELECT fp.id::text FROM fiscal_period fp
     WHERE fp.fiscal_year_id = ${y2.year.id} AND fp.period_no = 2`)
  await post(`${yr + 1}-02-10`, 'Second year revenue', [
    ['1200', '7000.00', true], ['4000', '7000.00', false]])

  // T17 — the new year's periods must carry the balances brought forward.
  //       Creating a year used to leave them with no rows at all, and every
  //       figure on the statement read zero.
  const sheet2 = (await renderStatement(L, 'IFRS_SFP_EN', feb2.id))!
  const [cashAtY2] = await db.execute<{ balance: string }>(raw`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS balance
      FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
      JOIN fiscal_period fp ON fp.id = je.period_id
     WHERE je.ledger_id = ${L} AND je.status IN ('posted','reversed')
       AND jl.account_id = ${id['1000']}::uuid AND fp.end_date <= (
         SELECT end_date FROM fiscal_period WHERE id = ${feb2.id}::uuid)`)
  sheet2.lines.find((l) => l.code === 'A_CASH')!.raw === BigInt(cashAtY2.balance)
    && BigInt(cashAtY2.balance) !== 0n
    ? pass('T17 a new fiscal year carries the balances forward',
           `cash ${money(BigInt(cashAtY2.balance))} in year two, not 0.00`)
    : fail('T17 a new fiscal year carries the balances forward',
           `statement ${sheet2.lines.find((l) => l.code === 'A_CASH')!.raw} vs ledger ${cashAtY2.balance}`)

  // T18 — and the unclosed prior year is REPORTED, with the reason. Without a
  //       closing entry the sheet is out by exactly the earlier year's result.
  const off2 = sheet2.lines.find((l) => l.code === 'TA')!.raw
             + sheet2.lines.find((l) => l.code === 'TLE')!.raw
  const explained = sheet2.problems.some((p) =>
    p.includes('does not balance') && p.includes('has not been closed into retained earnings'))
  off2 !== 0n && explained
    ? pass('T18 an unclosed prior year is named as the reason',
           `out by ${money(off2 < 0n ? -off2 : off2)}, and the statement says why`)
    : fail('T18 an unclosed prior year is named as the reason',
           JSON.stringify({ off: off2.toString(), problems: sheet2.problems }))

  // T19 — the amount it is out by IS the prior year's result
  const outstanding = await unclosedYears(L)
  const priorResult = outstanding.find((y) => y.name === co.year.name)
  priorResult && BigInt(priorResult.result) === -off2
    ? pass("T19 the difference is exactly the prior year's result",
           `${co.year.name} result ${money(-BigInt(priorResult.result))}`)
    : fail("T19 the difference is exactly the prior year's result",
           JSON.stringify({ off: off2.toString(), outstanding }))

  // T20 — closing the year fixes it. This is the accounting operation that was
  //       missing entirely, not a rendering adjustment.
  const closed = await closeFiscalYear(L, co.year.id, 'alicio@example.test')
  const sheet3 = (await renderStatement(L, 'IFRS_SFP_EN', feb2.id))!
  const off3 = sheet3.lines.find((l) => l.code === 'TA')!.raw
             + sheet3.lines.find((l) => l.code === 'TLE')!.raw
  off3 === 0n && sheet3.problems.length === 0
    ? pass('T20 closing the year makes it balance',
           `${closed.entry.entryNo} closed ${closed.accountsClosed} accounts, result ${money(-closed.result)}`)
    : fail('T20 closing the year makes it balance',
           JSON.stringify({ off: off3.toString(), problems: sheet3.problems }))

  // T21 — the result landed in retained earnings, and the P&L accounts are flat
  const [re] = await db.execute<{ balance: string }>(raw`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS balance
      FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
     WHERE je.ledger_id = ${L} AND je.status IN ('posted','reversed')
       AND jl.account_id = ${id['3100']}::uuid`)
  const [priorPl] = await db.execute<{ balance: string }>(raw`
    SELECT COALESCE(SUM(jl.amount), 0)::text AS balance
      FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
      JOIN account a ON a.id = jl.account_id
      JOIN fiscal_period fp ON fp.id = je.period_id
     WHERE je.ledger_id = ${L} AND je.status IN ('posted','reversed')
       AND a.account_type IN ('revenue','expense')
       AND fp.fiscal_year_id = ${co.year.id}::uuid`)
  BigInt(re.balance) === closed.result && BigInt(priorPl.balance) === 0n
    ? pass('T21 the result is in retained earnings, the year is flat',
           `retained earnings ${money(-BigInt(re.balance))}, prior-year P&L 0.00`)
    : fail('T21 the result is in retained earnings, the year is flat',
           JSON.stringify({ re: re.balance, priorPl: priorPl.balance }))

  // T22 — a year cannot be closed twice
  try {
    await closeFiscalYear(L, co.year.id, 'alicio@example.test')
    fail('T22 a year cannot be closed twice', 'it was closed again')
  } catch (e) {
    (e as PostingError).code === 'ALREADY_CLOSED'
      ? pass('T22 a year cannot be closed twice', (e as Error).message.slice(0, 62))
      : fail('T22 a year cannot be closed twice', (e as Error).message)
  }

  // T23 — a stale balance cache is reported, because both sides of a statement
  //       read it and a truncated cache truncates both equally
  await db.execute(raw`
    UPDATE period_balance SET closing_balance = closing_balance + 500000
     WHERE ledger_id = ${L} AND account_id = ${id['1000']}::uuid AND period_id = ${feb2.id}::uuid`)
  const stale = (await renderStatement(L, 'IFRS_SFP_EN', feb2.id))!
  stale.problems.some((p) => p.includes('no longer agrees with the journal'))
    ? pass('T23 a stale balance cache is reported', 'the figures below it may all be wrong')
    : fail('T23 a stale balance cache is reported', JSON.stringify(stale.problems))
  await db.execute(raw`SELECT rebuild_period_balances(${L}::uuid)`)

  // ============================================================= date spans ==
  // T24-T28: the same renderer over a RANGE of periods. Flow is summed across
  // the covered months; position is the end month's. The failure mode is a
  // second arithmetic: a span that disagrees with the sum of its own months.

  await post(`${yr + 1}-03-05`, 'March revenue', [
    ['1200', '3000.00', true], ['4000', '3000.00', false]])

  const p2 = async (no: number) => (await db.execute<{ id: string }>(raw`
    SELECT fp.id::text FROM fiscal_period fp
     WHERE fp.fiscal_year_id = ${y2.year.id} AND fp.period_no = ${no}`))[0]
  const [jan2, mar2] = [await p2(1), await p2(3)]

  // T24 — a span P&L is the sum of its months, read from the same renderer.
  const febPl = (await renderStatement(L, 'IFRS_PL_NATURE_EN', feb2.id))!
  const marPl = (await renderStatement(L, 'IFRS_PL_NATURE_EN', mar2.id))!
  const spanPl = (await renderStatement(L, 'IFRS_PL_NATURE_EN', mar2.id, feb2.id))!
  const rev = (st: typeof spanPl) => st.lines.find((l) => l.code === 'P_REV')!.raw
  rev(spanPl) === rev(febPl) + rev(marPl) && rev(spanPl) === -parseMoney('10000.00')
    ? pass('T24 a span P&L is the sum of its months',
           `Feb ${money(-rev(febPl))} + Mar ${money(-rev(marPl))} = ${money(-rev(spanPl))}`)
    : fail('T24 a span P&L is the sum of its months',
           JSON.stringify({ feb: rev(febPl).toString(), mar: rev(marPl).toString(), span: rev(spanPl).toString() }))

  // T25 — a span BALANCE SHEET is the end month's balance sheet: a position is
  //       a fact about a moment, and a range only chooses which moment ends it.
  const spanBs = (await renderStatement(L, 'IFRS_SFP_EN', mar2.id, jan2.id))!
  const endBs = (await renderStatement(L, 'IFRS_SFP_EN', mar2.id))!
  const bsFigures = (st: typeof spanBs) =>
    JSON.stringify(st.lines.map((l) => [l.code, l.raw.toString()]))
  bsFigures(spanBs) === bsFigures(endBs)
    ? pass('T25 a span balance sheet is the end month\'s', `${spanBs.lines.length} lines identical`)
    : fail('T25 a span balance sheet is the end month\'s', 'the two renders differ')

  // T26 — a P&L range covering a year-end close reads zero and SAYS WHY. The
  //       closing entry zeroes the year with ordinary journal lines, so "last
  //       year" on a closed year would otherwise report the year earned nothing
  //       and nothing would look wrong.
  const p1 = async (no: number) => (await db.execute<{ id: string }>(raw`
    SELECT fp.id::text FROM fiscal_period fp
      JOIN fiscal_year fy ON fy.id = fp.fiscal_year_id
     WHERE fp.ledger_id = ${L} AND fy.id = ${co.year.id} AND fp.period_no = ${no}`))[0]
  const [jan1, dec1] = [await p1(1), await p1(12)]
  const closedYearPl = (await renderStatement(L, 'IFRS_PL_NATURE_EN', dec1.id, jan1.id))!
  rev(closedYearPl) === 0n
    && closedYearPl.problems.some((p) => p.includes('year-end closing entry'))
    ? pass('T26 a range covering the close reads zero and says why',
           closedYearPl.problems.find((p) => p.includes('closing'))!.slice(0, 60))
    : fail('T26 a range covering the close reads zero and says why',
           JSON.stringify({ rev: rev(closedYearPl).toString(), problems: closedYearPl.problems }))

  // T27 — the untagged report watches MOVEMENT across the span, not just the
  //       end balance. An account whose money washes in and out inside the
  //       range ends at zero — and was invisible to a closing-balance check.
  const wash = await importAccounts(co.company.id, [{
    entityId: co.company.id, code: '1920', name: 'Wash', accountType: 'asset',
  }], 'alicio@example.test')
  id['1920'] = wash[0].id
  await post(`${yr + 1}-02-20`, 'Into wash', [['1920', '250.00', true], ['1000', '250.00', false]])
  await post(`${yr + 1}-03-20`, 'Out of wash', [['1000', '250.00', true], ['1920', '250.00', false]])

  const washSpan = (await renderStatement(L, 'IFRS_SFP_EN', mar2.id, feb2.id))!
  const washSingle = (await renderStatement(L, 'IFRS_SFP_EN', mar2.id))!
  washSpan.problems.some((p) => p.includes('1920'))
    && washSingle.problems.some((p) => p.includes('1920'))
    ? pass('T27 untagged movement is reported even at zero balance',
           'named over the span and in the single month it moved out')
    : fail('T27 untagged movement is reported even at zero balance',
           JSON.stringify({ span: washSpan.problems, single: washSingle.problems }))
  await setAccountRoles(wash[0].id, ['other_receivables'], 'alicio@example.test')

  // T28 — the span trial balance: movement summed, closing from the end month,
  //       and the resolver snaps a mid-month range outward and says so.
  const span = (await resolvePeriodSpan(L, `${yr + 1}-02-10`, `${yr + 1}-03-14`))!
  const tb = await trialBalanceSpan(L, span.fromPeriod.id, span.toPeriod.id)
  const cashRow = tb.find((r) => r.code === '1000')!
  const [cashClose] = await db.execute<{ b: string }>(raw`
    SELECT closing_balance::text AS b FROM period_balance
     WHERE ledger_id = ${L} AND account_id = ${id['1000']}::uuid
       AND period_id = ${mar2.id}::uuid`)
  const zero = tb.reduce((t, r) => t + BigInt(r.debit) - BigInt(r.credit), 0n)
  // The MAGNITUDE of a span movement, pinned to a concrete figure — critic
  // round 1 found the sum asserted only through `zero`, which any subset of
  // whole months also satisfies. Revenue moved 7,000 in Feb and 3,000 in Mar,
  // so a span that quietly reads one month cannot produce 10,000.
  const revRow = tb.find((r) => r.code === '4000')!
  span.snapped && span.fromPeriod.id === feb2.id && span.toPeriod.id === mar2.id
    && cashRow.balance === cashClose.b && zero === 0n
    && BigInt(revRow.credit) === parseMoney('10000.00')
    ? pass('T28 the span trial balance snaps, sums, and closes at the end',
           `revenue moved ${money(BigInt(revRow.credit))} over two months, cash closes ${money(BigInt(cashRow.balance))}`)
    : fail('T28 the span trial balance snaps, sums, and closes at the end',
           JSON.stringify({ snapped: span.snapped, cash: cashRow, close: cashClose.b,
                            revCredit: revRow.credit, zero: zero.toString() }))

  // ------------------------------------------------------- comparative ----

  // The comparative column (2026-09-04). Year 2's February beside year 1's:
  // the "year" comparison must equal a direct render of the earlier span, the
  // "prior" comparison must be the fiscal month just before, and the change
  // must be current minus compare on every figure.
  {
    const { renderComparative, compareDates } = await import('../src/lib/compare')
    const { resolvePeriodSpan } = await import('../src/lib/balances')
    const [feb2Dates] = await db.execute<{ start_date: string; end_date: string }>(raw`
      SELECT start_date::text, end_date::text FROM fiscal_period WHERE id = ${feb2.id}::uuid`)
    const span2 = (await resolvePeriodSpan(L, feb2Dates.start_date, feb2Dates.end_date))!
    const yearBack = (await compareDates(L, span2, 'year'))!
    const direct = (await renderStatement(L, 'IFRS_PL_NATURE_EN',
      (await resolvePeriodSpan(L, yearBack.from, yearBack.to))!.toPeriod.id))!
    const cmp = (await renderComparative(L, 'IFRS_PL_NATURE_EN', span2, 'year'))!
    const aligned = cmp.compare !== null && cmp.lines.every((l, i) =>
      l.label === direct.lines[i].label && (l.compare === null || l.compare === direct.lines[i].shown))
    const changes = cmp.lines.every((l) => l.change === null || l.change === l.current - (l.compare ?? 0n))
    aligned && changes && yearBack.from === `${yr}-02-01`
      ? pass('T29 the year comparison is the earlier span rendered directly, line for line',
          `${cmp.lines.length} lines; ${yearBack.from} to ${yearBack.to}`)
      : fail('T29 the year comparison is the earlier span rendered directly, line for line',
          `aligned ${aligned}, changes ${changes}, reason ${cmp.reason}, from ${yearBack.from}`)

    const prior = (await compareDates(L, span2, 'prior'))!
    const cmpPrior = (await renderComparative(L, 'IFRS_PL_NATURE_EN', span2, 'prior'))!
    prior.from === `${yr + 1}-01-01` && prior.to === `${yr + 1}-01-31` && cmpPrior.compare !== null
      ? pass('T30 the prior comparison is the fiscal month just before', `${prior.from} to ${prior.to}`)
      : fail('T30 the prior comparison is the fiscal month just before', `${prior.from} to ${prior.to}, reason ${cmpPrior.reason}`)

    // A span the books cannot reach back from is refused in words, not shown
    // beside a fraction of itself.
    const first = (await resolvePeriodSpan(L, `${yr}-01-01`, `${yr}-01-31`))!
    const noPrior = (await renderComparative(L, 'IFRS_PL_NATURE_EN', first, 'prior'))!
    noPrior.compare === null && !!noPrior.reason
      ? pass('T31 and a span with nothing before it says so', noPrior.reason ?? '')
      : fail('T31 and a span with nothing before it says so', `compare ${noPrior.compare !== null}`)

    // A SHORTER earlier span is refused too — the first version rendered three
    // months before a ten-month span as if they were ten, and printed the
    // difference as the change (critic). March–December of year 1 has only
    // January and February before it.
    const ten = (await resolvePeriodSpan(L, `${yr}-03-01`, `${yr}-12-31`))!
    const short = (await renderComparative(L, 'IFRS_PL_NATURE_EN', ten, 'prior'))!
    short.compare === null && /2 fiscal months come before this span, and it is 10 long/.test(short.reason ?? '')
      ? pass('T32 a shorter earlier span is refused, not shown as the whole', short.reason ?? '')
      : fail('T32 a shorter earlier span is refused, not shown as the whole', `compare ${short.compare !== null}: ${short.reason}`)
  }

  // ------------------------------------------------------------- T33–T40 --
  // The two statements the template model could not draw: cash flows and
  // changes in equity, both computed from movements (docs/design/21-cash-flow-and-equity.md).
  // On a company of their own, so the figures below are exactly the six
  // entries posted here: shares issued, equipment bought, an invoice with
  // GST, salaries and a professional fee paid or accrued, one month of
  // depreciation — and closing the year later touches nothing the earlier
  // checks were built on.
  const cfx = await createCompanyWithYear({ code: 'CFX', name: 'Cashflow Ltd.' }, 'alicio@example.test')
  const cfxAccts = await importAccounts(cfx.company.id,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: cfx.company.id })), 'alicio@example.test')
  const cid = Object.fromEntries(cfxAccts.map((a) => [a.code, a.id]))
  const cyr = Number(cfx.year.endDate.slice(0, 4))
  const CL = cfx.ledger.id
  const postC = (date: string, description: string, lines: Array<[string, string, boolean]>) =>
    postEntry({
      ledgerId: CL, entryDate: date, description, actor: 'alicio@example.test',
      lines: lines.map(([code, amount, isDebit]) => ({
        accountId: cid[code], amount: isDebit ? parseMoney(amount) : -parseMoney(amount),
      })),
    })
  await postC(`${cyr}-01-15`, 'Share capital', [['1000', '50000.00', true], ['3000', '50000.00', false]])
  await postC(`${cyr}-02-01`, 'Bought equipment', [['1500', '12000.00', true], ['1000', '12000.00', false]])
  await postC(`${cyr}-03-10`, 'Invoice 1001', [['1200', '22600.00', true], ['4000', '20000.00', false], ['2100', '2600.00', false]])
  await postC(`${cyr}-03-31`, 'Salaries', [['5000', '8000.00', true], ['1000', '8000.00', false]])
  await postC(`${cyr}-03-31`, 'Accountant', [['5100', '1500.00', true], ['2000', '1500.00', false]])
  await postC(`${cyr}-03-31`, 'Depreciation', [['5200', '1000.00', true], ['1510', '1000.00', false]])
  // T44 — the DERIVED statements say when the cache drifted, as the balance
  //       sheet does. All three read period_balance; the balance sheet asked
  //       check_balance_integrity first and the cash flow and equity statements
  //       did not, so a drifted cache warned on one screen and stayed quiet
  //       on two that show the same wrong figures. One row is put out by a
  //       cent, all three must say so, and a rebuild must clear all three.
  {
    const q1 = await resolvePeriodSpan(CL, `${cyr}-01-01`, `${cyr}-03-31`)
    await db.execute(raw`
      UPDATE period_balance SET closing_balance = closing_balance + 1
       WHERE ledger_id = ${CL}::uuid AND account_id = ${cid['1000']}::uuid AND period_id = ${q1!.toPeriod.id}::uuid`)
    const says = (ps: string[]) => ps.some((p) => p.includes('balance cache that no longer agrees'))
    const bsD = (await renderStatement(CL, 'IFRS_SFP_EN', q1!.toPeriod.id))!
    const cfD = (await renderCashFlow(CL, q1!.toPeriod.id, q1!.fromPeriod.id))!
    const eqD = (await renderEquityChanges(CL, q1!.toPeriod.id, q1!.fromPeriod.id))!
    await rebuildLedgerBalances(CL, 'alicio@example.test')
    const bsR = (await renderStatement(CL, 'IFRS_SFP_EN', q1!.toPeriod.id))!
    const cfR = (await renderCashFlow(CL, q1!.toPeriod.id, q1!.fromPeriod.id))!
    const eqR = (await renderEquityChanges(CL, q1!.toPeriod.id, q1!.fromPeriod.id))!
    const stillWarn = [bsR, cfR, eqR].filter((st) => says(st.problems)).length
    says(bsD.problems) && says(cfD.problems) && says(eqD.problems) && stillWarn === 0
      ? pass('T44 every statement says when the balance cache drifted, and stops when it is rebuilt',
             `drifted: balance sheet ${says(bsD.problems)}, cash flow ${says(cfD.problems)}, equity ${says(eqD.problems)}; after the rebuild ${stillWarn} still warn`)
      : fail('T44 every statement says when the balance cache drifted, and stops when it is rebuilt',
             `drifted: balance sheet ${says(bsD.problems)}, cash flow ${says(cfD.problems)}, equity ${says(eqD.problems)}; after the rebuild ${stillWarn} still warn`)
  }

  // T45 — the columned view asks the drift question ONCE and hands the answer
  //       to every column, and renderStatement honours a handed-in answer
  //       instead of asking again: twelve columns plus the whole span, each
  //       scanning check_balance_integrity — thirteen scans — was the
  //       whole-project audit's finding
  //       (2026-09-13). The sentinel proves the handed answer is printed as
  //       given; the null proves a handed answer suppresses the ask.
  {
    const q1 = await resolvePeriodSpan(CL, `${cyr}-01-01`, `${cyr}-03-31`)
    const sentinel = 'balance cache that no longer agrees (sentinel: handed in, not asked)'
    const told = (await renderStatement(CL, 'IFRS_SFP_EN', q1!.toPeriod.id, q1!.toPeriod.id, { drift: sentinel }))!
    await db.execute(raw`
      UPDATE period_balance SET closing_balance = closing_balance + 1
       WHERE ledger_id = ${CL}::uuid AND account_id = ${cid['1000']}::uuid AND period_id = ${q1!.toPeriod.id}::uuid`)
    const silenced = (await renderStatement(CL, 'IFRS_SFP_EN', q1!.toPeriod.id, q1!.toPeriod.id, { drift: null }))!
    const columned = (await renderColumned(CL, 'IFRS_PL_NATURE_EN', q1!, 'month'))!
    await rebuildLedgerBalances(CL, 'alicio@example.test')
    const says = (ps: string[]) => ps.some((x) => x.includes('balance cache that no longer agrees'))
    check(told.problems.includes(sentinel) && !says(silenced.problems) && says(columned.whole.problems),
      'T45 the drift answer is asked once, handed to every column, and a handed answer is honoured',
      `a sentinel handed on a clean cache: ${told.problems.includes(sentinel) ? 'printed' : 'ignored'}; `
        + `null handed on a drifted cache: ${says(silenced.problems) ? 'asked anyway' : 'quiet'}; `
        + `the columned view's one ask: ${says(columned.whole.problems) ? 'found it' : 'missed it'}`)
  }

  {
    const q1 = await resolvePeriodSpan(CL, `${cyr}-01-01`, `${cyr}-03-31`)
    const cf = (await renderCashFlow(CL, q1!.toPeriod.id, q1!.fromPeriod.id))!
    const cfLine = (code: string) => cf.lines.find((l) => l.code === code)!.raw
    const named = (label: string) => cf.lines.find((l) => l.label === label)?.raw

    // T33 — the proof line: beginning + net change = what the cash accounts hold
    const [cashNow] = await db.execute<{ balance: string }>(raw`
      SELECT COALESCE(SUM(jl.amount), 0)::text AS balance
        FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
       WHERE je.ledger_id = ${CL} AND je.status IN ('posted','reversed') AND jl.account_id = ${cid['1000']}::uuid`)
    cf.problems.length === 0 && cf.ending === BigInt(cashNow.balance) && cf.beginning + cf.netChange === cf.ending
      ? pass('T33 the cash flow statement reconciles to the cash accounts', `0 + ${money(cf.netChange)} = ${money(cf.ending)}`)
      : fail('T33 the cash flow statement reconciles to the cash accounts',
             `${cf.problems.join(' | ')} beginning ${cf.beginning} net ${cf.netChange} ending ${cf.ending} ledger ${cashNow.balance}`)

    // T34 — each activity holds what the fixture put there, with the sign of
    //       a cash effect: profit 9,500; depreciation added back 1,000; AR up
    //       22,600 (used); AP up 1,500 and GST up 2,600 (provided); equipment
    //       −12,000 investing; shares +50,000 financing.
    const expect: Array<[string, bigint]> = [
      ['CF_NI', parseMoney('9500.00')],
      ['CF_OPER', parseMoney('9500.00') + parseMoney('1000.00') - parseMoney('22600.00') + parseMoney('1500.00') + parseMoney('2600.00')],
      ['CF_INV', -parseMoney('12000.00')],
      ['CF_FIN', parseMoney('50000.00')],
    ]
    const wrong = expect.filter(([code, v]) => cfLine(code) !== v).map(([code, v]) => `${code} ${money(cfLine(code))} not ${money(v)}`)
    wrong.length === 0 && named('Accumulated depreciation') === parseMoney('1000.00') && named('Accounts Receivable') === -parseMoney('22600.00')
      ? pass('T34 operating, investing and financing each hold what the fixture put there, as cash effects',
             `operating ${money(cfLine('CF_OPER'))}, investing ${money(cfLine('CF_INV'))}, financing ${money(cfLine('CF_FIN'))}`)
      : fail('T34 operating, investing and financing each hold what the fixture put there, as cash effects',
             wrong.join('; ') || `dep ${named('Accumulated depreciation')} ar ${named('Accounts Receivable')}`)

    // T35 — an account with no cash-flow role and no classification default is
    //       named, shown under its own heading, and still counted, so the
    //       statement foots while saying what has not been decided.
    const [odd] = await importAccounts(cfx.company.id, [{ entityId: cfx.company.id, code: '1900', name: 'Mystery deposit', accountType: 'asset' }], 'alicio@example.test')
    cid['1900'] = odd.id
    await postC(`${cyr}-03-20`, 'Paid a deposit', [['1900', '700.00', true], ['1000', '700.00', false]])
    const cf2 = (await renderCashFlow(CL, q1!.toPeriod.id, q1!.fromPeriod.id))!
    const unclassified = cf2.lines.find((l) => l.code === 'CF_UNCLASSIFIED')
    cf2.problems.some((p) => p.includes('1900 Mystery deposit') && p.includes('cf_operating'))
      && unclassified?.raw === -parseMoney('700.00')
      && cf2.beginning + cf2.netChange === cf2.ending
      ? pass('T35 an account nobody has placed is named, shown apart, and still counted', `${unclassified?.raw} under Not classified`)
      : fail('T35 an account nobody has placed is named, shown apart, and still counted',
             `${cf2.problems.join(' | ')}; unclassified ${unclassified?.raw}`)
    // Tag it, and it moves where it was told to.
    await setAccountRoles(odd.id, ['cf_investing'], 'alicio@example.test')
    const cf3 = (await renderCashFlow(CL, q1!.toPeriod.id, q1!.fromPeriod.id))!
    cf3.problems.length === 0 && cf3.lines.find((l) => l.code === 'CF_INV')!.raw === -parseMoney('12700.00')
      ? pass('T36 a cash-flow tag places the account and outranks the default', `investing now ${money(cf3.lines.find((l) => l.code === 'CF_INV')!.raw)}`)
      : fail('T36 a cash-flow tag places the account and outranks the default', `${cf3.problems.join(' | ')} investing ${cf3.lines.find((l) => l.code === 'CF_INV')!.raw}`)

    // T37 — the statement of changes in equity: columns, the profit row, the proof.
    const eq = (await renderEquityChanges(CL, q1!.toPeriod.id, q1!.fromPeriod.id))!
    const col = (code: string) => eq.columns.findIndex((c) => c.code === code)
    const rowOf = (code: string) => eq.rows.find((r) => r.code === code)
    const re = col('RE'), sc = col('SC'), tot = eq.columns.length
    eq.problems.length === 0 && sc >= 0 && re >= 0
      && rowOf('PROFIT')!.shown[re] === parseMoney('9500.00')
      && rowOf('SHARES')!.shown[sc] === parseMoney('50000.00')
      && rowOf('CLOSE')!.shown[tot] === parseMoney('59500.00')
      && rowOf('OPEN')!.shown[tot] === 0n
      ? pass('T37 the statement of changes in equity shows the profit under retained earnings, the shares under share capital, and foots',
             `profit ${money(rowOf('PROFIT')!.shown[re])}, shares ${money(rowOf('SHARES')!.shown[sc])}, closing ${money(rowOf('CLOSE')!.shown[tot])}`)
      : fail('T37 the statement of changes in equity shows the profit under retained earnings, the shares under share capital, and foots',
             `${eq.problems.join(' | ')} cols ${eq.columns.map((c) => c.code).join(',')} rows ${eq.rows.map((r) => `${r.code}:${r.shown.join('/')}`).join(' ')}`)
  }

  // T38 — closing the year is a shuffle inside equity: neither statement moves.
  {
    await closeFiscalYear(CL, cfx.year.id, 'alicio@example.test')
    const year = await resolvePeriodSpan(CL, `${cyr}-01-01`, `${cyr}-12-31`)
    const cfYear = (await renderCashFlow(CL, year!.toPeriod.id, year!.fromPeriod.id))!
    const eqYear = (await renderEquityChanges(CL, year!.toPeriod.id, year!.fromPeriod.id))!
    const profit = cfYear.lines.find((l) => l.code === 'CF_NI')!.raw
    const [plYear] = await db.execute<{ amount: string }>(raw`
      SELECT COALESCE(SUM(jl.amount), 0)::text AS amount
        FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id JOIN account a ON a.id = jl.account_id
       WHERE je.ledger_id = ${CL} AND je.status IN ('posted','reversed')
         AND a.account_type IN ('revenue','expense') AND je.source_type <> 'period_close'`)
    const reCol = eqYear.columns.findIndex((c) => c.code === 'RE')
    const closeRow = eqYear.rows.find((r) => r.code === 'CLOSE')!
    const profitRow = eqYear.rows.find((r) => r.code === 'PROFIT')!
    profit === -BigInt(plYear.amount) && profit !== 0n
      && cfYear.problems.length === 0 && eqYear.problems.length === 0
      && profitRow.shown[reCol] === profit
      && !eqYear.rows.some((r) => r.code === 'OTHER_MOVES')
      && cfYear.beginning + cfYear.netChange === cfYear.ending
      ? pass('T38 closing the year moves nothing on either statement: the profit is still the profit, retained earnings has no "other" row',
             `profit ${money(profit)} on both; closing equity ${money(closeRow.shown[closeRow.shown.length - 1])}`)
      : fail('T38 closing the year moves nothing on either statement: the profit is still the profit, retained earnings has no "other" row',
             `cf profit ${profit} vs ledger ${-BigInt(plYear.amount)}; eq profit ${profitRow.shown[reCol]}; rows ${eqYear.rows.map((r) => r.code).join(',')}; ${cfYear.problems.join(' | ')} ${eqYear.problems.join(' | ')}`)

    // T38b — and reopening it (the close reversed, dated the same day) moves
    //        nothing either: the reversal is classed by what it reverses.
    const reopened = await reopenFiscalYear(CL, cfx.year.id, 'checking the statements', 'alicio@example.test')
    const cfBack = (await renderCashFlow(CL, year!.toPeriod.id, year!.fromPeriod.id))!
    const eqBack = (await renderEquityChanges(CL, year!.toPeriod.id, year!.fromPeriod.id))!
    const profitBack = cfBack.lines.find((l) => l.code === 'CF_NI')!.raw
    profitBack === profit && cfBack.problems.length === 0 && eqBack.problems.length === 0
      && eqBack.rows.find((r) => r.code === 'PROFIT')!.shown[reCol] === profit
      && !eqBack.rows.some((r) => r.code === 'OTHER_MOVES')
      ? pass('T38b and reopening it moves nothing either', `profit still ${money(profitBack)}`)
      : fail('T38b and reopening it moves nothing either',
             `profit ${profitBack} vs ${profit}; rows ${eqBack.rows.map((r) => r.code).join(',')}; ${cfBack.problems.join(' | ')} ${eqBack.problems.join(' | ')}`)

    // T38c — and reversing THAT reversal (reachable from the entry page) moves
    //        nothing either: the chain is walked to its root, not one hop.
    await reverseEntry(reopened.reversal.id, `${cyr}-12-31`, 'reversing the reopen', 'alicio@example.test')
    const cfAgain = (await renderCashFlow(CL, year!.toPeriod.id, year!.fromPeriod.id))!
    const eqAgain = (await renderEquityChanges(CL, year!.toPeriod.id, year!.fromPeriod.id))!
    const profitAgain = cfAgain.lines.find((l) => l.code === 'CF_NI')!.raw
    profitAgain === profit && cfAgain.problems.length === 0 && eqAgain.problems.length === 0
      && eqAgain.rows.find((r) => r.code === 'PROFIT')!.shown[reCol] === profit
      && !eqAgain.rows.some((r) => r.code === 'OTHER_MOVES')
      ? pass('T38c and reversing the reopen moves nothing either: the chain is walked to its root', `profit still ${money(profitAgain)}`)
      : fail('T38c and reversing the reopen moves nothing either: the chain is walked to its root',
             `profit ${profitAgain} vs ${profit}; rows ${eqAgain.rows.map((r) => r.code).join(',')}; ${cfAgain.problems.join(' | ')} ${eqAgain.problems.join(' | ')}`)

    // T39 — an opening-balance entry is beginning cash and a starting balance,
    //       not a flow and not a movement: a new company opened with cash and
    //       capital shows zero flows, beginning cash of the opening amount,
    //       and an "Opening balances entered" row in equity.
    const fresh = await createCompanyWithYear({ code: 'OPN', name: 'Opened Ltd.' }, 'alicio@example.test')
    const fa = await importAccounts(fresh.company.id, parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: fresh.company.id })), 'alicio@example.test')
    const fid = Object.fromEntries(fa.map((a) => [a.code, a.id]))
    const fy = Number(fresh.year.endDate.slice(0, 4))
    await postEntry({
      ledgerId: fresh.ledger.id, entryDate: `${fy}-01-01`, description: 'Opening balances', sourceType: 'opening_balance',
      actor: 'alicio@example.test',
      lines: [{ accountId: fid['1000'], amount: parseMoney('4000.00') }, { accountId: fid['3100'], amount: -parseMoney('4000.00') }],
    })
    await postEntry({
      ledgerId: fresh.ledger.id, entryDate: `${fy}-01-20`, description: 'Fee', actor: 'alicio@example.test',
      lines: [{ accountId: fid['1000'], amount: parseMoney('300.00') }, { accountId: fid['4000'], amount: -parseMoney('300.00') }],
    })
    const jan = await resolvePeriodSpan(fresh.ledger.id, `${fy}-01-01`, `${fy}-01-31`)
    const cfo = (await renderCashFlow(fresh.ledger.id, jan!.toPeriod.id, jan!.fromPeriod.id))!
    const eqo = (await renderEquityChanges(fresh.ledger.id, jan!.toPeriod.id, jan!.fromPeriod.id))!
    const entered = eqo.rows.find((r) => r.code === 'ENTERED')
    cfo.beginning === parseMoney('4000.00') && cfo.netChange === parseMoney('300.00') && cfo.ending === parseMoney('4300.00')
      && cfo.problems.length === 0
      && entered !== undefined && entered.shown[entered.shown.length - 1] === parseMoney('4000.00')
      && eqo.rows.find((r) => r.code === 'CLOSE')!.shown[eqo.columns.length] === parseMoney('4300.00')
      && eqo.problems.length === 0
      ? pass('T39 an opening-balance entry is beginning cash and an entered balance, never a flow',
             `beginning ${money(cfo.beginning)}, flows ${money(cfo.netChange)}, entered ${money(entered!.shown[entered!.shown.length - 1])}`)
      : fail('T39 an opening-balance entry is beginning cash and an entered balance, never a flow',
             `beginning ${cfo.beginning} net ${cfo.netChange} ending ${cfo.ending}; entered ${entered?.shown.join('/')}; ${cfo.problems.join(' | ')} ${eqo.problems.join(' | ')}`)

    // T40 — every balance-sheet classification role the taxonomy seeds has a
    //       default activity, except the two that ARE cash, so a starter chart
    //       needs no tagging before its first cash flow statement.
    const seeded = await db.execute<{ role: string }>(raw`
      SELECT code AS role FROM role_definition WHERE family = 'classification' AND category IN ('asset','liability','equity') ORDER BY code`)
    const unplaced = seeded.map((r) => r.role).filter((r) => !(CASH_ROLES as readonly string[]).includes(r) && CF_DEFAULT[r] === undefined)
    unplaced.length === 0
      ? pass('T40 every seeded balance-sheet role has a default activity, or is cash', `${seeded.length} roles`)
      : fail('T40 every seeded balance-sheet role has a default activity, or is cash', unplaced.join(', '))
  }

  // T41-T43 — THE SAME STATEMENT, CUT INTO COLUMNS.
  //
  //        By month or by quarter across a span, with the whole span at the end
  //        (owner, 2026-09-12). Nothing new computes a figure: each column is
  //        `renderStatement` over a shorter span, and that function already
  //        sums movement across a span while reading a POSITION at the end of
  //        it. So the two statements need no branch — and the arithmetic that
  //        proves it is different for each, which is what T42 is about.
  {
    const year = (await resolvePeriodSpan(L, `${yr + 1}-01-01`, `${yr + 1}-12-31`))!
    const byMonth = (await renderColumned(L, 'IFRS_PL_NATURE_EN', year, 'month'))!
    const byQuarter = (await renderColumned(L, 'IFRS_PL_NATURE_EN', year, 'quarter'))!
    const single = (await resolvePeriodSpan(L, `${yr + 1}-02-01`, `${yr + 1}-02-28`))!
    const tooShort = (await renderColumned(L, 'IFRS_PL_NATURE_EN', single, 'month'))!
    check(byMonth.columns.length === 12 && byQuarter.columns.length === 4
      && byMonth.columns[0]!.months === 1 && byQuarter.columns[0]!.months === 3
      && byQuarter.columns[0]!.from === byMonth.columns[0]!.from
      && byQuarter.columns[3]!.to === byMonth.columns[11]!.to
      && byMonth.reason === null && tooShort.columns.length === 0
      && (tooShort.reason ?? '').includes('one fiscal month'),
      'T41 a year is cut into twelve months or four quarters, edge to edge',
      `${byMonth.columns.length} monthly column(s) “${byMonth.columns[0]?.label}” … `
        + `“${byMonth.columns[11]?.label}”; ${byQuarter.columns.length} quarterly, the first `
        + `${byQuarter.columns[0]?.months} month(s) from ${byQuarter.columns[0]?.from}, the last `
        + `ending ${byQuarter.columns[3]?.to}; one month asked for columns: `
        + `${tooShort.columns.length} and “${tooShort.reason ?? 'no reason given'}”`)

    // THE TWO ARITHMETICS. On a flow statement the columns must add up to the
    // last figure; on a position one they must NOT be added, and the last
    // figure is the last column. Both are checked on every detail line rather
    // than on a total line, because a total line is itself a sum and would
    // agree with a wrong split.
    const sfp = (await renderColumned(L, 'IFRS_SFP_EN', year, 'quarter'))!
    const details = (c: typeof byQuarter) => c.lines.filter((l) => l.lineType === 'detail')
    // On the balance sheet the current-earnings line counts too: it is the one
    // line whose figure is not a plain position read (it sums the year to the
    // END period), so it is where a column could carry a quarter's profit
    // instead of the year-to-date — the branch the "no branch" claim leans on.
    const positions = (c: typeof sfp) =>
      c.lines.filter((l) => l.lineType === 'detail' || l.lineType === 'current_earnings')
    const flowAdds = details(byQuarter)
      .filter((l) => l.amounts.reduce((t, a) => t + a, 0n) !== l.total)
    const positionEnds = positions(sfp)
      .filter((l) => l.amounts[l.amounts.length - 1] !== l.total)
    // …and a position statement's columns are NOT its total, which is the
    // mistake the labels exist to prevent. At least one line must differ, or
    // the fixture is not proving anything.
    const positionMoves = positions(sfp)
      .some((l) => l.amounts.reduce((t, a) => t + a, 0n) !== l.total)
    check(byQuarter.totalIsSum && byQuarter.totalLabel === 'Total'
      && !sfp.totalIsSum && sfp.totalLabel === 'Closing'
      && details(byQuarter).length > 0 && flowAdds.length === 0
      && positionEnds.length === 0 && positionMoves,
      'T42 the columns add up on a flow statement and end on a position one',
      `profit and loss: “${byQuarter.totalLabel}”, totalIsSum ${byQuarter.totalIsSum}, `
        + `${details(byQuarter).length} detail line(s), ${flowAdds.length} that do not add up`
        + `${flowAdds.length ? `: ${flowAdds[0]!.label}` : ''}; balance sheet: `
        + `“${sfp.totalLabel}”, totalIsSum ${sfp.totalIsSum}, ${positions(sfp).length} position line(s) `
        + `(current earnings included), ${positionEnds.length} whose last column is not the closing figure`
        + `${positionEnds.length ? `: ${positionEnds[0]!.label}` : ''}, and summing them `
        + `${positionMoves ? 'gives something else, as it should' : 'HAPPENS TO AGREE — the fixture proves nothing'}`)

    // A span that does not divide by three: the short group is named by its
    // months, not called a quarter it is not.
    const five = (await resolvePeriodSpan(L, `${yr + 1}-01-01`, `${yr + 1}-05-31`))!
    const ragged = (await renderColumned(L, 'IFRS_PL_NATURE_EN', five, 'quarter'))!
    const last = ragged.columns[ragged.columns.length - 1]
    const raggedDetails = ragged.lines.filter((l) => l.lineType === 'detail')
    const raggedOff = raggedDetails.filter((l) => l.amounts.reduce((t, a) => t + a, 0n) !== l.total)
    check(ragged.columns.length === 2 && last?.months === 2
      && (last?.label ?? '').includes('–') && raggedDetails.length > 0 && raggedOff.length === 0,
      'T43 five months by quarter is three and two, and the short one says so',
      `${ragged.columns.length} column(s): `
        + `${ragged.columns.map((c) => `${c.label} (${c.months})`).join(', ')}; `
        + `${raggedOff.length} of ${raggedDetails.length} detail line(s) do not add up to the ${ragged.totalLabel.toLowerCase()}`
        + `${raggedOff.length ? `: ${raggedOff[0]!.label}` : ''}`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })
