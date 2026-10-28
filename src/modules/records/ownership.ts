import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/db/client'

export async function owns(kind: string, id: string, ledgerId: string): Promise<boolean | undefined> {
  const L = sql`JOIN ledger l ON l.entity_id`
  const queries: Record<string, SQL> = {
    directorship: sql`SELECT 1 AS ok FROM directorship d ${L} = d.entity_id WHERE d.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    share_class: sql`SELECT 1 AS ok FROM share_class sc ${L} = sc.entity_id WHERE sc.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    significant_individual: sql`SELECT 1 AS ok FROM significant_individual si ${L} = si.entity_id WHERE si.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    minute_book_entry: sql`SELECT 1 AS ok FROM minute_book_entry m ${L} = m.entity_id WHERE m.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    corporate_office: sql`SELECT 1 AS ok FROM corporate_office o ${L} = o.entity_id WHERE o.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    share_transaction: sql`SELECT 1 AS ok FROM share_transaction t JOIN share_class sc ON sc.id = t.share_class_id ${L} = sc.entity_id
                            WHERE t.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`,
    minute_book_attachment: sql`SELECT 1 AS ok FROM minute_book_attachment p JOIN minute_book_entry m ON m.id = p.minute_book_entry_id
                                 ${L} = m.entity_id WHERE p.id = ${id}::uuid AND l.id = ${ledgerId}::uuid`
  }
  const query = queries[kind]
  return query ? (await db.execute(query)).length > 0 : undefined
}
