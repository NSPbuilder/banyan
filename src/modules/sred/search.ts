import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { like, type Query } from '@/lib/query'
import type { Hit } from '@/lib/search'

export async function matchingSred(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const rows = await db.execute<{ id: string; code: string; title: string; status: string; started_on: string }>(sql`
    SELECT sp.id::text, sp.code, sp.title, sp.status, sp.started_on::text
      FROM sred_project sp
     WHERE sp.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
       AND (sp.code ILIKE ${like(q)} ESCAPE '\\' OR sp.title ILIKE ${like(q)} ESCAPE '\\')
     ORDER BY sp.started_on DESC
     LIMIT ${limit}`)
  return rows.map((r) => ({
    kind: 'SR&ED' as const,
    title: `${r.code} — ${r.title}`,
    detail: r.status,
    date: r.started_on,
    amount: null,
    href: `/sred/${r.id}`,
  }))
}
