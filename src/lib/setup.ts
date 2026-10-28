import 'server-only'
import { importAccounts, parseAccountsCsv } from './accounts'
import { CORE_ROLES } from './roles'
import { STARTER_CHART } from './starter-chart'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { entity, fiscalPeriod, fiscalYear, ledger } from '@/db/schema'
import { partsOf } from './today'
import { pad } from './date-range'
import { daysInMonth } from './dates'
import { actingAs } from './acting'
import { folderTakenBy } from './attachments'
import { initializeModuleCompany } from './module-extensions'
import {companySetupPlan,fiscalEndOn,type CompanySetupPlan,type SetupChart} from './company-onboarding'

export class SetupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SetupError'
  }
}

export type NewCompany = {
  code: string
  name: string
  legalName?: string
  province?: string
  businessNumber?: string
  /** Canadian corporations may choose any year end; T2 does not require December. */
  fiscalYearEndMonth?: number
  fiscalYearEndDay?: number
  /** Initial guide preferences; recorded once alongside company creation, never a grant. */
  onboarding?: CompanySetupPlan
}

/**
 * A company and its primary ledger are created together. `ledger` stays a
 * first-class row because a second set of books (a tax basis, say) must not
 * require a migration later — but there is no reason to make the owner think
 * about it today, so the UI never asks.
 */
export async function createCompany(input: NewCompany, actor = 'system') {
  const code = input.code.trim().toUpperCase()
  const name = input.name.trim()
  const onboarding=input.onboarding?companySetupPlan(input.onboarding):undefined

  if (!/^[A-Z0-9][A-Z0-9_-]{1,15}$/.test(code)) {
    throw new SetupError('BAD_CODE', 'A short code is 2 to 16 letters, digits, - or _ (e.g. ACME).')
  }
  if (name.length < 2) throw new SetupError('BAD_NAME', 'Enter the company name.')

  const month = input.fiscalYearEndMonth ?? 12
  const day = input.fiscalYearEndDay ?? 31
  if (month < 1 || month > 12) throw new SetupError('BAD_YEAR_END', 'Year-end month must be 1 to 12.')
  if (day < 1 || day > longestMonth(month)) {
    throw new SetupError('BAD_YEAR_END', `${monthName(month)} never has ${day} days.`)
  }

  const existing = await db.query.entity.findFirst({ where: eq(entity.code, code) })
  if (existing) throw new SetupError('DUPLICATE_CODE', `A company with the code ${code} already exists.`)
  const sharing = await folderTakenBy(name)
  if (sharing) {
    throw new SetupError('NAME_TAKEN',
      `A company called ${sharing} is already here. Give this one a different name — the two would share one folder of papers.`)
  }

  return db.transaction(async (tx) => {
    const [company] = await tx.insert(entity).values({
      code, name,
      legalName: input.legalName?.trim() || null,
      province: input.province || null,
      businessNumber: input.businessNumber?.trim() || null,
      fiscalYearEndMonth: month,
      fiscalYearEndDay: day,
    }).returning()

    const [book] = await tx.insert(ledger).values({
      entityId: company.id,
      code: 'PRIMARY',
      name: `${name} — Primary`,
      purpose: 'statutory',
      accountingStandard: 'IFRS',
      isPrimary: true,
    }).returning()

    await tx.execute(sqlAudit(actor, 'create_company', 'entity', company.id, { code, name, ...(onboarding?{onboarding}:{}) }))
    return { company, ledger: book }
  })
}

/**
 * The end of the fiscal year we are currently IN — the first year end falling on
 * or after today.
 *
 * Not the year end that has most recently passed: that is the year just closed,
 * and a company created in August would have got a fiscal year ending eight
 * months ago, so nothing dated today could be posted to it.
 */
export function currentYearEnd(month: number, day: number, today = new Date()): string {
  // All local. Asking the UTC clock what year it is gave a company created on
  // the evening of 31 December a fiscal year ending a year later than it should
  // — nothing dated that day could be posted to it, which is the failure this
  // function exists to prevent.
  const here = partsOf(today)
  const todayHere = `${here.year}-${pad(here.month)}-${pad(here.day)}`
  return fiscalEndOn(month,day,todayHere)
}


/**
 * Create a company AND the fiscal year it is currently in.
 *
 * A company with no fiscal year can do nothing at all — not a single entry can
 * be posted — so making the owner create one as a separate step was asking them
 * to complete a setup that was never optional.
 */
/**
 * A company somebody can start keeping books in: the fiscal year, AND the
 * accounts the books themselves rest on.
 *
 * SEPARATE FROM `createCompanyWithYear` on purpose. Nineteen suites build
 * companies with that one and then paste their own charts; seeding inside it
 * would change what every one of them counts. More than that, the primitive
 * should stay a primitive — this is the door a PERSON comes through, and being
 * handed a working chart is a courtesy to a person, not a property of the
 * table.
 *
 * The owner asked why the overview warned about missing accounts instead of
 * the accounts simply being there (2026-09-16), and they were right: a warning
 * is a poor substitute for the thing working. The core roles arrive; the tax
 * and payroll ones do not, because somebody with no employees should not be
 * handed a payroll liability account. The overview still names those if they
 * are ever needed.
 *
 * `seeded` comes back so the screen can say what it did rather than leave
 * accounts appearing from nowhere.
 */
/**
 * THE ACCOUNTS A NEW COMPANY STARTS WITH.
 *
 * Picked out of the GIFI starter chart BY ROLE, never typed again: one chart
 * in this tree, and these are the rows of it that carry a core role. So a new
 * company gets exactly the codes the paste screen would have given it, and
 * adding a core capability adds its account with no second list.
 *
 * It lives HERE and not beside the declarations because those are imported by
 * seven modules and must stay a leaf — reaching from there into `accounts.ts`
 * built a cycle that `tsc` and every suite missed and `next build` died on
 * (2026-09-16). Making a company is this file's job anyway.
 *
 * Cash yields two rows rather than one: the starter chart carries both a till
 * and a chequing account and calls both cash. That is the chart's judgement,
 * not a special case here.
 */
export function coreChartRows() {
  return parseAccountsCsv(STARTER_CHART)
    .filter((row) => (row.roles ?? []).some((role) => CORE_ROLES.includes(role)))
}

/** The wizard offers the existing complete Canadian chart or the original lean foundation. */
export function starterChartRows(chart:SetupChart='core') {
  return chart==='standard'?parseAccountsCsv(STARTER_CHART):coreChartRows()
}

export async function createCompanyReady(input: NewCompany, actor = 'system') {
  const made = await createCompanyWithYear(input, actor)
  const seeded = await importAccounts(
    made.company.id,
    starterChartRows(input.onboarding?.chart).map((row) => ({ ...row, entityId: made.company.id })),
    actor,
  )
  await actingAs(actor, tx => initializeModuleCompany(tx, made.company.id, actor, ['/assets', '/inventory']))
  return { ...made, seeded }
}

export async function createCompanyWithYear(input: NewCompany, actor = 'system') {
  const created = await createCompany(input, actor)
  const end = currentYearEnd(created.company.fiscalYearEndMonth, created.company.fiscalYearEndDay)
  const year = await createFiscalYear(created.ledger.id, end, actor)
  return { ...created, year: year.year, periodCount: year.periodCount }
}

/**
 * Twelve monthly periods for the year ENDING on the given date.
 *
 * The year runs from the day after the previous year end. A 30 June year end
 * therefore gives 1 July to 30 June, and each period is a calendar month —
 * which is what every bookkeeper and every bank statement already assumes.
 */
export async function createFiscalYear(ledgerId: string, endDate: string, actor = 'system') {
  const book = await db.query.ledger.findFirst({ where: eq(ledger.id, ledgerId) })
  if (!book) throw new SetupError('NO_LEDGER', 'That ledger does not exist.')

  const end = parseDate(endDate)
  const { start, periods } = planFiscalYear(end)

  // The year is named for the year it ENDS in: 1 Jul 2026 to 30 Jun 2027 is FY2027.
  const label = `FY${end.getUTCFullYear()}`
  const clash = await db.query.fiscalYear.findFirst({
    where: and(eq(fiscalYear.ledgerId, ledgerId), eq(fiscalYear.name, label)),
  })
  if (clash) throw new SetupError('DUPLICATE_YEAR', `${label} already exists for this ledger.`)

  // R6-7: a new year must continue from the last one. One ordinary click used
  // to be enough to create FY2028 next to FY2026 and leave a twelve-month hole
  // that no constraint and no check would report.
  // A new year must sit flush against what is already there — after the latest,
  // or before the earliest. Anything else leaves a gap, and a gap is a range of
  // dates nothing can ever be posted to.
  const [span] = await db.execute<{ first_start: string; last_end: string; first_name: string; last_name: string }>(sql`
    SELECT min(start_date)::text AS first_start, max(end_date)::text AS last_end,
           (SELECT name FROM fiscal_year WHERE ledger_id = ${ledgerId} ORDER BY start_date LIMIT 1) AS first_name,
           (SELECT name FROM fiscal_year WHERE ledger_id = ${ledgerId} ORDER BY end_date DESC LIMIT 1) AS last_name
      FROM fiscal_year WHERE ledger_id = ${ledgerId}`)

  if (span?.first_start) {
    const afterLast = iso(addDays(parseDate(span.last_end), 1))
    const beforeFirst = iso(addDays(parseDate(span.first_start), -1))
    const followsOn = iso(start) === afterLast
    const runsBefore = iso(end) === beforeFirst

    if (!followsOn && !runsBefore) {
      throw new SetupError('NOT_CONTIGUOUS',
        `This ledger covers ${span.first_start} to ${span.last_end}. ` +
        `The next year must start ${afterLast}, or an earlier year must end ${beforeFirst}. ` +
        `This one would run ${iso(start)} to ${iso(end)}, leaving a gap or an overlap.`)
    }
  }

  return db.transaction(async (tx) => {
    const [year] = await tx.insert(fiscalYear).values({
      ledgerId, name: label, startDate: iso(start), endDate: iso(end),
    }).returning()

    // The EXCLUDE constraint from 0006 rejects this insert if the arithmetic
    // ever produces an overlap, so a bug there fails loudly.
    await tx.insert(fiscalPeriod).values(periods.map((p, i) => ({
      fiscalYearId: year.id,
      ledgerId,
      periodNo: i + 1,
      name: p.name,
      startDate: iso(p.start),
      endDate: iso(p.end),
    })))

    // Carry every account's balance into the new periods.
    //
    // applyBalanceDeltas seeds period_balance only for the periods that exist
    // when an entry is posted, so a year created afterwards had no rows at all
    // — and every statement for it read zero. The balance sheet then showed a
    // fraction of the ledger, balanced perfectly, and reported nothing wrong,
    // because a truncated cache truncates both sides equally.
    await tx.execute(sql`SELECT rebuild_period_balances(${ledgerId}::uuid)`)

    await tx.execute(sqlAudit(actor, 'create_fiscal_year', 'fiscal_year', year.id,
      { name: label, startDate: iso(start), endDate: iso(end), periods: periods.length }))

    return { year, periodCount: periods.length }
  })
}

/**
 * Twelve periods for the year ending on `end`.
 *
 * When the year end is the last day of its month — which covers 31 December,
 * 30 June, 28/29 February and every other ordinary choice — the periods are
 * calendar months. That is what a bookkeeper and a bank statement both assume.
 *
 * The naive "start = end minus twelve months plus a day, then add a month
 * repeatedly" gives the wrong answer here. For a 28 February year end it lands
 * on 29 February of the preceding leap year and anchors every period to the
 * 29th, producing a period labelled 2024-12 that runs 29 December to 28 January.
 * A 15 December invoice then files into a period named 2024-11.
 *
 * A genuinely mid-month year end (the 15th, say) has no calendar months to use,
 * so those periods run day-after to day-of.
 *
 * Every period is named for the month it ENDS in, which is unique in both cases.
 */
export function planFiscalYear(end: Date) {
  const endsOnMonthEnd = end.getUTCDate() === daysInMonth(end.getUTCFullYear(), end.getUTCMonth() + 1)

  const periods: Array<{ start: Date; end: Date; name: string }> = []

  if (endsOnMonthEnd) {
    const lastStart = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
    for (let i = 11; i >= 0; i--) {
      const pStart = addMonths(lastStart, -i)
      const pEnd = new Date(Date.UTC(
        pStart.getUTCFullYear(), pStart.getUTCMonth(),
        daysInMonth(pStart.getUTCFullYear(), pStart.getUTCMonth() + 1)))
      periods.push({ start: pStart, end: pEnd, name: monthKey(pEnd) })
    }
  } else {
    const start = addDays(addMonths(end, -12), 1)
    for (let i = 0; i < 12; i++) {
      const pStart = i === 0 ? start : addDays(addMonths(end, i - 12), 1)
      const pEnd = addMonths(end, i - 11)
      periods.push({ start: pStart, end: pEnd, name: monthKey(pEnd) })
    }
  }

  return { start: periods[0].start, periods }
}

// ------------------------------------------------------------------- dates --
// Plain UTC arithmetic. Local time zones would shift a period boundary by a day
// twice a year, which in a ledger means entries landing in the wrong month.

function parseDate(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim())
  if (!m) throw new SetupError('BAD_DATE', `"${s}" is not a date in YYYY-MM-DD form.`)
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if (d.getUTCMonth() !== +m[2] - 1) throw new SetupError('BAD_DATE', `${s} is not a real date.`)
  return d
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000)

/** Clamps to the last day of the target month: 31 Mar minus one month is 28/29 Feb. */
function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + n
  const day = Math.min(d.getUTCDate(), daysInMonth(y + Math.floor(m / 12), ((m % 12) + 12) % 12 + 1))
  return new Date(Date.UTC(y, m, day))
}

/** The most days this month ever has, February included. Used to validate a year end. */
const longestMonth = (m1to12: number) => (m1to12 === 2 ? 29 : daysInMonth(2027, m1to12))
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
export const monthName = (m: number) =>
  ['January','February','March','April','May','June','July','August','September','October','November','December'][m - 1]

const sqlAudit = (actor: string, action: string, table: string, id: string, after: unknown) => sql`
  INSERT INTO audit_log (actor, action, table_name, record_id, after)
  VALUES (${actor}, ${action}, ${table}, ${id}, ${JSON.stringify(after)}::jsonb)`

export { CANADIAN_PROVINCES } from './provinces'

/**
 * Delete a fiscal year created by mistake — the wrong year end, or a year made
 * before it was needed (0084; owner, 2026-09-16: 「所有的紀錄儘量都可以編輯刪除」).
 *
 * Only a year that holds nothing: open, no entry of any status dated in it, no
 * SR&ED claim for it. And only the first or the last year of the ledger, for the
 * reason `createFiscalYear` refuses a gap: a hole in the middle is a range of
 * dates nothing could ever be posted to. Its periods go with it.
 */
export async function deleteFiscalYear(ledgerId: string, fiscalYearId: string, actor: string) {
  const [y] = await db.execute<{
    name: string; status: string; start_date: string; end_date: string
    entries: number; claims: number; closed_periods: number; is_edge: boolean
  }>(sql`
    SELECT fy.name, fy.status, fy.start_date::text, fy.end_date::text,
           (SELECT count(*)::int FROM journal_entry je
             WHERE je.ledger_id = fy.ledger_id
               AND (je.period_id IN (SELECT id FROM fiscal_period WHERE fiscal_year_id = fy.id)
                    OR je.entry_date BETWEEN fy.start_date AND fy.end_date)) AS entries,
           (SELECT count(*)::int FROM sred_claim WHERE fiscal_year_id = fy.id) AS claims,
           (SELECT count(*)::int FROM fiscal_period WHERE fiscal_year_id = fy.id AND status <> 'open') AS closed_periods,
           (NOT EXISTS (SELECT 1 FROM fiscal_year o WHERE o.ledger_id = fy.ledger_id AND o.start_date > fy.start_date)
            OR NOT EXISTS (SELECT 1 FROM fiscal_year o WHERE o.ledger_id = fy.ledger_id AND o.start_date < fy.start_date)) AS is_edge
      FROM fiscal_year fy WHERE fy.id = ${fiscalYearId}::uuid AND fy.ledger_id = ${ledgerId}::uuid`)
  if (!y) throw new SetupError('NO_YEAR', 'That fiscal year is not in these books.')
  if (y.entries > 0) {
    throw new SetupError('YEAR_IN_USE',
      `${y.name} has ${y.entries} entr${y.entries === 1 ? 'y' : 'ies'} dated in it, so it stays. Only an empty year can be deleted.`)
  }
  if (y.claims > 0) {
    throw new SetupError('YEAR_IN_USE', `${y.name} has an SR&ED claim. Delete the claim first.`)
  }
  if (y.status !== 'open' || y.closed_periods > 0) {
    throw new SetupError('YEAR_CLOSED', `${y.name} has closed periods. Reopen them first.`)
  }
  if (!y.is_edge) {
    throw new SetupError('YEAR_IN_THE_MIDDLE',
      `${y.name} sits between two other years; deleting it would leave dates nothing can be posted to. `
      + 'Only the first or the last year can be deleted.')
  }
  await actingAs(actor, async (tx) => {
    await tx.execute(sql`DELETE FROM fiscal_year WHERE id = ${fiscalYearId}::uuid`)
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before)
      VALUES (${actor}, 'delete_fiscal_year', 'fiscal_year', ${fiscalYearId},
              ${JSON.stringify({ name: y.name, start: y.start_date, end: y.end_date })}::jsonb)`)
  })
  return { name: y.name }
}
