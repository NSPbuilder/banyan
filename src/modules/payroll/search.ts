import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/db/client'
import { like, type Query } from '@/lib/query'
import type { Hit } from '@/lib/search'

export async function matchingEmployees(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const rows = await db.execute<{
    id: string; name: string; occupation: string | null; frequency: string; is_active: boolean
  }>(sql`
    SELECT pe.id::text, p.name, pe.occupation, pe.frequency, pe.is_active
      FROM payroll_employee pe
      JOIN party p ON p.id = pe.party_id
     WHERE pe.entity_id = (SELECT entity_id FROM ledger WHERE id = ${ledgerId}::uuid)
       AND (p.name ILIKE ${like(q)} ESCAPE '\\' OR pe.occupation ILIKE ${like(q)} ESCAPE '\\')
     ORDER BY p.name
     LIMIT ${limit}`)
  return rows.map((e) => ({
    kind: 'Employee' as const,
    title: e.name,
    detail: [e.occupation, e.frequency.replaceAll('_', '-'), e.is_active ? null : 'no longer employed']
      .filter(Boolean).join(' · '),
    date: null,
    amount: null,
    href: `/payroll/people/${e.id}`,
  }))
}

export async function matchingPayRuns(ledgerId: string, q: Query, limit: number): Promise<Hit[]> {
  const rows = await db.execute<{
    id: string; pay_date: string; period_start: string | null; period_end: string | null
    entry_no: string | null; total: string | null
  }>(sql`
    SELECT pr.id::text, pr.pay_date::text, pr.period_start::text, pr.period_end::text,
           je.entry_no, je.total_debit::text AS total
      FROM pay_run pr
      LEFT JOIN journal_entry je ON je.id = pr.entry_id
     WHERE pr.ledger_id = ${ledgerId}::uuid
       AND (je.entry_no ILIKE ${like(q)} ESCAPE '\\'
            OR ${q.date ? sql`pr.pay_date = ${q.date}::date` : sql`false`})
     ORDER BY pr.pay_date DESC
     LIMIT ${limit}`)
  return rows.map((r) => ({
    kind: 'Pay run' as const,
    title: `Pay run — paid ${r.pay_date}`,
    detail: [r.period_start && r.period_end ? `${r.period_start} to ${r.period_end}` : null, r.entry_no]
      .filter(Boolean).join(' · '),
    date: r.pay_date,
    amount: r.total,
    href: `/payroll/runs/${r.id}`,
  }))
}
