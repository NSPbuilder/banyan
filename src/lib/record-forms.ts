import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { type FormResult, attemptWith, g, RECORD_FIELDS, rowField, rowIndicesIn, sentenceOf } from './forms'
import { localToday } from './today'
import { entityOfLedger } from './access'
import { NOT_OURS } from './ours'
import { RECORD_COLUMNS, isRecordTable, rowIsBlank, type RecordTable } from './record-rows'
import { enterRecordRows, enteredSentence, rowProblems } from './record-entry'
import { AttachmentError } from './attachments'
import { attachToMinuteBook, detachFromMinuteBook } from '@/modules/records/attachments'
import { readingFile } from './bill-reading'
import { RecordsError, ceaseDirector, ceaseSignificantIndividual, saveProfile } from './records'
import { refuseUnlessOurs, type Owned } from './ours'
import { actingAs } from './acting'
import { correctRecordRow, removeRecordRow, removeShareClass, renameShareClass } from './record-edit'

/**
 * Reading the corporate-records screen. The field names live in `forms.ts`
 * with everyone else's — the client screen speaks them too.
 */


export { RECORD_FIELDS }

export type { FormResult }


const attempt = (run: () => Promise<unknown>, ok: string) => attemptWith(run, ok, RecordsError)

/**
 * A message that says WHEN, and says so louder when the date is in the
 * future. Every register on this screen answers "as at" a date, and the
 * default date is today: a movement recorded for next Friday is correctly
 * invisible on today's register, and the owner met exactly that and read it
 * as a feature that did nothing (2026-09-03). Saying the date is the cheapest
 * half of the fix; the register page saying it too is the other half.
 */
function dated(verb: string, onDate: string): string {
  const today = localToday()
  return onDate > today
    ? `${verb} — dated ${onDate}, which is after today (${today}), `
      + `so a register as at today does not show it yet.`
    : `${verb} — dated ${onDate}.`
}

export async function saveProfileFromForm(f: FormData, actor: string): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['entity', g(f, RECORD_FIELDS.entityId)]], g(f, RECORD_FIELDS.ledgerId))
  if (nope) return nope
  return attempt(() => saveProfile({
    entityId: g(f, RECORD_FIELDS.entityId),
    incorporationNumber: g(f, RECORD_FIELDS.incorporationNumber) || undefined,
    businessNumber: g(f, RECORD_FIELDS.businessNumber) || undefined,
    recognitionDate: g(f, RECORD_FIELDS.recognitionDate) || undefined,
    companyType: g(f, RECORD_FIELDS.companyType) || undefined,
    // Three answers, and the empty one is a real answer: nobody has said. A
    // company nobody has classified is priced as though it were not a CCPC and
    // the SR&ED paper prints that assumption, so "" must survive the trip
    // rather than collapsing into false (0068).
    isCcpc: { yes: true, no: false }[g(f, RECORD_FIELDS.isCcpc)] ?? null,
    actor,
  }), 'Profile saved.')
}

export async function ceaseDirectorFromForm(f: FormData, actor: string): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['directorship', g(f, RECORD_FIELDS.directorshipId)]], g(f, RECORD_FIELDS.ledgerId))
  if (nope) return nope
  const ceasedOn = g(f, RECORD_FIELDS.ceasedOn)
  // Through `actingAs`: ending a term is a change to the row, and every change
  // to a register row is written to the audit log under the person (0083).
  return attempt(() => actingAs(actor, (tx) => ceaseDirector({
    directorshipId: g(f, RECORD_FIELDS.directorshipId),
    ceasedOn,
    actor,
  }, tx)), dated('Ceased — the row keeps its dates', ceasedOn))
}

export async function ceaseSiFromForm(f: FormData, actor: string): Promise<FormResult> {
  const nope = await refuseUnlessOurs([['significant_individual', g(f, RECORD_FIELDS.siId)]], g(f, RECORD_FIELDS.ledgerId))
  if (nope) return nope
  const ceasedOn = g(f, RECORD_FIELDS.ceasedOn)
  return attempt(() => actingAs(actor, (tx) => ceaseSignificantIndividual({
    id: g(f, RECORD_FIELDS.siId),
    ceasedOn,
    actor,
  }, tx)), dated('Ceased', ceasedOn))
}

/**
 * The minute book's kinds, as the CHECK constraint states them — the one list
 * (0035). `screen-data.ts` reads it the same way for the form.
 */
export async function minuteKinds(): Promise<string[]> {
  const rows = await db.execute<{ kind: string }>(sql`
    SELECT unnest(regexp_matches(pg_get_constraintdef(oid), '''([a-z_]+)''', 'g')) AS kind
      FROM pg_constraint
     WHERE conrelid = 'minute_book_entry'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%record_kind%'`)
  return rows.map((r) => r.kind)
}

/**
 * An add form's rows (docs/design/41).
 *
 * The company is the LEDGER'S, never a field: the form carries the ledger and
 * nothing else that says whose books these are, so there is no entity id for
 * a crafted form to point at another company with. The rows are read by the
 * indices that arrived (`rowIndicesIn`), a row with nothing typed in it is no
 * row, and every problem with every row is said at once before anything is
 * asked of the database.
 */
export async function enterRowsFromForm(f: FormData, actor: string): Promise<FormResult> {
  const ledgerId = g(f, RECORD_FIELDS.ledgerId)
  const table = g(f, RECORD_FIELDS.table)
  if (!isRecordTable(table)) return { error: 'That form did not say which register it adds to.' }
  const entityId = await entityOfLedger(ledgerId)
  if (!entityId) return { error: NOT_OURS }

  const rows = rowIndicesIn(f.keys())
    .map((i) => ({
      line: i + 1,
      values: Object.fromEntries(RECORD_COLUMNS[table].map((c) => [c.key, g(f, rowField(i, c.key))])),
    }))
    .filter((r) => !rowIsBlank(table, r.values))
  if (rows.length === 0) return { error: 'Nothing to enter — every row is blank.' }

  const problems = rowProblems(table, rows, table === 'minute_book' ? await minuteKinds() : [])
  if (problems.length > 0) {
    return { error: `Nothing was entered. ${problems.join('\n')}` }
  }
  const readingId = g(f, RECORD_FIELDS.readingId) || null
  let entered
  try {
    entered = await enterRecordRows({ ledgerId, entityId, table, rows, readingId, actor })
  } catch (e) {
    return { error: `Nothing was entered. ${sentenceOf(e, RecordsError)}` }
  }
  return { ok: enteredSentence(entered) + await fileReadingOnMinuteBook(ledgerId, readingId, entered.minuteIds, actor) }
}

/**
 * THE DOCUMENT A MINUTE BOOK WAS READ FROM, filed against every record it made
 * (0081) — one blob, one binding per record.
 *
 * AFTER the rows are in, and never fatal: they ARE in the minute book by the
 * time this runs, so a store that refuses must not be reported as a failed
 * entry — the rule `attachIfAny` keeps for a receipt. A reading from a sentence
 * alone has no paper, and says nothing.
 */
async function fileReadingOnMinuteBook(
  ledgerId: string, readingId: string | null, minuteIds: string[], actor: string,
): Promise<string> {
  if (!readingId || minuteIds.length === 0) return ''
  const file = await readingFile(ledgerId, readingId)
  if (!file) return ''
  let filed = 0
  const refused: string[] = []
  for (const minuteId of minuteIds) {
    try {
      await attachToMinuteBook({ ledgerId, minuteId, filename: file.filename, bytes: file.bytes, mime: file.mime, actor })
      filed += 1
    } catch (e) {
      refused.push(sentenceOf(e, AttachmentError))
    }
  }
  return filed === minuteIds.length
    ? ` ${file.filename} is filed against ${filed === 1 ? 'it' : `each of the ${filed}`}.`
    : ` ${file.filename} could not be filed against ${minuteIds.length - filed} of them (${refused[0]}); attach it from the minute book by hand.`
}

/** A document filed against one minute-book record, from its floating form (0081). */
export async function attachMinuteBookFromForm(f: FormData, actor: string): Promise<FormResult> {
  const ledgerId = g(f, RECORD_FIELDS.ledgerId)
  const minuteId = g(f, RECORD_FIELDS.minuteId)
  const nope = await refuseUnlessOurs([['minute_book_entry', minuteId]], ledgerId)
  if (nope) return nope
  const file = f.get(RECORD_FIELDS.file)
  if (!(file instanceof File) || file.size === 0) return { error: 'Choose a file first — nothing arrived to keep.' }
  try {
    await attachToMinuteBook({
      ledgerId, minuteId, filename: file.name, bytes: Buffer.from(await file.arrayBuffer()), mime: file.type, actor,
    })
    return { ok: `${file.name} filed against the record, and in the company's Minute book folder.` }
  } catch (e) {
    return { error: sentenceOf(e, AttachmentError) }
  }
}

export async function detachMinuteBookFromForm(f: FormData, actor: string): Promise<FormResult> {
  const ledgerId = g(f, RECORD_FIELDS.ledgerId)
  const paperId = g(f, RECORD_FIELDS.paperId)
  const nope = await refuseUnlessOurs([['minute_book_attachment', paperId]], ledgerId)
  if (nope) return nope
  try {
    await detachFromMinuteBook(ledgerId, paperId, actor, g(f, RECORD_FIELDS.reason))
    return { ok: 'Unfiled. The file itself stays in the store.' }
  } catch (e) {
    return { error: sentenceOf(e, AttachmentError) }
  }
}

// ------------------------------------------------------ edit and delete (0083) --

/** What each table's rows are, to the question "is this id this company's". */
const OWNED: Record<RecordTable, Owned> = {
  offices: 'corporate_office',
  minute_book: 'minute_book_entry',
  directors: 'directorship',
  transparency: 'significant_individual',
  shares: 'share_transaction',
}

/** The table and row a form names, once they are known to be this company's. */
async function rowOfForm(f: FormData): Promise<
  { error: string } | { ledgerId: string; entityId: string; table: RecordTable; id: string }
> {
  const ledgerId = g(f, RECORD_FIELDS.ledgerId)
  const table = g(f, RECORD_FIELDS.table)
  const id = g(f, RECORD_FIELDS.recordId)
  if (!isRecordTable(table)) return { error: 'That form did not say which register the row is in.' }
  const nope = await refuseUnlessOurs([[OWNED[table], id]], ledgerId)
  if (nope) return nope
  const company = await entityOfLedger(ledgerId)
  if (!company) return { error: NOT_OURS }
  return { ledgerId, entityId: company, table, id }
}

/**
 * A row put right, from the boxes its Edit opened — the add form's own columns,
 * under the same `row.0.<column>` names, judged by the same `rowProblems`.
 */
export async function correctRowFromForm(f: FormData, actor: string): Promise<FormResult> {
  const at = await rowOfForm(f)
  if ('error' in at) return at
  const values = Object.fromEntries(RECORD_COLUMNS[at.table].map((c) => [c.key, g(f, rowField(0, c.key))]))
  const problems = rowProblems(at.table, [{ line: 1, values }], at.table === 'minute_book' ? await minuteKinds() : [])
    .map((p) => p.replace(/^Row 1: (.)/, (_m, c: string) => c.toUpperCase()))
  // A row already on a register has its start; clearing it would leave a row
  // that says nothing about when it began.
  if (at.table === 'directors' && !values.appointedOn) problems.push('Appointed is missing.')
  if (at.table === 'transparency' && !values.becameOn) problems.push('Since is missing.')
  if (problems.length > 0) return { error: `Nothing was saved. ${problems.join(' ')}` }
  try {
    return { ok: await correctRecordRow({ ...at, values, actor }) }
  } catch (e) {
    return { error: `Nothing was saved. ${sentenceOf(e, RecordsError)}` }
  }
}

export async function removeRowFromForm(f: FormData, actor: string): Promise<FormResult> {
  const at = await rowOfForm(f)
  if ('error' in at) return at
  try {
    return { ok: await removeRecordRow({ ...at, actor }) }
  } catch (e) {
    return { error: `Nothing was deleted. ${sentenceOf(e, RecordsError)}` }
  }
}

export async function renameClassFromForm(f: FormData, actor: string): Promise<FormResult> {
  const ledgerId = g(f, RECORD_FIELDS.ledgerId)
  const id = g(f, RECORD_FIELDS.shareClassId)
  const nope = await refuseUnlessOurs([['share_class', id]], ledgerId)
  if (nope) return nope
  const company = await entityOfLedger(ledgerId)
  if (!company) return { error: NOT_OURS }
  try {
    return { ok: await renameShareClass({ entityId: company, id, name: g(f, RECORD_FIELDS.className), series: g(f, RECORD_FIELDS.series), actor }) }
  } catch (e) {
    return { error: sentenceOf(e, RecordsError) }
  }
}

export async function removeClassFromForm(f: FormData, actor: string): Promise<FormResult> {
  const ledgerId = g(f, RECORD_FIELDS.ledgerId)
  const id = g(f, RECORD_FIELDS.shareClassId)
  const nope = await refuseUnlessOurs([['share_class', id]], ledgerId)
  if (nope) return nope
  const company = await entityOfLedger(ledgerId)
  if (!company) return { error: NOT_OURS }
  try {
    return { ok: await removeShareClass({ entityId: company, id, actor }) }
  } catch (e) {
    return { error: sentenceOf(e, RecordsError) }
  }
}
