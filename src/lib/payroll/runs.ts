import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { accountWithRole } from '../accounts'
import { loadEditions } from './editions'
import { ROLE } from '../roles'
import { postEntryCore, type PostEntryLine } from '../posting'
import { calculatePayroll, type Frequency, type PayrollResult } from './engine'
import { PayrollError } from './rates'
import { ZERO_YTD, translate, yearToDate, type YearToDate } from './employees'

/**
 * A pay run: what each employee is owed on a given day, and the one journal
 * entry that says so.
 *
 * COMPUTED AND POSTED IN ONE ACT. There is no draft pay run, deliberately. A
 * saved-but-unposted run would be a second answer to "what has this year
 * paid" — the year to date is summed from stubs, and a stub that has not
 * reached the books either counts (and overstates CPP room used) or does not
 * (and makes the saved figures a lie the moment they are posted). So the
 * preview is a pure calculation that writes nothing, and the run is a
 * transaction that writes everything or nothing.
 *
 * THE ENTRY, and why it is shaped this way (owner, 2026-09-03):
 *
 *   Dr  Salaries and wages   gross, one line per employee, naming them
 *   Dr  Salaries and wages   employer CPP  ┐ same account, their own lines, so
 *   Dr  Salaries and wages   employer EI   ┘ the T4 and the PD7A can be read
 *   Cr  Bank                 net pay, the whole run in one movement
 *   Cr  Payroll liabilities  CPP, EI and income tax — three lines, one debt
 *
 * Net pay is credited straight to the bank («直接贷银行»): this is what the
 * owner does — one transfer on payday, no wages-payable stop along the way.
 * The employer's share goes to the same expense account as the wages
 * («可以和工资同一账户，但是考虑未来报T4，需要细分»), and the breakdown the T4
 * will need lives on the stubs, per employee, where the ledger's summed lines
 * cannot reach.
 *
 * The debits foot to the credits by construction: gross + employer share on
 * one side, and on the other (gross − deductions) + (deductions + employer
 * share). `postEntry` will refuse anything else, which is the point of it
 * being the only door.
 */

/**
 * What a payday owes CRA: both sides of CPP and EI, plus the tax withheld.
 *
 * ONE definition, taken by anything shaped like a stub — the computed ones,
 * the stored ones the run list sums, the stored ones a run's own page shows.
 * It was written out three times (twice in TypeScript, once in SQL) and the
 * three agreed only because nothing had changed yet (critic).
 */
export const remittanceOf = (s: {
  cpp: bigint; cpp2: bigint; ei: bigint; incomeTax: bigint
  employerCpp: bigint; employerCpp2: bigint; employerEi: bigint
}): bigint =>
  s.cpp + s.cpp2 + s.ei + s.incomeTax + s.employerCpp + s.employerCpp2 + s.employerEi

// Named in src/lib/needed-roles.ts, where the capability that needs them is
// declared, so the readiness view and this code cannot mean different roles.
const WAGES_ROLE = ROLE.wages
const LIABILITY_ROLE = ROLE.payrollLiability
const BANK_ROLE = ROLE.cash

/** What one employee is being paid this period, before the engine sees it. */
export type PayLine = {
  employeeId: string
  /** Cents. The period's taxable gross, benefits included. */
  gross: bigint
  /** Defaults to the gross. Set these only when a part of the pay is not both. */
  pensionable?: bigint
  insurable?: bigint
  /**
   * Insurable hours in HUNDREDTHS — 37.5 hours is 3750n. Nothing computes with
   * them; ROE Block 15A is the reason they exist (0052).
   */
  hours?: bigint
  /**
   * How much of `gross` was a bonus or profit-based pay. A MEMO: it changes no
   * figure on this stub — CPP, EI, tax and the net are worked out from `gross`
   * exactly as before. The SR&ED proxy salary base has to exclude it (0072,
   * owner 2026-09-11), and until this existed nothing could tell a bonus from
   * a fortnight's salary.
   */
  bonus?: bigint
}

export type ComputedStub = PayrollResult & {
  employeeId: string
  partyId: string
  name: string
  frequency: Frequency
  gross: bigint
  pensionable: bigint
  insurable: bigint
  hours: bigint
  additionalTax: bigint
  /** Memo, carried so the stub row can store it. Computes nothing (0072). */
  bonus: bigint
  /** What the year had already taken, before this period. */
  ytd: YearToDate
}

export type PayRunPreview = {
  payDate: string
  stubs: ComputedStub[]
  totals: {
    gross: bigint
    cpp: bigint
    cpp2: bigint
    ei: bigint
    incomeTax: bigint
    netPay: bigint
    employerCpp: bigint
    employerCpp2: bigint
    employerEi: bigint
    /** What goes to CRA: both sides of CPP and EI, plus the tax withheld. */
    remittance: bigint
    /** What the run costs the company. */
    cost: bigint
  }
}

type EmployeeForRun = {
  id: string
  party_id: string
  name: string
  frequency: Frequency
  federal_claim: string | null
  bc_claim: string | null
  additional_tax: string
  is_active: boolean
  cpp_exempt: boolean
  ei_exempt: boolean
}

async function employeesForRun(ledgerId: string, ids: string[]) {
  if (ids.length === 0) {
    throw new PayrollError('NOBODY', 'A pay run needs at least one person on it.')
  }
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) {
      throw new PayrollError('TWICE',
        'Someone is on this run twice. One pay period is one line — add the amounts together.')
    }
    seen.add(id)
  }
  const rows = await db.execute<EmployeeForRun>(sql`
    SELECT pe.id::text, pe.party_id::text, p.name, pe.frequency,
           pe.federal_claim::text, pe.bc_claim::text,
           pe.additional_tax::text, pe.is_active, pe.cpp_exempt, pe.ei_exempt
      FROM payroll_employee pe
      JOIN party p ON p.id = pe.party_id
     WHERE pe.id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
       AND pe.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)`)

  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const id of ids) {
    const found = byId.get(id)
    if (!found) {
      throw new PayrollError('NO_EMPLOYEE',
        'One of those payroll records does not belong to this company.')
    }
    if (!found.is_active) {
      throw new PayrollError('NOT_ACTIVE',
        `${found.name} is not on the active payroll. Make the record active again to pay them.`)
    }
  }
  return byId
}

const claim = (v: string | null): bigint | undefined => (v == null ? undefined : BigInt(v))

/**
 * What the run WOULD be. Writes nothing, so a person can look at the figures
 * before the money moves — and so a check can assert the arithmetic without
 * touching the ledger.
 */
export async function previewPayRun(input: {
  ledgerId: string
  /** 'YYYY-MM-DD' — the day the money moves. It chooses the CRA edition. */
  payDate: string
  lines: PayLine[]
}): Promise<PayRunPreview> {
  // The editions added in the app (0082) join the list before anything is
  // computed — here, so the run and the preview both have them. Without them a
  // pay date they cover is refused, never mis-priced.
  await loadEditions()
  const employees = await employeesForRun(input.ledgerId, input.lines.map((l) => l.employeeId))
  const ytdByEmployee = await yearToDate(input.ledgerId, [...employees.keys()], input.payDate,
    Number(input.payDate.slice(0, 4)))

  const stubs: ComputedStub[] = input.lines.map((line) => {
    const e = employees.get(line.employeeId)!
    if (line.gross <= 0n) {
      throw new PayrollError('NOT_POSITIVE', `${e.name}'s pay for this period must be more than nothing.`)
    }
    // An exempt person has no pensionable, or no insurable, earnings: the
    // stub records nought, the engine withholds nought, box 24 or 26 says
    // nought, and box 28 says why (0074).
    if (e.cpp_exempt && line.pensionable !== undefined && line.pensionable !== 0n) {
      throw new PayrollError('EXEMPT', `${e.name} is exempt from CPP — leave pensionable earnings blank.`)
    }
    if (e.ei_exempt && line.insurable !== undefined && line.insurable !== 0n) {
      throw new PayrollError('EXEMPT', `${e.name} is not insurable for EI — leave insurable earnings blank.`)
    }
    const pensionable = e.cpp_exempt ? 0n : (line.pensionable ?? line.gross)
    const insurable = e.ei_exempt ? 0n : (line.insurable ?? line.gross)
    if (pensionable > line.gross || insurable > line.gross) {
      throw new PayrollError('MORE_THAN_GROSS',
        `${e.name}'s pensionable and insurable earnings cannot be more than the gross.`)
    }
    if (pensionable < 0n || insurable < 0n) {
      throw new PayrollError('NEGATIVE', 'Pensionable and insurable earnings cannot be negative.')
    }
    // The same two questions the other per-line figures are asked. Without them
    // a typed `-100` reached the INSERT and came back as 0072's raw CHECK
    // violation instead of a sentence naming the person (independent critic,
    // 2026-09-11).
    const bonus = line.bonus ?? 0n
    if (bonus < 0n) {
      throw new PayrollError('NEGATIVE', `${e.name}'s bonus cannot be negative.`)
    }
    if (bonus > line.gross) {
      throw new PayrollError('MORE_THAN_GROSS',
        `${e.name}'s bonus is part of the gross, so it cannot be more than it.`)
    }
    const hours = line.hours ?? 0n
    if (hours < 0n) {
      throw new PayrollError('NEGATIVE', 'Hours cannot be negative.')
    }
    const ytd = ytdByEmployee.get(line.employeeId) ?? ZERO_YTD
    const additionalTax = BigInt(e.additional_tax)
    const result = calculatePayroll({
      payDate: input.payDate,
      frequency: e.frequency,
      gross: line.gross,
      pensionable,
      insurable,
      // T4127's F and U1 are deliberately not passed: the engine subtracts
      // them from income for tax but nothing withholds them from the pay, so
      // offering them would compute a net pay the employee is not paid (0052).
      federalClaim: claim(e.federal_claim),
      bcClaim: claim(e.bc_claim),
      additionalTax,
      ytdPensionable: ytd.pensionable,
      ytdCpp: ytd.cpp,
      ytdCpp2: ytd.cpp2,
      ytdEi: ytd.ei,
    })
    return {
      ...result,
      employeeId: line.employeeId,
      partyId: e.party_id,
      name: e.name,
      frequency: e.frequency,
      gross: line.gross,
      pensionable,
      insurable,
      hours,
      additionalTax,
      // Not passed to the engine above on purpose: a bonus is taxed by a method
      // this system does not implement, and letting this reach the calculation
      // would claim otherwise. It rides along to the stub row and nowhere else.
      bonus,
      ytd,
    }
  })

  // A TD1 asking for more extra tax than the pay can carry. The database
  // refuses the stub, but only after the run has been half written, and the
  // entry it would have made BALANCES — a debit to the bank on payday — so
  // postEntry would have had nothing to object to (critic).
  for (const s of stubs) {
    if (s.netPay < 0n) {
      throw new PayrollError('NEGATIVE_NET_PAY',
        `${s.name} would be paid ${(Number(s.netPay) / 100).toFixed(2)} — the deductions come `
        + 'to more than the pay. Check the extra tax on their record against this period\'s gross.')
    }
  }

  const sum = (f: (s: ComputedStub) => bigint) => stubs.reduce((t, s) => t + f(s), 0n)
  const cpp = sum((s) => s.cpp)
  const cpp2 = sum((s) => s.cpp2)
  const ei = sum((s) => s.ei)
  const incomeTax = sum((s) => s.incomeTax)
  const employerCpp = sum((s) => s.employerCpp)
  const employerCpp2 = sum((s) => s.employerCpp2)
  const employerEi = sum((s) => s.employerEi)
  const gross = sum((s) => s.gross)

  return {
    payDate: input.payDate,
    stubs,
    totals: {
      gross, cpp, cpp2, ei, incomeTax,
      netPay: sum((s) => s.netPay),
      employerCpp, employerCpp2, employerEi,
      remittance: remittanceOf({
        cpp, cpp2, ei, incomeTax, employerCpp, employerCpp2, employerEi,
      }),
      cost: gross + employerCpp + employerCpp2 + employerEi,
    },
  }
}

/**
 * Run the payroll: compute it, store the stubs, and post the entry — all in
 * one transaction, so there is never a run in the database that the books have
 * not heard of, nor an entry with no stubs behind it.
 */
export async function runPayroll(input: {
  ledgerId: string
  payDate: string
  periodStart?: string
  periodEnd?: string
  bankAccountId: string
  lines: PayLine[]
  actor: string
  idempotencyKey?: string
}) {
  // A replay returns the payday that already happened and writes nothing. The
  // key is on the RUN and not only on the entry: `postEntry`'s own idempotency
  // would hand back the original entry while this function went on to write a
  // second run against it, and the year to date — summed from stubs — would
  // count the period twice.
  if (input.idempotencyKey) {
    const [already] = await db.execute<{ run_id: string; entry_id: string; entry_no: string }>(sql`
      SELECT pr.id::text AS run_id, pr.entry_id::text, je.entry_no
        FROM pay_run pr
        JOIN journal_entry je ON je.id = pr.entry_id
       WHERE pr.idempotency_key = ${input.idempotencyKey}
         AND pr.ledger_id = ${input.ledgerId}::uuid`)
    if (already) {
      // No figures are recomputed here. The first version returned a fresh
      // `previewPayRun`, which answers from TODAY's year to date rather than
      // from the stubs that payday actually wrote — a second answer to "what
      // did this run pay" — and could refuse outright if the employee had since
      // been taken off the payroll (critic). What that payday paid is on its
      // stubs: `payRunDetail`.
      return {
        runId: already.run_id, entryId: already.entry_id, entryNo: already.entry_no,
        preview: undefined, replayed: true as const,
      }
    }
  }

  const preview = await previewPayRun(input)
  const { totals } = preview

  const [bank] = await db.execute<{ ok: boolean }>(sql`
    SELECT (a.is_postable AND a.is_active) AS ok
      FROM account a
      JOIN account_role ar ON ar.account_id = a.id AND ar.role = ${BANK_ROLE}
     WHERE a.id = ${input.bankAccountId}::uuid
       AND a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${input.ledgerId}::uuid)`)
  if (!bank || !bank.ok) {
    throw new PayrollError('NOT_A_BANK_ACCOUNT',
      'Net pay must come out of an active account with the cash-and-cash-equivalents role.')
  }

  const [[wages], [liability]] = await Promise.all([
    accountWithRole(input.ledgerId, WAGES_ROLE),
    db.execute<{id:string;code:string;name:string}>(sql`SELECT a.id::text,a.code,a.name FROM account a JOIN account_role ar ON ar.account_id=a.id JOIN ledger l ON l.entity_id=a.entity_id WHERE l.id=${input.ledgerId}::uuid AND ar.role=${LIABILITY_ROLE} AND a.is_active AND a.is_postable AND NOT EXISTS(SELECT 1 FROM operations_account m JOIN operations_account_specs(m.seat) sp ON sp.key=m.key WHERE m.account_id=a.id AND sp.controlled) ORDER BY a.code LIMIT 1`),
  ])
  if (!wages) {
    throw new PayrollError('NO_WAGES_ACCOUNT',
      `No active account carries the ${WAGES_ROLE} role. Tag one in the chart of accounts `
      + '— the starter chart calls it "Salaries and wages".')
  }
  if (!liability) {
    throw new PayrollError('NO_LIABILITY_ACCOUNT',
      `No active account carries the ${LIABILITY_ROLE} role. Tag one in the chart of accounts `
      + '— it is what you owe CRA between payday and the remittance.')
  }

  // Signed cents, debit positive. A zero line is left out rather than posted:
  // an employer with no EI room left this year owes nothing, and a line for
  // nothing is noise in the journal.
  const lines: PostEntryLine[] = [
    ...preview.stubs.map((s) => ({
      accountId: wages.id,
      amount: s.gross,
      description: `${s.name} — gross pay`,
      partyId: s.partyId,
    })),
    ...(totals.employerCpp + totals.employerCpp2 > 0n ? [{
      accountId: wages.id,
      amount: totals.employerCpp + totals.employerCpp2,
      description: "Employer's CPP",
    }] : []),
    ...(totals.employerEi > 0n ? [{
      accountId: wages.id,
      amount: totals.employerEi,
      description: "Employer's EI",
    }] : []),
    { accountId: input.bankAccountId, amount: -totals.netPay, description: 'Net pay' },
    ...(totals.cpp + totals.cpp2 + totals.employerCpp + totals.employerCpp2 > 0n ? [{
      accountId: liability.id,
      amount: -(totals.cpp + totals.cpp2 + totals.employerCpp + totals.employerCpp2),
      description: 'CPP payable — both shares',
    }] : []),
    ...(totals.ei + totals.employerEi > 0n ? [{
      accountId: liability.id,
      amount: -(totals.ei + totals.employerEi),
      description: 'EI payable — both shares',
    }] : []),
    ...(totals.incomeTax > 0n ? [{
      accountId: liability.id,
      amount: -totals.incomeTax,
      description: 'Income tax withheld',
    }] : []),
  ]

  const period = input.periodStart && input.periodEnd
    ? ` for ${input.periodStart} to ${input.periodEnd}`
    : ''
  const who = preview.stubs.length === 1
    ? preview.stubs[0].name
    : `${preview.stubs.length} employees`

  try {
    return await db.transaction(async (tx) => {
      const [run] = await tx.execute<{ id: string }>(sql`
        INSERT INTO pay_run (ledger_id, pay_date, period_start, period_end,
                             bank_account_id, idempotency_key, created_by)
        VALUES (${input.ledgerId}::uuid, ${input.payDate}::date,
                ${input.periodStart || null}::date, ${input.periodEnd || null}::date,
                ${input.bankAccountId}::uuid, ${input.idempotencyKey ?? null}, ${input.actor})
        RETURNING id::text`)

      for (const s of preview.stubs) {
        await tx.execute(sql`
          INSERT INTO pay_stub (pay_run_id, employee_id, edition, frequency, gross,
                                pensionable, insurable, hours, cpp, cpp2, ei, federal_tax,
                                provincial_tax, additional_tax, income_tax, net_pay,
                                employer_cpp, employer_cpp2, employer_ei, bonus)
          VALUES (${run.id}::uuid, ${s.employeeId}::uuid, ${s.edition}, ${s.frequency},
                  ${s.gross}, ${s.pensionable}, ${s.insurable}, ${s.hours},
                  ${s.cpp}, ${s.cpp2},
                  ${s.ei}, ${s.federalTax}, ${s.provincialTax}, ${s.additionalTax},
                  ${s.incomeTax}, ${s.netPay}, ${s.employerCpp}, ${s.employerCpp2},
                  ${s.employerEi}, ${s.bonus})`)
      }

      const { entry } = await postEntryCore(tx, {
        ledgerId: input.ledgerId,
        entryDate: input.payDate,
        description: `Payroll ${input.payDate} — ${who}${period}`,
        sourceType: 'payroll',
        sourceId: run.id,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        lines,
      })

      await tx.execute(sql`
        UPDATE pay_run SET entry_id = ${entry.id}::uuid WHERE id = ${run.id}::uuid`)

      return {
        runId: run.id, entryId: entry.id, entryNo: entry.entryNo,
        preview: preview as PayRunPreview | undefined,
        replayed: false as const,
      }
    })
  } catch (e) {
    throw translate(e)
  }
}

/**
 * Every pay run in this company's books, newest first. The SQL sums the PARTS;
 * what goes to CRA is added up by `remittanceOf` like everywhere else, so the
 * list cannot come to a different figure than the run's own page.
 */
export async function payRuns(ledgerId: string) {
  const rows = await db.execute<{
    id: string; pay_date: string; period_start: string | null; period_end: string | null
    entry_id: string | null; entry_no: string | null; status: string | null
    people: string; gross: string; net_pay: string
    cpp: string; cpp2: string; ei: string; income_tax: string
    employer_cpp: string; employer_cpp2: string; employer_ei: string
  }>(sql`
    SELECT pr.id::text, pr.pay_date::text, pr.period_start::text, pr.period_end::text,
           pr.entry_id::text, je.entry_no, je.status::text,
           COUNT(ps.id)::text AS people,
           COALESCE(SUM(ps.gross), 0)::text AS gross,
           COALESCE(SUM(ps.net_pay), 0)::text AS net_pay,
           COALESCE(SUM(ps.cpp), 0)::text AS cpp,
           COALESCE(SUM(ps.cpp2), 0)::text AS cpp2,
           COALESCE(SUM(ps.ei), 0)::text AS ei,
           COALESCE(SUM(ps.income_tax), 0)::text AS income_tax,
           COALESCE(SUM(ps.employer_cpp), 0)::text AS employer_cpp,
           COALESCE(SUM(ps.employer_cpp2), 0)::text AS employer_cpp2,
           COALESCE(SUM(ps.employer_ei), 0)::text AS employer_ei
      FROM pay_run pr
      LEFT JOIN journal_entry je ON je.id = pr.entry_id
      LEFT JOIN pay_stub ps ON ps.pay_run_id = pr.id
     WHERE pr.ledger_id = ${ledgerId}::uuid
     GROUP BY pr.id, je.entry_no, je.status
     ORDER BY pr.pay_date DESC, pr.created_at DESC`)

  return rows.map((r) => ({
    ...r,
    remittance: remittanceOf({
      cpp: BigInt(r.cpp), cpp2: BigInt(r.cpp2), ei: BigInt(r.ei),
      incomeTax: BigInt(r.income_tax), employerCpp: BigInt(r.employer_cpp),
      employerCpp2: BigInt(r.employer_cpp2), employerEi: BigInt(r.employer_ei),
    }),
  }))
}

/** One pay run, with a stub per person — the payday's own paper. */
export async function payRunDetail(ledgerId: string, runId: string) {
  const [run] = await db.execute<{
    id: string; pay_date: string; period_start: string | null; period_end: string | null
    entry_id: string | null; entry_no: string | null; status: string | null
    bank_account_id: string; bank_code: string; bank_name: string
  }>(sql`
    SELECT pr.id::text, pr.pay_date::text, pr.period_start::text, pr.period_end::text,
           pr.entry_id::text, je.entry_no, je.status::text,
           a.id::text AS bank_account_id, a.code AS bank_code, a.name AS bank_name
      FROM pay_run pr
      JOIN account a ON a.id = pr.bank_account_id
      LEFT JOIN journal_entry je ON je.id = pr.entry_id
     WHERE pr.id = ${runId}::uuid AND pr.ledger_id = ${ledgerId}::uuid`)
  if (!run) return null

  const stubs = await db.execute<{
    id: string; employee_id: string; name: string; edition: string; frequency: string
    gross: string; pensionable: string; insurable: string; hours: string; bonus: string
    cpp: string; cpp2: string; ei: string; federal_tax: string; provincial_tax: string
    additional_tax: string; income_tax: string; net_pay: string
    employer_cpp: string; employer_cpp2: string; employer_ei: string
  }>(sql`
    SELECT ps.id::text, ps.employee_id::text, p.name, ps.edition, ps.frequency,
           ps.gross::text, ps.pensionable::text, ps.insurable::text, ps.hours::text, ps.bonus::text,
           ps.cpp::text, ps.cpp2::text, ps.ei::text, ps.federal_tax::text,
           ps.provincial_tax::text, ps.additional_tax::text, ps.income_tax::text,
           ps.net_pay::text, ps.employer_cpp::text, ps.employer_cpp2::text,
           ps.employer_ei::text
      FROM pay_stub ps
      JOIN payroll_employee pe ON pe.id = ps.employee_id
      JOIN party p ON p.id = pe.party_id
     WHERE ps.pay_run_id = ${runId}::uuid
     ORDER BY p.name`)

  return { run, stubs }
}

/** The bank accounts a pay run may draw on. */
export function payrollBankAccounts(ledgerId: string) {
  return db.execute<{ id: string; code: string; name: string }>(sql`
    SELECT a.id::text, a.code, a.name
      FROM account a
      JOIN account_role ar ON ar.account_id = a.id AND ar.role = ${BANK_ROLE}
     WHERE a.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
       AND a.is_postable AND a.is_active
     ORDER BY a.code`)
}

// -------------------------------------------------------------- PD7A ----

/**
 * What CRA is owed for one month of paydays — the figures a PD7A asks for.
 *
 * A regular remitter remits what was withheld in a month by the 15th of the
 * next month, and the month is the month of the PAY DATE: CRA's rule is "the
 * day you paid", not the period the pay was for (19.5, and PR43). Every figure
 * is a sum over the stubs of the runs paid that month; what goes to CRA is
 * `remittanceOf`, the same definition as everywhere else.
 *
 * "Number of employees" is the count in the LAST pay period of the month —
 * the latest pay date, and among runs paid that day the period that ends last
 * — which is what the form asks, not everybody paid at any point in it.
 *
 * Quarterly and accelerated remitters exist; this shows monthly and says so.
 * Whether the remittance was PAID is not decided here: a payment to CRA is an
 * ordinary entry against the payroll-liabilities account, and the balance of
 * that account is what is still owed.
 */
export type RemittanceMonth = {
  /** 'YYYY-MM' */
  month: string
  /** The 15th of the following month. */
  dueOn: string
  runs: number
  /** Distinct people paid in the month's last pay period. */
  employees: number
  gross: bigint
  cpp: bigint          // both sides, CPP and CPP2
  ei: bigint           // both sides
  incomeTax: bigint
  total: bigint        // remittanceOf
}

export const remittanceDueOn = (month: string): string => {
  const [y, m] = month.split('-').map(Number)
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }
  return `${next.y}-${String(next.m).padStart(2, '0')}-15`
}

export async function remittanceMonths(ledgerId: string, year: number): Promise<RemittanceMonth[]> {
  const rows = await db.execute<{
    month: string; runs: string; employees: string
    gross: string; cpp: string; cpp2: string; ei: string; income_tax: string
    employer_cpp: string; employer_cpp2: string; employer_ei: string
  }>(sql`
    WITH paid AS (
      SELECT to_char(pr.pay_date, 'YYYY-MM') AS month, pr.id AS run_id, pr.pay_date, pr.period_end, ps.*
        FROM pay_run pr
        JOIN pay_stub ps ON ps.pay_run_id = pr.id
        -- A run whose entry was reversed withheld nothing in the end: its
        -- stubs stay (the year to date needs them gone too, and 0051 handles
        -- that), but it is not money CRA is owed. PR46 held the liability
        -- balance against this sum and found the difference.
        JOIN journal_entry je ON je.id = pr.entry_id AND je.status = 'posted'
       WHERE pr.ledger_id = ${ledgerId}::uuid
         AND EXTRACT(YEAR FROM pr.pay_date) = ${year}
    ),
    -- The month's last pay PERIOD: the latest pay date, and among runs paid
    -- that day the one whose period ends last. Two periods paid together on
    -- one day are two periods, and the form asks about the last (critic).
    last_period AS (
      SELECT DISTINCT ON (month) month, run_id FROM paid
       ORDER BY month, pay_date DESC, period_end DESC NULLS LAST, run_id
    )
    SELECT p.month,
           count(DISTINCT p.run_id)::text AS runs,
           (SELECT count(DISTINCT q.employee_id) FROM paid q
             JOIN last_period lp ON lp.month = q.month AND lp.run_id = q.run_id
            WHERE q.month = p.month)::text AS employees,
           sum(p.gross)::text AS gross,
           sum(p.cpp)::text AS cpp, sum(p.cpp2)::text AS cpp2, sum(p.ei)::text AS ei,
           sum(p.income_tax)::text AS income_tax,
           sum(p.employer_cpp)::text AS employer_cpp, sum(p.employer_cpp2)::text AS employer_cpp2,
           sum(p.employer_ei)::text AS employer_ei
      FROM paid p
     GROUP BY p.month
     ORDER BY p.month`)

  return rows.map((r) => {
    const parts = {
      cpp: BigInt(r.cpp), cpp2: BigInt(r.cpp2), ei: BigInt(r.ei), incomeTax: BigInt(r.income_tax),
      employerCpp: BigInt(r.employer_cpp), employerCpp2: BigInt(r.employer_cpp2), employerEi: BigInt(r.employer_ei),
    }
    return {
      month: r.month,
      dueOn: remittanceDueOn(r.month),
      runs: Number(r.runs),
      employees: Number(r.employees),
      gross: BigInt(r.gross),
      cpp: parts.cpp + parts.cpp2 + parts.employerCpp + parts.employerCpp2,
      ei: parts.ei + parts.employerEi,
      incomeTax: parts.incomeTax,
      total: remittanceOf(parts),
    }
  })
}

/**
 * What the statutory payroll-liabilities accounts still hold — what has not been
 * remitted. EVERY account carrying the role, named together, and only the
 * ones a run can post to (active, postable, outside controlled production accruals): the first version named one
 * account and summed all of them (critic, 2026-09-04).
 */
export async function payrollOwed(ledgerId: string): Promise<{ account: string | null; balance: bigint }> {
  const [r] = await db.execute<{ account: string | null; balance: string }>(sql`
    WITH liab AS (
      SELECT a.id, a.code, a.name FROM account a
        JOIN account_role ar ON ar.account_id = a.id AND ar.role = ${LIABILITY_ROLE}
        JOIN ledger l ON l.entity_id = a.entity_id
       WHERE l.id = ${ledgerId}::uuid AND a.is_active AND a.is_postable
         AND NOT EXISTS(SELECT 1 FROM operations_account m JOIN operations_account_specs(m.seat) sp ON sp.key=m.key WHERE m.account_id=a.id AND sp.controlled)
    )
    SELECT (SELECT string_agg(code || ' — ' || name, ', ' ORDER BY code) FROM liab) AS account,
           coalesce((SELECT -sum(jl.amount) FROM journal_line jl
              JOIN journal_entry je ON je.id = jl.entry_id
              JOIN liab ON liab.id = jl.account_id
             WHERE je.ledger_id = ${ledgerId}::uuid AND je.status IN ('posted', 'reversed')), 0)::text AS balance`)
  return { account: r?.account ?? null, balance: BigInt(r?.balance ?? '0') }
}
