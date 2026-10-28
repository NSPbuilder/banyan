import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { actingAs, type Runner } from './acting'
import { auditRow } from './audit-row'
import { partyAddressLine } from './parties'

/**
 * Corporate records: what a BC company must keep, kept as data.
 *
 * Every statute reference lives in `docs/design/05-corporate-records.md` and
 * only there. This module knows the SHAPES the Act implies — registers are
 * as-of, ceasing is a date, the securities register's movements are its
 * history — without repeating a single section number. Putting a row right
 * that was ENTERED wrong is `record-edit.ts` (0083): a mistake is not an event,
 * and the audit log keeps what the row said before.
 *
 * Identity is `party`'s; what lives here is the relationship and the fields
 * the Act hangs on it. The prescribed address deliberately freezes on the
 * directorship row: a register as at 2024 keeps saying what was true in 2024
 * when the person later moves house.
 */

export class RecordsError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RecordsError'
  }
}

const first = (msg: string) => msg.split('\n')[0]

/**
 * Open the securities register for THIS transaction, and only this one (0083):
 * its Edit and Delete, and removing a whole company, are the doors that may
 * change or remove a movement. Transaction-local, so it cannot leak.
 */
export const OPEN_THE_REGISTER = sql`SELECT set_config('erp.register_edit', 'on', true)`

/** Rethrow a database refusal as a sentence, keeping its code word. */
export function asSentence(e: unknown): never {
  const chain: string[] = []
  let cur: unknown = e
  for (let i = 0; cur && i < 5; i++) {
    const err = cur as { message?: string; cause?: unknown }
    if (err.message) chain.push(err.message)
    cur = err.cause
  }
  // Prefer the line that carries a code word; then the one naming a
  // constraint — an EXCLUDE or CHECK violation has no CODE: prefix, and the
  // first version kept drizzle's outer "Failed query:" line instead, which
  // told the reader nothing and failed three checks' needles at once.
  const hit = chain.find((m) => /\b[A-Z][A-Z_]+:/.test(m))
    ?? chain.find((m) => m.includes('constraint') || m.includes('violates'))
    ?? chain[chain.length - 1] ?? String(e)
  throw new RecordsError('REFUSED', first(hit))
}

/**
 * A party's address as ONE line, spelled once.
 *
 * Two registers ask for an address and they ask different questions: a
 * directorship FREEZES the prescribed address on its row, because a register
 * as at 2024 must keep saying what was true in 2024; the securities register
 * reads it live, because s.111(1) asks for the holder's LAST KNOWN address.
 * Different questions, one way of writing an address down — otherwise the
 * same person appears two ways on two pages of one minute book.
 */
const ADDRESS_LINE = sql`concat_ws(', ', line1, line2, city, region, postal_code)`

// ---------------------------------------------------------------- profile --

export async function saveProfile(input: {
  entityId: string
  incorporationNumber?: string
  businessNumber?: string
  recognitionDate?: string
  companyType?: string
  /**
   * Canadian-controlled private corporation. THREE states, and null is one of
   * them: undefined here leaves whatever is on file, null means "nobody has
   * said". The SR&ED working paper prices an unclassified company as though it
   * were not a CCPC — 15% and not refundable instead of 35% and refundable —
   * and prints that assumption in its to-confirm list rather than guessing
   * upward (0068).
   */
  isCcpc?: boolean | null
  actor: string
}) {
  try {
    await actingAs(input.actor, async (tx) => {
      const [before] = await tx.execute<{
        is_ccpc: boolean | null; incorporation_number: string | null
        business_number: string | null; recognition_date: string | null
        company_type: string | null; name: string
      }>(sql`
        SELECT e.is_ccpc, p.incorporation_number, p.business_number,
               p.recognition_date::text, p.company_type, e.name
          FROM entity e LEFT JOIN company_profile p ON p.entity_id = e.id
         WHERE e.id = ${input.entityId}::uuid FOR UPDATE OF e`)
      if (!before) throw new RecordsError('NO_COMPANY', 'That company is not on file.')

      if (input.isCcpc !== undefined) {
        await tx.execute(sql`
          UPDATE entity SET is_ccpc = ${input.isCcpc} WHERE id = ${input.entityId}::uuid`)
      }
      await tx.execute(sql`
        INSERT INTO company_profile (entity_id, incorporation_number, business_number,
                                     recognition_date, company_type, updated_by)
        VALUES (${input.entityId}::uuid, ${input.incorporationNumber ?? null},
                ${input.businessNumber ?? null}, ${input.recognitionDate ?? null},
                ${input.companyType ?? 'limited'}, ${input.actor})
        ON CONFLICT (entity_id) DO UPDATE SET
          incorporation_number = EXCLUDED.incorporation_number,
          business_number      = EXCLUDED.business_number,
          recognition_date     = EXCLUDED.recognition_date,
          company_type         = EXCLUDED.company_type,
          updated_at           = now(),
          updated_by           = EXCLUDED.updated_by`)

      await auditRow(tx, {
        actor: input.actor, action: 'save_profile', table: 'company_profile',
        recordId: input.entityId, entityId: input.entityId, scope: 'company',
        targetLabel: before.name,
        before: {
          incorporationNumber: before.incorporation_number,
          businessNumber: before.business_number,
          recognitionDate: before.recognition_date,
          companyType: before.company_type,
          isCcpc: before.is_ccpc,
        },
        after: {
          incorporationNumber: input.incorporationNumber ?? null,
          businessNumber: input.businessNumber ?? null,
          recognitionDate: input.recognitionDate ?? null,
          companyType: input.companyType ?? 'limited',
          isCcpc: input.isCcpc === undefined ? before.is_ccpc : input.isCcpc,
        },
      })
    })
  } catch (e) { asSentence(e) }
}

export async function profileOf(entityId: string) {
  const [row] = await db.execute<{
    incorporation_number: string | null; business_number: string | null
    recognition_date: string | null; company_type: string
  }>(sql`
    SELECT incorporation_number, business_number, recognition_date::text, company_type
      FROM company_profile WHERE entity_id = ${entityId}::uuid`)
  return row ?? null
}

// ---------------------------------------------------------------- offices --

export async function setOffice(input: {
  entityId: string
  office: 'registered' | 'records'
  deliveryAddress: string
  deliveryCity: string
  deliveryPostal?: string
  mailingAddress?: string
  mailingCity?: string
  mailingPostal?: string
  effectiveFrom: string
  actor: string
}, on: Runner = db) {
  try {
    await on.transaction(async (tx) => {
      // The previous address ends the day before the new one begins. Ending is
      // writing a date — the row stays, because the register is as-of.
      await tx.execute(sql`
        UPDATE corporate_office
           SET effective_to = ${input.effectiveFrom}::date - 1
         WHERE entity_id = ${input.entityId}::uuid AND office = ${input.office}
           AND effective_to IS NULL`)
      await tx.execute(sql`
        INSERT INTO corporate_office (entity_id, office, delivery_address, delivery_city,
                                      delivery_postal, mailing_address, mailing_city,
                                      mailing_postal, effective_from, created_by)
        VALUES (${input.entityId}::uuid, ${input.office}, ${input.deliveryAddress},
                ${input.deliveryCity}, ${input.deliveryPostal ?? null},
                ${input.mailingAddress ?? null}, ${input.mailingCity ?? null},
                ${input.mailingPostal ?? null}, ${input.effectiveFrom}::date, ${input.actor})`)
    })
  } catch (e) { asSentence(e) }
}

export async function officesOf(entityId: string, asOf: string) {
  return db.execute<{
    office: string; delivery_address: string; delivery_city: string
    delivery_postal: string | null; effective_from: string
  }>(sql`
    SELECT office, delivery_address, delivery_city, delivery_postal, effective_from::text
      FROM corporate_office
     WHERE entity_id = ${entityId}::uuid
       AND effective_from <= ${asOf}::date
       AND (effective_to IS NULL OR effective_to >= ${asOf}::date)
     ORDER BY office`)
}

/**
 * Every address either office ever had, newest first — the rows the records
 * screen lists and puts right (0083). A register as at a date reads `officesOf`.
 */
export async function allOffices(entityId: string) {
  return db.execute<{
    id: string; office: string; delivery_address: string; delivery_city: string
    delivery_postal: string | null; effective_from: string; effective_to: string | null
  }>(sql`
    SELECT id::text, office, delivery_address, delivery_city, delivery_postal,
           effective_from::text, effective_to::text
      FROM corporate_office
     WHERE entity_id = ${entityId}::uuid
     ORDER BY office, effective_from DESC`)
}

// -------------------------------------------------------------- directors --

export async function appointDirector(input: {
  entityId: string
  partyId: string
  appointedOn: string
  /** Defaults from the party's address when not given, then freezes here. */
  prescribedDelivery?: string
  prescribedMailing?: string
  actor: string
}, on: Runner = db) {
  try {
    return await on.transaction(async (tx) => {
      let delivery = input.prescribedDelivery
      if (!delivery) {
        const [addr] = await tx.execute<{ line: string | null }>(sql`
          SELECT ${ADDRESS_LINE} AS line
            FROM party_address
           WHERE party_id = ${input.partyId}::uuid
           ORDER BY purpose LIMIT 1`)
        delivery = addr?.line || undefined
      }
      if (!delivery) {
        throw new RecordsError('NO_ADDRESS',
          'A director needs a prescribed address, and the party has none to borrow.')
      }
      const [row] = await tx.execute<{ id: string }>(sql`
        INSERT INTO directorship (entity_id, party_id, prescribed_delivery,
                                  prescribed_mailing, appointed_on, created_by)
        VALUES (${input.entityId}::uuid, ${input.partyId}::uuid, ${delivery},
                ${input.prescribedMailing ?? null}, ${input.appointedOn}::date, ${input.actor})
        RETURNING id::text`)
      return row.id
    })
  } catch (e) {
    if (e instanceof RecordsError) throw e
    asSentence(e)
  }
}

export async function ceaseDirector(input: {
  directorshipId: string
  ceasedOn: string
  actor: string
}, on: Runner = db) {
  try {
    const rows = await on.execute<{ id: string }>(sql`
      UPDATE directorship SET ceased_on = ${input.ceasedOn}::date
       WHERE id = ${input.directorshipId}::uuid AND ceased_on IS NULL
       RETURNING id::text`)
    if (rows.length === 0) {
      throw new RecordsError('NOT_SERVING',
        'That directorship does not exist or has already ended.')
    }
  } catch (e) {
    if (e instanceof RecordsError) throw e
    asSentence(e)
  }
}

/** The register's question: who was a director AS AT a date. */
export async function directorsAsAt(entityId: string, asOf: string) {
  return db.execute<{
    id: string; party_id: string; name: string
    prescribed_delivery: string; prescribed_mailing: string | null
    appointed_on: string; ceased_on: string | null
  }>(sql`
    SELECT d.id::text, d.party_id::text, p.name,
           d.prescribed_delivery, d.prescribed_mailing,
           d.appointed_on::text, d.ceased_on::text
      FROM directorship d JOIN party p ON p.id = d.party_id
     WHERE d.entity_id = ${entityId}::uuid
       AND d.appointed_on <= ${asOf}::date
       AND (d.ceased_on IS NULL OR d.ceased_on >= ${asOf}::date)
     ORDER BY d.appointed_on, p.name`)
}

/** Every term ever, for the full register (former directors keep their dates). */
export async function allDirectorships(entityId: string) {
  return db.execute<{
    id: string; name: string; prescribed_delivery: string
    appointed_on: string; ceased_on: string | null
  }>(sql`
    SELECT d.id::text, p.name, d.prescribed_delivery,
           d.appointed_on::text, d.ceased_on::text
      FROM directorship d JOIN party p ON p.id = d.party_id
     WHERE d.entity_id = ${entityId}::uuid
     ORDER BY d.appointed_on, p.name`)
}

// ----------------------------------------------------------------- shares --

export async function createShareClass(input: {
  entityId: string; name: string; series?: string; actor: string
}, on: Runner = db) {
  try {
    const [row] = await on.execute<{ id: string }>(sql`
      INSERT INTO share_class (entity_id, name, series, created_by)
      VALUES (${input.entityId}::uuid, ${input.name}, ${input.series ?? null}, ${input.actor})
      RETURNING id::text`)
    return row.id
  } catch (e) { asSentence(e) }
}

/**
 * The particulars s.111(1) asks for, on every movement (0050).
 *
 * `certificateNo` is the certificate the movement LEAVES its holder holding —
 * on a partial transfer out, the balance certificate the transferor gets
 * back. `surrenderedNo` is the one it takes in and cancels. Shares held
 * without certificates leave both empty, which is ordinary in BC.
 */
export type Particulars = {
  consideration?: string
  certificateNo?: string
  surrenderedNo?: string
}

const blank = (v?: string) => (v && v.trim() ? v.trim() : null)

export async function issueShares(input: {
  shareClassId: string; partyId: string; onDate: string
  quantity: bigint; details: string; actor: string
} & Particulars, on: Runner = db) {
  if (input.quantity <= 0n) {
    throw new RecordsError('NOT_POSITIVE', 'An issue is a positive number of shares.')
  }
  try {
    await on.execute(sql`
      INSERT INTO share_transaction (share_class_id, party_id, on_date, delta, kind, details,
                                     consideration, certificate_no, created_by)
      VALUES (${input.shareClassId}::uuid, ${input.partyId}::uuid, ${input.onDate}::date,
              ${input.quantity}, 'issue', ${input.details},
              ${blank(input.consideration)}, ${blank(input.certificateNo)}, ${input.actor})`)
  } catch (e) { asSentence(e) }
}

/**
 * A transfer is two rows in one group; the trigger holds them to zero.
 *
 * The SHARES are not cancelled and re-issued — they are the same shares under
 * a new holder, and minting new ones would inflate what the company has ever
 * issued and lose the fact that these particular shares moved, which is the
 * particular the Act asks for (owner asked, 2026-09-03).
 *
 * What IS cancelled and re-issued is the certificate: the transferor
 * surrenders theirs, the transferee gets a new one, and if only part of a
 * holding moved the transferor gets a BALANCE certificate for the rest. Those
 * are the three fields below, and they sit on the row whose holder they
 * belong to.
 */
export async function transferShares(input: {
  shareClassId: string; fromPartyId: string; toPartyId: string
  onDate: string; quantity: bigint; details: string; actor: string
  consideration?: string
  /** Taken in from the transferor and cancelled. */
  surrenderedNo?: string
  /** Issued to the transferee. */
  certificateNo?: string
  /** Issued back to the transferor for what they still hold, if anything. */
  balanceNo?: string
}, on: Runner = db) {
  if (input.quantity <= 0n) {
    throw new RecordsError('NOT_POSITIVE', 'A transfer moves a positive number of shares.')
  }
  try {
    await on.transaction(async (tx) => {
      const [g] = await tx.execute<{ id: string }>(sql`SELECT gen_random_uuid()::text AS id`)
      await tx.execute(sql`
        INSERT INTO share_transaction (share_class_id, party_id, on_date, delta, kind,
                                       transfer_group, details, consideration,
                                       certificate_no, surrendered_no, created_by)
        VALUES (${input.shareClassId}::uuid, ${input.fromPartyId}::uuid, ${input.onDate}::date,
                ${-input.quantity}, 'transfer_out', ${g.id}::uuid, ${input.details},
                ${blank(input.consideration)}, ${blank(input.balanceNo)},
                ${blank(input.surrenderedNo)}, ${input.actor}),
               (${input.shareClassId}::uuid, ${input.toPartyId}::uuid, ${input.onDate}::date,
                ${input.quantity}, 'transfer_in', ${g.id}::uuid, ${input.details},
                ${blank(input.consideration)}, ${blank(input.certificateNo)},
                NULL, ${input.actor})`)
    })
  } catch (e) { asSentence(e) }
}

/**
 * Cancel (buy back / redeem) shares: the company takes them in and they stop
 * existing. One negative row, kind 'cancellation' — the schema's own CHECK
 * holds the sign. With a transfer this is the second way a holder's balance
 * reaches zero, which is what puts a "date ceased" on the BC register
 * (owner, 2026-09-03).
 */
export async function cancelShares(input: {
  shareClassId: string; partyId: string; onDate: string; quantity: bigint
  details: string; actor: string
  consideration?: string
  /** Taken in and cancelled. */
  surrenderedNo?: string
  /** Issued back for what they still hold, when only part was bought back. */
  balanceNo?: string
}, on: Runner = db) {
  if (input.quantity <= 0n) {
    throw new RecordsError('NOT_POSITIVE', 'A cancellation takes back a positive number of shares.')
  }
  try {
    await on.execute(sql`
      INSERT INTO share_transaction (share_class_id, party_id, on_date, delta, kind, details,
                                     consideration, certificate_no, surrendered_no, created_by)
      VALUES (${input.shareClassId}::uuid, ${input.partyId}::uuid, ${input.onDate}::date,
              ${-input.quantity}, 'cancellation', ${input.details},
              ${blank(input.consideration)}, ${blank(input.balanceNo)},
              ${blank(input.surrenderedNo)}, ${input.actor})`)
  } catch (e) { asSentence(e) }
}

/**
 * The Central Securities Register per BC's own template: every holder who
 * EVER held shares of each class, with the date they became a registered
 * holder (first acquisition) and — when their balance stands at zero as at
 * the date — the date they ceased (the transaction that zeroed them).
 * Former holders stay on the page; leaving is a date, not an erasure.
 */
export async function securitiesRegister(entityId: string, asOf: string) {
  return db.execute<{
    share_class_id: string; class_name: string; series: string | null
    party_id: string; holder: string; address: string | null; holding: bigint
    became_on: string; ceased_on: string | null
  }>(sql`
    SELECT c.id::text AS share_class_id, c.name AS class_name, c.series,
           t.party_id::text, p.name AS holder, SUM(t.delta) AS holding,
           MIN(t.on_date)::text AS became_on,
           CASE WHEN SUM(t.delta) = 0 THEN MAX(t.on_date)::text END AS ceased_on,
           -- The holder's LAST KNOWN address, which s.111(1) asks for by that
           -- name: read live, not frozen the way a directorship's prescribed
           -- address is. Same spelling of an address as the directors'
           -- register uses, so one person reads the same on both pages.
           ${partyAddressLine(sql`t.party_id`)} AS address
      FROM share_transaction t
      JOIN share_class c ON c.id = t.share_class_id
      JOIN party p ON p.id = t.party_id
     WHERE c.entity_id = ${entityId}::uuid AND t.on_date <= ${asOf}::date
     GROUP BY c.id, c.name, c.series, t.party_id, p.name
     ORDER BY c.name, c.series NULLS FIRST, p.name`)
}

/**
 * Every movement of every share up to a date — the DATE AND PARTICULARS of
 * each issue and transfer that s.111(1) asks for, which this register has
 * been keeping in its table and printing nowhere (owner, 2026-09-03).
 *
 * One row per transaction, with the balance it left that holder standing at,
 * so a reader can add the page up: the last figure against a holder is the
 * number in the summary table above, and `CR27` says so rather than assuming
 * it. A transfer names the OTHER side from its paired row — "from whom" is a
 * particular the Act asks for, and the group already knows it.
 */
export async function shareMovements(entityId: string, asOf: string) {
  return db.execute<{
    id: string; share_class_id: string; class_name: string; series: string | null
    party_id: string; holder: string; on_date: string; kind: string
    delta: bigint; running: bigint; details: string
    consideration: string | null; certificate_no: string | null
    surrendered_no: string | null; counterparty: string | null
  }>(sql`
    SELECT t.id::text, c.id::text AS share_class_id, c.name AS class_name, c.series,
           t.party_id::text, p.name AS holder, t.on_date::text, t.kind,
           t.delta, t.details, t.consideration, t.certificate_no, t.surrendered_no,
           (SELECT p2.name
              FROM share_transaction o JOIN party p2 ON p2.id = o.party_id
             WHERE o.transfer_group = t.transfer_group AND o.id <> t.id
             LIMIT 1) AS counterparty,
           SUM(t.delta) OVER (PARTITION BY t.share_class_id, t.party_id
                              ORDER BY t.on_date, t.created_at, t.id
                              ROWS UNBOUNDED PRECEDING) AS running
      FROM share_transaction t
      JOIN share_class c ON c.id = t.share_class_id
      JOIN party p ON p.id = t.party_id
     WHERE c.entity_id = ${entityId}::uuid AND t.on_date <= ${asOf}::date
     ORDER BY c.name, c.series NULLS FIRST, p.name, t.on_date, t.created_at`)
}

/**
 * What this register would say if it were asked about a later day.
 *
 * An as-at register is silent about everything dated after the date it was
 * asked for — correctly, and invisibly. The owner recorded two buy-backs
 * dated 2026-09-05 and 09-06, read the register as at today (09-03), and saw
 * nothing move: "buy back功能更新了后台数据库，但前端没有反应" (2026-09-03).
 * Nothing was broken. The page simply never said that its answer had a date
 * on it, or that there was more after it.
 */
export async function movementsAfter(
  kind: 'directors' | 'central_securities' | 'transparency',
  entityId: string, asOf: string,
): Promise<{ count: number; earliest: string | null }> {
  const q = kind === 'central_securities'
    ? sql`SELECT count(*)::int AS n, MIN(t.on_date)::text AS earliest
            FROM share_transaction t JOIN share_class c ON c.id = t.share_class_id
           WHERE c.entity_id = ${entityId}::uuid AND t.on_date > ${asOf}::date`
    : kind === 'directors'
      ? sql`SELECT count(*)::int AS n, MIN(d)::text AS earliest FROM (
              SELECT appointed_on AS d FROM directorship
               WHERE entity_id = ${entityId}::uuid AND appointed_on > ${asOf}::date
              UNION ALL
              SELECT ceased_on AS d FROM directorship
               WHERE entity_id = ${entityId}::uuid AND ceased_on > ${asOf}::date) x`
      : sql`SELECT count(*)::int AS n, MIN(d)::text AS earliest FROM (
              SELECT became_on AS d FROM significant_individual
               WHERE entity_id = ${entityId}::uuid AND became_on > ${asOf}::date
              UNION ALL
              SELECT ceased_on AS d FROM significant_individual
               WHERE entity_id = ${entityId}::uuid AND ceased_on > ${asOf}::date) x`
  const [row] = await db.execute<{ n: number; earliest: string | null }>(q)
  return { count: Number(row?.n ?? 0), earliest: row?.earliest ?? null }
}

/**
 * Every movement on the register ONCE, in the add form's own words — a
 * transfer is one line here, though it is two rows in the table — so the
 * records screen lists each with the boxes it was entered in (0083).
 *
 * `id` is the row an Edit or Delete names: the receiving side of a transfer,
 * which the door follows to its pair. The certificate numbers sit where the
 * add form puts them: issued to whoever receives, surrendered and balance on
 * the side that gives up.
 */
export async function movementRows(entityId: string) {
  return db.execute<{
    id: string; kind: string; share_class: string; on_date: string
    from_name: string; to_name: string; quantity: string; consideration: string
    certificate_no: string; surrendered_no: string; balance_no: string; details: string
  }>(sql`
    SELECT t.id::text,
           CASE WHEN t.kind = 'transfer_in' THEN 'transfer' ELSE t.kind END AS kind,
           CASE WHEN c.series IS NULL THEN c.name ELSE c.name || ' — ' || c.series END AS share_class,
           t.on_date::text,
           CASE t.kind WHEN 'cancellation' THEN p.name WHEN 'transfer_in' THEN po.name ELSE '' END AS from_name,
           CASE t.kind WHEN 'cancellation' THEN '' ELSE p.name END AS to_name,
           abs(t.delta)::text AS quantity,
           COALESCE(t.consideration, '') AS consideration,
           CASE t.kind WHEN 'cancellation' THEN '' ELSE COALESCE(t.certificate_no, '') END AS certificate_no,
           COALESCE(CASE t.kind WHEN 'transfer_in' THEN o.surrendered_no ELSE t.surrendered_no END, '') AS surrendered_no,
           COALESCE(CASE t.kind WHEN 'transfer_in' THEN o.certificate_no
                                WHEN 'cancellation' THEN t.certificate_no END, '') AS balance_no,
           t.details
      FROM share_transaction t
      JOIN share_class c ON c.id = t.share_class_id
      JOIN party p ON p.id = t.party_id
      LEFT JOIN share_transaction o ON o.transfer_group = t.transfer_group AND o.id <> t.id
      LEFT JOIN party po ON po.id = o.party_id
     WHERE c.entity_id = ${entityId}::uuid AND t.kind <> 'transfer_out'
     ORDER BY t.on_date DESC, t.created_at DESC, t.id`)
}

/** This company's share classes, with how many movements each has — a class with none can be deleted. */
export async function shareClassRows(entityId: string) {
  return db.execute<{ id: string; name: string; series: string | null; movements: number }>(sql`
    SELECT c.id::text, c.name, c.series,
           (SELECT count(*)::int FROM share_transaction t WHERE t.share_class_id = c.id) AS movements
      FROM share_class c WHERE c.entity_id = ${entityId}::uuid
     ORDER BY c.name, c.series NULLS FIRST`)
}

/** Holdings per class and holder as at a date — derived, stored nowhere. */
export async function holdingsAsAt(entityId: string, asOf: string) {
  return db.execute<{
    share_class_id: string; class_name: string; series: string | null
    party_id: string; holder: string; holding: bigint
  }>(sql`
    SELECT c.id::text AS share_class_id, c.name AS class_name, c.series,
           t.party_id::text, p.name AS holder, SUM(t.delta) AS holding
      FROM share_transaction t
      JOIN share_class c ON c.id = t.share_class_id
      JOIN party p ON p.id = t.party_id
     WHERE c.entity_id = ${entityId}::uuid AND t.on_date <= ${asOf}::date
     GROUP BY c.id, c.name, c.series, t.party_id, p.name
    HAVING SUM(t.delta) <> 0
     ORDER BY c.name, c.series NULLS FIRST, p.name`)
}

/** The register's own trial balance: per class, Σ holders = Σ everything. */
export async function shareTotalsAsAt(entityId: string, asOf: string) {
  return db.execute<{ class_name: string; series: string | null; issued: bigint }>(sql`
    SELECT c.name AS class_name, c.series, COALESCE(SUM(t.delta), 0) AS issued
      FROM share_class c
      LEFT JOIN share_transaction t
        ON t.share_class_id = c.id AND t.on_date <= ${asOf}::date
     WHERE c.entity_id = ${entityId}::uuid
     GROUP BY c.id, c.name, c.series
     ORDER BY c.name, c.series NULLS FIRST`)
}

// --------------------------------------------- significant individuals --

export async function recordSignificantIndividual(input: {
  entityId: string; partyId: string; becameOn: string; howControl: string
  birthDate?: string; lastKnownAddress?: string
  citizenOrPr?: boolean; citizenships?: string; taxResidentCa?: boolean
  actor: string
}, on: Runner = db) {
  try {
    const [row] = await on.execute<{ id: string }>(sql`
      INSERT INTO significant_individual (entity_id, party_id, birth_date,
        last_known_address, citizen_or_pr, citizenships, tax_resident_ca,
        how_control, became_on, created_by)
      VALUES (${input.entityId}::uuid, ${input.partyId}::uuid, ${input.birthDate ?? null},
              ${input.lastKnownAddress ?? null}, ${input.citizenOrPr ?? true},
              ${input.citizenships ?? null}, ${input.taxResidentCa ?? true},
              ${input.howControl}, ${input.becameOn}::date, ${input.actor})
      RETURNING id::text`)
    return row.id
  } catch (e) { asSentence(e) }
}

export async function ceaseSignificantIndividual(input: {
  id: string; ceasedOn: string; actor: string
}, on: Runner = db) {
  try {
    const rows = await on.execute<{ id: string }>(sql`
      UPDATE significant_individual SET ceased_on = ${input.ceasedOn}::date
       WHERE id = ${input.id}::uuid AND ceased_on IS NULL
       RETURNING id::text`)
    if (rows.length === 0) {
      throw new RecordsError('NOT_CURRENT', 'That entry does not exist or has already ended.')
    }
  } catch (e) {
    if (e instanceof RecordsError) throw e
    asSentence(e)
  }
}

export async function significantIndividualsAsAt(entityId: string, asOf: string) {
  return db.execute<{
    id: string; name: string; birth_date: string | null
    last_known_address: string | null; citizen_or_pr: boolean
    citizenships: string | null; tax_resident_ca: boolean
    how_control: string; became_on: string
  }>(sql`
    SELECT s.id::text, p.name, s.birth_date::text, s.last_known_address,
           s.citizen_or_pr, s.citizenships, s.tax_resident_ca,
           s.how_control, s.became_on::text
      FROM significant_individual s JOIN party p ON p.id = s.party_id
     WHERE s.entity_id = ${entityId}::uuid
       AND s.became_on <= ${asOf}::date
       AND (s.ceased_on IS NULL OR s.ceased_on >= ${asOf}::date)
     ORDER BY s.became_on, p.name`)
}

/**
 * Every significant individual EVER recorded, ceased ones included — the
 * transparency register keeps former SIs with their dates (BCA: six years),
 * so the register view reads THIS, not the as-at filter (owner, 2026-09-03).
 */
export async function allSignificantIndividuals(entityId: string) {
  return db.execute<{
    id: string; name: string; birth_date: string | null
    last_known_address: string | null; citizen_or_pr: boolean
    citizenships: string | null; tax_resident_ca: boolean
    how_control: string; became_on: string; ceased_on: string | null
  }>(sql`
    SELECT s.id::text, p.name, s.birth_date::text, s.last_known_address,
           s.citizen_or_pr, s.citizenships, s.tax_resident_ca,
           s.how_control, s.became_on::text, s.ceased_on::text
      FROM significant_individual s JOIN party p ON p.id = s.party_id
     WHERE s.entity_id = ${entityId}::uuid
     ORDER BY s.became_on, p.name`)
}

// -------------------------------------------------------------- minute book --

export async function addMinuteBookEntry(input: {
  entityId: string; recordKind: string; onDate: string
  title: string; keptAt: string; note?: string; actor: string
}, on: Runner = db) {
  try {
    const [row] = await on.execute<{ id: string }>(sql`
      INSERT INTO minute_book_entry (entity_id, record_kind, on_date, title, kept_at, note, created_by)
      VALUES (${input.entityId}::uuid, ${input.recordKind}, ${input.onDate}::date,
              ${input.title}, ${input.keptAt}, ${input.note ?? null}, ${input.actor})
      RETURNING id::text`)
    return row.id
  } catch (e) { asSentence(e) }
}

export async function minuteBookOf(entityId: string) {
  return db.execute<{
    id: string; record_kind: string; on_date: string
    title: string; kept_at: string; note: string | null
  }>(sql`
    SELECT id::text, record_kind, on_date::text, title, kept_at, note
      FROM minute_book_entry
     WHERE entity_id = ${entityId}::uuid
     ORDER BY on_date DESC, created_at DESC`)
}
