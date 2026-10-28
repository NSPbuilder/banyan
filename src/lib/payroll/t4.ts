import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { PayrollError, cppEiForYear } from './rates'
import { loadEditions } from './editions'
import { dollars } from './exact'
import { yearToDate } from './employees'

/**
 * What each employee's T4 says, box by box — for TYPING IN, not for filing.
 *
 * The owner's ask, verbatim (2026-09-03): 「不需要我们能直接出T4 slips和T4
 * summary，只要方便的把每个employee该填的信息呈现出来就行了」. So this produces
 * no slip, no summary and no XML: it lays the figures out beside the box
 * numbers CRA prints on the form, and a person copies them across.
 *
 * That is a deliberately smaller thing than filing, and it is smaller in a way
 * that matters: a wrong figure typed by a person who is looking at the box
 * number is a mistake they can see, and a wrong figure in a filed XML is a
 * reassessment. What this owes them is that every number is right and every
 * number it CANNOT produce says so out loud rather than showing a confident
 * zero.
 *
 * IT SUMS THE SAME ROWS AS EVERYTHING ELSE. `yearToDate` is the one reader of
 * "what has this employee had this year"; the T4 is that answer wearing box
 * numbers. A second query here would be a second answer, and the year to date
 * is already the number the next pay run's CPP ceiling depends on.
 */

/** One line of the form: what CRA calls it, and what goes in it. */
export type T4Box = {
  /** '14', '16A', … — the number printed on the slip. */
  box: string
  label: string
  /** Cents. Null when this module cannot produce the figure. */
  amount: bigint | null
  /** Present when `amount` is null: what would have to exist to fill it. */
  absent?: string
  /** A box that carries a mark rather than money — box 28's "CPP", "EI". */
  text?: string
}

export type T4ForEmployee = {
  employeeId: string
  name: string
  /** Box 12. */
  sin: string | null
  boxes: T4Box[]
  /** Nothing was paid in the year — no slip is due. */
  empty: boolean
}

export type T4Year = {
  year: number
  /** Box 54, and the rest of the employer's own header. */
  employer: {
    name: string
    legalName: string | null
    businessNumber: string | null
    /** Box 10 — the province of employment, the same for everyone here. */
    province: string | null
  }
  employees: T4ForEmployee[]
  /** What a T4 Summary would total, so the owner can check their own typing. */
  totals: { box14: bigint; box16: bigint; box16a: bigint; box18: bigint; box22: bigint }
  /** Said on the page, not buried: what this cannot answer and why. */
  caveats: string[]
}

export async function t4Year(ledgerId: string, year: number): Promise<T4Year> {
  // The same refusal the engine gives, for the same reason: the ceilings below
  // are 2026's, and applying them to another year would cap the boxes at the
  // wrong figures while looking entirely ordinary (critic). `editionFor`
  // refuses by name; this had been left to trust.
  // `cppEiForYear` is the refusal now — one list of years, one place to add
  // the next, and no second copy of "which year do we know" to fall behind.
  // With the editions added in the app read in first (0082).
  await loadEditions()
  const cppEi = cppEiForYear(year)
  const [employer] = await db.execute<{
    name: string; legal_name: string | null; business_number: string | null
    province: string | null
  }>(sql`
    SELECT e.name, e.legal_name, e.business_number, e.province
      FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)

  // No such ledger is not "Unknown company" — the page guarded on a name this
  // function then supplied a default for, so the guard could never fire and a
  // bogus id rendered a worksheet (critic).
  if (!employer) {
    throw new PayrollError('NO_LEDGER', 'There is no such ledger.')
  }

  const staff = await db.execute<{ id: string; name: string; sin: string | null; cpp_exempt: boolean; ei_exempt: boolean }>(sql`
    SELECT pe.id::text, p.name, pe.sin, pe.cpp_exempt, pe.ei_exempt
      FROM payroll_employee pe
      JOIN party p ON p.id = pe.party_id
     WHERE pe.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
     ORDER BY p.name`)

  // The whole calendar year, through the ONE reader. The bound is exclusive,
  // so 1 January next is how a whole year is asked for.
  const ytd = await yearToDate(ledgerId, staff.map((s) => s.id), `${year + 1}-01-01`, year)

  // Boxes 24 and 26 are capped — an employee can earn more than the ceiling,
  // and the box reports the insurable or pensionable amount, not the earnings.
  //
  // Box 26's ceiling is the YAMPE, not the YMPE. CRA: "the amount you used to
  // calculate your employee's CPP/QPP and CPP2/QPP2 contributions … up to the
  // additional maximum pensionable earnings for the year" — because since 2024
  // the box has to support box 16A beside it, and CPP2 is charged on the band
  // ABOVE the YMPE. Capping at the YMPE understated it for everyone paid over
  // $74,600 and made box 26 unable to justify box 16A (critic; checked against
  // canada.ca's T4 slip instructions).
  const mie = dollars(cppEi.ei.mie)
  const yampe = dollars(cppEi.cpp.yampe)
  const atMost = (v: bigint, ceiling: bigint) => (v > ceiling ? ceiling : v)

  const employees: T4ForEmployee[] = staff.map((s) => {
    const t = ytd.get(s.id)!
    const cppAllYear = t.periods > 0 && t.pensionable === 0n
    const eiAllYear = t.periods > 0 && t.insurable === 0n
    // Why box 28 is blank, for THIS person: no pay this year, a flag set after
    // a pay had already been withheld from, or simply not exempt.
    const box28Absent = cppAllYear || eiAllYear ? undefined
      : t.periods === 0
        ? 'No pay in this year, so there was nothing to be exempt from; no slip is issued.'
        : (s.cpp_exempt || s.ei_exempt)
          ? 'The record says exempt now, but contributions were withheld on at least one '
            + 'pay this year. CRA marks box 28 only for a person exempt for the entire '
            + 'period, so it stays blank and boxes 16/18 carry what was withheld.'
          : 'Marked only for a person exempt all year — an owner controlling more than 40% '
            + 'of the voting shares (EI), or over 70 or with a CPT30 election on file (CPP). '
            + 'This person is not.'
    return {
      employeeId: s.id,
      name: s.name,
      sin: s.sin,
      empty: t.periods === 0,
      boxes: [
        { box: '14', label: 'Employment income', amount: t.gross },
        { box: '16', label: "Employee's CPP contributions", amount: t.cpp },
        { box: '16A', label: "Employee's second CPP contributions", amount: t.cpp2 },
        {
          box: '17', label: "Employee's QPP contributions", amount: null,
          absent: 'Quebec only. CRA: do not report anything here when box 10 is a '
            + 'province other than Quebec — and where a box has no value, leave it '
            + 'blank rather than entering nil. This module is BC.',
        },
        { box: '18', label: "Employee's EI premiums", amount: t.ei },
        {
          box: '20', label: 'RPP contributions', amount: null,
          absent: 'This module does not withhold registered pension contributions — '
            + 'see 0052. Nothing was deducted, so nothing belongs in box 20.',
        },
        { box: '22', label: 'Income tax deducted', amount: t.incomeTax },
        { box: '24', label: 'EI insurable earnings', amount: atMost(t.insurable, mie) },
        {
          box: '26', label: 'CPP/QPP pensionable earnings',
          amount: atMost(t.pensionable, yampe),
        },
        // CRA marks box 28 only for a person exempt for the ENTIRE period, so
        // the mark comes from the year's stubs — every pay with nought
        // pensionable, or nought insurable — the same source as boxes 16, 18,
        // 24 and 26, not from the flag as it stands today (independent critic).
        {
          box: '28', label: 'Exempt (CPP/QPP, EI)', amount: null,
          text: [cppAllYear ? 'CPP' : '', eiAllYear ? 'EI' : ''].filter(Boolean).join(', ') || undefined,
          ...(box28Absent ? { absent: box28Absent } : {}),
        },
        {
          box: '44', label: 'Union dues', amount: null,
          absent: 'This module does not withhold union dues — see 0052.',
        },
        {
          box: '45', label: 'Employer-offered dental benefits', amount: null,
          absent: 'A code from 1 to 5, not an amount, and a fact about the benefits '
            + 'you offer rather than about the pay. CRA has required it since 2023.',
        },
        {
          box: '40', label: 'Other taxable allowances and benefits', amount: null,
          absent: 'Payroll carries one gross figure a period and does not know which '
            + 'part of it was a benefit. Enter it from your own record.',
        },
      ],
    }
  })

  const total = (box: string) =>
    employees.reduce((t, e) => t + (e.boxes.find((b) => b.box === box)?.amount ?? 0n), 0n)

  return {
    year,
    employer: {
      name: employer.name,
      legalName: employer.legal_name,
      businessNumber: employer.business_number,
      province: employer.province,
    },
    employees,
    totals: {
      box14: total('14'), box16: total('16'), box16a: total('16A'),
      box18: total('18'), box22: total('22'),
    },
    caveats: [
      'Every figure is summed from the pay stubs of runs still standing in the books. '
      + 'A run whose entry was reversed is not counted, here or anywhere else.',
      'Box 24 stops at the year\'s maximum insurable earnings and box 26 at the '
      + 'ADDITIONAL maximum pensionable earnings — box 26 has to support box 16A '
      + 'beside it, and the second CPP contribution is charged above the first '
      + 'ceiling. The uncapped amounts are on each employee\'s own page.',
      'The employer\'s CPP and EI are not T4 boxes. They belong on the T4 Summary '
      + 'and on the PD7A, and they are on each pay run.',
      'This is a worksheet for typing into CRA\'s form. It is not a slip, and nothing '
      + 'here has been filed.',
    ],
  }
}
