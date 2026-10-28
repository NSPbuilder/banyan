import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { actingAs } from './acting'
import { auditRow } from './audit-row'
import { PayrollError, cppEiForYear } from './payroll/rates'
import { loadEditions } from './payroll/editions'
import { formatMoney, parseMoney } from './money'
import {
  EVIDENCE_KINDS, LINE_CATEGORIES, PROJECT_STATUS, bonusOutOfBase, hoursProblem, nothingOnRefusal,
  parseEvidencePaste, parseTimePaste,
  type Allocatable, type EvidenceRow, type PaperLine, type PasteRefusal, type SredCategory,
  type SredClaim, type SredMethod, type SredProject, type SredTimeRow, type WorkingPaper,
} from './sred-kinds'

/**
 * SR&ED — the work that was not certain to work, and what it cost.
 *
 * WHAT THIS PRODUCES IS A WORKING PAPER, NOT A RETURN. It arranges the
 * evidence, records who decided that a given cost belongs to a given project
 * and why, and computes what follows from those decisions under both overhead
 * methods. The T661 is still filled in by a person, from this. That is not
 * caution for its own sake: CRA examines the attribution and the evidence, and
 * a screen that printed 35% of something would invite nobody to check it.
 *
 * NOTHING HERE IS STORED AS AN AMOUNT. Every figure is read from `pay_stub`,
 * `journal_line` and `sred_rate` when it is asked for, so a claim cannot
 * disagree with the books (0068, and the derived-over-stored rule).
 *
 * EVERY RATE HAS A PROVISION AND A CONFIDENCE. The ones marked `unconfirmed`
 * are printed on the working paper as a list to check before filing — see
 * `sredRates`.
 */

export class SredError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SredError'
  }
}

/**
 * The vocabulary and the row shapes live in `sred-kinds.ts`, which is pure:
 * the project screen is a client component and cannot import this file. They
 * are re-exported here so a server caller has one place to look.
 */
export * from './sred-kinds'

// ------------------------------------------------------------------ rates --

export type SredRate = {
  jurisdiction: string; name: string; value: string
  effective_from: string; authority: string; confidence: string; note: string | null
}

/** Every rate in force on a day, with where it comes from. */
export async function sredRates(onDate: string): Promise<SredRate[]> {
  return db.execute<SredRate>(sql`
    SELECT DISTINCT ON (jurisdiction, name)
           jurisdiction, name, value::text, effective_from::text, authority, confidence, note
      FROM sred_rate
     WHERE effective_from <= ${onDate}::date
       AND (effective_to IS NULL OR effective_to >= ${onDate}::date)
     ORDER BY jurisdiction, name, effective_from DESC`)
}

/** Every rate row on file, in force or not — what the editing screen shows. */
export type SredRateRow = SredRate & { id: string; effective_to: string | null }

export async function sredRateRows(): Promise<SredRateRow[]> {
  return db.execute<SredRateRow>(sql`
    SELECT id::text, jurisdiction, name, value::text, effective_from::text,
           effective_to::text, authority, confidence, note
      FROM sred_rate ORDER BY jurisdiction, name, effective_from DESC`)
}

const JURISDICTIONS = ['federal', 'BC'] as const
const CONFIDENCE = ['confirmed', 'unconfirmed'] as const

/**
 * Putting a rate in, or correcting one.
 *
 * A RATE THAT CHANGES IS A NEW ROW, NOT AN EDIT. The table is dated — every
 * row carries the day it takes effect — so adding CRA's new percentage beside
 * the old one leaves last year's working papers computing on last year's
 * figure, which is what they must do. Editing a row in place is for a
 * transcription error: it rewrites history, deliberately, because a number
 * that was never right has no history worth keeping.
 *
 * 0068 put these in by migration and left no door at all, so until now adding
 * next year's rate meant writing SQL by hand (owner, 2026-09-12).
 */
/**
 * A rate a filed return was worked out with, being changed or taken away.
 *
 * `workingPaper` reads the rates LIVE, at the year end (`sredRates(year_end)`),
 * so a filed claim's figures are not a snapshot — edit the row and they move,
 * and DELETE it and `rateOf` throws, which makes that year's paper unopenable.
 * Both are the act this module already refuses everywhere else: 0068's own rule
 * is that what a return rested on is not edited or deleted, and the way out is
 * to un-file and say why. The first version of this door refused neither, and
 * the packet that asked about it mentioned only the edit
 * (independent critic, 2026-09-12).
 *
 * ADDING A ROW IS NOT THIS. A new row with a later `effective_from` leaves every
 * past year end on the far side of it, which is the whole point of a dated
 * table — so a rate that changed goes in freely.
 */
async function refuseIfAFiledYearUsedIt(
  tx: Parameters<Parameters<typeof actingAs>[1]>[0], rateId: string,
) {
  const [hit] = await tx.execute<{ filed_on: string; year_name: string; name: string }>(sql`
    SELECT c.filed_on::text, y.name AS year_name, r.name
      FROM sred_rate r
      JOIN sred_claim c ON c.filed_on IS NOT NULL
      JOIN fiscal_year y ON y.id = c.fiscal_year_id
     WHERE r.id = ${rateId}::uuid
       AND y.end_date >= r.effective_from
       AND (r.effective_to IS NULL OR y.end_date <= r.effective_to)
     LIMIT 1`)
  if (hit) {
    throw new SredError('FILED_YEAR',
      `${hit.year_name} was filed on ${hit.filed_on} and its working paper is built from `
      + `"${hit.name}" as it stands. Un-file that year first, and say why — or, if the rate `
      + 'itself has changed, add a new row from the day it changed and leave this one alone.')
  }
}

export async function saveSredRate(input: {
  rateId?: string
  jurisdiction: string; name: string; value: string
  effectiveFrom: string; effectiveTo?: string
  authority: string; confidence: string; note?: string; actor: string
}): Promise<void> {
  if (!(JURISDICTIONS as readonly string[]).includes(input.jurisdiction)) {
    throw new SredError('BAD_JURISDICTION',
      `"${input.jurisdiction}" is not a jurisdiction this system prices.`)
  }
  if (!(CONFIDENCE as readonly string[]).includes(input.confidence)) {
    throw new SredError('BAD_CONFIDENCE',
      `"${input.confidence}" is not one of: ${CONFIDENCE.join(', ')}.`)
  }
  if (!input.name.trim()) throw new SredError('NO_NAME', 'A rate needs the name the paper reads it by.')
  if (!input.authority.trim()) {
    throw new SredError('NO_AUTHORITY',
      'Say where this comes from. A rate with no authority is a rate somebody remembered.')
  }
  if (!/^-?\d+(\.\d+)?$/.test(input.value.trim())) {
    throw new SredError('BAD_VALUE', `"${input.value}" is not a number.`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) {
    throw new SredError('NO_DATE',
      `"${input.effectiveFrom}" is not a day this rate could start on.`)
  }
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw new SredError('BACKWARDS',
      `${input.effectiveTo} is before ${input.effectiveFrom}.`)
  }
  await actingAs(input.actor, async (tx) => {
    if (input.rateId) await refuseIfAFiledYearUsedIt(tx, input.rateId)
    return (input.rateId
    ? tx.execute(sql`
        UPDATE sred_rate
           SET jurisdiction = ${input.jurisdiction}, name = ${input.name.trim()},
               value = ${input.value.trim()}::numeric,
               effective_from = ${input.effectiveFrom}::date,
               effective_to = ${input.effectiveTo || null}::date,
               authority = ${input.authority.trim()}, confidence = ${input.confidence},
               note = ${input.note?.trim() || null}
         WHERE id = ${input.rateId}::uuid`)
    : tx.execute(sql`
        INSERT INTO sred_rate (jurisdiction, name, value, effective_from, effective_to,
                               authority, confidence, note)
        VALUES (${input.jurisdiction}, ${input.name.trim()}, ${input.value.trim()}::numeric,
                ${input.effectiveFrom}::date, ${input.effectiveTo || null}::date,
                ${input.authority.trim()}, ${input.confidence}, ${input.note?.trim() || null})`))
  })
}

export async function deleteSredRate(input: { rateId: string; actor: string }): Promise<void> {
  if (!input.rateId) throw new SredError('NO_ROW', 'Which rate?')
  await actingAs(input.actor, async (tx) => {
    await refuseIfAFiledYearUsedIt(tx, input.rateId)
    await tx.execute(sql`DELETE FROM sred_rate WHERE id = ${input.rateId}::uuid`)
  })
}

const rateOf = (rates: SredRate[], jurisdiction: string, name: string): number => {
  const r = rates.find((x) => x.jurisdiction === jurisdiction && x.name === name)
  if (!r) throw new SredError('NO_RATE', `No ${jurisdiction} ${name} is on file for that date.`)
  return Number(r.value)
}

/**
 * The YMPE, read from the SAME table payroll computes with.
 *
 * The specified-employee cap is five times it. A second copy of the figure
 * here would be a second thing to update each January, and the year they
 * disagreed the claim and the T4s would disagree with each other.
 */
export function ympeFor(year: number): bigint {
  try {
    return parseMoney(cppEiForYear(year).cpp.ympe)
  } catch (e) {
    // Said in this module's own words, and with the payroll message inside it
    // so the reader is told where the tables live rather than only that they
    // are missing.
    throw new SredError('NO_YMPE',
      `No YMPE on file for ${year}. ${e instanceof PayrollError ? e.message : String(e)}`)
  }
}

// --------------------------------------------------------------- projects --

export async function sredProjects(entityId: string): Promise<SredProject[]> {
  return db.execute<SredProject>(sql`
    SELECT id::text, entity_id::text, code, title, field_of_science,
           started_on::text, ended_on::text, status
      FROM sred_project WHERE entity_id = ${entityId}::uuid
     ORDER BY started_on DESC, code`)
}

export async function createSredProject(input: {
  entityId: string; code: string; title: string; startedOn: string
  fieldOfScience?: string; actor: string
}): Promise<{ id: string }> {
  if (!input.code.trim()) throw new SredError('NO_CODE', 'A project needs a short code.')
  if (!input.title.trim()) throw new SredError('NO_TITLE', 'A project needs a title.')
  return actingAs(input.actor, async (tx) => {
    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO sred_project (entity_id, code, title, field_of_science, started_on, created_by)
      VALUES (${input.entityId}::uuid, ${input.code.trim()}, ${input.title.trim()},
              ${input.fieldOfScience ?? null}, ${input.startedOn}::date, ${input.actor})
      RETURNING id::text`)
    return { id: row.id }
  })
}

/**
 * CORRECTING THE RECORD, and the rule the three doors below share.
 *
 * `sred_project`, `sred_time` and `sred_evidence` had an INSERT and nothing
 * else, so a name keyed wrong stayed keyed wrong. Survivable while every row
 * went in one at a time; not survivable the moment a batch arrives, which is
 * what the intake list was written to produce (owner, 2026-09-12).
 *
 * WHAT FILING FREEZES IS WIDER HERE THAN IT IS FOR MONEY. Adding time or
 * evidence to a filed year stays open on purpose — the project record goes on
 * being kept, which is what `S21` holds. Editing and DELETING are a different
 * act: they change what a return that has already gone rested on. So they are
 * refused inside a filed year, and the way out is the one that already exists —
 * un-file that year, with a reason.
 */
async function refuseIfInFiledYear(
  tx: Parameters<Parameters<typeof actingAs>[1]>[0], projectId: string, onDate: string,
) {
  const [hit] = await tx.execute<{ filed_on: string; year_name: string }>(sql`
    SELECT c.filed_on::text, y.name AS year_name
      FROM sred_claim c JOIN fiscal_year y ON y.id = c.fiscal_year_id
     WHERE c.filed_on IS NOT NULL AND c.project_id = ${projectId}::uuid
       AND ${onDate}::date BETWEEN y.start_date AND y.end_date
     LIMIT 1`)
  if (hit) {
    throw new SredError('FILED_YEAR',
      `${hit.year_name} was filed on ${hit.filed_on}, and this is part of what it rested on. `
      + 'Un-file that year first, and say why.')
  }
}

/**
 * And the project's own fence, which is NOT the one the rows have.
 *
 * A project is not dated to a year, so "is this inside a filed year" does not
 * ask anything about it. What is true instead: T661 carries the project's TITLE,
 * its identifier and its field of science, so once any year of it has gone,
 * those are what a return said. Its status and the day it ended are not on the
 * return and go on being kept — a project concludes after the first year is
 * filed and saying so is the point of the column.
 *
 * The first version of this door had no fence at all while the comment above it,
 * two design docs and the intake spec handed to another agent all said edits
 * were refused inside a filed year (independent critic, 2026-09-12).
 */
const ON_THE_RETURN = ['code', 'title', 'field of science', 'start date'] as const

export async function updateSredProject(input: {
  projectId: string; code: string; title: string; startedOn: string
  fieldOfScience?: string; status: string; endedOn?: string; actor: string
}): Promise<void> {
  if (!input.code.trim()) throw new SredError('NO_CODE', 'A project needs a short code.')
  if (!input.title.trim()) throw new SredError('NO_TITLE', 'A project needs a title.')
  if (!(PROJECT_STATUS as readonly string[]).includes(input.status)) {
    throw new SredError('UNKNOWN_STATUS', `"${input.status}" is not a status a project can be in.`)
  }
  await actingAs(input.actor, async (tx) => {
    const [filedYear] = await tx.execute<{ filed_on: string; year_name: string }>(sql`
      SELECT c.filed_on::text, y.name AS year_name
        FROM sred_claim c JOIN fiscal_year y ON y.id = c.fiscal_year_id
       WHERE c.filed_on IS NOT NULL AND c.project_id = ${input.projectId}::uuid
       LIMIT 1`)
    if (filedYear) {
      const [was] = await tx.execute<{
        code: string; title: string; field_of_science: string | null; started_on: string
      }>(sql`
        SELECT code, title, field_of_science, started_on::text
          FROM sred_project WHERE id = ${input.projectId}::uuid`)
      const now = [input.code.trim(), input.title.trim(),
                   input.fieldOfScience?.trim() || null, input.startedOn]
      const before = was
        ? [was.code, was.title, was.field_of_science, was.started_on]
        : now
      const moved = ON_THE_RETURN.filter((_, i) => now[i] !== before[i])
      if (moved.length > 0) {
        throw new SredError('FILED_YEAR',
          `${filedYear.year_name} was filed on ${filedYear.filed_on}, and the ${moved.join(', ')} of this `
          + 'project is what that return said. Un-file that year first, and say why. '
          + 'The status and the end date are not on the return and can still be set.')
      }
    }
    await tx.execute(sql`
    UPDATE sred_project
       SET code = ${input.code.trim()}, title = ${input.title.trim()},
           started_on = ${input.startedOn}::date,
           field_of_science = ${input.fieldOfScience?.trim() || null},
           status = ${input.status},
           ended_on = ${input.endedOn || null}::date
     WHERE id = ${input.projectId}::uuid`)
  })
}

/**
 * And putting one away. The claims, time and evidence go with it — 0068 says
 * ON DELETE CASCADE — so this is refused outright once any year of it has been
 * filed, rather than left to a foreign key to half-stop.
 */
export async function deleteSredProject(input: { projectId: string; actor: string }): Promise<void> {
  await actingAs(input.actor, async (tx) => {
    const [filed] = await tx.execute<{ filed_on: string; year_name: string }>(sql`
      SELECT c.filed_on::text, y.name AS year_name
        FROM sred_claim c JOIN fiscal_year y ON y.id = c.fiscal_year_id
       WHERE c.project_id = ${input.projectId}::uuid AND c.filed_on IS NOT NULL
       LIMIT 1`)
    if (filed) {
      throw new SredError('FILED_YEAR',
        `${filed.year_name} was filed on ${filed.filed_on}. A project a return has gone on `
        + 'cannot be deleted — un-file that year first, and say why.')
    }
    await tx.execute(sql`DELETE FROM sred_project WHERE id = ${input.projectId}::uuid`)
  })
}

// ----------------------------------------------------------------- claims --

export async function claimsFor(projectId: string): Promise<SredClaim[]> {
  return db.execute<SredClaim>(sql`
    SELECT c.id::text, c.project_id::text, c.fiscal_year_id::text, c.method,
           c.uncertainty_text, c.work_done_text, c.advancement_text,
           c.assistance_answered_on::text, c.assistance_note, c.filed_on::text,
           y.name AS year_name, y.start_date::text AS year_start, y.end_date::text AS year_end
      FROM sred_claim c JOIN fiscal_year y ON y.id = c.fiscal_year_id
     WHERE c.project_id = ${projectId}::uuid
     ORDER BY y.end_date DESC`)
}

export async function openClaim(input: {
  projectId: string; fiscalYearId: string; actor: string
}): Promise<{ id: string }> {
  return actingAs(input.actor, async (tx) => {
    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO sred_claim (project_id, fiscal_year_id, created_by)
      VALUES (${input.projectId}::uuid, ${input.fiscalYearId}::uuid, ${input.actor})
      ON CONFLICT (project_id, fiscal_year_id) DO UPDATE SET method = sred_claim.method
      RETURNING id::text`)
    return { id: row.id }
  })
}

export async function saveClaim(input: {
  claimId: string; method: SredMethod
  uncertainty?: string; workDone?: string; advancement?: string
  assistanceNote?: string; assistanceAnswered?: boolean
  actor: string
}): Promise<void> {
  await actingAs(input.actor, async (tx) => {
    const [already] = await tx.execute<{ filed_on: string | null }>(sql`
      SELECT filed_on::text FROM sred_claim WHERE id = ${input.claimId}::uuid`)
    if (!already) throw new SredError('NO_CLAIM', 'That claim is not on file.')
    // The method is chosen each year and is irrevocable once the year is
    // filed. Before that it is a decision, and this system lets a decision be
    // changed; after, it is a fact about a return that has gone.
    if (already.filed_on) {
      throw new SredError('FILED',
        `That year was filed on ${already.filed_on}. A filed claim is a record, not a draft.`)
    }
    await tx.execute(sql`
      UPDATE sred_claim SET
        method = ${input.method},
        uncertainty_text = ${input.uncertainty ?? null},
        work_done_text = ${input.workDone ?? null},
        advancement_text = ${input.advancement ?? null},
        assistance_note = ${input.assistanceNote ?? null},
        assistance_answered_on = ${input.assistanceAnswered ? sql`CURRENT_DATE` : sql`NULL`}
       WHERE id = ${input.claimId}::uuid`)
  })
}

/**
 * Mark a year filed, and take that back.
 *
 * `filed_on` is the switch every other refusal in this module hangs off, and
 * until now nothing could set it: the column existed, `saveClaim` refused a
 * filed year, and no door in the application could ever produce one.
 *
 * TAKING IT BACK NEEDS A REASON, the way reopening a closed period does
 * (`reopenPeriod`, 0024). Filing is a record of something that happened in the
 * world — a return went to CRA on a date — so un-filing is either a correction
 * of a fact or a lie about one, and the difference is exactly what the reason
 * sentence records. Without the door a mistyped date would lock a year for
 * good; with an unconditional one, "filed" would mean nothing.
 */
export async function fileClaim(input: {
  claimId: string; filedOn: string; actor: string
}): Promise<void> {
  if (!input.filedOn) {
    throw new SredError('NO_DATE', 'Say the date the return went. It is what the 18 months are counted to.')
  }
  await actingAs(input.actor, async (tx) => {
    const [claim] = await tx.execute<{ filed_on: string | null }>(sql`
      SELECT filed_on::text FROM sred_claim WHERE id = ${input.claimId}::uuid FOR UPDATE`)
    if (!claim) throw new SredError('NO_CLAIM', 'That claim is not on file.')
    if (claim.filed_on) {
      throw new SredError('ALREADY_FILED', `That year was already marked filed on ${claim.filed_on}.`)
    }
    await tx.execute(sql`
      UPDATE sred_claim SET filed_on = ${input.filedOn}::date, filed_by = ${input.actor},
             filed_at = now()
       WHERE id = ${input.claimId}::uuid`)
  })
}

export async function unfileClaim(input: {
  claimId: string; reason: string; actor: string
}): Promise<void> {
  if (!input.reason.trim()) {
    throw new SredError('NO_REASON',
      'Un-filing says a return that this system recorded as gone did not go, or went on '
      + 'another day. Say which.')
  }
  await actingAs(input.actor, async (tx) => {
    const [claim] = await tx.execute<{ filed_on: string | null }>(sql`
      SELECT filed_on::text FROM sred_claim WHERE id = ${input.claimId}::uuid FOR UPDATE`)
    if (!claim) throw new SredError('NO_CLAIM', 'That claim is not on file.')
    if (!claim.filed_on) throw new SredError('NOT_FILED', 'That year is not marked filed.')
    await tx.execute(sql`
      UPDATE sred_claim SET filed_on = NULL, filed_by = NULL, filed_at = NULL
       WHERE id = ${input.claimId}::uuid`)
    // The trigger records the change; the REASON exists only here, which is the
    // whole point of asking for it.
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, after, context)
      VALUES (${input.actor}, 'unfile_sred_claim', 'sred_claim', ${input.claimId},
              ${JSON.stringify({ filedOn: claim.filed_on })}::jsonb,
              ${JSON.stringify({ filedOn: null })}::jsonb,
              ${JSON.stringify({ reason: input.reason.trim() })}::jsonb)`)
  })
}

/**
 * Delete a year's claim opened by mistake — for the wrong year, or twice
 * started (0084). Its narratives and allocations go with it; the project, its
 * hours and its evidence stay, because those belong to the project. A filed
 * year is a record, not a draft: un-file it first, with the reason.
 */
export async function deleteSredClaim(input: { claimId: string; actor: string }): Promise<{ year: string }> {
  return actingAs(input.actor, async (tx) => {
    const [claim] = await tx.execute<{ filed_on: string | null; year: string }>(sql`
      SELECT c.filed_on::text, fy.name AS year FROM sred_claim c JOIN fiscal_year fy ON fy.id = c.fiscal_year_id
       WHERE c.id = ${input.claimId}::uuid FOR UPDATE OF c`)
    if (!claim) throw new SredError('NO_CLAIM', 'That claim is not on file.')
    if (claim.filed_on !== null) {
      throw new SredError('FILED',
        `${claim.year} was filed on ${claim.filed_on}, so its claim is a record. Un-file it first, and say why.`)
    }
    await tx.execute(sql`DELETE FROM sred_claim WHERE id = ${input.claimId}::uuid`)
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before)
      VALUES (${input.actor}, 'delete_sred_claim', 'sred_claim', ${input.claimId},
              ${JSON.stringify({ year: claim.year })}::jsonb)`)
    return { year: claim.year }
  })
}

// ------------------------------------------------------------------- time --

export async function timeFor(projectId: string): Promise<SredTimeRow[]> {
  const rows = await db.execute<Omit<SredTimeRow, 'lag_days'> & { lag: string }>(sql`
    SELECT t.id::text, t.on_date::text, t.hours::text, t.activity,
           t.employee_id::text, p.name AS who, t.created_at::text,
           (t.created_at::date - t.on_date)::text AS lag
      FROM sred_time t
      JOIN payroll_employee e ON e.id = t.employee_id
      JOIN party p ON p.id = e.party_id
     WHERE t.project_id = ${projectId}::uuid
     ORDER BY t.on_date DESC, t.created_at DESC`)
  return rows.map((r) => ({ ...r, lag_days: Number(r.lag) }))
}

export async function logSredTime(input: {
  projectId: string; employeeId: string; onDate: string; hours: string
  activity: string; actor: string
}): Promise<void> {
  if (!input.activity.trim()) {
    throw new SredError('NO_ACTIVITY',
      'Say what was done. "SR&ED" is not a record of anything; the sentence is the evidence.')
  }
  await actingAs(input.actor, (tx) => tx.execute(sql`
    INSERT INTO sred_time (project_id, employee_id, on_date, hours, activity, created_by)
    VALUES (${input.projectId}::uuid, ${input.employeeId}::uuid, ${input.onDate}::date,
            ${input.hours}::numeric, ${input.activity.trim()}, ${input.actor})`))
}

export async function updateSredTime(input: {
  timeId: string; onDate: string; hours: string; activity: string; actor: string
}): Promise<void> {
  const activity = input.activity.trim()
  if (activity === '') {
    throw new SredError('NO_ACTIVITY',
      'Say what was done. "SR&ED" is not a record of anything; the sentence is the evidence.')
  }
  // The same rule the paste door applies, from the same place. Sending 25 at
  // the column instead produces a constraint error where a sentence belonged.
  const badHours = hoursProblem(input.hours)
  if (badHours) throw new SredError('BAD_HOURS', `${badHours}.`)
  await actingAs(input.actor, async (tx) => {
    const [row] = await tx.execute<{ project_id: string; on_date: string }>(sql`
      SELECT project_id::text, on_date::text FROM sred_time WHERE id = ${input.timeId}::uuid`)
    if (!row) throw new SredError('NO_ROW', 'That time record is not on file.')
    // BOTH dates: the year it sits in now, and the year it is being moved to.
    // Checking only one of them lets an hour be carried out of a filed year, or
    // into one, by the door that was supposed to stop exactly that.
    await refuseIfInFiledYear(tx, row.project_id, row.on_date) // where the hour is
    await refuseIfInFiledYear(tx, row.project_id, input.onDate) // where the hour is going
    await tx.execute(sql`
      UPDATE sred_time SET on_date = ${input.onDate}::date, hours = ${input.hours}::numeric,
             activity = ${activity}
       WHERE id = ${input.timeId}::uuid`)
  })
}

export async function deleteSredTime(input: { timeId: string; actor: string }): Promise<void> {
  await actingAs(input.actor, async (tx) => {
    const [row] = await tx.execute<{ project_id: string; on_date: string }>(sql`
      SELECT project_id::text, on_date::text FROM sred_time WHERE id = ${input.timeId}::uuid`)
    if (!row) throw new SredError('NO_ROW', 'That time record is not on file.')
    await refuseIfInFiledYear(tx, row.project_id, row.on_date)
    await tx.execute(sql`DELETE FROM sred_time WHERE id = ${input.timeId}::uuid`)
  })
}

/**
 * A batch of hours, pasted in the shape the intake list asks the other agent
 * for. `parseTimePaste` in sred-kinds.ts does the reading; this door does the
 * two things a parser cannot: turn a name into an employee, and notice a row
 * that is already on file.
 *
 * ALL OR NOTHING. One bad line and nothing goes in, which is not politeness —
 * a partial insert leaves the person re-pasting a batch whose good half is
 * already there, and this system has no way to tell a genuine repeat of a day's
 * work from a double paste. Fix the lines it names and paste the whole thing
 * again.
 */
export async function logSredTimeBatch(input: {
  projectId: string; entityId: string; text: string; actor: string
}): Promise<{ added: number; refused: PasteRefusal[] }> {
  const parsed = parseTimePaste(input.text)
  const refused = [...parsed.refused]
  const people = await db.execute<{ id: string; name: string }>(sql`
    SELECT e.id::text, p.name FROM payroll_employee e JOIN party p ON p.id = e.party_id
     WHERE e.entity_id = ${input.entityId}::uuid AND e.is_active`)
  const byName = new Map(people.map((r) => [r.name.toLowerCase(), r.id]))
  const already = await db.execute<{ key: string }>(sql`
    SELECT (employee_id::text || '|' || on_date::text || '|' || activity) AS key
      FROM sred_time WHERE project_id = ${input.projectId}::uuid`)
  const onFile = new Set(already.map((r) => r.key))

  const ready: Array<{ employeeId: string; onDate: string; hours: string; activity: string }> = []
  for (const r of parsed.rows) {
    const text = `${r.who} | ${r.onDate} | ${r.hours} | ${r.activity}`
    const employeeId = byName.get(r.who.toLowerCase())
    if (!employeeId) {
      refused.push({ line: r.line, text, why: `no active employee called "${r.who}"` })
    } else if (onFile.has(`${employeeId}|${r.onDate}|${r.activity}`)) {
      refused.push({ line: r.line, text, why: 'already on file, to the word' })
    } else {
      // ADDED AS IT IS ACCEPTED, so the batch is deduped against ITSELF too. It
      // was checked against the table alone, and two identical lines in one
      // paste both went in — which is the case this rule exists for
      // (independent critic, 2026-09-12).
      onFile.add(`${employeeId}|${r.onDate}|${r.activity}`)
      ready.push({ employeeId, onDate: r.onDate, hours: r.hours, activity: r.activity })
    }
  }
  if (nothingOnRefusal(refused)) return { added: 0, refused }

  await actingAs(input.actor, async (tx) => {
    for (const r of ready) {
      await tx.execute(sql`
        INSERT INTO sred_time (project_id, employee_id, on_date, hours, activity, created_by)
        VALUES (${input.projectId}::uuid, ${r.employeeId}::uuid, ${r.onDate}::date,
                ${r.hours}::numeric, ${r.activity}, ${input.actor})`)
    }
  })
  return { added: ready.length, refused }
}

/**
 * What share of a person's hours in a span went to this project.
 *
 * The honest basis for a salary allocation: the percentage is worked out from
 * what was written down at the time rather than remembered at year end, and
 * the working paper says which it was.
 */
export async function timeShare(input: {
  projectId: string; employeeId: string; from: string; to: string
}): Promise<{ onProject: number; allProjects: number; percent: number | null }> {
  const [row] = await db.execute<{ mine: string; all: string }>(sql`
    SELECT COALESCE(SUM(hours) FILTER (WHERE project_id = ${input.projectId}::uuid), 0)::text AS mine,
           COALESCE(SUM(hours), 0)::text AS all
      FROM sred_time
     WHERE employee_id = ${input.employeeId}::uuid
       AND on_date BETWEEN ${input.from}::date AND ${input.to}::date`)
  const mine = Number(row.mine)
  const all = Number(row.all)
  return {
    onProject: mine,
    allProjects: all,
    percent: all > 0 ? Math.round((mine / all) * 10000) / 100 : null,
  }
}

/**
 * A filed year's MONEY is fixed; its project record is not.
 *
 * WHERE THE LINE FALLS, and why it is not "nothing can change". The
 * allocations are what produce every figure on the return that went to CRA, so
 * moving one after filing makes the working paper silently stop agreeing with
 * the return — the books-disagree-with-the-return problem, one layer in. Time
 * records and evidence are NOT claim-scoped: they belong to the project and
 * span every year of it, and a document found in March that supports work done
 * two years ago is a thing a person should still be able to file away. Freezing
 * those would punish the one habit this module exists to encourage.
 *
 * The line exists because a sentence on the screen said "nothing about the
 * claim can be changed afterwards" while only `saveClaim` refused anything
 * (independent critic, 2026-09-10). Either the sentence was wrong or the code
 * was; the allocations are money, so it was the code.
 */
async function refuseIfFiled(tx: Parameters<Parameters<typeof actingAs>[1]>[0], claimId: string) {
  const [claim] = await tx.execute<{ filed_on: string | null }>(sql`
    SELECT filed_on::text FROM sred_claim WHERE id = ${claimId}::uuid`)
  if (claim?.filed_on) {
    throw new SredError('FILED',
      `That year was filed on ${claim.filed_on}. What it claimed is a record now — `
      + 'un-file it first, and say why.')
  }
}

// ------------------------------------------------------------ allocations --

/** The pay stubs of a year, with what is already claimed against each. */
export async function allocatableSalary(ledgerId: string, from: string, to: string): Promise<Allocatable[]> {
  const rows = await db.execute<{
    id: string; on_date: string; who: string; gross: bigint
    is_specified: boolean; claimed: string
  }>(sql`
    SELECT ps.id::text, pr.pay_date::text AS on_date, p.name AS who, ps.gross,
           e.is_specified,
           COALESCE((SELECT SUM(a.percent) FROM sred_allocation a
                      WHERE a.source_kind = 'pay_stub' AND a.source_id = ps.id), 0)::text AS claimed
      FROM pay_stub ps
      JOIN pay_run pr ON pr.id = ps.pay_run_id
      JOIN journal_entry je ON je.id = pr.entry_id
      JOIN payroll_employee e ON e.id = ps.employee_id
      JOIN party p ON p.id = e.party_id
     WHERE pr.ledger_id = ${ledgerId}::uuid AND je.status = 'posted'
       AND pr.pay_date BETWEEN ${from}::date AND ${to}::date
     ORDER BY pr.pay_date, p.name`)
  return rows.map((r) => ({
    source_kind: 'pay_stub' as const,
    source_id: r.id,
    on_date: r.on_date,
    what: r.who,
    amount: r.gross,
    claimed_percent: Number(r.claimed),
    is_specified: r.is_specified,
  }))
}

/** The posted journal lines of a year that a claim could reach. */
export async function allocatableLines(ledgerId: string, from: string, to: string): Promise<Allocatable[]> {
  const rows = await db.execute<{
    id: string; on_date: string; what: string; amount: bigint
    party: string | null; arms_length: boolean | null; claimed: string
    sred_category: string | null
  }>(sql`
    SELECT jl.id::text, je.entry_date::text AS on_date, c.category AS sred_category,
           a.code || ' — ' || a.name ||
             CASE WHEN jl.description IS NULL THEN '' ELSE ' · ' || jl.description END AS what,
           jl.amount, p.name AS party, p.arms_length,
           COALESCE((SELECT SUM(x.percent) FROM sred_allocation x
                      WHERE x.source_kind = 'journal_line' AND x.source_id = jl.id), 0)::text AS claimed
      FROM journal_line jl
      JOIN journal_entry je ON je.id = jl.entry_id
      JOIN account a ON a.id = jl.account_id
      LEFT JOIN sred_account_category c ON c.account_id = a.id
      LEFT JOIN party p ON p.id = jl.party_id
     WHERE je.ledger_id = ${ledgerId}::uuid AND je.status = 'posted'
       AND je.entry_date BETWEEN ${from}::date AND ${to}::date
       AND jl.amount > 0
       AND a.account_type IN ('expense', 'asset')
       -- Payroll's own entry is claimed through the stubs, per person and per
       -- cap; reaching it as a line as well would be the same money twice
       -- with none of the rules applied.
       AND je.source_type IS DISTINCT FROM 'payroll'
     -- Tagged accounts first: the person told us these hold SR&ED costs, so
     -- they are what they came to allocate. Everything else keeps its date
     -- order underneath, because the tag is a hint and not a filter.
     ORDER BY (c.category IS NULL), je.entry_date, a.code`)
  return rows.map((r) => ({
    source_kind: 'journal_line' as const,
    source_id: r.id,
    on_date: r.on_date,
    what: r.what,
    amount: r.amount,
    claimed_percent: Number(r.claimed),
    arms_length: r.arms_length ?? true,
    party: r.party,
    suggested: r.sred_category as SredCategory | null,
  }))
}

/**
 * Which T661 line an account's costs feed — SR&ED's own tag on the chart
 * (0156; it was a column on `account` from 0071). A hint to the allocation
 * screen, never a decision: tagged accounts sort first and arrive with their
 * line chosen, and the percent and the basis are still typed by a person.
 * `salary` is not a choice here: salary is claimed through the pay stub.
 */
export async function sredAccountCategories(entityId: string): Promise<Array<{
  id: string; code: string; name: string; account_type: string; category: SredCategory | null
}>> {
  return db.execute(sql`
    SELECT a.id::text, a.code, a.name, a.account_type, c.category
      FROM account a LEFT JOIN sred_account_category c ON c.account_id = a.id
     WHERE a.entity_id = ${entityId}::uuid AND a.is_active AND a.is_postable
       AND a.account_type IN ('expense', 'asset')
     ORDER BY a.code`)
}

export async function setSredAccountCategory(input: {
  accountId: string; category: string | null; actor: string
}): Promise<void> {
  const category = input.category || null
  if (category !== null && !(LINE_CATEGORIES as string[]).includes(category)) {
    throw new SredError('BAD_CATEGORY', `"${category}" is not a T661 line an account can feed.`)
  }
  await actingAs(input.actor, async (tx) => {
    const [acct] = await tx.execute<{ entity_id: string; code: string; name: string; was: string | null }>(sql`
      SELECT a.entity_id::text, a.code, a.name, c.category AS was
        FROM account a LEFT JOIN sred_account_category c ON c.account_id = a.id
       WHERE a.id = ${input.accountId}::uuid`)
    if (!acct) throw new SredError('NO_ACCOUNT', 'That account is not in these books.')
    if (acct.was === category) return
    if (category === null) {
      await tx.execute(sql`DELETE FROM sred_account_category WHERE account_id = ${input.accountId}::uuid`)
    } else {
      await tx.execute(sql`
        INSERT INTO sred_account_category (account_id, category, updated_by)
        VALUES (${input.accountId}::uuid, ${category}, ${input.actor})
        ON CONFLICT (account_id) DO UPDATE
          SET category = EXCLUDED.category, updated_at = clock_timestamp(), updated_by = EXCLUDED.updated_by`)
    }
    await auditRow(tx, {
      actor: input.actor, action: 'set_sred_category', table: 'sred_account_category',
      recordId: input.accountId, before: { category: acct.was }, after: { category },
      entityId: acct.entity_id, targetLabel: `${acct.code} ${acct.name}`,
    })
  })
}

export async function allocate(input: {
  claimId: string; sourceKind: 'pay_stub' | 'journal_line'; sourceId: string
  category: SredCategory; percent: string; basis: string; actor: string
}): Promise<void> {
  if (!input.basis.trim()) {
    throw new SredError('NO_BASIS',
      'Say why this share belongs to the project. The percentage is what gets asked about.')
  }
  if (input.sourceKind === 'pay_stub' && input.category !== 'salary') {
    throw new SredError('WRONG_CATEGORY', 'A pay stub is salary or wages; it cannot be anything else.')
  }
  if (input.sourceKind === 'journal_line' && input.category === 'salary') {
    throw new SredError('WRONG_CATEGORY',
      'Salary is claimed through the pay stub, where the specified-employee cap can be applied.')
  }
  await actingAs(input.actor, async (tx) => {
    await refuseIfFiled(tx, input.claimId)
    await tx.execute(sql`
    INSERT INTO sred_allocation (claim_id, source_kind, source_id, category, percent, basis, created_by)
    VALUES (${input.claimId}::uuid, ${input.sourceKind}, ${input.sourceId}::uuid,
            ${input.category}, ${input.percent}::numeric, ${input.basis.trim()}, ${input.actor})
    ON CONFLICT (claim_id, source_kind, source_id) DO UPDATE
      SET category = EXCLUDED.category, percent = EXCLUDED.percent, basis = EXCLUDED.basis`)
  })
}

export async function unallocate(allocationId: string, actor: string): Promise<void> {
  await actingAs(actor, async (tx) => {
    const [row] = await tx.execute<{ claim_id: string }>(sql`
      SELECT claim_id::text FROM sred_allocation WHERE id = ${allocationId}::uuid`)
    if (row) await refuseIfFiled(tx, row.claim_id)
    await tx.execute(sql`DELETE FROM sred_allocation WHERE id = ${allocationId}::uuid`)
  })
}

// --------------------------------------------------------- working paper --

/**
 * What line 300 does not contain, in words, with the figure.
 *
 * A named sentence rather than a fragment spliced into a note: the first
 * mutation blocks written for these two disclosures anchored on the LAST piece
 * of a multi-line concatenation, removed "this paper." and "figure.", and came
 * back green because the claim itself was in the piece above (2026-09-11). A
 * disclosure a block cannot delete whole is a disclosure nothing is holding.
 */
const grossOnlyNote = (employerShare: bigint) =>
  `GROSS PAY ONLY: the employer's share of CPP and EI on this work, `
  + `${formatMoney(employerShare)} at the same percentages, is not in this figure. It is `
  + 'claimed on line 360 under the traditional method, as directly attributable overhead, and '
  + 'not at all under proxy, where no overhead is claimed separately.'

/**
 * What came out of the proxy base, and what could not.
 *
 * THE HEDGE IS UNCONDITIONAL, and that is the point. The exclusion is only as
 * good as what somebody typed into the pay run's bonus column — `pay_stub.bonus`
 * defaults to zero — so a ledger whose bonuses never reached that column gets a
 * base that excluded nothing. The first version put "which is the narrower
 * figure the law asks for" outside every condition and the caveat inside one,
 * which printed a claim of compliance on exactly the papers that had not earned
 * it (independent critic, 2026-09-11).
 */
const proxyBaseNote = (bonusOut: bigint) =>
  'The base is the salary on line 300 less whatever was entered as a bonus'
  + `${bonusOut > 0n ? ` — ${formatMoney(bonusOut)} taken out` : ' — nothing was'}. `
  + 'TWO THINGS THIS CANNOT TAKE OUT, so the base may still be wider than the law asks for: '
  + 'a bonus or profit-based pay nobody entered in that column (it appears on a pay run under '
  + '"Set pensionable, insurable and bonus separately"), and taxable benefits, which nothing in '
  + 'this system records apart from gross pay at all.'

const share = (whole: bigint, percent: number): bigint =>
  (whole * BigInt(Math.round(percent * 100))) / 10000n

/**
 * The claim, computed from the allocations and the ledger.
 *
 * BOTH METHODS, EVERY TIME. Proxy is simpler and usually larger for a company
 * whose costs are mostly people; traditional wins when the overhead is real
 * and recorded — and this system records it. Choosing without seeing the two
 * is choosing by habit.
 */
export async function workingPaper(claimId: string): Promise<WorkingPaper> {
  // The YMPE the salary cap is built from may be an edition added in the app (0082).
  await loadEditions()
  const [head] = await db.execute<{
    method: SredMethod; entity: string; is_ccpc: boolean | null
    year_name: string; year_start: string; year_end: string
    ledger_id: string; filed_on: string | null
    assistance_answered_on: string | null
  }>(sql`
    SELECT c.method, e.name AS entity, e.is_ccpc,
           y.name AS year_name, y.start_date::text AS year_start, y.end_date::text AS year_end,
           y.ledger_id::text, c.filed_on::text, c.assistance_answered_on::text
      FROM sred_claim c
      JOIN sred_project pj ON pj.id = c.project_id
      JOIN entity e ON e.id = pj.entity_id
      JOIN fiscal_year y ON y.id = c.fiscal_year_id
     WHERE c.id = ${claimId}::uuid`)
  if (!head) throw new SredError('NO_CLAIM', 'That claim is not on file.')

  const rates = await sredRates(head.year_end)
  const allocations = await db.execute<{
    id: string; source_kind: string; source_id: string; category: SredCategory
    percent: string; basis: string
    on_date: string; what: string; amount: bigint
    is_specified: boolean | null; arms_length: boolean | null
    employer_share: bigint | null; bonus: bigint | null
  }>(sql`
    SELECT a.id::text, a.source_kind, a.source_id::text, a.category,
           a.percent::text, a.basis,
           COALESCE(pr.pay_date, je.entry_date)::text AS on_date,
           COALESCE(p.name, acc.code || ' — ' || acc.name) AS what,
           COALESCE(ps.gross, jl.amount) AS amount,
           e.is_specified, lp.arms_length,
           -- What the COMPANY paid on top of the gross, for this stub. Named
           -- beside line 300 and claimed on line 360 under the traditional
           -- method; not in the proxy column at all.
           (ps.employer_cpp + ps.employer_cpp2 + ps.employer_ei) AS employer_share,
           ps.bonus
      FROM sred_allocation a
      LEFT JOIN pay_stub ps ON a.source_kind = 'pay_stub' AND ps.id = a.source_id
      LEFT JOIN pay_run pr ON pr.id = ps.pay_run_id
      LEFT JOIN payroll_employee e ON e.id = ps.employee_id
      LEFT JOIN party p ON p.id = e.party_id
      LEFT JOIN journal_line jl ON a.source_kind = 'journal_line' AND jl.id = a.source_id
      LEFT JOIN journal_entry je ON je.id = jl.entry_id
      LEFT JOIN account acc ON acc.id = jl.account_id
      LEFT JOIN party lp ON lp.id = jl.party_id
     WHERE a.claim_id = ${claimId}::uuid
     ORDER BY a.category, on_date`)

  const toConfirm: string[] = []
  for (const r of rates) {
    if (r.confidence === 'unconfirmed') {
      toConfirm.push(`${r.jurisdiction} ${r.name} = ${r.value} (${r.authority}) — ${r.note ?? ''}`)
    }
  }
  if (head.is_ccpc === null) {
    toConfirm.push('Nobody has said whether this company is a CCPC. The rate below assumes it is not.')
  }

  /**
   * HOURS ADDED AFTER THE RETURN WENT.
   *
   * Adding time to a filed year is deliberately still allowed — the project
   * record goes on being kept, and `workingPaper` never reads `sred_time`, so
   * no figure on this paper moves. What DOES move is a figure the return
   * CITED: the strongest allocation basis is a share of hours ("118 of 190
   * hours in the period"), that sentence is frozen on the allocation by
   * `refuseIfFiled`, and its denominator is not. So the paper says so rather
   * than leaving a person to notice (independent critic, 2026-09-12).
   */
  if (head.filed_on) {
    const [late] = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
        FROM sred_time t JOIN sred_claim c ON c.project_id = t.project_id
       WHERE c.id = ${claimId}::uuid
         AND t.on_date BETWEEN ${head.year_start}::date AND ${head.year_end}::date
         AND c.filed_at IS NOT NULL AND t.created_at > c.filed_at`)
    if (late && late.n > 0) {
      // NAMES WHAT IT MEASURED. It said "after the return went on <filed_on>",
      // and `filed_on` is a date a person types — file today with a date next
      // June and the sentence would claim records were late that were not, and
      // a re-file with the original date would say nothing about hours written
      // after it. The measurement is against `filed_at`, the instant, so the
      // sentence says that and shows the return's own date beside it
      // (independent critic, 2026-09-12).
      toConfirm.push(`${late.n} hour record(s) in this year were written down AFTER this year `
        + `was filed (the return is dated ${head.filed_on}). Any allocation whose basis quotes `
        + 'a share of hours was frozen when the year was filed and its denominator has moved '
        + 'since — read those sentences again before this paper is used for anything.')
    }
  }
  if (!head.assistance_answered_on) {
    toConfirm.push('Government assistance and payments for this work have not been answered for this year. '
      + 'They reduce the claim, and this is the line CRA adjusts most often.')
  }

  const pick = (c: SredCategory) => allocations.filter((a) => a.category === c)
  const lineOf = (a: typeof allocations[number]) => ({
    what: a.what, on_date: a.on_date, whole: a.amount,
    percent: Number(a.percent), taken: share(a.amount, Number(a.percent)),
  })

  // ---- salary, with the specified-employee cap ---------------------------
  //
  // The cap is on the YEAR, not on a stub, so the stubs are gathered per
  // person first and the cap applied to the total. Applying it stub by stub
  // would let twenty-six fortnights each pass a cap the year fails.
  const ympe = ympeFor(Number(head.year_end.slice(0, 4)))
  const capMultiple = rateOf(rates, 'federal', 'specified_employee_ympe_multiple')
  const cap = ympe * BigInt(capMultiple)
  const perPerson = new Map<string, { taken: bigint; specified: boolean; rows: PaperLine['from'] }>()
  for (const a of pick('salary')) {
    const key = a.what
    const at = perPerson.get(key) ?? { taken: 0n, specified: !!a.is_specified, rows: [] }
    at.taken += share(a.amount, Number(a.percent))
    at.rows.push(lineOf(a))
    perPerson.set(key, at)
  }
  const salaryRows: PaperLine['from'] = []
  let salary = 0n
  let ppaBase = 0n
  // The employer's half of CPP and EI, at the same share as the pay it sits on.
  // Named beside line 300 and ADDED TO LINE 360 under the traditional method,
  // where it is directly attributable overhead; under proxy it is claimed
  // nowhere, because under proxy no overhead is (owner, 2026-09-11).
  const employerShare = pick('salary').reduce(
    (n, a) => n + share(a.employer_share ?? 0n, Number(a.percent)), 0n)
  // OUT OF THE PROXY BASE, per the owner's answer (2026-09-11): the salary base
  // for the prescribed proxy amount excludes bonuses and profit-based pay. Line
  // 300 keeps them — only the base is narrower — and `pay_stub.bonus` (0072) is
  // what finally makes the two figures tellable apart.
  const bonusInBase = new Map<string, bigint>()
  for (const a of pick('salary')) {
    bonusInBase.set(a.what,
      (bonusInBase.get(a.what) ?? 0n) + share(a.bonus ?? 0n, Number(a.percent)))
  }
  const ppaSpecifiedPercent = rateOf(rates, 'federal', 'specified_employee_ppa_percent')
  let bonusLeftTheBase = 0n
  for (const [who, at] of perPerson) {
    const counted = at.specified && at.taken > cap ? cap : at.taken
    salary += counted
    // The bonus comes out of the base BEFORE the specified-employee share, and
    // never below nothing: a person capped down to 5 x YMPE may have had less
    // salary counted than they were paid in bonus.
    const bonus = bonusInBase.get(who) ?? 0n
    // Capped by what is in the base — see `bonusOutOfBase` in sred-kinds.ts,
    // which is where it lives so a check can call it.
    const bonusTaken = bonusOutOfBase(counted, bonus)
    bonusLeftTheBase += bonusTaken
    const forBase = counted - bonusTaken
    ppaBase += at.specified
      ? (forBase * BigInt(Math.round(ppaSpecifiedPercent * 100))) / 100n
      : forBase
    salaryRows.push(...at.rows)
    // EVERY specified employee, capped or not. The risk belongs to all of them:
    // the law keeps profit-based pay out of the claim itself and this module
    // keeps it only out of the proxy base, so somebody paid under the cap had
    // the same thing not done for them and used to be told nothing at all
    // (independent critic, 2026-09-11). The cap is a second sentence when it
    // bites, because that is a different fact.
    if (at.specified) {
      const theirBonus = bonusInBase.get(who) ?? 0n
      toConfirm.push(`${who} is a specified employee. `
        + (theirBonus > 0n
          ? `${formatMoney(theirBonus)} of their claimed pay was entered as a bonus and is out `
            + 'of the proxy base. '
          : 'None of their claimed pay was entered as a bonus. ')
        + 'For a specified employee the law also keeps profit-based pay out of the CLAIM itself, '
        + 'which this paper does NOT do — line 300 still carries whatever is there. The bonus '
        + 'column does not record WHICH it was: a bonus and profit-based pay go in the same box '
        + 'and come out of the proxy base together. So check what line 300 is made of, and that '
        + 'anything of either kind reached that column, because what did not is invisible here.')
    }
    if (at.specified && at.taken > cap) {
      toConfirm.push(`${who} is capped: ${formatMoney(at.taken)} claimed, counted at `
        + `${formatMoney(cap)} (${capMultiple} x YMPE).`)
    }
  }

  // ---- everything else ---------------------------------------------------
  const sum = (rows: PaperLine['from']) => rows.reduce((n, r) => n + r.taken, 0n)
  const materials = pick('materials').map(lineOf)

  const contractPercent = rateOf(rates, 'federal', 'contract_arms_length_percent')
  const contractRows = pick('contract').map(lineOf)
  const nonArms = pick('contract').filter((a) => a.arms_length === false)
  if (nonArms.length > 0) {
    toConfirm.push(`${nonArms.length} contract allocation(s) name a party that is not at arm's length. `
      + 'The 80% rule does not apply to those and they need advice; they are counted here in full.')
  }
  const contractsAtEighty = pick('contract').reduce((n, a) => {
    const taken = share(a.amount, Number(a.percent))
    return n + (a.arms_length === false
      ? taken
      : (taken * BigInt(Math.round(contractPercent * 100))) / 100n)
  }, 0n)

  const thirdRows = pick('third_party').map(lineOf)
  const thirdAtEighty = (sum(thirdRows) * BigInt(Math.round(contractPercent * 100))) / 100n

  const overheadRows = pick('overhead').map(lineOf)
  const proxyPercent = rateOf(rates, 'federal', 'proxy_percent')
  const ppa = (ppaBase * BigInt(Math.round(proxyPercent * 100))) / 100n

  // The two disclosures, each on one line a block can blank.
  const saidGross = grossOnlyNote(employerShare)
  const saidBase = proxyBaseNote(bonusLeftTheBase)

  const capitalRows = pick('capital').map(lineOf)
  // The caveat is the RATE's own note, not a second spelling of it typed here.
  // Two sentences saying one thing drift the first time either is edited.
  const capitalNote = rates.find((r) => r.name === 'capital_eligible')?.note

  const common = (): PaperLine[] => [
    { t661: '300', label: 'Salary or wages', amount: salary, from: salaryRows,
      note: `Directly engaged in Canada. Specified employees capped at 5 x YMPE. ${saidGross}` },
    { t661: '320', label: 'Cost of materials consumed or transformed', amount: sum(materials), from: materials },
    { t661: '340', label: 'Contracts for SR&ED performed on your behalf',
      amount: contractsAtEighty, from: contractRows,
      note: `Arm's-length contracts counted at ${Math.round(contractPercent * 100)}%.` },
    { t661: '345', label: 'Third-party payments', amount: thirdAtEighty, from: thirdRows,
      note: `Counted at ${Math.round(contractPercent * 100)}%.` },
  ]

  const proxyLines: PaperLine[] = [
    ...common(),
    { t661: '502', label: 'Prescribed proxy amount', amount: ppa, from: [],
      note: `${Math.round(proxyPercent * 100)}% of the salary base `
        + `(specified employees at ${Math.round(ppaSpecifiedPercent * 100)}%). `
        + `Overhead is not claimed separately under this method. ${saidBase}` },
  ]
  const traditionalLines: PaperLine[] = [
    ...common(),
    { t661: '360', label: 'Overhead and other expenditures',
      // The employer's share of CPP and EI on the claimed pay is directly
      // attributable overhead, so it belongs HERE and only here (owner,
      // 2026-09-11). Under proxy it is not claimed at all, because under proxy
      // no overhead is — the prescribed proxy amount stands in for all of it.
      amount: sum(overheadRows) + employerShare, from: overheadRows,
      note: 'Only what is directly attributable, and recorded. The proxy amount is not claimed. '
        + `Includes ${formatMoney(employerShare)} of employer CPP and EI on the salary above.` },
  ]

  const total = (lines: PaperLine[]) => lines.reduce((n, l) => n + l.amount, 0n)

  // ---- the credits -------------------------------------------------------
  const enhanced = rateOf(rates, 'federal', 'enhanced_itc')
  const basic = rateOf(rates, 'federal', 'basic_itc')
  const limit = parseMoney(String(rateOf(rates, 'federal', 'expenditure_limit')))
  const bcRate = rateOf(rates, 'BC', 'itc_percent')
  const qualified = head.method === 'proxy' ? total(proxyLines) : total(traditionalLines)
  const ccpc = head.is_ccpc === true
  if (ccpc) {
    // The limit is applied here IN FULL, per claim, and two things can make that
    // wrong: it is ground down by taxable capital between $10M and $50M, and
    // ASSOCIATED CORPORATIONS SHARE ONE LIMIT between them. This system holds
    // several companies and no association test — so the paper says so rather
    // than quietly claiming the whole limit for each of them.
    toConfirm.push('The enhanced rate is taken up to the expenditure limit in full. That limit '
      + 'is ground down by taxable capital, and associated corporations share one limit between '
      + 'them; neither is worked out here, so a company with associates divides it by hand.')
  }
  if (qualified > limit) {
    // The federal side splits at the limit two lines down. BC's does not: its
    // 10% is taken on the whole figure, and the province's own credit is
    // refundable for a CCPC only up to a limit (the seeded rate's note says so).
    // Above the limit, the BC half of this paper is wrong in a direction nobody
    // would notice, so it is said out loud rather than left in the number.
    toConfirm.push('This claim is above the expenditure limit. The federal side splits at it; '
      + 'the BC figure below does not — 10% is taken on the whole amount, and the provincial '
      + 'credit is refundable for a CCPC only up to a limit. The BC half needs working out by hand.')
  }
  const atEnhanced = qualified > limit ? limit : qualified
  const above = qualified > limit ? qualified - limit : 0n
  const federalAmount = ccpc
    ? (atEnhanced * BigInt(Math.round(enhanced * 100))) / 100n
      + (above * BigInt(Math.round(basic * 100))) / 100n
    : (qualified * BigInt(Math.round(basic * 100))) / 100n

  // A SHORT TAX YEAR IS DETECTED TWO WAYS, AND PRORATED NEITHER.
  //
  // The year's own dates catch a row a restore carried in or an open year
  // somebody redefined; the recognition date catches the case no ledger date
  // can show — a company incorporated mid-year, whose first tax year is short
  // while this ledger keeps twelve months for it.
  //
  // INSIDE the year means both ends. With only the lower bound, a claim on a
  // year that ENDS before the company existed — `createFiscalYear` will plan one
  // flush before the earliest — was told that year contained the incorporation,
  // which is false about it twice over (independent critic, 2026-09-11).
  //
  // Both are day counts. Neither is a proration: `ITA 37(9.1)` prorates the cap
  // and working out by how much is a judgement this module does not make.
  //
  // RISKS §23 carries the argument, including why this was deleted once on a
  // premise that was wrong three ways. It is not restated here — four copies of
  // it had to be corrected together, which is the drift the note above
  // `capitalNote` warns about.
  const [span] = await db.execute<{ days: string; incorporated: string | null }>(sql`
    SELECT (${head.year_end}::date - ${head.year_start}::date + 1)::text AS days,
           (SELECT recognition_date::text FROM company_profile cp
             JOIN sred_project p2 ON p2.entity_id = cp.entity_id
             JOIN sred_claim c2 ON c2.project_id = p2.id
            WHERE c2.id = ${claimId}::uuid) AS incorporated`)
  const dayCount = Number(span.days)
  if (dayCount < 365) {
    toConfirm.push(`This fiscal year is ${dayCount} days long, not a full one. The `
      + `${capMultiple} x YMPE cap on a specified employee is prorated for a short tax year and `
      + 'is NOT prorated here — it is applied in full, so a capped figure above is too generous '
      + 'by the fraction of the year that is missing.')
  } else if (span.incorporated
             && span.incorporated > head.year_start && span.incorporated <= head.year_end) {
    toConfirm.push(`This company was recognised on ${span.incorporated}, inside a fiscal year `
      + `this ledger keeps as twelve months. Its FIRST TAX YEAR is shorter than that, and the `
      + `${capMultiple} x YMPE cap is prorated for a short tax year — it is applied in full `
      + 'here, so a capped figure above is too generous.')
  }

  const deadlineMonths = rateOf(rates, 'federal', 'reporting_deadline_months')
  const [when] = await db.execute<{ deadline: string; days: string }>(sql`
    SELECT (${head.year_end}::date + (${deadlineMonths} || ' months')::interval)::date::text AS deadline,
           ((${head.year_end}::date + (${deadlineMonths} || ' months')::interval)::date
             - CURRENT_DATE)::text AS days`)

  return {
    claimId,
    entity: head.entity,
    isCcpc: head.is_ccpc,
    year: { name: head.year_name, start: head.year_start, end: head.year_end },
    deadline: when.deadline,
    daysLeft: Number(when.days),
    method: head.method,
    proxy: { lines: proxyLines, qualified: total(proxyLines) },
    traditional: { lines: traditionalLines, qualified: total(traditionalLines) },
    excluded: [
      { t661: null, label: 'Capital expenditures — not eligible federally since 2014',
        amount: sum(capitalRows), from: capitalRows,
        note: `Listed so the money is visible. ${capitalNote ?? ''}`.trim() },
    ],
    credits: {
      federal: {
        rate: ccpc ? enhanced : basic,
        refundable: ccpc,
        amount: federalAmount,
        basis: ccpc
          ? `CCPC: ${Math.round(enhanced * 100)}% up to the expenditure limit, `
            + `${Math.round(basic * 100)}% above it. Refundable.`
          : `Not a CCPC (or not stated): ${Math.round(basic * 100)}%, generally not refundable.`,
      },
      bc: {
        rate: bcRate,
        refundable: ccpc,
        amount: (qualified * BigInt(Math.round(bcRate * 100))) / 100n,
        basis: `${Math.round(bcRate * 100)}% of the qualified expenditures above. `
          + 'Applied to the federal figure: nothing here tests that an expenditure was '
          + 'incurred in BC, and a claim with work done elsewhere needs that taken out by hand. '
          + 'No expenditure limit is applied to this figure either — the provincial credit is '
          + 'refundable for a CCPC only up to one. '
          + 'It is assistance federally, so it reduces next year’s federal pool.',
      },
    },
    toConfirm,
  }
}

// ------------------------------------------------------------- evidence --

export async function evidenceFor(projectId: string): Promise<EvidenceRow[]> {
  return db.execute<EvidenceRow>(sql`
    SELECT ev.id::text, ev.kind, ev.title, ev.on_date::text,
           ev.attachment_id::text, ev.note, at.filename
      FROM sred_evidence ev
      LEFT JOIN attachment at ON at.id = ev.attachment_id
     WHERE ev.project_id = ${projectId}::uuid
     ORDER BY ev.on_date DESC, ev.kind`)
}

export async function addEvidence(input: {
  projectId: string; kind: string; title: string; onDate: string
  attachmentId?: string; note?: string; actor: string
}): Promise<void> {
  if (!EVIDENCE_KINDS.some((k) => k.kind === input.kind)) {
    throw new SredError('UNKNOWN_KIND', `"${input.kind}" is not one of the kinds CRA asks for.`)
  }
  await actingAs(input.actor, (tx) => tx.execute(sql`
    INSERT INTO sred_evidence (project_id, kind, title, on_date, attachment_id, note, created_by)
    VALUES (${input.projectId}::uuid, ${input.kind}, ${input.title.trim()}, ${input.onDate}::date,
            ${input.attachmentId ?? null}, ${input.note ?? null}, ${input.actor})`))
}

export async function updateSredEvidence(input: {
  evidenceId: string; kind: string; title: string; onDate: string
  /** Undefined leaves it as it is; '' clears it (0084 — the note had no way back in). */
  note?: string
  actor: string
}): Promise<void> {
  if (!EVIDENCE_KINDS.some((k) => k.kind === input.kind)) {
    throw new SredError('UNKNOWN_KIND', `"${input.kind}" is not one of the kinds CRA asks for.`)
  }
  if (!input.title.trim()) throw new SredError('NO_TITLE', 'Say what the paper is.')
  await actingAs(input.actor, async (tx) => {
    const [row] = await tx.execute<{ project_id: string; on_date: string }>(sql`
      SELECT project_id::text, on_date::text FROM sred_evidence WHERE id = ${input.evidenceId}::uuid`)
    if (!row) throw new SredError('NO_ROW', 'That evidence is not on file.')
    // Both dates, for the reason `updateSredTime` gives.
    await refuseIfInFiledYear(tx, row.project_id, row.on_date) // where the paper is
    await refuseIfInFiledYear(tx, row.project_id, input.onDate) // where the paper is going
    await tx.execute(sql`
      UPDATE sred_evidence SET kind = ${input.kind}, title = ${input.title.trim()},
             on_date = ${input.onDate}::date,
             note = ${input.note === undefined ? sql`note` : sql`${input.note.trim() || null}`}
       WHERE id = ${input.evidenceId}::uuid`)
  })
}

export async function deleteSredEvidence(input: {
  evidenceId: string; actor: string
}): Promise<void> {
  await actingAs(input.actor, async (tx) => {
    const [row] = await tx.execute<{ project_id: string; on_date: string }>(sql`
      SELECT project_id::text, on_date::text FROM sred_evidence WHERE id = ${input.evidenceId}::uuid`)
    if (!row) throw new SredError('NO_ROW', 'That evidence is not on file.')
    await refuseIfInFiledYear(tx, row.project_id, row.on_date)
    await tx.execute(sql`DELETE FROM sred_evidence WHERE id = ${input.evidenceId}::uuid`)
  })
}

/** A batch of paper, same shape and same all-or-nothing rule as the hours. */
export async function addSredEvidenceBatch(input: {
  projectId: string; text: string; actor: string
}): Promise<{ added: number; refused: PasteRefusal[] }> {
  const parsed = parseEvidencePaste(input.text)
  const refused = [...parsed.refused]
  const already = await db.execute<{ key: string }>(sql`
    SELECT (kind || '|' || on_date::text || '|' || title) AS key
      FROM sred_evidence WHERE project_id = ${input.projectId}::uuid`)
  const onFile = new Set(already.map((r) => r.key))

  const ready = parsed.rows.filter((r) => {
    // Against itself as well as against the table — see the note in the hours
    // batch above.
    if (!onFile.has(`${r.kind}|${r.onDate}|${r.title}`)) {
      onFile.add(`${r.kind}|${r.onDate}|${r.title}`)
      return true
    }
    refused.push({ line: r.line, text: `${r.kind} | ${r.title} | ${r.onDate}`,
                   why: 'already on file, to the word' })
    return false
  })
  if (nothingOnRefusal(refused)) return { added: 0, refused }

  await actingAs(input.actor, async (tx) => {
    for (const r of ready) {
      await tx.execute(sql`
        INSERT INTO sred_evidence (project_id, kind, title, on_date, created_by)
        VALUES (${input.projectId}::uuid, ${r.kind}, ${r.title}, ${r.onDate}::date, ${input.actor})`)
    }
  })
  return { added: ready.length, refused }
}

/**
 * What a project has and what it has not — by the QUESTION each kind answers,
 * because that is how a claim is read.
 *
 * Nothing here refuses anything. A project with invoices and no trial records
 * can still be claimed; it is simply the shape of claim that gets a letter,
 * and the person should be looking at that before the year ends rather than
 * eighteen months after it.
 */
export async function evidenceStanding(projectId: string): Promise<Array<{
  answers: 'why' | 'how' | 'cost'; kinds: number; held: number; missing: string[]
}>> {
  const have = new Set((await evidenceFor(projectId)).map((e) => e.kind))
  const out: Record<string, { kinds: number; held: number; missing: string[] }> = {}
  for (const k of EVIDENCE_KINDS) {
    const at = out[k.answers] ?? { kinds: 0, held: 0, missing: [] }
    at.kinds++
    if (have.has(k.kind)) at.held++
    else at.missing.push(k.label)
    out[k.answers] = at
  }
  return (['why', 'how', 'cost'] as const).map((answers) => ({ answers, ...out[answers] }))
}
