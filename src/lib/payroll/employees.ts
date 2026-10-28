import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { actingAs } from '../acting'
import { causesOf } from '../db-errors'
import { PayrollError } from './rates'
import { FREQUENCIES, type Frequency } from './engine'

/**
 * Who is on the payroll, and what the year has done to them so far.
 *
 * An employee here is a PARTY who holds the `employee` role in this company —
 * the framework owns people, and this module owns only what payroll needs to
 * know about them (how often they are paid, what their TD1 says, what comes
 * off before tax). The database refuses a payroll record for a party without
 * that role; so does this file, earlier and in words.
 *
 * THE YEAR TO DATE IS DERIVED. CPP, CPP2 and EI all stop at an annual maximum,
 * so every period's answer depends on every period before it — which is
 * exactly the sort of running total this repository does not store. It is
 * summed from the pay stubs, every time, and the sum counts only stubs whose
 * pay run is standing in the books: a run that was reversed did not happen,
 * and its contributions must not eat into this year's room.
 */

export type EmployeeRecord = {
  id: string
  party_id: string
  party_name: string
  frequency: Frequency
  federal_claim: string | null
  bc_claim: string | null
  additional_tax: string
  sin: string | null
  occupation: string | null
  hired_on: string | null
  is_active: boolean
  is_specified: boolean
  cpp_exempt: boolean
  ei_exempt: boolean
}

const entityOf = (ledgerId: string) =>
  sql`(SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)`

/** Everyone with a payroll record in this company, retired ones included. */
export function listEmployees(ledgerId: string) {
  return db.execute<EmployeeRecord>(sql`
    SELECT pe.id::text, pe.party_id::text, p.name AS party_name,
           pe.frequency, pe.federal_claim::text, pe.bc_claim::text,
           pe.additional_tax::text,
           pe.sin, pe.occupation, pe.hired_on::text, pe.is_active, pe.is_specified,
           pe.cpp_exempt, pe.ei_exempt
      FROM payroll_employee pe
      JOIN party p ON p.id = pe.party_id
     WHERE pe.entity_id = ${entityOf(ledgerId)}
     ORDER BY pe.is_active DESC, p.name`)
}

/**
 * Parties this company could put on the payroll: they hold the employee role
 * and have no payroll record yet. The form offers these and nothing else, so
 * the trigger's refusal is a backstop rather than the first thing a person
 * meets.
 */
export function eligibleParties(ledgerId: string) {
  return db.execute<{ id: string; name: string }>(sql`
    SELECT p.id::text, p.name
      FROM party p
      JOIN party_role pr ON pr.party_id = p.id
       AND pr.entity_id = ${entityOf(ledgerId)}
       AND pr.role = 'employee'
     WHERE NOT EXISTS (
             SELECT 1 FROM payroll_employee pe
              WHERE pe.party_id = p.id AND pe.entity_id = pr.entity_id)
     GROUP BY p.id, p.name
     ORDER BY p.name`)
}

export type EmployeeInput = {
  ledgerId: string
  /** Absent for a new record. */
  id?: string
  partyId: string
  frequency: string
  /** Cents. Null or undefined means claim code 1 — the basic amount. */
  federalClaim?: bigint | null
  bcClaim?: bigint | null
  additionalTax?: bigint
  sin?: string | null
  /** ROE Block 13. */
  occupation?: string | null
  hiredOn?: string | null
  isActive?: boolean
  /**
   * ITA 248(1) "specified employee": someone who does not deal at arm's length
   * with the company, or owns 10% or more of any class of its shares. It is a
   * person's answer, not a derivation — this system holds the share register
   * that would settle the second half and nothing that settles the first, and a
   * relationship is not a shareholding. Ticked, the SR&ED 5 x YMPE cap applies
   * to their year and only 75% of the capped figure enters the proxy base.
   */
  isSpecified?: boolean
  /**
   * Exempt from CPP (over 70, or a CPT30 election on file) or from EI (an
   * owner controlling more than 40% of the voting shares, EIA 5(2)(b)). A
   * person's answer, like `isSpecified`; off means the ordinary employee.
   */
  cppExempt?: boolean
  eiExempt?: boolean
  actor: string
}

function checkedFrequency(raw: string): Frequency {
  if (!(raw in FREQUENCIES)) {
    throw new PayrollError('BAD_FREQUENCY',
      `"${raw}" is not a pay frequency. CRA's are: ${Object.keys(FREQUENCIES).join(', ')}.`)
  }
  return raw as Frequency
}

/** A social insurance number, or the refusal that says why it is not one. */
function checkedSin(raw?: string | null): string | null {
  const digits = (raw ?? '').replace(/[\s-]/g, '')
  if (!digits) return null
  if (!/^\d{9}$/.test(digits)) {
    throw new PayrollError('BAD_SIN', 'A social insurance number is nine digits.')
  }
  // The Luhn check SIN numbers carry. A typo that passes it is possible; one
  // that fails it is certainly a typo, and this is the last place anyone will
  // look at the number before it goes on a T4.
  const sum = [...digits].reduce((acc, ch, i) => {
    const d = Number(ch)
    if (i % 2 === 0) return acc + d
    const doubled = d * 2
    return acc + (doubled > 9 ? doubled - 9 : doubled)
  }, 0)
  if (sum % 10 !== 0) {
    throw new PayrollError('BAD_SIN',
      'That is nine digits, but it is not a valid social insurance number — check it against the card.')
  }
  return digits
}

const notNegative = (v: bigint | undefined, what: string): bigint => {
  const amount = v ?? 0n
  if (amount < 0n) throw new PayrollError('NEGATIVE', `${what} cannot be less than nothing.`)
  return amount
}

export async function saveEmployee(input: EmployeeInput) {
  const frequency = checkedFrequency(input.frequency)
  const sin = checkedSin(input.sin)
  const additionalTax = notNegative(input.additionalTax, 'Additional tax')
  for (const [claim, what] of [[input.federalClaim, 'federal'], [input.bcClaim, 'BC']] as const) {
    if (claim != null && claim < 0n) {
      throw new PayrollError('NEGATIVE', `A ${what} TD1 claim cannot be less than nothing.`)
    }
  }

  try {
    if (input.id) {
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE payroll_employee SET
          frequency = ${frequency}, federal_claim = ${input.federalClaim ?? null},
          bc_claim = ${input.bcClaim ?? null}, additional_tax = ${additionalTax},
          sin = ${sin}, occupation = ${input.occupation || null},
          hired_on = ${input.hiredOn || null}::date,
          is_active = ${input.isActive ?? true},
          is_specified = ${input.isSpecified ?? false},
          cpp_exempt = ${input.cppExempt ?? false}, ei_exempt = ${input.eiExempt ?? false}
        WHERE id = ${input.id}::uuid
          AND entity_id = ${entityOf(input.ledgerId)}
        RETURNING id::text`)
      if (rows.length === 0) {
        throw new PayrollError('NO_EMPLOYEE', 'That payroll record is not this company\'s.')
      }
      return rows[0]
    }
    const [row] = await db.execute<{ id: string }>(sql`
      INSERT INTO payroll_employee (entity_id, party_id, frequency, federal_claim, bc_claim,
                                    additional_tax, sin, occupation, hired_on,
                                    is_active, is_specified, cpp_exempt, ei_exempt, created_by)
      VALUES (${entityOf(input.ledgerId)}, ${input.partyId}::uuid, ${frequency},
              ${input.federalClaim ?? null}, ${input.bcClaim ?? null},
              ${additionalTax}, ${sin}, ${input.occupation || null},
              ${input.hiredOn || null}::date, ${input.isActive ?? true},
              ${input.isSpecified ?? false}, ${input.cppExempt ?? false}, ${input.eiExempt ?? false},
              ${input.actor})
      RETURNING id::text`)
    return row
  } catch (e) {
    throw translate(e)
  }
}

/**
 * Take somebody off the payroll who was put on it by mistake (0084) — never
 * paid, and no SR&ED hours against them. A person who has been paid stays: the
 * stubs are the year's record and the T4 is summed from them; unticking Active
 * retires them instead. The person stays on the company's list either way.
 */
export async function deleteEmployee(ledgerId: string, employeeId: string, actor: string) {
  const [held] = await db.execute<{ name: string; stubs: number; hours: number }>(sql`
    SELECT p.name,
           (SELECT count(*)::int FROM pay_stub WHERE employee_id = e.id) AS stubs,
           (SELECT count(*)::int FROM sred_time WHERE employee_id = e.id) AS hours
      FROM payroll_employee e JOIN party p ON p.id = e.party_id
     WHERE e.id = ${employeeId}::uuid AND e.entity_id = ${entityOf(ledgerId)}`)
  if (!held) throw new PayrollError('NO_EMPLOYEE', 'That payroll record is not this company\'s.')
  if (held.stubs > 0) {
    throw new PayrollError('WAS_PAID',
      `${held.name} has been paid ${held.stubs} time${held.stubs === 1 ? '' : 's'}, and those stubs are the year's record, `
      + 'so the payroll record stays. Untick Active to take them off future pay runs.')
  }
  if (held.hours > 0) {
    throw new PayrollError('HAS_SRED_TIME',
      `${held.name} has ${held.hours} day${held.hours === 1 ? '' : 's'} of SR&ED hours recorded. Delete those first, `
      + 'or untick Active.')
  }
  await actingAs(actor, async (tx) => {
    await tx.execute(sql`DELETE FROM payroll_employee WHERE id = ${employeeId}::uuid`)
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before)
      VALUES (${actor}, 'delete_employee', 'payroll_employee', ${employeeId},
              ${JSON.stringify({ name: held.name })}::jsonb)`)
  })
  return { name: held.name }
}

/**
 * Re-exported under the name payroll already uses. The implementation is
 * `db-errors.ts` — it had been written three separate times, each by somebody
 * meeting the same surprise (a refusal that fires correctly and reads as no
 * refusal at all) without knowing the other two existed.
 */
export { causesOf as fullMessage }

/** The database's own refusals, said in words a person can act on. */
export function translate(e: unknown): unknown {
  const message = causesOf(e)
  if (message.includes('NOT_AN_EMPLOYEE')) {
    return new PayrollError('NOT_AN_EMPLOYEE',
      'That person is not an employee of this company. Give them the employee role first — '
      + 'payroll pays employees, and the ledger will not let a line name anyone else.')
  }
  if (message.includes('payroll_employee_entity_id_party_id_key')) {
    return new PayrollError('ALREADY_ON_PAYROLL',
      'That person already has a payroll record in this company. Edit that one.')
  }
  if (message.includes('pay_run_idempotency_key')) {
    return new PayrollError('ALREADY_RUN',
      'That payroll has already been run. Look for it in the list rather than running it again.')
  }
  if (message.includes('PAYROLL_POSTED')) {
    return new PayrollError('PAYROLL_POSTED',
      'That pay run is in the books. Reverse its journal entry, then run the payroll again.')
  }
  return e
}

/** Everything the year has taken from one employee before a given pay date. */
export type YearToDate = {
  gross: bigint
  pensionable: bigint
  insurable: bigint
  cpp: bigint
  cpp2: bigint
  ei: bigint
  federalTax: bigint
  provincialTax: bigint
  incomeTax: bigint
  netPay: bigint
  employerCpp: bigint
  employerCpp2: bigint
  employerEi: bigint
  periods: number
}

/** Nobody has been paid yet this year. */
export const ZERO_YTD: YearToDate = {
  gross: 0n, pensionable: 0n, insurable: 0n, cpp: 0n, cpp2: 0n, ei: 0n,
  federalTax: 0n, provincialTax: 0n, incomeTax: 0n, netPay: 0n,
  employerCpp: 0n, employerCpp2: 0n, employerEi: 0n, periods: 0,
}

/**
 * The year to date for several employees at once, summed from their stubs.
 *
 * `before` bounds it: a run dated 15 June asks what the year did up to but not
 * including that day, because CPP's and EI's remaining room is what is left
 * before this period, not after it. Two runs on the SAME date (a special run
 * beside the regular one) is the case this cannot see; CRA's own answer is
 * that they should have been one period, and the engine would need the
 * combined gross to get the exemption right.
 *
 * Only stubs of runs whose entry is standing count. A reversed run did not
 * happen.
 *
 * Bound to the LEDGER, not merely to the employee: an entity may keep several
 * ledgers (0001 allows statutory, tax and management), and a payroll record
 * belongs to the entity. Without this it and `stubsFor` would be answering
 * slightly different questions and agreeing only because `createCompany`
 * happens to make one ledger each (critic).
 */
/**
 * The year is the CALLER's, stated, never derived from the bound. A pay run
 * asks for everything before its own pay date in that pay date's year; a T4
 * asks for the whole of a year by passing 1 January next. Deriving the year
 * from the bound served both — until a pay date of 1 January: "the day before"
 * is the previous year, and the first cheque of a new year would have
 * inherited the whole old year as its year-to-date, met every ceiling at once
 * and withheld no CPP and no EI (whole-project audit, 2026-09-13; live the
 * day a second year's tables are added).
 */
export async function yearToDate(ledgerId: string, employeeIds: string[], before: string, year: number) {
  const found = new Map<string, YearToDate>()
  if (employeeIds.length === 0) return found

  const rows = await db.execute<{
    employee_id: string; gross: string; pensionable: string; insurable: string
    cpp: string; cpp2: string; ei: string; federal_tax: string; provincial_tax: string
    income_tax: string; net_pay: string; employer_cpp: string; employer_cpp2: string
    employer_ei: string; periods: string
  }>(sql`
    SELECT ps.employee_id::text,
           SUM(ps.gross)::text AS gross, SUM(ps.pensionable)::text AS pensionable,
           SUM(ps.insurable)::text AS insurable, SUM(ps.cpp)::text AS cpp,
           SUM(ps.cpp2)::text AS cpp2, SUM(ps.ei)::text AS ei,
           SUM(ps.federal_tax)::text AS federal_tax,
           SUM(ps.provincial_tax)::text AS provincial_tax,
           SUM(ps.income_tax)::text AS income_tax, SUM(ps.net_pay)::text AS net_pay,
           SUM(ps.employer_cpp)::text AS employer_cpp,
           SUM(ps.employer_cpp2)::text AS employer_cpp2,
           SUM(ps.employer_ei)::text AS employer_ei,
           COUNT(*)::text AS periods
      FROM pay_stub ps
      JOIN pay_run pr ON pr.id = ps.pay_run_id
      JOIN journal_entry je ON je.id = pr.entry_id AND je.status = 'posted'
     WHERE ps.employee_id IN (${sql.join(employeeIds.map((id) => sql`${id}::uuid`), sql`, `)})
       AND pr.ledger_id = ${ledgerId}::uuid
       AND date_part('year', pr.pay_date) = ${year}
       AND pr.pay_date < ${before}::date
     GROUP BY ps.employee_id`)

  for (const id of employeeIds) found.set(id, ZERO_YTD)
  for (const r of rows) {
    found.set(r.employee_id, {
      gross: BigInt(r.gross), pensionable: BigInt(r.pensionable),
      insurable: BigInt(r.insurable), cpp: BigInt(r.cpp), cpp2: BigInt(r.cpp2),
      ei: BigInt(r.ei), federalTax: BigInt(r.federal_tax),
      provincialTax: BigInt(r.provincial_tax), incomeTax: BigInt(r.income_tax),
      netPay: BigInt(r.net_pay), employerCpp: BigInt(r.employer_cpp),
      employerCpp2: BigInt(r.employer_cpp2), employerEi: BigInt(r.employer_ei),
      periods: Number(r.periods),
    })
  }
  return found
}

/**
 * One employee's stubs for a calendar YEAR, newest first.
 *
 * The same span `yearToDate` sums, deliberately: the page shows both, and the
 * first version bounded the totals to a year and the table to nothing at all —
 * so a prior-year stub or a future-dated run sat in the table, outside the
 * totals, with nothing saying why (critic).
 */
export function stubsFor(ledgerId: string, employeeId: string, year: number) {
  return db.execute<{
    id: string; pay_run_id: string; pay_date: string; edition: string; frequency: string
    gross: string; cpp: string; cpp2: string; ei: string
    federal_tax: string; provincial_tax: string; additional_tax: string
    income_tax: string; net_pay: string
    employer_cpp: string; employer_cpp2: string; employer_ei: string
    entry_id: string | null; entry_no: string | null; status: string | null
  }>(sql`
    SELECT ps.id::text, ps.pay_run_id::text, pr.pay_date::text, ps.edition, ps.frequency,
           ps.gross::text, ps.cpp::text, ps.cpp2::text, ps.ei::text,
           ps.federal_tax::text, ps.provincial_tax::text, ps.additional_tax::text,
           ps.income_tax::text,
           ps.net_pay::text, ps.employer_cpp::text, ps.employer_cpp2::text,
           ps.employer_ei::text,
           pr.entry_id::text, je.entry_no, je.status::text
      FROM pay_stub ps
      JOIN pay_run pr ON pr.id = ps.pay_run_id
      LEFT JOIN journal_entry je ON je.id = pr.entry_id
     WHERE ps.employee_id = ${employeeId}::uuid
       AND pr.ledger_id = ${ledgerId}::uuid
       AND date_part('year', pr.pay_date) = ${year}
     ORDER BY pr.pay_date DESC, ps.id`)
}
