/**
 * SR&ED: the work that was not certain to work, and what it cost.
 *   npm run db:verify-sred   (resets the TEST database first)
 *
 * What is checked here is what decides money and what an auditor asks about:
 * that one dollar cannot be claimed twice, that a specified employee's cap is
 * applied to the YEAR rather than to a stub, that an arm's-length contract is
 * counted at 80% and a non-arm's-length one is not quietly counted at 80%
 * anyway, that capital is listed rather than dropped, and that every rate the
 * paper used names the provision it came from.
 *
 * The narratives and the evidence are not checked for quality — nothing can
 * do that. What is checked is that they are DATED, because contemporaneous is
 * the whole of CRA's test for a record.
 */
import './env'
import { messageOf as errorText, reporter, sourceFiles } from './suite'
import { BASE, fileModule } from './module-map'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql as raw } from 'drizzle-orm'
import { db, sql as conn } from '../src/db/client'
import { createCompanyWithYear, createFiscalYear, planFiscalYear } from '../src/lib/setup'
import { importAccounts, parseAccountsCsv } from '../src/lib/accounts'
import { createParty, updateParty } from '../src/lib/parties'
import { saveProfileFromForm } from '../src/lib/record-forms'
import { RECORD_FIELDS } from '../src/lib/forms'
import { postEntry } from '../src/lib/posting'
import { saveEmployee } from '../src/lib/payroll/employees'
import { runPayroll } from '../src/lib/payroll/runs'
import { parseMoney, formatMoney } from '../src/lib/money'
import {
  SredError, allocate, allocatableLines, allocatableSalary, addEvidence,
  addSredEvidenceBatch, claimsFor, createSredProject, deleteSredEvidence, deleteSredProject,
  deleteSredClaim, deleteSredTime, evidenceFor, evidenceStanding, fileClaim, logSredTime, logSredTimeBatch,
  deleteSredRate, openClaim, saveClaim, saveSredRate, setSredAccountCategory, sredAccountCategories,
  sredProjects, sredRateRows, sredRates,
  timeFor, timeShare, unallocate, unfileClaim,
  updateSredEvidence, updateSredProject, updateSredTime, workingPaper, ympeFor,
} from '../src/lib/sred'
import {
  PROJECT_STATUS, TIME_PASTE_FIELDS, bonusOutOfBase, matchesCost,
  parseEvidencePaste, parseTimePaste, viewedYear,
  type Allocatable,
} from '../src/lib/sred-kinds'
import { ours } from '../src/lib/ours'
import { EDITIONS, setAddedEditions } from '../src/lib/payroll/rates'
import { loadEditions } from '../src/lib/payroll/editions'

const r = reporter(58)
const { check } = r
/** Every .ts and .tsx under src, for the check that reads the whole tree. */

/**
 * EVERY `check` DETAIL IN THIS FILE IS COMPOSED FROM WHAT WAS MEASURED.
 *
 * Not a style note — a rule, arrived at the hard way. A detail that states the
 * expected composition reads as a description of what happened, so the mutation
 * block that breaks exactly that composition records a line saying it did not.
 * The evidence file then contains a block whose title, narrative and captured
 * output disagree with each other, and it is the captured output a reader
 * trusts. It was fixed in S24, then reintroduced in S4 in the same pass, then
 * found again in S27, S29, S8, S9, S6 and S25 (independent critic, four rounds
 * running, 2026-09-11).
 *
 * The shape that works: print the figure the code produced, then the one it was
 * supposed to produce, labelled — and report EVERY clause the condition tests,
 * not only the ones that make a good sentence. A clause the detail is silent
 * about is a clause whose failure the evidence cannot explain.
 *
 * TWO THINGS THAT DO NOT CATCH IT. Reading the details looking for prose that
 * sounds wrong caught six of the nine. A script matching identifiers in the
 * condition against text in the detail caught a seventh and missed two more, in
 * the same way both times: the variables were called `unsaid` and `allowed`, and
 * those words were sitting in the very prose being asserted. What does catch it
 * is asking, clause by clause, "if only this one failed, what would this line
 * say?" — which is the question the loop above should be read with.
 *
 * AND ONE THAT THE QUESTION ONLY HALF ANSWERS. Asked of S18, it gave the right
 * answer for the wrong reason: the detail DID report the cap sentence, so the
 * clause looked covered. The clause was testing `capped at` while the paper had
 * been saying `is capped:` since this node renamed it — a conjunct true of every
 * paper that will ever be built, sitting beside a detail reporting the phrase
 * that is real. So the question has a second half: not only "what would this
 * line say", but "can this clause be false at all?" A phrase asserted against
 * produced text is the place to look, because renaming the text is a change
 * nothing makes the assertion follow.
 *
 * AND A SWEEP FOR IT THAT DOES NOT WORK. Checking every `.includes()` literal
 * for existence anywhere under src/ passes `capped at` — the string is in this
 * tree, at sred.ts's line-300 note and in the EI comment; what it is not is
 * reachable by the value being asserted, which is a `toConfirm` entry. The
 * relation to test is literal-reachable-by-THIS-expression, and no grep knows
 * that. The same shape defeats counting: `verify-sred.ts` has five negated
 * membership assertions, and four of them are a named boolean two lines above
 * the `!`, so the syntactic form finds one. Both of those were offered as
 * evidence and neither was (independent critic, 2026-09-12).
 *
 * THREE SPECIES, THEN, and the third is not about phrases at all: a conjunct
 * implied by another conjunct in the same condition, and a fence placed after
 * something that throws before it can be reached. Both read as coverage and
 * hold nothing. S5, S18 and S4 each carried one.
 */

/**
 * A thing the FIXTURE is supposed to have. Missing, it says so and stops —
 * which is not the same as a `!` that throws a TypeError four frames later.
 *
 * The difference matters because of how this file is run: `main().catch()`
 * exits before the `=== N CHECK(S) FAILED ===` line, so any throw outside a
 * `try` turns a mutation block into `SUITE DID NOT FINISH` and kills the whole
 * evidence run. That happened four times in one node, and the fifth was still
 * sitting in code written to fix the fourth (independent critic, 2026-09-11).
 */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    console.error(`the fixture has no ${what}, so this check cannot run`)
    process.exit(1)
  }
  return value
}

/**
 * The whole cause chain, not the outermost wrapper.
 *
 * A driver error arrives as "Failed query: INSERT INTO …" with the database's
 * own sentence — the one naming the trigger that refused — buried in `.cause`.
 * A check that prints only the wrapper says a mutation was caught without
 * saying what caught it, which is how a block gets recorded red for a reason
 * nobody checked (CHANGELOG, 2026-09-07). S3 walks the chain for exactly this;
 * this is that walk, shared.
 */
function errorChain(e: unknown): string {
  const seen: string[] = []
  for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
    const err = cur as { message?: string; cause?: unknown }
    if (err.message) seen.push(err.message.split('\n')[0])
    cur = err.cause
  }
  return seen.join(' | ')
}

const CHART = `1000,Cash — Operating,asset,,cash_and_cash_equivalents
1500,Equipment,asset,,property_plant_equipment
2500,Payroll Liabilities,liability,,payroll_liabilities
3000,Share Capital,equity,,share_capital
4000,Revenue,revenue,,revenue_from_contracts
5000,Salaries and Benefits,expense,,employee_benefits_expense
5100,Materials,expense,,
5200,Subcontractors,expense,,
5300,Rent,expense,,`

async function main() {
  const co = await createCompanyWithYear({ code: 'RND', name: 'Uncertain Works Ltd.', province: 'BC' },
    'alicio@example.test')
  const L = co.ledger.id
  const E = co.company.id
  const yr = Number(co.year.endDate.slice(0, 4))
  const accts = await importAccounts(E,
    parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: E })), 'alicio@example.test')
  const id = Object.fromEntries(accts.map((a) => [a.code, a.id]))

  // A CCPC, because that is what decides the rate — set through the door a
  // person uses, not by raw SQL. Until 2026-09-10 there was no such door and
  // this line was an UPDATE, which meant the fixture proved the column worked
  // and proved nothing about whether anybody could ever set it.
  const sayCcpc = async (answer: '' | 'yes' | 'no') => {
    const f = new FormData()
    f.set(RECORD_FIELDS.ledgerId, L)  // the screen's form always says which books
    f.set(RECORD_FIELDS.entityId, E)
    f.set(RECORD_FIELDS.isCcpc, answer)
    // Recognised INSIDE its own fiscal year, which is what a company
    // incorporated mid-year looks like and is the commonest way a first tax
    // year is short while the ledger keeps twelve months (S28).
    f.set(RECORD_FIELDS.recognitionDate, `${yr}-03-15`)
    const r = await saveProfileFromForm(f, 'alicio@example.test')
    if (r.error) { console.error(`CCPC "${answer}": ${r.error}`); process.exit(1) }
  }
  await sayCcpc('yes')

  // Two people: the owner, who is a specified employee, and somebody who is
  // not. And two contractors, one at arm's length and one not.
  const owner = await createParty({
    kind: 'person', name: 'Dana Owner',
    roles: [{ entityId: E, role: 'employee', heldFrom: co.year.startDate }],
    actor: 'alicio@example.test',
  })
  const hand = await createParty({
    kind: 'person', name: 'Sam Engineer',
    roles: [{ entityId: E, role: 'employee', heldFrom: co.year.startDate }],
    actor: 'alicio@example.test',
  })
  const armsLength = await createParty({
    kind: 'organisation', name: 'Outside Lab Ltd.',
    roles: [{ entityId: E, role: 'supplier', heldFrom: co.year.startDate }],
    actor: 'alicio@example.test',
  })
  const related = await createParty({
    kind: 'organisation', name: 'Sister Company Ltd.',
    roles: [{ entityId: E, role: 'supplier', heldFrom: co.year.startDate }],
    actor: 'alicio@example.test',
  })
  await updateParty({ partyId: related.id, name: 'Sister Company Ltd.',
                      armsLength: false, actor: 'alicio@example.test' })

  const ownerEmp = await saveEmployee({
    ledgerId: L, partyId: owner.id, frequency: 'monthly', sin: '046454286',
    occupation: 'Founder', hiredOn: co.year.startDate, isSpecified: true,
    actor: 'alicio@example.test',
  })
  const handEmp = await saveEmployee({
    ledgerId: L, partyId: hand.id, frequency: 'monthly', sin: '046454286',
    occupation: 'Engineer', hiredOn: co.year.startDate, isSpecified: true,
    actor: 'alicio@example.test',
  })

  // ------------------------------------------------------------ a project --
  const project = await createSredProject({
    entityId: E, code: 'P1', title: 'A method that might not have worked',
    startedOn: `${yr}-01-05`, actor: 'alicio@example.test',
  })
  const claim = await openClaim({
    projectId: project.id, fiscalYearId: co.year.id, actor: 'alicio@example.test',
  })

  // S1 — THE RATES NAME THEIR PROVISIONS. A rate with no authority is a rate
  //      somebody remembered, and this is a claim somebody files.
  {
    const rates = await sredRates(co.year.endDate)
    const bare = rates.filter((r) => !r.authority.trim())
    const unconfirmed = rates.filter((r) => r.confidence === 'unconfirmed')
    const noted = unconfirmed.filter((r) => !!r.note)
    // `unconfirmed.length > 0` is part of the rule, not padding: `every` over an
    // empty list is true, so confirming both rows would have left this green
    // while asserting nothing at all about notes — and the design doc promises
    // those two reach the to-confirm list with their wording. The detail is
    // composed too; it used to print "all with a note" on a failure whose cause
    // was a missing authority (independent critic, 2026-09-11).
    check(rates.length >= 10 && bare.length === 0
      && unconfirmed.length > 0 && noted.length === unconfirmed.length,
      'S1 every rate names the provision it comes from, and every doubt is written down',
      `${rates.length} rates, ${bare.length} with no authority, `
        + `${noted.length} of ${unconfirmed.length} unconfirmed ones carrying a note`)
  }

  // ------------------------------------------------------------- payroll --
  // Twelve months for each. The owner is paid well above the cap so the
  // specified-employee limit has something to bite on.
  for (let m = 1; m <= 12; m++) {
    const day = `${yr}-${String(m).padStart(2, '0')}-28`
    await runPayroll({
      ledgerId: L, payDate: day, periodStart: `${yr}-${String(m).padStart(2, '0')}-01`,
      periodEnd: day, bankAccountId: id['1000'], actor: 'alicio@example.test',
      lines: [
        // 10,000 of the owner's 40,000 is a bonus every month. Without one
        // anywhere the proxy base's exclusion would be arithmetic nothing runs.
        { employeeId: ownerEmp.id, gross: parseMoney('40000.00'), hours: 15000n,
          bonus: parseMoney('10000.00') },
        // Sam is specified too, and under the cap — which is what makes the
        // claim-side sentence testable for somebody the cap never touches — and
        // earns a smaller bonus, so the two figures on the paper (one person's,
        // everybody's) are different numbers (independent critic, 2026-09-11).
        { employeeId: handEmp.id, gross: parseMoney('8000.00'), hours: 15000n,
          bonus: parseMoney('1000.00') },
      ],
    })
  }

  // ---------------------------------------------------------------- time --
  await logSredTime({
    projectId: project.id, employeeId: handEmp.id, onDate: `${yr}-03-04`,
    hours: '6.5', activity: 'Ran the second-generation trial; the seal failed at 40 psi again.',
    actor: 'alicio@example.test',
  })
  await logSredTime({
    projectId: project.id, employeeId: handEmp.id, onDate: `${yr}-03-05`,
    hours: '3.5', activity: 'Analysed the failure; the hypothesis about the gasket is wrong.',
    actor: 'alicio@example.test',
  })

  // S2 — TIME IS A RECORD, AND A RECORD SAYS WHAT WAS DONE. "SR&ED" is not an
  //      activity; the sentence is the evidence CRA reads.
  {
    let refused = ''
    try {
      await logSredTime({ projectId: project.id, employeeId: handEmp.id, onDate: `${yr}-03-06`,
        hours: '8', activity: '   ', actor: 'alicio@example.test' })
    } catch (e) { refused = e instanceof SredError ? e.code : errorText(e) }
    const shareOf = await timeShare({
      projectId: project.id, employeeId: handEmp.id, from: `${yr}-03-01`, to: `${yr}-03-31`,
    })
    check(refused === 'NO_ACTIVITY' && shareOf.onProject === 10 && shareOf.percent === 100,
      'S2 a time record must say what was done, and it is what a salary share is worked out from',
      `${refused}; ${shareOf.onProject}h of ${shareOf.allProjects}h = ${shareOf.percent}%`)
  }

  // --------------------------------------------------------- allocations --
  const stubs = await allocatableSalary(L, co.year.startDate, co.year.endDate)
  const ownerStubs = stubs.filter((s) => s.what === 'Dana Owner')
  const handStubs = stubs.filter((s) => s.what === 'Sam Engineer')
  for (const s of ownerStubs) {
    await allocate({ claimId: claim.id, sourceKind: 'pay_stub', sourceId: s.source_id,
      category: 'salary', percent: '100', basis: 'Full time on the trials all year.',
      actor: 'alicio@example.test' })
  }
  for (const s of handStubs) {
    await allocate({ claimId: claim.id, sourceKind: 'pay_stub', sourceId: s.source_id,
      category: 'salary', percent: '50', basis: 'Half the fortnight on the trials, per the time record.',
      actor: 'alicio@example.test' })
  }

  // Named out here because S23, at the foot of this file, needs a SECOND claim
  // on the same sources to move a row into.
  let secondProjectId = ''

  // S3 — ONE DOLLAR, ONCE. Two projects may share a fortnight; the two shares
  //      may not add to more than the fortnight. The database holds this,
  //      because it is the rule a spreadsheet cannot.
  {
    const second = await createSredProject({
      entityId: E, code: 'P2', title: 'A different uncertainty',
      startedOn: `${yr}-06-01`, actor: 'alicio@example.test' })
    const secondClaim = await openClaim({
      projectId: second.id, fiscalYearId: co.year.id, actor: 'alicio@example.test' })
    secondProjectId = second.id
    let refused = ''
    try {
      await allocate({ claimId: secondClaim.id, sourceKind: 'pay_stub',
        sourceId: handStubs[0].source_id, category: 'salary', percent: '60',
        basis: 'Also on this one.', actor: 'alicio@example.test' })
    } catch (e) {
      const chain: string[] = []
      for (let cur: unknown = e, i = 0; cur && i < 5; i++) {
        const err = cur as { message?: string; cause?: unknown }
        if (err.message) chain.push(err.message)
        cur = err.cause
      }
      refused = chain.join(' | ')
    }
    // …and the half that is left over is allowed.
    let leftover = ''
    try {
      await allocate({ claimId: secondClaim.id, sourceKind: 'pay_stub',
        sourceId: handStubs[0].source_id, category: 'salary', percent: '50',
        basis: 'The other half of that fortnight.', actor: 'alicio@example.test' })
    } catch (e) { leftover = errorChain(e) }
    // BOTH halves reported. The detail branched on the refusal alone and
    // asserted "50% + 50% allowed", so a database that wrongly refused the
    // leftover half would have been recorded as allowing it — and the bare
    // `catch` threw the sentence away, so there was nothing to print even if the
    // branch had been right. The ninth instance of this class, and the one that
    // hid in the same blind spot as S16: the variable was called `allowed` and
    // the word "allowed" was sitting in the asserted prose (independent critic,
    // 2026-09-11).
    check(refused.includes('SRED_OVER_ALLOCATED') && leftover === '',
      'S3 one dollar cannot be claimed twice, and what is left of it still can',
      `50% + 60% ${refused.includes('SRED_OVER_ALLOCATED')
        ? 'refused by the database' : `NOT refused: ${refused.slice(0, 60)}`}; `
        + `50% + 50% ${leftover === '' ? 'allowed' : `REFUSED: ${leftover.slice(0, 60)}`}`)
  }

  // ------------------------------------------------------ the other costs --
  const materials = await postEntry({
    ledgerId: L, entryDate: `${yr}-04-02`, description: 'Test rig materials',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['5100'], amount: parseMoney('6000.00') },
      { accountId: id['1000'], amount: -parseMoney('6000.00') },
    ],
  })
  const outside = await postEntry({
    ledgerId: L, entryDate: `${yr}-05-02`, description: 'Outside Lab — trial series',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['5200'], amount: parseMoney('10000.00'), partyId: armsLength.id },
      { accountId: id['1000'], amount: -parseMoney('10000.00') },
    ],
  })
  const sister = await postEntry({
    ledgerId: L, entryDate: `${yr}-05-03`, description: 'Sister Company — trial series',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['5200'], amount: parseMoney('4000.00'), partyId: related.id },
      { accountId: id['1000'], amount: -parseMoney('4000.00') },
    ],
  })
  const rent = await postEntry({
    ledgerId: L, entryDate: `${yr}-06-01`, description: 'Workshop rent',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['5300'], amount: parseMoney('12000.00') },
      { accountId: id['1000'], amount: -parseMoney('12000.00') },
    ],
  })
  const rig = await postEntry({
    ledgerId: L, entryDate: `${yr}-07-01`, description: 'Test rig, bought',
    actor: 'alicio@example.test',
    lines: [
      { accountId: id['1500'], amount: parseMoney('20000.00') },
      { accountId: id['1000'], amount: -parseMoney('20000.00') },
    ],
  })

  const lines = await allocatableLines(L, co.year.startDate, co.year.endDate)
  const lineOn = (entryId: string, code: string) => {
    const wanted = lines.find((x) => x.what.startsWith(code) && x.on_date >= `${yr}-01-01`)
    if (!wanted) throw new Error(`no allocatable line for ${code}`)
    return wanted
  }
  void materials; void outside; void sister; void rent; void rig

  for (const [code, category, percent, basis] of [
    ['5100', 'materials', '100', 'Consumed in the trials; the scrap record is filed.'],
    ['5200', 'contract', '100', 'The trial series, contracted out.'],
    ['5300', 'overhead', '25', 'The workshop bay the rig stood in, by floor area.'],
    ['1500', 'capital', '100', 'The rig itself.'],
  ] as const) {
    await allocate({ claimId: claim.id, sourceKind: 'journal_line',
      sourceId: lineOn('', code).source_id, category, percent, basis, actor: 'alicio@example.test' })
  }
  // Both contractor lines, so the arm's-length rule has something to separate.
  const sisterLine = must(lines.find((x) => x.party === 'Sister Company Ltd.'), 'line for Sister Company Ltd.')
  await allocate({ claimId: claim.id, sourceKind: 'journal_line', sourceId: sisterLine.source_id,
    category: 'contract', percent: '100', basis: 'The same trials, the other lab.',
    actor: 'alicio@example.test' })

  // S4 — SALARY IS CLAIMED THROUGH THE STUB, never as a journal line: the
  //      line is the whole payroll entry, and reaching it would be the same
  //      money again with none of the caps applied.
  {
    // THERE WAS A THIRD FENCE HERE AND IT COULD NOT RUN. It asked the door to
    // refuse an allocation against the payroll line 5000 — but `lineOn` throws
    // when no 5000 line exists, which is precisely what the second conjunct
    // below asserts, so on every passing run the door was never reached and the
    // caught error was the fixture's own. Its result was then discarded with
    // `void`. A fence that cannot run is not a weaker fence; it is scenery
    // (independent critic, 2026-09-12).
    const payrollLines = lines.filter((x) => x.what.startsWith('5000'))
    // TWO fences, asserted separately. This was one disjunction, and the
    // payroll-exclusion half is always true — so the door's refusal was never
    // once exercised by a passing run, and a mutation removing only that guard
    // left the battery green. The first conjunct now aims at a line the fixture
    // always has, whatever the exclusion does (independent critic, 2026-09-11).
    let onAnyLine = ''
    try {
      await allocate({ claimId: claim.id, sourceKind: 'journal_line',
        sourceId: lineOn('', '5100').source_id, category: 'salary', percent: '10',
        basis: 'nope', actor: 'alicio@example.test' })
    } catch (e) { onAnyLine = e instanceof SredError ? e.code : errorText(e).slice(0, 40) }
    // BOTH halves composed from what was seen. The first version asserted the
    // payroll half as a string, and the evidence then carried "the payroll entry
    // is not offered as a line at all" under the very block that makes it
    // offered — the same defect this file had just removed from S24,
    // reintroduced three checks away in the same pass (independent critic,
    // 2026-09-11).
    check(onAnyLine === 'WRONG_CATEGORY' && payrollLines.length === 0,
      'S4 salary is claimed through the pay stub, where the cap can be applied',
      `${onAnyLine || 'not refused'} on an ordinary cost line; payroll `
        + `${payrollLines.length === 0 ? 'not offered as a line' : `offered as ${payrollLines.length} line(s)`}`)
  }

  // ------------------------------------------------------ the working paper --
  await saveClaim({
    claimId: claim.id, method: 'proxy',
    uncertainty: 'Whether a seal of this geometry could hold at 40 psi at all.',
    workDone: 'Three generations of trial, each with the gasket changed and the failure measured.',
    advancement: 'It cannot, and we now know why — which is the advance.',
    assistanceNote: 'None: no grant, no IRAP, nobody paid us for this work.',
    assistanceAnswered: true, actor: 'alicio@example.test',
  })
  const paper = await workingPaper(claim.id)
  const lineAt = (m: 'proxy' | 'traditional', t661: string) =>
    paper[m].lines.find((l) => l.t661 === t661)!

  // S5 — THE SPECIFIED-EMPLOYEE CAP IS ON THE YEAR. Applied stub by stub,
  //      twelve months each pass a cap the year fails by a mile. The owner is
  //      paid 480,000 and counts for five times the YMPE and not a cent more.
  {
    const cap = ympeFor(yr) * 5n
    const salary = lineAt('proxy', '300')
    const uncapped = parseMoney('480000.00') + parseMoney('48000.00')   // owner + half of Sam
    // AND THE WARNING READS AS MONEY. Everything a person sees on this paper is
    // formatted; this sentence printed raw cents — "37300000" beside amounts
    // shown as 373,000.00 — and when that was fixed nothing held it, so a
    // regression would have been invisible (independent critic, 2026-09-11).
    const warned = paper.toConfirm.find((t) => t.includes('is capped:')) ?? ''
    // AND THE TWO SENTENCES ARE READ AGAINST EACH OTHER, not against the same
    // literal twice. The specified-employee note names ONE person's bonus;
    // line 502's note names the total over everybody. Asserting they are equal
    // would be true of this fixture and false the moment a second person earns
    // one — the packet claimed a coupling that did not exist (independent
    // critic, 2026-09-11). What is asserted is the real relationship.
    const [bonusRows] = await db.execute<{ mine: string; all: string }>(raw`
      SELECT COALESCE(SUM(TRUNC(ps.bonus * a.percent / 100)) FILTER (WHERE p.name = 'Dana Owner'), 0)
               ::bigint::text AS mine,
             COALESCE(SUM(TRUNC(ps.bonus * a.percent / 100)), 0)::bigint::text AS all
        FROM sred_allocation a
        JOIN pay_stub ps ON ps.id = a.source_id
        JOIN payroll_employee e ON e.id = ps.employee_id
        JOIN party p ON p.id = e.party_id
       WHERE a.claim_id = ${claim.id}::uuid AND a.source_kind = 'pay_stub'`)
    // Dana's, BY NAME. Both people are specified now, so a `find` on the shared
    // phrase returned whichever the allocation order put first — and it was
    // Sam's, whose figure is the other one this check is comparing against.
    const said = paper.toConfirm.find((t) => t.startsWith('Dana Owner is a specified')) ?? ''
    const baseNote = must(paper.proxy.lines.find((l) => l.t661 === '502'), 'line 502').note ?? ''
    // Sam is specified and UNDER the cap, so their sentence exists only because
    // the claim-side warning fires for every specified employee rather than
    // only capped ones — re-narrowing that condition used to leave every check
    // green. And the two figures are now different numbers, so the relationship
    // is tested rather than coincidentally satisfied (independent critic,
    // 2026-09-11).
    const samSaid = paper.toConfirm.find((t) => t.startsWith('Sam Engineer is a specified')) ?? ''
    const samCapped = paper.toConfirm.some((t) => t.startsWith('Sam Engineer is capped'))
    const agrees = Number(bonusRows.mine) > 0
      && Number(bonusRows.all) > Number(bonusRows.mine)
      && said.includes(formatMoney(BigInt(bonusRows.mine)))
      && /out of the proxy base/.test(said)
      && /does NOT do/.test(said)
      && baseNote.includes(formatMoney(BigInt(bonusRows.all)))
      && samSaid !== '' && !samCapped
    // The PROPERTY, not one of the two figures in it: no run of five digits,
    // because formatted money never has one and raw cents always does. The
    // first version asserted the cap was formatted while the block it was
    // written for changed the OTHER number in the same sentence, and came back
    // green (marker 584, 2026-09-11).
    const asMoney = warned.includes(formatMoney(cap)) && !/\d{5,}/.test(warned)
    // ONE FIGURE, NOT TWO. `salary.amount < uncapped` used to sit here and could
    // never be the clause that reddened the line: the conjunct before it pins
    // the amount at 421,000.00 and `uncapped` is the literal 528,000.00 two
    // dozen lines up, so the first implied the second on every run there will
    // ever be. The ordering is still in the detail, where a reader can see it
    // (independent critic, 2026-09-12).
    check(salary.amount === cap + parseMoney('48000.00')
      && asMoney && agrees,
      'S5 the cap is applied to the year, and the paper’s two bonus sentences agree with each other',
      `${formatMoney(salary.amount)} claimed; the cap alone is ${formatMoney(cap)}, `
        + `uncapped it would have been ${formatMoney(uncapped)}; the warning `
        + `${asMoney ? 'shows it as money' : 'does NOT show it as money'}; the sentences `
        + `${agrees ? 'agree — one person’s bonus in the warning, everybody’s in line 502, '
                      + 'and an uncapped specified employee is warned too'
                    : 'do NOT agree'}`)
  }

  // S6 — AN ARM'S-LENGTH CONTRACT COUNTS AT 80%; ONE THAT IS NOT DOES NOT
  //      QUIETLY COUNT AT 80% ANYWAY. It is counted in full and named as
  //      needing advice, because this system does not attempt that rule.
  {
    const contracts = lineAt('proxy', '340')
    const expected = (parseMoney('10000.00') * 80n) / 100n + parseMoney('4000.00')
    const warned = paper.toConfirm.some((t) => t.includes("not at arm's length"))
    check(contracts.amount === expected && warned,
      'S6 an arm’s-length contract counts at 80%, a related one is flagged instead',
      `line 340 is ${formatMoney(contracts.amount)}, expected ${formatMoney(expected)} `
        + `(80% of 10,000 plus 4,000 in full); the related party `
        + `${warned ? 'is named on the paper' : 'is NOT named'}`)
  }

  // S7 — CAPITAL IS LISTED AND EXCLUDED. Dropping it silently would lose the
  //      figure the day the rule changes back, and hide a real cost today.
  {
    const capital = paper.excluded.find((l) => l.label.startsWith('Capital'))!
    const inProxy = paper.proxy.lines.some((l) => l.label.toLowerCase().includes('capital'))
    check(capital.amount === parseMoney('20000.00') && !inProxy,
      'S7 capital is shown, and is not in the total',
      `${formatMoney(capital.amount)} listed under what is excluded, and the proxy column `
        + `${inProxy ? 'HAS a capital line' : 'has none'}`)
  }

  // S8 — BOTH METHODS, EVERY TIME. The choice is the owner's and is
  //      irrevocable for the year, so it should be made in sight of the two.
  {
    const ppa = lineAt('proxy', '502')
    const overhead = lineAt('traditional', '360')
    const differ = paper.proxy.qualified !== paper.traditional.qualified
    // 3,000 of recorded overhead PLUS the employer's CPP and EI on the claimed
    // pay, which is directly attributable overhead and is claimed here and
    // nowhere else (owner, 2026-09-11).
    const [employer] = await db.execute<{ cents: string }>(raw`
      SELECT COALESCE(SUM(TRUNC(
               (ps.employer_cpp + ps.employer_cpp2 + ps.employer_ei) * a.percent / 100
             )), 0)::bigint::text AS cents
        FROM sred_allocation a JOIN pay_stub ps ON ps.id = a.source_id
       WHERE a.claim_id = ${claim.id}::uuid AND a.source_kind = 'pay_stub'`)
    check(ppa.amount > 0n
      && overhead.amount === parseMoney('3000.00') + BigInt(employer.cents) && differ,
      'S8 the paper carries both methods, and only traditional claims the employer CPP and EI',
      // MEASURED, then expected. This printed the expected composition
      // unconditionally, so the block that stops the employer share reaching
      // line 360 recorded a line saying it had reached it (independent critic,
      // 2026-09-11 — the same defect S24, S27 and S29 were cured of, in the two
      // checks nobody had converted). Line 502 is here because the condition
      // asks for it: without it, the clause that proves the proxy column still
      // has a prescribed amount could fail under a line that reads healthy.
      `proxy ${formatMoney(paper.proxy.qualified)} vs traditional `
        + `${formatMoney(paper.traditional.qualified)}; line 502 is `
        + `${formatMoney(ppa.amount)}; line 360 is `
        + `${formatMoney(overhead.amount)}, expected `
        + `${formatMoney(parseMoney('3000.00') + BigInt(employer.cents))} `
        + `(3,000.00 recorded plus ${formatMoney(BigInt(employer.cents))} of employer CPP/EI)`)
  }

  // S9 — THE PROXY BASE TAKES A SPECIFIED EMPLOYEE AT 75%. Confirmed against
  //      the rate table rather than a number typed here, so the day the
  //      provision changes this check follows it.
  {
    const rates = await sredRates(co.year.endDate)
    const pct = Number(must(rates.find((r) => r.name === 'specified_employee_ppa_percent'),
      'specified_employee_ppa_percent rate').value)
    const proxyPct = Number(must(rates.find((r) => r.name === 'proxy_percent'), 'proxy_percent rate').value)
    const cap = ympeFor(yr) * 5n

    // Both people are specified now, so both go in at 75% — and each has their
    // own bonus out first: the owner's twelve 10,000 at 100%, Sam's twelve
    // 1,000 at the 50% their stubs are allocated.
    const ownerBonus = parseMoney('10000.00') * 12n
    const samBonus = (parseMoney('1000.00') * 12n) / 2n
    const at75 = (x: bigint) => (x * BigInt(Math.round(pct * 100))) / 100n
    const base = at75(cap - ownerBonus) + at75(parseMoney('48000.00') - samBonus)
    const expected = (base * BigInt(Math.round(proxyPct * 100))) / 100n
    // AND THE CLAMP'S BRANCHES, called directly. `S29` holds the same clamp on a
    // real paper; these four pin the arithmetic itself.
    const clamp = [
      ['a bonus inside the salary comes out whole', bonusOutOfBase(100n, 40n) === 40n],
      ['a bonus larger than the salary comes out at the salary',
       bonusOutOfBase(100n, 150n) === 100n],
      ['and never more, so the base cannot go negative', bonusOutOfBase(0n, 150n) === 0n],
      ['equal is equal', bonusOutOfBase(100n, 100n) === 100n],
    ] as const
    const clampBroken = clamp.filter(([, ok]) => !ok).map(([what]) => what)
    check(lineAt('proxy', '502').amount === expected && clampBroken.length === 0,
      'S9 the proxy base takes a specified employee at 75%, and a bonus never exceeds what it leaves',
      // The base and the bonus below are the EXPECTED figures; the amount is the
      // paper's. Printing the expected base as though it were the paper's made
      // the block that puts the bonus back record "126,000.00 of bonus came out".
      `line 502 is ${formatMoney(lineAt('proxy', '502').amount)}, expected `
        + `${formatMoney(expected)} — a base of ${formatMoney(base)} after `
        + `${formatMoney(ownerBonus + samBonus)} of bonus should have come out`
        + `${clampBroken.length ? `; clamp broken: ${clampBroken.join(', ')}` : ''}`)
  }

  // S10 — THE CREDIT FOLLOWS THE COMPANY. A CCPC gets the enhanced rate and
  //       it is refundable; a company nobody has classified is assumed not to
  //       be one, and the paper says so out loud rather than guessing upward.
  {
    const federal = paper.credits.federal
    const bc = paper.credits.bc
    const expected = (paper.proxy.qualified * 35n) / 100n
    const [other] = await db.execute<{ id: string }>(raw`
      SELECT id::text FROM entity WHERE code = 'RND'`)
    void other
    check(federal.rate === 0.35 && federal.refundable && federal.amount === expected
      && bc.rate === 0.10 && bc.basis.includes('reduces next year')
      // The BC figure has NO expenditure limit applied to it while the federal
      // one does, and the seeded rate's own note says the provincial credit is
      // refundable only up to one. The number stays as it is; the sentence
      // beside it has to say that, or the paper asserts a rule it did not apply
      // (independent critic, 2026-09-10).
      && bc.basis.includes('No expenditure limit'),
      'S10 a CCPC gets 35% refundable, and BC’s 10% is named as assistance next year',
      `federal ${formatMoney(federal.amount)} at ${federal.rate * 100}% `
        + `${federal.refundable ? 'refundable' : 'NOT refundable'}, `
        + `BC ${formatMoney(bc.amount)} at ${bc.rate * 100}%, `
        + `${bc.basis.includes('reduces next year') ? 'named as next year’s assistance' : 'NOT so named'}, `
        + `${bc.basis.includes('No expenditure limit') ? 'and no limit applied' : 'and silent on the limit'}`)
  }

  // S11 — THE DEADLINE IS DERIVED. Eighteen months from the year end, and
  //       missing it loses the claim outright — there is no relief provision,
  //       which is why it is not a date somebody types.
  {
    const [expected] = await db.execute<{ d: string }>(raw`
      SELECT (${co.year.endDate}::date + interval '18 months')::date::text AS d`)
    check(paper.deadline === expected.d,
      'S11 the reporting deadline is 18 months after the year end, worked out from it',
      `${paper.deadline} (${paper.daysLeft} days from today)`)
  }

  // S12 — WHAT IS STILL UNSETTLED IS PRINTED. The two unconfirmed rates, the
  //       related-party contract, and the cap that bit. A working paper that
  //       hid these would be a return, and this is not one.
  {
    const has = (t: string) => paper.toConfirm.some((x) => x.includes(t))
    // `is capped:`, not `specified employee`: one of the unconfirmed RATES is
    // called specified_employee_ppa_percent and its note says those two words,
    // so that phrase was true whether or not the cap warning had ever been
    // pushed. A mutation deleting the warning outright left this check green
    // (the block at marker 552 — markers, not ordinals; see mutations.sh),
    // which is the whole reason the phrase is now one only the cap sentence can
    // produce. (It was `capped at` until this node split that sentence in two.)
    check(paper.toConfirm.length >= 3 && has('expenditure_limit')
          && has("not at arm's length") && has('is capped:'),
      'S12 the paper prints what the person filing still has to settle',
      `${paper.toConfirm.length} item(s) to confirm; `
        + [['an unconfirmed rate', has('expenditure_limit')],
           ["the related party", has("not at arm's length")],
           ['the cap', has('is capped:')]]
          .map(([what, there]) => `${there ? '' : 'NOT '}naming ${what}`).join(', '))
  }

  // ---- the four switches, and whether a door reaches the number -----------
  //
  // Every one of these columns was read by the paper and written by NOBODY: no
  // screen in the application could set them (owner, 2026-09-10 — "如何使用").
  // So each check sets the switch THROUGH ITS DOOR and then asks the working
  // paper what changed. Asserting that the column took the value would have
  // passed for the whole time the defect existed.

  // S16 — THE CCPC ANSWER. Three states, and the third is a real answer: a
  //       company nobody has classified is priced as though it were not one,
  //       and the paper says so instead of guessing upward.
  {
    // Through the FORM READER, not the library behind it: the three answers are
    // the reader's job — '' must survive as null — and a first version of this
    // check called the library, so the mutation collapsing '' into false came
    // back green (marker 560).
    await sayCcpc('no')
    const plain = await workingPaper(claim.id)
    await sayCcpc('')
    const unsaid = await workingPaper(claim.id)
    await sayCcpc('yes')
    const ccpc = await workingPaper(claim.id)
    check(plain.credits.federal.rate === 0.15 && !plain.credits.federal.refundable
      && ccpc.credits.federal.rate === 0.35 && ccpc.credits.federal.refundable
      && ccpc.credits.federal.amount > plain.credits.federal.amount
      && unsaid.credits.federal.rate === 0.15
      && unsaid.toConfirm.some((t) => t.includes('CCPC')),
      'S16 the CCPC answer is set through a door, and it moves the credit',
      // Six clauses, six things printed. This printed "unsaid is priced as
      // not, and says so" unconditionally, and under the block that collapses
      // the unanswered state into a definite No the SENTENCE is the only thing
      // that fails — so the record said it was there. The two rates and the two
      // refundability flags were the second half of the same omission: neither
      // flag moves a printed figure, so flipping one produced a FAIL line
      // byte-identical to a pass, three times over in the recorded evidence
      // (independent critic, 2026-09-11).
      `not a CCPC ${plain.credits.federal.rate * 100}% `
        + `${plain.credits.federal.refundable ? 'REFUNDABLE' : 'not refundable'} `
        + `${formatMoney(plain.credits.federal.amount)} vs CCPC `
        + `${ccpc.credits.federal.rate * 100}% `
        + `${ccpc.credits.federal.refundable ? 'refundable' : 'NOT refundable'} `
        + `${formatMoney(ccpc.credits.federal.amount)}; unanswered is priced at `
        + `${unsaid.credits.federal.rate * 100}% and `
        + `${unsaid.toConfirm.some((t) => t.includes('CCPC'))
             ? 'says nobody has said' : 'says NOTHING about nobody having said'}`)
  }

  // S17 — ARM'S LENGTH. The 80% rule turns on the PARTY, not the account, and
  //       a person has to be able to say which a party is.
  {
    await updateParty({ partyId: related.id, name: 'Sister Company Ltd.',
                        armsLength: true, actor: 'alicio@example.test' })
    const asArms = await workingPaper(claim.id)
    await updateParty({ partyId: related.id, name: 'Sister Company Ltd.',
                        armsLength: false, actor: 'alicio@example.test' })
    const asRelated = await workingPaper(claim.id)
    const line = (p: typeof asArms) => p.proxy.lines.find((l) => l.t661 === '340')!.amount
    check(line(asArms) === (parseMoney('14000.00') * 80n) / 100n
      && line(asRelated) === (parseMoney('10000.00') * 80n) / 100n + parseMoney('4000.00')
      && line(asRelated) > line(asArms)
      && asRelated.toConfirm.some((t) => t.includes("not at arm's length")),
      'S17 arm’s length is set through a door, and it moves the contract line',
      `at arm's length ${formatMoney(line(asArms))} vs related ${formatMoney(line(asRelated))}; `
        + `${asRelated.toConfirm.some((t) => t.includes("not at arm's length"))
             ? 'and the paper names the related party' : 'and the paper does NOT name it'}`)
  }

  // S18 — THE SPECIFIED EMPLOYEE. Untick it and the 5 x YMPE cap never bites;
  //       nothing else on the paper would look wrong.
  {
    const owner0 = {
      ledgerId: L, id: ownerEmp.id, partyId: owner.id, frequency: 'monthly',
      sin: '046454286', occupation: 'Founder', hiredOn: co.year.startDate,
      actor: 'alicio@example.test',
    }
    await saveEmployee({ ...owner0, isSpecified: false })
    const loose = await workingPaper(claim.id)
    await saveEmployee({ ...owner0, isSpecified: true })
    const capped = await workingPaper(claim.id)
    const salary = (p: typeof loose) => p.proxy.lines.find((l) => l.t661 === '300')!.amount
    // Two exact figures, and no third conjunct comparing them: 421,000.00 is
    // less than 528,000.00 whatever happens, so `salary(capped) < salary(loose)`
    // was a clause that could not fail. Same reason as S5 (independent critic,
    // 2026-09-12).
    check(salary(loose) === parseMoney('528000.00')
      && salary(capped) === ympeFor(yr) * 5n + parseMoney('48000.00')
      // `is capped:`, the phrase the paper actually produces. This said
      // `capped at` — the wording the cap sentence had BEFORE this node split
      // it in two — so the conjunct was true of every paper ever built and the
      // clause could not fail. S5 and S12 were moved when the sentence changed;
      // this one was not, and the detail beside it had been reporting the new
      // phrase all along, which is how the two came to disagree in writing
      // (independent critic, 2026-09-11).
      && !loose.toConfirm.some((t) => t.includes('is capped:')),
      'S18 “specified employee” is set through a door, and it is what makes the cap bite',
      `unticked ${formatMoney(salary(loose))}, ticked ${formatMoney(salary(capped))}; `
        + `unticked the paper ${loose.toConfirm.some((t) => t.includes('is capped:'))
             ? 'STILL claims a cap bit' : 'says nothing about a cap'}`)
  }

  // S13 — A FILED YEAR IS A RECORD, NOT A DRAFT. The method is irrevocable
  //       once the return has gone, and so is everything else about it.
  {
    await fileClaim({ claimId: claim.id, filedOn: `${yr + 1}-06-30`,
                      actor: 'alicio@example.test' })
    let refused = ''
    try {
      await saveClaim({ claimId: claim.id, method: 'traditional', actor: 'alicio@example.test' })
    } catch (e) { refused = e instanceof SredError ? e.code : errorText(e) }
    const [after] = await db.execute<{ method: string }>(raw`
      SELECT method FROM sred_claim WHERE id = ${claim.id}::uuid`)
    check(refused === 'FILED' && after.method === 'proxy',
      'S13 a filed year cannot have its method changed underneath the return',
      `${refused}; still ${after.method}`)
  }

  // S19 — AND FILING CAN BE TAKEN BACK, BUT ONLY WITH A REASON.
  //
  //       Without the door, a year could never be marked filed and `FILED`
  //       refused nobody. With an unconditional door, "filed" would mean
  //       nothing — so un-filing follows `reopenPeriod`'s precedent: it says a
  //       return this system recorded as gone did not go, and the sentence
  //       saying which is kept in the trail.
  {
    let twice = ''
    try {
      await fileClaim({ claimId: claim.id, filedOn: `${yr + 1}-07-01`, actor: 'alicio@example.test' })
    } catch (e) { twice = e instanceof SredError ? e.code : errorText(e) }

    let noReason = ''
    try {
      await unfileClaim({ claimId: claim.id, reason: '   ', actor: 'alicio@example.test' })
    } catch (e) { noReason = e instanceof SredError ? e.code : errorText(e) }

    let undone = ''
    try {
      await unfileClaim({
        claimId: claim.id, reason: 'The return did not go on that date; it went a week later.',
        actor: 'alicio@example.test',
      })
    } catch (e) { undone = e instanceof SredError ? e.code : errorText(e) }
    const [trail] = await db.execute<{ reason: string; actor: string }>(raw`
      SELECT context->>'reason' AS reason, actor FROM audit_log
       WHERE action = 'unfile_sred_claim' AND record_id = ${claim.id}
       ORDER BY occurred_at DESC LIMIT 1`)
    // …and the year is a draft again, which is the whole point of allowing it.
    let editable = true
    try {
      await saveClaim({ claimId: claim.id, method: 'proxy', actor: 'alicio@example.test' })
    } catch { editable = false }

    check(twice === 'ALREADY_FILED' && noReason === 'NO_REASON' && undone === ''
      && !!trail?.reason.startsWith('The return did not go')
      && trail.actor === 'alicio@example.test' && editable,
      'S19 a filed year can be taken back, and only with a reason the trail keeps',
      `${twice || 'filed twice'}; ${noReason || 'no reason wanted'}; `
        + `${undone || 'undone'}; the trail says “${trail?.reason.slice(0, 30) ?? '—'}…”; `
        + `the year is ${editable ? 'a draft again' : 'STILL refusing edits'}`)
  }

  // S14 — THE EVIDENCE IS COUNTED BY THE QUESTION IT ANSWERS, because that is
  //       how a claim is read: why, how, and how much. Nothing is refused for
  //       being thin — it is shown, before the year ends rather than after.
  {
    await addEvidence({ projectId: project.id, kind: 'plan', title: 'Project plan',
      onDate: `${yr}-01-06`, actor: 'alicio@example.test' })
    await addEvidence({ projectId: project.id, kind: 'trial_record', title: 'Trial 2 log',
      onDate: `${yr}-03-04`, actor: 'alicio@example.test' })
    await addEvidence({ projectId: project.id, kind: 'invoice', title: 'Outside Lab invoice',
      onDate: `${yr}-05-02`, actor: 'alicio@example.test' })
    let refusedKind = ''
    try {
      await addEvidence({ projectId: project.id, kind: 'vibes', title: 'x',
        onDate: `${yr}-05-02`, actor: 'alicio@example.test' })
    } catch (e) { refusedKind = e instanceof SredError ? e.code : errorText(e) }
    const standing = await evidenceStanding(project.id)
    const why = must(standing.find((s) => s.answers === 'why'), 'why standing')
    const how = must(standing.find((s) => s.answers === 'how'), 'how standing')
    check(refusedKind === 'UNKNOWN_KIND' && why.held === 1 && how.held === 1 && how.missing.length > 0,
      'S14 evidence is counted by the question it answers, and the gaps are named',
      `${standing.map((s) => `${s.answers} ${s.held}/${s.kinds}`).join(', ')}; `
        + `an unknown kind is ${refusedKind === 'UNKNOWN_KIND' ? 'refused' : `NOT refused (${refusedKind})`}; `
        + `${how.missing.length} gap(s) named under how`)
  }

  // S20 — AND A PERSON CAN ACTUALLY REACH EVERY SWITCH IN THE TABLE BELOW.
  //
  //       The defect this closed was never that the columns were wrong. It was
  //       that `entity.is_ccpc`, `party.arms_length`,
  //       `payroll_employee.is_specified` and `sred_claim.filed_on` were READ
  //       by the working paper and written by NOTHING — no screen in the
  //       application could set any of them, so every paper priced a CCPC as
  //       though nobody had said, and the 5 x YMPE cap could never bite
  //       (owner, 2026-09-10). S16-S19 call the doors or the form readers; not
  //       one of them touches a screen, so every one of them would have passed
  //       for the whole time that was true.
  //
  //       So this one reads the TREE: each switch must be offered by a field in
  //       a screen AND read by the NAMED module that calls its door. A door
  //       nothing posts to is not a door.
  //
  //       The reader half names the file and the door rather than searching the
  //       whole tree for the constant: the first version asked only whether the
  //       name appeared in some `.ts` under src, which a comment or a type
  //       annotation would have satisfied with nothing wired (independent
  //       critic, 2026-09-10).
  {
    const tree = sourceFiles('src').map((f) => ({ f, text: readFileSync(f, 'utf8') }))
    const unreachable: string[] = []
    const switches = [
      ['isCcpc', 'entity.is_ccpc', join('src', 'lib', 'record-forms.ts'), 'saveProfile('],
      ['armsLength', 'party.arms_length', join('src', 'lib', 'party-forms.ts'), 'updateParty('],
      ['isSpecified', 'payroll_employee.is_specified',
       join('src', 'lib', 'payroll', 'forms.ts'), 'saveEmployee('],
      ['filedOn', 'sred_claim.filed_on', join('src', 'app', 'ledger', '[ledgerId]', 'sred', 'actions.ts'), 'fileSredClaim('],
      // An account's T661 line, tagged on the SR&ED screen since 0156 (it was a
      // box on the account form). A mutation dropping it from the door came
      // back green because S24 tags an account through the library, not the
      // door (marker 575).
      ['accountCategory', 'sred_account_category.category',
       join('src', 'app', 'ledger', '[ledgerId]', 'sred', 'actions.ts'), 'setSredAccountCategory('],
      // A PER-ROW field, so it is named by a helper rather than a constant:
      // `name={payBonus(i)}`. Both halves below take that spelling as well,
      // because the rule is the same one — the proxy base leaves bonuses out
      // and a bonus nobody can enter is a base that never changes. The block at
      // marker 587 drops it from the reader and came back green until this row
      // existed, since the SR&ED fixture calls `runPayroll` directly
      // (2026-09-11).
      ['bonus', 'pay_stub.bonus', join('src', 'lib', 'payroll', 'forms.ts'), 'runPayroll('],
    ] as const
    for (const [field, column, reader, door] of switches) {
      // ONE spelling alternation, built once and used by both halves below.
      // They used to take different sets — this half accepted any identifier
      // ending in F but only immediately after `name={`, while the reader half
      // matched `RECORD_FIELDS.x` anywhere — and a comment claimed they were the
      // same. Two spellings of one question is the defect this whole tree hunts
      // (independent critic, 2026-09-11).
      const named = `(?:[A-Z_]*FIELDS|F)\\.${field}\\b`
      // …or a helper that names the row's field: `name={payBonus(i)}`.
      const helper = `pay${field[0].toUpperCase()}${field.slice(1)}\\(`
      const offered = tree.some(({ f, text }) =>
        f.endsWith('.tsx') && f.startsWith(join('src', 'app'))
        && new RegExp(`name=(?:\\{${named}\\}|"${field}"|\\{${helper})`).test(text))
      const source = tree.find(({ f }) => f === reader)?.text ?? ''
      // `FIELDS.x` or the aliased `F.x` — both spellings are in use, and the
      // tightening here is the FILE and the DOOR, not the spelling.
      // The literal spelling is anchored to a USE, not to the bare token: a
      // comment or a type annotation naming the field would otherwise satisfy
      // this with nothing wired. `${field}:` was one of these alternatives and
      // has been dropped: it matched a type annotation and a comment as readily
      // as an assignment, which is the very thing this comment warns about
      // (independent critic, 2026-09-11).
      const carried = new RegExp(`${named}|get\\(['"\`]${field}['"\`]\\)|${field}:\\s*\\w+\\(g\\(f, ${helper}`)
        .test(source) && source.includes(door)
      if (!offered) unreachable.push(`${column}: no screen offers it`)
      else if (!carried) unreachable.push(`${column}: ${reader} does not carry it to ${door})`)
    }
    check(unreachable.length === 0,
      'S20 every switch the working paper reads is one a person can actually set',
      unreachable.length === 0
        ? `${switches.length} switches, each with a field on a screen and a module that `
          + 'reads it on the way to the door'
        : unreachable.join('; '))
  }

  const claims = await claimsFor(project.id)
  check(claims.length === 1 && claims[0].year_end === co.year.endDate,
    'S15 a project has one claim per fiscal year',
    `${claims.length} claim, year ending ${claims[0]?.year_end}`)

  // S22 — AND A SHARE CAN BE LOWERED. The over-allocation rule counts what
  //       OTHER claims took, not what this one already took — because
  //       `allocate` writes with ON CONFLICT DO UPDATE and Postgres fires the
  //       BEFORE INSERT trigger on a proposed row with a fresh id before it
  //       discovers the conflict. 0068 excluded `id <> NEW.id`, which excluded
  //       nothing on that path: lowering a source already at 100% was refused
  //       with a sentence saying it was over 100%. 0069 excludes the claim.
  //
  //       This was found by the battery — a block testing the filed-year fence
  //       came back red for this reason instead of its own (2026-09-10).
  {
    const stub = must((await allocatableSalary(L, co.year.startDate, co.year.endDate))
      .find((a) => a.claimed_percent === 100), 'fully claimed pay stub')
    let lowered = ''
    try {
      await allocate({ claimId: claim.id, sourceKind: 'pay_stub', sourceId: stub.source_id,
        category: 'salary', percent: '60',
        basis: 'The time log says 60%, not all of it.', actor: 'alicio@example.test' })
    } catch (e) { lowered = e instanceof SredError ? e.code : errorChain(e) }
    const [after] = await db.execute<{ percent: string }>(raw`
      SELECT percent::text FROM sred_allocation
       WHERE claim_id = ${claim.id}::uuid AND source_id = ${stub.source_id}::uuid`)
    // …and putting it back does not become impossible either. CAUGHT, and so is
    // every other call these last checks make: a mutant must redden a line, and
    // an uncaught throw kills the run instead — which proves nothing. It
    // happened twice in one node (2026-09-10), and a third time in the sentence
    // that first claimed it had stopped happening, where S21's own two door
    // calls were still bare (independent critic, 2026-09-11).
    let restored = ''
    try {
      await allocate({ claimId: claim.id, sourceKind: 'pay_stub', sourceId: stub.source_id,
        category: 'salary', percent: '100', basis: 'Full time on the trials all year.',
        actor: 'alicio@example.test' })
    } catch (e) { restored = e instanceof SredError ? e.code : errorChain(e) }
    check(lowered === '' && after?.percent === '60.00' && restored === '',
      'S22 a share can be lowered — the rule counts what other claims took, not this one',
      lowered === '' && restored === ''
        ? `100% to ${after?.percent}% and back`
        : (lowered || restored).slice(0, 80))
  }

  // S29 — AND THE CLAMP BITES ON A REAL PAPER, not only in four direct calls.
  //
  //       A company of its own, because the main fixture must not be distorted
  //       into one whose owner is paid almost entirely in bonus — that is the
  //       case this needs and it would wreck the worked example the docs use to
  //       explain proxy against traditional. Here the specified employee is paid
  //       400,000 in a month of which 390,000 is bonus: the cap counts 373,000
  //       of the salary, the bonus entered is larger than that, and what leaves
  //       the base is the salary, not the bonus.
  //
  //       This exists because the clamp's own justification was wrong. It said
  //       no fixture could reach it, and the fixture's owner was already paid
  //       480,000 — so the call site was held by nothing while the helper's
  //       arithmetic was covered (independent critic, 2026-09-11).
  {
    const co2 = await createCompanyWithYear(
      { code: 'CLMP', name: 'Mostly Bonus Ltd.', province: 'BC' }, 'alicio@example.test')
    const accts2 = await importAccounts(co2.company.id,
      parseAccountsCsv(CHART).map((r) => ({ ...r, entityId: co2.company.id })),
      'alicio@example.test')
    const id2 = Object.fromEntries(accts2.map((a) => [a.code, a.id]))
    const boss = await createParty({
      kind: 'person', name: 'Robin Founder',
      roles: [{ entityId: co2.company.id, role: 'employee', heldFrom: co2.year.startDate }],
      actor: 'alicio@example.test' })
    const bossEmp = await saveEmployee({
      ledgerId: co2.ledger.id, partyId: boss.id, frequency: 'monthly', sin: '046454286',
      occupation: 'Founder', hiredOn: co2.year.startDate, isSpecified: true,
      actor: 'alicio@example.test' })
    await runPayroll({
      ledgerId: co2.ledger.id, payDate: `${yr}-06-30`,
      periodStart: `${yr}-06-01`, periodEnd: `${yr}-06-30`,
      bankAccountId: id2['1000'], actor: 'alicio@example.test',
      lines: [{ employeeId: bossEmp.id, gross: parseMoney('400000.00'),
                bonus: parseMoney('390000.00'), hours: 15000n }],
    })
    const proj2 = await createSredProject({
      entityId: co2.company.id, code: 'P1', title: 'Paid in bonus, mostly',
      startedOn: co2.year.startDate, actor: 'alicio@example.test' })
    const claim2 = await openClaim({ projectId: proj2.id, fiscalYearId: co2.year.id,
      actor: 'alicio@example.test' })
    const stub2 = must((await allocatableSalary(
      co2.ledger.id, co2.year.startDate, co2.year.endDate))[0], 'the one pay stub')
    await allocate({ claimId: claim2.id, sourceKind: 'pay_stub', sourceId: stub2.source_id,
      category: 'salary', percent: '100', basis: 'All of it, on the one project.',
      actor: 'alicio@example.test' })

    const paper2 = await workingPaper(claim2.id)
    const cap2 = ympeFor(yr) * 5n
    const entered = parseMoney('390000.00')
    const left = bonusOutOfBase(cap2, entered)   // the salary, not the bonus
    const line502 = must(paper2.proxy.lines.find((l) => l.t661 === '502'), 'line 502')
    const note2 = line502.note ?? ''
    const salary2 = must(paper2.proxy.lines.find((l) => l.t661 === '300'), 'line 300').amount
    const nothingLeft = line502.amount === 0n
    const saysLeft = note2.includes(formatMoney(left))
    const saysEntered = note2.includes(formatMoney(entered))
    // EVERY clause composed from the paper, including the counted salary — which
    // was still printing the cap, a constant, so a block breaking that very
    // conjunct reported the expected figure as though the paper had produced it
    // (independent critic, 2026-09-11, twice: first the whole detail, then this
    // clause).
    check(salary2 === cap2 && left === cap2 && entered > cap2
      && nothingLeft && saysLeft && !saysEntered,
      'S29 a bonus bigger than the salary left after the cap takes out only the salary',
      `${formatMoney(entered)} of bonus against ${formatMoney(salary2)} of counted salary `
        + `(the cap is ${formatMoney(cap2)}): `
        + `the proxy amount is ${formatMoney(line502.amount)}, and the note names `
        + `${saysLeft ? formatMoney(left) : 'something else'}`
        + `${saysEntered ? ' — including the whole bonus, which never left the base' : ''}`)
  }

  // S27 — EVERY FIGURE SAYS WHAT IT LEAVES OUT.
  //
  //       What each figure leaves out, named beside it. The owner asked what
  //       happens to the employer's CPP and EI when a salary is split by
  //       percentage (2026-09-10); the answer then was "nothing at all", and it
  //       was disclosed rather than computed while the treatment was open. They
  //       settled it on 2026-09-11 — line 360 under the traditional method, and
  //       nowhere under proxy — so line 300 now says where the money WENT, not
  //       that it went nowhere, and line 502 says what came out of its base and
  //       what could not.
  //
  //       The employer figure is asserted against the stubs, not read off the
  //       paper: a note quoting itself would pass whatever it said.
  {
    const paperNow = await workingPaper(claim.id)
    const line = (t: string) => must(paperNow.proxy.lines.find((l) => l.t661 === t), `line ${t}`)
    // TRUNC PER ROW, then sum — which is what `share()` does in cents, and the
    // first version of this summed exactly and cast at the end, coming out five
    // cents high. Two spellings of one calculation is the defect this tree
    // hunts; this one is the same spelling in SQL.
    const [owed] = await db.execute<{ employer: string }>(raw`
      SELECT COALESCE(SUM(TRUNC(
               (ps.employer_cpp + ps.employer_cpp2 + ps.employer_ei) * a.percent / 100
             )), 0)::bigint::text AS employer
        FROM sred_allocation a
        JOIN pay_stub ps ON ps.id = a.source_id
       WHERE a.claim_id = ${claim.id}::uuid AND a.source_kind = 'pay_stub'`)

    const salaryNote = line('300').note ?? ''
    const ppaNote = line('502').note ?? ''
    const namesGross = /GROSS PAY ONLY/.test(salaryNote)
    // As MONEY, the way every other figure on this paper is shown. The first
    // version compared the raw cents string, so it did not merely miss the
    // defect — it required it: formatting the note correctly would have turned
    // this red (independent critic, 2026-09-11).
    const namesFigure = salaryNote.includes(formatMoney(BigInt(owed.employer)))
    // BOTH halves: what came out (bonuses, with the figure) and what did not
    // (taxable benefits, which this system cannot tell apart from pay at all).
    // The hedge has to be there whether or not a bonus was found, so it is
    // asserted separately from the figure: with no bonus recorded this note used
    // to claim the base was the law's narrower figure anyway.
    const bothBonuses = parseMoney('10000.00') * 12n + (parseMoney('1000.00') * 12n) / 2n
    const namesBase = /less whatever was entered as a bonus/.test(ppaNote)
      && ppaNote.includes(formatMoney(bothBonuses))
      && /TWO THINGS THIS CANNOT TAKE OUT/.test(ppaNote)
      && /taxable benefits/.test(ppaNote)

    // AND A PAPER WITH NO BONUS SAYS THE SAME THING. The hedge used to sit
    // inside `bonusOut > 0n` while the compliance claim sat outside it, so a
    // claim that had excluded nothing read as though it had. Nothing rendered
    // that branch, which is why it survived (independent critic, 2026-09-11).
    const bare = await createSredProject({
      entityId: E, code: 'P3', title: 'Nobody was paid a bonus on this one',
      startedOn: co.year.startDate, actor: 'alicio@example.test' })
    const bareClaim = await openClaim({ projectId: bare.id, fiscalYearId: co.year.id,
      actor: 'alicio@example.test' })
    const bareNote = must((await workingPaper(bareClaim.id)).proxy.lines
      .find((l) => l.t661 === '502'), 'line 502 on a claim with no bonus').note ?? ''
    // Two conjuncts, not three: a `!/narrower figure the law asks for/` was
    // sitting here, and that phrase exists nowhere in the tree — true of every
    // possible input, redden-able by nothing (independent critic, 2026-09-11).
    const bareHedged = /nothing was/.test(bareNote)
      && /TWO THINGS THIS CANNOT TAKE OUT/.test(bareNote)
    // Composed, not asserted. The first version printed "named and not claimed;
    // the proxy base says it is gross pay" whatever the notes said, so the two
    // blocks that delete those sentences recorded a line claiming they were
    // there — the third time in this node that a detail told the opposite of
    // what its block did (2026-09-11).
    check(Number(owed.employer) > 0 && namesGross && namesFigure && namesBase && bareHedged,
      'S27 line 300 says where its employer CPP and EI went, and 502 what came out of its base',
      `${formatMoney(BigInt(owed.employer))} of employer CPP/EI: `
        + `line 300 ${namesGross ? 'sends it to 360 under traditional' : 'says nothing'}, `
        + `${namesFigure ? 'with the figure' : 'without the figure'}; `
        + `line 502 ${namesBase ? 'names the bonus out and the benefits still in' : 'admits nothing'}; `
        + `a claim with no bonus ${bareHedged ? 'still carries the hedge' : 'claims compliance anyway'}`)
  }

  // S28 — A SHORT TAX YEAR IS SAID, BOTH WAYS IT CAN ARISE HERE.
  //
  //       `ITA 37(9.1)` prorates the specified-employee cap for a tax year under
  //       twelve months, and this module does not prorate it — so it says so.
  //       Two detections, because there are two ways to get there and only one
  //       of them is visible in the fiscal year's own dates:
  //
  //         - the `fiscal_year` ROW is short. No door PLANS one and no product
  //           code redefines one: the restore is the product path (it writes
  //           these rows verbatim), and redefining an open empty year is what
  //           0007's guard PERMITS rather than something this application does.
  //           Either way the row is a state the database can hold, so it is
  //           checked rather than assumed;
  //         - the row is twelve months and the COMPANY'S FIRST TAX YEAR is not,
  //           because it was incorporated inside that year. The ledger cannot
  //           model that at all, which is precisely what makes the cap silently
  //           too generous — a reason to say it, not to skip it.
  //
  //       This check was once the opposite claim ("no year this system can plan
  //       is shorter"), used to justify deleting the disclosure. RISKS §23 has
  //       why that premise was wrong; it is not restated here.
  {
    // Twelve months exactly, from both branches of the planner.
    const planned = ['2026-12-31', '2026-06-30', '2026-02-28', '2026-07-15', '2026-01-01']
      .map((d) => {
        const plan = planFiscalYear(new Date(`${d}T00:00:00Z`))
        const last = must(plan.periods[plan.periods.length - 1], `last period for ${d}`)
        const start = new Date(plan.start)
        const aYearOn = new Date(Date.UTC(
          start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate() - 1))
        return { d, exact: last.end.getTime() === aYearOn.getTime(), periods: plan.periods.length }
      })
    const wrong = planned.filter((x) => !x.exact || x.periods !== 12)

    // The row-is-short detection, in a company of its own so the year can be
    // moved at all: 0007's guard permits it only while the year is OPEN and
    // holds no posted entries, which is exactly the state a fresh company's
    // year is in. It has to END in the year the YMPE table covers, or the paper
    // refuses for a different reason entirely.
    const other = await createCompanyWithYear(
      { code: 'SHRT', name: 'Short Year Ltd.', province: 'BC' }, 'alicio@example.test')
    await db.execute(raw`
      UPDATE fiscal_year SET start_date = (end_date - INTERVAL '200 days')::date
       WHERE id = ${other.year.id}::uuid`)
    const otherProject = await createSredProject({
      entityId: other.company.id, code: 'P1', title: 'A short year of it',
      startedOn: other.year.endDate, actor: 'alicio@example.test' })
    const shortClaim = await openClaim({ projectId: otherProject.id,
      fiscalYearId: other.year.id, actor: 'alicio@example.test' })
    let rowSaid = false
    let why = ''
    try {
      rowSaid = (await workingPaper(shortClaim.id)).toConfirm
        .some((t) => t.includes('201 days') && t.includes('NOT prorated here'))
    } catch (e) { why = errorChain(e).slice(0, 60) }

    // And the first-tax-year detection: the fixture's company was recognised
    // inside its own fiscal year, so every paper on it should say so.
    const bornSaid = paper.toConfirm.some((t) => t.includes('FIRST TAX YEAR'))

    // …and the bound on the other side, which needs a company of its own with a
    // FULL year: the short-row branch comes first, so on Short Year Ltd. the
    // incorporation branch never runs and a mutation to it was invisible
    // (block 583 came back green). This one is recognised AFTER its year ends —
    // what a year that closed before the company existed looks like — and being
    // after the start is not enough to be inside (independent critic,
    // 2026-09-11).
    const bound = await createCompanyWithYear(
      { code: 'BND', name: 'Bounded Ltd.', province: 'BC' }, 'alicio@example.test')
    {
      const f = new FormData()
      f.set(RECORD_FIELDS.ledgerId, bound.ledger.id)
      f.set(RECORD_FIELDS.entityId, bound.company.id)
      f.set(RECORD_FIELDS.recognitionDate, `${yr + 1}-02-01`)
      const r = await saveProfileFromForm(f, 'alicio@example.test')
      if (r.error) { console.error(`BND profile: ${r.error}`); process.exit(1) }
    }
    const boundProject = await createSredProject({
      entityId: bound.company.id, code: 'P1', title: 'A year that closed before we existed',
      startedOn: bound.year.endDate, actor: 'alicio@example.test' })
    const boundClaim = await openClaim({ projectId: boundProject.id,
      fiscalYearId: bound.year.id, actor: 'alicio@example.test' })
    const outsideSaid = (await workingPaper(boundClaim.id)).toConfirm
      .some((t) => t.includes('FIRST TAX YEAR'))

    check(wrong.length === 0 && rowSaid && bornSaid && !outsideSaid,
      'S28 a short tax year is said — from the year’s own dates, and from an incorporation inside it',
      wrong.length > 0
        ? `planner: ${wrong.map((x) => x.d).join(', ')}`
        : `${planned.length} end dates each planned as exactly twelve months; a 201-day row `
          + `${rowSaid ? 'is named' : `is NOT named${why ? ` (${why})` : ''}`}; `
          + `a mid-year incorporation ${bornSaid ? 'is named' : 'is NOT named'}; `
          + `one after the year end ${outsideSaid ? 'is WRONGLY named' : 'is not'}`)
  }

  // S24 — AN ACCOUNT CAN SAY WHAT IT HOLDS, AND THE SCREEN LISTENS.
  //
  //       The owner's plan (2026-09-10) is R&D sub-accounts, one per T661 line,
  //       split on the day the invoice arrives. So the system reads their chart
  //       rather than asking them to tag a second time: a tagged account's
  //       lines sort to the top, arrive with the category chosen and 100%
  //       offered. NOTHING IS DECIDED BY THE TAG — the percent and the basis
  //       are still typed, and the basis is still refused if blank.
  {
    // 5300 Rent, tagged OVERHEAD, and both halves of that choice are the
    // check's: its line is not the earliest of the year, so "tagged first"
    // cannot pass by luck of the date order; and `overhead` is not the first
    // entry of LINE_CATEGORIES, so a pre-selected category cannot pass by
    // luck of the default. The first version of this check used 5100 and
    // `materials` and was green under both mutations (markers 571, 573).
    await setSredAccountCategory({ accountId: id['5300'], category: 'overhead', actor: 'alicio@example.test' })
    const offered = await allocatableLines(L, co.year.startDate, co.year.endDate)
    const first = must(offered[0], 'allocatable cost line')
    const tagged = offered.filter((a) => a.suggested === 'overhead')
    const lastTagged = offered.findLastIndex((a) => a.suggested !== null)
    const firstPlain = offered.findIndex((a) => a.suggested === null)
    // The tagged row OPEN: since 2026-09-16 a cost is text until its Claim is
    // pressed, and the defaults this reads are the boxes that press shows.
    const taggedLine = tagged[0]
    const html = (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-sred-money.tsx', JSON.stringify({
        lines: offered.map((a) => ({ ...a, amount: a.amount.toString() })),
        open: taggedLine ? `${taggedLine.source_kind}:${taggedLine.source_id}` : undefined,
      }),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    // Scoped to the ROW, not the page. `value="100"` anywhere in the markup is
    // a coincidence waiting to happen, and an assertion that passes on a
    // coincidence is the defect this file keeps finding elsewhere.
    const rows = html.split('<tr ').slice(1)
    const taggedRow = rows.find((r) => r.includes('data-suggested="overhead"')) ?? ''
    const saysSo = taggedRow !== ''
    const preselected = /<option[^>]*selected[^>]*value="overhead"|<option[^>]*value="overhead"[^>]*selected/
      .test(taggedRow)
    const hundred = /name="percent"[^>]*value="100"|value="100"[^>]*name="percent"/.test(taggedRow)
    // The detail is COMPOSED from what was observed, not asserted. Three
    // different mutations recorded a byte-identical FAIL line here, and that
    // line said "all above the untagged" for the mutation that had just
    // destroyed the ordering — evidence stating the opposite of what happened
    // (independent critic, 2026-09-11).
    const seen = [
      `first is ${first.suggested ?? 'untagged'}`,
      lastTagged < firstPlain ? 'tagged all above untagged' : 'tagged mixed in with untagged',
      saysSo ? 'row says which' : 'row says nothing',
      preselected ? 'category pre-selected' : 'category not pre-selected',
      hundred ? '100% offered' : '100% not offered',
    ].join('; ')
    check(tagged.length > 0 && first.suggested === 'overhead'
      && lastTagged < firstPlain && saysSo && preselected && hundred,
      'S24 a tagged account sorts first and arrives with its category and 100% offered',
      seen)
    await setSredAccountCategory({ accountId: id['5300'], category: null, actor: 'alicio@example.test' })
  }

  // S25 — AND THE TABLE SURVIVES A REAL YEAR. Hundreds of lines is what a set
  //       of books looks like; this screen rendered every one of them until
  //       now, which is a wall rather than a list. One page, a search box and
  //       a filter — the same shape the bank feed settled on.
  {
    const many = Array.from({ length: 120 }, (_, i) => ({
      source_kind: 'journal_line' as const,
      source_id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      on_date: `${yr}-03-01`, what: `5100 — Supplies · batch ${i}`, amount: '10000',
      claimed_percent: 0, arms_length: true, party: null, suggested: null,
    }))
    const html = (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-sred-money.tsx', JSON.stringify({ lines: many }),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const rendered = (html.match(/data-allocatable=/g) ?? []).length
    const paged = html.includes('page 1 of 3')
    check(rendered === 50 && html.includes('Search the costs') && html.includes('Which costs')
      && paged,
      'S25 one page of costs at a time, with a way to search and to narrow',
      `${rendered} of ${many.length} rows rendered; the counter `
        + `${paged ? 'says page 1 of 3' : 'does not say page 1 of 3'}; `
        + `the search box is ${html.includes('Search the costs') ? 'there' : 'MISSING'} and `
        + `the lens is ${html.includes('Which costs') ? 'there' : 'MISSING'}`)
  }

  // S26 — AND THE FILTER FILTERS.
  //
  //       `matchesCost` is called directly here AND rendered through the
  //       harness, because until 2026-09-11 neither happened: the predicate was
  //       a closure inside the component, both renders used an empty query and
  //       the `all` lens, and the harness header claimed it was being checked.
  //       Every branch below is a branch that ran zero times under a battery
  //       reporting full coverage.
  {
    const row = (over: Partial<Allocatable>): Allocatable => ({
      source_kind: 'journal_line', source_id: 'x', on_date: `${yr}-03-04`,
      what: '5100 — Materials · gasket batch', amount: 1000n, claimed_percent: 0,
      arms_length: true, party: null, suggested: null, ...over,
    })
    const plain = row({})
    const taggedRow = row({ suggested: 'overhead' })
    const claimedRow = row({ claimed_percent: 40 })
    const withParty = row({ party: 'Outside Lab Ltd.' })

    const branches = [
      ['every word must appear', matchesCost(plain, 'gasket materials', 'all')],
      ['a word that is not there fails', !matchesCost(plain, 'gasket turbine', 'all')],
      ['order does not matter', matchesCost(plain, 'materials gasket', 'all')],
      ['case does not matter', matchesCost(plain, 'GASKET', 'all')],
      ['the date is searchable', matchesCost(plain, `${yr}-03`, 'all')],
      ['the party is searchable', matchesCost(withParty, 'outside lab', 'all')],
      ['tagged keeps a tagged row', matchesCost(taggedRow, '', 'tagged')],
      ['tagged drops an untagged row', !matchesCost(plain, '', 'tagged')],
      ['unclaimed keeps an unclaimed row', matchesCost(plain, '', 'unclaimed')],
      ['unclaimed drops a claimed row', !matchesCost(claimedRow, '', 'unclaimed')],
      ['a category keeps its own', matchesCost(taggedRow, '', 'overhead')],
      ['a category drops another', !matchesCost(taggedRow, '', 'materials')],
      ['all keeps everything', matchesCost(claimedRow, '', 'all')],
      ['the lens and the words both apply', !matchesCost(taggedRow, 'turbine', 'tagged')],
    ] as const
    const broken = branches.filter(([, ok]) => !ok).map(([what]) => what)

    // …and the table really does show the narrowed list, not just hold a box.
    const mixed = [plain, taggedRow, claimedRow].map((a, i) => ({
      ...a, source_id: `0000000${i}-0000-4000-8000-000000000000`, amount: '1000',
    }))
    const render = (query: string, lens: string) => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-sred-money.tsx', JSON.stringify({ lines: mixed, query, lens }),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const count = (html: string) => (html.match(/data-allocatable=/g) ?? []).length
    const everything = count(render('', 'all'))
    const onlyTagged = count(render('', 'tagged'))
    const noMatch = count(render('turbine', 'all'))

    check(broken.length === 0 && everything === 3 && onlyTagged === 1 && noMatch === 0,
      'S26 the search and the lens narrow the list, and the table shows what is left',
      broken.length === 0
        ? `${branches.length} branches, and the table went ${everything} → ${onlyTagged} → ${noMatch}`
        : `not filtering: ${broken.join(', ')}`)
  }

  // S23 — AND A ROW THAT CHANGES HANDS IS NOT COUNTED AGAINST ITSELF.
  //
  //       0069 excluded the CLAIM, which is right for every write this
  //       application makes. On an UPDATE that moves a row to another claim the
  //       pre-image still carries the old one, so the exclusion missed it and
  //       the row was summed against itself — a refusal saying a source was
  //       over-claimed by the very row being moved. 0070 excludes the id as
  //       well (independent critic, 2026-09-11).
  //
  //       Nothing in the tree moves a row between claims, so this goes through
  //       raw SQL on purpose: the fence lives in the database and is tested
  //       where it lives, rather than through a door that cannot reach it.
  {
    // A cost of its own, posted here: every line the fixture already holds is
    // spoken for, and borrowing one would make this check depend on how much of
    // it some earlier check happened to leave.
    const fresh = await postEntry({
      ledgerId: L, entryDate: `${yr}-04-03`, description: 'Second batch of gasket stock',
      actor: 'alicio@example.test',
      lines: [
        // The LINE carries the description: `allocatableLines` builds what a
        // person reads from the account plus the line's own words, not from the
        // entry's, so an entry-level description is invisible there.
        { accountId: id['5100'], amount: parseMoney('1000.00'), description: 'gasket stock' },
        { accountId: id['1000'], amount: -parseMoney('1000.00') },
      ],
    })
    void fresh
    const line = must((await allocatableLines(L, co.year.startDate, co.year.endDate))
      .find((a) => a.claimed_percent === 0 && a.what.includes('gasket stock')),
      'line it just posted')
    const other = must((await claimsFor(secondProjectId))[0], 'claim on the second project')
    await allocate({ claimId: claim.id, sourceKind: 'journal_line', sourceId: line.source_id,
      category: 'materials', percent: '60', basis: 'Most of this batch went into the rig.',
      actor: 'alicio@example.test' })
    let moved = ''
    try {
      await db.execute(raw`
        UPDATE sred_allocation SET claim_id = ${other.id}::uuid
         WHERE claim_id = ${claim.id}::uuid AND source_id = ${line.source_id}::uuid`)
    } catch (e) { moved = errorChain(e) }
    // Put the source back to unclaimed either way, so later checks see the
    // fixture they expect.
    await db.execute(raw`
      DELETE FROM sred_allocation WHERE source_id = ${line.source_id}::uuid`)
    check(moved === '',
      'S23 moving an allocation between claims is not refused by counting it against itself',
      moved === '' ? '60% moved to another claim, unrefused' : moved.slice(0, 90))
  }

  // S21 — A FILED YEAR'S MONEY IS FIXED; ITS PROJECT RECORD IS NOT.
  //
  //       The screen said "nothing about the claim can be changed afterwards"
  //       while only `saveClaim` refused anything — so every allocation, which
  //       is what produces each figure on the return that went, stayed
  //       editable (independent critic, 2026-09-10). The allocations are money
  //       and are frozen now. Time and evidence are NOT: they belong to the
  //       project and span its years, and a document found in March that
  //       supports work done two years ago is a thing a person should still be
  //       able to file away. This checks BOTH halves, because a freeze that
  //       took the record with it would punish the one habit the module exists
  //       to encourage.
  {
    let filedAgain = ''
    try {
      await fileClaim({ claimId: claim.id, filedOn: `${yr + 1}-06-30`,
                        actor: 'alicio@example.test' })
    } catch (e) { filedAgain = e instanceof SredError ? e.code : errorChain(e) }
    const stub = (await allocatableSalary(L, co.year.startDate, co.year.endDate))[0]

    let movingMoney = ''
    try {
      await allocate({ claimId: claim.id, sourceKind: 'pay_stub', sourceId: stub.source_id,
        category: 'salary', percent: '1', basis: 'changing my mind after the fact',
        actor: 'alicio@example.test' })
    } catch (e) { movingMoney = e instanceof SredError ? e.code : errorChain(e) }

    let droppingMoney = ''
    const [anyAllocation] = await db.execute<{ id: string }>(raw`
      SELECT id::text FROM sred_allocation WHERE claim_id = ${claim.id}::uuid LIMIT 1`)
    try {
      await unallocate(anyAllocation!.id, 'alicio@example.test')
    } catch (e) { droppingMoney = e instanceof SredError ? e.code : errorChain(e) }

    // …and the project record goes on being kept.
    let recordStillOpen = true
    try {
      await logSredTime({ projectId: project.id, employeeId: handEmp.id,
        onDate: `${yr}-11-14`, hours: '2', activity: 'Wrote up the third trial for the file.',
        actor: 'alicio@example.test' })
      await addEvidence({ projectId: project.id, kind: 'notebook',
        title: 'Bench notebook, found later', onDate: `${yr}-11-14`,
        actor: 'alicio@example.test' })
    } catch { recordStillOpen = false }

    let putBack = ''
    try {
      await unfileClaim({ claimId: claim.id, reason: 'Back to a draft for the rest of the checks.',
                          actor: 'alicio@example.test' })
    } catch (e) { putBack = e instanceof SredError ? e.code : errorChain(e) }
    check(filedAgain === '' && movingMoney === 'FILED' && droppingMoney === 'FILED'
      && recordStillOpen && putBack === '',
      'S21 filing freezes the money and leaves the project record open',
      `allocate ${movingMoney || 'allowed'}, unallocate ${droppingMoney || 'allowed'}; `
        + `time and evidence ${recordStillOpen ? 'still go in' : 'are REFUSED too'}`
        + `${filedAgain || putBack ? ' (but the door itself refused)' : ''}`)
  }

  // S30 — A SECOND YEAR OPENS, AND THE BUTTON OPENS THE YEAR IN FRONT OF YOU.
  //
  //       What was wrong, and why ten checks walked past it, is set out once on
  //       `viewedYear` in sred-kinds.ts. What is here is what holds it.
  {
    // THE FIXTURE'S OWN DOORS ARE GUARDED. An unguarded call that refuses kills
    // `main()` before the summary line, and the battery records that as
    // "SUITE DID NOT FINISH" — a dead suite where a red check should be
    // (independent critic, 2026-09-12).
    let opened = ''
    let nextId = ''
    try {
      const planned = await createFiscalYear(L, `${yr + 1}-12-31`, 'alicio@example.test')
      nextId = planned.year.id
      await openClaim({ projectId: project.id, fiscalYearId: nextId,
                        actor: 'alicio@example.test' })
    } catch (e) { opened = e instanceof SredError ? e.code : errorChain(e) }
    // THE CONFLICT TARGET of that upsert cannot be mutated usefully: the only
    // matching index is `sred_claim_one_per_year`, so retargeting it errors on
    // the FIRST claim too — which this fixture opens unguarded near the top of
    // the file — and the battery records a dead suite instead of a red check.
    // That is true of the conflict target and NOT of the upsert generally: the
    // first version of this comment said "every plausible weakening", and block
    // 602 is a weakening that breaks only the second year, handed over by the
    // reviewer who read the sentence (independent critic, 2026-09-12).
    const mine = await claimsFor(project.id)
    const twoYears = new Set(mine.map((c) => c.fiscal_year_id)).size
    // AND NEWEST FIRST, ASKED OF THE DATABASE. `viewedYear` lands on
    // `claims[0]`; what makes that the newest is `claimsFor`'s ORDER BY, and no
    // literal array can say anything about it. Stated as the pairwise property
    // so it is not a second spelling of "a second year opened" — that one is
    // `twoYears`, and neither implies the other (independent critic, 2026-09-12).
    const descending = mine.every((c, i) => i === 0 || mine[i - 1].year_end >= c.year_end)

    // The resolver, branch by branch. FOUR years and TWO claims: two claims so
    // that `claims[0]` is a choice rather than the only answer a function could
    // give, and no claimed year is `years[0]`, so "the year of the first claim"
    // and "the newest year" are never the same value.
    const y = (id: string, n: number) =>
      ({ id, start_date: `${n}-01-01`, end_date: `${n}-12-31` })
    const ys = [y('d', 2029), y('c', 2028), y('b', 2027), y('a', 2026)]
    const cs = [{ fiscal_year_id: 'c' }, { fiscal_year_id: 'a' }]
    //
    // THE WINDOW IS ASSERTED ON ALL THREE ARMS, not only the asked one. It was
    // asserted on `wanted` alone, and `span = wanted ? … : null` survived every
    // branch while giving the DEFAULT view — a project opened with no `?year=`
    // in the address — no costs at all (independent critic, 2026-09-12).
    const branches: Array<[string, boolean]> = [
      ['no year asked → the first claim given, on its own year and dates',
       viewedYear(ys, cs, undefined).claim === cs[0]
         && viewedYear(ys, cs, undefined).year?.id === 'c'
         && viewedYear(ys, cs, undefined).span?.from === '2028-01-01'],
      ['a claimed year → that year’s own claim',
       viewedYear(ys, cs, 'a').claim === cs[1] && viewedYear(ys, cs, 'a').year?.id === 'a'],
      ['a year with nothing in it → NO claim, and that year',
       viewedYear(ys, cs, 'b').claim === null && viewedYear(ys, cs, 'b').year?.id === 'b'],
      ['an id that is not a year → the first claim given',
       viewedYear(ys, cs, 'zzz').claim === cs[0] && viewedYear(ys, cs, 'zzz').year?.id === 'c'],
      // `claim === null` is NOT asserted here: `claims` is the empty array, so
      // `claims[0] ?? null` is null for any implementation that indexes it, and
      // a clause no implementation can fail is not a clause.
      ['a project with no claim anywhere → the newest year, and its dates',
       viewedYear(ys, [], undefined).year?.id === 'd'
         && viewedYear(ys, [], undefined).span?.from === '2029-01-01'],
      // THERE IS NO "no years at all" BRANCH, and there was. It asserted
      // `year === null` on an empty year list — but every arm of the resolver
      // reads from `years`, so null is the answer whatever the arms are, in
      // whatever order, and the one edit that would change it (dropping the
      // trailing `?? null`) does not typecheck. The same reasoning that had
      // just removed `span === null` from beside it applies to the clause
      // itself (independent critic, 2026-09-12).
      ['the window of the year asked for is that year’s own dates',
       viewedYear(ys, cs, 'b').span?.from === '2027-01-01'
         && viewedYear(ys, cs, 'b').span?.to === '2027-12-31'],
    ]

    // And the STRIP, because the resolver being right does not make the button
    // submit the right year — that was the other half, and it lives in markup.
    //
    // THE CONDITION ON THIS ARRAY: the year being looked at has no claim AND is
    // not `years[0]`. Without the second half, `years[0]` and the viewed year
    // are the same value and the block that puts the old defect back reddens
    // nothing. It is a condition on this fixture, not on `ys` above
    // (independent critic, 2026-09-12).
    const strip = (yearId: string | null) => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-sred-years.tsx', JSON.stringify({
        years: [{ id: 'c', name: 'FY2028' }, { id: 'b', name: 'FY2027' },
                { id: 'a', name: 'FY2026' }],
        claims: [{ fiscal_year_id: 'a' }], yearId,
      }),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const onBare = strip('b')
    const onClaimed = strip('a')
    const submits = /name="fiscalYearId"[^>]*value="([^"]*)"/.exec(onBare)?.[1] ?? '(no opener at all)'
    // Scoped to the year's own link, not the page: `bg-clay-600` somewhere in
    // the markup is a coincidence, and this file has been caught by one before.
    const bareLink = onBare.split('<a ').find((a) => a.includes('?year=b')) ?? ''
    const marksViewed = bareLink.includes('bg-clay-600')
    const offeredOnClaimed = /name="fiscalYearId"/.test(onClaimed)
    // AND THE DOT, which is the strip's only way of saying which years already
    // have a claim. Read as the two labels themselves rather than as a
    // predicate, so the detail can print what the buttons say; inverting the
    // marker compiles and left every other clause green
    // (independent critic, 2026-09-12).
    const labelOf = (html: string, id: string) => {
      const a = html.split('<a ').find((x) => x.includes(`?year=${id}`)) ?? ''
      return (/>([^<]*)</.exec(a)?.[1] ?? '(no link)').trim()
    }
    const claimedLabel = labelOf(onBare, 'a')
    const bareLabel = labelOf(onBare, 'b')
    const marksWhichHaveClaims = claimedLabel === 'FY2026' && bareLabel === 'FY2027 ·'

    // The two hand-off lines, and the ordering the resolver leans on. THESE
    // MEASURE TEXT: `page.tsx` is a server component and nothing in this battery
    // renders one. They are worded as what they are — a substring is present —
    // rather than as what the page does, because a detail that reads like
    // behaviour while measuring presence is this file's oldest defect. The one
    // line here that was a DECISION rather than a hand-off, the cost window, is
    // no longer in the page at all: it moved into `viewedYear`, where a branch
    // above calls it (independent critic, 2026-09-12).
    const pageText = readFileSync(
      join('src', 'app', 'ledger', '[ledgerId]', 'sred', '[projectId]', 'page.tsx'), 'utf8')
    const wired: Array<[string, boolean]> = [
      ['`viewedYear(years, claims, asked)`', pageText.includes('viewedYear(years, claims, asked)')],
      ['`yearId={year?.id ?? null}`', pageText.includes('yearId={year?.id ?? null}')],
      ['`ORDER BY end_date DESC`', pageText.includes('ORDER BY end_date DESC')],
      // BOTH of the window's consumers. Moving the DECISION out of the page and
      // into `viewedYear` left the HAND-OFF held by nothing, so the page could
      // reach past `span` to `years[0]` and reproduce block 599 from the other
      // side. The first repair took the salary line and said "the window's one
      // consumer" — there are two, and the costs line is the one that carries
      // materials, contracts and overhead (independent critic, 2026-09-12).
      ['`allocatableSalary(ledgerId, span.from, span.to)`',
       pageText.includes('allocatableSalary(ledgerId, span.from, span.to)')],
      ['`allocatableLines(ledgerId, span.from, span.to)`',
       pageText.includes('allocatableLines(ledgerId, span.from, span.to)')],
      // AND ALL THREE OF THE CLAIM'S OWN. `viewedYear` answers with three
      // things and this was the one nothing held on the page side — the one
      // that routes the WRITES. `claim={claims[0] ?? null}` compiles, leaves
      // every branch and every rendered clause above green, and gives a year
      // with nothing in it another year's narrative, method and figures while
      // every form on the screen posts that other year's claim id: an
      // allocation made on 2027 written against 2026, and "file" filing 2026.
      // Block 595 had no page-side twin; 599 had two (independent critic,
      // 2026-09-12).
      ['`claim={claim}`', pageText.includes('claim={claim}')],
      ['`workingPaper(claim.id)`', pageText.includes('workingPaper(claim.id)')],
      ['`claim_id = ${claim.id}::uuid`',
       pageText.includes('claim_id = ${claim.id}::uuid')],
    ]

    check(opened === '' && twoYears === 2 && descending
      && branches.every(([, ok]) => ok)
      && submits === 'b' && marksViewed && !offeredOnClaimed
      && marksWhichHaveClaims && wired.every(([, ok]) => ok),
      'S30 a second year opens, and the button opens the year in front of you',
      `${opened ? `the door REFUSED a second year: ${opened}; ` : ''}`
        + `${twoYears} year(s) claimed on one project, `
        + `${descending ? 'newest first' : 'NOT newest first'}; `
        + `${branches.map(([w, ok]) => `${ok ? '' : 'NOT '}${w}`).join('; ')}; `
        + `the opener on an unclaimed year submits ${submits} and that year `
        + `${marksViewed ? 'is marked as the one being looked at' : 'is NOT marked'}; `
        + `on a year that has a claim the opener is `
        + `${offeredOnClaimed ? 'STILL OFFERED' : 'not offered'}; the buttons read `
        + `“${claimedLabel}” for the claimed year and “${bareLabel}” for the bare one; page.tsx `
        + `${wired.map(([w, ok]) => `${ok ? 'has' : 'NO LONGER has'} ${w}`).join(', ')}`)
  }

  // S31 — THE TWO PASTE FORMATS, READ BY THE THING THAT READS THEM.
  //
  //       `parseTimePaste` and `parseEvidencePaste` are pure and exported for
  //       exactly this: a parser living inside the screen is a parser nothing
  //       can call, and every refusal below is a line a person will actually
  //       hit. The good rows and the bad ones go in ONE text, because that is
  //       how a batch arrives.
  {
    const timeText = [
      '### TIME',
      '',
      'Dana Owner | 2026-03-02 | 6.25 | Ran seal geometry B at 40 psi.',
      'Sam Engineer | 2026-03-03 | 8 | Wrote up the weld failures.',
      'Sam Engineer | 2026-03-04 | 8',
      'Sam Engineer | 03-05-2026 | 4 | Bad date.',
      'Sam Engineer | 2026-03-06 | 4.005 | Too many decimals.',
      'Sam Engineer | 2026-03-07 | 25 | A long day.',
      'Sam Engineer | 2026-03-08 | 0 | No time at all.',
      'Sam Engineer | 2026-03-09 | 4 | ',
      ' | 2026-03-10 | 4 | Nobody.',
    ].join('\n')
    const t = parseTimePaste(timeText)
    const why = (n: number) => t.refused.find((r) => r.line === n)?.why ?? '(not refused)'
    const timeRight =
      t.rows.length === 2 && t.rows[0]?.who === 'Dana Owner' && t.rows[0]?.line === 3
      && t.refused.length === 7
      && why(5).includes('4 fields expected, 3 given')
      && why(6).includes('not yyyy-mm-dd') && why(7).includes('two decimals')
      && why(8).includes('between 0 and 24') && why(9).includes('between 0 and 24')
      && why(10).includes('no activity') && why(11).includes('no name')

    const evText = [
      '### EVIDENCE',
      'trial_record | March pressure trials, raw sheets | 2026-03-31',
      'lab_book | Not one of the thirteen | 2026-03-31',
      'invoice |  | 2026-04-01',
      'invoice | Rig hire | April',
      'invoice | Rig hire | 2026-04-02 | extra',
    ].join('\n')
    const e = parseEvidencePaste(evText)
    const eWhy = (n: number) => e.refused.find((r) => r.line === n)?.why ?? '(not refused)'
    const evRight =
      e.rows.length === 1 && e.rows[0]?.kind === 'trial_record' && e.rows[0]?.line === 2
      && e.refused.length === 4
      && eWhy(3).includes('is not one of the kinds') && eWhy(4).includes('no title')
      && eWhy(5).includes('not yyyy-mm-dd') && eWhy(6).includes('3 fields expected, 4 given')

    check(timeRight && evRight,
      'S31 a pasted batch is read line by line, and every bad line says which and why',
      `hours: ${t.rows.length} kept of ${t.rows.length + t.refused.length} read, first is `
        + `${t.rows[0]?.who ?? 'nobody'} from line ${t.rows[0]?.line ?? 0}; `
        + `${[5, 6, 7, 8, 9, 10, 11].map((n) => `L${n} ${why(n)}`).join('; ')}; `
        + `paper: ${e.rows.length} kept of ${e.rows.length + e.refused.length} read, first is `
        + `${e.rows[0]?.kind ?? 'nothing'} from line ${e.rows[0]?.line ?? 0}; `
        + `${[3, 4, 5, 6].map((n) => `L${n} ${eWhy(n)}`).join('; ')}`)
  }

  // S32 — AND THE DOORS DO THE TWO THINGS A PARSER CANNOT: turn a name into an
  //       employee, and notice a row already on file. ALL OR NOTHING, so a
  //       batch with one bad line puts nothing in — otherwise the person
  //       re-pastes a batch whose good half is already there and this system
  //       cannot tell a repeat of a day's work from a double paste.
  {
    const before = (await timeFor(project.id)).length
    const oneBad = await logSredTimeBatch({
      projectId: project.id, entityId: E, actor: 'alicio@example.test',
      text: 'Sam Engineer | 2026-05-04 | 3 | Re-ran the weld.\nNobody At All | 2026-05-05 | 3 | Ghost.',
    })
    const afterBad = (await timeFor(project.id)).length
    const good = await logSredTimeBatch({
      projectId: project.id, entityId: E, actor: 'alicio@example.test',
      text: '### TIME\nSam Engineer | 2026-05-04 | 3 | Re-ran the weld.\nDana Owner | 2026-05-05 | 2 | Read it back.',
    })
    const afterGood = (await timeFor(project.id)).length
    const again = await logSredTimeBatch({
      projectId: project.id, entityId: E, actor: 'alicio@example.test',
      text: 'Sam Engineer | 2026-05-04 | 3 | Re-ran the weld.',
    })
    // TWICE IN ONE PASTE, which the table cannot see: the key has to be added as
    // each row is accepted, not only read from what is already there
    // (independent critic, 2026-09-12).
    const twiceInOne = await logSredTimeBatch({
      projectId: project.id, entityId: E, actor: 'alicio@example.test',
      text: 'Sam Engineer | 2026-05-07 | 1 | Same line twice.\nSam Engineer | 2026-05-07 | 1 | Same line twice.',
    })
    const afterTwice = (await timeFor(project.id)).length
    const evBefore = (await evidenceFor(project.id)).length
    const evGood = await addSredEvidenceBatch({
      projectId: project.id, actor: 'alicio@example.test',
      text: '### EVIDENCE\nscrap_record | Two failed seals kept | 2026-05-06',
    })
    const evAfter = (await evidenceFor(project.id)).length

    check(oneBad.added === 0 && afterBad === before
      && oneBad.refused.some((r) => r.why.includes('no active employee called "Nobody At All"'))
      && good.added === 2 && afterGood === before + 2
      && again.added === 0 && again.refused.some((r) => r.why.includes('already on file'))
      && twiceInOne.added === 0 && afterTwice === afterGood
      && twiceInOne.refused.some((r) => r.line === 2 && r.why.includes('already on file'))
      && evGood.added === 1 && evAfter === evBefore + 1,
      'S32 a batch goes in whole or not at all, and says which line stopped it',
      `one unknown name: ${oneBad.added} added, ${afterBad - before} row(s) appeared, `
        + `refused ${oneBad.refused.map((r) => r.why).join(' / ').slice(0, 48)}; `
        + `a clean batch: ${good.added} added, ${afterGood - before} appeared; `
        + `the same batch again: ${again.added} added, `
        + `${again.refused[0]?.why ?? 'NOT refused'}; the same line twice in ONE paste: `
        + `${twiceInOne.added} added, ${afterTwice - afterGood} appeared, line 2 `
        + `${twiceInOne.refused.find((r) => r.line === 2)?.why ?? 'NOT refused'}; `
        + `paper: ${evGood.added} added, `
        + `${evAfter - evBefore} appeared`)
  }

  // S33 — CORRECTING IT, AND WHAT FILING PUTS BEYOND CORRECTION.
  //
  //       Adding to a filed year stays open — `S21` holds that, and it is
  //       deliberate. Editing and deleting are a different act: they change
  //       what a return that has already gone rested on. So this walks both
  //       sides of that line rather than one.
  {
    const rowOf = async (activity: string) =>
      (await timeFor(project.id)).find((t) => t.activity === activity)
    // EVERY door call in this check goes through here, including the ones
    // expected to succeed. A block that makes the fence refuse where it should
    // not would otherwise throw out of `main()` and be recorded as a dead suite
    // rather than as this line going red (marker 619 did exactly that).
    const refusedBy = async (run: () => Promise<unknown>) => {
      try { await run(); return '' } catch (e) { return e instanceof SredError ? e.code : errorChain(e) }
    }
    // NOT `must`. The row this edits was put there by the batch in S32, and a
    // block that stops the batch would turn a missing row into a thrown
    // TypeError — which the battery records as a dead suite, not a red check.
    // Five earlier blocks in this file died that way (marker 613 was the sixth).
    const mine = await rowOf('Re-ran the weld.')
    const editRefusal = mine
      ? await refusedBy(() => updateSredTime({ timeId: mine.id, onDate: '2026-05-04',
          hours: '4.5', activity: 'Re-ran the weld, twice.', actor: 'alicio@example.test' }))
      : 'no pasted row to edit'
    const fixed = await rowOf('Re-ran the weld, twice.')
    const edited = editRefusal === '' && fixed?.hours === '4.50'

    // Now a year that HAS been filed, and a row inside it. NOTHING HERE IS
    // `must` EITHER: the second year is S30's, the row and the paper are put
    // there by doors, and a block on any of the three would turn this check
    // into a dead suite. `NOT_RUN` is a value the detail prints, so a reader
    // sees which half could not be reached rather than a stack trace.
    const NOT_RUN = 'not reached'
    // Looked up once, and NOT with `must`: the batch in S32 may not have run.
    const pasted0 = (await evidenceFor(project.id)).find((e) => e.title === 'Two failed seals kept')
    const nextYear = (await claimsFor(project.id)).find((c) => c.fiscal_year_id !== co.year.id)
    const wroteHour = await refusedBy(() => logSredTime({ projectId: project.id,
      employeeId: handEmp.id, onDate: `${yr + 1}-02-02`, hours: '3',
      activity: 'Work in the year that gets filed.', actor: 'alicio@example.test' }))
    const inFiled = await rowOf('Work in the year that gets filed.')
    const wrotePaper = await refusedBy(() => addEvidence({ projectId: project.id, kind: 'photo',
      title: 'Rig, second year', onDate: `${yr + 1}-02-03`, actor: 'alicio@example.test' }))
    const paperInFiled = (await evidenceFor(project.id)).find((e) => e.title === 'Rig, second year')
    const filed = nextYear
      ? await refusedBy(() => fileClaim({ claimId: nextYear.id, filedOn: `${yr + 2}-06-30`,
                                          actor: 'alicio@example.test' }))
      : 'no second year to file'

    const editRefused = inFiled
      ? await refusedBy(() => updateSredTime({ timeId: inFiled.id,
          onDate: `${yr + 1}-02-02`, hours: '9', activity: 'Nine hours after all.',
          actor: 'alicio@example.test' }))
      : NOT_RUN
    const dropRefused = inFiled
      ? await refusedBy(() => deleteSredTime({ timeId: inFiled.id, actor: 'alicio@example.test' }))
      : NOT_RUN
    const paperRefused = paperInFiled
      ? await refusedBy(() => deleteSredEvidence({ evidenceId: paperInFiled.id,
                                                   actor: 'alicio@example.test' }))
      : NOT_RUN
    // INTO the filed year, not out of it. A row already inside one is refused by
    // the first of the two tests whatever the second does, so moving it out
    // proves nothing about the destination being checked; a DRAFT row redated
    // into the filed year is the only thing that does.
    const carryIn = mine
      ? await refusedBy(() => updateSredTime({ timeId: mine.id,
          onDate: `${yr + 1}-02-05`, hours: '4.5', activity: 'Re-ran the weld, twice.',
          actor: 'alicio@example.test' }))
      : 'no draft row to carry'
    // The paper's DESTINATION date, which nothing reached: S33 only ever edited
    // evidence without moving it, so the second of its two fences was held by
    // nothing (independent critic, 2026-09-12).
    const paperCarryIn = pasted0
      ? await refusedBy(() => updateSredEvidence({ evidenceId: pasted0.id,
          kind: 'scrap_record', title: 'Two failed seals kept',
          onDate: `${yr + 1}-02-06`, actor: 'alicio@example.test' }))
      : 'no pasted evidence to carry'
    // The edit door's hours, which used to go straight at the column.
    const badHours = mine
      ? await refusedBy(() => updateSredTime({ timeId: mine.id, onDate: '2026-05-04',
          hours: '25', activity: 'Re-ran the weld, twice.', actor: 'alicio@example.test' }))
      : 'no draft row to over-fill'
    // …and the draft year is still correctable while that one is filed.
    const draftStillOpen = pasted0
      ? await refusedBy(() => updateSredEvidence({
          evidenceId: pasted0.id, kind: 'scrap_record', title: 'Two failed seals, kept',
          onDate: '2026-05-06', actor: 'alicio@example.test' }))
      : 'no pasted evidence reached the draft year'
    const unfiled = nextYear
      ? await refusedBy(() => unfileClaim({ claimId: nextYear.id,
          reason: 'Back to a draft for the rest of the checks.', actor: 'alicio@example.test' }))
      : NOT_RUN
    const afterUnfiling = inFiled
      ? await refusedBy(() => deleteSredTime({ timeId: inFiled.id, actor: 'alicio@example.test' }))
      : NOT_RUN
    const gone = inFiled !== undefined && (await timeFor(project.id)).every((t) => t.id !== inFiled.id)

    // ADDING to a filed year is still open, and the paper now says so, because
    // an allocation basis that quotes a share of hours was frozen and its
    // denominator was not.
    //
    // ON THE FIRST YEAR, not the second: a working paper needs a YMPE for its
    // year and 2027's CPP table is not on file — `ympeFor` refuses, which is
    // correct and is why this episode is here rather than beside the fence
    // tests above.
    const filedFirst = await refusedBy(() => fileClaim({ claimId: claim.id,
      filedOn: `${yr + 1}-06-30`, actor: 'alicio@example.test' }))
    const lateHour = await refusedBy(() => logSredTime({ projectId: project.id,
      employeeId: handEmp.id, onDate: `${yr}-11-20`, hours: '2',
      activity: 'Written up long afterwards.', actor: 'alicio@example.test' }))
    // THE COUNT, not the sentence. This year already holds hours written long
    // before the filing, so "does the paper mention late hours" stayed true
    // with the predicate deleted or reversed — five earlier rows kept the
    // number above zero. Exactly one row is created after the filing above
    // (independent critic, 2026-09-12).
    const lateSaid = (await workingPaper(claim.id)).toConfirm
      .find((t) => t.includes('written down AFTER this year was filed')) ?? ''
    const paperSaysLate = lateSaid.startsWith('1 hour record(s)')
    const unfiledFirst = await refusedBy(() => unfileClaim({ claimId: claim.id,
      reason: 'Back to a draft for the rest of the checks.', actor: 'alicio@example.test' }))

    check(edited && wroteHour === '' && wrotePaper === '' && filed === ''
      && editRefused === 'FILED_YEAR' && dropRefused === 'FILED_YEAR'
      && paperRefused === 'FILED_YEAR' && carryIn === 'FILED_YEAR'
      && paperCarryIn === 'FILED_YEAR' && badHours === 'BAD_HOURS'
      && filedFirst === '' && lateHour === '' && paperSaysLate && unfiledFirst === ''
      && draftStillOpen === '' && unfiled === '' && afterUnfiling === '' && gone,
      'S33 the record can be corrected, except where a filed return rests on it',
      `an hour changed to ${fixed?.hours ?? (editRefusal || 'NOT changed')}; `
        + 'inside a filed year — '
        + `edit ${editRefused || 'ALLOWED'}, delete ${dropRefused || 'ALLOWED'}, `
        + `paper ${paperRefused || 'ALLOWED'}; a draft row redated into it `
        + `${carryIn || 'WENT IN'}, a draft paper redated into it ${paperCarryIn || 'WENT IN'}; `
        + `25 hours through the edit door ${badHours || 'was ACCEPTED'}; the first year filed `
        + `${filedFirst || 'yes'}, an hour ADDED to it afterwards ${lateHour || 'went in'} and `
        + `the paper says “${lateSaid.slice(0, 46) || 'NOTHING about it'}”, un-filed again `
        + `${unfiledFirst || 'yes'}; setting it up: hour `
        + `${wroteHour || 'written'}, `
        + `paper ${wrotePaper || 'written'}, filed ${filed || 'yes'}, un-filed `
        + `${unfiled || 'yes'}; the draft year `
        + `${draftStillOpen === '' ? 'still edits' : `is REFUSED: ${draftStillOpen}`}; `
        + `after un-filing the delete ${afterUnfiling || 'went through'} and the row `
        + `${gone ? 'is gone' : 'IS STILL THERE'}`)
  }

  // S35 — THE PROJECT ITSELF: the three columns no screen could reach, the
  //       status it refuses, and putting one away.
  //
  //       ON A PROJECT OF ITS OWN, because the block written for the delete
  //       guard has to be allowed to succeed: a mutation that lets the delete
  //       through takes the project's claims, hours and evidence with it, and
  //       pointed at the main fixture that is a dead suite rather than a red
  //       check — the same trap `S30`'s door comment records.
  {
    // EVERY DOOR CALL HERE IS GUARDED TOO, including the ones expected to
    // succeed, and nothing is `must`. The first version had three bare awaits
    // and a `must`, any of which a block aimed at those doors would have turned
    // into a dead suite (independent critic, 2026-09-12).
    const NOT_RUN = 'not reached'
    const refusedBy = async (run: () => Promise<unknown>) => {
      try { await run(); return '' } catch (e) { return e instanceof SredError ? e.code : errorChain(e) }
    }
    let made = ''
    let throwawayId = ''
    try {
      throwawayId = (await createSredProject({ entityId: E, code: 'GONE',
        title: 'Whether it can be put away again', startedOn: `${yr}-01-05`,
        actor: 'alicio@example.test' })).id
    } catch (e) { made = e instanceof SredError ? e.code : errorChain(e) }
    const before = (await sredProjects(E)).length

    const renamed = throwawayId
      ? await refusedBy(() => updateSredProject({ projectId: throwawayId, code: 'GONE2',
          title: 'Whether it can be put away again, renamed', startedOn: `${yr}-01-06`,
          fieldOfScience: '1.03 Physical sciences', status: 'abandoned',
          endedOn: `${yr}-11-30`, actor: 'alicio@example.test' }))
      : NOT_RUN
    const saved = (await sredProjects(E)).find((p) => p.id === throwawayId)
    const wrote = saved?.code === 'GONE2' && saved?.field_of_science === '1.03 Physical sciences'
      && saved?.status === 'abandoned' && saved?.ended_on === `${yr}-11-30`
      && saved?.started_on === `${yr}-01-06`

    const badStatus = saved
      ? await refusedBy(() => updateSredProject({ projectId: throwawayId,
          code: 'GONE2', title: saved.title, startedOn: saved.started_on, status: 'shelved',
          actor: 'alicio@example.test' }))
      : NOT_RUN

    // The ledger's own newest year, not another check's claim: borrowing one
    // makes a block on `openClaim` throw here instead of reddening a line.
    const [newest] = await db.execute<{ id: string }>(raw`
      SELECT id::text FROM fiscal_year WHERE ledger_id = ${L}::uuid ORDER BY end_date DESC LIMIT 1`)
    let itsId = ''
    let opened = ''
    try {
      itsId = (await openClaim({ projectId: throwawayId, fiscalYearId: newest?.id ?? co.year.id,
                                 actor: 'alicio@example.test' })).id
    } catch (e) { opened = e instanceof SredError ? e.code : errorChain(e) }
    const itsFiled = itsId
      ? await refusedBy(() => fileClaim({ claimId: itsId, filedOn: `${yr + 2}-06-30`,
                                          actor: 'alicio@example.test' }))
      : NOT_RUN
    // THE PROJECT'S OWN FENCE, which did not exist: the title is on T661, so
    // once a year of it has gone that title is what a return said. The status
    // and the end date are not on the return and stay open — a project
    // concludes after the first year is filed and saying so is the point of the
    // column (independent critic, 2026-09-12).
    const renameWhileFiled = saved
      ? await refusedBy(() => updateSredProject({ projectId: throwawayId, code: 'GONE3',
          title: saved.title, startedOn: saved.started_on, fieldOfScience: saved.field_of_science ?? undefined,
          status: saved.status, endedOn: saved.ended_on ?? undefined, actor: 'alicio@example.test' }))
      : NOT_RUN
    const statusWhileFiled = saved
      ? await refusedBy(() => updateSredProject({ projectId: throwawayId, code: saved.code,
          title: saved.title, startedOn: saved.started_on, fieldOfScience: saved.field_of_science ?? undefined,
          status: 'concluded', endedOn: `${yr}-12-01`, actor: 'alicio@example.test' }))
      : NOT_RUN
    const whileFiled = await refusedBy(() => deleteSredProject({ projectId: throwawayId,
      actor: 'alicio@example.test' }))
    const stillThere = (await sredProjects(E)).some((p) => p.id === throwawayId)
    // Guarded like the rest: a block that lets the delete through takes this
    // claim with it, and an unguarded un-file would then throw out of `main()`
    // and be recorded as a dead suite instead of as this line going red.
    const unfiled = itsId
      ? await refusedBy(() => unfileClaim({ claimId: itsId,
          reason: 'Nothing went to CRA; this was a check.', actor: 'alicio@example.test' }))
      : NOT_RUN
    const afterUnfiling = await refusedBy(() => deleteSredProject({ projectId: throwawayId,
      actor: 'alicio@example.test' }))
    const after = (await sredProjects(E)).length

    check(made === '' && renamed === '' && wrote && badStatus === 'UNKNOWN_STATUS'
      && opened === '' && itsFiled === ''
      && renameWhileFiled === 'FILED_YEAR' && statusWhileFiled === ''
      && whileFiled === 'FILED_YEAR' && stillThere
      && unfiled === '' && afterUnfiling === '' && after === before - 1,
      'S35 a project can be corrected, given a status, and put away — unless a year of it is filed',
      `${made ? `opening one REFUSED: ${made}; ` : ''}`
        + `${renamed ? `renaming it REFUSED: ${renamed}; ` : ''}`
        + `saved as ${saved?.code ?? '?'}/${saved?.status ?? '?'}/`
        + `${saved?.field_of_science ?? 'no field'}/${saved?.ended_on ?? 'no end'} from `
        + `${saved?.started_on ?? '?'}${wrote ? '' : ' — NOT what was sent'}; a status off the list `
        + `${badStatus || 'was ACCEPTED'}; opening its year ${opened || 'worked'} and filing it `
        + `${itsFiled || 'worked'}; with that year filed, renaming ${renameWhileFiled || 'WENT THROUGH'} `
        + `and setting the status ${statusWhileFiled === '' ? 'still works' : `was REFUSED: ${statusWhileFiled}`}; `
        + 'the delete '
        + `${whileFiled || 'WENT THROUGH'} and the project `
        + `${stillThere ? 'is still there' : 'IS GONE'}; un-filing `
        + `${unfiled || 'worked'} and the delete then went `
        + `${afterUnfiling === '' ? 'cleanly' : `NOT: ${afterUnfiling}`}, `
        + `${before} project(s) to ${after}`)
  }

  // S34 — AND EVERY ONE OF THOSE IS REACHABLE FROM A SCREEN. Which row's id a
  //       form carries is the whole of what "correct this row" means, and it
  //       lives in markup and nowhere else.
  {
    const render = (input: unknown) => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-sred-record.tsx', JSON.stringify(input),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html

    const rows = await timeFor(project.id)
    const two = rows.slice(0, 2)
    // Each row rendered OPEN in its turn — a row is text until its Edit is
    // pressed (2026-09-16) — with the other row beside it, shut. Scoped to the
    // ROW: a form carrying some other row's id is exactly the defect, so the
    // ids are counted inside each row rather than on the page.
    const rowIn = (html: string, attr: string, id: string) => html.split('<tr ').find((r) => r.includes(`${attr}="${id}"`)) ?? ''
    const openTime = (id: string) => rowIn(render({ what: 'time', time: two, editing: id }), 'data-time', id)
    const carries = two.length === 2 && two.every((t) => (openTime(t.id).match(new RegExp(`name="timeId" value="${t.id}"`, 'g')) ?? []).length === 2)
    const notOthers = two.every((t) => two.every((o) => o.id === t.id || !openTime(t.id).includes(o.id)))

    const evRows = (await evidenceFor(project.id)).slice(0, 2)
    const openEvidence = (id: string) => rowIn(render({ what: 'evidence', evidence: evRows, editing: id }), 'data-evidence', id)
    const evCarries = evRows.length === 2 && evRows.every((e) => (openEvidence(e.id).match(new RegExp(`name="evidenceId" value="${e.id}"`, 'g')) ?? []).length === 2)
    const evNotOthers = evRows.every((e) => evRows.every((o) => o.id === e.id || !openEvidence(e.id).includes(o.id)))

    // THE SHARED ARRAY, not a copy of it: `TIME_PASTE_FIELDS` is what the parser
    // counts against and what the box prints, so this renders the one and reads
    // the other back.
    const pasteHtml = render({ what: 'paste',
      fields: TIME_PASTE_FIELDS, note: 'and nothing goes in.' })
    const saysFormat = pasteHtml.includes(TIME_PASTE_FIELDS.join(' | '))
      && pasteHtml.includes('name="paste"')
    // And that the SCREEN hands it that array rather than a literal of its own.
    // Text, not behaviour: nothing here renders the add forms whole, so this
    // says each file still contains its hand-off and no more than that. The
    // boxes live in the add forms since 2026-09-16 (`time/new`, `evidence/new`).
    const addForm = (seg: string, file: string) => readFileSync(
      join('src', 'app', 'ledger', '[ledgerId]', 'sred', '[projectId]', seg, 'new', file), 'utf8')
    const handsShared = [
      addForm('time', 'AddTimeForm.tsx').includes('fields={TIME_PASTE_FIELDS}') ? 'time' : '',
      addForm('evidence', 'AddEvidenceForm.tsx').includes('fields={EVIDENCE_PASTE_FIELDS}') ? 'evidence' : '',
    ].filter(Boolean)

    const proj = must((await sredProjects(E)).find((x) => x.id === project.id), 'the project')
    const projHtml = render({ what: 'project', project: proj, editing: true })
    // The three columns no screen could reach until now, and the status list
    // read off the CHECK rather than typed here.
    const reaches = ['fieldOfScience', 'status', 'endedOn'].filter((n) => projHtml.includes(`name="${n}"`))
    const everyStatus = PROJECT_STATUS.every((st) => projHtml.includes(`value="${st}"`))

    check(carries && notOthers && evCarries && evNotOthers && saysFormat
      && handsShared.length === 2 && reaches.length === 3 && everyStatus,
      'S34 every correction is reachable from a screen, and each form carries its own row',
      `${two.length} hour row(s): each ${carries ? 'carries its own id twice' : 'does NOT'}, and `
        + `${notOthers ? 'names no other row' : 'NAMES ANOTHER ROW'}; `
        + `${evRows.length} paper row(s): each `
        + `${evCarries ? 'carries its own id twice' : 'does NOT'}, and `
        + `${evNotOthers ? 'names no other row' : 'NAMES ANOTHER ROW'}; the paste box `
        + `${saysFormat ? `prints “${TIME_PASTE_FIELDS.join(' | ')}” and has its box` : 'does NOT'}, `
        + `and the add forms have ${handsShared.length} of the 2 shared field lists; `
        + 'the project offers '
        + `${reaches.join(', ') || 'none'} of fieldOfScience, status, endedOn and `
        + `${everyStatus ? `all ${PROJECT_STATUS.length} statuses` : 'NOT every status'}`)
  }

  // S36 — THE RATE TABLE HAS A DOOR.
  //
  //       0068 seeded eleven rates and left no way to touch them, so adding
  //       next year's percentage meant writing SQL by hand (owner,
  //       2026-09-12). The distinction the door is built around: a rate that
  //       CHANGED is a new row — the table is dated, so last year's papers go
  //       on computing last year's figure — and editing in place is for a
  //       transcription error.
  {
    const refusedBy = async (run: () => Promise<unknown>) => {
      try { await run(); return '' } catch (e) { return e instanceof SredError ? e.code : errorChain(e) }
    }
    const before = (await sredRateRows()).length
    const good = {
      jurisdiction: 'federal', name: 'test_only_rate', value: '0.42',
      effectiveFrom: `${yr + 1}-01-01`, authority: 'A test, not a provision',
      confidence: 'unconfirmed', actor: 'alicio@example.test',
    }
    const added = await refusedBy(() => saveSredRate(good))
    const mine = (await sredRateRows()).find((r) => r.name === 'test_only_rate')
    const landed = mine?.value === '0.42' && mine?.confidence === 'unconfirmed'
      && mine?.effective_from === `${yr + 1}-01-01`

    const refusals: Array<[string, string]> = [
      ['a jurisdiction nobody prices',
       await refusedBy(() => saveSredRate({ ...good, jurisdiction: 'Mars' }))],
      ['a confidence off the list',
       await refusedBy(() => saveSredRate({ ...good, confidence: 'probably' }))],
      ['no name', await refusedBy(() => saveSredRate({ ...good, name: '  ' }))],
      // A NAME OF ITS OWN. Reusing the good row's name meant this attempt hit
      // the unique index before the door's own check, so the block written for
      // the authority rule reddened for a reason unrelated to it — and the
      // capture said so underneath its own prose
      // (independent critic, 2026-09-12).
      ['no authority',
       await refusedBy(() => saveSredRate({ ...good, name: 'test_only_rate_b', authority: '' }))],
      ['a value that is not a number',
       await refusedBy(() => saveSredRate({ ...good, value: 'about a half' }))],
      ['an end before the start',
       await refusedBy(() => saveSredRate({ ...good, name: 'test_only_rate_c',
                                            effectiveTo: `${yr}-01-01` }))],
      ['no start at all',
       await refusedBy(() => saveSredRate({ ...good, name: 'test_only_rate_d',
                                            effectiveFrom: '' }))],
      ['a delete with no row named',
       await refusedBy(() => deleteSredRate({ rateId: '', actor: 'alicio@example.test' }))],
    ]
    const wanted = ['BAD_JURISDICTION', 'BAD_CONFIDENCE', 'NO_NAME', 'NO_AUTHORITY',
                    'BAD_VALUE', 'BACKWARDS', 'NO_DATE', 'NO_ROW']
    const slipped = refusals.filter(([, got], i) => got !== wanted[i])

    // Corrected in place, then taken away again.
    const corrected = mine
      ? await refusedBy(() => saveSredRate({ ...good, rateId: mine.id, value: '0.43' }))
      : 'no row to correct'
    const now = (await sredRateRows()).find((r) => r.name === 'test_only_rate')
    const dropped = mine
      ? await refusedBy(() => deleteSredRate({ rateId: mine.id, actor: 'alicio@example.test' }))
      : 'no row to drop'
    const after = (await sredRateRows()).length

    // AND A RATE A FILED RETURN WAS WORKED OUT WITH IS NOT TOUCHED. The paper
    // reads the rates live, so editing one moves a filed year's figures and
    // DELETING one makes that year's paper throw — the record stops opening at
    // all. The rest of this module refuses both; this door refused neither
    // (independent critic, 2026-09-12).
    const used = (await sredRateRows()).find((r) => r.name === 'proxy_percent')
    const filedYear = (await claimsFor(project.id)).find((c) => c.fiscal_year_id === co.year.id)
    const filedIt = filedYear
      ? await refusedBy(() => fileClaim({ claimId: filedYear.id, filedOn: `${yr + 1}-06-30`,
                                          actor: 'alicio@example.test' }))
      : 'no year to file'
    const editUsed = used
      ? await refusedBy(() => saveSredRate({ ...good, rateId: used.id, name: used.name,
          value: used.value, effectiveFrom: used.effective_from, authority: used.authority,
          confidence: used.confidence }))
      : 'no rate in use'
    const dropUsed = used
      ? await refusedBy(() => deleteSredRate({ rateId: used.id, actor: 'alicio@example.test' }))
      : 'no rate in use'
    // …while a NEW row from a later day goes in freely, which is how a rate that
    // changed is supposed to be recorded.
    const newerRow = await refusedBy(() => saveSredRate({ ...good, name: 'proxy_percent',
      value: '0.60', effectiveFrom: `${yr + 5}-01-01`, authority: 'A later test row' }))
    const unfiled = filedYear
      ? await refusedBy(() => unfileClaim({ claimId: filedYear.id,
          reason: 'Back to a draft for the rest of the checks.', actor: 'alicio@example.test' }))
      : 'no year to un-file'
    const later = (await sredRateRows()).find((r) => r.name === 'proxy_percent' && r.value === '0.60')
    if (later) await deleteSredRate({ rateId: later.id, actor: 'alicio@example.test' })

    // And each row's forms carry that row's id, which is what editing means —
    // each row rendered open in its turn, since a rate is text until its Edit
    // is pressed (2026-09-16).
    const shown = (await sredRateRows()).slice(0, 2)
    const rateHtml = (editing: string) => (JSON.parse(execFileSync('npx', [
      'tsx', 'scripts/render-sred-record.tsx', JSON.stringify({
        what: 'rates', editing,
        rates: shown.map((r) => ({ ...r, value: String(r.value) })),
      }),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    const rowFor = (id: string) => rateHtml(id).split('<tr ').find((d) => d.includes(`data-rate="${id}"`)) ?? ''
    const carries = shown.length === 2 && shown.every((r) =>
      (rowFor(r.id).match(new RegExp(`name="rateId" value="${r.id}"`, 'g')) ?? []).length === 2)
    const notices = !rateHtml('').includes('Edits change past papers')
      && shown.every((r) => {
        const html = rowFor(r.id)
        return html.includes('Edits change past papers')
          && html.includes('deleting can make them unavailable')
          && html.includes('Filed-year rates are locked')
      })

    check(added === '' && landed && slipped.length === 0 && corrected === ''
      && now?.value === '0.43' && dropped === '' && after === before
      && filedIt === '' && editUsed === 'FILED_YEAR' && dropUsed === 'FILED_YEAR'
      && newerRow === '' && unfiled === ''
      && carries && notices,
      'S36 a rate can be put in, corrected and taken away, and each row edits itself',
      `${before} rate(s) to start; adding ${added || 'worked'} and it `
        + `${landed ? 'landed as sent' : 'did NOT land as sent'}; refusals: `
        + `${refusals.map(([w, got], i) => `${w} ${got || 'ALLOWED'}`
             + `${got === wanted[i] ? '' : ` (wanted ${wanted[i]})`}`).join(', ')}; `
        + `correcting ${corrected || 'worked'} to ${now?.value ?? 'nothing'}; `
        + `deleting ${dropped || 'worked'}, back to ${after}; with a year filed `
        + `(${filedIt || 'yes'}), a rate that year's paper is built from: editing `
        + `${editUsed || 'WENT THROUGH'}, deleting ${dropUsed || 'WENT THROUGH'}, while a new row `
        + `from a later day ${newerRow || 'went in'} and un-filing ${unfiled || 'worked'}; `
        + 'the screen '
        + `${carries ? 'gives each row its own id twice' : 'does NOT'} and `
        + `${notices ? 'shows concise consequences only when editing' : 'MISSES the editing consequences'}`)
  }

  // S38 — AND AT REST, NOT ONE BOX. The owner's words (2026-09-16): 「SRED 的
  //       页面非常凌乱，有太多空需要填了，如果这样不如做成一个表格」 and 「所有
  //       添加记录的功能都以表单形式以悬浮页面呈现」. So every list on the project
  //       and the list page renders as TEXT until a row is opened: a named field
  //       anywhere in those tables at rest is a blank sitting on the page. The
  //       same tables rendered open (S24, S34, S36) are what proves the boxes
  //       still exist once asked for; this proves they wait to be asked.
  {
    const render = (script: string, input: unknown) => (JSON.parse(execFileSync('npx', [
      'tsx', script, JSON.stringify(input),
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })) as { html: string }).html
    // A field a person could type in: named, and not hidden. The one-click doors
    // (Start a claim for this year) carry hidden ids and nothing to fill.
    const boxes = (html: string) => (html.match(/<(?:input|select|textarea)\b[^>]*>/g) ?? [])
      .filter((tag) => /\bname="/.test(tag) && !/type="hidden"/.test(tag)).length
    const time = (await timeFor(project.id)).slice(0, 3)
    const evidence = (await evidenceFor(project.id)).slice(0, 3)
    const rates = (await sredRateRows()).slice(0, 3).map((r) => ({ ...r, value: String(r.value) }))
    const proj = await sredProjects(E).then((ps) => ps.find((x) => x.id === project.id))
    const costs = (await allocatableLines(L, co.year.startDate, co.year.endDate)).slice(0, 5)
      .map((a) => ({ ...a, amount: a.amount.toString() }))
    const claims = await claimsFor(project.id)
    const claimRenders: Array<[string, string, string]> = claims[0] ? [
      ['draft', render('scripts/render-sred-record.tsx', { what: 'claim', claim: { ...claims[0], filed_on: null } }), 'Mark this year filed'],
      ['filed', render('scripts/render-sred-record.tsx', { what: 'claim', claim: { ...claims[0], filed_on: `${yr + 1}-06-30` } }), 'Un-file this year'],
    ] : []
    // The strip on a year with no claim, which is when its one-click opener
    // shows — a year of its own, so this does not depend on which years some
    // earlier check happened to open.
    const years = [{ id: '00000000-0000-4000-8000-000000002099', name: 'FY2099' },
      ...(await db.execute<{ id: string; name: string }>(raw`
        SELECT id::text, name FROM fiscal_year WHERE ledger_id = ${L}::uuid ORDER BY end_date DESC`))]
    const unclaimedYear = years[0]
    const atRest: Array<[string, number, number]> = [
      ['hours', time.length, boxes(render('scripts/render-sred-record.tsx', { what: 'time', time }))],
      ['evidence', evidence.length, boxes(render('scripts/render-sred-record.tsx', { what: 'evidence', evidence }))],
      ['rates', rates.length, boxes(render('scripts/render-sred-record.tsx', { what: 'rates', rates }))],
      ['the project', proj ? 1 : 0, proj ? boxes(render('scripts/render-sred-record.tsx', { what: 'project', project: proj })) : -1],
      ['costs', costs.length, boxes(render('scripts/render-sred-money.tsx', { lines: costs }))],
      // The year's three answers and the filing card, drafted and filed both.
      // The "rows" figure is how many of the two renders drew their cards — a
      // draft (which offers Mark filed) and the same claim filed (which offers
      // Un-file) — so a blank render counts 0 and fails as NOTHING TO RENDER
      // rather than passing as "0 boxes" (critic round 2).
      ['the three answers and filing', claimRenders.filter(([, html, words]) => html.includes('The three questions') && html.includes(words)).length === 2 ? 2 : 0,
       claimRenders.reduce((n, [, html]) => n + boxes(html), 0)],
      // The year strip on a year with no claim, where its one-click opener shows.
      ['the year strip', render('scripts/render-sred-record.tsx', { what: 'years', years, claims, yearId: unclaimedYear.id })
         .includes('Start a claim for this year') ? 1 : 0,
       boxes(render('scripts/render-sred-record.tsx', { what: 'years', years, claims, yearId: unclaimedYear.id }))],
    ]
    // And each list with ONE row opened has boxes — or a zero above would prove
    // only that the harness renders nothing. One control per list, not one for
    // all of them (critic round 1).
    const openedEach: Array<[string, number]> = [
      ['hours', time[0] ? boxes(render('scripts/render-sred-record.tsx', { what: 'time', time, editing: time[0].id })) : 0],
      ['evidence', evidence[0] ? boxes(render('scripts/render-sred-record.tsx', { what: 'evidence', evidence, editing: evidence[0].id })) : 0],
      ['rates', rates[0] ? boxes(render('scripts/render-sred-record.tsx', { what: 'rates', rates, editing: rates[0].id })) : 0],
      ['the project', proj ? boxes(render('scripts/render-sred-record.tsx', { what: 'project', project: proj, editing: true })) : 0],
      ['costs', costs[0] ? boxes(render('scripts/render-sred-money.tsx', { lines: costs, open: `${costs[0].source_kind}:${costs[0].source_id}` })) : 0],
    ]
    const shut = openedEach.filter(([, n]) => n === 0).map(([what]) => what)
    const empty = atRest.filter(([, rows]) => rows === 0).map(([what]) => what)
    const blank = atRest.filter(([, , n]) => n !== 0)
    check(empty.length === 0 && blank.length === 0 && shut.length === 0,
      'S38 every SR&ED list reads as text until a row is opened',
      `${atRest.map(([what, rows, n]) => `${what}: ${rows} row(s), ${n} box(es)`).join('; ')}; `
        + `opened: ${openedEach.map(([what, n]) => `${what} ${n}`).join(', ')}`
        + (empty.length ? `; NOTHING TO RENDER for ${empty.join(', ')}` : ''))
  }

  // S37 — THE ID BESIDE THE LEDGER. Every SR&ED door reads project, claim,
  //       time, evidence and allocation ids out of its form and judged only
  //       the ledger beside them (audit, 2026-09-13). The doors all pass
  //       through `sredAction`, which is where the one question is asked —
  //       a check cannot call a server action, so two things are read: the
  //       predicate, kind by kind, and that the action asks it of every id
  //       field an SR&ED form has.
  {
    const theirs = await createCompanyWithYear({ code: 'THEIRS', name: 'Somebody Else Ltd.', province: 'BC' }, 'alicio@example.test')
    const theirProject = await createSredProject({
      entityId: theirs.company.id, code: 'TP1', title: 'Their uncertain method', startedOn: `${yr}-02-01`, actor: 'alicio@example.test',
    })
    const wrong: string[] = []
    if (await ours('sred_project', theirProject.id, L)) wrong.push('their project reads as ours')
    if (!(await ours('sred_project', theirProject.id, theirs.ledger.id))) wrong.push('their project does not read as theirs')
    if (await ours('fiscal_year', theirs.year.id, L)) wrong.push('their year reads as ours')
    if (await ours('sred_project', project.id, theirs.ledger.id)) wrong.push('our project reads as theirs')
    if (!(await ours('sred_project', project.id, L))) wrong.push('our project does not read as ours')
    // The related ids an allocation and a time record carry — an employee, a
    // journal line — are judged too, because `allocate` and `logSredTime`
    // themselves check nothing about whose they are (independent critic).
    if (!(await ours('employee', handEmp.id, L))) wrong.push('our employee does not read as ours')
    if (await ours('employee', handEmp.id, theirs.ledger.id)) wrong.push('our employee reads as theirs')
    const [ourLine] = await db.execute<{ id: string }>(raw`
      SELECT jl.id::text FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id WHERE je.ledger_id = ${L}::uuid LIMIT 1`)
    if (!ourLine || !(await ours('journal_line', ourLine.id, L))) wrong.push('our journal line does not read as ours')
    if (ourLine && await ours('journal_line', ourLine.id, theirs.ledger.id)) wrong.push('our journal line reads as theirs')
    const [ourStub] = await db.execute<{ id: string }>(raw`
      SELECT ps.id::text FROM pay_stub ps JOIN pay_run pr ON pr.id = ps.pay_run_id WHERE pr.ledger_id = ${L}::uuid LIMIT 1`)
    if (!ourStub || !(await ours('pay_stub', ourStub.id, L))) wrong.push('our pay stub does not read as ours')
    if (ourStub && await ours('pay_stub', ourStub.id, theirs.ledger.id)) wrong.push('our pay stub reads as theirs')
    const actions = readFileSync('src/app/ledger/[ledgerId]/sred/actions.ts', 'utf8')
    const door = actions.slice(actions.indexOf('async function sredAction('), actions.indexOf('\n}\n', actions.indexOf('async function sredAction(')))
    const asks = /await refuseUnlessOurs\(SRED_OWNED/.test(door)
    const fields = ['projectId', 'claimId', 'timeId', 'evidenceId', 'allocationId', 'fiscalYearId', 'employeeId', 'categoryAccountId']
      .filter((f) => !new RegExp(`SRED_FIELDS\\.${f}\\b`).test(actions.slice(actions.indexOf('const SRED_OWNED'), actions.indexOf('async function sredAction('))))
    // The QUESTION, not the field names: a door that reads sourceId and does
    // nothing with it would satisfy a name test.
    const source = /refuseUnlessOurs\(\[\[sourceKind, sourceId\]\]/.test(door)
    check(wrong.length === 0 && asks && fields.length === 0 && source,
      "S37 another company's project, claim, time, evidence or allocation under this ledger is not ours, and every SR&ED door asks",
      (wrong.length ? wrong.join('; ') : 'the predicate tells the two companies apart both ways')
        + `; sredAction ${asks ? 'asks refuseUnlessOurs of' : 'DOES NOT ASK about'} the form's ids`
        + (fields.length ? `; not listed: ${fields.join(', ')}` : '; all seven id fields listed')
        + (source ? ', and the allocation source by its kind' : ', but NOT the allocation source'))
  }

  // S39 — THE SALARY CAP READS AN EDITION ADDED IN THE APP, COLD (0082). The
  //       YMPE the cap is five times is payroll's, and a year's tables may now
  //       be a row rather than code. The working paper is often the first thing
  //       opened after a restart, so it must read the rows itself: the
  //       project's next-year claim (S30 opened it) is refused for want of a
  //       YMPE, then — with an edition for that year on file and the process's
  //       list emptied — works to five times that edition's YMPE.
  {
    const next = yr + 1
    const [nextClaim] = await db.execute<{ id: string }>(raw`
      SELECT sc.id::text FROM sred_claim sc JOIN fiscal_year fy ON fy.id = sc.fiscal_year_id
       WHERE sc.project_id = ${project.id}::uuid AND fy.end_date = ${`${next}-12-31`}::date`)
    const paperSays = async () => {
      setAddedEditions([])
      try { await workingPaper(nextClaim.id); return 'worked' } catch (e) { return e instanceof SredError ? e.code : errorText(e) }
    }
    const without = nextClaim ? await paperSays() : 'no next-year claim'
    const july = EDITIONS[EDITIONS.length - 1]
    await db.execute(raw`
      INSERT INTO payroll_rate_edition (id, starts_on, authority, cpp_ei, federal, bc, pdoc, created_by)
      VALUES (${`${next}-01`}, ${`${next}-01-01`}::date, 'S39: the last built-in figures, a year on',
              ${JSON.stringify(july.cppEi)}::jsonb, ${JSON.stringify(july.federal)}::jsonb,
              ${JSON.stringify(july.bc)}::jsonb, '{}'::jsonb, 'alicio@example.test')`)
    const withRow = nextClaim ? await paperSays() : 'no next-year claim'
    const cap = withRow === 'worked' ? formatMoney(ympeFor(next) * 5n) : '—'
    await db.execute(raw`DELETE FROM payroll_rate_edition WHERE id = ${`${next}-01`}`)
    await loadEditions()
    check(without === 'NO_YMPE' && withRow === 'worked' && cap === formatMoney(parseMoney(july.cppEi.cpp.ympe) * 5n),
      'S39 the working paper reads a year\'s tables added in the app itself, and caps salary at five times that YMPE',
      `the ${next} claim with no ${next} tables: ${without}; with an edition added and the process cold: ${withRow}; `
        + `the cap: ${cap}`)
  }

  // S40 — A YEAR'S CLAIM OPENED BY MISTAKE IS DELETED, AND AN EVIDENCE NOTE IS
  //       CORRECTED (0084). The owner: 「所有的紀錄儘量都可以編輯刪除」. A claim
  //       filed is refused and told to un-file first; un-filed, it goes, and its
  //       project stays; the trail names the year. A note written with the
  //       evidence is changed, left alone when the form has no note box, and
  //       cleared when the box is emptied.
  {
    const A = 'alicio@example.test'
    const p = await createSredProject({ entityId: co.company.id, code: 'OOPS', title: 'Opened for the wrong year', startedOn: `${yr}-02-01`, actor: A })
    const c = await openClaim({ projectId: p.id, fiscalYearId: co.year.id, actor: A })
    await fileClaim({ claimId: c.id, filedOn: `${yr + 1}-06-30`, actor: A })
    let filedSaid = ''
    try { await deleteSredClaim({ claimId: c.id, actor: A }); filedSaid = 'DELETED' } catch (e) { filedSaid = e instanceof SredError ? `${e.code}: ${e.message}` : String(e) }
    // Guarded: with the filed-year rule gone the claim is already deleted, and
    // an unguarded un-file would kill the suite instead of turning this red.
    try { await unfileClaim({ claimId: c.id, reason: 'Opened for the wrong year; never went', actor: A }) } catch { /* said below */ }
    let gone = ''
    try { gone = (await deleteSredClaim({ claimId: c.id, actor: A })).year } catch (e) { gone = `REFUSED ${String(e)}` }
    const [left] = await db.execute<{ claims: number; projects: number }>(raw`
      SELECT (SELECT count(*)::int FROM sred_claim WHERE id = ${c.id}::uuid) AS claims,
             (SELECT count(*)::int FROM sred_project WHERE id = ${p.id}::uuid) AS projects`)
    const [trail] = await db.execute<{ n: number }>(raw`
      SELECT count(*)::int AS n FROM audit_log WHERE action = 'delete_sred_claim' AND record_id = ${c.id} AND actor = ${A}`)

    await addEvidence({ projectId: p.id, kind: 'notebook', title: 'Lab notebook 3', onDate: `${yr}-03-01`, note: 'pages 1-40', actor: A })
    const ev = (await evidenceFor(p.id))[0]
    const noteOf = async () => (await evidenceFor(p.id))[0]?.note ?? null
    await updateSredEvidence({ evidenceId: ev.id, kind: 'notebook', title: 'Lab notebook 3', onDate: `${yr}-03-01`, note: 'pages 1-44', actor: A })
    const changed = await noteOf()
    await updateSredEvidence({ evidenceId: ev.id, kind: 'notebook', title: 'Lab notebook 3', onDate: `${yr}-03-01`, actor: A })
    const kept = await noteOf()
    await updateSredEvidence({ evidenceId: ev.id, kind: 'notebook', title: 'Lab notebook 3', onDate: `${yr}-03-01`, note: '  ', actor: A })
    const cleared = await noteOf()
    check(filedSaid.startsWith('FILED') && filedSaid.includes('Un-file it first') && gone === co.year.name
          && left.claims === 0 && left.projects === 1 && trail.n === 1
          && changed === 'pages 1-44' && kept === 'pages 1-44' && cleared === null,
      "S40 a year's claim opened by mistake is deleted once unfiled, and an evidence note is corrected or cleared",
      `filed: ${filedSaid.slice(0, 70)}; unfiled: ${gone ? `deleted ${gone}` : 'nothing'} (claim ${left.claims}, project ${left.projects}, `
        + `${trail.n} trail row); note changed ${changed}, without a box ${kept}, emptied ${cleared === null ? 'cleared' : cleared}`)
  }

  // S41 — AN SR&ED ROW STILL FINDS ITS COMPANY IN THE TRAIL, now that the trail
  //       asks a register (0155). The audit trigger named sred_project,
  //       sred_rate and the other add-on tables in its own body (0086), so the
  //       framework knew SR&ED; it reads audit_scope_source instead. Two halves:
  //       the table-to-column mapping is the one 0086 wrote, table for table,
  //       plus 0158's three FX registrations, and a row written with no company still lands in one.
  {
    const old = readFileSync('db/migrations/0086_the_trail_knows_where_it_belongs.sql', 'utf8')
    const before = old.slice(old.lastIndexOf('CREATE OR REPLACE FUNCTION audit_actor_from_setting'))
    const [{ now }] = await db.execute<{ now: string }>(raw`SELECT pg_get_functiondef('audit_actor_from_setting'::regproc) AS now`)
    const register = await db.execute<{ table_name: string; scope_column: string | null; system_scope: boolean }>(raw`
      SELECT table_name, scope_column, system_scope FROM audit_scope_source`)
    const pairs = (src: string) => [...src.matchAll(/NEW\.table_name = '([a-z_]+)' THEN\s+SELECT (?:a\.)?(ledger_id|entity_id) INTO/g)]
      .map((m) => `${m[1]}:${m[2]}`)
    const system = (src: string) => (/WHEN NEW\.table_name IN \(([^)]*)\)\s*(?:OR EXISTS \([^)]*\)\s*)?THEN 'system'/.exec(src)?.[1] ?? '')
      .match(/[a-z_]+/g) ?? []
    const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
    const mapped = same([...pairs(before), 'fx_company_currency:entity_id'], [...pairs(now),
      ...register.filter((x) => x.scope_column).map((x) => `${x.table_name}:${x.scope_column}`)])
    const systemSame = same([...system(before), 'fx_currency', 'fx_rate'], [...system(now), ...register.filter((x) => x.system_scope).map((x) => x.table_name)])
    const [{ missing }] = await db.execute<{ missing: string }>(raw`
      SELECT count(*)::text AS missing FROM audit_scope_source s
       WHERE s.scope_column IS NOT NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns c
         WHERE c.table_schema = 'public' AND c.table_name = s.table_name AND c.column_name = s.scope_column)`)
    const probe = await createSredProject({
      entityId: E, code: 'P41', title: 'A probe for the trail', startedOn: `${yr}-01-05`, actor: 'alicio@example.test',
    })
    const [landed] = await db.execute<{ entity_id: string | null; scope: string }>(raw`
      INSERT INTO audit_log (actor, action, table_name, record_id, scope)
      VALUES ('check', 'scope_probe', 'sred_project', ${probe.id}, 'unresolved') RETURNING entity_id::text, scope`)
    const [rate] = await db.execute<{ entity_id: string | null; scope: string }>(raw`
      INSERT INTO audit_log (actor, action, table_name, record_id, scope)
      VALUES ('check', 'scope_probe', 'sred_rate', ${probe.id}, 'unresolved') RETURNING entity_id::text, scope`)
    check(mapped && systemSame && missing === '0' && !/sred_/.test(now)
          && landed.entity_id === E && landed.scope === 'company' && rate.scope === 'system',
      "S41 an SR&ED row still finds its company in the trail, which names no SR&ED table any more",
      `0086's mapping ${mapped ? 'kept' : 'CHANGED'}, system tables ${systemSame ? 'kept' : 'CHANGED'}, `
        + `${missing} register row(s) naming a column that is not there; the trigger ${/sred_/.test(now) ? 'still names' : 'names no'} SR&ED table; `
        + `a project row lands ${landed.scope}${landed.entity_id === E ? ' in its company' : ''}, a rate row ${rate.scope}`)
  }

  // S42 — AN ACCOUNT'S T661 LINE IS SR&ED'S TO KEEP (0156). It was a column on
  //       `account` that the chart's own forms offered, so the framework knew
  //       SR&ED. Now the tag is a row SR&ED owns, set from the SR&ED screen:
  //       no base file may name it, setting it is on the company's trail, a
  //       line that is not a T661 line is refused, and clearing it removes it.
  {
    const knows = sourceFiles('src').filter((f) => BASE.has(fileModule(f))
      && /sredCategory|sred_category/.test(readFileSync(f, 'utf8')))
    const A = 'alicio@example.test'
    await setSredAccountCategory({ accountId: id['5300'], category: 'capital', actor: A })
    const tagged = (await sredAccountCategories(E)).find((a) => a.id === id['5300'])?.category ?? null
    const [trail] = await db.execute<{ n: string; entity_id: string | null; scope: string | null }>(raw`
      SELECT count(*)::text AS n, max(entity_id::text) AS entity_id, max(scope) AS scope FROM audit_log
       WHERE action = 'set_sred_category' AND record_id = ${id['5300']} AND after->>'category' = 'capital'`)
    const refused = await setSredAccountCategory({ accountId: id['5300'], category: 'salary', actor: A })
      .then(() => 'ACCEPTED', (e) => (e instanceof SredError ? e.code : String(e)))
    await setSredAccountCategory({ accountId: id['5300'], category: null, actor: A })
    const [{ left }] = await db.execute<{ left: string }>(raw`
      SELECT count(*)::text AS left FROM sred_account_category WHERE account_id = ${id['5300']}::uuid`)
    check(knows.length === 0 && tagged === 'capital' && trail.n === '1' && trail.entity_id === E
          && trail.scope === 'company' && refused === 'BAD_CATEGORY' && left === '0',
      "S42 an account's T661 line is SR&ED's own row: no base file names it, and setting it is on the company's trail",
      `${knows.length ? `base files naming it: ${knows.join(', ')}` : 'no base file names it'}; tagged ${tagged ?? 'nothing'}; `
        + `${trail.n} trail row (${trail.scope ?? 'none'}); salary ${refused}; cleared leaves ${left}`)
  }

  console.log(r.summary())
  await conn.end()
  process.exit(r.failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await conn.end(); process.exit(1) })
