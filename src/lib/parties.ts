import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, actingAs, type Runner } from './acting'
import { causesOf } from './db-errors'

/** Edit the existing shared primary contact; the caller holds the Party lease. */
export async function setPrimaryContactEmail(partyId:string,email:string,actor:string,runner:Runner=db){
  const value=primaryEmail(email)
  return actingAs(actor,async tx=>{
    const [party]=await tx.execute(sql`SELECT id FROM party WHERE id=${partyId}::uuid FOR UPDATE`)
    if(!party)throw new PartyError('NOT_FOUND','This party is unavailable.')
    const [contact]=await tx.execute<{id:string;name:string|null;phone:string|null}>(sql`SELECT id::text,name,phone FROM party_contact WHERE party_id=${partyId}::uuid AND is_primary FOR UPDATE`)
    if(contact&&!value&&contact.name===null&&contact.phone===null)await tx.execute(sql`DELETE FROM party_contact WHERE id=${contact.id}::uuid`)
    else if(contact)await tx.execute(sql`UPDATE party_contact SET email=${value||null} WHERE id=${contact.id}::uuid`)
    else if(value)await tx.execute(sql`INSERT INTO party_contact(party_id,email,is_primary) VALUES(${partyId}::uuid,${value},true)`)
    return {ok:'Primary email saved.'}
  },runner)
}

/**
 * Customers and suppliers — one list, shared across the companies.
 *
 * The shape is settled in `docs/design/03-parties.md` and 0025 implements it.
 * The part worth remembering while reading this file: a party is GLOBAL and a
 * role is PER COMPANY, so Acme Ltd is one row even when it sells to one company
 * and buys from another, and changing its address changes it for both. What
 * each company is owed by Acme is a different question, answered by the ledger.
 *
 * Nothing here keeps a balance. There is no `party.balance`, no AR summary
 * table, and there will not be one: a second answer to a question the ledger
 * already answers is the defect shape this system keeps finding in itself.
 */

/** Every message in the chain — the driver wraps what Postgres said. */
/**
 * One address line for a party, the way it should be shown wherever a document
 * needs one — a pay statement, a Record of Employment.
 *
 * The ORDER matters and is not alphabetical: `party_address_purpose.sort_order`
 * exists to say which address is the one to use, and two callers picked with
 * `ORDER BY purpose` instead, which happens to prefer 'delivery' by spelling
 * (critic). One expression, and it asks the table that knows.
 */
export const partyAddressLine = (partyColumn: SQL) => sql`(
  SELECT concat_ws(', ', a.line1, a.line2, a.city, a.region, a.postal_code)
    FROM party_address a
    JOIN party_address_purpose pp ON pp.code = a.purpose
   WHERE a.party_id = ${partyColumn}
   ORDER BY pp.sort_order, a.purpose
   LIMIT 1)`

export class PartyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'PartyError'
  }
}

function primaryEmail(email: string) {
  const value = email.trim()
  if (value && (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value) || value.length > 254)) {
    throw new PartyError('EMAIL', 'Enter a valid primary email address.')
  }
  return value
}

export type PartyKind = 'organisation' | 'person'
export type PartyRole = 'customer' | 'supplier' | 'employee' | 'director' | 'shareholder'

export type PartyRecord = {
  id: string
  kind: PartyKind
  name: string
  trading_name: string | null
  tax_number: string | null
  is_active: boolean
  notes: string | null
  /**
   * Whether this company deals with them at arm's length (0068). Every query
   * that builds one of these selects it, rather than the type claiming a column
   * some of them leave undefined.
   */
  arms_length: boolean
}

export type RoleRecord = {
  id: string
  party_id: string
  entity_id: string
  role: PartyRole
  held_from: string | null
  held_to: string | null
}

export type AddressRecord = {
  id: string
  party_id: string
  purpose: string
  line1: string
  line2: string | null
  city: string | null
  region: string | null
  postal_code: string | null
  country: string
}

/** The roles a party can hold, and which of them may carry money. */
export async function roleDefinitions() {
  return db.execute<{ code: PartyRole; label: string; transacts: boolean }>(sql`
    SELECT code, label, transacts FROM party_role_definition ORDER BY sort_order`)
}

export async function addressPurposes() {
  return db.execute<{ code: string; label: string }>(sql`
    SELECT code, label FROM party_address_purpose ORDER BY sort_order`)
}

/**
 * Create a party, its roles, and any contact/address supplied in one transaction.
 *
 * Both together, because a party with no role is invisible to every screen that
 * matters and a role that failed to land leaves a name nobody can invoice. The
 * same reasoning as `registerTax` creating its accounts atomically.
 */
export async function createParty(input: {
  kind: PartyKind
  name: string
  tradingName?: string
  taxNumber?: string
  notes?: string
  primaryContact?: { name?: string; email?: string; phone?: string }
  mailingAddress?: { line1: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string }
  /** At least one. Each is a company plus the role held there. */
  roles: Array<{ entityId: string; role: PartyRole; heldFrom?: string; heldTo?: string }>
  actor?: string
}, on: Runner = db): Promise<PartyRecord> {
  const name = input.name.trim()
  if (!name) {
    throw new PartyError('NAME_REQUIRED', 'A party needs a name.')
  }
  if (input.roles.length === 0) {
    throw new PartyError('ROLE_REQUIRED',
      `Say what ${name} is to at least one company — a customer, a supplier, and so on. `
      + 'A party with no role anywhere cannot be invoiced, paid or reported on.')
  }

  const actor = input.actor ?? 'system'
  const contact = input.primaryContact ? {
    name: input.primaryContact.name?.trim() || null,
    email: primaryEmail(input.primaryContact.email ?? '') || null,
    phone: input.primaryContact.phone?.trim() || null,
  } : undefined

  return actingAs(actor, async (tx) => {
    // `party_name_key` is the index's own expression (0026), and the value
    // handed to it is `name` — the one that gets STORED — not `input.name`.
    //
    // That distinction is the whole finding. JavaScript `.trim()` strips
    // U+FEFF; Postgres `\s` does not match it. Looking up with the raw input
    // keyed a BOM-prefixed name as '\ufeffacme ltd.', missed, and then inserted
    // the trimmed 'Acme Ltd.' — whose index key collided. The duplicate was
    // caught, but by the index, as a raw constraint violation instead of a
    // sentence. Passing the same value to both sides removes the second
    // normaliser rather than trying to make two of them agree.
    const [existing] = await tx.execute<{ id: string; name: string }>(sql`
      SELECT id::text, name FROM party
       WHERE is_active AND party_name_key(name) = party_name_key(${name})`)
    if (existing) {
      throw new PartyError('DUPLICATE_NAME',
        `${existing.name} is already on the list. Add the role to that one rather than `
        + 'creating a second record — two records means two addresses and eventually '
        + 'two answers to who they are.')
    }

    const [party] = await tx.execute<PartyRecord>(sql`
      INSERT INTO party (kind, name, trading_name, tax_number, notes, created_by)
      VALUES (${input.kind}, ${name}, ${input.tradingName?.trim() || null},
              ${input.taxNumber?.trim() || null}, ${input.notes?.trim() || null}, ${actor})
      RETURNING id::text, kind, name, trading_name, tax_number, is_active, notes, arms_length`)

    for (const r of input.roles) {
      await tx.execute(sql`
        INSERT INTO party_role (party_id, entity_id, role, held_from, held_to, created_by)
        VALUES (${party.id}::uuid, ${r.entityId}::uuid, ${r.role},
                ${r.heldFrom ?? null}::date, ${r.heldTo ?? null}::date, ${actor})`)
    }

    if (contact && (contact.name || contact.email || contact.phone)) {
      await tx.execute(sql`INSERT INTO party_contact (party_id, name, email, phone, is_primary)
        VALUES (${party.id}::uuid, ${contact.name}, ${contact.email}, ${contact.phone}, true)`)
    }
    if (input.mailingAddress) {
      await setAddress({ partyId: party.id, purpose: 'mailing', ...input.mailingAddress }, tx)
    }

    return party
  }, on)
}

/** Give an existing party another role, or the same role at another company. */
export async function grantRole(input: {
  partyId: string
  entityId: string
  role: PartyRole
  heldFrom?: string
  heldTo?: string
  actor?: string
}, on: Runner = db): Promise<RoleRecord> {
  const [row] = await on.execute<RoleRecord>(sql`
    INSERT INTO party_role (party_id, entity_id, role, held_from, held_to, created_by)
    VALUES (${input.partyId}::uuid, ${input.entityId}::uuid, ${input.role},
            ${input.heldFrom ?? null}::date, ${input.heldTo ?? null}::date, ${input.actor ?? 'system'})
    RETURNING id::text, party_id::text, entity_id::text, role, held_from::text, held_to::text`)
  return row
}

/**
 * End a role on a date.
 *
 * Not a delete. A supplier who stopped being one in March still explains every
 * invoice dated before March, and deleting the role would make those lines
 * unexplainable — the database refuses them at insert for exactly that reason.
 */
export async function endRole(roleId: string, heldTo: string, actor = 'system', on: Runner = db): Promise<RoleRecord> {
  let row: RoleRecord | undefined
  try {
    // Under the person: the role trigger names whoever changed it (0085).
    ;[row] = await actingAs(actor, (tx) => tx.execute<RoleRecord>(sql`
      UPDATE party_role SET held_to = ${heldTo}::date
       WHERE id = ${roleId}::uuid
      RETURNING id::text, party_id::text, entity_id::text, role, held_from::text, held_to::text`), on)
  } catch (e) {
    // 0026 refuses ending a role before something already posted to it. The
    // database is right and its message is long; this is the part to act on.
    const text = causesOf(e)
    if (text.includes('ROLE_STILL_NEEDED')) {
      throw new PartyError('ROLE_STILL_NEEDED',
        text.split('ROLE_STILL_NEEDED: ')[1]?.split('\n')[0]
        ?? 'Something already posted falls inside this role; end it later.')
    }
    throw e
  }
  if (!row) throw new PartyError('NO_ROLE', 'That role does not exist.')
  return row
}

/**
 * Put a role's dates right, or take a role out that was given by mistake
 * (0084; owner, 2026-09-16: 「所有的紀錄儘量都可以編輯刪除」).
 *
 * Ending a role is still `endRole` — a supplier who stopped being one. These
 * are for a role that was never right: the wrong start date, the wrong role.
 * The database refuses what would leave a posted line unexplained (0026), and
 * a payroll record needs its person to hold the employee role (0051); both
 * refusals are said here in words.
 */
function roleRefusal(e: unknown, fallback: string): never {
  const text = causesOf(e)
  if (text.includes('ROLE_STILL_NEEDED')) {
    throw new PartyError('ROLE_STILL_NEEDED',
      text.split('ROLE_STILL_NEEDED: ')[1]?.split('\n')[0] ?? fallback)
  }
  // An overlap with another term of the same role is the form layer's to say:
  // `party-forms.ts` already turns that constraint into a sentence for grants.
  throw e
}

export async function correctRole(roleId: string, heldFrom: string | undefined, heldTo: string | null, actor = 'system', on: Runner = db): Promise<RoleRecord> {
  if ((heldFrom && !/^\d{4}-\d{2}-\d{2}$/.test(heldFrom)) || (heldTo !== null && !/^\d{4}-\d{2}-\d{2}$/.test(heldTo))) {
    throw new PartyError('BAD_DATE', 'The last day must be a date, or empty while the role is still held.')
  }
  let row: RoleRecord | undefined
  try {
    ;[row] = await actingAs(actor, (tx) => tx.execute<RoleRecord>(sql`
      UPDATE party_role SET held_from = COALESCE(${heldFrom || null}::date, held_from), held_to = ${heldTo}::date
       WHERE id = ${roleId}::uuid
      RETURNING id::text, party_id::text, entity_id::text, role, held_from::text, held_to::text`), on)
  } catch (e) {
    roleRefusal(e, 'Something already posted falls outside those dates.')
  }
  if (!row) throw new PartyError('NO_ROLE', 'That role does not exist.')
  return row
}

export async function deleteRole(roleId: string, actor = 'system', on: Runner = db): Promise<void> {
  const [held] = await on.execute<{ role: string; on_payroll: boolean }>(sql`
    SELECT pr.role, EXISTS (SELECT 1 FROM payroll_employee e
                             WHERE e.party_id = pr.party_id AND e.entity_id = pr.entity_id) AS on_payroll
      FROM party_role pr WHERE pr.id = ${roleId}::uuid`)
  if (!held) throw new PartyError('NO_ROLE', 'That role does not exist.')
  if (held.role === 'employee' && held.on_payroll) {
    const [others] = await on.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM party_role o JOIN party_role pr ON pr.id = ${roleId}::uuid
       WHERE o.id <> pr.id AND o.party_id = pr.party_id AND o.entity_id = pr.entity_id AND o.role = 'employee'`)
    if (others.n === 0) {
      throw new PartyError('ON_PAYROLL',
        'They have a payroll record here, which needs the employee role. Delete the payroll record first, or end the role instead.')
    }
  }
  try {
    await actingAs(actor, (tx) => tx.execute(sql`DELETE FROM party_role WHERE id = ${roleId}::uuid`), on)
  } catch (e) {
    roleRefusal(e, 'Something already posted is explained by this role, so it stays. End it instead.')
  }
}

/** Remove the address kept for one purpose. Every company that prints it stops printing it. */
export async function deleteAddress(partyId: string, purpose: string, actor = 'system', on: Runner = db): Promise<void> {
  await actingAs(actor, async (tx) => {
    const gone = await tx.execute<{ line1: string; city: string | null; postal_code: string | null }>(sql`
      DELETE FROM party_address WHERE party_id = ${partyId}::uuid AND purpose = ${purpose}
      RETURNING line1, city, postal_code`)
    if (gone.length === 0) throw new PartyError('NO_ADDRESS', 'There is no such address on file.')
    // No trigger watches addresses; the door says what went and who took it.
    await tx.execute(sql`
      INSERT INTO audit_log (actor, action, table_name, record_id, before, context)
      VALUES (${actor}, 'delete_party_address', 'party_address', ${partyId},
              ${JSON.stringify(gone[0])}::jsonb, ${JSON.stringify({ purpose })}::jsonb)`)
  }, on)
}

/**
 * Who holds a role at a company on a given day.
 *
 * As-at rather than current, because the question is asked about the past:
 * which directors were in office at the year end, who was a supplier when this
 * invoice was dated.
 */
export async function partiesAsAt(entityId: string, asOf: string, role?: PartyRole) {
  return db.execute<PartyRecord & { role: PartyRole; held_from: string | null; held_to: string | null }>(sql`
    SELECT * FROM (
    SELECT DISTINCT ON (p.id, pr.role)
           p.id::text, p.kind, p.name, p.trading_name, p.tax_number, p.is_active, p.notes, p.arms_length,
           pr.role, pr.held_from::text, pr.held_to::text
      FROM party p
      JOIN party_role pr ON pr.party_id = p.id
     WHERE pr.entity_id = ${entityId}::uuid
       AND (pr.held_to IS NULL OR pr.held_to >= ${asOf}::date)
       ${role ? sql`AND pr.role = ${role}` : sql``}
     ORDER BY p.id, pr.role, pr.held_to DESC NULLS FIRST, pr.created_at DESC
    ) AS known ORDER BY name, role`)
}

/** Every party with a role at this company, whether current or ended. */
/**
 * Who a journal line may name at this company: active parties holding a
 * transacting role here. The entry screens (new, edit, correct) all offer
 * THIS list — one query, so the three doors cannot drift apart on who exists.
 */
export async function transactingParties(entityId: string) {
  // `roles` rides along for the dropdowns: with directors transacting (0044)
  // the list holds people in very different capacities, and "Jane Doe" alone
  // no longer says which. Distinct labels, sorted, joined once — display only.
  return db.execute<{ id: string; name: string; roles: string }>(sql`
    SELECT p.id::text, p.name,
           string_agg(DISTINCT rd.label, ', ' ORDER BY rd.label) AS roles
      FROM party p JOIN party_role pr ON pr.party_id = p.id
      JOIN party_role_definition rd ON rd.code = pr.role AND rd.transacts
     WHERE pr.entity_id = ${entityId}::uuid AND p.is_active
     GROUP BY p.id, p.name
     ORDER BY p.name`)
}

/**
 * The parties a form may name, under the heading each belongs to.
 *
 * ONE definition, because there were two: the invoice screen grouped them
 * as Customers and Suppliers while the quick forms put the role in small
 * grey type beside the name, and the same box on two screens looked like two
 * different boxes (owner, 2026-09-07 — 「这两个下拉菜单的风格不一样」).
 *
 * A role's end still matters; registration has no lower date boundary.
 */
export async function partyChoices(entityId: string, asOf: string) {
  const withRole = async (role: 'customer' | 'supplier') =>
    (await db.execute<{ id: string; name: string }>(sql`
      SELECT DISTINCT p.id::text, p.name
        FROM party p JOIN party_role pr ON pr.party_id = p.id
       WHERE pr.entity_id = ${entityId}::uuid AND pr.role = ${role}
         AND (pr.held_to IS NULL OR pr.held_to >= ${asOf}::date)
         AND p.is_active
       ORDER BY p.name`)).map((p) => ({ id: p.id, label: p.name }))
  const [customers, suppliers] = await Promise.all([withRole('customer'), withRole('supplier')])
  return { customers, suppliers }
}

/** The person a due-to-shareholder/director account owes on this date. */
export async function shareholderDirectorChoices(entityId: string, asOf: string) {
  return db.execute<{ id: string; label: string; hint: string }>(sql`
    SELECT p.id::text, p.name AS label,
           string_agg(DISTINCT rd.label, ', ' ORDER BY rd.label) AS hint
      FROM party p
      JOIN party_role pr ON pr.party_id = p.id
      JOIN party_role_definition rd ON rd.code = pr.role
     WHERE pr.entity_id = ${entityId}::uuid
       AND pr.role IN ('shareholder', 'director')
       AND (pr.held_to IS NULL OR pr.held_to >= ${asOf}::date)
       AND p.is_active
     GROUP BY p.id, p.name
     ORDER BY p.name`)
}

/** All roles a bank row can name, with their dates for that row's own day. */
export async function transactingPartyRoles(entityId: string) {
  return db.execute<{
    id: string; label: string; role: string; role_label: string
    held_from: string | null; held_to: string | null
  }>(sql`
    SELECT p.id::text, p.name AS label, pr.role, rd.label AS role_label,
           pr.held_from::text, pr.held_to::text
      FROM party p
      JOIN party_role pr ON pr.party_id = p.id
      JOIN party_role_definition rd ON rd.code = pr.role
     WHERE pr.entity_id = ${entityId}::uuid AND p.is_active AND rd.transacts
     ORDER BY p.name, rd.sort_order`)
}


export async function partiesFor(entityId: string) {
  return db.execute<PartyRecord & { roles: string }>(sql`
    SELECT p.id::text, p.kind, p.name, p.trading_name, p.tax_number, p.is_active, p.notes,
           string_agg(
             pr.role || CASE WHEN pr.held_to IS NULL THEN '' ELSE ' (to ' || pr.held_to || ')' END,
             ', ' ORDER BY pr.role) AS roles
      FROM party p
      JOIN party_role pr ON pr.party_id = p.id AND pr.entity_id = ${entityId}::uuid
     GROUP BY p.id, p.kind, p.name, p.trading_name, p.tax_number, p.is_active, p.notes
     ORDER BY p.name`)
}

/** One party, with roles limited to the company whose books are open. */
export async function partyDetail(partyId: string, entityId?: string) {
  const [party] = await db.execute<PartyRecord & {version:string}>(sql`
    SELECT id::text, version::text, kind, name, trading_name, tax_number, is_active, notes, arms_length
      FROM party WHERE id = ${partyId}::uuid`)
  if (!party) return null

  const roles = await db.execute<RoleRecord & { entity_name: string }>(sql`
    SELECT pr.id::text, pr.party_id::text, pr.entity_id::text, pr.role,
           pr.held_from::text, pr.held_to::text, e.name AS entity_name
      FROM party_role pr JOIN entity e ON e.id = pr.entity_id
     WHERE pr.party_id = ${partyId}::uuid
       ${entityId ? sql`AND pr.entity_id = ${entityId}::uuid` : sql``}
     ORDER BY e.name, pr.role, pr.held_from`)

  const addresses = await db.execute<AddressRecord & { purpose_label: string }>(sql`
    SELECT a.id::text, a.party_id::text, a.purpose, a.line1, a.line2, a.city, a.region,
           a.postal_code, a.country, p.label AS purpose_label
      FROM party_address a JOIN party_address_purpose p ON p.code = a.purpose
     WHERE a.party_id = ${partyId}::uuid
     ORDER BY p.sort_order`)

  const contacts = await db.execute<{
    id: string; name: string | null; email: string | null; phone: string | null
    is_primary: boolean
  }>(sql`
    SELECT id::text, name, email, phone, is_primary
      FROM party_contact WHERE party_id = ${partyId}::uuid
     ORDER BY is_primary DESC, name`)

  return { party, roles, addresses, contacts }
}

/**
 * Set an address for a purpose. One per purpose, so this replaces.
 *
 * The acceptance test `03` was written against is here: the same supplier under
 * two companies, address changed once, right in both places. It is right in both
 * because there is only one place.
 */
export async function setAddress(input: {
  partyId: string
  purpose: string
  line1: string
  line2?: string
  city?: string
  region?: string
  postalCode?: string
  country?: string
}, on: Runner = db): Promise<AddressRecord> {
  if (!input.line1.trim()) {
    throw new PartyError('ADDRESS_EMPTY', 'An address needs at least a first line.')
  }
  const [row] = await on.execute<AddressRecord>(sql`
    INSERT INTO party_address (party_id, purpose, line1, line2, city, region, postal_code, country)
    VALUES (${input.partyId}::uuid, ${input.purpose}, ${input.line1.trim()},
            ${input.line2?.trim() || null}, ${input.city?.trim() || null},
            ${input.region?.trim() || null}, ${input.postalCode?.trim() || null},
            ${input.country?.trim() || 'CA'})
    ON CONFLICT (party_id, purpose) DO UPDATE SET
      line1 = EXCLUDED.line1, line2 = EXCLUDED.line2, city = EXCLUDED.city,
      region = EXCLUDED.region, postal_code = EXCLUDED.postal_code,
      country = EXCLUDED.country, updated_at = now()
    RETURNING id::text, party_id::text, purpose, line1, line2, city, region, postal_code, country`)
  return row
}

/**
 * Change who a party says they are. Roles and addresses have their own verbs;
 * this touches only the record itself.
 */
export async function updateParty(input: {
  partyId: string
  name: string
  tradingName?: string
  taxNumber?: string
  notes?: string
  /**
   * Whether this party deals at arm's length. Defaults true in the column
   * (0068), because most do — and it is the SR&ED 80% contract rule that asks:
   * an arm's-length contract counts at 80%, a related one is counted in full
   * and named as needing advice. Undefined leaves the stored answer alone —
   * which is not the same as false, and the SQL below says so rather than
   * defaulting a missing argument into an answer.
   */
  armsLength?: boolean
  actor?: string
}, on: Runner = db): Promise<PartyRecord> {
  const name = input.name.trim()
  if (!name) throw new PartyError('NAME_REQUIRED', 'A party needs a name.')

  return on.transaction(async (tx) => {
    await acting(tx, input.actor ?? 'system')
    // Same normaliser on both sides, same reason as createParty — and the
    // party's own row is excluded, or renaming Acme to Acme would be refused.
    const [existing] = await tx.execute<{ name: string }>(sql`
      SELECT name FROM party
       WHERE is_active AND party_name_key(name) = party_name_key(${name})
         AND id <> ${input.partyId}::uuid`)
    if (existing) {
      throw new PartyError('DUPLICATE_NAME',
        `${existing.name} is already on the list under that name.`)
    }
    // Hoisted, not written inline: undefined must leave the stored answer
    // alone, and that is a different thing from false. Written into the
    // statement it was also a line a mutation block could not anchor on.
    const armsLength = input.armsLength === undefined
      ? sql`arms_length` : sql`${input.armsLength}`
    const [row] = await tx.execute<PartyRecord>(sql`
      UPDATE party SET name = ${name},
             trading_name = ${input.tradingName?.trim() || null},
             tax_number = ${input.taxNumber?.trim() || null},
             notes = ${input.notes?.trim() || null},
             arms_length = ${armsLength},
             updated_at = now()
       WHERE id = ${input.partyId}::uuid
      RETURNING id::text, kind, name, trading_name, tax_number, is_active, notes, arms_length`)
    if (!row) throw new PartyError('NO_PARTY', 'That party does not exist.')
    return row
  })
}

/**
 * Truly delete a party — only possible while nothing refers to them. The
 * moment an entry, an invoice or a corporate record names this party, the
 * database refuses the delete, and deactivating is the honest alternative:
 * history keeps its explanation, the name comes free for reuse.
 */
export async function deleteParty(partyId: string, actor = 'system', on: Runner = db): Promise<void> {
  try {
    // Under the person: removing the roles fires the role trigger, which names
    // whoever is acting (0085).
    await actingAs(actor, async (tx) => {
      // The party's own satellites go with it; they describe nobody else.
      await tx.execute(sql`DELETE FROM party_contact WHERE party_id = ${partyId}::uuid`)
      await tx.execute(sql`DELETE FROM party_address WHERE party_id = ${partyId}::uuid`)
      await tx.execute(sql`DELETE FROM party_role    WHERE party_id = ${partyId}::uuid`)
      const deleted = await tx.execute<{ id: string }>(sql`
        DELETE FROM party WHERE id = ${partyId}::uuid RETURNING id::text`)
      if (deleted.length === 0) throw new PartyError('NO_PARTY', 'That party does not exist.')
    }, on)
  } catch (e) {
    if (e instanceof PartyError) throw e
    const text = causesOf(e)
    // 0025's trigger says it best — how many journal lines name them, and what
    // to do instead. That sentence is kept; only its transport is changed.
    if (text.includes('PARTY_IN_USE')) {
      throw new PartyError('IN_USE',
        text.split('PARTY_IN_USE: ')[1]?.split('\n')[0]
        ?? 'The books still name this party, so the record cannot be deleted. Deactivate it instead.')
    }
    // Anything else still holding on — an invoice, a corporate record — comes
    // back as a foreign key. Same answer, said here because constraint names
    // are not sentences.
    if (text.includes('foreign key') || text.includes('violates')) {
      throw new PartyError('IN_USE',
        'The books still refer to this party — an invoice or a corporate record names '
        + 'them — so the record cannot be deleted. Deactivate it instead: history keeps '
        + 'its explanation and the name is freed for reuse.')
    }
    throw e
  }
}

/**
 * Put a deactivated party back on the lists — the undo for deactivateParty,
 * refused if the name has since been taken by another active record (the
 * duplicate index only watches active rows, so this check is the gate).
 */
export async function reactivateParty(partyId: string, actor = 'system', on: Runner = db): Promise<PartyRecord> {
  return on.transaction(async (tx) => {
    await acting(tx, actor)
    const [me] = await tx.execute<{ name: string }>(sql`
      SELECT name FROM party WHERE id = ${partyId}::uuid`)
    if (!me) throw new PartyError('NO_PARTY', 'That party does not exist.')
    const [taken] = await tx.execute<{ name: string }>(sql`
      SELECT name FROM party
       WHERE is_active AND party_name_key(name) = party_name_key(${me.name})
         AND id <> ${partyId}::uuid`)
    if (taken) {
      throw new PartyError('NAME_TAKEN',
        `${taken.name} is now on the list under that name; rename one of them first.`)
    }
    const [row] = await tx.execute<PartyRecord>(sql`
      UPDATE party SET is_active = true, updated_at = now()
       WHERE id = ${partyId}::uuid
      RETURNING id::text, kind, name, trading_name, tax_number, is_active, notes, arms_length`)
    return row
  })
}

/**
 * Take a party off the lists without touching what it explains.
 *
 * The database refuses to delete one the books refer to. This is the thing to
 * do instead, and it frees the name for a genuine second organisation with the
 * same name — the duplicate index only covers active rows.
 */
export async function deactivateParty(partyId: string, actor = 'system', on: Runner = db): Promise<PartyRecord> {
  const [row] = await actingAs(actor, (tx) => tx.execute<PartyRecord>(sql`
    UPDATE party SET is_active = false, updated_at = now()
     WHERE id = ${partyId}::uuid
    RETURNING id::text, kind, name, trading_name, tax_number, is_active, notes, arms_length`), on)
  if (!row) throw new PartyError('NO_PARTY', 'That party does not exist.')
  return row
}
