import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'

/**
 * The company a ledger belongs to — the first thing nearly every page under
 * /ledger/[ledgerId] asks, and until 2026-09-13 asked in its own copy of the
 * same six-word query (thirty-seven of them). One spelling; each caller still
 * decides what a missing row means to it: notFound, null, or a refusal.
 */
export type LedgerHead = { entity: string; entity_id: string; entity_code: string; currency: string }

export async function ledgerHead(ledgerId: string): Promise<LedgerHead | null> {
  const [row] = await db.execute<LedgerHead>(sql`
    SELECT e.name AS entity, e.id::text AS entity_id, e.code AS entity_code, l.currency
      FROM ledger l JOIN entity e ON e.id = l.entity_id
     WHERE l.id = ${ledgerId}::uuid`)
  return row ?? null
}
