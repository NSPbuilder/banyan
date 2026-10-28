import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, type Tx } from './acting'
import { createParty, grantRole, type PartyRole } from './parties'
import { endsLikeACompany } from './prefill'
import { RECORD_COLUMNS, TABLE_WORDS, type RecordTable } from './record-rows'
import {
  RecordsError, addMinuteBookEntry, appointDirector, cancelShares, ceaseDirector,
  ceaseSignificantIndividual, createShareClass, issueShares, recordSignificantIndividual,
  setOffice, transferShares,
} from './records'
import { localToday } from './today'

/**
 * ENTERING AN ADD FORM'S ROWS — all of them, or none.
 *
 * The corporate record's add forms (docs/design/41) take several rows at once,
 * because a minute book is several events at once and a reading of one fills
 * the form with them. Each row still goes through the door a single row always
 * went through — `appointDirector`, `issueShares`, `setOffice` — so what the
 * register refuses about one row it refuses here. What this file adds is only
 * what a batch needs:
 *
 *   one transaction   a refusal at row nine takes rows one to eight back, and
 *                     says which row it was. A register that half-took a minute
 *                     book is worse than one that took none of it.
 *   date order        rows go in by their own date, so a director's resignation
 *                     read before their appointment still lands after it — and
 *                     within a day by `sameDayRank`, so a transfer never
 *                     precedes the issue it transfers.
 *   names             a row names people, not ids: the person or company is
 *                     found on the list by `party_name_key` (0026) — the index's
 *                     own expression — and added to it when a row brings
 *                     somebody new. Only somebody RECEIVING shares or joining a
 *                     register can be new; nobody gives up shares they never
 *                     held, so a stranger in `from` is refused, as the old
 *                     transfer box refused a new party there.
 *   classes           a class is found by its name (and series); a row naming a
 *                     class this company has not got creates it, and says so.
 *   the reading       when the rows came from a reading, the reading is marked
 *                     for this table FIRST, inside the same transaction (0080),
 *                     so a second press — another tab, a resubmitted form — is
 *                     refused before anything is written, not after.
 */

export type EnterRow = { line: number; values: Record<string, string> }

export type Entered = {
  table: RecordTable
  count: number
  newParties: string[]
  /**
   * People and companies found on ANOTHER company's list and used here — the
   * name matched, so no new party was made. Said in the sentence, with the role
   * they were given here if any: party names are one list across every company
   * (0026), and the owner asked that using somebody from elsewhere never be
   * silent (2026-09-16, critic round 1).
   */
  fromElsewhere: Array<{ name: string; role: PartyRole | null }>
  newClasses: string[]
  /** The minute-book records this form made, so the reading's document can be filed against them (0081). */
  minuteIds: string[]
  /** Rows dated after today: a register as at today does not show them yet. */
  ahead: number
  /** The latest of those dates, which the sentence names. */
  furthest: string | null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A share movement judged when its STATEMENT ends rather than when the
 * transaction commits (0035 defers both checks), so a refusal names the row
 * that caused it instead of arriving, row-less, at the very end. Named, on a
 * line of its own, so the mutation battery can anchor on the line that runs it.
 */
const JUDGED_PER_ROW = sql`SET CONSTRAINTS trg_transfer_group, trg_holding_never_negative IMMEDIATE`

/** The date a row happens on, for ordering and for "after today". */
const dateOf = (table: RecordTable, v: Record<string, string>): string => {
  switch (table) {
    case 'directors': return v.appointedOn || v.ceasedOn || ''
    case 'transparency': return v.becameOn || v.ceasedOn || ''
    case 'offices': return v.effectiveFrom || ''
    default: return v.onDate || ''
  }
}

/**
 * Within one day, what has to come first: an issue before the transfer of the
 * shares it issued, a transfer before a cancellation, and a term's start before
 * a row that only ends one. A minute book's first page is all one date — the
 * company is incorporated, shares are issued and some change hands the same
 * day — and the person's row order is not a promise about any of that.
 */
const sameDayRank = (table: RecordTable, v: Record<string, string>): number => {
  if (table === 'shares') return v.kind === 'issue' ? 0 : v.kind === 'transfer' ? 1 : 2
  if (table === 'directors') return v.appointedOn ? 0 : 1
  if (table === 'transparency') return v.becameOn ? 0 : 1
  return 0
}

/**
 * Everything wrong with the rows that can be said without the database — every
 * row, not the first — so a form of twenty rows is fixed in one pass. The same
 * rule the SR&ED paste box keeps: one row wrong and nothing goes in.
 */
export function rowProblems(table: RecordTable, rows: EnterRow[], minuteKinds: readonly string[]): string[] {
  const out: string[] = []
  for (const { line, values: v } of rows) {
    const say = (what: string) => out.push(`Row ${line}: ${what}`)
    for (const c of RECORD_COLUMNS[table]) {
      const value = v[c.key] ?? ''
      if (c.required && !value) say(`${c.label} is missing.`)
      else if (value && c.type === 'date' && !DATE.test(value)) say(`${c.label} "${value}" is not a date.`)
      else if (value && c.type === 'count' && !/^[1-9]\d*$/.test(value)) say(`${c.label} "${value}" is not a whole number of shares.`)
      else if (value && c.type === 'choice' && c.options && !c.options.some((o) => o.value === value)) {
        say(`${c.label} "${value}" is not one of ${c.options.map((o) => o.label).join(', ')}.`)
      }
    }
    if (table === 'minute_book' && v.recordKind && !minuteKinds.includes(v.recordKind)) {
      say(`"${v.recordKind}" is not a kind of record the minute book keeps.`)
    }
    if (table === 'directors' || table === 'transparency') {
      const from = table === 'directors' ? v.appointedOn : v.becameOn
      const label = table === 'directors' ? 'Appointed' : 'Since'
      if (!from && !v.ceasedOn) say(`give ${label} or Ceased — a row with neither says nothing happened.`)
      if (from && v.ceasedOn && v.ceasedOn < from) say(`Ceased ${v.ceasedOn} is before ${label} ${from}.`)
      // Only a NEW entry says how: a row that just ends somebody's entry is
      // about the one already on the register, which said so when it began.
      if (table === 'transparency' && from && !v.howControl) say('How they control is missing.')
      if (table === 'transparency' && from) {
        if (!v.citizenOrPr) say('Choose whether they are a Canadian citizen or PR.')
        if (!v.taxResidentCa) say('Choose whether they are a Canadian tax resident.')
        if (v.citizenOrPr === 'no' && !v.citizenships?.trim()) say('Citizenships is needed when neither a Canadian citizen nor PR.')
      }
    }
    if (table === 'shares') {
      if (v.kind === 'issue' && !v.to) say('an issue needs To — who the shares were issued to.')
      if (v.kind === 'issue' && v.from) say('an issue has no From; the company is issuing them.')
      if (v.kind === 'transfer' && (!v.from || !v.to)) say('a transfer needs both From and To.')
      if (v.kind === 'transfer' && v.from && v.to && v.from.toLowerCase() === v.to.toLowerCase()) {
        say('a transfer from somebody to themselves moves nothing.')
      }
      if (v.kind === 'cancellation' && !v.from) say('a cancellation needs From — whose shares were taken back.')
      if (v.kind === 'cancellation' && v.to) say('a cancellation has no To; the shares stop existing.')
    }
  }
  return out
}

/**
 * The person or company a row names, on this company's list.
 *
 * `giving` is true for somebody giving shares up: they must already hold some,
 * so they must already be somebody. Everybody else a row names may be new, and
 * is added with the role the row gives them, from the row's date.
 */
export async function partyNamed(tx: Tx, entityId: string, name: string, opts: {
  role: PartyRole; from: string; giving?: boolean; actor: string; made: string[]
  /** Where a match from another company's list is written down, for the sentence. */
  elsewhere: Entered['fromElsewhere']
  /**
   * Whether somebody ALREADY on the list is given the role here when they lack
   * it — a director of the other company appointed to this one. Not for the
   * transparency register: being significant is not being a shareholder, and
   * the role is only what a brand-new entry on the list needs to exist at all.
   */
  grant: boolean
  /** Directors and significant individuals are people; a shareholder may be a company. */
  person: boolean
}): Promise<string> {
  const [found] = await tx.execute<{ id: string; name: string; here: number; as_role: number }>(sql`
    SELECT p.id::text, p.name,
           (SELECT count(*)::int FROM party_role r WHERE r.party_id = p.id AND r.entity_id = ${entityId}::uuid) AS here,
           (SELECT count(*)::int FROM party_role r WHERE r.party_id = p.id AND r.entity_id = ${entityId}::uuid
               AND r.role = ${opts.role}) AS as_role
      FROM party p WHERE p.is_active AND party_name_key(p.name) = party_name_key(${name})`)
  if (found) {
    const granting = opts.grant && found.as_role === 0
    if (granting) {
      await grantRole({ partyId: found.id, entityId, role: opts.role, heldFrom: opts.from, actor: opts.actor }, tx)
    }
    // Nobody by this name on THIS company's list: the match is somebody from
    // another company's, and the sentence says so — once per name.
    if (found.here === 0 && !opts.elsewhere.some((e) => e.name === found.name)) {
      opts.elsewhere.push({ name: found.name, role: granting ? opts.role : null })
    }
    return found.id
  }
  if (opts.giving) {
    throw new RecordsError('NOT_A_HOLDER',
      `${name} is not on this company's list, and nobody gives up shares they never held.`)
  }
  const made = await createParty({
    kind: opts.person || !endsLikeACompany(name) ? 'person' : 'organisation',
    name,
    roles: [{ entityId, role: opts.role, heldFrom: opts.from }],
    actor: opts.actor,
  }, tx)
  opts.made.push(made.name)
  return made.id
}

/** A class by its name as the row gives it — `Class A`, or `Class A — Series 1` as the screens print it. */
export async function classNamed(tx: Tx, entityId: string, label: string, actor: string, made: string[]): Promise<string> {
  const [name, series] = label.split(/\s+—\s+/, 2).map((s) => s.trim())
  const [found] = await tx.execute<{ id: string }>(sql`
    SELECT id::text FROM share_class
     WHERE entity_id = ${entityId}::uuid AND lower(name) = lower(${name})
       AND lower(COALESCE(series, '')) = lower(${series ?? ''})`)
  if (found) return found.id
  const id = await createShareClass({ entityId, name, series: series || undefined, actor }, tx)
  made.push(label)
  return id!
}

/** The one open term a person has on a register, or null. */
async function openTerm(tx: Tx, table: 'directorship' | 'significant_individual', entityId: string, partyId: string) {
  const since = table === 'directorship' ? sql`appointed_on` : sql`became_on`
  const [row] = await tx.execute<{ id: string; since: string }>(sql`
    SELECT id::text, ${since}::text AS since FROM ${sql.raw(table)}
     WHERE entity_id = ${entityId}::uuid AND party_id = ${partyId}::uuid AND ceased_on IS NULL
     ORDER BY ${since} DESC LIMIT 1`)
  return row ?? null
}

async function enterOne(tx: Tx, table: RecordTable, entityId: string, v: Record<string, string>,
  actor: string, done: Entered) {
  const blankless = (s: string) => s || undefined
  switch (table) {
    case 'offices':
      await setOffice({
        entityId, office: v.office as 'registered' | 'records',
        deliveryAddress: v.deliveryAddress, deliveryCity: v.deliveryCity,
        deliveryPostal: blankless(v.deliveryPostal), effectiveFrom: v.effectiveFrom, actor,
      }, tx)
      return
    case 'minute_book': {
      const made = await addMinuteBookEntry({
        entityId, recordKind: v.recordKind, onDate: v.onDate, title: v.title,
        keptAt: v.keptAt, note: blankless(v.note), actor,
      }, tx)
      if (made) done.minuteIds.push(made)
      return
    }
    case 'directors':
    case 'transparency': {
      const directors = table === 'directors'
      const since = directors ? v.appointedOn : v.becameOn
      const partyId = await partyNamed(tx, entityId, v.name, {
        role: directors ? 'director' : 'shareholder', from: since || v.ceasedOn,
        person: true, grant: directors, actor, made: done.newParties, elsewhere: done.fromElsewhere,
      })
      const open = await openTerm(tx, directors ? 'directorship' : 'significant_individual', entityId, partyId)
      // A row with no start, or the start of the term already open, is about
      // THAT term: it can only end it.
      if (!since || (open && open.since === since)) {
        if (!open) {
          throw new RecordsError('NOT_SERVING', `${v.name} has no ${directors ? 'term as a director' : 'entry'} still open to end.`)
        }
        if (!v.ceasedOn) {
          throw new RecordsError('NOTHING_NEW',
            `${v.name} is already on the register from ${open.since}; this row adds nothing.`)
        }
        if (directors) await ceaseDirector({ directorshipId: open.id, ceasedOn: v.ceasedOn, actor }, tx)
        else await ceaseSignificantIndividual({ id: open.id, ceasedOn: v.ceasedOn, actor }, tx)
        return
      }
      const id = directors
        ? await appointDirector({
            entityId, partyId, appointedOn: since, prescribedDelivery: blankless(v.address), actor,
          }, tx)
        : await recordSignificantIndividual({
            entityId, partyId, becameOn: since, howControl: v.howControl,
            birthDate: blankless(v.birthDate), lastKnownAddress: blankless(v.lastKnownAddress),
            citizenOrPr: v.citizenOrPr === 'yes', citizenships: blankless(v.citizenships),
            taxResidentCa: v.taxResidentCa === 'yes', actor,
          }, tx)
      if (v.ceasedOn && id) {
        if (directors) await ceaseDirector({ directorshipId: id, ceasedOn: v.ceasedOn, actor }, tx)
        else await ceaseSignificantIndividual({ id, ceasedOn: v.ceasedOn, actor }, tx)
      }
      return
    }
    case 'shares': {
      const shareClassId = await classNamed(tx, entityId, v.shareClass, actor, done.newClasses)
      const quantity = BigInt(v.quantity)
      const party = (name: string, giving: boolean) => partyNamed(tx, entityId, name, {
        role: 'shareholder', from: v.onDate, giving, person: false, grant: true, actor, made: done.newParties,
        elsewhere: done.fromElsewhere,
      })
      const particulars = { consideration: blankless(v.consideration) }
      if (v.kind === 'issue') {
        await issueShares({
          shareClassId, partyId: await party(v.to, false), onDate: v.onDate, quantity,
          details: v.details || 'Issued', ...particulars, certificateNo: blankless(v.certificateNo), actor,
        }, tx)
      } else if (v.kind === 'transfer') {
        await transferShares({
          shareClassId, fromPartyId: await party(v.from, true), toPartyId: await party(v.to, false),
          onDate: v.onDate, quantity, details: v.details || 'Transfer', ...particulars,
          surrenderedNo: blankless(v.surrenderedNo), certificateNo: blankless(v.certificateNo),
          balanceNo: blankless(v.balanceNo), actor,
        }, tx)
      } else {
        await cancelShares({
          shareClassId, partyId: await party(v.from, true), onDate: v.onDate, quantity,
          details: v.details || 'Cancelled', ...particulars,
          surrenderedNo: blankless(v.surrenderedNo), balanceNo: blankless(v.balanceNo), actor,
        }, tx)
      }
      return
    }
  }
}

/**
 * Enter an add form's rows. `rowProblems` has been asked first by the caller
 * and came back empty; the database is asked the rest, row by row, inside one
 * transaction.
 */
export async function enterRecordRows(input: {
  ledgerId: string; entityId: string; table: RecordTable; rows: EnterRow[]
  readingId: string | null; actor: string
}): Promise<Entered> {
  const { table, entityId, actor } = input
  if (input.rows.length === 0) {
    throw new RecordsError('NO_ROWS', 'Nothing to enter — every row is blank.')
  }
  const done: Entered = {
    table, count: 0, newParties: [], fromElsewhere: [], newClasses: [], minuteIds: [], ahead: 0, furthest: null,
  }
  const today = localToday()
  // By date; within a day by what must come first; then in the person's order,
  // because sort is stable.
  const ordered = [...input.rows].sort((a, b) =>
    dateOf(table, a.values).localeCompare(dateOf(table, b.values))
    || sameDayRank(table, a.values) - sameDayRank(table, b.values))

  await db.transaction(async (tx) => {
    await acting(tx, actor)
    await tx.execute(JUDGED_PER_ROW)

    if (input.readingId) {
      const marked = await tx.execute<{ id: string }>(sql`
        UPDATE ai_bill_reading
           SET records_entered = records_entered || jsonb_build_object(
                 ${table}::text, jsonb_build_object('at', now(), 'by', ${actor}::text, 'rows', ${input.rows.length}::int))
         WHERE id = ${input.readingId}::uuid AND ledger_id = ${input.ledgerId}::uuid
           AND records_entered -> ${table}::text IS NULL
         RETURNING id::text`)
      if (marked.length === 0) {
        const [there] = await tx.execute<{ id: string }>(sql`
          SELECT id::text FROM ai_bill_reading WHERE id = ${input.readingId}::uuid AND ledger_id = ${input.ledgerId}::uuid`)
        throw there
          ? new RecordsError('READING_USED',
              `The rows of that reading are already in the ${TABLE_WORDS[table].title.toLowerCase()} — `
              + 'entering them again would record everything twice. Add any row still missing by hand.')
          : new RecordsError('NO_READING', 'That reading is not in these books.')
      }
    }

    for (const row of ordered) {
      try {
        await enterOne(tx, table, entityId, row.values, actor, done)
      } catch (e) {
        const message = e instanceof Error ? e.message.split('\n')[0] : String(e)
        throw new RecordsError(e instanceof RecordsError ? e.code : 'REFUSED', `Row ${row.line}: ${message}`)
      }
      done.count += 1
      const on = dateOf(table, row.values)
      if (on > today) {
        done.ahead += 1
        if (done.furthest === null || on > done.furthest) done.furthest = on
      }
    }
  })
  return done
}

/** What the form says afterwards — the count, who and what was new, and whether any of it is ahead of today. */
export function enteredSentence(e: Entered): string {
  const words = TABLE_WORDS[e.table]
  const bits = [`Entered ${e.count} ${e.count === 1 ? words.one : words.many}.`]
  if (e.newParties.length > 0) bits.push(`Added to this company's list: ${e.newParties.join(', ')}.`)
  if (e.fromElsewhere.length > 0) {
    const who = e.fromElsewhere.map((p) => (p.role ? `${p.name} (now a ${p.role} here)` : `${p.name} (no role given here)`))
    bits.push(`Found on another company's list and used here: ${who.join(', ')}.`)
  }
  if (e.newClasses.length > 0) bits.push(`New share class: ${e.newClasses.join(', ')}.`)
  // Said with the date, and louder when it is ahead: every register here
  // answers "as at", and a movement recorded for next Friday is correctly
  // invisible on today's — which the owner once met and read as a feature that
  // did nothing (2026-09-03). The single-row doors said so; the rows door does.
  if (e.ahead > 0) {
    const ahead = e.ahead === e.count ? (e.count === 1 ? 'It is' : 'All of them are') : `${e.ahead} of them are`
    const when = e.ahead === 1 ? `dated ${e.furthest}` : `dated as late as ${e.furthest}`
    bits.push(`${ahead} ${when}, which is after today (${localToday()}), `
      + `so a register as at today does not show ${e.ahead === 1 ? 'it' : 'them'} yet.`)
  }
  return bits.join(' ')
}
