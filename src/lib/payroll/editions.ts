import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { formatMoney, parseMoney } from '../money'
import { calculatePayroll, FREQUENCIES, type Frequency } from './engine'
import {
  EDITIONS, PayrollError, editionsOnFile, setAddedEditions,
  type BcRates, type CppEiRates, type FederalRates, type RateEdition,
} from './rates'
import { problemsWith, problemsWithList, sameFigures } from './rates-check'

/**
 * THE CRA EDITIONS ADDED IN THE APP (0082) — read, added, removed.
 *
 * `rates.ts` keeps the editions built into the code and computes with whatever
 * list it is handed; this is where the rest of that list comes from. Every
 * door that computes pay, a T4 or the SR&ED salary cap calls `loadEditions()`
 * first. One that forgot would see only the built-in editions: for a year only
 * an added edition covers it refuses by name, but for a later edition added
 * inside a year that already has tables it would compute with the earlier
 * tables — which is why loading is every door's first line, not a fallback.
 *
 * Adding one is the doc-35 procedure the app can do by itself:
 *
 *   1. the figures are numbers              `editionFromFigures`
 *   2. they agree with themselves           `problemsWith` — hard refusals
 *   3. the list stays in order, one per id, `problemsWithList`
 *      a year opens on its first day, and
 *      a year carries one set of CPP/EI
 *   4. ONE PDOC CASE COMPUTED WITH THEM     the checker cannot tell a
 *      MATCHES CRA's CALCULATOR TO THE CENT consistent table from THIS year's
 *                                           table; only PDOC can (doc 35)
 *
 * and only then is a row written.
 */

export type PdocCase = {
  payDate: string
  frequency: Frequency
  /** Cents, as text: the period's gross and the two claims PDOC was given. */
  gross: string
  federalClaim: string
  bcClaim: string
  /** What PDOC said, per period, in cents as text. */
  expect: { cpp: string; cpp2: string; ei: string; federalTax: string; provincialTax: string }
}

export type EditionRecord = {
  edition: RateEdition
  /** Null for an edition built into the code. */
  added: { at: string; by: string; pdoc: PdocCase } | null
  /**
   * On a built-in edition: the copy added in the app before a release built it
   * in — ignored by the list, shown so it can be removed, and said whether its
   * figures are the release's.
   */
  copy?: { at: string; by: string; pdoc: PdocCase; sameFigures: boolean } | null
}

type Row = {
  id: string; starts_on: string; authority: string
  cpp_ei: CppEiRates; federal: FederalRates; bc: BcRates; pdoc: PdocCase
  created_at: string; created_by: string
}

const fromRow = (r: Row): RateEdition =>
  ({ id: r.id, startsOn: r.starts_on, authority: r.authority, cppEi: r.cpp_ei, federal: r.federal, bc: r.bc })

async function rows(): Promise<Row[]> {
  return db.execute<Row>(sql`
    SELECT id, starts_on::text, authority, cpp_ei, federal, bc, pdoc, created_at::text, created_by
      FROM payroll_rate_edition ORDER BY starts_on`)
}

/**
 * A row a later release has since built in — added in the app while it was
 * new, then shipped in `rates.ts`. The release's copy is the one computed with;
 * counting both would put two editions of one id on the list, which refuses
 * every computation of every company (independent critic, 2026-09-16).
 */
const notBuiltIn = (r: Row) => !EDITIONS.some((e) => e.id === r.id)

/** Read the editions added in the app into the list `rates.ts` computes with. Returns the whole list. */
export async function loadEditions(): Promise<RateEdition[]> {
  setAddedEditions((await rows()).filter(notBuiltIn).map(fromRow))
  return editionsOnFile()
}

/** Every edition on file, built-in first, with who added the others and what they were proved against. */
export async function editionRecords(): Promise<EditionRecord[]> {
  const all = await rows()
  const added = all.filter(notBuiltIn)
  setAddedEditions(added.map(fromRow))
  return [
    ...EDITIONS.map((edition) => {
      const c = all.find((r) => r.id === edition.id)
      return {
        edition, added: null,
        copy: c ? { at: c.created_at, by: c.created_by, pdoc: c.pdoc, sameFigures: sameFigures(fromRow(c), edition) } : null,
      }
    }),
    ...added.map((r) => ({ edition: fromRow(r), added: { at: r.created_at, by: r.created_by, pdoc: r.pdoc } })),
  ]
}

const LINES: Array<[keyof PdocCase['expect'], string]> = [
  ['cpp', 'CPP'], ['cpp2', 'CPP2'], ['ei', 'EI'], ['federalTax', 'federal tax'], ['provincialTax', 'BC tax'],
]

/**
 * What the candidate computes for the PDOC case, line by line against what
 * PDOC said. Empty means every line matched to the cent.
 */
export function pdocDisagreements(candidate: RateEdition, list: RateEdition[], pdoc: PdocCase): string[] {
  const got = calculatePayroll({
    payDate: pdoc.payDate, frequency: pdoc.frequency, gross: BigInt(pdoc.gross),
    federalClaim: BigInt(pdoc.federalClaim), bcClaim: BigInt(pdoc.bcClaim),
  }, list)
  if (got.edition !== candidate.id) {
    return [`the PDOC pay date ${pdoc.payDate} falls under ${got.edition}, not under ${candidate.id}`]
  }
  return LINES.flatMap(([key, label]) => {
    const want = BigInt(pdoc.expect[key])
    return got[key] === want ? [] : [`${label}: PDOC says ${formatMoney(want)}, these tables compute ${formatMoney(got[key])}`]
  })
}

/**
 * Add an edition. Refused, with every reason, unless all four questions above
 * answer yes; nothing is written until they do.
 */
export async function addEdition(input: { edition: RateEdition; pdoc: PdocCase; actor: string }): Promise<void> {
  const { edition, pdoc } = input
  const current = await loadEditions()
  const last = current[current.length - 1]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(edition.startsOn) || edition.id !== edition.startsOn.slice(0, 7)) {
    throw new PayrollError('BAD_EDITION', `An edition is named for the month it starts in: ${edition.startsOn.slice(0, 7) || 'YYYY-MM'}.`)
  }
  if (last && edition.startsOn <= last.startsOn) {
    throw new PayrollError('BAD_EDITION',
      `A new edition starts after the last one on file (${last.id}, from ${last.startsOn}). `
      + 'An edition already on file is corrected by removing it and adding it again.')
  }
  const { wrong } = problemsWith(edition)
  if (wrong.length > 0) {
    throw new PayrollError('BAD_TABLES', `These tables do not add up, so nothing was saved: ${wrong.join('; ')}.`)
  }
  const list = [...current, edition]
  const listProblems = problemsWithList(list)
  if (listProblems.length > 0) {
    throw new PayrollError('BAD_TABLES', `The editions would not be usable, so nothing was saved: ${listProblems.join('; ')}.`)
  }
  if (!(pdoc.frequency in FREQUENCIES)) {
    throw new PayrollError('BAD_PDOC', 'Say how often the PDOC example is paid.')
  }
  const off = pdocDisagreements(edition, list, pdoc)
  if (off.length > 0) {
    throw new PayrollError('PDOC_DISAGREES',
      `The PDOC example does not come out the same with these tables, so nothing was saved — `
      + `${off.join('; ')}. Check the figure behind each line against the PDF, and the example against PDOC.`)
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      INSERT INTO payroll_rate_edition (id, starts_on, authority, cpp_ei, federal, bc, pdoc, created_by)
      VALUES (${edition.id}, ${edition.startsOn}::date, ${edition.authority},
              ${JSON.stringify(edition.cppEi)}::jsonb, ${JSON.stringify(edition.federal)}::jsonb,
              ${JSON.stringify(edition.bc)}::jsonb, ${JSON.stringify(pdoc)}::jsonb, ${input.actor})`)
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, after)
      VALUES (${input.actor}, 'add_edition', 'payroll_rate_edition', ${edition.id},
              ${JSON.stringify({ startsOn: edition.startsOn, authority: edition.authority, pdoc })}::jsonb)`)
  })
  await loadEditions()
}

/**
 * Remove an edition added in the app. Not one built into the code, and not one
 * a pay stub was computed with: that stub names it, and its figures are what
 * the stub's amounts were worked out from.
 */
const removeCopy = (id: string) => sql`DELETE FROM payroll_rate_edition WHERE id = ${id}`

export async function removeEdition(id: string, actor: string): Promise<void> {
  const builtIn = EDITIONS.find((e) => e.id === id)
  if (EDITIONS.some((e) => e.id === id)) {
    // The copy added before a release built this edition in is ignored by the
    // list and may be taken away; the built-in edition itself stays. Unless pay
    // was run under the copy and its figures are not the release's: then the
    // copy is the only record of what those stubs were worked out from
    // (independent critic, 2026-09-16).
    const [copy] = await rows().then((all) => all.filter((r) => r.id === id))
    if (copy === undefined) {
      throw new PayrollError('BUILT_IN', `${id} is built into the app and cannot be removed here.`)
    }
    const [stubs] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pay_stub WHERE edition = ${id}`)
    const same = sameFigures(fromRow(copy), builtIn!)
    if (stubs.n > 0 && !same) {
      throw new PayrollError('IN_USE',
        `${stubs.n} pay stub${stubs.n === 1 ? ' was' : 's were'} computed with ${id} while the copy added here was on `
        + 'the list, and its figures differ from the ones the app now builds in. The copy stays as their record.')
    }
    await db.execute(removeCopy(id))
    await db.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, context)
      VALUES (${actor}, 'remove_edition', 'payroll_rate_edition', ${id},
              ${JSON.stringify({ authority: copy.authority, cppEi: copy.cpp_ei, federal: copy.federal, bc: copy.bc, pdoc: copy.pdoc, addedBy: copy.created_by, addedAt: copy.created_at })}::jsonb,
              ${JSON.stringify({ note: 'the copy added in the app; the release builds this edition in', sameFigures: same, stubs: stubs.n })}::jsonb)`)
    await loadEditions()
    return
  }
  const [used] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pay_stub WHERE edition = ${id}`)
  if (used && used.n > 0) {
    throw new PayrollError('IN_USE',
      `${used.n} pay stub${used.n === 1 ? ' was' : 's were'} computed with ${id}, so it stays. `
      + 'Its figures are what those stubs were worked out from.')
  }
  // AND WHAT IS LEFT MUST STILL BE A LIST PAYROLL CAN USE. Taking a January
  // edition out from under a July one leaves a year whose first edition does
  // not start on its first day, and every computation of every company then
  // refuses the whole list — with no door back, because a January cannot be
  // added after a July (independent critic, 2026-09-16).
  const remaining = (await loadEditions()).filter((e) => e.id !== id)
  const broken = problemsWithList(remaining)
  if (broken.length > 0) {
    throw new PayrollError('LIST_BREAKS',
      `Removing ${id} would leave editions payroll cannot use (${broken.join('; ')}). `
      + 'Remove the editions after it first.')
  }
  const gone = await db.execute<{ id: string }>(sql`
    DELETE FROM payroll_rate_edition WHERE id = ${id} RETURNING id`)
  if (gone.length === 0) throw new PayrollError('NO_EDITION', `There is no added edition called ${id}.`)
  await db.execute(sql`
    INSERT INTO audit_log (actor, action, table_name, record_id)
    VALUES (${actor}, 'remove_edition', 'payroll_rate_edition', ${id})`)
  await loadEditions()
}

/** Cents as text, from what a person typed. */
export const centsText = (typed: string): string => parseMoney(typed).toString()
