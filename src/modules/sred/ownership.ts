import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db/client'

export async function owns(kind: string, id: string, ledgerId: string): Promise<boolean | undefined> {
  const L = sql`JOIN ledger l ON l.entity_id`
  const queries: Record<string, SQL> = {
    sred_project: sql`SELECT 1 AS ok FROM sred_project p ${L} = p.entity_id WHERE p.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    sred_claim: sql`SELECT 1 AS ok FROM sred_claim c JOIN sred_project p ON p.id = c.project_id ${L} = p.entity_id
                     WHERE c.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    sred_time: sql`SELECT 1 AS ok FROM sred_time t JOIN sred_project p ON p.id = t.project_id ${L} = p.entity_id
                    WHERE t.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    sred_evidence: sql`SELECT 1 AS ok FROM sred_evidence e JOIN sred_project p ON p.id = e.project_id ${L} = p.entity_id
                        WHERE e.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    sred_allocation: sql`SELECT 1 AS ok FROM sred_allocation a JOIN sred_claim c ON c.id = a.claim_id
                          JOIN sred_project p ON p.id = c.project_id ${L} = p.entity_id
                          WHERE a.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`
  }
  const query = queries[kind]
  return query ? (await db.execute(query)).length > 0 : undefined
}
