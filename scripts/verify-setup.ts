/**
 * Company and fiscal-year creation, end to end against a real database.
 *   npm run db:verify-setup   (resets the database first)
 */
import './env'
import { trailNamesPeople } from './actor-trail'
import { expectCode, reporter } from './suite'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { sql as raw } from 'drizzle-orm'
import { byHand } from './by-hand'
import { db, sql as conn } from '../src/db/client'
import { SetupError, createCompany, createCompanyReady, createCompanyWithYear, createFiscalYear, currentYearEnd, deleteFiscalYear, planFiscalYear } from '../src/lib/setup'
import { trialBalance } from '../src/lib/balances'
import { chartOfAccounts, importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { missingRoles } from '../src/lib/needed-roles'
import { STARTER_CHART } from '../src/lib/starter-chart'
import { postEntry } from '../src/lib/posting'
import { parseMoney } from '../src/lib/money'
import {
  COMPANY_TABLES, COMPANY_RETAINED_TABLES, CompanyError, archiveCompany, companiesWithState, companyById, deleteCompany,
  unarchiveCompany,
} from '../src/lib/companies'
import { archiveCompanyFromForm, deleteCompanyFromForm, unarchiveCompanyFromForm } from '../src/lib/company-forms'
import { COMPANY_FIELDS as CF } from '../src/lib/forms'
import { causesOf } from '../src/lib/db-errors'
import { allCompanies, grantsOf, setGrants } from '../src/lib/access'
import { createUser } from '../src/lib/users'
import { createParty } from '../src/lib/parties'
import { createShareClass, issueShares, transferShares } from '../src/lib/records'

const r = reporter(50)
const { pass, fail } = r

const expectError = expectCode(r)

async function main() {
  // S1 — a company arrives with its primary ledger
  const acme = await createCompany({ code: 'acme', name: 'Acme Consulting Inc.', province: 'ON' }, 'alicio@example.test')
  acme.company.code === 'ACME' && acme.ledger.isPrimary && acme.ledger.accountingStandard === 'IFRS'
    ? pass('S1 company and primary ledger created', `${acme.company.code} / ${acme.ledger.code} / IFRS`)
    : fail('S1 company and primary ledger created', JSON.stringify(acme))

  await expectError('S2 rejects a duplicate code', 'DUPLICATE_CODE',
    () => createCompany({ code: 'ACME', name: 'Another Acme' }))
  await expectError('S3 rejects a malformed code', 'BAD_CODE',
    () => createCompany({ code: 'a b', name: 'Spaces Inc.' }))
  await expectError('S4 rejects an impossible year end', 'BAD_YEAR_END',
    () => createCompany({ code: 'FEB30', name: 'Feb 30 Inc.', fiscalYearEndMonth: 2, fiscalYearEndDay: 30 }))

  // S5 — a December year end gives calendar months
  const fy = await createFiscalYear(acme.ledger.id, '2026-12-31', 'alicio@example.test')
  const dec = await db.execute<{ name: string; start_date: string; end_date: string }>(raw`
    SELECT name, start_date::text, end_date::text FROM fiscal_period
     WHERE ledger_id = ${acme.ledger.id} ORDER BY start_date`)
  fy.periodCount === 12 && dec[0].start_date === '2026-01-01' && dec[0].end_date === '2026-01-31'
    && dec[11].start_date === '2026-12-01' && dec[11].end_date === '2026-12-31'
    ? pass('S5 December year end -> calendar months', `${fy.year.name}: ${dec[0].name} .. ${dec[11].name}`)
    : fail('S5 December year end -> calendar months', JSON.stringify(dec.slice(0, 2)))

  await expectError('S6 rejects the same fiscal year twice', 'DUPLICATE_YEAR',
    () => createFiscalYear(acme.ledger.id, '2026-12-31'))

  // S7 — a 30 June year end runs July to June, and is named for the closing year
  const beta = await createCompany({ code: 'BETA', name: 'Beta Holdings Inc.', province: 'BC',
    fiscalYearEndMonth: 6, fiscalYearEndDay: 30 }, 'alicio@example.test')
  const bfy = await createFiscalYear(beta.ledger.id, '2027-06-30', 'alicio@example.test')
  const jun = await db.execute<{ name: string; start_date: string; end_date: string }>(raw`
    SELECT name, start_date::text, end_date::text FROM fiscal_period
     WHERE ledger_id = ${beta.ledger.id} ORDER BY start_date`)
  bfy.year.name === 'FY2027' && jun[0].start_date === '2026-07-01' && jun[11].end_date === '2027-06-30'
    ? pass('S7 June year end -> July..June, named FY2027', `${jun[0].start_date} .. ${jun[11].end_date}`)
    : fail('S7 June year end -> July..June, named FY2027', JSON.stringify({ name: bfy.year.name, first: jun[0], last: jun[11] }))

  // S8 — the periods must tile each fiscal year exactly. The database enforces
  //      no overlaps (0006) but nothing enforces coverage, so this is the only
  //      thing standing behind that property.
  //
  //      The previous version of this check asserted only "no row found", which
  //      passed on an empty table and passed with an entire year missing. It
  //      also printed a period count it never computed. Every assertion below
  //      is now a computed comparison.
  const tiling = await db.execute<{
    ledger: string; year: string; periods: string; first_start: string
    last_end: string; year_start: string; year_end: string; breaks: string
  }>(raw`
    SELECT e.code AS ledger, fy.name AS year,
           count(fp.id)::text                       AS periods,
           min(fp.start_date)::text                 AS first_start,
           max(fp.end_date)::text                   AS last_end,
           fy.start_date::text                      AS year_start,
           fy.end_date::text                        AS year_end,
           (SELECT count(*) FROM fiscal_period a
             WHERE a.fiscal_year_id = fy.id
               AND a.end_date <> fy.end_date
               AND NOT EXISTS (SELECT 1 FROM fiscal_period b
                                WHERE b.fiscal_year_id = fy.id
                                  AND b.start_date = a.end_date + 1))::text AS breaks
      FROM fiscal_year fy
      JOIN ledger l ON l.id = fy.ledger_id
      JOIN entity e ON e.id = l.entity_id
      LEFT JOIN fiscal_period fp ON fp.fiscal_year_id = fy.id
     GROUP BY e.code, fy.id, fy.name, fy.start_date, fy.end_date
     ORDER BY e.code, fy.name`)

  const badYears = tiling.filter((y) =>
    Number(y.periods) !== 12 ||
    y.first_start !== y.year_start ||   // a hole at the START of a year was invisible before
    y.last_end !== y.year_end ||
    Number(y.breaks) !== 0)

  tiling.length === 2 && badYears.length === 0
    ? pass('S8 each fiscal year is tiled by exactly 12 periods',
           tiling.map((y) => `${y.ledger}/${y.year} ${y.first_start}..${y.last_end}`).join('  '))
    : fail('S8 each fiscal year is tiled by exactly 12 periods',
           `${tiling.length} year(s) found; bad: ${JSON.stringify(badYears)}`)

  // S9 — both actions leave a trail
  const trail = await db.execute<{ action: string; n: string }>(raw`
    SELECT action, count(*)::text AS n FROM audit_log
     WHERE action IN ('create_company','create_fiscal_year') GROUP BY action ORDER BY action`)
  const byAction = Object.fromEntries(trail.map((r) => [r.action, Number(r.n)]))
  byAction.create_company === 2 && byAction.create_fiscal_year === 2
    ? pass('S9 setup actions are audited', '2 companies, 2 fiscal years')
    : fail('S9 setup actions are audited', JSON.stringify(byAction))

  // S10 — the two companies' books stay separate
  const isolation = await db.execute<{ code: string; periods: string }>(raw`
    SELECT e.code, count(fp.id)::text AS periods
      FROM entity e JOIN ledger l ON l.entity_id = e.id
      LEFT JOIN fiscal_period fp ON fp.ledger_id = l.id
     GROUP BY e.code ORDER BY e.code`)
  isolation.every((r) => r.periods === '12')
    ? pass('S10 each company has its own 12 periods', isolation.map((r) => `${r.code}:${r.periods}`).join(' '))
    : fail('S10 each company has its own 12 periods', JSON.stringify(isolation))

  // S11 — a 28 February year end. The old arithmetic stepped back twelve months
  //        from 2025-02-28, landed on the leap day 2024-02-29, and anchored every
  //        period to the 29th: a period NAMED 2024-12 that ran 29 Dec to 28 Jan.
  //        A 15 December invoice filed into a period named 2024-11.
  const feb = planFiscalYear(new Date('2025-02-28T00:00:00Z'))
  const febOk = feb.start.toISOString().slice(0, 10) === '2024-03-01'
    && feb.periods.every((p) => p.start.getUTCDate() === 1)
    && feb.periods[9].name === '2024-12'
    && feb.periods[9].start.toISOString().slice(0, 10) === '2024-12-01'
    && feb.periods[9].end.toISOString().slice(0, 10) === '2024-12-31'
  febOk
    ? pass('S11 28 February year end gives calendar months', '2024-03-01 .. 2025-02-28, 2024-12 is December')
    : fail('S11 28 February year end gives calendar months',
           feb.periods.map((p) => `${p.name}:${p.start.toISOString().slice(5,10)}~${p.end.toISOString().slice(5,10)}`).join(' '))

  // S12 — every year end from 2020 to 2040: periods must abut exactly, stay
  //       inside the year, and carry twelve distinct names.
  const broken: string[] = []
  for (let t = Date.UTC(2020, 0, 1); t <= Date.UTC(2040, 11, 31); t += 86_400_000) {
    const end = new Date(t)
    const { start, periods } = planFiscalYear(end)
    const key = end.toISOString().slice(0, 10)
    if (new Set(periods.map((p) => p.name)).size !== 12) broken.push(`${key} duplicate names`)
    if (periods[0].start.getTime() !== start.getTime()) broken.push(`${key} start mismatch`)
    if (periods[11].end.getTime() !== end.getTime()) broken.push(`${key} end mismatch`)
    for (let i = 0; i < 12; i++) {
      if (periods[i].end < periods[i].start) broken.push(`${key} p${i + 1} reversed`)
      if (i > 0 && periods[i].start.getTime() !== periods[i - 1].end.getTime() + 86_400_000) {
        broken.push(`${key} break between p${i} and p${i + 1}`)
      }
    }
    if (broken.length > 3) break
  }
  broken.length === 0
    ? pass('S12 every year end 2020-2040 tiles cleanly', '7,671 year ends, no gaps or overlaps')
    : fail('S12 every year end 2020-2040 tiles cleanly', broken.slice(0, 3).join('; '))

  // S13 — a second fiscal year must continue from the first. One click used to
  //       be enough to create FY2028 beside FY2026 and leave a 12-month hole.
  await expectError('S13 rejects a non-contiguous fiscal year', 'NOT_CONTIGUOUS',
    () => createFiscalYear(acme.ledger.id, '2028-12-31'))
  const next = await createFiscalYear(acme.ledger.id, '2027-12-31', 'alicio@example.test')
  const [cover] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM fiscal_period
     WHERE ledger_id = ${acme.ledger.id} AND '2027-03-15' BETWEEN start_date AND end_date`)
  next.year.name === 'FY2027' && cover.n === '1'
    ? pass('S14 the following year continues from the last', 'FY2026 -> FY2027, no hole')
    : fail('S14 the following year continues from the last', JSON.stringify({ next: next.year.name, cover }))

  // S15 — period_no restarts at 1 in every fiscal year, so it cannot identify a
  //        period. Filtering a trial balance on it returned March 2026 AND
  //        March 2027 once a second year existed: two years added together,
  //        with a React duplicate-key warning as the only outward sign.
  const cha = await importAccounts(acme.company.id, parseAccountsCsv(
    '1000,Cash,asset,,cash_and_cash_equivalents\n4000,Revenue,revenue,,revenue_from_contracts',
  ).map((r) => ({ ...r, entityId: acme.company.id })), 'alicio@example.test')
  const acct = Object.fromEntries(cha.map((a) => [a.code, a.id]))

  // One entry in March 2026, a different one in March 2027.
  await postEntry({
    ledgerId: acme.ledger.id, entryDate: '2026-03-10', description: 'March 2026',
    lines: [
      { accountId: acct['1000'], amount: parseMoney('100.00') },
      { accountId: acct['4000'], amount: -parseMoney('100.00') },
    ],
  })
  await postEntry({
    ledgerId: acme.ledger.id, entryDate: '2027-03-10', description: 'March 2027',
    lines: [
      { accountId: acct['1000'], amount: parseMoney('7.00') },
      { accountId: acct['4000'], amount: -parseMoney('7.00') },
    ],
  })

  const marches = await db.execute<{ id: string; name: string }>(raw`
    SELECT id::text, name FROM fiscal_period
     WHERE ledger_id = ${acme.ledger.id} AND period_no = 3 ORDER BY start_date`)
  const tb2026 = await trialBalance(acme.ledger.id, marches[0].id)
  const tb2027 = await trialBalance(acme.ledger.id, marches[1].id)

  const cash2026 = tb2026.find((r) => r.code === '1000')
  const cash2027 = tb2027.find((r) => r.code === '1000')
  marches.length === 2
    && new Set(tb2026.map((r) => r.code)).size === tb2026.length   // one row per account
    && cash2026?.debit === '10000' && cash2027?.debit === '700'    // each year on its own
    ? pass('S15 a trial balance covers one period, not one number',
           `${marches[0].name} debit 100.00, ${marches[1].name} debit 7.00, no duplicate rows`)
    : fail('S15 a trial balance covers one period, not one number',
           JSON.stringify({ marches: marches.length, tb2026, tb2027 }))

  // S16 — the defect this replaces: filtering on period_no returns both years
  const byNumber = await db.execute<{ code: string; n: string }>(raw`
    SELECT a.code, count(*)::text AS n
      FROM period_balance pb JOIN account a ON a.id = pb.account_id
      JOIN fiscal_period fp ON fp.id = pb.period_id
     WHERE pb.ledger_id = ${acme.ledger.id} AND fp.period_no = 3
     GROUP BY a.code ORDER BY a.code`)
  byNumber.every((r) => r.n === '2')
    ? pass('S16 filtering by period NUMBER is what duplicated rows',
           `${byNumber.length} accounts, 2 rows each — the bug this guards against`)
    : fail('S16 filtering by period NUMBER is what duplicated rows', JSON.stringify(byNumber))

  // S17 — a company must be able to receive an entry dated TODAY the moment it
  //        is created. The first rule tried here returned the year end that had
  //        most recently PASSED, so a company created in August got a fiscal
  //        year that ended eight months earlier and nothing current could be
  //        posted to it.
  //
  //        Note these are UTC midnights, which in a timezone west of Greenwich
  //        are the previous afternoon LOCALLY — so `onYearEnd` is 30 December
  //        here, not "the day itself", and none of them can tell the local year
  //        from the UTC one. S19 below is the check that can.
  const inAugust = new Date('2026-08-21T00:00:00Z')
  const inJanuary = new Date('2026-01-05T00:00:00Z')
  const onYearEnd = new Date('2026-12-31T12:00:00Z')
  currentYearEnd(12, 31, inAugust) === '2026-12-31'
    && currentYearEnd(12, 31, inJanuary) === '2026-12-31'
    && currentYearEnd(12, 31, onYearEnd) === '2026-12-31'
    && currentYearEnd(6, 30, inAugust) === '2027-06-30'     // June year end already past
    && currentYearEnd(6, 30, inJanuary) === '2026-06-30'
    && currentYearEnd(2, 29, new Date('2026-10-12T12:00:00Z')) === '2027-02-28'
    && currentYearEnd(2, 29, new Date('2027-10-12T12:00:00Z')) === '2028-02-29'
    ? pass('S17 the fiscal year offered is the one we are in',
           'Dec year end in August -> 2026-12-31; June year end in August -> 2027-06-30')
    : fail('S17 the fiscal year offered is the one we are in',
           [currentYearEnd(12, 31, inAugust), currentYearEnd(6, 30, inAugust),
            currentYearEnd(6, 30, inJanuary)].join(' '))

  // S18 — and end to end: a new company can take an entry dated today
  const fresh = await createCompanyWithYear({ code: 'FRESH', name: 'Fresh Co.' }, 'alicio@example.test')
  const today = new Date().toISOString().slice(0, 10)
  const [covers] = await db.execute<{ n: string }>(raw`
    SELECT count(*)::text AS n FROM fiscal_period
     WHERE ledger_id = ${fresh.ledger.id} AND ${today}::date BETWEEN start_date AND end_date
       AND status = 'open'`)
  covers.n === '1' && fresh.periodCount === 12
    ? pass('S18 a new company can take an entry dated today', `${fresh.year.name} covers ${today}`)
    : fail('S18 a new company can take an entry dated today',
           `${fresh.year.name} (${fresh.year.startDate}..${fresh.year.endDate}) covers ${today}? ${covers.n}`)

  // S19 — the year end offered on the EVENING of 31 December.
  //
  //        `currentYearEnd` read the UTC year, so a company created that
  //        evening was given a fiscal year ending a year later than it should
  //        be, and nothing dated that day could be posted to it — the exact
  //        failure this function's own comment says it exists to prevent. Every
  //        instant S17 passes is a UTC midnight, where the two clocks agree.
  const offsetMinutes = -new Date('2026-12-31T12:00:00Z').getTimezoneOffset()
  if (offsetMinutes === 0) {
    pass('S19 the year end on New Year\'s Eve is this year\'s',
         'skipped: this machine runs on UTC, where the two never differ')
  } else {
    const nye = offsetMinutes < 0
      ? new Date('2027-01-01T01:00:00Z')   // west: 31 Dec, evening
      : new Date('2026-12-31T23:30:00Z')   // east: already 1 Jan
    const expected = offsetMinutes < 0 ? '2026-12-31' : '2027-12-31'
    const got = currentYearEnd(12, 31, nye)
    got === expected
      ? pass('S19 the year end on New Year\'s Eve is this year\'s',
             `${nye.toISOString()} -> ${got}`)
      : fail('S19 the year end on New Year\'s Eve is this year\'s',
             `wanted ${expected}, got ${got}`)
  }

  // ------------------------------------------------------ archive and remove --
  //
  // Two doors, and the line between them is not a judgment: whether anything
  // was ever posted (0065; the owner asked for both, 2026-09-07).
  const check = (ok: boolean, label: string, detail = '') => (ok ? pass(label, detail) : fail(label, detail))
  const said = (e: unknown) => (e instanceof CompanyError ? `${e.code}: ${e.message}` : causesOf(e)).replace(/\s+/g, ' ')

  // CO1 — archiving needs a reason, and keeps who, when and why.
  {
    const co = await createCompanyWithYear({ code: 'ARCH', name: 'Archivable Holdings Ltd.' }, 'alicio@example.test')
    let bare = ''
    try { await archiveCompany(co.company.id, '   ', 'pat@x.test'); bare = 'archived with no reason' }
    catch (e) { bare = said(e) }
    // Caught: a mutant that lets a blank reason through archives the company
    // here, and this call would then throw ALREADY_ARCHIVED and kill the
    // suite instead of turning this line red.
    let done: { archived_at: string | null } | null = null
    try { done = await archiveCompany(co.company.id, 'Dissolved in 2026', 'pat@x.test') }
    catch { done = null }
    const back = await companyById(co.company.id)
    const [audit] = await db.execute<{ actor: string; after: unknown }>(raw`
      SELECT actor, after FROM audit_log
       WHERE action = 'archive_company' AND record_id = ${co.company.id} ORDER BY occurred_at DESC LIMIT 1`)
    let twice = ''
    try { await archiveCompany(co.company.id, 'again', 'pat@x.test') } catch (e) { twice = said(e) }
    check(bare.startsWith('NO_REASON') && done?.archived_at !== null && back?.archived_by === 'pat@x.test'
      && back.archived_reason === 'Dissolved in 2026' && audit?.actor === 'pat@x.test'
      && twice.startsWith('ALREADY_ARCHIVED'),
      'CO1 archiving needs a reason, records who and why, and happens once',
      `${bare.slice(0, 30)}; by ${back?.archived_by}; ${twice.slice(0, 30)}`)

    // CO2 — nothing enters an archived company: not through the door, not by
    //       hand. And no new year either, which would be a period nothing
    //       could be posted into.
    // A payables account with its role, so the by-hand invoice below is a
    // VALID invoice but for the archive: without it the insert was refused by
    // the control-account rule instead, and the check could not tell the two
    // refusals apart (critic's block 476 came back toothless on exactly that).
    const chart = await importAccounts(co.company.id,
      parseAccountsCsv(`1000,Cash,asset,,cash_and_cash_equivalents
2100,Trade payables,liability,,trade_payables
3000,Share capital,equity,,share_capital`).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
    const id = Object.fromEntries(chart.map((a) => [a.code, a.id]))
    let posted = '', byHandPost = '', newYear = ''
    try {
      await postEntry({ ledgerId: co.ledger.id, entryDate: `${new Date().getFullYear()}-06-01`,
        description: 'Should not land', actor: 'alicio@example.test',
        lines: [{ accountId: id['1000'], amount: 100n }, { accountId: id['3000'], amount: -100n }] })
      posted = 'landed'
    } catch (e) { posted = said(e) }
    try {
      await byHand(async (tx) => {
        await tx.execute(raw`
          INSERT INTO journal_entry (ledger_id, entry_date, description, status, source_type, total_debit, total_credit)
          VALUES (${co.ledger.id}::uuid, '2026-06-01'::date, 'By hand', 'draft', 'manual', 0, 0)`)
      })
      byHandPost = 'landed'
    } catch (e) { byHandPost = said(e) }
    try { await createFiscalYear(co.ledger.id, '2027-12-31', 'alicio@example.test'); newYear = 'created' }
    catch (e) { newYear = said(e) }
    // And every OTHER way in, not just the posting door. An invoice, a pay
    // run and a bill reading are documents that exist before they post, and a
    // bank file lands as rows against an account: 0065 gated two tables and
    // said "nothing can enter", which was four doors short (critic,
    // 2026-09-07; 0066 closes them).
    const byHandInto = async (statement: (tx: Parameters<Parameters<typeof byHand>[0]>[0]) => Promise<unknown>) => {
      try { await byHand(statement); return 'landed' } catch (e) { return said(e) }
    }
    const anyAccount = { id: id['1000'] }
    const payable = { id: id['2100'] }
    // A party to bill, so the invoice INSERT actually inserts a row: the
    // first version selected from an empty `party` table, inserted nothing,
    // raised nothing, and read as "landed".
    const supplier = await createParty({
      kind: 'organisation', name: 'Someone To Bill Ltd.', actor: 'alicio@example.test',
      roles: [{ entityId: co.company.id, role: 'supplier', heldFrom: '2026-01-01' }],
    })
    const invoice = await byHandInto(async (tx) => tx.execute(raw`
      INSERT INTO invoice (entity_id, ledger_id, direction, document_kind, party_id, control_account_id,
                           issued_on, due_on, created_by)
      VALUES (${co.company.id}::uuid, ${co.ledger.id}::uuid, 'purchase', 'invoice', ${supplier.id}::uuid,
              ${payable.id}::uuid, '2026-06-01'::date, '2026-07-01'::date, 'pat@x.test')`))
    const payRun = await byHandInto(async (tx) => tx.execute(raw`
      INSERT INTO pay_run (ledger_id, pay_date, bank_account_id, created_by)
      VALUES (${co.ledger.id}::uuid, '2026-06-20'::date, ${anyAccount.id}::uuid, 'pat@x.test')`))
    // The bytes as a parameter rather than a literal: an escaped bytea inside
    // a template literal is one backslash away from a different error.
    const reading = await byHandInto(async (tx) => tx.execute(raw`
      INSERT INTO ai_bill_reading (ledger_id, read_by, filename, mime, bytes, sha256)
      VALUES (${co.ledger.id}::uuid, 'pat@x.test', 'x.png', 'image/png', ${Buffer.from([0])}, 'abc')`))
    const bankRow = await byHandInto(async (tx) => tx.execute(raw`
      INSERT INTO bank_transaction (account_id, txn_date, amount, description, occurrence, imported_by)
      VALUES (${anyAccount.id}::uuid, '2026-06-01'::date, -100, 'A ROW', 1, 'pat@x.test')`))
    const statement = await byHandInto(async (tx) => tx.execute(raw`
      INSERT INTO bank_statement (account_id, statement_date, ending_balance, created_by)
      VALUES (${anyAccount.id}::uuid, '2026-06-30'::date, 0, 'pat@x.test')`))
    const every = [invoice, payRun, reading, bankRow, statement]
    check(posted.includes('ENTITY_ARCHIVED') && byHandPost.includes('ENTITY_ARCHIVED')
      && newYear.includes('ENTITY_ARCHIVED') && every.every((r) => r.includes('ENTITY_ARCHIVED')),
      'CO2 nothing enters an archived company: not an entry, a year, an invoice, a pay run, a reading, a bank row or a statement',
      `door: ${posted.includes('ENTITY_ARCHIVED') ? 'refused' : posted.slice(0, 30)}; `
      + `by hand: ${byHandPost.includes('ENTITY_ARCHIVED') ? 'refused' : byHandPost.slice(0, 30)}; `
      + `year: ${newYear.includes('ENTITY_ARCHIVED') ? 'refused' : newYear.slice(0, 30)}; `
      + `invoice/run/reading/row/statement: ${every.map((r) => r.includes('ENTITY_ARCHIVED') ? 'refused' : r.slice(0, 40)).join(' | ')}`)

    // CO3 — it comes back, and then it posts. One flag, derived: `is_active`
    //       is generated from `archived_at`, so the dozen queries that filter
    //       on it cannot disagree with the fact.
    const [whileAway] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM entity WHERE id = ${co.company.id}::uuid AND is_active`)
    await unarchiveCompany(co.company.id, 'pat@x.test')
    const [nowBack] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM entity WHERE id = ${co.company.id}::uuid AND is_active`)
    const landed = await postEntry({ ledgerId: co.ledger.id, entryDate: `${new Date().getFullYear()}-06-01`,
      description: 'Lands now', actor: 'alicio@example.test',
      lines: [{ accountId: id['1000'], amount: 100n }, { accountId: id['3000'], amount: -100n }] })
    check(whileAway.n === '0' && nowBack.n === '1' && !!landed.entry.entryNo
      && (await companyById(co.company.id))?.archived_at === null,
      'CO3 bringing it back makes it postable again, and is_active is derived from the one fact',
      `active while archived: ${whileAway.n}; after: ${nowBack.n}; then posted ${landed.entry.entryNo}`)

    // CO4 — and now it cannot be removed, because it has books.
    let refused = ''
    try { await deleteCompany(co.company.id, 'pat@x.test') } catch (e) { refused = said(e) }
    check(refused.startsWith('HAS_BOOKS') && refused.includes('Archive it instead')
      && (await companyById(co.company.id)) !== null,
      'CO4 a company with books cannot be removed, and the refusal says to archive it',
      refused.slice(0, 80))
  }

  // CO9 — archiving a company leaves people and permissions alone, and a
  //       save after it does not quietly take them away.
  //
  //       This is what `allCompanies` including archived ones is FOR: the
  //       grants screen sends the whole set of ticks and `setGrants` replaces
  //       what it is sent, so a company missing from the ticks loses its
  //       grants on the next save by anybody (critic, 2026-09-07).
  {
    const co = await createCompanyWithYear({ code: 'GRNT', name: 'Granted Ltd.' }, 'alicio@example.test')
    const other = await createCompanyWithYear({ code: 'OTHR2', name: 'Other Ltd.' }, 'alicio@example.test')
    const person = await createUser({
      email: 'clerk@x.test', firstName: 'Clerk', lastName: null, password: 'a long ordinary sentence',
      kind: 'user', actor: 'alicio@example.test',
    })
    await setGrants({ userId: person.id, entityIds: [co.company.id, other.company.id],
                      modules: ['/entries'], actor: 'alicio@example.test' })
    await archiveCompany(co.company.id, 'Wound up', 'alicio@example.test')
    const offered = await allCompanies()
    const stillOffered = offered.find((c) => c.id === co.company.id)
    // Somebody saves this person's access from the screen: it sends back what
    // the screen showed.
    await setGrants({ userId: person.id, entityIds: offered.map((c) => c.id),
                      modules: ['/entries'], actor: 'alicio@example.test' })
    const after = await grantsOf(person.id)
    check(!!stillOffered && stillOffered.archived === true && after.entities.includes(co.company.id)
      && after.entities.includes(other.company.id),
      'CO9 archiving leaves people and permissions alone, and a later save does not drop them',
      `offered while archived: ${!!stillOffered} (flagged ${stillOffered?.archived}); `
      + `grants after a save: ${after.entities.length}`)
  }

  // CO10 — a company whose only rows are the assistant's cannot be removed
  //        either: an exchange is never deleted (0061's trigger refuses it),
  //        so the gate names those rows and says to archive before the delete
  //        can reach the trigger.
  {
    const asked = await createCompanyWithYear({ code: 'ASKD', name: 'Asked Only Ltd.' }, 'alicio@example.test')
    // A reading with no exchange cannot come through `readBill`, which always
    // writes the exchange first; this hand-made one guards the gate on its own.
    const read = await createCompanyWithYear({ code: 'READ', name: 'Read Only Ltd.' }, 'alicio@example.test')
    const inquired = await createCompanyWithYear({ code: 'INQR', name: 'Inquired Only Ltd.' }, 'alicio@example.test')
    await byHand((tx) => tx.execute(raw`
      INSERT INTO ai_exchange (ledger_id, asked_by, model, question)
      VALUES (${asked.ledger.id}::uuid, 'alicio@example.test', 'stub-model', 'What is owed?')`))
    await byHand((tx) => tx.execute(raw`
      INSERT INTO ai_bill_reading (ledger_id, read_by, filename, mime, bytes, sha256)
      VALUES (${read.ledger.id}::uuid, 'alicio@example.test', 'bill.pdf', 'application/pdf',
              '\\x00'::bytea, ${'c'.repeat(64)})`))
    await byHand((tx) => tx.execute(raw`
      INSERT INTO ai_inquiry (ledger_id, asked_by, question, system, model)
      VALUES (${inquired.ledger.id}::uuid, 'alicio@example.test', 'Who owes us?', 'the system text', 'stub-model')`))
    const attempt = async (id: string) => {
      try { await deleteCompany(id, 'pat@x.test'); return 'removed' } catch (e) { return said(e) }
    }
    const one = await attempt(asked.company.id)
    const two = await attempt(read.company.id)
    const three = await attempt(inquired.company.id)
    const stay = [await companyById(asked.company.id), await companyById(read.company.id), await companyById(inquired.company.id)]
    check([one, two, three].every((t) => t.startsWith('HAS_AI_RECORDS') && t.includes('Archive it instead'))
      && stay.every((c) => c !== null && c.entries === '0' && c.ai_records === '1'),
      'CO10 a company holding only the assistant\'s rows is refused at the gate with a sentence to archive, not by the trigger',
      `${one.slice(0, 50)} | ${two.slice(0, 50)} | ${three.slice(0, 50)}`)
  }

  // CO11 — and the companies list offers Remove from the same two counts: a
  //        company with nothing in its books but a question to the assistant
  //        is told it can only be archived, not handed a door the library
  //        refuses.
  {
    const render = (input: { books: string; aiRecords: string }) => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-company-state.tsx', JSON.stringify(input),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const empty = render({ books: '0', aiRecords: '0' })
    const asked = render({ books: '0', aiRecords: '2' })
    const kept = render({ books: '3', aiRecords: '0' })
    const offered = (html: string) => html.includes('data-delete-offered')
    check(offered(empty) && !offered(asked) && asked.includes('asked the assistant')
          && !offered(kept) && kept.includes('3 things in its books'),
      'CO11 the companies list offers Remove only with nothing in the books and nothing asked of the assistant',
      `empty ${offered(empty) ? 'offered' : 'not offered'}; asked ${offered(asked) ? 'offered' : 'not offered'}; `
      + `books ${offered(kept) ? 'offered' : 'not offered'}`)

    // The row decides from what it is handed; the page is what hands it the
    // library's counts, and a count of its own there was the defect.
    const page = readFileSync('src/app/companies/page.tsx', 'utf8')
    const fromLibrary = page.includes('new Map((await companiesWithState()).map((c) => [c.id, c]))')
      && page.includes("books={counts.get(c.entity_id)?.entries ?? '1'}")
      && page.includes("aiRecords={counts.get(c.entity_id)?.ai_records ?? '1'}")
    check(fromLibrary,
      'CO11b the companies list hands each row the library\'s two counts, not a count of its own',
      fromLibrary ? 'books and aiRecords from companiesWithState' : 'the page hands the row something else')
  }

  // CO5 — a company that was a mistake goes, with everything that hung off it,
  //       and the audit trail keeps that it existed.
  {
    const co = await createCompanyWithYear({ code: 'OOPS', name: 'Mistake Ltd.' }, 'alicio@example.test')
    await importAccounts(co.company.id,
      parseAccountsCsv('1000,Cash,asset,,cash_and_cash_equivalents').map((r) => ({ ...r, entityId: co.company.id })),
      'alicio@example.test')
    // Caught, so a delete that leaves a row behind makes this line red rather
    // than killing the suite — a mutant that removes a table from the list
    // fails on the foreign key, and a dead suite records nothing.
    let gone: { code: string; name: string } | null = null
    let threw = ''
    try { gone = await deleteCompany(co.company.id, 'pat@x.test') } catch (e) { threw = said(e) }
    const left = await Promise.all([
      db.execute<{ n: string }>(raw`SELECT count(*)::text AS n FROM entity WHERE id = ${co.company.id}::uuid`),
      db.execute<{ n: string }>(raw`SELECT count(*)::text AS n FROM ledger WHERE entity_id = ${co.company.id}::uuid`),
      db.execute<{ n: string }>(raw`SELECT count(*)::text AS n FROM account WHERE entity_id = ${co.company.id}::uuid`),
      db.execute<{ n: string }>(raw`SELECT count(*)::text AS n FROM fiscal_year WHERE ledger_id = ${co.ledger.id}::uuid`),
      db.execute<{ n: string }>(raw`SELECT count(*)::text AS n FROM fiscal_period WHERE ledger_id = ${co.ledger.id}::uuid`),
    ])
    const [trail] = await db.execute<{ before: { code?: string; name?: string } }>(raw`
      SELECT before FROM audit_log WHERE action = 'delete_company' AND record_id = ${co.company.id}`)
    check(gone?.code === 'OOPS' && left.every((r) => r[0].n === '0')
      && trail?.before?.name === 'Mistake Ltd.' && trail.before.code === 'OOPS',
      'CO5 a company with no books is removed with everything under it, and the trail keeps its name',
      threw ? `refused: ${threw.slice(0, 70)}`
            : `${left.map((r) => r[0].n).join('/')} rows left; the trail says ${trail?.before?.name}`)
  }

  // CO12 — a company whose only records are its share register goes too. The
  //        register's movements are not "books" and do not stop a delete, but
  //        the register refused every DELETE outright (0035), so this company
  //        could not be removed at all; 0083 opens the register to the doors
  //        that set its flag, and removing a company is one of them.
  {
    const co = await createCompanyWithYear({ code: 'SHRS', name: 'Shares Only Ltd.' }, 'alicio@example.test')
    const holder = await createParty({ kind: 'person', name: 'Pat Holder',
      roles: [{ entityId: co.company.id, role: 'shareholder', heldFrom: '2020-01-01' }], actor: 'alicio@example.test' })
    const other = await createParty({ kind: 'person', name: 'Quinn Other',
      roles: [{ entityId: co.company.id, role: 'shareholder', heldFrom: '2020-01-01' }], actor: 'alicio@example.test' })
    const cls = (await createShareClass({ entityId: co.company.id, name: 'Common', actor: 'alicio@example.test' }))!
    await issueShares({ shareClassId: cls, partyId: holder.id, onDate: '2020-01-01', quantity: 10n, details: 'Issued', actor: 'alicio@example.test' })
    await transferShares({ shareClassId: cls, fromPartyId: holder.id, toPartyId: other.id, onDate: '2021-01-01', quantity: 4n, details: 'Sold', actor: 'alicio@example.test' })
    let threw = ''
    try { await deleteCompany(co.company.id, 'pat@x.test') } catch (e) { threw = said(e) }
    const [left] = await db.execute<{ n: string }>(raw`SELECT count(*)::text AS n FROM share_class WHERE id = ${cls}::uuid`)
    check(threw === '' && left.n === '0' && (await companyById(co.company.id)) === null,
      'CO12 a company holding only share movements is removed, register and all',
      threw ? `refused: ${threw.slice(0, 90)}` : `${left.n} share class row(s) left`)
  }

  // CO13 — A FISCAL YEAR MADE BY MISTAKE IS DELETED WHILE IT HOLDS NOTHING
  //        (0084; owner: 「所有的紀錄儘量都可以編輯刪除」). Three years: the
  //        middle one is refused for the gap it would leave; the last, with an
  //        entry dated in it, is refused and counts it; the first, empty, goes
  //        with its periods, and the trail keeps its name.
  {
    const A = 'alicio@example.test'
    const co = await createCompanyWithYear({ code: 'YEARS', name: 'Three Years Ltd.' }, A)
    const L = co.ledger.id
    const endYr = Number(co.year.endDate.slice(0, 4))
    const md = co.year.endDate.slice(4)
    const earlier = await createFiscalYear(L, `${endYr - 1}${md}`, A)
    const later = await createFiscalYear(L, `${endYr + 1}${md}`, A)
    const accts = await importAccounts(co.company.id,
      parseAccountsCsv('1000,Cash,asset,,cash_and_cash_equivalents\n3000,Capital,equity').map((row) => ({ ...row, entityId: co.company.id })), A)
    const at = (code: string) => accts.find((a) => a.code === code)!.id
    await postEntry({ ledgerId: L, entryDate: later.year.startDate, description: 'In the last year', actor: A,
      lines: [{ accountId: at('1000'), amount: 100n }, { accountId: at('3000'), amount: -100n }] })
    const tryDelete = async (id: string) => {
      try { return `deleted ${(await deleteFiscalYear(L, id, A)).name}` } catch (e) { return e instanceof SetupError ? `${e.code}: ${e.message}` : String(e) }
    }
    const middle = await tryDelete(co.year.id)
    const last = await tryDelete(later.year.id)
    const first = await tryDelete(earlier.year.id)
    const [left] = await db.execute<{ years: number; periods: number; trail: number }>(raw`
      SELECT (SELECT count(*)::int FROM fiscal_year WHERE ledger_id = ${L}::uuid) AS years,
             (SELECT count(*)::int FROM fiscal_period WHERE fiscal_year_id = ${earlier.year.id}::uuid) AS periods,
             (SELECT count(*)::int FROM audit_log WHERE action = 'delete_fiscal_year' AND record_id = ${earlier.year.id}) AS trail`)
    check(middle.startsWith('YEAR_IN_THE_MIDDLE') && last.startsWith('YEAR_IN_USE') && last.includes('1 entry')
          && first === `deleted ${earlier.year.name}` && left.years === 2 && left.periods === 0 && left.trail === 1,
      'CO13 an empty fiscal year at either end is deleted with its periods; one in the middle or holding an entry stays',
      `middle: ${middle.slice(0, 40)}; last: ${last.slice(0, 60)}; first: ${first}; ${left.years} years left, `
        + `${left.periods} of its periods, ${left.trail} trail row`)
  }

  // CO14 — A NEW COMPANY IS NOT GIVEN A NAME ANOTHER COMPANY HAS. The papers
  //        of a company live in a folder named for it; two companies of one
  //        name share that folder, and renaming or rebuilding either reaches
  //        into the other's (independent critic, 2026-09-16). Refused whatever
  //        the case, and nothing is created.
  {
    await createCompanyWithYear({ code: 'TWIN1', name: 'Twin Name Ltd.' }, 'alicio@example.test')
    let said = ''
    try { await createCompany({ code: 'TWIN2', name: 'twin name ltd.' }, 'alicio@example.test'); said = 'CREATED' }
    catch (e) { said = e instanceof SetupError ? `${e.code}: ${e.message}` : String(e) }
    const [twins] = await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM entity WHERE code IN ('TWIN1', 'TWIN2')`)
    check(said.startsWith('NAME_TAKEN') && said.includes('Twin Name Ltd.') && twins.n === 1,
      'CO14 a company cannot be created with the name of one already here, whatever the case',
      `${said.slice(0, 90)}; ${twins.n} company row(s)`)
  }

  // CO6 — the form doors: the reason, the typed code, and the refusals.
  {
    const co = await createCompanyWithYear({ code: 'FORM', name: 'Form Door Ltd.' }, 'alicio@example.test')
    const f = (over: Record<string, string>) => {
      const d = new FormData()
      d.set(CF.entityId, co.company.id); d.set(CF.code, 'FORM')
      for (const [k, v] of Object.entries(over)) d.set(k, v)
      return d
    }
    const wrongCode = await deleteCompanyFromForm(f({ [CF.confirm]: 'form' }), 'pat@x.test')
    const noReason = await archiveCompanyFromForm(f({ [CF.reason]: '' }), 'pat@x.test')
    const archived = await archiveCompanyFromForm(f({ [CF.reason]: 'Never traded' }), 'pat@x.test')
    const backAgain = await unarchiveCompanyFromForm(f({}), 'pat@x.test')
    let removed: { ok?: string; error?: string }
    try { removed = await deleteCompanyFromForm(f({ [CF.confirm]: 'FORM' }), 'pat@x.test') }
    catch (e) { removed = { error: `threw: ${said(e)}` } }
    check(!!wrongCode.error && wrongCode.error.includes('Type FORM') && !!noReason.error
      && !!archived.ok && archived.ok.includes('books stay') && !!backAgain.ok
      && !!removed.ok && (await companyById(co.company.id)) === null,
      'CO6 the form doors: a reason to archive, the code typed to remove, and both refusals by name',
      `${wrongCode.error?.slice(0, 30)}; ${archived.ok?.slice(0, 30)}; ${removed.ok?.slice(0, 30)}`)
  }

  // CO7 — the delete's table list against the DATABASE's own foreign keys,
  //       walked OUTWARD rather than one hop.
  //
  //       Every table that can hold a row belonging to a company is reachable
  //       from `entity` or `ledger` by following foreign keys: `bank_match`
  //       points at a bank row, which points at an account, which points at
  //       the company. The first version of this check asked only for tables
  //       pointing straight at `entity` or `ledger`, and its own comment
  //       claimed the rest were removed by their parent's cascade — false for
  //       five of them, and the delete aborted on their keys (critic,
  //       2026-09-07). This walks until nothing new is reached, and every
  //       table it finds must either be in the list or be removed by a
  //       cascade of its own.
  {
    const keys = await db.execute<{ child: string; parent: string; cascade: boolean }>(raw`
      SELECT c.relname AS child, f.relname AS parent, (k.confdeltype = 'c') AS cascade
        FROM pg_constraint k
        JOIN pg_class c ON c.oid = k.conrelid
        JOIN pg_class f ON f.oid = k.confrelid
       WHERE k.contype = 'f' AND c.relnamespace = 'public'::regnamespace`)
    const reached = new Set<string>(['entity', 'ledger'])
    for (let grew = true; grew;) {
      grew = false
      for (const k of keys) {
        if (reached.has(k.parent) && !reached.has(k.child)) { reached.add(k.child); grew = true }
      }
    }
    // Removed by a cascade of its own, from a table this delete removes: the
    // attachment bindings go with their entries that way (0046), and the
    // journal lines with their entries.
    const cascades = new Set(keys.filter((k) => k.cascade).map((k) => k.child))
    const known = new Set<string>([...COMPANY_TABLES.first.map((t) => t.table), ...COMPANY_TABLES.byEntity, ...COMPANY_RETAINED_TABLES])
    const unaccounted = [...reached]
      .filter((t) => t !== 'entity' && !known.has(t) && !cascades.has(t))
      // `party` and the reference tables are shared across companies and are
      // NOT the company's to remove; a party_role goes, the party stays.
      .filter((t) => !['party', 'accounting_standard', 'party_role_definition',
                       'statement_template', 'statement_line', 'audit_log',
                       'app_user', 'user_session', 'user_module_access',
                       'attachment_blob', 'schema_migration'].includes(t))
    const stale = [...known].filter((t) => !reached.has(t))
    check(unaccounted.length === 0 && stale.length === 0,
      'CO7 every table reachable from a company is named in the delete, removed by a cascade, or shared on purpose',
      unaccounted.length || stale.length
        ? `unaccounted: ${unaccounted.join(', ') || 'none'}; not reachable: ${stale.join(', ') || 'none'}`
        : `${reached.size - 1} tables reachable, ${known.size} named, ${cascades.size} cascading`)
  }

  // CO8 — the list KEEPS archived companies rather than hiding them, after
  //       the live ones. Their books are still readable, which is the whole
  //       difference between archiving and removing. Archived here on purpose
  //       so the ordering has something to order: the first version asserted
  //       "no live company after an archived one" over a list with nothing
  //       archived in it, which is true of every list.
  {
    // A code that sorts FIRST, archived: if the ordering only sorted by code
    // this would head the list, so its position is the archived clause and
    // nothing else. Bringing it back puts it at the top, which is the pair.
    const away = await createCompanyWithYear({ code: 'AAAA', name: 'Alpha First Ltd.' }, 'alicio@example.test')
    await archiveCompany(away.company.id, 'so the list has one', 'pat@x.test')
    const rows = await companiesWithState()
    const archived = rows.filter((r) => r.archived_at !== null)
    const firstArchived = rows.findIndex((r) => r.archived_at !== null)
    const liveAfter = rows.slice(firstArchived).some((r) => r.archived_at === null)
    await unarchiveCompany(away.company.id, 'pat@x.test')
    const afterBack = await companiesWithState()
    check(rows.length > 1 && archived.some((r) => r.code === 'AAAA') && !liveAfter
      && rows[0].code !== 'AAAA' && afterBack[0].code === 'AAAA',
      'CO8 the list still holds archived companies, after the live ones whatever their code',
      `${rows.length} compan(ies), ${archived.length} archived; AAAA sat among them while archived and first once back`)
  }

  // S-ready — A NEW COMPANY CAN KEEP BOOKS THE MINUTE IT EXISTS (2026-09-16).
//
//   The owner asked why the overview warned about missing accounts instead of
//   the accounts being there: 「你把所有需要的account直接内置不就行了」. The
//   core roles now arrive with the company. Three things have to hold together
//   or that is worse than the warning was.
{
  const ready = await createCompanyReady(
    { code: 'RDY', name: 'Ready Books Ltd.' }, 'alicio@example.test')

  // 1. Every CORE role is carried, so nothing core can refuse on day one.
  const left = await missingRoles(ready.ledger.id)
  const coreLeft = left.filter((m) => m.stops.some((c) => c.weight === 'core'))

  // 2. The optional ones are NOT invented. Somebody with no employees is not
  //    handed a payroll liability account just to quiet a banner.
  const optionalLeft = left.filter((m) => m.stops.every((c) => c.weight === 'optional'))

  // 3. AND THE PASTE SCREEN STILL WORKS. importAccounts refuses a whole paste
  //    containing a code that exists, so seeding could have made the starter
  //    chart unpasteable on the one screen that exists to paste it. The page
  //    hands the form the chart LESS what is already there; this is that same
  //    subtraction, done here, and then actually imported.
  const taken = new Set((await chartOfAccounts(ready.company.id)).map((a) => a.code))
  const projectDefaults = await db.execute(raw`SELECT account_id FROM project_category_account WHERE entity_id=${ready.company.id}::uuid`)
  check(projectDefaults.length===0 && !taken.has('8518') && !taken.has('8320') && !taken.has('8340') && !taken.has('8360') && !taken.has('8450') && !taken.has('8457'),
    'S-ready-project a new company receives no optional Project cost accounts', `${taken.size} core accounts; no Project bindings`)
  const rest = parseAccountsCsv(
    STARTER_CHART.split('\n').filter((l) => !taken.has(l.split(',')[0]?.trim())).join('\n'))
  let pasted = ''
  try {
    await importAccounts(ready.company.id, rest.map((x) => ({ ...x, entityId: ready.company.id })),
                         'alicio@example.test')
  } catch (e) { pasted = e instanceof Error ? e.message : String(e) }
  const whole = await chartOfAccounts(ready.company.id)
  const expectedCodes = new Set([...taken, ...parseAccountsCsv(STARTER_CHART).map(a=>a.code)])

  check(ready.seeded.length > 0 && coreLeft.length === 0 && optionalLeft.length > 0
        && pasted === '' && whole.length === expectedCodes.size && whole.every(a=>expectedCodes.has(a.code)),
    'S-ready a new company arrives with the core accounts, and the starter chart still pastes on top',
    coreLeft.length > 0 ? `core role missing on a fresh company: ${coreLeft.map((m) => m.role).join(', ')}`
      : optionalLeft.length === 0 ? 'the optional roles were invented too — a company with no employees should not be given a payroll account'
      : pasted !== '' ? `the rest of the starter chart was refused: ${pasted.slice(0, 80)}`
      : `${ready.seeded.length} seeded (${ready.seeded.map((a) => a.code).join(' ')}); `
        + `${optionalLeft.length} optional role(s) still open; the remaining chart pasted to ${whole.length}`)
}

  await trailNamesPeople(check, 'CO15 every audit row this suite wrote names a person, not the database role')
  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })
