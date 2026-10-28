import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db/client'

export async function owns(kind: string, id: string, ledgerId: string): Promise<boolean | undefined> {
  const L = sql`JOIN ledger l ON l.entity_id`
  const queries: Record<string, SQL> = {
    crm_account: sql`SELECT 1 AS ok FROM crm_account x ${L} = x.entity_id WHERE x.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    crm_lead: sql`SELECT 1 AS ok FROM crm_lead x ${L} = x.entity_id WHERE x.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    crm_contact: sql`SELECT 1 AS ok FROM crm_account_contact x ${L} = x.entity_id WHERE x.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    crm_opportunity: sql`SELECT 1 AS ok FROM crm_opportunity x ${L} = x.entity_id WHERE x.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    crm_activity: sql`SELECT 1 AS ok FROM crm_activity x ${L} = x.entity_id WHERE x.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    crm_task: sql`SELECT 1 AS ok FROM crm_task x ${L} = x.entity_id WHERE x.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    crm_handoff: sql`SELECT 1 AS ok FROM crm_finance_handoff x ${L} = x.entity_id WHERE x.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    crm_attachment: sql`SELECT 1 AS ok FROM crm_attachment x ${L} = x.entity_id WHERE x.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`
  }
  const query = queries[kind]
  return query ? (await db.execute(query)).length > 0 : undefined
}
