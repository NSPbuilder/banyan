import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { partyAddressLine } from '../parties'
import { PayrollError } from './rates'
import type { Frequency } from './engine'

/**
 * A Record of Employment, block by block — what the books can answer, and what
 * they cannot.
 *
 * The owner asked for 「roe基本信息…呈现总结by employee」: a summary per person,
 * not a filed ROE. Service Canada's own form is filled on ROE Web or on paper,
 * and this is the sheet somebody works from while doing that.
 *
 * WHAT MAKES THIS HARD TO GET RIGHT, and why the numbers below are looked up
 * rather than remembered: Blocks 15A, 15B and 15C each cover a DIFFERENT number
 * of pay periods, and the number depends on the pay-period type. Getting one
 * wrong understates somebody's benefit claim. The counts are from Service
 * Canada's employer guide (canada.ca, "How to complete the record of employment
 * form"), read on 2026-09-03:
 *
 *              15A hours   15B earnings   15C list (paper / electronic)
 *   Weekly          53          27             27 / 53
 *   Bi-weekly       27          14             14 / 27
 *   Semi-monthly    25          13             13 / 25
 *   Monthly         13           7              7 / 13
 *   13 a year       14           7              7 / 14
 *
 * They are MAXIMA: fewer if the employment was shorter. Paper ROEs have 27
 * fields for Block 15C; ROE Web takes the longer list, and Service Canada asks
 * for it, so both are given.
 *
 * The two frequencies CRA supports and Service Canada does not — 22 and 10 pay
 * periods a year — have no pay-period type on the form. This says so rather
 * than guessing a count, because a guess here is somebody's claim.
 */

/** How many periods each block covers, by pay-period type. */
type BlockSpan = { hours15A: number; earnings15B: number; paper15C: number; web15C: number }

const SPANS: Partial<Record<Frequency, BlockSpan>> = {
  weekly: { hours15A: 53, earnings15B: 27, paper15C: 27, web15C: 53 },
  biweekly: { hours15A: 27, earnings15B: 14, paper15C: 14, web15C: 27 },
  semi_monthly: { hours15A: 25, earnings15B: 13, paper15C: 13, web15C: 25 },
  monthly: { hours15A: 13, earnings15B: 7, paper15C: 7, web15C: 13 },
  four_weekly: { hours15A: 14, earnings15B: 7, paper15C: 7, web15C: 14 },
}

/** What Service Canada calls each pay-period type in Block 6. */
const BLOCK_6: Partial<Record<Frequency, string>> = {
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  semi_monthly: 'Semi-monthly',
  monthly: 'Monthly',
  four_weekly: '13 pay periods a year',
}

/** One period on the Block 15C list, newest first. */
export type RoePeriod = {
  payDate: string
  periodEnd: string | null
  /** Cents. */
  insurable: bigint
  /** Hundredths of an hour; zero when none was recorded. */
  hours: bigint
}

export type RoeSummary = {
  employeeId: string
  name: string
  /** Block 8. */
  sin: string | null
  /** Block 9. */
  address: string | null
  /** Block 13. */
  occupation: string | null
  /** Block 6, in Service Canada's own words — null when the form has no such type. */
  payPeriodType: string | null
  frequency: Frequency
  /** Block 10 — first day worked. */
  firstDayWorked: string | null
  /** Block 11 — last day for which paid. */
  lastDayPaid: string | null
  /** Block 12 — the end of the pay period containing Block 11. */
  finalPeriodEnd: string | null
  /** True when Block 12 is the pay DATE standing in for a period end nobody entered. */
  finalPeriodEndIsPayDate: boolean
  /**
   * Block 15A, over `span.hours15A` periods. Null when no hours were recorded,
   * and null when there is no span to take — see `span`.
   */
  insurableHours: bigint | null
  /** Block 15B, over `span.earnings15B` periods. Null when there is no span. */
  insurableEarnings: bigint | null
  /** Block 15C, newest first, as long as ROE Web will take. Empty without a span. */
  periods: RoePeriod[]
  /**
   * Null for a pay frequency Service Canada's form has no type for. When it is
   * null, EVERY figure above that depends on a period count is null too: the
   * first version fell back to "all the periods there are", which for an
   * employee of two years is a multi-year total typed into Block 15B — the
   * figure a benefit rate is worked out from (critic). The docstring said it
   * refused to guess while the code guessed.
   */
  span: BlockSpan | null
  /** How many periods each figure above actually covers — fewer if shorter. */
  covered: { hours: number; earnings: number; hoursRecorded: number }
  /** Blocks nobody can derive from a ledger. Shown, never guessed. */
  toSupply: Array<{ block: string; label: string; why: string }>
}

export async function roeSummary(ledgerId: string, employeeId: string): Promise<RoeSummary> {
  const [who] = await db.execute<{
    id: string; name: string; sin: string | null; occupation: string | null
    frequency: Frequency; hired_on: string | null; address: string | null
    role_from: string | null; role_to: string | null
  }>(sql`
    SELECT pe.id::text, p.name, pe.sin, pe.occupation, pe.frequency,
           pe.hired_on::text,
           ${partyAddressLine(sql`p.id`)} AS address,
           -- The employee ROLE is the framework's own record of when they were
           -- employed here. Payroll does not keep a second copy of it.
           (SELECT min(pr.held_from)::text FROM party_role pr
             WHERE pr.party_id = p.id AND pr.entity_id = pe.entity_id
               AND pr.role = 'employee') AS role_from,
           -- The role's end date, but ONLY when no employee role is still open:
           -- max() skips nulls, so somebody rehired after a termination would
           -- otherwise report the OLD leaving date as Block 11 (critic).
           (SELECT CASE WHEN bool_or(pr.held_to IS NULL) THEN NULL
                        ELSE max(pr.held_to)::text END
              FROM party_role pr
             WHERE pr.party_id = p.id AND pr.entity_id = pe.entity_id
               AND pr.role = 'employee') AS role_to
      FROM payroll_employee pe
      JOIN party p ON p.id = pe.party_id
     WHERE pe.id = ${employeeId}::uuid
       AND pe.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)`)
  if (!who) {
    throw new PayrollError('NO_EMPLOYEE', 'That payroll record is not this company\'s.')
  }

  const span = SPANS[who.frequency] ?? null

  // Every standing period, newest first. Not bounded by year: an ROE looks back
  // across the calendar year end and always has.
  const all = await db.execute<{
    pay_date: string; period_end: string | null; insurable: string; hours: string
  }>(sql`
    SELECT pr.pay_date::text, pr.period_end::text, ps.insurable::text, ps.hours::text
      FROM pay_stub ps
      JOIN pay_run pr ON pr.id = ps.pay_run_id
      JOIN journal_entry je ON je.id = pr.entry_id AND je.status = 'posted'
     WHERE ps.employee_id = ${employeeId}::uuid
       AND pr.ledger_id = ${ledgerId}::uuid
     ORDER BY pr.pay_date DESC, ps.id`)

  const periods: RoePeriod[] = all.map((r) => ({
    payDate: r.pay_date,
    periodEnd: r.period_end,
    insurable: BigInt(r.insurable),
    hours: BigInt(r.hours),
  }))

  // No span, no totals. There is no honest number to give.
  const overHours = span ? periods.slice(0, span.hours15A) : []
  const overEarnings = span ? periods.slice(0, span.earnings15B) : []
  const anyHours = overHours.some((p) => p.hours > 0n)

  const latest = periods[0]
  return {
    employeeId: who.id,
    name: who.name,
    sin: who.sin,
    address: who.address,
    occupation: who.occupation,
    payPeriodType: BLOCK_6[who.frequency] ?? null,
    frequency: who.frequency,
    // Payroll owns the hiring fact. Old role dates are a legacy fallback;
    // newly registered parties have no start date to substitute for it.
    firstDayWorked: who.hired_on ?? who.role_from,
    lastDayPaid: who.role_to ?? latest?.periodEnd ?? latest?.payDate ?? null,
    finalPeriodEnd: latest?.periodEnd ?? latest?.payDate ?? null,
    finalPeriodEndIsPayDate: latest !== undefined && latest.periodEnd === null,
    insurableHours: span && anyHours ? overHours.reduce((t, p) => t + p.hours, 0n) : null,
    insurableEarnings: span ? overEarnings.reduce((t, p) => t + p.insurable, 0n) : null,
    periods: span ? periods.slice(0, span.web15C) : [],
    span,
    // How many of those periods actually had hours entered: a total over 27
    // periods of which three carry hours is not 27 periods of hours, and Block
    // 15A read that way understates an EI claim (whole-project audit).
    covered: {
      hours: overHours.length, earnings: overEarnings.length,
      hoursRecorded: overHours.filter((p) => p.hours > 0n).length,
    },
    toSupply: [
      {
        block: '16', label: 'Reason for issuing this ROE',
        why: 'A code from A to M — shortage of work, quit, dismissal, and so on. '
          + 'It is a fact about why the employment ended, which no ledger holds.',
      },
      {
        block: '17', label: 'Vacation pay, statutory holiday pay, other monies',
        why: 'Payroll carries one gross figure a period and does not know which part '
          + 'of it was vacation pay, nor what is owed on separation.',
      },
      {
        block: '14', label: 'Expected date of recall',
        why: 'Only meaningful for a layoff, and it is a plan rather than a record.',
      },
      {
        block: '18', label: 'Comments',
        why: 'Service Canada asks that this be left empty unless the situation is '
          + 'genuinely unusual — a comment sends the claim for manual review.',
      },
    ],
  }
}
