/**
 * Payroll: CRA's answer, and the entry that follows from it.
 *   npm run db:verify-payroll   (resets the database first)
 *
 * TWO CHECKS CARRY THIS SUITE AND EVERY OTHER ONE SERVES THEM.
 *
 * `PR1` and `PR2` are captures from CRA's own Payroll Deductions Online
 * Calculator, brought over unchanged from the project this engine came from.
 * A payroll engine is not "mostly right": it is out by cents every payday,
 * twenty-six times a year, and nobody notices until the T4 does not foot or a
 * remittance is short. So the oracle is CRA, the tolerance is zero, and the
 * arithmetic is exact integers — never a float.
 *
 * The rest is about the machinery around that answer: that the edition is
 * chosen by the pay date and not frozen at whichever one was written first
 * (`PR4`), that the year to date is DERIVED and gives its room back when a run
 * is reversed (`PR10`), and that the entry a run posts is the one the owner
 * asked for and balances (`PR8`, `PR9`).
 */
import './env'
import { reporter } from './suite'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty, endRole, grantRole } from '../src/lib/parties'
import { reverseEntry } from '../src/lib/posting'
import { FREQUENCIES, bpaf, calculatePayroll } from '../src/lib/payroll/engine'
import {
  EDITIONS, FEDERAL_2026, coveredYears, cppEiForYear, editionFor, lastCoveredDate, vetted,
  type RateEdition,
} from '../src/lib/payroll/rates'
import { problemsWith, problemsWithList } from '../src/lib/payroll/rates-check'
import { FREQUENCY_LABEL } from '../src/lib/payroll/labels'
import { PayrollError, setAddedEditions } from '../src/lib/payroll/rates'
import { ALL_FIGURES, EDITION_HEAD, PDOC_FIELDS, editionFromFigures, figureOf } from '../src/lib/payroll/edition-fields'
import { editionRecords, loadEditions } from '../src/lib/payroll/editions'
import { addEditionFromForm, removeEditionFromForm } from '../src/lib/payroll/edition-forms'
import { execFileSync } from 'node:child_process'
import { amendEntry } from '../src/lib/posting'
import { fullMessage, saveEmployee, stubsFor, yearToDate } from '../src/lib/payroll/employees'
import {
  previewPayRun, runPayroll, payRunDetail, payRuns, remittanceDueOn, remittanceMonths,
  remittanceOf, payrollOwed,
} from '../src/lib/payroll/runs'
import { deleteEmployeeFromForm, runPayrollFromForm } from '../src/lib/payroll/forms'
import { t4Year } from '../src/lib/payroll/t4'
import { roeSummary } from '../src/lib/payroll/roe'
import { paychequePdf } from '../src/lib/payroll/paycheque'
import { pdfText, pdfTextAt } from './pdf-text'
import {
  PAYROLL_FIELDS as F, payEmployee, payGross, payHours, payIndicesIn, payInsurable,
  payPensionable,
} from '../src/lib/forms'
import { formatMoney, parseMoney } from '../src/lib/money'

const r = reporter(58)
const { fail, check } = r

/**
 * The summary line and the exit, in ONE place. Written once because the early
 * exit below used to carry its own copy of it — together with a pasted copy of
 * three whole checks, which would have thrown for the same reason the catch
 * was entered and taken the summary with them (critic).
 */
async function done(): Promise<never> {
  // ------------------------------------------------------------ PR49-PR52
  // THE CRA NUMBERS, AND WHAT IT TAKES TO ADD A YEAR.
  //
  // The tables were 2026's and the year was written into `editionFor` as a
  // comparison, so there was nowhere to put 2027 (owner, 2026-09-12). They are
  // a list now, and the four checks below are the list, the arithmetic that
  // vets an entry, the entries on file, and the refusal to compute from one
  // that does not add up. `docs/design/35-the-cra-numbers.md` is the procedure.
  {
    const refusedBy = (run: () => unknown) => {
      try { run(); return '' } catch (e) { return e instanceof PayrollError ? e.code : String(e) }
    }
    const idOn = (d: string) => { try { return editionFor(d).id } catch { return '(refused)' } }
    const june = idOn('2026-06-30')
    const july = idOn('2026-07-01')
    // DERIVED FROM THE LIST, not pinned to 2026. Adding next year's tables is
    // supposed to be adding an entry, and three literals here would have turned
    // this line red on a correct change (independent critic, 2026-09-12).
    const years = coveredYears()
    const last = must(years[years.length - 1], 'a covered year')
    const off = refusedBy(() => editionFor(`${last + 1}-01-15`))
    let says = ''
    try { editionFor(`${last + 1}-01-15`) } catch (e) { says = e instanceof Error ? e.message : '' }
    const namesTheEdge = says.includes(lastCoveredDate())
    const yearKnown = refusedBy(() => cppEiForYear(last))
    const yearNot = refusedBy(() => cppEiForYear(last + 1))
    const edgeRight = lastCoveredDate() === `${last}-12-31`
    const ascending = years.every((y, i) => i === 0 || y > years[i - 1]!)
    check(june === '2026-01' && july === '2026-07' && off === 'NO_TABLES' && namesTheEdge
      && yearKnown === '' && yearNot === 'NO_TABLES' && edgeRight && ascending && years.length > 0,
      'PR49 the tables are a list, chosen by pay date, and a year off the end is refused',
      `30 June → ${june}, 1 July → ${july}; covering ${years.join(', ')}`
        + `${ascending ? '' : ' — NOT in order'}, up to ${lastCoveredDate()}`
        + `${edgeRight ? '' : ` — NOT ${last}'s year end`}; ${last + 1} `
        + `${off || 'ACCEPTED'} and the refusal `
        + `${namesTheEdge ? 'names that edge' : 'does NOT name that edge'}; `
        + `the year's CPP/EI: ${last} ${yearKnown || 'given'}, ${last + 1} ${yearNot || 'GIVEN'}`)
  }

  {
    // PR53 — AND AN EDITION CANNOT BE BORROWED ACROSS A YEAR BOUNDARY.
    //
    // The hole this closes: `editionFor` asked whether the YEAR was covered and
    // then searched backwards for the newest edition starting on or before the
    // date, which walks over the year line. A year whose only edition begins in
    // July would give its March pay dates the PREVIOUS year's July tables — a
    // real table, correctly formed, for the wrong year, so `vetted` passes it
    // (independent critic, 2026-09-12).
    const refusedBy = (run: () => unknown) => {
      try { run(); return '' } catch (e) { return e instanceof PayrollError ? e.code : String(e) }
    }
    const first = must(EDITIONS[0], 'the first edition')
    const before = refusedBy(() => editionFor('2025-12-31'))
    // A list whose year opens in July, checked through the list rules that now
    // run before anything is computed.
    const late = { ...structuredClone(first) as RateEdition, id: 'late', startsOn: '2099-07-01' }
    const holed = problemsWithList([...EDITIONS, late])
    const outOfOrder = problemsWithList([...EDITIONS,
      { ...structuredClone(first) as RateEdition, id: 'back', startsOn: '2020-01-01' }])
    const twinId = problemsWithList([...EDITIONS,
      { ...structuredClone(first) as RateEdition, startsOn: '2099-01-01' }])
    const splitCppEi = (() => {
      const a = structuredClone(first) as RateEdition
      const b = { ...structuredClone(first) as RateEdition, id: 'b', startsOn: '2099-07-01' }
      a.id = 'a'; a.startsOn = '2099-01-01'
      b.cppEi.ei.mie = '70000.00'
      return problemsWithList([a, b])
    })()
    check(before === 'NO_TABLES'
      && holed.some((p) => p.includes('nothing covers the start'))
      && outOfOrder.some((p) => p.includes('not after'))
      && twinId.some((p) => p.includes('two editions are called'))
      && splitCppEi.some((p) => p.includes('different CPP/EI')),
      'PR53 a date cannot borrow another year’s edition, and the list itself is checked',
      `a date before the first edition ${before || 'WENT THROUGH'}; a year opening in July `
        + `${holed.length ? 'is named' : 'is NOT named'}; out of order `
        + `${outOfOrder.length ? 'is named' : 'is NOT named'}; a repeated id `
        + `${twinId.length ? 'is named' : 'is NOT named'}; one year with two sets of CPP/EI `
        + `${splitCppEi.length ? 'is named' : 'is NOT named'}`)
  }

  {
    // Ten ways a pasted edition can be wrong, one at a time, each starting from
    // a table that IS right. What is being checked is not that the numbers on
    // file are good — PR51 does that — but that a bad one would be caught.
    const good = must(EDITIONS[0], 'the first edition on file')
    const broken: Array<[string, (e: RateEdition) => void]> = [
      ['a K constant off by a hundred', (e) => { e.federal.constants[1] = '3904' }],
      ['a bracket out of order', (e) => { e.federal.thresholds[2] = '40000' }],
      ['a rate that does not climb', (e) => { e.bc.rates[2] = '0.0700' }],
      ['lowestRate not the first bracket', (e) => { e.federal.lowestRate = '0.1500' }],
      ['a bracket missing its constant', (e) => { e.bc.constants.pop() }],
      ['the first bracket not starting at 0', (e) => { e.federal.thresholds[0] = '100' }],
      ['the CPP maximum not the rate times the base', (e) => { e.cppEi.cpp.maxContribution = '4230.00' }],
      ['the EI premium ceiling not the MIE times the rate', (e) => { e.cppEi.ei.maxPremium = '1123.00' }],
      ['the CPP rate not its two halves', (e) => { e.cppEi.cpp.firstAdditionalRate = '0.0200' }],
      ['the BPAF spread not the difference', (e) => { e.federal.bpaf.reductionNumerator = '1600' }],
    ]
    const slipped = broken.filter(([, breakIt]) => {
      const e = structuredClone(good) as RateEdition
      breakIt(e)
      return problemsWith(e).wrong.length === 0
    }).map(([what]) => what)
    check(slipped.length === 0,
      'PR50 an edition that cannot be right is caught by the arithmetic, not by a paycheque',
      `${broken.length - slipped.length} of ${broken.length} caught`
        + `${slipped.length ? `; MISSED ${slipped.join('; ')}` : ''}`)
  }

  {
    // And the ones actually on file. The `confirm` list is PRINTED rather than
    // asserted empty: it holds identities CRA is under no obligation to keep,
    // and one edition on file legitimately breaks one — see the note in
    // rates-check.ts. A reader of this line sees what is outstanding.
    const wrong = EDITIONS.flatMap((e) => problemsWith(e).wrong)
    const confirm = EDITIONS.flatMap((e) => problemsWith(e).confirm)
    const listing = problemsWithList(EDITIONS)
    // And the SEVERITY of that rule is held too: a BC reduction that does not
    // spend its credit is a thing to check, not a thing to refuse — otherwise
    // the July edition on file could not compute at all.
    const bent = structuredClone(must(EDITIONS[0], 'the first edition')) as RateEdition
    bent.bc.taxReduction.maxCredit = '900.00'
    const bentSaid = problemsWith(bent)
    const asksRatherThanRefuses = bentSaid.confirm.length === 1 && bentSaid.wrong.length === 0
    check(wrong.length === 0 && listing.length === 0 && asksRatherThanRefuses,
      'PR51 every edition on file adds up, and what only CRA can settle is named',
      `${EDITIONS.length} edition(s), ${wrong.length} that cannot be right`
        + `${wrong.length ? `: ${wrong.join('; ').slice(0, 90)}` : ''}; `
        + `${listing.length} problem(s) with the list itself`
        + `${listing.length ? `: ${listing.join('; ').slice(0, 60)}` : ''}; `
        + `${confirm.length} to confirm against the PDF`
        + `${confirm.length ? `: ${confirm.join(' / ').slice(0, 110)}` : ''}; `
        + `a credit that does not match its own phase-out `
        + `${asksRatherThanRefuses ? 'is asked about, not refused'
             : `gave ${bentSaid.wrong.length} refusal(s) and ${bentSaid.confirm.length} question(s)`}`)
  }

  {
    // ENFORCED, not merely available. A checker nothing calls is a checker.
    const bent = structuredClone(must(EDITIONS[0], 'the first edition')) as RateEdition
    bent.id = 'bent'
    bent.cppEi.cpp.maxContribution = '9999.99'
    let refused = ''
    let named = false
    try { vetted(bent) } catch (e) {
      refused = e instanceof PayrollError ? e.code : String(e)
      named = e instanceof Error && e.message.includes('9999.99')
    }
    // …and what the remembering must NOT do: hand back the edition it saw first
    // when a second one arrives under the same id. Keyed on the id it did —
    // silently, with a `return seen` (independent critic, 2026-09-12).
    const twin = structuredClone(must(EDITIONS[0], 'the first edition')) as RateEdition
    twin.cppEi.ei.mie = '70000.00'
    let twinBack: RateEdition | null = null
    let twinRefused = ''
    try { twinBack = vetted(twin) } catch (e) {
      twinRefused = e instanceof PayrollError ? e.code : String(e)
    }
    const notSwapped = twinRefused !== '' || (twinBack !== EDITIONS[0] && twinBack === twin)
    check(refused === 'BAD_TABLES' && named && notSwapped,
      'PR52 nothing is computed from a table that does not add up',
      `a bent edition ${refused || 'WENT THROUGH'} and the refusal `
        + `${named ? 'names the figure' : 'does NOT name the figure'}; a second edition under an `
        + `id already seen came back as ${twinRefused || (twinBack === EDITIONS[0]
             ? 'THE FIRST ONE' : 'itself')}`)
  }


  // ------------------------------------------------------------------- PR3
  // A year the tables do not cover is REFUSED, by name. Computing 2027 with
  // 2026's constants is the silent wrongness this module must not have: the
  // answer would look entirely reasonable and be wrong on every line.
  {
    let refused = ''
    try {
      calculatePayroll({ payDate: '2027-01-15', frequency: 'semi_monthly', gross: parseMoney('3000') })
    } catch (e) {
      refused = e instanceof PayrollError ? `${e.code}: ${e.message}` : String(e)
    }
    check(refused.startsWith('NO_TABLES') && refused.includes('2027'),
      'PR3 a pay date outside the tables is refused, saying so',
      refused || 'it computed an answer with the wrong year\'s constants')
  }

  // ------------------------------------------------------------------- PR4
  // The edition is chosen by the PAY DATE. BC's lowest rate went from 5.06%
  // to 6.14% on 1 July 2026, so the same pay in January and in July is not
  // the same provincial tax — and if it were, the edition would be decorative.
  {
    const shape = { frequency: 'semi_monthly' as const, gross: parseMoney('3000.00') }
    const jan = calculatePayroll({ ...shape, payDate: '2026-06-30' })
    const jul = calculatePayroll({ ...shape, payDate: '2026-07-01' })
    check(jan.edition === '2026-01' && jul.edition === '2026-07'
          && jan.provincialTax !== jul.provincialTax
          && jan.federalTax === jul.federalTax,
      'PR4 one day later is the July table, and BC tax moves',
      `30 Jun BC ${$(jan.provincialTax)} (${jan.edition}) → 1 Jul BC ${$(jul.provincialTax)} `
      + `(${jul.edition}); federal unchanged at ${$(jan.federalTax)}`)
  }

  // ------------------------------------------------------------------- PR5
  // CPP stops at the annual maximum, and the LAST period is capped to what is
  // left rather than charged the full rate. An engine that only checks "is the
  // year to date at the maximum" over-deducts on the way there.
  {
    const nearly = calculatePayroll({
      payDate: '2026-03-15', frequency: 'semi_monthly', gross: parseMoney('4000.00'),
      ytdPensionable: parseMoney('70000.00'), ytdCpp: parseMoney('4200.00'),
    })
    const done = calculatePayroll({
      payDate: '2026-03-15', frequency: 'semi_monthly', gross: parseMoney('4000.00'),
      ytdPensionable: parseMoney('74600.00'), ytdCpp: parseMoney('4230.45'),
    })
    check(nearly.cpp === parseMoney('30.45') && done.cpp === 0n,
      'PR5 CPP is capped to the room left, then stops',
      `$30.45 of room left → ${$(nearly.cpp)}; at the maximum → ${$(done.cpp)}`)
  }

  // ------------------------------------------------------------------- PR6
  // Above the YMPE, CPP stops and CPP2 begins — a second contribution on the
  // band from $74,600 to $85,000, which is not the same thing as CPP running on.
  {
    const second = calculatePayroll({
      payDate: '2026-03-15', frequency: 'semi_monthly', gross: parseMoney('4000.00'),
      ytdPensionable: parseMoney('76000.00'), ytdCpp: parseMoney('4230.45'),
    })
    check(second.cpp === 0n && second.cpp2 === parseMoney('160.00'),
      'PR6 above the YMPE the second contribution takes over',
      `CPP ${$(second.cpp)}, CPP2 ${$(second.cpp2)} on $4,000 of the second band`)
  }

  // ------------------------------------------------------------------- PR7
  {
    const capped = calculatePayroll({
      payDate: '2026-03-15', frequency: 'semi_monthly', gross: parseMoney('4000.00'),
      ytdEi: parseMoney('1100.00'),
    })
    const spent = calculatePayroll({
      payDate: '2026-03-15', frequency: 'semi_monthly', gross: parseMoney('4000.00'),
      ytdEi: parseMoney('1123.07'),
    })
    check(capped.ei === parseMoney('23.07') && spent.ei === 0n
          && capped.employerEi === parseMoney('32.30'),
      'PR7 EI stops at the maximum premium, employer at 1.4×',
      `${$(capped.ei)} left of $1,123.07, employer ${$(capped.employerEi)}; then ${$(spent.ei)}`)
  }

  // -------------------------------------------------------------------------
  // From here the database is involved: a company, a chart, and two people.
  const co = await createCompanyWithYear({ code: 'PRA', name: 'Cedar Works Ltd.' }, 'alicio@example.test')
  const other = await createCompanyWithYear({ code: 'PRB', name: 'Alder Works Ltd.' }, 'alicio@example.test')
  const L = co.ledger.id
  const accts = await importAccounts(co.company.id,
    parseAccountsCsv(chart).map((r) => ({ ...r, entityId: co.company.id })), 'alicio@example.test')
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))

  const hired = '2026-01-01'
  const mkParty = async (name: string, role: 'employee' | 'supplier', entityId = co.company.id) =>
    await createParty({
      kind: 'person', name,
      roles: [{ entityId, role, heldFrom: hired }],
      actor: 'alicio@example.test',
    })

  const dana = await mkParty('Dana Whitfield', 'employee')
  const rey = await mkParty('Rey Okonkwo', 'employee')
  const notStaff = await mkParty('Harbour Stationery', 'supplier')
  // Nobody pays Kai until PR23 does, so the room CPP has left in the year is
  // the whole of it — the claim there is an exact figure, not a subtraction
  // from whatever earlier checks happened to have paid somebody.
  const kai = await mkParty('Kai Ferreira', 'employee')

  const danaRec = await saveEmployee({
    ledgerId: L, partyId: dana.id, frequency: 'semi_monthly',
    federalClaim: parseMoney('16452.00'), bcClaim: parseMoney('13216.00'),
    hiredOn: hired, actor: 'alicio@example.test',
  })
  const reyRec = await saveEmployee({
    ledgerId: L, partyId: rey.id, frequency: 'semi_monthly',
    federalClaim: parseMoney('16452.00'), bcClaim: parseMoney('13216.00'),
    hiredOn: hired, actor: 'alicio@example.test',
  })
  const kaiRec = await saveEmployee({
    ledgerId: L, partyId: kai.id, frequency: 'semi_monthly',
    federalClaim: parseMoney('16452.00'), bcClaim: parseMoney('13216.00'),
    hiredOn: hired, actor: 'alicio@example.test',
  })

  // ------------------------------------------------------------------- PR11
  {
    let refused = ''
    try {
      await saveEmployee({
        ledgerId: L, partyId: notStaff.id, frequency: 'monthly', actor: 'alicio@example.test',
      })
    } catch (e) {
      refused = e instanceof PayrollError ? `${e.code}: ${e.message}` : String(e)
    }
    check(refused.startsWith('NOT_AN_EMPLOYEE') && refused.includes('employee role'),
      'PR11 payroll pays employees, and says so when asked to pay a supplier',
      refused || 'a supplier was put on the payroll')
  }

  // ------------------------------------------------------------------- PR17
  {
    const bad: string[] = []
    for (const [sin, why] of [['12345678', 'eight digits'], ['123456788', 'fails the check digit']]) {
      let refused = ''
      try {
        await saveEmployee({ ledgerId: L, partyId: dana.id, id: danaRec.id,
          frequency: 'semi_monthly', sin, actor: 'alicio@example.test' })
      } catch (e) { refused = e instanceof PayrollError ? e.code : String(e) }
      if (refused !== 'BAD_SIN') bad.push(`${sin} (${why}) → ${refused || 'accepted'}`)
    }
    // And one that is genuinely valid goes in.
    await saveEmployee({ ledgerId: L, partyId: dana.id, id: danaRec.id,
      frequency: 'semi_monthly', federalClaim: parseMoney('16452.00'),
      bcClaim: parseMoney('13216.00'), sin: '046 454 286', hiredOn: hired, actor: 'alicio@example.test' })
    const [stored] = await db.execute<{ sin: string }>(raw`
      SELECT sin FROM payroll_employee WHERE id = ${danaRec.id}::uuid`)
    check(bad.length === 0 && stored?.sin === '046454286',
      'PR17 a social insurance number is nine digits that check out',
      bad.length ? bad.join(' | ') : `stored as ${stored?.sin}, spaces and all removed`)
  }

  // ------------------------------------------------------------------- PR15
  {
    let refused = ''
    try {
      await previewPayRun({ ledgerId: L, payDate: '2026-01-15', lines: [
        { employeeId: danaRec.id, gross: parseMoney('3000.00') },
        { employeeId: danaRec.id, gross: parseMoney('500.00') },
      ]})
    } catch (e) { refused = e instanceof PayrollError ? `${e.code}: ${e.message}` : String(e) }
    check(refused.startsWith('TWICE'),
      'PR15 one person, one line — the same period twice is refused',
      refused || 'the same employee was paid twice in one run, and the exemption applied twice')
  }

  // ------------------------------------------------------------------- PR16
  {
    let refused = ''
    try {
      await previewPayRun({ ledgerId: other.ledger.id, payDate: '2026-01-15',
        lines: [{ employeeId: danaRec.id, gross: parseMoney('3000.00') }] })
    } catch (e) { refused = e instanceof PayrollError ? `${e.code}: ${e.message}` : String(e) }
    check(refused.startsWith('NO_EMPLOYEE'),
      'PR16 one company cannot run another company\'s payroll',
      refused || 'Alder Works paid a Cedar Works employee')
  }

  // ------------------------------------------------------------- PR8, PR9, PR14
  // The run itself: two people, one entry, the shape the owner asked for.
  // Caught rather than left to throw: a run that will not post is a FAILURE
  // of PR8, not a dead suite. A suite that dies partway prints no summary and
  // reads as "nothing was red", which is how two toothless blocks survived a
  // whole node in this repository before.
  let first
  try {
    first = await runPayroll({
      ledgerId: L, payDate: '2026-01-15', periodStart: '2026-01-01', periodEnd: '2026-01-15',
      bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [
        { employeeId: danaRec.id, gross: parseMoney('3000.00') },
        { employeeId: reyRec.id, gross: parseMoney('2400.00') },
      ],
    })
  } catch (e) {
    // The suite stops here rather than carrying on: every check below this
    // point needs the run that just failed. It stops by PRINTING A SUMMARY,
    // which is the whole point — a suite that dies partway prints none, and
    // green from a complete run must not look like green from a truncated one.
    fail('PR8 the entry is the shape the owner asked for',
      `the run would not post at all: ${fullMessage(e).slice(0, 140)}`)
    return done()
  }

  {
    const lines = await db.execute<{
      code: string; name: string; amount: string; description: string; party: string | null
    }>(raw`
      SELECT a.code, a.name, jl.amount::text, jl.description, p.name AS party
        FROM journal_line jl
        JOIN account a ON a.id = jl.account_id
        LEFT JOIN party p ON p.id = jl.party_id
       WHERE jl.entry_id = ${first.entryId}::uuid
       ORDER BY jl.line_no`)
    const at = (code: string) => lines.filter((l) => l.code === code)
    const total = (code: string) => at(code).reduce((t, l) => t + BigInt(l.amount), 0n)
    const t = first.preview!.totals

    const wages = at('9060')
    const named = wages.filter((l) => l.party !== null)
    // Not just "two lines carry a party": each named line must carry THAT
    // person's own gross. Swapping the two amounts left every earlier
    // assertion true (critic).
    const mismatched = named.filter((l) => {
      const theirs = first.preview!.stubs.find((s) => s.name === l.party)
      return !theirs || BigInt(l.amount) !== theirs.gross
    })
    check(total('1000') === -t.netPay
          && total('2627') === -t.remittance
          && total('9060') === t.cost
          && named.length === 2 && mismatched.length === 0
          && named.some((l) => l.party === 'Dana Whitfield')
          && named.some((l) => l.party === 'Rey Okonkwo')
          && wages.some((l) => l.description === "Employer's CPP")
          && wages.some((l) => l.description === "Employer's EI"),
      'PR8 the entry is the shape the owner asked for',
      mismatched.length > 0
        ? `${mismatched.length} wage line(s) carry somebody else's gross: `
          + mismatched.map((l) => `${l.party} ${$(BigInt(l.amount))}`).join(', ')
        : `bank ${$(-total('1000'))} = net pay; payroll liabilities ${$(-total('2627'))} = remittance; `
          + `wages ${$(total('9060'))} across ${wages.length} lines, `
          + `${named.length} naming the employee and each carrying their own gross`)

    // Against what the STUBS say, not against the totals object the entry was
    // built from — and not against `debits === credits`, which `validateEntry`
    // guarantees before this check can run, nor against
    // `cost === netPay + remittance`, which is an identity given the
    // definitions in previewPayRun (critic). A second reader, or nothing.
    const [stored] = await db.execute<{
      net: string; cra: string; cost: string
    }>(raw`
      SELECT SUM(ps.net_pay)::text AS net,
             SUM(ps.cpp + ps.cpp2 + ps.ei + ps.income_tax
                 + ps.employer_cpp + ps.employer_cpp2 + ps.employer_ei)::text AS cra,
             SUM(ps.gross + ps.employer_cpp + ps.employer_cpp2 + ps.employer_ei)::text AS cost
        FROM pay_stub ps WHERE ps.pay_run_id = ${first.runId}::uuid`)
    const debits = lines.reduce((t2, l) => t2 + (BigInt(l.amount) > 0n ? BigInt(l.amount) : 0n), 0n)
    // SUM over no rows is a row of nulls, not no row — so this is guarded on
    // the VALUES, not on the row.
    const summed = stored?.cost != null && stored.net != null && stored.cra != null
    check(summed && debits === BigInt(stored.cost)
          && -total('1000') === BigInt(stored.net)
          && -total('2627') === BigInt(stored.cra),
      'PR9 the entry says what the stubs say',
      !summed
        ? 'the run has no stubs to compare the entry against'
        : `stubs: cost ${$(BigInt(stored.cost))} = net ${$(BigInt(stored.net))} + CRA ${$(BigInt(stored.cra))}; `
          + `entry debits ${$(debits)}, bank ${$(-total('1000'))}, liability ${$(-total('2627'))}`)

    const detail = await payRunDetail(L, first.runId)
    const stubTotal = detail!.stubs.reduce((s, r) => s + BigInt(r.net_pay), 0n)
    check(detail !== null && detail.stubs.length === 2 && stubTotal === t.netPay
          && detail.run.entry_no?.startsWith('PR-') === true,
      'PR14 two people, two stubs, one entry, and the number says payroll',
      `${detail?.stubs.length} stubs summing to ${$(stubTotal)} on entry ${detail?.run.entry_no}`)
  }

  // ------------------------------------------------------------------- PR10
  // The year to date is DERIVED. The second period sees the first without
  // anything having stored a running total — and reversing the first run
  // gives the room back, because a reversed run did not happen.
  {
    const ytdAfterOne = (await yearToDate(L, [danaRec.id], '2026-02-15', 2026)).get(danaRec.id)!
    const second = await previewPayRun({ ledgerId: L, payDate: '2026-02-15',
      lines: [{ employeeId: danaRec.id, gross: parseMoney('3000.00') }] })
    const sawIt = second.stubs[0].ytd.cpp === ytdAfterOne.cpp && ytdAfterOne.cpp > 0n

    await reverseEntry(first.entryId, '2026-01-31', 'wrong bank account', 'alicio@example.test')
    const afterReversal = (await yearToDate(L, [danaRec.id], '2026-02-15', 2026)).get(danaRec.id)!
    const third = await previewPayRun({ ledgerId: L, payDate: '2026-02-15',
      lines: [{ employeeId: danaRec.id, gross: parseMoney('3000.00') }] })

    check(sawIt && afterReversal.cpp === 0n && afterReversal.periods === 0
          && third.stubs[0].ytd.cpp === 0n,
      'PR10 the year to date is summed from standing runs only',
      `after one run ${$(ytdAfterOne.cpp)} of CPP; after reversing it ${$(afterReversal.cpp)}`)
  }

  // ------------------------------------------------------------------- PR12
  // A stub whose run reached the books is frozen — the trigger, not the app.
  {
    const [stub] = await db.execute<{ id: string }>(raw`
      SELECT ps.id::text FROM pay_stub ps
       WHERE ps.pay_run_id = ${first.runId}::uuid LIMIT 1`)
    // No stub at all is a FAILURE of this check, not a crash. Every read below
    // that a mutation could empty is guarded the same way: a suite that dies
    // prints no summary, and `mutations.sh` then throws the whole run away
    // (which is how this was found — one block emptied a read forty minutes in).
    const refusals: string[] = stub ? [] : ['the run wrote no stub to freeze']
    for (const [what, statement] of (stub ? [
      ['edit', raw`UPDATE pay_stub SET gross = 1 WHERE id = ${stub.id}::uuid`],
      ['delete', raw`DELETE FROM pay_stub WHERE id = ${stub.id}::uuid`],
    ] : []) as ReadonlyArray<readonly [string, ReturnType<typeof raw>]>) {
      try {
        await db.execute(statement)
        refusals.push(`${what} went through`)
      } catch (e) {
        if (!fullMessage(e).includes('PAYROLL_POSTED')) refusals.push(`${what}: ${fullMessage(e).slice(0, 80)}`)
      }
    }
    check(refusals.length === 0,
      'PR12 a stub behind a posted run cannot be edited or deleted',
      refusals.length ? refusals.join(' | ') : 'both refused with PAYROLL_POSTED')
  }

  // ------------------------------------------------------------------- PR13
  // The stub's own trial balance, enforced where nothing can go around it.
  {
    const [run] = await db.execute<{ id: string }>(raw`
      INSERT INTO pay_run (ledger_id, pay_date, bank_account_id, created_by)
      VALUES (${L}::uuid, '2026-03-15'::date, ${id['1000']}::uuid, 'check')
      RETURNING id::text`)
    // Each row breaks exactly ONE constraint and the check requires THAT one by
    // name. The first version's second row broke both, so dropping
    // `pay_stub_tax_adds_up` entirely left PR13 green on the other (critic).
    const tries: string[] = []
    for (const [what, constraint, values] of [
      // net_pay that is not gross less the deductions; the tax figures foot.
      ['net pay', 'pay_stub_net_adds_up',
       '300000, 300000, 300000, 16982, 0, 4890, 31959, 13601, 0, 45560, 999999'],
      // income_tax that is not federal + provincial + additional. net_pay is
      // gross less THIS income_tax, so the net constraint is satisfied.
      ['income tax', 'pay_stub_tax_adds_up',
       '300000, 300000, 300000, 16982, 0, 4890, 31959, 13601, 0, 99999, 178129'],
      // a net pay below zero: deductions larger than the pay.
      ['negative net pay', 'pay_stub_net_pay_check',
       '300000, 300000, 300000, 16982, 0, 4890, 31959, 13601, 250000, 295560, -17432'],
    ] as const) {
      try {
        await db.execute(raw`
          INSERT INTO pay_stub (pay_run_id, employee_id, edition, frequency, gross,
                                pensionable, insurable, cpp, cpp2, ei, federal_tax,
                                provincial_tax, additional_tax, income_tax, net_pay,
                                employer_cpp, employer_cpp2, employer_ei)
          VALUES (${run.id}::uuid, ${danaRec.id}::uuid, '2026-01', 'semi_monthly',
                  ${raw.raw(values)}, 16982, 0, 6846)`)
        tries.push(`a stub with the wrong ${what} was stored`)
      } catch (e) {
        if (!fullMessage(e).includes(constraint)) {
          tries.push(`${what}: refused, but by ${fullMessage(e).slice(0, 60)} and not ${constraint}`)
        }
      }
    }
    await db.execute(raw`DELETE FROM pay_run WHERE id = ${run.id}::uuid`)
    check(tries.length === 0,
      'PR13 a stub that does not add up, or pays less than nothing, is refused',
      tries.length ? tries.join(' | ')
        : 'three bad rows, each refused by the one constraint that is about it')
  }

  // ------------------------------------------------------------------- PR18
  // Pensionable and insurable earnings follow their own figures, not the
  // gross. A taxable benefit that is not insurable is the ordinary case, and
  // an engine that reads the gross three times cannot express it.
  {
    const whole = calculatePayroll({
      payDate: '2026-01-15', frequency: 'semi_monthly', gross: parseMoney('3000.00'),
    })
    const partly = calculatePayroll({
      payDate: '2026-01-15', frequency: 'semi_monthly', gross: parseMoney('3000.00'),
      pensionable: parseMoney('2800.00'), insurable: parseMoney('2600.00'),
    })
    // $2,800 pensionable less the truncated period exemption of $145.83, at
    // 5.95%; $2,600 insurable at 1.63%. Both worked by hand from T4127.
    check(whole.cpp === parseMoney('169.82') && whole.ei === parseMoney('48.90')
          && partly.cpp === parseMoney('157.92') && partly.ei === parseMoney('42.38'),
      'PR18 CPP and EI follow pensionable and insurable, not the gross',
      `on $3,000 gross: CPP ${$(whole.cpp)} → ${$(partly.cpp)} on $2,800 pensionable, `
      + `EI ${$(whole.ei)} → ${$(partly.ei)} on $2,600 insurable`)
  }

  // ------------------------------------------------------------------- PR19
  {
    const key = 'payroll-check-idempotent'
    const a = await runPayroll({
      ledgerId: L, payDate: '2026-04-15', bankAccountId: id['1000'], actor: 'alicio@example.test',
      idempotencyKey: key, lines: [{ employeeId: reyRec.id, gross: parseMoney('2400.00') }],
    })
    let second: string | null = null
    try {
      const b = await runPayroll({
        ledgerId: L, payDate: '2026-04-15', bankAccountId: id['1000'], actor: 'alicio@example.test',
        idempotencyKey: key, lines: [{ employeeId: reyRec.id, gross: parseMoney('2400.00') }],
      })
      second = b.entryId
    } catch (e) { second = `refused: ${fullMessage(e).slice(0, 80)}` }
    // Both counts. Counting entries alone cannot see the defect the run-level
    // key exists for: two pay_run rows against ONE entry leaves the entry count
    // at 1 and still counts the period twice in every year to date (critic).
    const [{ entries, paydays }] = await db.execute<{ entries: string; paydays: string }>(raw`
      SELECT (SELECT COUNT(*) FROM journal_entry
               WHERE ledger_id = ${L}::uuid AND entry_date = '2026-04-15'::date
                 AND source_type = 'payroll')::text AS entries,
             (SELECT COUNT(*) FROM pay_run
               WHERE ledger_id = ${L}::uuid AND pay_date = '2026-04-15'::date)::text AS paydays`)
    check(second === a.entryId && entries === '1' && paydays === '1',
      'PR19 the same run submitted twice pays once',
      `${entries} entry and ${paydays} pay run on 15 April; `
      + `the replay returned ${second === a.entryId ? 'the original' : second}`)
  }

  // ------------------------------------------------------------------- PR20
  // The list and the stub history are the same figures a stub carries — one
  // reader for the run, one for the person, and they agree.
  {
    const runs = await payRuns(L)
    const listed = runs.find((r) => r.id === first.runId)
    const history = await stubsFor(L, danaRec.id, 2026)
    const january = history.find((h) => h.pay_date === '2026-01-15')
    const detail = await payRunDetail(L, first.runId)
    const danaStub = detail!.stubs.find((s) => s.employee_id === danaRec.id)
    // "What goes to CRA" was written out three times — here, in the run list's
    // SQL, and on the run's own page — and nothing compared them (critic). The
    // list's figure and the run's own stubs must come to the same number.
    const detailRemittance = remittanceOf({
      cpp: sumOf(detail!.stubs, 'cpp'), cpp2: sumOf(detail!.stubs, 'cpp2'),
      ei: sumOf(detail!.stubs, 'ei'), incomeTax: sumOf(detail!.stubs, 'income_tax'),
      employerCpp: sumOf(detail!.stubs, 'employer_cpp'),
      employerCpp2: sumOf(detail!.stubs, 'employer_cpp2'),
      employerEi: sumOf(detail!.stubs, 'employer_ei'),
    })
    check(listed !== undefined && listed.people === '2'
          && january !== undefined && january.net_pay === danaStub!.net_pay
          && january.status === 'reversed'
          && BigInt(listed.gross) === first.preview!.totals.gross
          && BigInt(listed.remittance) === detailRemittance
          && detailRemittance === first.preview!.totals.remittance,
      'PR20 the run list, the run and the person tell one story',
      `${listed?.people} people, gross ${$(BigInt(listed?.gross ?? '0'))}, `
      + `to CRA ${$(BigInt(listed?.remittance ?? '0'))} by the list and ${$(detailRemittance)} `
      + `by the stubs; Dana's January stub ${$(BigInt(january?.net_pay ?? '0'))}, marked ${january?.status}`)
  }

  // ------------------------------------------------------------- PR21, PR22
  // The FORM path, end to end. Everything above calls the library directly;
  // this is what the browser actually sends, read back through the same field
  // names the screen renders — the two-lists defect in form-field form is a
  // row the reader never sees, and the payday is short by exactly one person
  // with every figure on it agreeing with every other.
  {
    const f = new FormData()
    f.set(F.ledgerId, L)
    f.set(F.payDate, '2026-05-15')
    f.set(F.periodStart, '2026-05-01')
    f.set(F.periodEnd, '2026-05-15')
    f.set(F.bankAccountId, id['1000'])
    f.set(F.idempotencyKey, 'from-the-form')
    f.set(payEmployee(0), danaRec.id)
    f.set(payGross(0), '3,000.00')
    f.set(payEmployee(1), reyRec.id)
    f.set(payGross(1), '2400')
    // A third row the person added and left empty is an unused extra, not an
    // error, and must not become a stub.
    f.set(payEmployee(2), '')
    f.set(payGross(2), '')

    const first = await runPayrollFromForm(f, 'alicio@example.test')
    const again = await runPayrollFromForm(f, 'alicio@example.test')
    const detail = first.runId ? await payRunDetail(L, first.runId) : null
    const dana = detail?.stubs.find((r) => r.name === 'Dana Whitfield')

    check(first.ok !== undefined && detail?.stubs.length === 2
          && dana?.net_pay === String(parseMoney('2325.68'))
          && again.runId === first.runId,
      'PR21 what the form sends is what gets paid',
      first.error ?? `${detail?.stubs.length} stubs from 3 rows; Dana's net ${$(BigInt(dana?.net_pay ?? '0'))}; `
        + `submitted twice, one run (${again.ok})`)

    // And the names the form writes are the names the reader reads back.
    const written = [payEmployee(0), payGross(0), payPensionable(1), payInsurable(2)]
    check(payIndicesIn(written).join(',') === '0,1,2',
      'PR22 the row names the screen writes are the ones the reader finds',
      `${written.join(' ')} → rows ${payIndicesIn(written).join(', ')}`)
  }

  // ------------------------------------------------------------- PR23, PR24
  // The year to date REACHES THE ENGINE. PR10 proves the sum is right; this
  // proves it is handed over. A first period large enough to exhaust the CPP
  // maximum and cross the YMPE makes the second period's answer impossible
  // to produce from the period alone: CPP must be nothing at all, and CPP2
  // must appear. Nothing but the derived year to date can do that.
  {
    const big = await runPayroll({
      ledgerId: L, payDate: '2026-06-15', bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: kaiRec.id, gross: parseMoney('72000.00') }],
    })
    const after = await previewPayRun({ ledgerId: L, payDate: '2026-06-30',
      lines: [{ employeeId: kaiRec.id, gross: parseMoney('3000.00') }] })
    const s = after.stubs[0]
    check(big.preview!.stubs[0].cpp === parseMoney('4230.45')
          && s.cpp === 0n && s.cpp2 === parseMoney('16.00') && s.ei === 0n,
      'PR23 the derived year to date is what the engine is handed',
      `first period took the whole ${$(big.preview!.stubs[0].cpp)} maximum; the next `
      + `contributes CPP ${$(s.cpp)}, CPP2 ${$(s.cpp2)} on the $400 over the YMPE, EI ${$(s.ei)}`)
  }

  // PR24 — and pensionable and insurable reach it too. PR18 proves the engine
  //        honours them; a run that read the gross three times would still be
  //        green there and wrong on every stub.
  {
    const split = await previewPayRun({ ledgerId: L, payDate: '2026-02-15', lines: [
      { employeeId: danaRec.id, gross: parseMoney('3000.00'),
        pensionable: parseMoney('2800.00'), insurable: parseMoney('2600.00') },
    ]})
    const s = split.stubs[0]
    check(s.gross === parseMoney('3000.00') && s.pensionable === parseMoney('2800.00')
          && s.cpp === parseMoney('157.92') && s.ei === parseMoney('42.38'),
      'PR24 a run carries pensionable and insurable through to the figures',
      `gross ${$(s.gross)}, CPP on ${$(s.pensionable)} is ${$(s.cpp)}, `
      + `EI on ${$(s.insurable)} is ${$(s.ei)}`)
  }

  // ------------------------------------------------------------------ PR25
  // Federal and provincial are rounded SEPARATELY and then added — what PDOC
  // does, and not the same thing as rounding their sum. The two PDOC cases
  // above cannot see this: they happen to give the same answer either way.
  // $1,093.00 semi-monthly in January does not. It is a cent, once, and a
  // cent is the whole standard this engine is held to.
  {
    const r = calculatePayroll({
      payDate: '2026-01-15', frequency: 'semi_monthly', gross: parseMoney('1093.00'),
    })
    check(r.federalTax === parseMoney('37.91') && r.provincialTax === parseMoney('0.38')
          && r.incomeTax === parseMoney('38.29'),
      'PR25 the two taxes are rounded apart, then added',
      `federal ${$(r.federalTax)} + BC ${$(r.provincialTax)} = ${$(r.incomeTax)}; `
      + 'rounding the sum instead gives 38.28')
  }

  // ------------------------------------------------------------------ PR26
  // Deleting the RUN must not take a posted payday's stubs with it. The stub
  // trigger cannot see this: the stubs cascade, and during a cascade the parent
  // row is already gone when the child's BEFORE DELETE fires, so it reads as an
  // unposted run and lets them all go — the year to date silently gains back
  // room that was used, and the journal entry is left with nothing behind it
  // (critic).
  {
    let refused = ''
    try {
      await db.execute(raw`DELETE FROM pay_run WHERE id = ${first.runId}::uuid`)
    } catch (e) { refused = fullMessage(e) }
    const [{ n }] = await db.execute<{ n: string }>(raw`
      SELECT COUNT(*)::text AS n FROM pay_stub WHERE pay_run_id = ${first.runId}::uuid`)
    check(refused.includes('PAYROLL_POSTED') && n === '2',
      'PR26 a posted pay run cannot be deleted out from under its stubs',
      refused.includes('PAYROLL_POSTED')
        ? `refused, and its ${n} stubs are still there`
        : `the delete went through and left ${n} stubs`)
  }

  // ------------------------------------------------------------------ PR27
  // Nobody is paid a negative amount. Extra tax on a TD1 is unbounded, so one
  // typo is enough — and the entry it makes BALANCES (a debit to the bank on
  // payday), so postEntry would have taken it (critic).
  {
    await saveEmployee({ ledgerId: L, partyId: kai.id, id: kaiRec.id,
      frequency: 'semi_monthly', federalClaim: parseMoney('16452.00'),
      bcClaim: parseMoney('13216.00'), additionalTax: parseMoney('5000.00'),
      hiredOn: hired, actor: 'alicio@example.test' })
    let refused = ''
    try {
      await previewPayRun({ ledgerId: L, payDate: '2026-08-15',
        lines: [{ employeeId: kaiRec.id, gross: parseMoney('2000.00') }] })
    } catch (e) { refused = e instanceof PayrollError ? `${e.code}: ${e.message}` : fullMessage(e) }
    // Put the record back before anything else uses it.
    await saveEmployee({ ledgerId: L, partyId: kai.id, id: kaiRec.id,
      frequency: 'semi_monthly', federalClaim: parseMoney('16452.00'),
      bcClaim: parseMoney('13216.00'), hiredOn: hired, actor: 'alicio@example.test' })
    check(refused.startsWith('NEGATIVE_NET_PAY') && refused.includes('Kai'),
      'PR27 a pay period cannot take more than it pays',
      refused || '$5,000 of extra tax on $2,000 of pay was computed and would have posted')
  }

  // ------------------------------------------------------------------ PR28
  // The four refusals that stand between a person and money moving. Each was
  // written and none was exercised (critic).
  {
    const said = async (what: () => Promise<unknown>) => {
      try { await what(); return '' } catch (e) {
        return e instanceof PayrollError ? e.code : fullMessage(e).slice(0, 60)
      }
    }
    const pay = (over: Record<string, unknown>) => () => runPayroll({
      ledgerId: L, payDate: '2026-09-15', bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: reyRec.id, gross: parseMoney('2400.00') }], ...over,
    })

    // Off the active payroll.
    await saveEmployee({ ledgerId: L, partyId: kai.id, id: kaiRec.id,
      frequency: 'semi_monthly', isActive: false, hiredOn: hired, actor: 'alicio@example.test' })
    const retired = await said(pay({ lines: [{ employeeId: kaiRec.id, gross: parseMoney('2400.00') }] }))
    await saveEmployee({ ledgerId: L, partyId: kai.id, id: kaiRec.id,
      frequency: 'semi_monthly', federalClaim: parseMoney('16452.00'),
      bcClaim: parseMoney('13216.00'), hiredOn: hired, actor: 'alicio@example.test' })

    // An account that is not a bank account.
    const notBank = await said(pay({ bankAccountId: id['9060'] }))

    // No account carries the wages role, then none carries the liability role.
    const untag = async (code: string) => db.execute(raw`
      DELETE FROM account_role WHERE account_id = ${id[code]}::uuid`)
    const retag = async (code: string, role: string) => db.execute(raw`
      INSERT INTO account_role (account_id, role) VALUES (${id[code]}::uuid, ${role})`)
    await untag('9060')
    const noWages = await said(pay({}))
    await retag('9060', 'employee_benefits_expense')
    await untag('2627')
    const noLiability = await said(pay({}))
    await retag('2627', 'payroll_liabilities')

    const got = { retired, notBank, noWages, noLiability }
    const want = {
      retired: 'NOT_ACTIVE', notBank: 'NOT_A_BANK_ACCOUNT',
      noWages: 'NO_WAGES_ACCOUNT', noLiability: 'NO_LIABILITY_ACCOUNT',
    }
    const wrong = Object.entries(want).filter(([k, v]) => got[k as keyof typeof got] !== v)
    check(wrong.length === 0,
      'PR28 every refusal between a person and the money says which one it is',
      wrong.length === 0
        ? Object.values(want).join(', ')
        : wrong.map(([k, v]) => `${k}: ${got[k as keyof typeof got] || 'accepted'} not ${v}`).join(' | '))
  }

  // ------------------------------------------------------------------ PR29
  // The pay frequencies are written down three times — the engine's
  // `FREQUENCIES`, the screens' `FREQUENCY_LABEL`, and the migration's CHECK.
  // Adding one to the first two and not the third produces a raw constraint
  // error at the database, which is the two-lists defect wearing a CHECK
  // (critic). Read from the live constraint, not from a copy of it.
  {
    const [row] = await db.execute<{ def: string }>(raw`
      SELECT pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'payroll_employee' AND pg_get_constraintdef(c.oid) ILIKE '%frequency%'`)
    // No constraint at all is the strongest version of this failure, so it is
    // a red line rather than a crash.
    const inDatabase = [...(row?.def ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    const inEngine = Object.keys(FREQUENCIES).sort()
    const onScreen = Object.keys(FREQUENCY_LABEL).sort()
    check(row !== undefined && inEngine.join(' ') === inDatabase.join(' ')
          && inEngine.join(' ') === onScreen.join(' '),
      'PR29 one list of pay frequencies, in all three places that hold one',
      row === undefined
        ? 'the database has no CHECK on the frequency column at all'
        : `engine ${inEngine.length}, screens ${onScreen.length}, database ${inDatabase.length}: `
      + (inEngine.join(' ') === inDatabase.join(' ') && inEngine.join(' ') === onScreen.join(' ')
          ? inEngine.join(', ')
          : `engine [${inEngine}] screens [${onScreen}] database [${inDatabase}]`))
  }

  // ------------------------------------------------------------------ PR30
  // The BPAF phases OUT. Every check above passes an explicit federal claim,
  // which short-circuits it, so only its flat branch had ever run and the
  // phase-out constants were read by nothing (critic). Above $181,440 of
  // annual income the basic amount slides from $16,452 to $14,829, and past
  // $258,482 it stays there.
  {
    const at = (gross: string) => calculatePayroll({
      payDate: '2026-01-15', frequency: 'monthly', gross: parseMoney(gross),
    })
    const under = at('15000.00')      // $180,000 a year — under the threshold
    const sliding = at('18000.00')    // $216,000 — inside the phase-out
    const over = at('25000.00')       // $300,000 — past the far end
    check(bpaf(under.annualTaxable, FEDERAL_2026) === parseMoney('16452.00')
          && bpaf(over.annualTaxable, FEDERAL_2026) === parseMoney('14829.00')
          && bpaf(sliding.annualTaxable, FEDERAL_2026) > parseMoney('14829.00')
          && bpaf(sliding.annualTaxable, FEDERAL_2026) < parseMoney('16452.00'),
      'PR30 the basic personal amount phases out with income',
      `$180k → ${$(bpaf(under.annualTaxable, FEDERAL_2026))}, `
      + `$216k → ${$(bpaf(sliding.annualTaxable, FEDERAL_2026))}, `
      + `$300k → ${$(bpaf(over.annualTaxable, FEDERAL_2026))}`)
  }

  // ------------------------------------------------------------------ PR31
  // The whole year, asked for the way the employee's page asks for it: an
  // exclusive bound of 1 January next. `yearToDate` took the calendar year off
  // that bound, so it filtered for the FOLLOWING year and summed nothing —
  // the page showed 0.00 above a table of stubs. Found in a browser pass; the
  // suite could not see it because every other caller passes a date inside the
  // year it means.
  {
    const whole = (await yearToDate(L, [reyRec.id], '2027-01-01', 2026)).get(reyRec.id)!
    const stubs = await stubsFor(L, reyRec.id, 2026)
    const standing = stubs.filter((s) => s.status === 'posted')
    const fromStubs = standing.reduce((t, s) => t + BigInt(s.gross), 0n)
    check(standing.length > 0 && whole.periods === standing.length
          && whole.gross === fromStubs,
      'PR31 the whole year is the sum of the year\'s own standing stubs',
      `${whole.periods} periods totalling ${$(whole.gross)}, `
      + `against ${standing.length} standing stubs totalling ${$(fromStubs)}`)
  }

  // ------------------------------------------------------------------ PR32
  // The T4 worksheet is the year to date wearing box numbers — the SAME sum,
  // not a second query — and the boxes it cannot produce are absent with a
  // reason rather than a confident zero. A zero in box 20 is a claim that
  // nothing was contributed; a dash is the truth, which is that this module
  // does not withhold it.
  {
    const t4 = await t4Year(L, 2026)
    const mine = t4.employees.find((e) => e.employeeId === danaRec.id)!
    const year = (await yearToDate(L, [danaRec.id], '2027-01-01', 2026)).get(danaRec.id)!
    const box = (n: string) => mine.boxes.find((b) => b.box === n)!
    const absent = mine.boxes.filter((b) => b.amount === null)

    check(box('14').amount === year.gross
          && box('16').amount === year.cpp
          && box('16A').amount === year.cpp2
          && box('18').amount === year.ei
          && box('22').amount === year.incomeTax
          && box('20').amount === null && (box('20').absent ?? '').includes('0052')
          && box('17').amount === null && (box('17').absent ?? '').includes('Quebec')
          && box('44').amount === null
          && absent.every((b) => (b.absent ?? '').length > 20),
      'PR32 the T4 boxes are the year to date, and the missing ones say why',
      `box 14 ${$(box('14').amount!)}, box 22 ${$(box('22').amount!)}; `
      + `${absent.length} boxes shown as absent, each with a reason`)
  }

  // ------------------------------------------------------------------ PR33
  // Boxes 24 and 26 are CAPPED. An employee over the ceiling has insurable
  // earnings of the maximum, not of what they earned — reporting the earnings
  // would overstate the base every EI claim is worked out from.
  {
    // Kai's June run was $72,000 — over the EI maximum but under both CPP
    // ones. More paydays put them past the YAMPE too, which is the only way to
    // see the two boxes stop at their own different ceilings.
    await runPayroll({
      ledgerId: L, payDate: '2026-06-30', bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: kaiRec.id, gross: parseMoney('5000.00') }],
    })
    await runPayroll({
      ledgerId: L, payDate: '2026-07-31', bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: kaiRec.id, gross: parseMoney('10000.00') }],
    })
    const t4 = await t4Year(L, 2026)
    const kai = t4.employees.find((e) => e.employeeId === kaiRec.id)!
    const year = (await yearToDate(L, [kaiRec.id], '2027-01-01', 2026)).get(kaiRec.id)!
    const box24 = kai.boxes.find((b) => b.box === '24')!.amount!
    const box26 = kai.boxes.find((b) => b.box === '26')!.amount!
    // Box 26's ceiling is the YAMPE, not the YMPE: since 2024 it has to support
    // box 16A beside it, and CPP2 is charged on the band ABOVE the YMPE. Capping
    // at $74,600 understated it for everyone paid over that and left box 16A
    // unexplained (critic; CRA's own T4 slip instructions).
    check(year.insurable > parseMoney('68900.00') && box24 === parseMoney('68900.00')
          && year.pensionable > parseMoney('85000.00') && box26 === parseMoney('85000.00')
          && box26 !== parseMoney('74600.00'),
      'PR33 box 24 stops at the MIE and box 26 at the YAMPE',
      `earned ${$(year.insurable)} insurable → box 24 ${$(box24)}; `
      + `${$(year.pensionable)} pensionable → box 26 ${$(box26)}, not the YMPE 74,600.00`)
  }

  // ------------------------------------------------------------------ PR34
  // The ROE's blocks cover Service Canada's own pay-period counts, and they
  // are DIFFERENT counts: 15A looks back 25 semi-monthly periods and 15B only
  // 13. Using one number for both is the mistake this pins — it would either
  // overstate the earnings or understate the hours, and somebody's benefit
  // claim is worked out from them.
  {
    // ALL FOUR NUMBERS FOR EVERY FREQUENCY, from Service Canada's employer
    // guide. The first version pinned the semi-monthly row alone — four of the
    // twenty — so any other row could have been edited freely (critic).
    const WANT: Record<string, [number, number, number, number, string | null]> = {
      weekly: [53, 27, 27, 53, 'Weekly'],
      biweekly: [27, 14, 14, 27, 'Bi-weekly'],
      semi_monthly: [25, 13, 13, 25, 'Semi-monthly'],
      monthly: [13, 7, 7, 13, 'Monthly'],
      four_weekly: [14, 7, 7, 14, '13 pay periods a year'],
      // CRA pays on these; Service Canada's form has no type for them, so
      // there is no count and every span figure must be refused.
      twenty_two: [0, 0, 0, 0, null],
      ten: [0, 0, 0, 0, null],
    }
    const wrong: string[] = []
    for (const [freq, [a, b, paper, web, label]] of Object.entries(WANT)) {
      await saveEmployee({ ledgerId: L, partyId: rey.id, id: reyRec.id,
        frequency: freq, federalClaim: parseMoney('16452.00'),
        bcClaim: parseMoney('13216.00'), hiredOn: hired, actor: 'alicio@example.test' })
      const r = await roeSummary(L, reyRec.id)
      if (label === null) {
        // No type on the form: no span, and no total pretending to be one.
        if (r.span !== null || r.payPeriodType !== null
            || r.insurableEarnings !== null || r.insurableHours !== null
            || r.periods.length !== 0) {
          wrong.push(`${freq} produced figures with no pay-period type to base them on`)
        }
        continue
      }
      if (r.span?.hours15A !== a || r.span?.earnings15B !== b
          || r.span?.paper15C !== paper || r.span?.web15C !== web
          || r.payPeriodType !== label) {
        wrong.push(`${freq}: ${r.span?.hours15A}/${r.span?.earnings15B}/`
          + `${r.span?.paper15C}/${r.span?.web15C} "${r.payPeriodType}" `
          + `≠ ${a}/${b}/${paper}/${web} "${label}"`)
      }
    }
    await saveEmployee({ ledgerId: L, partyId: rey.id, id: reyRec.id,
      frequency: 'semi_monthly', federalClaim: parseMoney('16452.00'),
      bcClaim: parseMoney('13216.00'), hiredOn: hired, actor: 'alicio@example.test' })

    const roe = await roeSummary(L, danaRec.id)
    const descending = roe.periods.every((p, i) =>
      i === 0 || roe.periods[i - 1].payDate >= p.payDate)
    check(wrong.length === 0 && descending && roe.periods[0] !== undefined
          && roe.toSupply.some((b) => b.block === '16'),
      'PR34 every ROE span is Service Canada\'s, and newest comes first',
      wrong.length === 0
        ? '5 pay-period types pinned on all four counts, 2 frequencies refused for '
          + 'having no type; 15C newest first'
        : wrong.join(' | '))
  }

  // ------------------------------------------------------------------ PR35
  // Hours ride from the run form to the stub to the ROE untouched, and an
  // employee with none recorded gets a refusal to state a figure rather than
  // a zero — zero hours is a claim, and the wrong one.
  {
    const withHours = await runPayroll({
      ledgerId: L, payDate: '2026-10-15', periodStart: '2026-10-01', periodEnd: '2026-10-15',
      bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: danaRec.id, gross: parseMoney('3000.00'), hours: 7250n }],
    })
    const detail = await payRunDetail(L, withHours.runId)
    const roe = await roeSummary(L, danaRec.id)
    const none = await roeSummary(L, reyRec.id)
    check(detail!.stubs[0].hours === '7250'
          && roe.insurableHours === 7250n
          && roe.periods[0].hours === 7250n
          && none.insurableHours === null,
      'PR35 hours reach the stub and the ROE, and their absence is said not guessed',
      `72.50 hours stored as ${detail!.stubs[0].hours}, Block 15A ${roe.insurableHours}; `
      + `an employee with none recorded reports ${none.insurableHours}`)
  }

  // ------------------------------------------------------------------ PR36
  // The pay statement is the stub on paper. Read back out of the PDF by a
  // decoder that knows nothing about the builder, so a figure that never
  // reached the page cannot pass.
  {
    const detail = await payRunDetail(L, first.runId)
    // The stub may be GONE — an earlier check deletes the run under a mutation
    // that lets it — and that is a failure of this check, not a crash. Every
    // fixture a later check depends on is read this way for that reason.
    const dana = detail?.stubs.find((s) => s.employee_id === danaRec.id)
    const doc = dana ? await paychequePdf(L, first.runId, danaRec.id) : null
    const text = doc ? pdfText(doc.buffer).replace(/\s+/g, ' ') : ''
    const marks = doc ? pdfTextAt(doc.buffer) : []
    // What the paycheque actually carries. It shows one Income Tax figure
    // rather than the federal and provincial halves — that split is on the run
    // page and on the T4 worksheet, and a pay slip does not print it.
    const wants = dana ? [
      'Dana Whitfield', 'Pay Stub Detail', 'Cedar Works Ltd.',
      'EMPLOYER', 'EMPLOYEE', 'PAY PERIOD', 'TAXES', 'SUMMARY', 'Net Pay',
      'Income Tax', 'Employment Insurance', 'Canada Pension Plan',
      formatMoney(BigInt(dana.gross)), formatMoney(BigInt(dana.net_pay)),
      formatMoney(BigInt(dana.cpp)), formatMoney(BigInt(dana.ei)),
      formatMoney(BigInt(dana.income_tax)),
      // The date, in the order the paper prints it.
      '15-01-2026',
    ] : []
    const missing = wants.filter((w) => !text.includes(w))
    // The net pay is printed THREE times — the voucher band, the NET PAY line
    // and the summary — so "it is on the page somewhere" is not enough: a
    // mutation of any one of them left the other two carrying the string and
    // this check green (found by spot-proving block 327). Counting pins all
    // three, and a fourth would have to be added here on purpose.
    const netTimes = dana
      ? text.split(formatMoney(BigInt(dana.net_pay))).length - 1 : 0
    const nobody = await paychequePdf(L, first.runId, kaiRec.id)
    check(dana !== undefined && doc !== null && missing.length === 0
          && netTimes === 3 && nobody === null
          && marks.some((m) => m.text === 'Pay Stub Detail' && m.x > 400 && m.y > 675)
          && marks.some((m) => m.text === 'EMPLOYER' && m.x === 36)
          && marks.some((m) => m.text === 'BENEFITS' && m.x === 36),
      'PR36 the paycheque is the stub, read back off the page',
      dana === undefined
        ? 'the January run has no stub to draw a paycheque from'
        : missing.length > 0
        ? `not on the page: ${missing.join(', ')}`
        : netTimes !== 3
        ? `the net pay is printed ${netTimes} times, not 3 — the band, the NET PAY `
          + 'line and the summary must all carry it'
        : `${wants.length} figures found in ${doc!.buffer.length} bytes of PDF, `
          + 'the net in all 3 places; somebody not on the run gets no document')
  }

  // ------------------------------------------------------------------ PR37
  // The employee record offers no deduction the pay run does not withhold.
  // `rpp_rrsp` and `union_dues` did: the engine subtracted them from income
  // for tax and nothing took them off the pay, so the employee was short by
  // exactly that much and box 20 was a fiction. They are gone (0052), and this
  // is the pin — the day withholding is built, it adds the columns AND the
  // ledger lines, and changes this check on purpose.
  {
    const columns = await db.execute<{ column_name: string }>(raw`
      SELECT column_name::text FROM information_schema.columns
       WHERE table_name = 'payroll_employee'
         AND (column_name ILIKE '%rpp%' OR column_name ILIKE '%rrsp%'
              OR column_name ILIKE '%union%' OR column_name ILIKE '%dues%')`)
    // And the stub's own identity names every withholding there is. The
    // constraint MISSING is the loudest version of this failing, so it is read
    // defensively — destructuring it crashed the suite under the block that
    // removes it, and a suite that dies prints no summary at all.
    const [row] = await db.execute<{ def: string }>(raw`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conname = 'pay_stub_net_adds_up'`)
    const named = ['gross', 'cpp', 'cpp2', 'ei', 'income_tax']
    const def = row?.def ?? ''
    check(columns.length === 0 && row !== undefined && named.every((n) => def.includes(n)),
      'PR37 nothing is deducted for tax that is not taken off the pay',
      columns.length > 0
        ? `still offered: ${columns.map((c) => c.column_name).join(', ')}`
        : row === undefined
        ? 'the stub has no constraint saying what net pay is'
        : 'no unwithheld deduction on the employee record; net pay = gross less the four')
  }

  // ------------------------------------------------------------------ PR38
  // The statement's year-to-date column. PR36 reads the period figures off the
  // page; this reads the OTHER column, on a later payday where the two differ —
  // where the first version silently printed 0.00 for a year's additional tax
  // that was already inside the total beside it, so the column did not add up
  // on the one piece of paper an employee keeps (critic).
  {
    // Two paydays with extra tax on the record, so the year's figure is real
    // and is not the period's.
    await saveEmployee({ ledgerId: L, partyId: rey.id, id: reyRec.id,
      frequency: 'semi_monthly', federalClaim: parseMoney('16452.00'),
      bcClaim: parseMoney('13216.00'), additionalTax: parseMoney('25.00'),
      hiredOn: hired, actor: 'alicio@example.test' })
    const one = await runPayroll({
      ledgerId: L, payDate: '2026-11-15', bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: reyRec.id, gross: parseMoney('2400.00') }],
    })
    const two = await runPayroll({
      ledgerId: L, payDate: '2026-11-30', bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: reyRec.id, gross: parseMoney('2400.00') }],
    })
    const doc = await paychequePdf(L, two.runId, reyRec.id)
    const text = doc ? pdfText(doc.buffer).replace(/\s+/g, ' ') : ''
    const year = (await yearToDate(L, [reyRec.id], '2026-12-01', 2026)).get(reyRec.id)!
    const period = two.preview!.stubs[0]
    const ytdAdditional = year.incomeTax - year.federalTax - year.provincialTax

    // The year's extra tax is two periods' worth and must appear as such —
    // not as the period's $25.00, and not as $0.00.
    // The paycheque's own words and its year column, read off the page.
    const missing = ['of which extra tax you asked for', formatMoney(ytdAdditional),
                     formatMoney(year.gross), 'YTD']
      .filter((w) => !text.includes(w))
    check(one.entryId !== two.entryId
          && missing.length === 0
          && ytdAdditional === parseMoney('50.00')
          && period.additionalTax === parseMoney('25.00')
          && year.gross !== period.gross,
      'PR38 the paycheque\'s year column is the year, and it adds up',
      missing.length > 0
        ? `not on the page: ${missing.join(', ')}`
        : `period extra tax ${$(period.additionalTax)}, year ${$(ytdAdditional)}; `
          + `year gross ${$(year.gross)} against this period's ${$(period.gross)}`)
  }

  // ------------------------------------------------------------------ PR39
  // None of the three new readers leaves the company it was asked in. They are
  // bound in SQL, and nothing had asked them to prove it (critic) — the T4
  // worksheet and the ROE are exactly the screens somebody would reach for
  // while looking at the wrong company.
  {
    const strangers: string[] = []
    const otherLedger = other.ledger.id

    const t4 = await t4Year(otherLedger, 2026)
    if (t4.employees.some((e) => e.employeeId === danaRec.id)) {
      strangers.push('the T4 worksheet listed another company\'s employee')
    }
    if (t4.employer.name === 'Cedar Works Ltd.') {
      strangers.push('the T4 worksheet named the wrong employer')
    }

    let roeRefused = ''
    try {
      await roeSummary(otherLedger, danaRec.id)
    } catch (e) { roeRefused = e instanceof PayrollError ? e.code : fullMessage(e) }
    if (roeRefused !== 'NO_EMPLOYEE') {
      strangers.push(`the ROE answered for another company's employee (${roeRefused || 'no refusal'})`)
    }

    const doc = await paychequePdf(otherLedger, first.runId, danaRec.id)
    if (doc !== null) strangers.push('a pay statement was drawn for another company\'s run')

    check(strangers.length === 0,
      'PR39 the T4, the ROE and the statement stay in their own company',
      strangers.length === 0
        ? `Alder Works sees ${t4.employees.length} employees, no ROE and no statement `
          + 'for a Cedar Works employee'
        : strangers.join(' | '))
  }

  // ------------------------------------------------------------------ PR40
  // A T4 for a year these constants do not describe is refused by name, the
  // way the engine refuses a pay date. The ceilings are 2026's; applying them
  // to another year would cap the boxes at the wrong figures and look entirely
  // ordinary (critic).
  {
    let refused = ''
    try {
      await t4Year(L, 2027)
    } catch (e) { refused = e instanceof PayrollError ? `${e.code}: ${e.message}` : fullMessage(e) }
    check(refused.startsWith('NO_TABLES') && refused.includes('2027'),
      'PR40 a T4 for a year the ceilings do not cover is refused',
      refused || 'it produced a 2027 worksheet capped at 2026 maximums')
  }

  // ------------------------------------------------------------------ PR41
  // Negative hours are refused, and hours typed on a row with nobody on it do
  // not quietly vanish — `payIndicesIn` now counts a row that has only hours,
  // so a row with hours and no employee has to be an error rather than an
  // unused extra (critic).
  {
    let negative = ''
    try {
      await previewPayRun({ ledgerId: L, payDate: '2026-05-15',
        lines: [{ employeeId: danaRec.id, gross: parseMoney('3000.00'), hours: -100n }] })
    } catch (e) { negative = e instanceof PayrollError ? e.code : fullMessage(e) }

    const f = new FormData()
    f.set(F.ledgerId, L)
    f.set(F.payDate, '2026-05-15')
    f.set(F.bankAccountId, id['1000'])
    f.set(payEmployee(0), danaRec.id)
    f.set(payGross(0), '3000.00')
    f.set(payHours(1), '40')          // hours, nobody, no amount
    const orphan = await runPayrollFromForm(f, 'alicio@example.test')

    check(negative === 'NEGATIVE' && orphan.error !== undefined
          && orphan.error.includes('2'),
      'PR41 negative hours are refused, and hours with nobody to pay are not swallowed',
      `${negative || 'negative hours accepted'}; a row of hours alone → `
      + `"${orphan.error ?? 'it posted'}"`)
  }

  // ------------------------------------------------------------------ PR42
  // Somebody who left and came back. Block 11 is the last day for which they
  // were PAID, and `max(held_to)` over their roles skips nulls — so the old
  // leaving date would be reported for an employee who is still working, with
  // Block 12 following it and every other figure on the sheet right (critic).
  {
    const returner = await createParty({
      kind: 'person', name: 'Wren Halloran',
      roles: [{ entityId: co.company.id, role: 'employee', heldFrom: '2026-02-01' }],
      actor: 'alicio@example.test',
    })
    const [firstRole] = await db.execute<{ id: string }>(raw`
      SELECT id::text FROM party_role
       WHERE party_id = ${returner.id}::uuid AND role = 'employee'`)
    await endRole(firstRole.id, '2026-03-31')
    // Rehired, and this time the role has no end.
    await grantRole({ partyId: returner.id, entityId: co.company.id,
      role: 'employee', heldFrom: '2026-06-01', actor: 'alicio@example.test' })

    const rec = await saveEmployee({
      ledgerId: L, partyId: returner.id, frequency: 'semi_monthly',
      federalClaim: parseMoney('16452.00'), bcClaim: parseMoney('13216.00'),
      hiredOn: '2026-01-01', actor: 'alicio@example.test',
    })
    await runPayroll({
      ledgerId: L, payDate: '2026-06-15', periodStart: '2026-06-01', periodEnd: '2026-06-15',
      bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: rec.id, gross: parseMoney('2000.00') }],
    })

    const roe = await roeSummary(L, rec.id)
    check(roe.firstDayWorked === '2026-01-01' && roe.lastDayPaid === '2026-06-15' && roe.finalPeriodEnd === '2026-06-15',
      'PR42 payroll hiring date overrides party registration, and rehire does not reuse the old leaving date',
      `hired ${roe.firstDayWorked}, registered 2026-02-01, back 2026-06-01, last paid ${roe.lastDayPaid}`)
  }

  // ------------------------------------------------------------- PD7A ------

  // Wrapped: a mutation that breaks the grouping (block 386) makes the reader
  // throw on a month it cannot name, and a suite that dies there prints no
  // FAIL. The catch turns the throw into the red line it is.
  try {
    // August, two paydays: the 15th pays two people, the 31st pays one. CRA
    // asks for the headcount of the LAST pay period.
    await runPayroll({
      ledgerId: L, payDate: '2026-08-15', periodStart: '2026-08-01', periodEnd: '2026-08-15',
      bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [
        { employeeId: danaRec.id, gross: parseMoney('3000.00') },
        { employeeId: reyRec.id, gross: parseMoney('2400.00') },
      ],
    })
    await runPayroll({
      ledgerId: L, payDate: '2026-08-31', periodStart: '2026-08-16', periodEnd: '2026-08-31',
      bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: danaRec.id, gross: parseMoney('3000.00') }],
    })
    // And a period that ends in September but is PAID in October: CRA groups
    // by the day you paid, so it is October's remittance.
    await runPayroll({
      ledgerId: L, payDate: '2026-09-15', periodStart: '2026-09-01', periodEnd: '2026-09-15',
      bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [
        { employeeId: danaRec.id, gross: parseMoney('3000.00') },
        { employeeId: reyRec.id, gross: parseMoney('2400.00') },
      ],
    })
    await runPayroll({
      ledgerId: L, payDate: '2026-10-02', periodStart: '2026-09-16', periodEnd: '2026-09-30',
      bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: danaRec.id, gross: parseMoney('3000.00') }],
    })

    const months = await remittanceMonths(L, 2026)
    const runs = await payRuns(L)
    const paidIn = (prefix: string) => runs.filter((r) => r.pay_date.startsWith(prefix) && r.status === 'posted')
    const sep = months.find((m) => m.month === '2026-09'), oct = months.find((m) => m.month === '2026-10')
    const sepFromRuns = paidIn('2026-09').reduce((a, r) => a + r.remittance, 0n)
    // The three parts against the RUNS' own parts — not against each other,
    // which is arithmetic the mapping cannot get wrong (critic).
    const sepCpp = paidIn('2026-09').reduce((a, r) => a + BigInt(r.cpp) + BigInt(r.cpp2) + BigInt(r.employer_cpp) + BigInt(r.employer_cpp2), 0n)
    const sepEi = paidIn('2026-09').reduce((a, r) => a + BigInt(r.ei) + BigInt(r.employer_ei), 0n)
    const sepTax = paidIn('2026-09').reduce((a, r) => a + BigInt(r.income_tax), 0n)
    check(!!sep && !!oct && sep.runs === paidIn('2026-09').length && oct.runs === paidIn('2026-10').length
          && sep.total === sepFromRuns && sep.total > 0n
          && sep.cpp === sepCpp && sep.ei === sepEi && sep.incomeTax === sepTax,
      'PR43 a month\'s remittance is the sum of the runs PAID in it, and its three parts foot',
      sep && oct ? `September ${sep.runs} run(s) = ${sep.total}; the period ending 30 September paid 2 October is October's (${oct.runs} run)` : 'a month is missing')

    const aug = months.find((m) => m.month === '2026-08')
    check(!!aug && aug.employees === 1,
      'PR44 the headcount is the last pay period\'s, not everybody paid that month',
      `${aug?.employees} on the 31st (two were paid on the 15th)`)

    check(aug?.dueOn === '2026-09-15' && remittanceDueOn('2026-12') === '2027-01-15',
      'PR45 due the 15th of the next month, December included',
      `August → ${aug?.dueOn}, December → ${remittanceDueOn('2026-12')}`)

    // Every posted run's remittance adds to the liability account and nothing
    // in this suite pays CRA, so what is owed IS this year's total — and a
    // reversed run is in neither (the first version counted its stubs, and
    // this line is what said so).
    const owed = await payrollOwed(L)
    const yearTotal = months.reduce((a, m) => a + m.total, 0n)
    check(owed.account !== null && owed.balance === yearTotal,
      'PR46 what is still owed is the payroll-liabilities balance, which the posted runs add up to',
      `${owed.account}: ${owed.balance} owed, ${yearTotal} withheld by posted runs this year`)

    // A pay run's entry cannot be AMENDED: amendEntry re-points bank matches
    // and applications to the replacement but no trigger lets pay_run follow
    // (0051 froze it), so the run would vanish from the PD7A while its money
    // stayed in the liability (critic). Reverse and run again is the path.
    const [aug15] = paidIn('2026-08')
    let refused = ''
    try {
      await amendEntry(aug15.entry_id!, {
        entryDate: aug15.pay_date, description: 'Trying to amend a pay run', actor: 'alicio@example.test',
        lines: [{ accountId: id['1000'], amount: 100n }, { accountId: id['5100'], amount: -100n }],
      }, 'alicio@example.test')
    } catch (e) { refused = (e as { code?: string }).code ?? fullMessage(e) }
    const after = await remittanceMonths(L, 2026)
    check(refused === 'PAYROLL_ENTRY' && after.find((m) => m.month === '2026-08')?.runs === 2,
      'PR47 a pay run\'s entry refuses to be amended, and the month keeps both its runs',
      `${refused}; August still has ${after.find((m) => m.month === '2026-08')?.runs} runs`)

    // PR48 — THE BONUS MEMO IS ASKED THE SAME TWO QUESTIONS AS EVERY OTHER FIGURE
    //        ON THE ROW. It is part of the gross, so it cannot exceed it, and pay
    //        cannot be negative. 0072's CHECK is the backstop for anything that
    //        skips this door; the door exists so a person gets a sentence naming
    //        them instead of a constraint violation (independent critic,
    //        2026-09-11: the column shipped with no application-level guard).
    {
      const runs = async (bonus: bigint) => {
        try {
          await previewPayRun({
            ledgerId: L, payDate: '2026-09-15',
            lines: [{ employeeId: danaRec.id, gross: parseMoney('3000.00'), bonus }],
          })
          return ''
        } catch (e) { return e instanceof PayrollError ? e.code : fullMessage(e) }
      }
      const negative = await runs(-parseMoney('100.00'))
      const tooBig = await runs(parseMoney('4000.00'))
      const fine = await runs(parseMoney('500.00'))
      check(negative === 'NEGATIVE' && tooBig === 'MORE_THAN_GROSS' && fine === '',
        'PR48 a bonus cannot be negative, nor more than the gross it is part of',
        `${negative || 'a negative bonus was ACCEPTED'}; `
        + `${tooBig || 'a bonus above the gross was ACCEPTED'}; `
        + `a bonus inside the gross ${fine === '' ? 'is accepted' : `is refused: ${fine}`}`)
    }
  } catch (e) {
    fail('PR43 a month\'s remittance is the sum of the runs PAID in it, and its three parts foot',
      `the reader threw: ${fullMessage(e).slice(0, 110)}`)
  }

  // PR54 — THE YEAR IS THE CALLER'S. `yearToDate` used to take its calendar
  //        year from the bound it was given: the day before the exclusive bound.
  //        A T4 passing 1 January next got the right year; a pay run whose pay
  //        date IS 1 January got the year before it — the whole old year as
  //        this cheque's year-to-date, every ceiling met, no CPP and no EI
  //        withheld (audit, 2026-09-13; live the day a second year's tables
  //        exist). The year is now an argument. Asked the two ways a New Year's
  //        Day pay run and a T4 ask, the same bound gives two answers.
  {
    const asNewYear = (await yearToDate(L, [danaRec.id], '2027-01-01', 2027)).get(danaRec.id)
    const asT4 = (await yearToDate(L, [danaRec.id], '2027-01-01', 2026)).get(danaRec.id)
    check((asNewYear === undefined || asNewYear.periods === 0) && asT4 !== undefined && asT4.periods > 0,
      'PR54 the year to date is the year the caller names, not the year before its bound',
      `1 January 2027 asked as a pay run: ${asNewYear?.periods ?? 0} period(s); asked as 2026's T4: ${asT4?.periods ?? 0}`)
  }

  // PR55 — THE JULY FIGURE, CONFIRMED. The 123rd edition's BC reduction failed
  //        the phase-out identity (805 on file, 690 implied) and was carried as
  //        "confirm". Read against T4127 on canada.ca (2026-09-13): the maximum
  //        is prorated to $805 for July–December, the endpoints and the rate are
  //        the annual ones, so the published formula itself steps from $115 to
  //        nothing at $44,952. The edition now says where it was confirmed and
  //        the checker stops asking; an edition without that word is still
  //        asked. And an edition is named for the year it starts in.
  {
    const july = EDITIONS.find((e) => e.id === '2026-07')!
    const stillAsked = problemsWith(july).confirm
    const unconfirmed: RateEdition = {
      ...july, bc: { ...july.bc, taxReduction: { ...july.bc.taxReduction, confirmed: undefined } },
    }
    const askedAgain = problemsWith(unconfirmed).confirm
    // A next-year table built by spreading this one carries the numbers, not
    // the reading: the confirmation names its edition and is honoured for it alone.
    const spread: RateEdition = { ...july, id: '2027-07', startsOn: '2027-07-01' }
    const inherited = problemsWith(spread).confirm
    const misnamed = problemsWith({ ...EDITIONS[0]!, id: '2027-01' }).wrong
    check(stillAsked.length === 0 && (july.bc.taxReduction.confirmed?.source ?? '').includes('T4127')
          && july.bc.taxReduction.confirmed?.edition === '2026-07'
          && askedAgain.length === 1 && inherited.length === 1 && misnamed.some((w) => w.includes('named for 2027')),
      'PR55 the confirmed July reduction is no longer queried, an unconfirmed or inherited one still is, and an edition is named for its year',
      `2026-07: ${stillAsked.length} query(ies), confirmed for ${july.bc.taxReduction.confirmed?.edition} by "${(july.bc.taxReduction.confirmed?.source ?? '').slice(0, 40)}…"; `
        + `the same table unconfirmed: ${askedAgain.length}, spread into 2027-07: ${inherited.length}; `
        + `a 2027 id on the 2026 table: ${misnamed.length ? misnamed[0] : 'not refused'}`)
  }

  // PR56 — EXEMPT FROM WHAT. An owner over 40% of the votes is not in insurable
  //        employment; a person over 70 or with a CPT30 on file pays no CPP.
  //        The record says which (0074); the run then carries nought insurable
  //        or pensionable, withholds nought, and the T4 marks box 28.
  {
    const owner = await mkParty('Olga Ownsit', 'employee')
    const senior = await mkParty('Sam Seventy', 'employee')
    const ownerRec = await saveEmployee({ ledgerId: L, partyId: owner.id, frequency: 'semi_monthly',
      hiredOn: hired, eiExempt: true, actor: 'alicio@example.test' })
    const seniorRec = await saveEmployee({ ledgerId: L, partyId: senior.id, frequency: 'semi_monthly',
      hiredOn: hired, cppExempt: true, actor: 'alicio@example.test' })
    const preview = await previewPayRun({ ledgerId: L, payDate: '2026-09-15', lines: [
      { employeeId: ownerRec.id, gross: parseMoney('4000.00') },
      { employeeId: seniorRec.id, gross: parseMoney('4000.00') },
    ]})
    const o = preview.stubs.find((x) => x.employeeId === ownerRec.id)!
    const sr = preview.stubs.find((x) => x.employeeId === seniorRec.id)!
    await runPayroll({ ledgerId: L, payDate: '2026-09-15', periodStart: '2026-09-01', periodEnd: '2026-09-15',
      bankAccountId: id['1000'], actor: 'alicio@example.test', lines: [
        { employeeId: ownerRec.id, gross: parseMoney('4000.00') },
        { employeeId: seniorRec.id, gross: parseMoney('4000.00') },
      ] })
    // Flagged after a pay was withheld: CRA marks box 28 only for the entire
    // period, so the mark comes from the year's stubs, and the slip says why
    // it is blank. And a typed figure for an exempt person is refused in words.
    const late = await mkParty('Lee Latecomer', 'employee')
    const lateRec = await saveEmployee({ ledgerId: L, partyId: late.id, frequency: 'semi_monthly',
      hiredOn: hired, actor: 'alicio@example.test' })
    await runPayroll({ ledgerId: L, payDate: '2026-09-30', periodStart: '2026-09-16', periodEnd: '2026-09-30',
      bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: lateRec.id, gross: parseMoney('2000.00') }] })
    await saveEmployee({ ledgerId: L, partyId: late.id, id: lateRec.id, frequency: 'semi_monthly',
      hiredOn: hired, eiExempt: true, actor: 'alicio@example.test' })
    let typed = ''
    try {
      await previewPayRun({ ledgerId: L, payDate: '2026-10-15', lines: [{ employeeId: ownerRec.id, gross: parseMoney('100.00'), insurable: parseMoney('100.00') }] })
    } catch (e) { typed = e instanceof PayrollError ? e.code : String(e) }
    let typedCpp = ''
    try {
      await previewPayRun({ ledgerId: L, payDate: '2026-10-15', lines: [{ employeeId: seniorRec.id, gross: parseMoney('100.00'), pensionable: parseMoney('100.00') }] })
    } catch (e) { typedCpp = e instanceof PayrollError ? e.code : String(e) }
    // Flagged, and never paid this year: nothing was withheld, so the slip must
    // not say it was — the reason is "no pay", and the slip is empty.
    const nia = await mkParty('Nia Nopay', 'employee')
    const niaRec = await saveEmployee({ ledgerId: L, partyId: nia.id, frequency: 'semi_monthly',
      hiredOn: hired, eiExempt: true, actor: 'alicio@example.test' })
    const t4 = await t4Year(L, 2026)
    const box28 = (who: string) => t4.employees.find((e) => e.employeeId === who)?.boxes.find((b) => b.box === '28')
    const dana28 = box28(danaRec.id)
    const late28 = box28(lateRec.id)
    const nia28 = box28(niaRec.id)
    const niaSlip = t4.employees.find((e) => e.employeeId === niaRec.id)
    check(o.ei === 0n && o.employerEi === 0n && o.insurable === 0n && o.cpp > 0n && o.pensionable > 0n
          && sr.cpp === 0n && sr.cpp2 === 0n && sr.employerCpp === 0n && sr.pensionable === 0n && sr.ei > 0n
          && box28(ownerRec.id)?.text === 'EI' && box28(seniorRec.id)?.text === 'CPP'
          && dana28 !== undefined && dana28.text === undefined && (dana28.absent ?? '').includes('This person is not')
          && late28 !== undefined && late28.text === undefined && (late28.absent ?? '').includes('entire period')
          && niaSlip?.empty === true && nia28 !== undefined && nia28.text === undefined && (nia28.absent ?? '').includes('No pay')
          && typed === 'EXEMPT' && typedCpp === 'EXEMPT',
      'PR56 an exempt person is exempt on the stub, in the run, and on the T4\'s box 28 — for a whole year only',
      `owner: EI ${formatMoney(o.ei)} (employer ${formatMoney(o.employerEi)}), insurable ${formatMoney(o.insurable)}, CPP ${formatMoney(o.cpp)}; `
        + `senior: CPP ${formatMoney(sr.cpp)} + ${formatMoney(sr.cpp2)}, pensionable ${formatMoney(sr.pensionable)}, EI ${formatMoney(sr.ei)}; `
        + `box 28: owner "${box28(ownerRec.id)?.text ?? '—'}", senior "${box28(seniorRec.id)?.text ?? '—'}", Dana "${dana28?.text ?? '—'}", `
        + `flagged mid-year "${late28?.text ?? '—'}" (${(late28?.absent ?? '').includes('entire period') ? 'says entire period' : 'no reason'}), `
        + `flagged and never paid "${nia28?.text ?? '—'}" (${niaSlip?.empty ? 'empty slip' : 'a slip'}, ${(nia28?.absent ?? '').includes('No pay') ? 'says no pay' : 'no reason'}); `
        + `Dana's reason ${(dana28?.absent ?? '').includes('This person is not') ? 'is about her' : 'is about the room'}; `
        + `a typed insurable figure for the owner: ${typed || 'accepted'}, a typed pensionable figure for the senior: ${typedCpp || 'accepted'}`)
  }

  // PR57 — BLOCK 15A SAYS HOW MANY PERIODS IT COUNTED HOURS FOR. Twenty-seven
  //        periods with hours entered on three is not twenty-seven periods of
  //        hours; the summary carries the count so the page can say so.
  {
    const part = await mkParty('Pat Parttime', 'employee')
    const partRec = await saveEmployee({ ledgerId: L, partyId: part.id, frequency: 'semi_monthly',
      hiredOn: hired, actor: 'alicio@example.test' })
    await runPayroll({ ledgerId: L, payDate: '2026-08-14', periodStart: '2026-08-01', periodEnd: '2026-08-14',
      bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: partRec.id, gross: parseMoney('1200.00'), hours: 4000n }] })
    await runPayroll({ ledgerId: L, payDate: '2026-08-28', periodStart: '2026-08-15', periodEnd: '2026-08-28',
      bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: partRec.id, gross: parseMoney('1200.00') }] })
    const roe = await roeSummary(L, partRec.id)
    check(roe.covered.hours === 2 && roe.covered.hoursRecorded === 1 && roe.insurableHours === 4000n,
      'PR57 an ROE whose hours were entered on some periods only says on how many',
      `${roe.covered.hoursRecorded} of ${roe.covered.hours} period(s) had hours; 15A total ${roe.insurableHours ?? 'none'}`)
  }
  // ------------------------------------------------- the CRA numbers, as data --
  //
  // 0082. The owner could not see the T4127 figures in the app and had no way to
  // give it a new edition (2026-09-16). These hold the three halves of the
  // answer: every figure is shown, a new edition goes in through a form that
  // proves it first, and one that is not loaded refuses rather than mis-prices.
  const july = EDITIONS.find((e) => e.id === '2026-07')!

  // PR63 — SOMEBODY PUT ON THE PAYROLL BY MISTAKE COMES OFF IT (0084). The
  //        owner: 「所有的紀錄儘量都可以編輯刪除」. A record nobody was ever paid
  //        from is deleted and its person stays on the list; Dana, who was
  //        paid, is refused and told to untick Active, and her record stays;
  //        another company's ledger cannot name either.
  {
    const oops = await mkParty('Mistaken Hire', 'employee')
    const oopsRec = await saveEmployee({ ledgerId: L, partyId: oops.id, frequency: 'monthly', hiredOn: hired, actor: 'alicio@example.test' })
    const del = (ledgerId: string, employeeId: string) => {
      const fd = new FormData()
      fd.set(F.ledgerId, ledgerId); fd.set(F.employeeId, employeeId)
      // Caught: a refusal that arrives as a raw database error is a red line
      // here, not a suite that dies before it can say so.
      return deleteEmployeeFromForm(fd, 'alicio@example.test').catch((e: unknown) => ({ error: `threw: ${String(e).slice(0, 80)}`, ok: undefined }))
    }
    const fromOther = await del(other.ledger.id, oopsRec.id)
    const gone = await del(L, oopsRec.id)
    const paid = await del(L, danaRec.id)
    const [counts] = await db.execute<{ oops: number; dana: number; person: number }>(raw`
      SELECT (SELECT count(*)::int FROM payroll_employee WHERE id = ${oopsRec.id}::uuid) AS oops,
             (SELECT count(*)::int FROM payroll_employee WHERE id = ${danaRec.id}::uuid) AS dana,
             (SELECT count(*)::int FROM party WHERE id = ${oops.id}::uuid) AS person`)
    check(fromOther.error === "That is not in this company's books." && gone.ok?.includes('Mistaken Hire is off the payroll') === true
          && paid.error?.includes('Untick Active') === true && counts.oops === 0 && counts.dana === 1 && counts.person === 1,
      'PR63 a payroll record never paid from is deleted; one somebody was paid from stays',
      `from another company: ${fromOther.error ?? fromOther.ok}; never paid: ${gone.ok ?? gone.error}; `
        + `Dana: ${(paid.error ?? paid.ok ?? '').slice(0, 90)}; rows: mistaken ${counts.oops}, Dana ${counts.dana}, the person ${counts.person}`)
  }

  // PR58 — EVERY FIGURE IS ON THE SCREEN, AND THE FORM READS BACK WHAT IT SHOWS.
  //        The figures view renders a cell per figure of the catalogue, holding
  //        the edition's own value; and reading those same values back through
  //        the form's parser gives the edition's numbers — one list, not three.
  {
    const html = (JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-editions.tsx', july.id],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const cells = [...html.matchAll(/data-figure="([^"]+)">([^<]*)</g)].map((m) => [m[1], m[2]] as const)
    const wrongCells = ALL_FIGURES.filter((f) => !cells.some(([path, v]) => path === f.path && v === figureOf(july, f.path)))
    const read = editionFromFigures({ id: july.id, startsOn: july.startsOn, authority: july.authority },
      (path) => figureOf(july, path))
    // Key order is not a figure, and `confirmed` is the code's note on where a
    // figure was checked — not a figure either, so the form does not ask it.
    const canon = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) =>
      x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'confirmed').sort(([a], [b]) => a.localeCompare(b)))
        : x)
    const same = read.edition !== null
      && canon([read.edition.cppEi, read.edition.federal, read.edition.bc]) === canon([july.cppEi, july.federal, july.bc])
    check(cells.length === ALL_FIGURES.length && wrongCells.length === 0 && read.problems.length === 0 && same,
      'PR58 every figure of an edition is on the screen, and the form reads back exactly those numbers',
      `${cells.length} cell(s) for ${ALL_FIGURES.length} figure(s)`
        + (wrongCells.length ? `; wrong or missing: ${wrongCells.map((f) => f.path).join(', ')}` : '')
        + `; read back ${read.problems.length ? `with problems: ${read.problems[0]}` : same ? 'as the same numbers' : 'as DIFFERENT numbers'}`)
  }

  // The form a person fills in: July 2026's figures relabelled as a January 2027
  // edition, and a PDOC example whose answers are what those very figures give
  // for the same pay in July 2026 — the only PDOC answers a check can know.
  const pdocPay = { frequency: 'semi_monthly' as const, gross: parseMoney('3000.00'),
    federalClaim: parseMoney(july.federal.bpaf.max), bcClaim: parseMoney(july.bc.basicPersonalAmount) }
  const truth = calculatePayroll({ payDate: '2026-07-15', ...pdocPay })
  const editionForm = (startsOn: string, change: (fd: FormData) => void = () => {}) => {
    const fd = new FormData()
    fd.set('ledgerId', '00000000-0000-4000-8000-000000000000')
    fd.set(EDITION_HEAD.startsOn, startsOn)
    fd.set(EDITION_HEAD.authority, `A test edition from ${startsOn}, July 2026's figures again.`)
    for (const f of ALL_FIGURES) fd.set(f.path, figureOf(july, f.path))
    fd.set(PDOC_FIELDS.payDate, `${startsOn.slice(0, 8)}15`)
    fd.set(PDOC_FIELDS.frequency, pdocPay.frequency)
    fd.set(PDOC_FIELDS.gross, '3000.00')
    fd.set(PDOC_FIELDS.federalClaim, july.federal.bpaf.max)
    fd.set(PDOC_FIELDS.bcClaim, july.bc.basicPersonalAmount)
    fd.set(PDOC_FIELDS.cpp, formatMoney(truth.cpp)); fd.set(PDOC_FIELDS.cpp2, formatMoney(truth.cpp2))
    fd.set(PDOC_FIELDS.ei, formatMoney(truth.ei)); fd.set(PDOC_FIELDS.federalTax, formatMoney(truth.federalTax))
    fd.set(PDOC_FIELDS.provincialTax, formatMoney(truth.provincialTax))
    change(fd)
    return fd
  }
  const rowCount = async () => Number((await db.execute<{ n: string }>(raw`SELECT count(*)::text AS n FROM payroll_rate_edition`))[0].n)
  const idOn = (d: string) => { try { return editionFor(d).id } catch (e) { return e instanceof PayrollError ? e.code : String(e) } }

  // PR59 — A NEW EDITION GOES IN THROUGH THE FORM, AND PAYROLL CAN RUN INTO IT.
  //        Before: a 2027 pay date is refused by name. After the form door:
  //        a row with its PDOC case, an audit row, the list extends to the end
  //        of 2027 and a March 2027 pay date resolves to the new edition.
  {
    await loadEditions()
    const before = idOn('2027-03-15')
    const said = await addEditionFromForm(editionForm('2027-01-01'), 'alicio@example.test')
    await loadEditions()
    const after = idOn('2027-03-15')
    const [row] = await db.execute<{ pdoc: { payDate: string }; created_by: string }>(raw`
      SELECT pdoc, created_by FROM payroll_rate_edition WHERE id = '2027-01'`)
    const [audit] = await db.execute<{ n: string }>(raw`
      SELECT count(*)::text AS n FROM audit_log WHERE action = 'add_edition' AND record_id = '2027-01'`)
    const records = await editionRecords()
    const listed = records.find((r) => r.edition.id === '2027-01')
    check(before === 'NO_TABLES' && said.ok?.startsWith('Added 2027-01.') === true && after === '2027-01'
          && lastCoveredDate() === '2027-12-31' && row?.pdoc.payDate === '2027-01-15' && Number(audit?.n) === 1
          && listed?.added?.by === 'alicio@example.test' && records.filter((r) => r.added === null).length === EDITIONS.length,
      'PR59 a new edition goes in through the form, and a pay date in it resolves to it',
      `a March 2027 pay date before: ${before}; the form said ${(said.ok ?? said.error ?? '').slice(0, 90)}; after: ${after}; `
        + `covered to ${lastCoveredDate()}; the row kept its PDOC case ${row ? 'yes' : 'NO ROW'}; ${audit?.n ?? 0} audit row(s); `
        + `listed as added by ${listed?.added?.by ?? 'nobody'}`)
  }

  // PR60 — AND NOTHING WRONG GOES IN. From July 2027, one fault at a time:
  //        a K constant off by one (the tables disagree with themselves); the
  //        PDOC federal tax a cent out (the tables are consistent but are not
  //        what CRA computes); a start that is not after the last edition; a
  //        figure that is not a number. Each is refused by name, and not one
  //        row is written. Then the same form with no fault goes in — so each
  //        refusal was its fault's, and a second edition in a year the app
  //        added is not mistaken for different CPP/EI (jsonb reorders keys).
  {
    const rows = await rowCount()
    const faults: Array<[string, FormData, string]> = [
      ['a K constant off by one', editionForm('2027-07-01', (fd) => fd.set('federal.constants', figureOf(july, 'federal.constants').replace('3804', '3805'))), 'These tables do not add up, so nothing was saved'],
      ['the PDOC federal tax a cent out', editionForm('2027-07-01', (fd) => fd.set(PDOC_FIELDS.federalTax, formatMoney(truth.federalTax + 1n))), 'federal tax: PDOC says'],
      ['a start not after the last edition', editionForm('2027-01-01'), 'starts after the last one on file'],
      ['a figure that is not a number', editionForm('2027-07-01', (fd) => fd.set('cppEi.ei.rate', 'one point six')), 'is not a number'],
    ]
    const results: Array<readonly [string, boolean, string]> = []
    for (const [what, fd, needle] of faults) {
      const out = await addEditionFromForm(fd, 'alicio@example.test')
      results.push([what, out.error?.includes(needle) === true, out.error ?? out.ok ?? 'nothing'])
    }
    const slipped = results.filter(([, refused]) => !refused)
    const rowsAfter = await rowCount()
    const control = await addEditionFromForm(editionForm('2027-07-01'), 'alicio@example.test')
    const controlRows = await rowCount()
    await removeEditionFromForm((() => { const fd = new FormData(); fd.set(EDITION_HEAD.editionId, '2027-07'); return fd })(), 'alicio@example.test')
    check(slipped.length === 0 && rowsAfter === rows && control.ok !== undefined && controlRows === rows + 1,
      'PR60 an edition whose figures disagree, or that PDOC does not confirm, or that is out of order, is refused whole',
      `${results.map(([what, refused, said]) => `${what}: ${refused ? 'refused' : `NOT REFUSED (${said.slice(0, 50)})`}`).join('; ')}; `
        + `rows ${rows} → ${rowsAfter}; with no fault: ${control.ok ? 'added' : `REFUSED (${(control.error ?? '').slice(0, 120)})`}`)
  }

  // PR61 — EVERY DOOR THAT COMPUTES READS THE ADDED EDITIONS ITSELF. A fresh
  //        server knows only the built-in editions until something loads the
  //        rest, and the first thing pressed may be a preview or a T4 rather
  //        than the payroll screen. With the process's list emptied, each
  //        door is asked about 2027 cold: the preview computes the stub under
  //        2027-01, and the T4 year has its CPP and EI ceilings.
  {
    const cold = async <T,>(what: () => Promise<T>): Promise<[T | null, string]> => {
      setAddedEditions([])
      try { return [await what(), ''] } catch (e) { return [null, e instanceof PayrollError ? e.code : String(e)] }
    }
    const [preview, previewSaid] = await cold(() => previewPayRun({ ledgerId: L, payDate: '2027-01-15',
      lines: [{ employeeId: danaRec.id, gross: parseMoney('3000.00') }] }))
    const [t4, t4Said] = await cold(() => t4Year(L, 2027))
    await loadEditions()
    check(preview?.stubs[0]?.edition === '2027-01' && t4 !== null,
      'PR61 a preview and a T4 year read the editions added in the app themselves, cold',
      `preview of a January 2027 payday: ${preview ? `computed under ${preview.stubs[0]?.edition}` : `REFUSED (${previewSaid})`}; `
        + `the 2027 T4 year: ${t4 ? 'has its ceilings' : `REFUSED (${t4Said})`}`)
  }

  // PR62 — A DOOR THAT FORGOT TO LOAD REFUSES; REMOVING IS FOR WHAT NOTHING USED.
  //        With the added editions not read in, the March 2027 pay date is
  //        refused rather than computed with 2026's tables. A built-in edition
  //        cannot be removed. An added one that a pay stub names stays — the
  //        stub's amounts were worked out from it — and once nothing names it,
  //        it goes and the coverage steps back to the end of 2026.
  {
    const removeForm = (id: string) => { const fd = new FormData(); fd.set(EDITION_HEAD.editionId, id); return fd }
    setAddedEditions([])
    const unloaded = idOn('2027-03-15')
    await loadEditions()
    const loaded = idOn('2027-03-15')
    const builtIn = await removeEditionFromForm(removeForm('2026-07'), 'alicio@example.test')
    // A July 2027 on top of the January: taking the January out from under it
    // would leave 2027 starting in July, and every computation of every company
    // refusing the whole list, with no way to add a January back (critic,
    // 2026-09-16). Refused; the July goes first, and then the January may.
    const july2027 = await addEditionFromForm(editionForm('2027-07-01'), 'alicio@example.test')
    const underJuly = await removeEditionFromForm(removeForm('2027-01'), 'alicio@example.test')
    const julyGone = await removeEditionFromForm(removeForm('2027-07'), 'alicio@example.test')
    // A stub computed with 2027-01: a copy of one on file, on an unposted run
    // of its own so it can be taken away again (a posted run's stubs cannot).
    const [run] = await db.execute<{ id: string }>(raw`
      INSERT INTO pay_run (ledger_id, pay_date, bank_account_id, created_by)
      SELECT ledger_id, '2027-01-15', bank_account_id, 'alicio@example.test' FROM pay_run LIMIT 1
      RETURNING id`)
    await db.execute(raw`
      INSERT INTO pay_stub (pay_run_id, employee_id, edition, frequency, gross, pensionable, insurable,
                            cpp, cpp2, ei, federal_tax, provincial_tax, additional_tax, income_tax, net_pay,
                            employer_cpp, employer_cpp2, employer_ei)
      SELECT ${run.id}, employee_id, '2027-01', frequency, gross, pensionable, insurable,
             cpp, cpp2, ei, federal_tax, provincial_tax, additional_tax, income_tax, net_pay,
             employer_cpp, employer_cpp2, employer_ei FROM pay_stub LIMIT 1`)
    const inUse = await removeEditionFromForm(removeForm('2027-01'), 'alicio@example.test')
    const stillThere = (await rowCount()) === 1
    await db.execute(raw`DELETE FROM pay_run WHERE id = ${run.id}`)
    const removed = await removeEditionFromForm(removeForm('2027-01'), 'alicio@example.test')
    const coveredAfter = lastCoveredDate()
    const rowsAfter = await rowCount()
    check(unloaded === 'NO_TABLES' && loaded === '2027-01' && builtIn.error?.includes('built into the app') === true
          && july2027.ok !== undefined && underJuly.error?.includes('would leave editions payroll cannot use') === true
          && julyGone.ok?.startsWith('Removed 2027-07.') === true
          && inUse.error?.includes('1 pay stub was computed with 2027-01') === true && stillThere
          && removed.ok?.startsWith('Removed 2027-01.') === true && coveredAfter === '2026-12-31' && rowsAfter === 0,
      'PR62 an edition not loaded is refused, not guessed; only an added edition no stub names, and nothing later rests on, can be removed',
      `unloaded: ${unloaded}; loaded: ${loaded}; removing a built-in: ${builtIn.error ?? builtIn.ok}; `
        + `the January under a July: ${(underJuly.error ?? `REMOVED (${underJuly.ok})`).slice(0, 80)}; the July: ${julyGone.ok ?? julyGone.error}; `
        + `removing it while a stub names it: ${inUse.error ?? `REMOVED (${inUse.ok})`}; `
        + `once nothing does: ${removed.ok ?? removed.error}; covered to ${coveredAfter}; ${rowsAfter} row(s) left`)
  }

  // PR64 — AN EDITION ADDED IN THE APP THAT A LATER RELEASE BUILDS IN. The row
  //        stays in the database when the release ships the same edition; two
  //        of one id on the list would refuse every computation of every
  //        company (critic, 2026-09-16). The list ignores the copy; the payroll
  //        screen shows it under the built-in edition, says whether the figures
  //        agree, and offers Remove. While stubs were computed under a copy whose
  //        figures differ, Remove is refused — the copy is their record; once
  //        they agree it goes, and the trail keeps the copy's figures and PDOC.
  {
    const july = EDITIONS.find((e) => e.id === '2026-07')!
    const differentBc = { ...july.bc, basicPersonalAmount: '13300.00' }
    await db.execute(raw`
      INSERT INTO payroll_rate_edition (id, starts_on, authority, cpp_ei, federal, bc, pdoc, created_by)
      VALUES ('2026-07', '2026-07-01', 'added in the app before the release shipped it',
              ${JSON.stringify(july.cppEi)}::jsonb, ${JSON.stringify(july.federal)}::jsonb,
              ${JSON.stringify(differentBc)}::jsonb, '{"payDate":"2026-07-15"}'::jsonb, 'alicio@example.test')`)
    await loadEditions()
    let computes = ''
    try { computes = editionFor('2026-08-15').id } catch (e) { computes = e instanceof PayrollError ? e.code : String(e) }
    const records = (await editionRecords()).filter((x) => x.edition.id === '2026-07')
    const copy = records[0]?.copy
    const html = copy ? (JSON.parse(execFileSync('npx', ['tsx', 'scripts/render-editions.tsx', '2026-07', JSON.stringify(copy)],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html : ''
    const offered = html.includes(`name="${EDITION_HEAD.editionId}" value="2026-07"`) && html.includes('DIFFER from the copy')
    const [stubs] = await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM pay_stub WHERE edition = '2026-07'`)
    const removeForm = () => { const fd = new FormData(); fd.set(EDITION_HEAD.editionId, '2026-07'); return fd }
    const whileDifferent = await removeEditionFromForm(removeForm(), 'alicio@example.test')
    await db.execute(raw`UPDATE payroll_rate_edition SET bc = ${JSON.stringify(july.bc)}::jsonb WHERE id = '2026-07'`)
    const sameNow = (await editionRecords()).find((x) => x.edition.id === '2026-07')?.copy?.sameFigures
    const copyGone = await removeEditionFromForm(removeForm(), 'alicio@example.test')
    const [left] = await db.execute<{ n: number }>(raw`SELECT count(*)::int AS n FROM payroll_rate_edition WHERE id = '2026-07'`)
    const [trail] = await db.execute<{ before: { bc?: { basicPersonalAmount?: string }; pdoc?: { payDate?: string } } }>(raw`
      SELECT before FROM audit_log WHERE action = 'remove_edition' AND record_id = '2026-07' ORDER BY id DESC LIMIT 1`)
    const again = await removeEditionFromForm(removeForm(), 'alicio@example.test')
    check(computes === '2026-07' && records.length === 1 && copy?.sameFigures === false && offered
          && stubs.n > 0 && whileDifferent.error?.includes('The copy stays as their record') === true
          && sameNow === true && copyGone.ok !== undefined && left.n === 0
          && trail?.before?.bc?.basicPersonalAmount === july.bc.basicPersonalAmount && trail.before.pdoc?.payDate === '2026-07-15'
          && again.error?.includes('built into the app') === true,
      'PR64 an added copy of an edition a release builds in is ignored, shown with Remove, and kept while stubs rest on different figures',
      `an August 2026 pay date with the copy on file: ${computes}; listed ${records.length} time(s), the copy ${copy ? (copy.sameFigures ? 'the same' : 'different') : 'NOT SHOWN'}, `
        + `Remove ${offered ? 'offered' : 'NOT offered'}; ${stubs.n} stub(s) name 2026-07; removing while different: `
        + `${(whileDifferent.error ?? `REMOVED (${whileDifferent.ok})`).slice(0, 70)}; once the same: ${copyGone.ok ?? copyGone.error} `
        + `(${left.n} row(s) left, trail ${trail ? 'keeps its figures and PDOC' : 'EMPTY'}); again: ${again.error ?? again.ok}`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

const $ = (cents: bigint) => formatMoney(cents)
/** A thing the FIXTURE must have. Missing, it says so rather than throwing four frames later. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    console.log(`the fixture has no ${what}, so this check cannot run`)
    process.exit(1)
  }
  return value
}
const sumOf = <K extends string>(rows: Array<Record<K, string>>, key: K): bigint =>
  rows.reduce((t, r) => t + BigInt(r[key]), 0n)

/** What CRA's calculator said, kept as the strings that were captured. */
const PDOC = [
  {
    label: 'PR1 BC semi-monthly $3,000.00 paid 2026-01-15 matches PDOC',
    input: {
      payDate: '2026-01-15', frequency: 'semi_monthly' as const, gross: parseMoney('3000.00'),
      federalClaim: parseMoney('16452.00'), bcClaim: parseMoney('13216.00'),
    },
    expect: {
      cpp: '169.82', cpp2: '0.00', ei: '48.90', federalTax: '319.59',
      provincialTax: '136.01', incomeTax: '455.60',
      employeeDeductions: '674.32', netPay: '2325.68',
    },
  },
  {
    label: 'PR2 BC bi-weekly $2,000.00 paid 2026-07-15 matches PDOC',
    input: {
      payDate: '2026-07-15', frequency: 'biweekly' as const, gross: parseMoney('2000.00'),
      federalClaim: parseMoney('16452.00'), bcClaim: parseMoney('13216.00'),
    },
    expect: {
      cpp: '110.99', cpp2: '0.00', ei: '32.60', federalTax: '163.23',
      provincialTax: '83.45', incomeTax: '246.68',
      employeeDeductions: '390.27', netPay: '1609.73',
    },
  },
]

const chart = `1000,Cash — Operating,asset,,cash_and_cash_equivalents
2627,Payroll liabilities,liability,,payroll_liabilities
4000,Consulting Revenue,revenue,,revenue_from_contracts
9060,Salaries and wages,expense,,employee_benefits_expense`

async function main() {
  // ---------------------------------------------------------------- PR1, PR2
  // The engine alone, no database in sight. This is the check that says the
  // port is faithful; everything else assumes it.
  for (const c of PDOC) {
    const r = calculatePayroll(c.input) as unknown as Record<string, bigint>
    const wrong = Object.entries(c.expect)
      .filter(([k, want]) => $(r[k]).replace(/,/g, '') !== want)
      .map(([k, want]) => `${k} ${$(r[k])} ≠ ${want}`)
    check(wrong.length === 0, c.label,
      wrong.length ? wrong.join(' | ') : `every figure to the cent (edition ${r.edition})`)
  }

  return done()
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })
