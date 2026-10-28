import { formatNumber } from './numbers'
import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { localStamp, localToday } from './today'
import {
  allDirectorships, allSignificantIndividuals, movementsAfter, securitiesRegister,
  shareMovements, shareTotalsAsAt,
} from './records'

/**
 * ONE renderer, two exits.
 *
 * `renderRegister` builds the whole document — title, header lines, columns,
 * rows — as data. The preview page displays that structure; the print view
 * prints the SAME structure. Two code paths each doing their own queries would
 * be two answers to one question, which is this repository's oldest defect
 * shape; the design doc's acceptance test is that adding a field is ONE change
 * and both exits show it, and a mutation that breaks this renderer must redden
 * the preview check and the PDF check together.
 *
 * Who may see what is DATA (`register_field_visibility`), because the law on
 * the transparency register's openness changes by regulation: the day it
 * changes, rows change, not code. Statute references live in
 * `docs/design/05-corporate-records.md` and are deliberately absent here —
 * including from the rendered headers, which say what a reader must know
 * without citing the section that says it.
 */

export type RegisterKind = 'directors' | 'central_securities' | 'transparency'
export const REGISTER_KINDS: RegisterKind[] = ['directors', 'central_securities', 'transparency']
export type Audience = 'director' | 'public'

/** A table on a register: its heading, its columns, its rows. */
export type RegisterTable = {
  title: string
  columns: string[]
  rows: string[][]
}

export type RenderedRegister = {
  kind: RegisterKind
  title: string
  entityName: string
  asOf: string
  audience: Audience
  generatedAt: string
  /** Every line a printed page must carry, in order. */
  headerNotes: string[]
  columns: string[]
  rows: string[][]
  /**
   * A second table under the first. The central securities register is a
   * two-part document: WHO holds what, and the date and particulars of every
   * issue and transfer that got them there. Both exits render
   * `[the main table, ...detail]` through one piece of code, so a register
   * with two tables is still not two rendering paths.
   */
  detail?: RegisterTable
  /** Fields the audience was not allowed to see, named so the omission is loud. */
  withheld: string[]
}

/** What a movement was, in the Act's own vocabulary, and with whom. */
function howAcquired(kind: string, counterparty: string | null): string {
  if (kind === 'issue') return 'Allotment'
  if (kind === 'transfer_in') return `Transfer from ${counterparty ?? 'a former holder'}`
  if (kind === 'transfer_out') return `Transfer to ${counterparty ?? 'a new holder'}`
  return 'Cancelled — bought back or redeemed'
}

const TITLES: Record<RegisterKind, string> = {
  directors: 'Register of Directors',
  central_securities: 'Central Securities Register',
  transparency: 'Transparency Register',
}

async function visibleFields(kind: RegisterKind, audience: Audience): Promise<{
  allowed: (field: string) => boolean
  withheld: string[]
}> {
  if (audience === 'director') return { allowed: () => true, withheld: [] }
  const rows = await db.execute<{ field: string; visibility: string }>(sql`
    SELECT field, visibility FROM register_field_visibility WHERE register = ${kind}`)
  const priv = new Set(rows.filter((r) => r.visibility === 'private').map((r) => r.field))
  return { allowed: (f) => !priv.has(f), withheld: [...priv].sort() }
}

export async function renderRegister(
  kind: RegisterKind, entityId: string, asOf: string, audience: Audience,
): Promise<RenderedRegister> {
  const [entity] = await db.execute<{ name: string }>(sql`
    SELECT name FROM entity WHERE id = ${entityId}::uuid`)
  const { allowed, withheld } = await visibleFields(kind, audience)
  // What this register would say if it were asked about a later day. An
  // as-at answer is silent about everything after its date, correctly and
  // invisibly — which is how two buy-backs dated later than today looked
  // like a feature that did nothing (owner, 2026-09-03).
  const later = await movementsAfter(kind, entityId, asOf)

  const base: Omit<RenderedRegister, 'columns' | 'rows'> = {
    kind,
    title: TITLES[kind],
    entityName: entity?.name ?? 'Unknown company',
    asOf,
    audience,
    // The person's clock, not UTC. `R47` scans every file for the UTC-now
    // idiom and caught this line's first version on its first full battery: a
    // register generated at 8pm in Vancouver stamped tomorrow's date. The
    // idiom itself is deliberately not spelled out here — R47 reads source
    // text, comments included. `today.ts` has the argument.
    generatedAt: `${localToday()} ${localStamp().slice(9)}`,
    headerNotes: [
      `As at ${asOf}`,
      `Prepared for: ${audience === 'director' ? 'a director of the company' : 'public inspection'}`,
      kind === 'transparency'
        ? 'NOT available for public inspection. This register may be shown only to a director of the company or an official entitled to inspect it.'
        : 'Availability of this record depends on who is asking; the design note names the rule.',
      // Last, so the availability sentence keeps its place on the page.
      ...(later.count > 0 ? [
        `${later.count} ${later.count === 1 ? 'movement is' : 'movements are'} recorded after `
        + `${asOf} and not shown here — the first on ${later.earliest}. `
        + `Ask for a later date.`,
      ] : []),
    ],
    withheld,
  }

  if (kind === 'directors') {
    // The full register: former directors appear WITH their dates — the point
    // of a register is that leaving does not erase anyone.
    const terms = await allDirectorships(entityId)
    const inTerm = terms.filter((t) => t.appointed_on <= asOf)
    const cols = [
      ['name', 'Full name'],
      ['prescribed_delivery', 'Prescribed address'],
      ['appointed_on', 'Appointed'],
      ['ceased_on', 'Ceased'],
    ].filter(([f]) => allowed(f))
    return {
      ...base,
      columns: cols.map(([, label]) => label),
      rows: inTerm.map((t) => cols.map(([f]) => {
        if (f === 'ceased_on') {
          return t.ceased_on && t.ceased_on <= asOf ? t.ceased_on : '—'
        }
        return String(t[f as keyof typeof t] ?? '—')
      })),
    }
  }

  if (kind === 'central_securities') {
    // BC's own template: former holders stay on the page, with the date they
    // became a registered holder and the date their balance reached zero
    // (owner, 2026-09-03). `securitiesRegister` derives both from the
    // transactions; nothing is stored.
    const holdings = await securitiesRegister(entityId, asOf)
    const totals = await shareTotalsAsAt(entityId, asOf)
    const cols = [
      ['class', 'Class / series'],
      ['name', 'Holder'],
      // s.111(1) asks for the holder's LAST KNOWN address by that name; the
      // register kept everything else it asks for and not this.
      ['address', 'Last known address'],
      ['holding', 'Shares held'],
      ['became_on', 'Became holder'],
      ['ceased_on', 'Ceased'],
    ].filter(([f]) => f === 'class' || allowed(f))
    const rows = holdings.map((h) => cols.map(([f]) => {
      if (f === 'class') return h.series ? `${h.class_name} — ${h.series}` : h.class_name
      if (f === 'name') return h.holder
      if (f === 'address') return h.address ?? '—'
      if (f === 'became_on') return h.became_on
      if (f === 'ceased_on') return h.ceased_on ?? '—'
      return formatNumber(h.holding)
    }))
    // The trial-balance line per class, so a reader can add the page up.
    for (const t of totals) {
      rows.push(cols.map(([f]) => {
        if (f === 'class') return t.series ? `${t.class_name} — ${t.series}` : t.class_name
        if (f === 'name') return 'TOTAL ISSUED'
        if (f === 'address' || f === 'became_on' || f === 'ceased_on') return ''
        return formatNumber(t.issued)
      }))
    }

    // The other half of s.111(1): the DATE AND PARTICULARS of each issue and
    // each transfer. One row per movement, with the balance it left that
    // holder standing at — so the summary above is addable rather than
    // asserted, and so "what did this shareholder hold at the time" is a
    // line on the page rather than a query somebody has to write.
    //
    // Gated by ONE visibility row (0050): a public inspection copy of this
    // register shows neither who holds what nor how they came to hold it, so
    // there is no version of it that prints these particulars.
    const detail: RegisterTable | undefined = allowed('particulars')
      ? {
          title: 'Date and particulars of each issue and transfer',
          columns: ['Date', 'Holder', 'Class / series', 'How', 'Shares',
                    'Balance', 'Consideration', 'Certificate', 'Surrendered'],
          rows: (await shareMovements(entityId, asOf)).map((m) => [
            m.on_date,
            m.holder,
            m.series ? `${m.class_name} — ${m.series}` : m.class_name,
            howAcquired(m.kind, m.counterparty),
            formatNumber(m.delta),
            formatNumber(m.running),
            m.consideration ?? '—',
            m.certificate_no ?? '—',
            m.surrendered_no ?? '—',
          ]),
        }
      : undefined

    return { ...base, columns: cols.map(([, label]) => label), rows, detail }
  }

  // Transparency register. Former significant individuals STAY listed with
  // their dates (the BCA keeps them for six years) — only entries that had
  // not yet begun as at the date are left off (owner, 2026-09-03).
  const sis = (await allSignificantIndividuals(entityId))
    .filter((s) => s.became_on <= asOf)
  const cols = [
    ['name', 'Full name'],
    ['birth_date', 'Born'],
    ['last_known_address', 'Last known address'],
    ['citizen_or_pr', 'Canadian citizen or PR'],
    ['citizenships', 'Citizenships (if neither)'],
    ['tax_resident_ca', 'Resident in Canada for tax'],
    ['how_control', 'How they are a significant individual'],
    ['became_on', 'Since'],
    ['ceased_on', 'Ceased'],
  ].filter(([f]) => allowed(f))
  return {
    ...base,
    columns: cols.map(([, label]) => label),
    rows: sis.map((s) => cols.map(([f]) => {
      if (f === 'ceased_on') {
        return s.ceased_on && s.ceased_on <= asOf ? s.ceased_on : '—'
      }
      const v = s[f as keyof typeof s]
      if (typeof v === 'boolean') return v ? 'yes' : 'no'
      return v == null || v === '' ? '—' : String(v)
    })),
  }
}

/**
 * The ledger-facing door, so the PAGE needs no query of its own: `CR16` reads
 * the page's source and refuses it a `sql` of any kind — one renderer, one
 * path, and the ledger-to-entity hop is part of the path.
 */
export async function renderRegisterForLedger(
  kind: RegisterKind, ledgerId: string, asOf: string, audience: Audience,
): Promise<{ register: RenderedRegister; entityId: string } | null> {
  const [head] = await db.execute<{ entity_id: string }>(sql`
    SELECT entity_id::text FROM ledger WHERE id = ${ledgerId}::uuid`)
  if (!head) return null
  return {
    register: await renderRegister(kind, head.entity_id, asOf, audience),
    entityId: head.entity_id,
  }
}

/** The audit row a register export leaves behind — who asked for what, when. */
export async function logRegisterExport(input: {
  entityId: string; kind: RegisterKind; asOf: string; audience: Audience; actor: string
}) {
  await db.execute(sql`
    INSERT INTO audit_log (actor, action, table_name, record_id, context)
    VALUES (${input.actor}, 'export_register', 'register', ${input.entityId},
            ${JSON.stringify({ kind: input.kind, asOf: input.asOf, audience: input.audience })}::jsonb)`)
}
