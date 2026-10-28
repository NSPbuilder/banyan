import 'server-only'
import { ROLE } from './roles'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { acting, actingAs } from './acting'
import { importAccountsCore, type NewAccount } from './accounts'
import { localToday } from './today'
import { nextDay } from './date-range'

/**
 * Whether a company is registered for a sales tax, and the accounts that go
 * with being registered.
 *
 * Which taxes apply is a fact about the province, and getting it wrong is quiet:
 * PST in British Columbia, Saskatchewan and Manitoba is generally NOT
 * recoverable by a business — it is a cost, not an input tax credit. Creating a
 * "PST recoverable" account there would be an account that should never carry a
 * balance and will eventually carry one.
 */

export class RegistrationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RegistrationError'
  }
}

export type TaxKind = 'GST_HST' | 'QST' | 'PST'

/** What a person calls each one, for a message they have to act on. */
const TAX_NAME: Record<TaxKind, string> = { GST_HST: 'GST/HST', QST: 'QST', PST: 'PST' }

export type TaxProfile = {
  tax: TaxKind
  /** What a person calls it where they are. */
  label: string
  /** Whether tax paid on purchases can be claimed back. */
  recoverable: boolean
  note?: string
}

const HST = ['ON', 'NB', 'NL', 'NS', 'PE']
const GST_PST = ['BC', 'SK', 'MB']

/** The sales taxes a company in this province may have to register for. */
export function taxesFor(province: string | null): TaxProfile[] {
  const p = (province ?? '').toUpperCase()

  if (HST.includes(p)) {
    return [{ tax: 'GST_HST', label: 'HST', recoverable: true,
              note: 'GST and the provincial part are one tax here, with one registration.' }]
  }
  if (p === 'QC') {
    return [
      { tax: 'GST_HST', label: 'GST', recoverable: true },
      { tax: 'QST', label: 'QST', recoverable: true,
        note: 'Quebec administers QST itself, with its own number and its own return.' },
    ]
  }
  if (GST_PST.includes(p)) {
    return [
      { tax: 'GST_HST', label: 'GST', recoverable: true },
      { tax: 'PST', label: 'PST', recoverable: false,
        note: 'PST paid on purchases is generally a cost here, not something you claim back — '
            + 'so there is no "recoverable" account to create.' },
    ]
  }
  // AB, NT, NU, YT, and anywhere unrecognised.
  return [{ tax: 'GST_HST', label: 'GST', recoverable: true }]
}

export type ProposedAccount = {
  code: string
  name: string
  accountType: 'liability' | 'asset'
  role: string
  why: string
  /**
   * Set when an account already carries this role.
   *
   * Registering again after a gap reuses it — two "GST/HST Payable" accounts
   * would split every future return down the middle. But the form was still
   * offering an editable code and name for it, and `registerTax` discarded
   * whatever was typed. A box that ignores what you put in it is worse than no
   * box: it says a decision is yours when it is not.
   */
  existing?: { code: string; name: string }
}

/**
 * The accounts a registration needs, with codes that do not collide with the
 * chart as it stands.
 *
 * Codes are a proposal, not a decision: each company here keeps its own chart
 * with its own numbering, and a hardcoded code would either clash or look
 * foreign in someone else's scheme.
 */
export async function proposedAccounts(
  entityId: string, tax: TaxKind,
): Promise<ProposedAccount[]> {
  const [company] = await db.execute<{ province: string | null }>(sql`
    SELECT province FROM entity WHERE id = ${entityId}::uuid`)
  if (!company) throw new RegistrationError('NO_ENTITY', 'That company does not exist.')

  const profile = taxesFor(company.province).find((t) => t.tax === tax)
  if (!profile) {
    throw new RegistrationError('NOT_APPLICABLE',
      `A company in ${company.province ?? 'that province'} does not register for ${tax}.`)
  }

  const existing = await db.execute<{ code: string }>(sql`
    SELECT code FROM account WHERE entity_id = ${entityId}::uuid ORDER BY code`)
  const taken = new Set(existing.map((a) => a.code))

  /** The first free code at or after a starting point, in the same style. */
  const free = (start: string) => {
    let n = Number(start)
    while (taken.has(String(n))) n += 10
    taken.add(String(n))
    return String(n)
  }

  // Accounts already carrying one of these roles. `registerTax` reuses them, so
  // the form must not pretend the code and name are still open questions.
  const held = new Map((await db.execute<{ code: string; name: string; role: string }>(sql`
    SELECT a.code, a.name, ar.role FROM account a
      JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${entityId}::uuid
       AND ar.role IN (${ROLE.gstPayable},${ROLE.gstRecoverable},
                       'qst_pst_payable','qst_pst_recoverable')`))
    .map((r) => [r.role, { code: r.code, name: r.name }]))

  const label = profile.label
  const out: ProposedAccount[] = [{
    // GIFI vocabulary (2026-09-02): 2680 is CRA's "Taxes payable", whose own
    // description names GST/HST and sales taxes; PST takes the next unassigned
    // number in the block. `free` still steps around a crowded chart.
    code: free(tax === 'GST_HST' ? '2680' : '2681'),
    name: `${label} Payable`,
    accountType: 'liability',
    role: tax === 'GST_HST' ? 'gst_hst_payable' : 'qst_pst_payable',
    why: `The ${label} you charge customers, owed to the tax authority until you remit it.`,
  }]

  if (profile.recoverable) {
    out.push({
      // 1066 "Taxes receivable" names GST/HST in its GIFI description; QST's
      // recoverable side takes 1483 "Taxes recoverable/refundable".
      code: free(tax === 'GST_HST' ? '1066' : '1483'),
      name: `${label} Recoverable`,
      accountType: 'asset',
      role: tax === 'GST_HST' ? ROLE.gstRecoverable : ROLE.pstRecoverable,
      why: `The ${label} you pay on purchases, which you claim back on the return.`,
    })
  }

  return out.map((row) => {
    const already = held.get(row.role)
    return already ? { ...row, existing: already } : row
  })
}

export type Registration = {
  id: string
  tax: TaxKind
  number: string
  registeredOn: string
  ceasedOn: string | null
  active: boolean
}

/**
 * `today` is a parameter so a page can compute it once and hand the same day to
 * everything it renders. Two `new Date()` calls either side of midnight
 * disagree, and the disagreement shows as a badge that contradicts the form
 * beside it.
 */
export async function registrationsFor(
  entityId: string, today = localToday(),
): Promise<Registration[]> {
  const rows = await db.execute<{
    id: string; tax: TaxKind; number: string
    registered_on: string; ceased_on: string | null
  }>(sql`
    SELECT id::text, tax, number, registered_on::text, ceased_on::text
      FROM entity_tax_registration
     WHERE entity_id = ${entityId}::uuid
     ORDER BY tax, registered_on DESC`)

  return rows.map((r) => ({
    id: r.id, tax: r.tax, number: r.number,
    registeredOn: r.registered_on, ceasedOn: r.ceased_on,
    active: r.registered_on <= today && (r.ceased_on === null || r.ceased_on >= today),
  }))
}

/**
 * Every registration that overlaps a date range, in order.
 *
 * Asking about the two ends of the range is not the same question: a company
 * that registered on 1 February and deregistered on 28 February was registered
 * for none of 1 January and none of 31 March, and had a perfectly real
 * February. Testing the endpoints reported it as never registered while its
 * February tax sat in the books.
 */
export async function registrationsOverlapping(
  entityId: string, tax: TaxKind, from: string, to: string,
): Promise<Registration[]> {
  const rows = await db.execute<{
    id: string; tax: TaxKind; number: string
    registered_on: string; ceased_on: string | null
  }>(sql`
    SELECT id::text, tax, number, registered_on::text, ceased_on::text
      FROM entity_tax_registration
     WHERE entity_id = ${entityId}::uuid AND tax = ${tax}
       AND registered_on <= ${to}::date
       AND (ceased_on IS NULL OR ceased_on >= ${from}::date)
     ORDER BY registered_on`)

  const today = localToday()
  return rows.map((r) => ({
    id: r.id, tax: r.tax, number: r.number,
    registeredOn: r.registered_on, ceasedOn: r.ceased_on,
    active: r.registered_on <= today && (r.ceased_on === null || r.ceased_on >= today),
  }))
}


/**
 * How much of a filing period the company was registered for.
 *
 * `part` is a real answer and not a rounding of the other two: a company that
 * registered mid-quarter files for that quarter, but only from the day it
 * registered, and anything taxed before that is a separate problem.
 */
export function coverageOf(
  registrations: Registration[], from: string, to: string,
): 'none' | 'part' | 'all' {
  // Registrations that touch the range at all. Without this, a list holding
  // only registrations from other years answered 'part' — "registered for some
  // of this quarter" about a quarter it covered not one day of. The caller that
  // matters pre-filters, so this was invisible; being exported, that is not a
  // reason to be wrong.
  const touching = registrations.filter(
    (r) => r.registeredOn <= to && (r.ceasedOn === null || r.ceasedOn >= from))
  if (touching.length === 0) return 'none'

  // The EXCLUDE constraint keeps these disjoint, so walking them in order is
  // enough to find a gap. Sorted here rather than assumed: the caller that
  // matters orders by registered_on, but a list in the wrong order would
  // silently report a gap that is not there.
  const inOrder = [...touching].sort((a, b) => a.registeredOn < b.registeredOn ? -1 : 1)

  let cursor = from
  for (const r of inOrder) {
    if (r.registeredOn > cursor) return 'part'
    const end = r.ceasedOn
    if (end === null || end >= to) return 'all'
    // Never move the cursor backwards.
    const next = nextDay(end)
    if (next > cursor) cursor = next
  }
  return 'part'
}

/** Whether a company was registered for a tax on a given day. */
export async function registeredOn(
  entityId: string, tax: TaxKind, date: string,
): Promise<Registration | null> {
  const [row] = await db.execute<{
    id: string; tax: TaxKind; number: string
    registered_on: string; ceased_on: string | null
  }>(sql`
    SELECT id::text, tax, number, registered_on::text, ceased_on::text
      FROM entity_tax_registration
     WHERE entity_id = ${entityId}::uuid AND tax = ${tax}
       AND registered_on <= ${date}::date
       AND (ceased_on IS NULL OR ceased_on >= ${date}::date)
     LIMIT 1`)
  if (!row) return null
  return {
    id: row.id, tax: row.tax, number: row.number,
    registeredOn: row.registered_on, ceasedOn: row.ceased_on, active: true,
  }
}

/**
 * Register, and create the accounts in the same transaction.
 *
 * Both or neither: a registration whose accounts failed to appear looks
 * complete and produces a return of zeroes, which is the failure this whole
 * feature exists to remove.
 */
export async function registerTax(input: {
  entityId: string
  tax: TaxKind
  number: string
  registeredOn: string
  /** Codes the person may have adjusted; names and roles come from the proposal. */
  /**
   * Indexed to match the proposal: entry `i` configures proposed account `i`.
   * A hole means "leave that one as proposed", not "shift the next one up".
   */
  accounts?: Array<{ code: string; name: string; role?: string } | undefined>
  actor?: string
}) {
  const actor = input.actor ?? 'system'
  const number = input.number.trim()

  if (!number) {
    throw new RegistrationError('NO_NUMBER',
      'A registration number is needed — it goes on your invoices and on the return.')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.registeredOn)) {
    throw new RegistrationError('BAD_DATE', 'The registration date must be a date.')
  }
  if (!isRealDate(input.registeredOn)) {
    throw new RegistrationError('BAD_DATE',
      `There is no such date as ${input.registeredOn}.`)
  }

  // A new registration has no end, so it overlaps ANY registration that has not
  // already finished before it starts. Asking only about its first day let a
  // date earlier than a live registration through the guard and into the
  // EXCLUDE constraint, which surfaced as a database error page.
  const [clash] = await db.execute<{ number: string; registered_on: string; ceased_on: string | null }>(sql`
    SELECT number, registered_on::text, ceased_on::text
      FROM entity_tax_registration
     WHERE entity_id = ${input.entityId}::uuid AND tax = ${input.tax}
       AND (ceased_on IS NULL OR ceased_on >= ${input.registeredOn}::date)
     ORDER BY registered_on LIMIT 1`)
  if (clash) {
    throw new RegistrationError('ALREADY',
      clash.registered_on <= input.registeredOn
        ? `Already registered for ${input.tax} on ${input.registeredOn} as ${clash.number}.`
        : `There is already a registration as ${clash.number} from ${clash.registered_on}. `
          + 'End that one first, or start this one after it.')
  }

  const proposal = await proposedAccounts(input.entityId, input.tax)

  // A row that names a role no proposal entry has is a row from a DIFFERENT
  // form. Falling back to position when the role did not match made that
  // silent: rendering the GST proposal inside the PST form produced an account
  // coded 2100 and named "GST Payable" tagged `qst_pst_payable`, reported as
  // success. Matching on identity is only worth anything if a failure to match
  // is an error rather than a shrug.
  const roles = new Set(proposal.map((p) => p.role))
  const stray = input.accounts?.find((a) => a?.role && !roles.has(a.role))
  if (stray) {
    throw new RegistrationError('WRONG_FORM',
      `That form is for ${stray.role?.startsWith('gst') ? 'GST/HST' : 'PST or QST'}, `
      + `not ${TAX_NAME[input.tax]}. Reload the page and try again.`)
  }

  const chosen = proposal.map((p, i) => {
    // Matched on what the row SAYS IT IS, falling back to its position only
    // when it says nothing at all. Five rounds of defects came from something
    // reordering the rows between here and the form; a row that names its own
    // role cannot be misplaced by anything that carries it.
    const given = input.accounts?.find((a) => a?.role === p.role)
               ?? (input.accounts?.[i]?.role ? undefined : input.accounts?.[i])
    return {
      ...p,
      code: given?.code?.trim() || p.code,
      name: given?.name?.trim() || p.name,
    }
  })

  // An account already carrying this role is the one to use: registering again
  // after a gap should not create a second GST/HST Payable.
  const already = await db.execute<{ code: string; role: string }>(sql`
    SELECT a.code, ar.role FROM account a
      JOIN account_role ar ON ar.account_id = a.id
     WHERE a.entity_id = ${input.entityId}::uuid
       AND ar.role IN (${sql.join(chosen.map((c) => sql`${c.role}`), sql`, `)})`)
  const haveRole = new Set(already.map((a) => a.role))
  const toCreate = chosen.filter((c) => !haveRole.has(c.role))

  return db.transaction(async (tx) => {
    await acting(tx, actor)
    if (toCreate.length > 0) {
      const rows: NewAccount[] = toCreate.map((c) => ({
        entityId: input.entityId,
        code: c.code,
        name: c.name,
        accountType: c.accountType,
        roles: [c.role],
      }))
      // The core validates the whole set before writing any of it, inside THIS
      // transaction, so a clashing code stops the registration rather than
      // leaving accounts behind with no registration to explain them.
      await importAccountsCore(tx, input.entityId, rows, actor)
    }

    const [row] = await tx.execute<{ id: string }>(sql`
      INSERT INTO entity_tax_registration (entity_id, tax, number, registered_on, created_by)
      VALUES (${input.entityId}::uuid, ${input.tax}, ${number}, ${input.registeredOn}::date, ${actor})
      RETURNING id::text`)

    return {
      id: row.id,
      created: toCreate.map((c) => `${c.code} ${c.name}`),
      reused: already.map((a) => a.code),
    }
  }).catch((e) => {
    // The guard above reads before the transaction writes, so two people
    // registering at once both pass it and the database settles it. Whichever
    // loses gets a constraint violation, and a driver error is not an answer
    // anyone can act on. Nothing is half-written either way: the whole
    // transaction rolls back, accounts included.
    const code = sqlstateOf(e)
    if (code === '23P01') {
      // A DIFFERENT code from the guard's `ALREADY` on purpose. The two look
      // alike to a person and are opposites to a test: `ALREADY` means nothing
      // was ever written, `RACE` means the accounts were written and then rolled
      // back. A test for the transaction boundary that accepted either would
      // pass on a slow machine where the guard caught it first — which is to
      // say, it would pass without testing anything.
      throw new RegistrationError('RACE',
        `Another registration for ${input.tax} was recorded at the same moment. `
        + 'Nothing was saved here. Reload the page to see it.')
    }
    if (code === '23505') {
      throw new RegistrationError('CODE_TAKEN',
        'One of those account codes was taken while this was being saved. '
        + 'Reload the page and pick another.')
    }
    if (code === '22008' || code === '22007') {
      throw new RegistrationError('BAD_DATE', `There is no such date as ${input.registeredOn}.`)
    }
    throw e
  })
}

/** The Postgres error code, wherever the driver has buried it. */
function sqlstateOf(e: unknown): string | undefined {
  let cur: unknown = e
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    cur = (cur as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Whether a YYYY-MM-DD string is a day that exists.
 *
 * The format test alone accepts 30 February, which reaches Postgres as a cast
 * that fails mid-transaction — after the accounts have been written.
 */
function isRealDate(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(y, m - 1, d))
  return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d
}

/**
 * Stop being registered. The accounts stay.
 *
 * They hold the history of every return already filed, and 0008 refuses to
 * delete an account that has been posted to anyway. Deregistering means "expect
 * no more tax from this date", not "remove the evidence".
 */
export async function ceaseTax(registrationId: string, ceasedOn: string, actor = 'system') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ceasedOn) || !isRealDate(ceasedOn)) {
    throw new RegistrationError('BAD_DATE', 'The date you stopped being registered must be a date.')
  }

  const [row] = await db.execute<{
    tax: TaxKind; number: string; registered_on: string; entity_id: string; ceased_on: string | null
  }>(sql`
    SELECT tax, number, registered_on::text, entity_id::text, ceased_on::text FROM entity_tax_registration
     WHERE id = ${registrationId}::uuid`)
  if (!row) throw new RegistrationError('NO_REGISTRATION', 'That registration does not exist.')
  if (ceasedOn < row.registered_on) {
    throw new RegistrationError('BAD_DATE',
      `Registration began on ${row.registered_on}; it cannot end before it started.`)
  }

  // ONE RULE FOR AN END BEFORE WHAT IS POSTED, WHICHEVER DOOR SETS IT: the
  // end is recorded, and the sentence says what falls outside it. Tax posted
  // after a registration ended is a state this system was built to REPORT
  // (0015, `R20`) — refusing the true end date would leave a registration
  // claiming days it did not have, and a sales invoice dated after it
  // reprinting a number that was no longer the company's. The first versions
  // refused some doors and warned at others, and two saves reached what one
  // refused (independent critic, 2026-09-16); now every door says the same
  // thing. Only deleting a registration something rests on is refused.
  const outsideAfterEnd = await outsideOf(row, registrationId, { from: row.registered_on, to: ceasedOn })

  // Ending a registration LATER can run it into the next one. The EXCLUDE
  // constraint refuses that, and a driver error is not an answer anyone can act
  // on — the same gap `registerTax` had, in the function beside it.
  const [next] = await db.execute<{ number: string; registered_on: string }>(sql`
    SELECT number, registered_on::text FROM entity_tax_registration
     WHERE entity_id = ${row.entity_id}::uuid AND tax = ${row.tax}
       AND id <> ${registrationId}::uuid
       AND registered_on > ${row.registered_on}::date
     ORDER BY registered_on LIMIT 1`)
  if (next && ceasedOn >= next.registered_on) {
    throw new RegistrationError('OVERLAP',
      `The next registration, ${next.number}, begins on ${next.registered_on}. `
      + 'This one has to end before then.')
  }

  try {
    await db.execute(sql`
      UPDATE entity_tax_registration
         SET ceased_on = ${ceasedOn}::date, ceased_by = ${actor}
       WHERE id = ${registrationId}::uuid`)
  } catch (e) {
    const code = sqlstateOf(e)
    if (code === '23P01') {
      // `RACE`, not `OVERLAP`, for the same reason `registerTax` distinguishes
      // them: OVERLAP means the guard above saw it, RACE means the guard did
      // not and the database did. A test that accepted either would pass with
      // the guard deleted — which is exactly what it did, until this line.
      throw new RegistrationError('RACE',
        'Another registration for this tax changed while this was being saved. '
        + 'Nothing was saved here. Reload the page to see it.')
    }
    if (code === '22008' || code === '22007') {
      throw new RegistrationError('BAD_DATE', `There is no such date as ${ceasedOn}.`)
    }
    throw e
  }

  return { tax: row.tax, number: row.number, ceasedOn, outside: outsideAfterEnd }
}

/**
 * WHAT ALREADY RESTS ON A REGISTRATION'S DAYS: tax posted to this tax's accounts
 * and invoices issued, dated inside a span — and, given a second span, only
 * those the second no longer covers. A registration those rest on is what the
 * returns were filed against and what the documents carried, so deleting it or
 * moving its dates past them would rewrite what was already handed over — the
 * thing the locks the owner kept exist to prevent (independent critic,
 * 2026-09-16).
 *
 * SALES invoices only: a supplier's bill carries the supplier's number, never
 * ours (`customer-docs.ts` will not render one), so it holds no registration.
 */
const billsHoldRegistrations = false
async function restingOn(
  entityId: string, tax: TaxKind, span: { from: string; to: string | null },
  stillCovered: { from: string; to: string | null } | null = null,
): Promise<{ lines: number; invoices: number; first: string | null }> {
  const roles = tax === 'GST_HST' ? [ROLE.gstPayable, ROLE.gstRecoverable] : [ROLE.pstPayable, ROLE.pstRecoverable]
  const inSpan = (col: ReturnType<typeof sql.raw>) => sql`${col} BETWEEN ${span.from}::date AND COALESCE(${span.to}::date, 'infinity'::date)`
  const outsideKept = (col: ReturnType<typeof sql.raw>) => stillCovered
    ? sql`AND NOT (${col} BETWEEN ${stillCovered.from}::date AND COALESCE(${stillCovered.to}::date, 'infinity'::date))`
    : sql``
  const [row] = await db.execute<{ lines: number; invoices: number; first: string | null }>(sql`
    SELECT
      (SELECT count(*)::int FROM journal_line jl
         JOIN journal_entry je ON je.id = jl.entry_id
         JOIN ledger l ON l.id = je.ledger_id
        WHERE l.entity_id = ${entityId}::uuid AND je.status IN ('posted', 'reversed')
          AND EXISTS (SELECT 1 FROM account_role ar WHERE ar.account_id = jl.account_id
                       AND ar.role IN (${sql.join(roles.map((r) => sql`${r}`), sql`, `)}))
          AND ${inSpan(sql.raw('je.entry_date'))} ${outsideKept(sql.raw('je.entry_date'))}) AS lines,
      (SELECT count(*)::int FROM invoice i
        WHERE i.entity_id = ${entityId}::uuid AND i.status = 'posted'
          AND (i.direction = 'sales' OR ${billsHoldRegistrations})
          AND ${inSpan(sql.raw('i.issued_on'))} ${outsideKept(sql.raw('i.issued_on'))}) AS invoices,
      (SELECT min(d)::text FROM (
         SELECT je.entry_date AS d FROM journal_line jl
           JOIN journal_entry je ON je.id = jl.entry_id JOIN ledger l ON l.id = je.ledger_id
          WHERE l.entity_id = ${entityId}::uuid AND je.status IN ('posted', 'reversed')
            AND EXISTS (SELECT 1 FROM account_role ar WHERE ar.account_id = jl.account_id
                         AND ar.role IN (${sql.join(roles.map((r) => sql`${r}`), sql`, `)}))
            AND ${inSpan(sql.raw('je.entry_date'))} ${outsideKept(sql.raw('je.entry_date'))}
         UNION ALL
         SELECT i.issued_on FROM invoice i
          WHERE i.entity_id = ${entityId}::uuid AND i.status = 'posted'
            AND (i.direction = 'sales' OR ${billsHoldRegistrations})
            AND ${inSpan(sql.raw('i.issued_on'))} ${outsideKept(sql.raw('i.issued_on'))}) x) AS first`)
  return row
}

const restingSentence = (r: { lines: number; invoices: number; first: string | null }) =>
  [r.lines ? `${r.lines} posted tax line${r.lines === 1 ? '' : 's'}` : '', r.invoices ? `${r.invoices} posted sales invoice${r.invoices === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' and ') + (r.first ? `, the first dated ${r.first}` : '')

/** What each kind rests on, said once for every refusal that names them. */
const RESTING_WHY = 'Tax lines are what the return reads, and a sales invoice prints the registration number every time it is printed.'

/**
 * What a registration's new dates leave outside ANY registration of its tax:
 * posted tax lines and sales invoices dated in the old span (or, for an open
 * one, anywhere after its start) that neither the new dates nor the next
 * registration cover — as the sentence a door appends, or '' when nothing is.
 */
async function outsideOf(
  row: { tax: TaxKind; entity_id: string; registered_on: string; ceased_on: string | null },
  registrationId: string, now: { from: string; to: string | null },
): Promise<string> {
  const [next] = await db.execute<{ registered_on: string; before: string }>(sql`
    SELECT registered_on::text, (registered_on - 1)::text AS before FROM entity_tax_registration
     WHERE entity_id = ${row.entity_id}::uuid AND tax = ${row.tax} AND id <> ${registrationId}::uuid
       AND registered_on > ${row.registered_on}::date
     ORDER BY registered_on LIMIT 1`)
  const from = row.registered_on < now.from ? row.registered_on : now.from
  const r = await restingOn(row.entity_id, row.tax, { from, to: next?.before ?? null }, now)
  const bits: string[] = []
  if (r.lines) bits.push(`${r.lines} posted tax line${r.lines === 1 ? '' : 's'} now fall${r.lines === 1 ? 's' : ''} outside it — the return will list ${r.lines === 1 ? 'it' : 'them'} as outside the registration`)
  if (r.invoices) bits.push(`${r.invoices} posted sales invoice${r.invoices === 1 ? '' : 's'} dated outside it will print without the number`)
  return bits.join('; ')
}

/**
 * Put a registration right (0084): its number, the day it began, and the day
 * it ended — or none, which un-ends it. For a registration ENTERED wrong; a
 * registration that really stopped is `ceaseTax`, and keeps its dates.
 *
 * Every refusal is said before the database would say it: an overlap names the
 * registration it would run into.
 */
export async function correctRegistration(input: {
  registrationId: string; number: string; registeredOn: string
  /** '' — still registered. */
  ceasedOn: string
  actor: string
}) {
  const number = input.number.trim()
  const ceasedOn = input.ceasedOn.trim() || null
  if (!number) {
    throw new RegistrationError('NO_NUMBER', 'A registration number is needed — it goes on your invoices and on the return.')
  }
  for (const d of [input.registeredOn, ceasedOn]) {
    if (d !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isRealDate(d))) {
      throw new RegistrationError('BAD_DATE', `"${d}" is not a date.`)
    }
  }
  if (ceasedOn && ceasedOn < input.registeredOn) {
    throw new RegistrationError('BAD_DATE',
      `It cannot end on ${ceasedOn}, before it began on ${input.registeredOn}.`)
  }
  const [row] = await db.execute<{ tax: TaxKind; entity_id: string; number: string; registered_on: string; ceased_on: string | null }>(sql`
    SELECT tax, entity_id::text, number, registered_on::text, ceased_on::text
      FROM entity_tax_registration WHERE id = ${input.registrationId}::uuid`)
  if (!row) throw new RegistrationError('NO_REGISTRATION', 'That registration does not exist.')
  // The same rule as `ceaseTax`: new dates are saved, and what they leave
  // outside is said — not refused — so the two doors cannot disagree.
  const outsideNewDates = await outsideOf(row, input.registrationId, { from: input.registeredOn, to: ceasedOn })
  const [clash] = await db.execute<{ number: string; registered_on: string; ceased_on: string | null }>(sql`
    SELECT number, registered_on::text, ceased_on::text FROM entity_tax_registration
     WHERE entity_id = ${row.entity_id}::uuid AND tax = ${row.tax} AND id <> ${input.registrationId}::uuid
       AND daterange(registered_on, COALESCE(ceased_on, 'infinity'::date), '[]')
        && daterange(${input.registeredOn}::date, COALESCE(${ceasedOn}::date, 'infinity'::date), '[]')
     ORDER BY registered_on LIMIT 1`)
  if (clash) {
    throw new RegistrationError('OVERLAP',
      `Registration ${clash.number} runs from ${clash.registered_on}${clash.ceased_on ? ` to ${clash.ceased_on}` : ''}; `
      + 'these dates would share days with it.')
  }
  try {
    await actingAs(input.actor, (tx) => tx.execute(sql`
      UPDATE entity_tax_registration
         SET number = ${number}, registered_on = ${input.registeredOn}::date,
             ceased_on = ${ceasedOn}::date, ceased_by = ${ceasedOn ? input.actor : null}
       WHERE id = ${input.registrationId}::uuid`))
  } catch (e) {
    if (sqlstateOf(e) === '23P01') {
      throw new RegistrationError('RACE',
        'Another registration for this tax changed while this was being saved. Nothing was saved here. Reload the page to see it.')
    }
    throw e
  }
  return { tax: row.tax, number, registeredOn: input.registeredOn, ceasedOn, renumbered: number !== row.number, outside: outsideNewDates }
}

/**
 * Delete a registration that was entered by mistake (0084). The accounts it
 * created stay — they may hold posted tax, and 0008 would refuse to delete them
 * then anyway — and the audit log keeps what the registration said.
 */
export async function deleteRegistration(registrationId: string, actor: string) {
  const [row] = await db.execute<{ tax: TaxKind; entity_id: string; number: string; registered_on: string; ceased_on: string | null }>(sql`
    SELECT tax, entity_id::text, number, registered_on::text, ceased_on::text
      FROM entity_tax_registration WHERE id = ${registrationId}::uuid`)
  if (row) {
    const resting = await restingOn(row.entity_id, row.tax, { from: row.registered_on, to: row.ceased_on })
    if (resting.lines + resting.invoices > 0) {
      throw new RegistrationError('POSTED_UNDER',
        `${row.number} has ${restingSentence(resting)} dated while it was registered. ${RESTING_WHY} `
        + 'So it stays; end it on the right date instead.')
    }
  }
  const gone = await actingAs(actor, (tx) => tx.execute<{ tax: TaxKind; number: string }>(sql`
    DELETE FROM entity_tax_registration WHERE id = ${registrationId}::uuid RETURNING tax, number`))
  if (gone.length === 0) throw new RegistrationError('NO_REGISTRATION', 'That registration does not exist.')
  return gone[0]
}

/**
 * What the registration page shows: which taxes still need registering, and for
 * each registration on file, how its end-date form should read.
 *
 * A pure function because the page that held this logic was rendered by
 * nothing. Two one-line changes to it passed every check: dropping `.active`
 * from the filter meant a company that had ever ceased a registration could
 * never register again — the form vanished and the page said it was registered
 * for everything; and defaulting the date to today gave a not-yet-started
 * registration a value its own guard refuses, and silently rewrote a recorded
 * end date on re-save.
 *
 * `today` is passed in for the same reason it is passed to `registrationsFor`:
 * one day for the whole page, and a day a check can choose.
 */
export type RegistrationView = {
  /** Taxes with no live registration — a form is offered for each. */
  open: TaxProfile[]
  rows: Array<{
    registration: Registration
    /** `ended`, `starts later`, or nothing. */
    badge: string | null
    mode: 'end' | 'change' | 'correct'
    /** A date `ceaseTax` will accept for this registration. */
    defaultDate: string
  }>
}

export function registrationView(
  applicable: TaxProfile[], existing: Registration[], today: string,
): RegistrationView {
  return {
    // A ceased registration can be picked up again, so what closes a form is a
    // LIVE registration, not any registration.
    open: applicable.filter((t) => !existing.some((r) => r.tax === t.tax && r.active)),
    rows: existing.map((r) => ({
      registration: r,
      badge: r.active ? null
           : r.ceasedOn !== null && r.ceasedOn < today ? 'ended'
           : 'starts later',
      // "Has an end date" is not "has ended": one in the future is still live.
      mode: r.ceasedOn === null ? 'end' : r.ceasedOn < today ? 'correct' : 'change',
      // Today is before a registration that has not started, and `ceaseTax`
      // refuses an end date earlier than the start.
      defaultDate: r.ceasedOn ?? (r.registeredOn > today ? r.registeredOn : today),
    })),
  }
}

/**
 * The proposal to show under each tax still open — the accounts that tax needs,
 * paired with the tax they belong to.
 *
 * A function rather than a line in the page because the pairing is the thing
 * that can be got wrong: asking `proposedAccounts` for one tax while heading
 * the form with another produced a form titled "Register for PST" carrying an
 * account coded 2100 and named "GST Payable". `registerTax` refuses that now —
 * but refusing forever is not the same as working, and nothing was checking
 * which proposal went with which tax.
 */
export async function openProposals(entityId: string, open: TaxProfile[]) {
  return Promise.all(open.map(async (t) => ({
    tax: t.tax,
    label: t.label,
    note: t.note,
    rows: await proposedAccounts(entityId, t.tax),
  })))
}
