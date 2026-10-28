import { sql } from 'drizzle-orm'
import type { Tx } from './acting'

/**
 * One audit row, written by the application inside the transaction that
 * makes the change it describes.
 *
 * The triggers write the rows for tables that have them; `app_user` and the
 * grant tables have none (0053, 0054), so the people doors write their own.
 * Before/after are whatever the door chooses to record — never a password
 * hash — and `context` is for what identifies the record to a reader once
 * the record itself is gone (an email beside a user id).
 */
export type AuditWrite = {
  actor: string
  action: string
  table: string
  recordId: string
  before?: unknown
  after?: unknown
  context?: unknown
  entityId?: string | null
  ledgerId?: string | null
  scope?: 'company' | 'shared' | 'system' | 'unresolved'
  reason?: string | null
  targetLabel?: string | null
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v))

export const auditRow = (tx: Tx, w: AuditWrite) => tx.execute(sql`
  INSERT INTO audit_log (
    actor, action, table_name, record_id, before, after, context,
    entity_id, ledger_id, scope, reason, target_label
  )
  VALUES (${w.actor}, ${w.action}, ${w.table}, ${w.recordId},
          ${json(w.before)}::jsonb, ${json(w.after)}::jsonb, ${json(w.context)}::jsonb,
          ${w.entityId ?? null}::uuid, ${w.ledgerId ?? null}::uuid,
          ${w.scope ?? 'unresolved'}, ${w.reason?.trim() || null}, ${w.targetLabel ?? null})`)
