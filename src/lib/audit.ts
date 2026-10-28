import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { csvFile } from './csv'

/**
 * The audit trail, read.
 *
 * Every trigger and every application path has written to `audit_log` since
 * 0001 — who, when, what, before and after — and until 2026-09-04 nothing read
 * it back but a psql prompt. This is the reader: newest first, filtered by the
 * things a person asks with ("what did X do", "what happened to this entry",
 * "what changed last Tuesday"), and capped, because the trail is the one table
 * that only grows.
 *
 * Owner-only at the door (the page), because the trail spans every company:
 * a row names a table and a record id, not a ledger, and pretending to filter
 * it by company would be a filter that lets through whatever the writer did
 * not label.
 */
export type AuditRow = {
  id: string
  occurred_at: string
  actor: string
  action: string
  table_name: string
  record_id: string | null
  before: unknown
  after: unknown
  context: unknown
  entity_id: string | null
  ledger_id: string | null
  scope: 'company' | 'shared' | 'system' | 'unresolved'
  reason: string | null
  target_label: string | null
  entity_name: string | null
  ledger_name: string | null
  chain_id?:string|null
  chain_seq?:string|null
  source?:string
}

export type AuditFilter = {
  actor?: string
  action?: string
  table?: string
  /** A record id, or a fragment of one. */
  record?: string
  entity?: string
  ledger?: string
  scope?: 'company' | 'shared' | 'system' | 'unresolved'
  from?: string
  to?: string
  limit?: number
}

export const AUDIT_LIMIT = 200
export const AUDIT_EXPORT_LIMIT = 50_000

const SCOPES = ['company', 'shared', 'system', 'unresolved'] as const

const validDay = (value: string | undefined): string | undefined => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const day = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(day.valueOf()) || day.toISOString().slice(0, 10) !== value
    ? undefined : value
}

/** One parser for the page and its CSV route, so "what I see" is what leaves. */
export function auditFilterFrom(q: Record<string, string | undefined>): AuditFilter {
  const scope = q.scope && SCOPES.includes(q.scope as typeof SCOPES[number])
    ? q.scope as typeof SCOPES[number] : undefined
  return {
    actor: q.actor || undefined,
    action: q.action || undefined,
    table: q.table || undefined,
    record: q.record || undefined,
    entity: q.entity || undefined,
    ledger: q.ledger || undefined,
    scope,
    from: validDay(q.from),
    to: validDay(q.to),
  }
}

/** The zone a calendar day is read in — the machine's, like today.ts. */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

export async function auditTrail(filter: AuditFilter = {}): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(filter.limit ?? AUDIT_LIMIT, 1), AUDIT_EXPORT_LIMIT + 1)
  const validUuid = (value: string | undefined) => value
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value : null
  const entity = validUuid(filter.entity)
  const ledger = validUuid(filter.ledger)
  const scope = filter.scope && SCOPES.includes(filter.scope)
    ? filter.scope : null
  const from = validDay(filter.from)
  const to = validDay(filter.to)
  const rows = await db.execute<AuditRow>(sql`
    SELECT a.id::text, a.occurred_at::text, a.actor, a.action, a.table_name, a.record_id,
           audit_canonical_v1(audit_redact(a.before))::jsonb AS before, audit_canonical_v1(audit_redact(a.after))::jsonb AS after,
           audit_canonical_v1(audit_redact(a.context))::jsonb AS context, a.entity_id::text, a.ledger_id::text,
           a.scope, a.reason, a.target_label, e.name AS entity_name, l.name AS ledger_name,
           a.chain_id::text,a.chain_seq::text,a.source
      FROM audit_log a
      LEFT JOIN entity e ON e.id = a.entity_id
      LEFT JOIN ledger l ON l.id = a.ledger_id
     WHERE (${filter.actor ?? null}::text IS NULL OR actor = ${filter.actor ?? null})
       AND (${filter.action ?? null}::text IS NULL OR action = ${filter.action ?? null})
       AND (${filter.table ?? null}::text IS NULL OR table_name = ${filter.table ?? null})
       AND (${filter.record ?? null}::text IS NULL OR record_id LIKE '%' || ${filter.record ?? null} || '%')
       AND (${entity}::uuid IS NULL OR a.entity_id = ${entity}::uuid)
       AND (${ledger}::uuid IS NULL OR a.ledger_id = ${ledger}::uuid)
       AND (${scope}::text IS NULL OR a.scope = ${scope})
       -- Calendar days in THIS machine's zone, the way today.ts reads a day —
       -- not the database session's midnight, which is wherever the server
       -- happens to be (critic, 2026-09-04).
       AND (${from ?? null}::date IS NULL OR (occurred_at AT TIME ZONE ${ZONE})::date >= ${from ?? null}::date)
       AND (${to ?? null}::date IS NULL OR (occurred_at AT TIME ZONE ${ZONE})::date <= ${to ?? null}::date)
     ORDER BY occurred_at DESC, id DESC
     LIMIT ${limit}`)
  return rows
}

/** Spreadsheet-ready audit rows; csvFile also neutralises formula prefixes. */
export function auditCsv(rows: AuditRow[]): string {
  const json = (value: unknown) => value === null || value === undefined
    ? '' : JSON.stringify(value)
  return csvFile([
    [
      'Audit id', 'Occurred at', 'Actor', 'Action', 'Table', 'Target', 'Record id', 'Scope',
      'Company', 'Company id', 'Ledger', 'Ledger id', 'Reason', 'Before', 'After', 'Context',
    ],
    ...rows.map((row) => [
      row.id, row.occurred_at, row.actor, row.action, row.table_name, row.target_label,
      row.record_id, row.scope, row.entity_name, row.entity_id, row.ledger_name,
      row.ledger_id, row.reason, json(row.before), json(row.after), json(row.context),
    ]),
  ])
}

/** The vocabulary the filters offer — read from the trail, not typed. */
export async function auditVocabulary() {
  const [actors, actions, tables, entities, ledgers] = await Promise.all([
    db.execute<{ v: string }>(sql`SELECT DISTINCT actor AS v FROM audit_log ORDER BY 1`),
    db.execute<{ v: string }>(sql`SELECT DISTINCT action AS v FROM audit_log ORDER BY 1`),
    db.execute<{ v: string }>(sql`SELECT DISTINCT table_name AS v FROM audit_log ORDER BY 1`),
    db.execute<{ id: string; label: string }>(sql`
      SELECT DISTINCT a.entity_id::text AS id,
             COALESCE(e.name, a.target_label, 'Deleted company · ' || left(a.entity_id::text, 8)) AS label
        FROM audit_log a LEFT JOIN entity e ON e.id = a.entity_id
       WHERE a.entity_id IS NOT NULL ORDER BY label, id`),
    db.execute<{ id: string; label: string }>(sql`
      SELECT DISTINCT a.ledger_id::text AS id,
             COALESCE(l.name, 'Deleted ledger · ' || left(a.ledger_id::text, 8)) AS label
        FROM audit_log a LEFT JOIN ledger l ON l.id = a.ledger_id
       WHERE a.ledger_id IS NOT NULL ORDER BY label, id`),
  ])
  return {
    actors: actors.map((r) => r.v),
    actions: actions.map((r) => r.v),
    tables: tables.map((r) => r.v),
    entities,
    ledgers,
  }
}
