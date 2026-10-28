import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { like, type Query } from '@/lib/query'
import type { Hit } from '@/lib/search'

export async function matchingShares(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const rows = await db.execute<{
    on_date: string; kind: string; holder: string; class_name: string
    details: string; certificate_no: string | null; consideration: string | null
    delta: string
  }>(sql`
    SELECT t.on_date::text, t.kind, p.name AS holder, c.name AS class_name,
           t.details, t.certificate_no, t.consideration, t.delta::text
      FROM share_transaction t
      JOIN share_class c ON c.id = t.share_class_id
      JOIN party p ON p.id = t.party_id
     WHERE c.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
       AND (t.details ILIKE ${like(q)} ESCAPE '\\'
            OR t.consideration ILIKE ${like(q)} ESCAPE '\\'
            OR t.certificate_no ILIKE ${like(q)} ESCAPE '\\'
            OR t.surrendered_no ILIKE ${like(q)} ESCAPE '\\'
            OR p.name ILIKE ${like(q)} ESCAPE '\\'
            OR c.name ILIKE ${like(q)} ESCAPE '\\'
            OR ${q.date ? sql`t.on_date = ${q.date}::date` : sql`false`})
     ORDER BY t.on_date DESC
     LIMIT ${limit}`)
  return rows.map((t) => ({
    kind: 'Shares' as const,
    title: `${t.holder} — ${t.delta} ${t.class_name}`,
    detail: [t.kind.replace('_', ' '), t.details, t.consideration ?? null,
             t.certificate_no ? `cert ${t.certificate_no}` : null].filter(Boolean).join(' · '),
    date: t.on_date,
    amount: null,
    href: '/records/register/central_securities',
  }))
}

export async function matchingMinutes(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const rows = await db.execute<{
    id: string; record_kind: string; on_date: string; title: string
    kept_at: string; note: string | null
  }>(sql`
    SELECT m.id::text, m.record_kind, m.on_date::text, m.title, m.kept_at, m.note
      FROM minute_book_entry m
     WHERE m.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
       AND (m.title ILIKE ${like(q)} ESCAPE '\\'
            OR m.note ILIKE ${like(q)} ESCAPE '\\'
            OR m.kept_at ILIKE ${like(q)} ESCAPE '\\'
            OR ${q.date ? sql`m.on_date = ${q.date}::date` : sql`false`})
     ORDER BY m.on_date DESC
     LIMIT ${limit}`)
  return rows.map((m) => ({
    kind: 'Minute book' as const,
    title: m.title,
    detail: [m.record_kind.replaceAll('_', ' '), `kept at ${m.kept_at}`, m.note ?? null]
      .filter(Boolean).join(' · '),
    date: m.on_date,
    amount: null,
    href: `/records/minute-book?q=${encodeURIComponent(m.title)}`,
  }))
}
