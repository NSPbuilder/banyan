import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, type Tx } from './acting'
import { minuteBookLinks, refileMinuteBookLinks, unlinkMinuteBookLinks } from '@/modules/records/attachments'
import { classNamed, partyNamed, type Entered } from './record-entry'
import { TABLE_WORDS, type RecordTable } from './record-rows'
import { OPEN_THE_REGISTER, RecordsError, asSentence } from './records'

/**
 * PUTTING A CORPORATE-RECORD ROW RIGHT, OR TAKING IT OUT (0083).
 *
 * The owner (2026-09-16): 「minute book不能修改編輯或者刪除欸。所有的紀錄儘量都可以
 * 編輯刪除」. Every register could only grow; a row typed wrong — a date, a
 * person a reading matched to the wrong name, an issue entered twice — had no
 * way out. Ceasing stays what it was, a date for something that happened. This
 * is for what did not.
 *
 * An edit takes the row in the add form's own columns (`record-rows.ts`), so
 * the person sees the same boxes they entered it with, and it is judged by the
 * same `rowProblems` and resolves names and classes by the same `partyNamed`
 * and `classNamed` the add door does. What only an edit has to say is here:
 *
 *   offices     an office's addresses are a chain — each ends the day before
 *               the next begins — so moving a start date moves the end of the
 *               one before it, and deleting a row gives its dates back to it.
 *   the minute  a record's documents are linked in the Finder tree under its
 *   book        date, kind and title, so those links follow a corrected record
 *               and go with a removed one. The blobs stay in the store.
 *   shares      the register changes only inside `erp.register_edit`; a
 *               transfer is its two rows, changed in one statement and removed
 *               together; nobody's holding may go negative on any day, which
 *               the database judges when the transaction ends — so an issue a
 *               later transfer rests on cannot be deleted from under it.
 *
 * Every change and removal is written to the audit log with the row before and
 * after, by the database (0083), under the name `acting` gives it.
 */

export type RowValues = Record<string, string>

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : null)

type Said = Pick<Entered, 'newParties' | 'fromElsewhere' | 'newClasses'>

function saidAlso(s: Said): string {
  const bits: string[] = []
  if (s.newParties.length > 0) bits.push(`Added to this company's list: ${s.newParties.join(', ')}.`)
  if (s.fromElsewhere.length > 0) {
    const who = s.fromElsewhere.map((p) => (p.role ? `${p.name} (now a ${p.role} here)` : `${p.name} (no role given here)`))
    bits.push(`Found on another company's list and used here: ${who.join(', ')}.`)
  }
  if (s.newClasses.length > 0) bits.push(`New share class: ${s.newClasses.join(', ')}.`)
  return bits.length ? ` ${bits.join(' ')}` : ''
}

const gone = (table: RecordTable) =>
  new RecordsError('NO_ROW', `There is no such ${TABLE_WORDS[table].one} in these books.`)

/** A transaction that says who is acting and turns a database refusal into a sentence. */
async function inTx<T>(actor: string, run: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      await acting(tx, actor)
      return run(tx)
    })
  } catch (e) {
    if (e instanceof RecordsError) throw e
    const text = `${String(e)} ${String((e as { cause?: unknown }).cause ?? '')}`
    if (text.includes('corporate_office_no_overlap')) {
      throw new RecordsError('OVERLAP', 'That would give the office two addresses on the same day.')
    }
    if (text.includes('directorship_no_overlap')) {
      throw new RecordsError('OVERLAP', 'That term would overlap another term of the same person.')
    }
    if (text.includes('significant_individual_no_overlap')) {
      throw new RecordsError('OVERLAP', 'That would overlap another entry for the same person.')
    }
    if (text.includes('share_class_unique')) {
      throw new RecordsError('CLASS_TAKEN', 'This company already has a class by that name.')
    }
    asSentence(e)
  }
}

// -------------------------------------------------------------------- edit --

export async function correctRecordRow(input: {
  ledgerId: string; entityId: string; table: RecordTable; id: string; values: RowValues; actor: string
}): Promise<string> {
  const { ledgerId, entityId: E, table, id, values: v, actor } = input
  const said: Said = { newParties: [], fromElsewhere: [], newClasses: [] }
  const one = TABLE_WORDS[table].one

  if (table === 'minute_book') {
    const links = await minuteBookLinks(ledgerId, id)
    if (!links) throw gone(table)
    await inTx(actor, (tx) => tx.execute(sql`
      UPDATE minute_book_entry
         SET record_kind = ${v.recordKind}, on_date = ${v.onDate}::date, title = ${v.title},
             kept_at = ${v.keptAt}, note = ${blank(v.note)}
       WHERE id = ${id}::uuid AND entity_id = ${E}::uuid`))
    await refileMinuteBookLinks(ledgerId, links)
    return `Saved the ${one}.${links.papers.length ? ' Its documents are filed under the new name.' : ''}`
  }

  await inTx(actor, async (tx) => {
    switch (table) {
      case 'offices': return correctOffice(tx, E, id, v)
      case 'directors': return correctDirector(tx, E, id, v, actor, said)
      case 'transparency': return correctIndividual(tx, E, id, v, actor, said)
      case 'shares': return correctMovement(tx, E, id, v, actor, said)
    }
  })
  return `Saved the ${one}.${saidAlso(said)}`
}

async function correctOffice(tx: Tx, E: string, id: string, v: RowValues) {
  const [row] = await tx.execute<{ office: string; effective_from: string; effective_to: string | null }>(sql`
    SELECT office, effective_from::text, effective_to::text FROM corporate_office
     WHERE id = ${id}::uuid AND entity_id = ${E}::uuid FOR UPDATE`)
  if (!row) throw gone('offices')
  if (v.office !== row.office) {
    throw new RecordsError('OFFICE_FIXED',
      `This is a ${row.office} office address. To file it under the other office, delete it and add it there.`)
  }
  const [prev] = await tx.execute<{ id: string; effective_from: string }>(sql`
    SELECT id::text, effective_from::text FROM corporate_office
     WHERE entity_id = ${E}::uuid AND office = ${row.office}
       AND effective_to = ${row.effective_from}::date - 1`)
  const from = v.effectiveFrom
  if (prev && from <= prev.effective_from) {
    throw new RecordsError('BEFORE_PREVIOUS',
      `The address before this one began on ${prev.effective_from}; this one has to begin after it.`)
  }
  if (row.effective_to && from > row.effective_to) {
    throw new RecordsError('AFTER_NEXT',
      `This address ended on ${row.effective_to}, when the next one began; it has to begin by then.`)
  }
  // Moving earlier shortens the previous address first; moving later lengthens
  // it after — either way the two never claim the same day.
  const previousEnds = prev && sql`
    UPDATE corporate_office SET effective_to = ${from}::date - 1 WHERE id = ${prev.id}::uuid`
  if (previousEnds && from < row.effective_from) await tx.execute(previousEnds)
  await tx.execute(sql`
    UPDATE corporate_office
       SET delivery_address = ${v.deliveryAddress}, delivery_city = ${v.deliveryCity},
           delivery_postal = ${blank(v.deliveryPostal)}, effective_from = ${from}::date
     WHERE id = ${id}::uuid`)
  if (previousEnds && from > row.effective_from) await tx.execute(previousEnds)
}

async function correctDirector(tx: Tx, E: string, id: string, v: RowValues, actor: string, said: Said) {
  const [row] = await tx.execute<{ party_id: string; prescribed_delivery: string }>(sql`
    SELECT party_id::text, prescribed_delivery FROM directorship
     WHERE id = ${id}::uuid AND entity_id = ${E}::uuid FOR UPDATE`)
  if (!row) throw gone('directors')
  const partyId = await partyNamed(tx, E, v.name, {
    role: 'director', from: v.appointedOn, person: true, grant: true, actor,
    made: said.newParties, elsewhere: said.fromElsewhere,
  })
  let address = blank(v.address) ?? (partyId === row.party_id ? row.prescribed_delivery : null)
  if (!address) {
    const [addr] = await tx.execute<{ line: string | null }>(sql`
      SELECT concat_ws(', ', line1, line2, city, region, postal_code) AS line
        FROM party_address WHERE party_id = ${partyId}::uuid ORDER BY purpose LIMIT 1`)
    address = addr?.line || null
  }
  if (!address) {
    throw new RecordsError('NO_ADDRESS', `A director needs a prescribed address, and ${v.name} has none on file to borrow.`)
  }
  await tx.execute(sql`
    UPDATE directorship
       SET party_id = ${partyId}::uuid, prescribed_delivery = ${address},
           appointed_on = ${v.appointedOn}::date, ceased_on = ${blank(v.ceasedOn)}::date
     WHERE id = ${id}::uuid`)
}

async function correctIndividual(tx: Tx, E: string, id: string, v: RowValues, actor: string, said: Said) {
  const [row] = await tx.execute<{ id: string }>(sql`
    SELECT id::text FROM significant_individual
     WHERE id = ${id}::uuid AND entity_id = ${E}::uuid FOR UPDATE`)
  if (!row) throw gone('transparency')
  const partyId = await partyNamed(tx, E, v.name, {
    role: 'shareholder', from: v.becameOn, person: true, grant: false, actor,
    made: said.newParties, elsewhere: said.fromElsewhere,
  })
  // The birth date and the address are never sent to the screen, so a box left
  // blank means "as it is", not "remove it".
  await tx.execute(sql`
    UPDATE significant_individual
       SET party_id = ${partyId}::uuid, how_control = ${v.howControl},
           became_on = ${v.becameOn}::date, ceased_on = ${blank(v.ceasedOn)}::date,
           birth_date = COALESCE(${blank(v.birthDate)}::date, birth_date),
           last_known_address = COALESCE(${blank(v.lastKnownAddress)}, last_known_address),
           citizen_or_pr = ${v.citizenOrPr === 'yes'},
           citizenships = ${blank(v.citizenships)},
           tax_resident_ca = ${v.taxResidentCa === 'yes'}
     WHERE id = ${id}::uuid`)
}

/** The register's own word for a row, in the form's words. */
export const movementKind = (kind: string) => (kind === 'transfer_in' || kind === 'transfer_out' ? 'transfer' : kind)

async function correctMovement(tx: Tx, E: string, id: string, v: RowValues, actor: string, said: Said) {
  const [row] = await tx.execute<{ kind: string; transfer_group: string | null; details: string }>(sql`
    SELECT t.kind, t.transfer_group::text, t.details FROM share_transaction t
      JOIN share_class c ON c.id = t.share_class_id
     WHERE t.id = ${id}::uuid AND c.entity_id = ${E}::uuid FOR UPDATE OF t`)
  if (!row) throw gone('shares')
  const kind = movementKind(row.kind)
  if (v.kind !== kind) {
    throw new RecordsError('KIND_FIXED',
      `This is ${kind === 'issue' ? 'an issue' : kind === 'transfer' ? 'a transfer' : 'a cancellation'}. `
      + 'To record it as something else, delete it and add the right movement.')
  }
  await tx.execute(OPEN_THE_REGISTER)
  const classId = await classNamed(tx, E, v.shareClass, actor, said.newClasses)
  const party = (name: string, giving: boolean) => partyNamed(tx, E, name, {
    role: 'shareholder', from: v.onDate, giving, person: false, grant: true, actor,
    made: said.newParties, elsewhere: said.fromElsewhere,
  })
  const q = BigInt(v.quantity)
  const details = blank(v.details) ?? row.details
  const consideration = blank(v.consideration)
  if (kind === 'issue') {
    await tx.execute(sql`
      UPDATE share_transaction
         SET share_class_id = ${classId}::uuid, party_id = ${await party(v.to, false)}::uuid,
             on_date = ${v.onDate}::date, delta = ${q}, consideration = ${consideration},
             certificate_no = ${blank(v.certificateNo)}, details = ${details}
       WHERE id = ${id}::uuid`)
  } else if (kind === 'cancellation') {
    await tx.execute(sql`
      UPDATE share_transaction
         SET share_class_id = ${classId}::uuid, party_id = ${await party(v.from, true)}::uuid,
             on_date = ${v.onDate}::date, delta = ${-q}, consideration = ${consideration},
             certificate_no = ${blank(v.balanceNo)}, surrendered_no = ${blank(v.surrenderedNo)},
             details = ${details}
       WHERE id = ${id}::uuid`)
  } else {
    const from = await party(v.from, true)
    const to = await party(v.to, false)
    // Both sides in ONE statement: the group must net to zero whenever it is
    // judged, and a side changed on its own does not.
    await tx.execute(sql`
      UPDATE share_transaction
         SET share_class_id = ${classId}::uuid, on_date = ${v.onDate}::date,
             details = ${details}, consideration = ${consideration},
             party_id = CASE kind WHEN 'transfer_out' THEN ${from}::uuid ELSE ${to}::uuid END,
             delta = CASE kind WHEN 'transfer_out' THEN ${-q} ELSE ${q} END,
             certificate_no = CASE kind WHEN 'transfer_out' THEN ${blank(v.balanceNo)} ELSE ${blank(v.certificateNo)} END,
             surrendered_no = CASE kind WHEN 'transfer_out' THEN ${blank(v.surrenderedNo)} END
       WHERE transfer_group = ${row.transfer_group}::uuid`)
  }
}

// ------------------------------------------------------------------ delete --

export async function removeRecordRow(input: {
  ledgerId: string; entityId: string; table: RecordTable; id: string; actor: string
}): Promise<string> {
  const { ledgerId, entityId: E, table, id, actor } = input
  const one = TABLE_WORDS[table].one

  if (table === 'minute_book') {
    const links = await minuteBookLinks(ledgerId, id)
    if (!links) throw gone(table)
    await inTx(actor, (tx) => tx.execute(sql`
      DELETE FROM minute_book_entry WHERE id = ${id}::uuid AND entity_id = ${E}::uuid`))
    await unlinkMinuteBookLinks(links)
    const n = links.papers.length
    return `Deleted the ${one} "${links.head.title}".`
      + (n ? ` Its ${n === 1 ? 'document was' : `${n} documents were`} unfiled; the file${n === 1 ? ' stays' : 's stay'} in the store.` : '')
  }

  let also = ''
  await inTx(actor, async (tx) => {
    switch (table) {
      case 'offices': {
        const [row] = await tx.execute<{ office: string; effective_from: string; effective_to: string | null }>(sql`
          DELETE FROM corporate_office WHERE id = ${id}::uuid AND entity_id = ${E}::uuid
          RETURNING office, effective_from::text, effective_to::text`)
        if (!row) throw gone(table)
        // The address before it takes its days back: to the day this one
        // ended, or open again if this one was the current address.
        const reopened = await tx.execute<{ id: string }>(sql`
          UPDATE corporate_office SET effective_to = ${row.effective_to}::date
           WHERE entity_id = ${E}::uuid AND office = ${row.office}
             AND effective_to = ${row.effective_from}::date - 1
          RETURNING id::text`)
        if (reopened.length > 0) {
          also = row.effective_to
            ? ` The address before it now runs to ${row.effective_to}.`
            : ' The address before it is the current one again.'
        }
        return
      }
      case 'directors':
      case 'transparency': {
        const t = table === 'directors' ? sql.raw('directorship') : sql.raw('significant_individual')
        const rows = await tx.execute<{ id: string }>(sql`
          DELETE FROM ${t} WHERE id = ${id}::uuid AND entity_id = ${E}::uuid RETURNING id::text`)
        if (rows.length === 0) throw gone(table)
        return
      }
      case 'shares': {
        await tx.execute(OPEN_THE_REGISTER)
        const rows = await tx.execute<{ id: string }>(sql`
          DELETE FROM share_transaction t
           USING share_class c
           WHERE c.id = t.share_class_id AND c.entity_id = ${E}::uuid
             AND (t.id = ${id}::uuid
                  OR t.transfer_group = (SELECT transfer_group FROM share_transaction WHERE id = ${id}::uuid))
          RETURNING t.id::text`)
        if (rows.length === 0) throw gone(table)
        if (rows.length === 2) also = ' Both sides of the transfer went.'
        return
      }
    }
  })
  return `Deleted the ${one}.${also}`
}

// ----------------------------------------------------------- share classes --

export async function renameShareClass(input: {
  entityId: string; id: string; name: string; series: string; actor: string
}): Promise<string> {
  const name = input.name.trim()
  if (!name) throw new RecordsError('NO_NAME', 'A class needs a name.')
  await inTx(input.actor, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      UPDATE share_class SET name = ${name}, series = ${blank(input.series)}
       WHERE id = ${input.id}::uuid AND entity_id = ${input.entityId}::uuid RETURNING id::text`)
    if (rows.length === 0) throw new RecordsError('NO_ROW', 'There is no such share class in these books.')
  })
  return `Saved the class as ${name}${blank(input.series) ? ` — ${blank(input.series)}` : ''}.`
}

export async function removeShareClass(input: { entityId: string; id: string; actor: string }): Promise<string> {
  let label = ''
  await inTx(input.actor, async (tx) => {
    const [c] = await tx.execute<{ label: string; movements: number }>(sql`
      SELECT CASE WHEN series IS NULL THEN name ELSE name || ' — ' || series END AS label,
             (SELECT count(*)::int FROM share_transaction t WHERE t.share_class_id = c.id) AS movements
        FROM share_class c WHERE c.id = ${input.id}::uuid AND c.entity_id = ${input.entityId}::uuid`)
    if (!c) throw new RecordsError('NO_ROW', 'There is no such share class in these books.')
    if (c.movements > 0) {
      throw new RecordsError('CLASS_IN_USE',
        `${c.label} has ${c.movements} movement${c.movements === 1 ? '' : 's'} on the register. `
        + 'Delete those first, or rename the class instead.')
    }
    label = c.label
    await tx.execute(sql`DELETE FROM share_class WHERE id = ${input.id}::uuid`)
  })
  return `Deleted the class ${label}.`
}
