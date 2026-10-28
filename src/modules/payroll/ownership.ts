import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db/client'

export async function owns(kind: string, id: string, ledgerId: string): Promise<boolean | undefined> {
  const L = sql`JOIN ledger l ON l.entity_id`
  const queries: Record<string, SQL> = {
    employee: sql`SELECT 1 AS ok FROM payroll_employee e ${L} = e.entity_id WHERE e.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    pay_stub: sql`SELECT 1 AS ok FROM pay_stub ps JOIN pay_run pr ON pr.id = ps.pay_run_id
                   WHERE ps.id = ${id}::uuid AND pr.ledger_id = ${ledgerId}::uuid`
  }
  const query = queries[kind]
  return query ? (await db.execute(query)).length > 0 : undefined
}
